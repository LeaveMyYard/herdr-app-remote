import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import type { Runner, RunResult } from "../plugins/exec.js";
import { parseAnsi } from "./ansi.js";

export const CHAT_PREFIX = "chat:";
/** The poll interval: `hc events` is unverified against a live core (PLAN section 8), so a chat is read once a second. */
export const CHAT_INTERVAL_MS = 1_000;
/** Per `hc` command. A hung core shows as `source_unavailable` after this long, not later. */
export const CHAT_READ_TIMEOUT_MS = 4_000;
/** How many trailing lines each `hc read` asks for, and the most the topic keeps. A `\r` in the output is dropped, not an overwrite: `hc read` returns rendered text. */
export const CHAT_LINES = 200;
/** Chats read at once. A further one goes stale (`too_many_chats`) until another closes. */
export const MAX_ACTIVE_CHATS = 6;
/**
 * `hc ls` is checked on the first tick and then every this many, to notice a terminal that closed: `hc read` of a
 * finished terminal still answers (its last screen), so only `hc ls` tells. Every 3 s at the 1 s poll.
 */
const LS_EVERY = 3;
const MAX_BACKOFF_MS = 5_000;

export interface ChatTopicOptions {
  hub: Hub;
  run: Runner;
  binaries?: Binaries;
  intervalMs?: number;
  readTimeoutMs?: number;
  lines?: number;
}

/**
 * Ids in `hc ls --json`. hc 0.1.20 prints `{"hidden_finished":0,"terminals":[{"address":"t1",...}]}` (recorded in the
 * rig: test/fixtures/hc/ls-0.1.20.json); `address` is the id `hc read` takes. A bare list and the other id keys are read
 * too, tolerantly. Anything else yields `null` (unknown), and the read goes ahead and decides.
 */
export function terminalIds(stdout: string): Set<string> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(doc) ? doc : doc && typeof doc === "object" ? firstArray(doc as Record<string, unknown>) : undefined;
  if (!list) return null;
  const ids = new Set<string>();
  for (const e of list) {
    if (typeof e === "string") ids.add(e);
    else if (e && typeof e === "object") {
      const r = e as Record<string, unknown>;
      for (const k of ["address", "id", "terminal", "name"]) if (typeof r[k] === "string") ids.add(r[k] as string);
    }
  }
  return ids;
}

function firstArray(o: Record<string, unknown>): unknown[] | undefined {
  for (const k of ["terminals", "items", "ls"]) if (Array.isArray(o[k])) return o[k] as unknown[];
  return undefined;
}

/** hc's error kind from a failed command's JSON (`{"error":{"kind":"not_found",...}}` on stderr), or undefined. */
export function hcErrorKind(r: RunResult): string | undefined {
  for (const text of [r.stderr, r.stdout]) {
    try {
      const doc = JSON.parse(text) as { error?: { kind?: unknown } } | null;
      const kind = doc?.error?.kind;
      if (typeof kind === "string") return kind;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** The `stale` reason for an `hc` command that failed, so the phone can say which. */
export function failureReason(r: RunResult): bridgeApi.StaleReason {
  if (r.error === "ENOENT") return "hc_missing";
  if (r.error) return "source_unavailable";
  return hcErrorKind(r) === "not_found" ? "terminal_not_found" : "source_unavailable";
}

interface Poll {
  timer: NodeJS.Timeout | undefined;
  /** Ticks so far, read or not: `hc ls` runs on every {@link LS_EVERY}th. */
  ticks: number;
  failures: number;
  stopped: boolean;
}

/**
 * Publishes `chat:<t>` topics from `hc read <t> --lines N`, once a second while someone is subscribed (and not at all
 * otherwise), with `hc ls --json` checking now and then that the terminal still exists. Read-only: it never runs `hc send`.
 * The id in the topic name is checked against {@link bridgeApi.TERMINAL_ID} before it reaches the command line.
 */
export class ChatTopicDriver {
  private readonly o: ChatTopicOptions;
  private readonly polls = new Map<string, Poll>();
  /** Subscribed chats that found every slot taken; the first is read when a slot frees. */
  private readonly waiting = new Set<string>();
  private unwatch: (() => void) | undefined;

  constructor(opts: ChatTopicOptions) {
    this.o = opts;
  }

  start(): void {
    this.unwatch = this.o.hub.watchPrefix(CHAT_PREFIX, (topic, n) => (n > 0 ? this.open(topic) : this.close(topic)));
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.waiting.clear();
    for (const topic of [...this.polls.keys()]) this.close(topic);
  }

  get activeTopics(): string[] {
    return [...this.polls.keys()];
  }

  private open(topic: string): void {
    if (this.polls.has(topic)) return;
    const id = bridgeApi.chatTerminal(topic);
    if (id === null) return void this.o.hub.setStale(topic, "bad_terminal");
    if (this.polls.size >= MAX_ACTIVE_CHATS) {
      this.waiting.add(topic);
      return void this.o.hub.setStale(topic, "too_many_chats");
    }
    this.waiting.delete(topic);
    const poll: Poll = { timer: undefined, ticks: 0, failures: 0, stopped: false };
    this.polls.set(topic, poll);
    void this.tick(topic, id, poll);
  }

  private close(topic: string): void {
    this.waiting.delete(topic);
    const poll = this.polls.get(topic);
    if (poll) {
      poll.stopped = true;
      clearTimeout(poll.timer);
      this.polls.delete(topic);
    }
    this.o.hub.discard(topic);
    const next = this.waiting.values().next().value;
    if (poll && next !== undefined) this.open(next);
  }

  /**
   * One poll: `hc ls --json` now and then, then `hc read`. Every failure marks the topic stale with a reason the phone
   * shows at once (it never waits on a value that is not coming): `hc_missing` when hc can't be found,
   * `terminal_not_found` when hc says there is no such terminal, `source_unavailable` for the rest (a failing or
   * timed-out command). A `hc ls` that fails skips the read, so a dead core answers within one command timeout.
   */
  private async tick(topic: string, id: string, poll: Poll): Promise<void> {
    const bin = (this.o.binaries ?? DEFAULT_BINARIES).hc;
    const { hub } = this.o;
    const timeoutMs = this.o.readTimeoutMs ?? CHAT_READ_TIMEOUT_MS;
    const lsNow = poll.ticks % LS_EVERY === 0;
    poll.ticks += 1;
    let ok = false;
    try {
      if (lsNow) {
        const ls = await this.o.run(bin, ["ls", "--json"], { timeoutMs });
        if (poll.stopped) return;
        if (ls.error || ls.code !== 0) return this.fail(topic, id, poll, failureReason(ls));
        // Output it does not understand is not a failure: the read decides.
        const ids = terminalIds(ls.stdout);
        if (ids && !ids.has(id)) return this.fail(topic, id, poll, "terminal_not_found");
      }
      const r = await this.o.run(bin, ["read", id, "--lines", String(this.o.lines ?? CHAT_LINES)], { timeoutMs });
      if (poll.stopped) return;
      if (r.code === 0 && !r.error) {
        const { lines, truncated } = parseAnsi(r.stdout, { maxLines: this.o.lines ?? CHAT_LINES });
        const value: bridgeApi.ChatTopic = { terminal: id, lines, ...(truncated ? { truncated: true } : {}) };
        hub.publish(topic, value as unknown as Json);
        ok = true;
      } else {
        hub.setStale(topic, failureReason(r));
      }
    } catch {
      if (poll.stopped) return;
      hub.setStale(topic, "source_unavailable");
    }
    poll.failures = ok ? 0 : poll.failures + 1;
    this.schedule(topic, id, poll);
  }

  private fail(topic: string, id: string, poll: Poll, reason: bridgeApi.StaleReason): void {
    this.o.hub.setStale(topic, reason);
    poll.failures += 1;
    this.schedule(topic, id, poll);
  }

  private schedule(topic: string, id: string, poll: Poll): void {
    if (poll.stopped) return;
    const base = this.o.intervalMs ?? CHAT_INTERVAL_MS;
    // Back off while reads fail, so a dead core is not asked every second.
    const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(poll.failures, 3));
    poll.timer = setTimeout(() => void this.tick(topic, id, poll), delay);
    poll.timer.unref();
  }
}
