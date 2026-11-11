import { open } from "node:fs/promises";
import { join } from "node:path";
import type { bridgeApi } from "@herdr-remote/protocol";
import {
  FEED_MAX_BYTES,
  FEED_STALE_MS,
  INBOX_PROBE_PREFIX,
  INBOX_PROTOCOL,
  MIN_HC_VERSION,
  PANORAMA_CONTRACT,
  PANORAMA_FEED,
  PANORAMA_FEED_VERSION,
  PANORAMA_RECEIPT,
  PROBE_TIMEOUT_MS,
  USAGE_FORMAT,
} from "./constants.js";
import type { Runner, RunResult } from "./exec.js";
import { loadPinned } from "./loader.js";

export type PluginStatus = bridgeApi.PluginStatus;

export interface Binaries {
  hc: string;
  inbox: string;
  usagebar: string;
}
export const DEFAULT_BINARIES: Binaries = { hc: "hc", inbox: "herdr-inbox", usagebar: "usagebar" };

export interface DetectEnv {
  appHome: string;
  run: Runner;
  binaries?: Binaries;
  /** Epoch milliseconds; injectable for the staleness rule. */
  now?: () => number;
}

const ok = (): PluginStatus => ({ state: "ready" });
const st = (state: PluginStatus["state"], detail?: string): PluginStatus => (detail === undefined ? { state } : { state, detail });

/** Maps a command that could not produce an answer to a status, or undefined when it ran and exited. */
function unrunnable(r: RunResult, name: string): PluginStatus | undefined {
  if (r.error === "ENOENT") return st("missing", `${name} is not installed`);
  if (r.error === "timeout") return st("broken", `${name} timed out`);
  if (r.error || r.code === null) return st("broken", `${name} could not run`);
  return undefined;
}

export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** `hc --version`: missing, broken (no version in the output), too_old (below the minimum) or ready. */
export async function detectHc(env: DetectEnv): Promise<PluginStatus> {
  const bin = (env.binaries ?? DEFAULT_BINARIES).hc;
  const r = await env.run(bin, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
  const bad = unrunnable(r, "hc");
  if (bad) return bad;
  if (r.code !== 0) return st("broken", "hc --version failed");
  const v = parseVersion(r.stdout);
  if (!v) return st("broken", "hc --version printed no version");
  return compare(v, parseVersion(MIN_HC_VERSION) as number[]) < 0 ? st("too_old", `hc ${v.join(".")} is older than ${MIN_HC_VERSION}`) : ok();
}

/**
 * `herdr-inbox app --help`: the first line must be `herdr-inbox app v1`. An older inbox answers with its own
 * version and exit 0 (app-feed-v1), so any other first line on exit 0 is too_old; a newer protocol is broken.
 */
export async function detectInbox(env: DetectEnv): Promise<PluginStatus> {
  const bin = (env.binaries ?? DEFAULT_BINARIES).inbox;
  const r = await env.run(bin, ["app", "--help"], { timeoutMs: PROBE_TIMEOUT_MS });
  const bad = unrunnable(r, "herdr-inbox");
  if (bad) return bad;
  // A non-zero exit is taken as "no `app` command" (an older inbox); a crash looks the same by design.
  if (r.code !== 0) return st("too_old", "herdr-inbox has no app command");
  const first = r.stdout.split("\n")[0] ?? "";
  if (first === `${INBOX_PROBE_PREFIX}${INBOX_PROTOCOL}`) return ok();
  const m = /^herdr-inbox app v(\d+)$/.exec(first);
  if (m && Number(m[1]) > INBOX_PROTOCOL) return st("broken", `unsupported herdr-inbox app protocol v${m[1]}`);
  return st("too_old", "herdr-inbox is too old for the app protocol");
}

/**
 * `usagebar collect --format v1`: JSON with `version: 1` is ready. A usagebar that predates `--format` prints
 * the unversioned debug shape (too_old). `--panes []` and `--quotas-only`
 * keep the probe cheap and independent of the open panes.
 */
export async function detectUsage(env: DetectEnv): Promise<PluginStatus> {
  const bin = (env.binaries ?? DEFAULT_BINARIES).usagebar;
  const r = await env.run(bin, ["collect", "--format", "v1", "--quotas-only", "--panes", "[]"], { timeoutMs: PROBE_TIMEOUT_MS });
  const bad = unrunnable(r, "usagebar");
  if (bad) return bad;
  if (r.code !== 0) return st("broken", "usagebar collect failed");
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return st("broken", "usagebar collect printed invalid JSON");
  }
  const version = doc !== null && typeof doc === "object" ? (doc as { version?: unknown }).version : undefined;
  if (version === undefined) return st("too_old", "usagebar printed the unversioned shape");
  if (version !== USAGE_FORMAT) return st("broken", "unsupported usagebar format");
  return ok();
}

export async function readFeed(path: string): Promise<{ text: string } | { missing: true } | { error: string }> {
  try {
    const h = await open(path, "r");
    try {
      const buf = Buffer.alloc(FEED_MAX_BYTES + 1);
      const { bytesRead } = await h.read(buf, 0, buf.length, 0);
      return bytesRead > FEED_MAX_BYTES ? { error: "feed larger than 1 MiB" } : { text: buf.toString("utf8", 0, bytesRead) };
    } finally {
      await h.close();
    }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : { error: "feed unreadable" };
  }
}

/**
 * Panorama: install receipt, `contract.js` hash, feed `v == 2`.
 * - no receipt: missing; receipt/hash/load problems, or a feed that fails contract.js: broken
 * - no feed file, or a feed older than 15 s: not_running / stale (only the sidebar's lease owner writes it)
 * - feed `v < 2`: too_old; `v > 2`: broken
 */
export async function detectPanorama(env: DetectEnv): Promise<PluginStatus> {
  const loaded = await loadPinned(env.appHome, PANORAMA_RECEIPT, [PANORAMA_CONTRACT]);
  if (!loaded.ok) return st(loaded.reason, loaded.detail);
  const contract = loaded.modules[PANORAMA_CONTRACT] as {
    parseFeed?: (text: string) => unknown;
    aged?: (packet: unknown, now?: number) => boolean;
  };
  if (typeof contract.parseFeed !== "function" || typeof contract.aged !== "function") return st("broken", "contract.js has an unexpected shape");
  const f = await readFeed(join(env.appHome, PANORAMA_FEED));
  if ("missing" in f) return st("not_running", "no feed yet");
  if ("error" in f) return st("broken", f.error);
  let raw: unknown;
  try {
    raw = JSON.parse(f.text);
  } catch {
    return st("broken", "feed is not JSON");
  }
  const v = raw !== null && typeof raw === "object" ? (raw as { v?: unknown }).v : undefined;
  if (typeof v === "number" && v < PANORAMA_FEED_VERSION) return st("too_old", "feed is v1");
  if (v !== PANORAMA_FEED_VERSION) return st("broken", "unsupported feed version");
  let feed: unknown;
  try {
    feed = contract.parseFeed(f.text);
  } catch {
    return st("broken", "feed failed validation");
  }
  const now = (env.now ?? Date.now)();
  // contract.js `aged` is the rule (15 s, unstamped or future = stale); FEED_STALE_MS documents the same number.
  return contract.aged(feed, now) ? st("stale", `feed older than ${FEED_STALE_MS / 1000} s`) : ok();
}

export interface HostView {
  hasState: boolean;
  /** `hub.isStale("host")`. */
  stale: string | null;
}

/** host: the link, or (later) `herdr-app status`. Derived from the `host` topic, so no process is run. */
export function detectHost(h: HostView): PluginStatus {
  if (h.stale === "layout_without_remote") return st("not_running", "the shown layout has no Remote link");
  if (h.stale === "source_unavailable") return st("broken", "the link source is unavailable");
  if (h.stale !== null) return h.hasState ? st("stale", h.stale) : st("not_running", "waiting for the link");
  return h.hasState ? ok() : st("not_running", "waiting for the link");
}
