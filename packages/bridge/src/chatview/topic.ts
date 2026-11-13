// The `chatview:<t>` topic (docs/chatview.md §2, §3, §5, §7; CV3): a Claude Code agent's conversation as chat items.
//
// Binding. Only panorama's proved join is used: the feed root at exactly this terminal address (`host ==
// "herdr-core"`, `root.terminal == t`), joined to the one live host agent at that address, with a session id
// panorama verified. An aged or stale feed, no lease owner, no root, two roots, no session id: no chat view. The
// session is then bound to an agent-usage root through `ClaudeHistory.bind` (no scan, no fallback roots).
//
// Tailing. While someone is subscribed, `root.transcript` is stat'ed once a second: size and mtime only, the
// bridge never opens it. When either changes (or the binding does), the session is read through the reader child,
// mapped (map.ts), diffed by item id and published as a patch. If the chain was rewritten (compaction, rewind,
// `continued-in` moving the session id), the topic gets a fresh `snap` and a new `rev`.
//
// Nothing that names where the history lives (transcript path, config dir, session id) is ever put in the topic.
import { randomBytes } from "node:crypto";
import { stat as fsStat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { bridgeApi, type AgentState } from "@herdr-remote/protocol";
import type { Binding, BindResult, ClaudeMessage, ProvedSession, ReadOptions, ReadResult } from "../claude/index.js";
import { SESSION_ID } from "../claude/wire.js";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { diff } from "../patch.js";
import type { Contract, FeedView } from "../panorama/feed.js";
import { mapMessages, newest, type MapOptions } from "./map.js";

type ChatItem = bridgeApi.ChatItem;
type ChatviewTopic = bridgeApi.ChatviewTopic;
type Reason = Exclude<bridgeApi.ChatviewReason, "forbidden">;

export const CHATVIEW_INTERVAL_MS = 1_000;
/** Chat views tailed at once. A further one goes stale (`too_many_chats`) until another closes. */
export const MAX_ACTIVE_CHATVIEWS = 6;
/** Items kept in memory per open chat view, for older pages. Older than these, a page says `older: false`. */
export const CHATVIEW_KEPT = 5_000;
/** After a failed bind or read, the next attempt waits this long (the stat still runs every second). */
export const CHATVIEW_RETRY_MS = 5_000;

/** What the topic needs of the Claude reader (`ClaudeHistory`). */
export interface ChatviewHistory {
  bind(s: ProvedSession): Promise<BindResult>;
  read(b: Binding, o?: ReadOptions): Promise<ReadResult>;
}

export type StatResult = { size: number; mtimeMs: number } | "missing" | "error";

/** Size and mtime of a path, and nothing else: the transcript is never opened. */
export async function statOnly(path: string): Promise<StatResult> {
  try {
    const s = await fsStat(path);
    if (!s.isFile()) return "error";
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
  }
}

export interface ChatviewOptions {
  hub: Hub;
  /** The reader; null when the bridge has no verified reader (then every Claude chat view is `reader_failed`). */
  history: ChatviewHistory | null;
  /** The feed as panorama's driver last read it (`PanoramaTopicDriver.feedView`). */
  feed: () => { view: FeedView; contract: Contract | undefined } | undefined;
  intervalMs?: number;
  retryMs?: number;
  /** Test seam: the stat of `root.transcript`. Default {@link statOnly}. */
  stat?: (path: string) => Promise<StatResult>;
  now?: () => number;
  map?: MapOptions;
  /** The topic value failed its own schema (a bug): logged by the app, the topic goes `reader_failed`. */
  onInvalid?: (topic: string, error: string) => void;
}

/** What panorama and the host prove about a terminal: a session to read, or why there is none. */
export type Resolution =
  | { ok: true; harness: "claude"; session: ProvedSession & { transcript: string }; agentState: AgentState }
  | { ok: false; harness: string; reason: Reason; agentState: AgentState | null };

const HARNESS = /^[A-Za-z0-9._-]{1,64}$/;
const harnessId = (h: string | undefined): string => (h !== undefined && HARNESS.test(h) ? h : "unknown");

/**
 * The binding for terminal `t`, from the host topic and panorama's feed only (§2.1). Never by cwd, title, pane id
 * or recency. The harness check comes first, so a Codex pane says `harness` even without panorama.
 */
export function resolve(t: string, hostRaw: unknown, fv: { view: FeedView; contract: Contract | undefined } | undefined): Resolution {
  const host = bridgeApi.HostTopic.safeParse(hostRaw);
  if (!host.success) return { ok: false, harness: "unknown", reason: "no_binding", agentState: null };
  const agents = host.data.agents.filter((a) => a.terminal_id === t);
  // Two live agents claiming one address is a conflict, not a choice.
  const agent = agents.length === 1 ? agents[0] : undefined;
  const agentState = agent?.state ?? null;
  // `program` is the herdr-app program key (`claude`, `codex`); `harness` is a display name first, so not used.
  const hint = agent?.program;
  if (hint !== undefined && hint !== "claude") return { ok: false, harness: harnessId(hint), reason: "harness", agentState };
  const feed = fv?.view.feed ?? null;
  if (host.data.shared["panorama.feed.owner"] === null || feed === null || fv?.contract === undefined) {
    return { ok: false, harness: harnessId(hint), reason: "no_panorama", agentState };
  }
  // An aged feed applies no joins (numbering is per core instance); a failed read can't be trusted either.
  if (fv.view.stale || fv.view.aged) return { ok: false, harness: harnessId(hint), reason: "no_binding", agentState };
  const roots = feed.roots.filter((r) => r.host === "herdr-core" && r.terminal === t);
  if (roots.length !== 1) return { ok: false, harness: harnessId(hint), reason: "no_binding", agentState };
  const root = roots[0]!;
  if (root.harness !== "claude") return { ok: false, harness: harnessId(root.harness), reason: "harness", agentState };
  if (agent === undefined) return { ok: false, harness: "claude", reason: "no_binding", agentState };
  const sid = root.session_id;
  if (typeof sid !== "string" || !SESSION_ID.test(sid)) return { ok: false, harness: "claude", reason: "no_binding", agentState };
  const transcript = root.transcript;
  if (typeof transcript !== "string" || !isAbsolute(transcript) || transcript.includes("\0")) return { ok: false, harness: "claude", reason: "no_binding", agentState };
  const cwd = typeof root.cwd === "string" && isAbsolute(root.cwd) ? root.cwd : null;
  return { ok: true, harness: "claude", session: { sessionId: sid, transcript, cwd }, agentState: agent.state };
}

/** The status line from the host's agent state (§3): never from the transcript. */
export function statusOf(state: AgentState | null, items: readonly ChatItem[]): bridgeApi.ChatviewStatus {
  if (state === "working") {
    let since: string | null = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.role === "you") {
        since = it.at;
        break;
      }
    }
    return { state: "working", since };
  }
  return { state: state === "waiting" ? "blocked" : "idle", since: null };
}

/**
 * Whether `next` carries on from `prev`: the items they share are the same ids in the same order, and `next` only
 * adds items after them. Either list may have lost its oldest items to the {@link CHATVIEW_KEPT} cap.
 */
export function continues(prev: readonly ChatItem[], next: readonly ChatItem[]): boolean {
  if (prev.length === 0) return true;
  if (next.length === 0) return false;
  let p = 0;
  let q = next.findIndex((i) => i.id === prev[0]!.id);
  if (q < 0) {
    // `next` was cut at the front: it must start inside `prev`.
    p = prev.findIndex((i) => i.id === next[0]!.id);
    if (p < 0) return false;
    q = 0;
  }
  if (next.length - q < prev.length - p) return false;
  for (; p < prev.length; p++, q++) if (next[q]!.id !== prev[p]!.id) return false;
  return true;
}

/**
 * The patch from `prev` to `next` when `next`'s window starts k items later in `prev`'s: k removes at the front,
 * then an ordinary diff. Null when the windows don't line up (the caller snaps).
 */
export function windowOps(prev: ChatviewTopic, next: ChatviewTopic): bridgeApi.PatchOp[] | null {
  if (prev.items.length === 0 || next.items.length === 0) return diff(prev as unknown as Json, next as unknown as Json);
  const k = prev.items.findIndex((i) => i.id === next.items[0]!.id);
  if (k < 0) return null;
  const ops: bridgeApi.PatchOp[] = [];
  for (let i = 0; i < k; i++) ops.push({ op: "remove", path: "/items/0" });
  const shifted = { ...prev, items: prev.items.slice(k) };
  return ops.concat(diff(shifted as unknown as Json, next as unknown as Json));
}

const newRev = (): string => randomBytes(8).toString("hex");

interface Watch {
  topic: string;
  terminal: string;
  timer: NodeJS.Timeout | undefined;
  stopped: boolean;
  /** `sessionId \0 transcript \0 cwd` of the proved session the binding is for. */
  proved: string | null;
  sessionId: string | null;
  binding: Binding | null;
  /** The transcript's size and mtime at the last good read; null forces a read. */
  seen: { size: number; mtimeMs: number } | null;
  /** No bind or read before this time (after a failure). */
  retryAt: number;
  /** Every item of the session (the newest {@link CHATVIEW_KEPT}), oldest first. */
  items: ChatItem[];
  rev: string;
  /** The last value published, or undefined. */
  last: ChatviewTopic | undefined;
  /** The look in flight (or the last one, settled). */
  inflight: Promise<void>;
}

export type PageResult =
  | { ok: true; page: bridgeApi.ChatviewPage }
  | { ok: false; status: 404 | 409; code: "not_open" | "rev_changed" | "unknown_cursor" };

/**
 * Publishes `chatview:<t>` while someone is subscribed (and does nothing otherwise). The subscription itself was
 * already allowed by the hub's topic gate (`view` + `transcript.read`, and the open recorded in Activity).
 */
export class ChatviewTopicDriver {
  private readonly o: ChatviewOptions;
  private readonly watches = new Map<string, Watch>();
  private readonly waiting = new Set<string>();
  private unwatch: (() => void) | undefined;

  constructor(opts: ChatviewOptions) {
    this.o = opts;
  }

  start(): void {
    this.unwatch = this.o.hub.watchPrefix(bridgeApi.CHATVIEW_PREFIX, (topic, n) => (n > 0 ? this.open(topic) : this.close(topic)));
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.waiting.clear();
    for (const topic of [...this.watches.keys()]) this.close(topic);
  }

  get activeTopics(): string[] {
    return [...this.watches.keys()];
  }

  /**
   * Older items of an open chat view (`GET /api/v1/chatview/<t>`): up to `n` items just before `before`, from
   * what the topic already holds (no extra read). `rev`, when given, must be the current one.
   */
  page(terminal: string, before: string, n: number, rev?: string): PageResult {
    const w = this.watches.get(`${bridgeApi.CHATVIEW_PREFIX}${terminal}`);
    if (!w || w.last?.state !== "ok") return { ok: false, status: 409, code: "not_open" };
    if (rev !== undefined && rev !== w.rev) return { ok: false, status: 409, code: "rev_changed" };
    const end = w.items.findIndex((i) => i.id === before);
    if (end < 0) return { ok: false, status: 404, code: "unknown_cursor" };
    const count = Math.max(1, Math.min(bridgeApi.CHATVIEW_PAGE_MAX, Math.floor(n)));
    const from = Math.max(0, end - count);
    const fit = newest(w.items.slice(from, end), { items: [], older: false, rev: w.rev }, count, bridgeApi.CHATVIEW_SNAP_MAX_BYTES);
    return { ok: true, page: { items: fit.items, older: fit.older || from > 0, rev: w.rev } };
  }

  private open(topic: string): void {
    if (this.watches.has(topic)) return;
    const terminal = bridgeApi.chatviewTerminal(topic);
    if (terminal === null) return void this.o.hub.setStale(topic, "bad_terminal");
    if (this.watches.size >= MAX_ACTIVE_CHATVIEWS) {
      this.waiting.add(topic);
      return void this.o.hub.setStale(topic, "too_many_chats");
    }
    this.waiting.delete(topic);
    const w: Watch = { topic, terminal, timer: undefined, stopped: false, proved: null, sessionId: null, binding: null, seen: null, retryAt: 0, items: [], rev: newRev(), last: undefined, inflight: Promise.resolve() };
    this.watches.set(topic, w);
    void this.tick(w);
  }

  private close(topic: string): void {
    this.waiting.delete(topic);
    const w = this.watches.get(topic);
    if (w) {
      w.stopped = true;
      clearTimeout(w.timer);
      this.watches.delete(topic);
    }
    // Nobody looks: the history held for it goes with it.
    this.o.hub.discard(topic);
    const next = this.waiting.values().next().value;
    if (w && next !== undefined) this.open(next);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private async tick(w: Watch): Promise<void> {
    await this.look(w);
    if (w.stopped) return;
    w.timer = setTimeout(() => void this.tick(w), this.o.intervalMs ?? CHATVIEW_INTERVAL_MS);
    w.timer.unref();
  }

  /** One look now, after any in flight (looks never overlap). Resolves when it is done. */
  poll(topic: string): Promise<void> {
    const w = this.watches.get(topic);
    return w ? this.look(w) : Promise.resolve();
  }

  /** Resolves once the look in flight (if any) is done. */
  settled(topic: string): Promise<void> {
    return this.watches.get(topic)?.inflight ?? Promise.resolve();
  }

  private look(w: Watch): Promise<void> {
    const run = w.inflight.then(async () => {
      if (w.stopped) return;
      try {
        await this.step(w);
      } catch {
        if (!w.stopped) this.unavailable(w, "claude", "reader_failed", null, true);
      }
    });
    w.inflight = run;
    return run;
  }

  /** One look: resolve the binding, stat the transcript, read if it changed, publish. */
  private async step(w: Watch): Promise<void> {
    const r = resolve(w.terminal, this.o.hub.get("host"), this.o.feed());
    if (!r.ok) return this.unavailable(w, r.harness, r.reason, r.agentState, true);
    const history = this.o.history;
    if (history === null) return this.unavailable(w, r.harness, "reader_failed", r.agentState, true);
    const key = `${r.session.sessionId}\0${r.session.transcript}\0${r.session.cwd ?? ""}`;
    if (key !== w.proved) {
      // Another session (or the same one at another path): bind again and read everything again.
      w.proved = key;
      w.binding = null;
      w.seen = null;
      w.retryAt = 0;
    }
    if (this.now() < w.retryAt) return this.republish(w, r.agentState);
    if (w.binding === null) {
      const b = await history.bind(r.session);
      if (w.stopped) return;
      if (!b.ok) {
        w.retryAt = this.now() + (this.o.retryMs ?? CHATVIEW_RETRY_MS);
        return this.unavailable(w, "claude", b.reason, r.agentState);
      }
      w.binding = b.binding;
    }
    const st = await (this.o.stat ?? statOnly)(r.session.transcript);
    if (w.stopped) return;
    if (st === "error") return this.failRead(w, r.agentState);
    const now = st === "missing" ? { size: 0, mtimeMs: 0 } : st;
    if (w.seen !== null && w.last?.state === "ok" && now.size === w.seen.size && now.mtimeMs === w.seen.mtimeMs) return this.republish(w, r.agentState);
    const read = await history.read(w.binding);
    if (w.stopped) return;
    let messages: ClaudeMessage[];
    if (read.ok) messages = read.messages;
    else if (read.reason === "not_found" && now.size === 0) messages = []; // a new session: no file, or an empty one, yet
    else return this.failRead(w, r.agentState); // `not_found` with a transcript on disk is a reader that can't see it
    const items = mapMessages(messages, this.o.map).slice(-CHATVIEW_KEPT);
    const rewritten = w.sessionId !== r.session.sessionId || !continues(w.items, items);
    if (rewritten) w.rev = newRev();
    w.sessionId = r.session.sessionId;
    w.items = items;
    w.seen = now;
    this.publish(w, r.agentState, rewritten);
  }

  private failRead(w: Watch, agentState: AgentState | null): void {
    // Bind again next time: the root list or the reader may have changed.
    w.binding = null;
    w.seen = null;
    w.retryAt = this.now() + (this.o.retryMs ?? CHATVIEW_RETRY_MS);
    this.unavailable(w, "claude", "reader_failed", agentState);
  }

  /** Same items, maybe another status line. */
  private republish(w: Watch, agentState: AgentState | null): void {
    if (w.last?.state !== "ok") return;
    // Nothing to send when the status line is the same: skip rebuilding and checking the window every second.
    const status = statusOf(agentState, w.items);
    if (status.state === w.last.status.state && status.since === w.last.status.since) return;
    this.publish(w, agentState, false);
  }

  private publish(w: Watch, agentState: AgentState | null, fresh: boolean): void {
    const status = statusOf(agentState, w.items);
    const base = { terminal: w.terminal, harness: "claude", state: "ok" as const, items: [] as ChatItem[], older: false, rev: w.rev, status };
    const win = newest(w.items, base, bridgeApi.CHATVIEW_WINDOW, bridgeApi.CHATVIEW_SNAP_MAX_BYTES);
    const value: ChatviewTopic = { ...base, items: win.items, older: win.older };
    this.emit(w, value, fresh);
  }

  /** `forget`: the binding itself is gone (not just this attempt), so the next good look binds and reads again. */
  private unavailable(w: Watch, harness: string, reason: Reason, agentState: AgentState | null, forget = false): void {
    // The history held is dropped: it is never shown under another binding. The next good read starts a new `rev`.
    w.items = [];
    w.sessionId = null;
    if (forget) {
      w.proved = null;
      w.binding = null;
      w.seen = null;
      w.retryAt = 0;
    }
    const value: ChatviewTopic = { terminal: w.terminal, harness, state: "unavailable", reason, items: [], older: false, rev: "", status: statusOf(agentState, []) };
    this.emit(w, value, false);
  }

  private emit(w: Watch, value: ChatviewTopic, fresh: boolean): void {
    const checked = bridgeApi.ChatviewTopic.safeParse(value);
    if (!checked.success) {
      this.o.onInvalid?.(w.topic, checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      if (value.state === "ok") return this.unavailable(w, value.harness, "reader_failed", null, true);
      return;
    }
    const prev = w.last;
    w.last = value;
    const data = value as unknown as Json;
    if (fresh || prev === undefined || prev.state !== value.state || prev.rev !== value.rev) {
      this.o.hub.publish(w.topic, data, { snap: true });
      return;
    }
    const ops = windowOps(prev, value);
    if (ops === null) this.o.hub.publish(w.topic, data, { snap: true });
    else if (ops.length > 0) this.o.hub.publish(w.topic, data, { ops });
  }
}
