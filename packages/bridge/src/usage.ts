import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeApi, HostState } from "@herdr-remote/protocol";
import type { ActResult, Hub } from "./hub.js";
import type { Json } from "./patch.js";
import { DEFAULT_BINARIES, type Binaries } from "./plugins/detect.js";
import type { Runner } from "./plugins/exec.js";

export const USAGE_TOPIC = "usage";
/** PLAN S9: collect every 15 s while subscribed, with a 10 s timeout. */
export const USAGE_INTERVAL_MS = 15_000;
export const USAGE_TIMEOUT_MS = 10_000;

/** herdr-app program keys that differ from usagebar's agent ids (agent-usage `mods/agent-usage/main.js`). */
const AGENT_IDS: Record<string, string> = { antigravity: "agy", "cursor-agent": "cursor" };

/** The `--panes` argument: the open agent panes, in the shape agent-usage's collect-json-v1 takes. */
export function panesArg(host: unknown): string {
  const parsed = HostState.safeParse(host);
  if (!parsed.success) return "[]";
  const panes = parsed.data.agents.map((a) => ({
    paneId: a.terminal_id ?? a.id,
    agent: AGENT_IDS[a.harness] ?? a.harness,
    label: a.name,
  }));
  return JSON.stringify(panes);
}

/** Abbreviates a path under the home directory with `~`; anything else is left alone. */
export function tilde(path: string | null | undefined, home: string): string | null | undefined {
  if (!path || !home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/**
 * Validates a `collect --format v1` document and keeps what the screen draws. Paths under the home directory
 * are abbreviated like the desktop panel does (`~/.codex`); an email identity has no path to abbreviate.
 */
export function normalizeReport(raw: unknown, home: string): { ok: true; report: bridgeApi.UsageReport } | { ok: false; error: bridgeApi.UsageError } {
  const version = raw !== null && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  if (version !== undefined && version !== 1) return { ok: false, error: "unsupported" };
  const r = bridgeApi.UsageReport.safeParse(raw);
  if (!r.success) return { ok: false, error: "bad_output" };
  const report = r.data;
  for (const p of report.providers) {
    if (p.identity) p.identity = tilde(p.identity, home);
    if (p.source) p.source = tilde(p.source, home);
    if (p.home) p.home = tilde(p.home, home);
  }
  return { ok: true, report };
}

export interface UsageTopicOptions {
  hub: Hub;
  run: Runner;
  binaries?: Binaries;
  /** Poll interval while subscribed. Default 15 s. */
  intervalMs?: number;
  /** Per-collect timeout. Default 10 s. */
  timeoutMs?: number;
  now?: () => number;
  /** For the `~` abbreviation. Default: the bridge user's home. */
  home?: string;
  /**
   * The herdr-app home. When set, collect runs the way agent-usage's own panel does: the binary and config
   * dir come from `<appHome>/mods/agent-usage/local.json` (read-only; defaults `~/.local/bin/usagebar` and
   * `~/.config/agent-usage`), and the command is `/usr/bin/env HERDR_PLUGIN_CONFIG_DIR=<dir> <binary> ...`, so
   * the phone reads the same accounts and settings as the desktop panel.
   */
  appHome?: string;
}

/** The `local.json` keys the panel honours (`binary`, `configDir`); anything else in it is ignored. */
async function readLocal(appHome: string): Promise<{ binary?: string; configDir?: string }> {
  try {
    const j = JSON.parse(await readFile(join(appHome, "mods/agent-usage/local.json"), "utf8")) as Record<string, unknown>;
    const out: { binary?: string; configDir?: string } = {};
    if (typeof j.binary === "string" && j.binary) out.binary = j.binary;
    if (typeof j.configDir === "string" && j.configDir) out.configDir = j.configDir;
    return out;
  } catch {
    return {};
  }
}

/**
 * Publishes the `usage` topic by running `usagebar collect --format v1 [--all] --panes <JSON>`.
 * It runs only while at least one client is subscribed (collecting at once for the first), never overlaps
 * itself, keeps the last good report when a collect fails, and never calls `usagebar notify`
 * (a second consumer of toasts would split them with the desktop mod, PLAN section 7).
 */
export class UsageTopicDriver {
  private readonly o: UsageTopicOptions;
  private filter: bridgeApi.UsageTopic["filter"] = "open-panes";
  private report: bridgeApi.UsageReport | null = null;
  private updatedAtMs: number | null = null;
  private error: bridgeApi.UsageError | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  /** The generation `inflight` was started under. */
  private inflightGen = 0;
  /** Bumped when the filter changes, so a collect started under the old filter is dropped. */
  private generation = 0;
  private unwatch: (() => void) | undefined;
  private polling = false;

  constructor(opts: UsageTopicOptions) {
    this.o = opts;
  }

  start(): void {
    this.unwatch = this.o.hub.watchSubscribers(USAGE_TOPIC, (n) => (n > 0 ? this.startPolling() : this.stopPolling()));
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.stopPolling();
  }

  get isPolling(): boolean {
    return this.polling;
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.intervalMs ?? USAGE_INTERVAL_MS);
    this.timer.unref();
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Collects now. Overlapping calls share one run. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflightGen = this.generation;
      this.inflight = this.collect().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** Like `refresh`, but when the run it joins was dropped for a filter change, collects again. */
  private async refreshCurrent(): Promise<void> {
    const joined = this.inflight ? this.inflightGen : this.generation;
    await this.refresh();
    if (joined !== this.generation) await this.refreshCurrent();
  }

  private publish(): void {
    const value: bridgeApi.UsageTopic = { filter: this.filter, report: this.report, updatedAtMs: this.updatedAtMs };
    if (this.error) value.error = this.error;
    this.o.hub.publish(USAGE_TOPIC, value as unknown as Json);
  }

  private async collect(): Promise<void> {
    const gen = this.generation;
    let cmd = (this.o.binaries ?? DEFAULT_BINARIES).usagebar;
    const prefix: string[] = [];
    if (this.o.appHome !== undefined) {
      const home = this.o.home ?? homedir();
      const local = await readLocal(this.o.appHome);
      cmd = "/usr/bin/env";
      prefix.push(`HERDR_PLUGIN_CONFIG_DIR=${local.configDir ?? `${home}/.config/agent-usage`}`, local.binary ?? `${home}/.local/bin/usagebar`);
    }
    const args = [...prefix, "collect", "--format", "v1", ...(this.filter === "all" ? ["--all"] : []), "--panes", panesArg(this.o.hub.get("host"))];
    const r = await this.o.run(cmd, args, { timeoutMs: this.o.timeoutMs ?? USAGE_TIMEOUT_MS });
    if (gen !== this.generation) return;
    if (r.error === "ENOENT" || r.error === "other") this.error = "unavailable";
    else if (r.error === "timeout") this.error = "timeout";
    else if (r.code !== 0) this.error = "failed";
    else {
      let doc: unknown;
      try {
        doc = JSON.parse(r.stdout);
      } catch {
        doc = undefined;
      }
      const n = doc === undefined ? ({ ok: false, error: "bad_output" } as const) : normalizeReport(doc, this.o.home ?? homedir());
      if (n.ok) {
        this.report = n.report;
        this.updatedAtMs = (this.o.now ?? Date.now)();
        this.error = undefined;
      } else {
        this.error = n.error;
      }
    }
    this.publish();
  }

  /** The `act` kinds of the usage topic. Returns undefined for any other kind. */
  async act(kind: string, args: Record<string, unknown>): Promise<ActResult | undefined> {
    if (kind === "usage.refresh") {
      await this.refreshCurrent();
      return { ok: this.error === undefined, ...(this.error ? { code: this.error } : {}) };
    }
    if (kind === "usage.set_filter") {
      const f = args.filter;
      if (f !== "open-panes" && f !== "all") return { ok: false, code: "bad_args" };
      if (f !== this.filter) {
        this.filter = f;
        this.generation += 1;
        this.report = null;
        this.updatedAtMs = null;
        this.error = undefined;
        // A collect still running for the old filter is dropped when it ends; this one waits for it.
        const pending = this.inflight;
        this.publish();
        if (pending) await pending;
        await this.refresh();
      }
      return { ok: this.error === undefined, ...(this.error ? { code: this.error } : {}) };
    }
    return undefined;
  }
}
