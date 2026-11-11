import { homedir } from "node:os";
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
    this.inflight ??= this.collect().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private publish(): void {
    const value: bridgeApi.UsageTopic = { filter: this.filter, report: this.report, updatedAtMs: this.updatedAtMs };
    if (this.error) value.error = this.error;
    this.o.hub.publish(USAGE_TOPIC, value as unknown as Json);
  }

  private async collect(): Promise<void> {
    const gen = this.generation;
    const bin = (this.o.binaries ?? DEFAULT_BINARIES).usagebar;
    const args = ["collect", "--format", "v1", ...(this.filter === "all" ? ["--all"] : []), "--panes", panesArg(this.o.hub.get("host"))];
    const r = await this.o.run(bin, args, { timeoutMs: this.o.timeoutMs ?? USAGE_TIMEOUT_MS });
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
      await this.refresh();
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
