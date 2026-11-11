import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { INBOX_COMMANDS_JS, INBOX_FEED_JS, INBOX_RECEIPT, INBOX_WORDS_JS } from "../plugins/constants.js";
import { loadPinned } from "../plugins/loader.js";
import type { Runner, RunResult } from "../plugins/exec.js";

/** A pre-validated feed as feed.js returns it: `{feed}` or `{problem, errors}`. */
export type ParsedFeed = { feed: RawFeed; problem?: undefined } | { problem: "missing" | "unreadable" | "unsupported" | "not-ok"; errors: string[]; feed?: undefined };

/** The parts of the (validated) feed the bridge reads. feed.js has checked every field it relies on. */
export interface RawFeed {
  v: 1;
  generated_at: number;
  ok: true;
  errors: string[];
  omitted: { groups: number; questions: number; failed: number; alerts: number; remote: number; question_ids: number[] };
  new_since?: { question_id?: number; alert_id?: number };
  entries: Record<string, unknown>[];
}

export interface Incompleteness {
  counts: string[];
  errors: string[];
  ids: number[];
  unlisted: number;
}

/** The inbox plugin's own pure JS, loaded hash-pinned from its install receipt (app-feed-v1: reuse, never reimplement). */
export interface InboxModules {
  parseFeed(text: string | null): ParsedFeed;
  isStale(generatedAt: unknown, nowSeconds: number): boolean;
  incompleteness(feed: RawFeed): Incompleteness | null;
  leftOut(feed: RawFeed): number;
  showArgs(qid: number): string[];
  /** The arguments after the launcher's `cli` for a verb, or null when these can't be a command (e.g. a detail over 64 KiB). */
  verbArgs(cmd: { verb: string; entry: string; qids?: number[]; detail?: VerbDetail | undefined; clear?: boolean }, token: string): string[] | null;
  readResult(result: { code: number | null; stdout: string } | null, verb: string, entry: string | null): ShowResult | { kind: string; [k: string]: unknown };
  deliveryWords(row: unknown): { warn: boolean; line: string };
  knownDelivery(row: unknown): boolean;
  retryLabel(row: unknown): "Send now" | "Retry delivery";
  severity(word: string): "urgent" | "warning" | "info";
  alertKind(word: string): "agent" | "blocked";
  refusalWords(verb: string, refusal: { code: string; message: string; closed: string | null }): string;
  unknownWords(why: string): string;
  heldWords(verb: string, done: number[]): string;
  queuedWords(done: number[]): string;
  skippedWords(skipped: number[]): string;
}

/** A Detail as app-commands-v1 takes it: option labels, notes keyed by label, free text. */
export interface VerbDetail {
  choices: string[];
  notes: Record<string, string>;
  text: string | null;
}

/** What `readResult` makes of a verb's exit and stdout. Anything but `done` or `refused` is of unknown effect. */
export type VerbResult =
  | { kind: "done"; token: string | null; done: number[]; skipped: number[]; delivery: "queued" | "held" | null }
  | { kind: "refused"; code: string; closed: string | null; message: string }
  | { kind: "unknown"; why: string };

export interface ShowResult {
  kind: "shown";
  row: Record<string, unknown>;
}

export type ModulesLoad = { ok: true; modules: InboxModules } | { ok: false; reason: "missing" | "broken"; detail: string };

const NAMES: Record<string, string[]> = {
  [INBOX_FEED_JS]: ["parseFeed", "isStale", "incompleteness", "leftOut"],
  [INBOX_COMMANDS_JS]: ["showArgs", "verbArgs", "readResult"],
  [INBOX_WORDS_JS]: ["deliveryWords", "knownDelivery", "retryLabel", "severity", "alertKind", "refusalWords", "unknownWords", "heldWords", "queuedWords", "skippedWords"],
};

export async function loadInboxModules(appHome: string): Promise<ModulesLoad> {
  const loaded = await loadPinned(appHome, INBOX_RECEIPT, [INBOX_FEED_JS, INBOX_COMMANDS_JS, INBOX_WORDS_JS]);
  if (!loaded.ok) return loaded;
  const merged: Record<string, unknown> = {};
  for (const [file, names] of Object.entries(NAMES)) {
    const mod = loaded.modules[file] ?? {};
    for (const n of names) {
      if (typeof mod[n] !== "function") return { ok: false, reason: "broken", detail: "a plugin file has an unexpected shape" };
      merged[n] = mod[n];
    }
  }
  return { ok: true, modules: merged as unknown as InboxModules };
}

export type Launch = (args: string[], timeoutMs: number) => Promise<RunResult>;

/**
 * Every command goes through the plugin's launcher (`sh <root>/scripts/launch cli ...`, app-commands-v1): there is
 * no private copy of the binary. The root is the one the install record holds, and it must still hold the
 * plugin's `herdr-plugin.toml` and `scripts/launch`. (`plugin_root` from `herdr plugin list` and Claude Code's
 * `installed_plugins.json` are not consulted yet: a moved, non-checkout install reads as not installed.)
 */
export async function resolveLauncher(appHome: string, run: Runner): Promise<Launch | undefined> {
  let record: unknown;
  try {
    record = JSON.parse(await readFile(join(appHome, INBOX_RECEIPT), "utf8"));
  } catch {
    return undefined;
  }
  const rec = record !== null && typeof record === "object" ? (record as { plugin_root?: unknown; plugin_moves?: unknown }) : {};
  const root = rec.plugin_root;
  // Only the operator's own checkout stays put. A moving install may leave an old copy behind that a rollback
  // never reaches, and finding the current one needs `herdr plugin list` / Claude Code's list (not done yet).
  if (rec.plugin_moves !== false) return undefined;
  if (typeof root !== "string" || !isAbsolute(root)) return undefined;
  const launch = join(root, "scripts", "launch");
  try {
    await access(join(root, "herdr-plugin.toml"));
    await access(launch);
  } catch {
    return undefined;
  }
  return (args, timeoutMs) => run("sh", [launch, "cli", ...args], { timeoutMs });
}
