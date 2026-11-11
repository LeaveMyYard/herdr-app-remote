import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import type { Runner } from "../plugins/exec.js";
import { parseAnsi } from "./ansi.js";

export const CHAT_PREFIX = "chat:";
/** The poll interval: `hc events` is unverified against a live core (PLAN section 8), so a chat is read once a second. */
export const CHAT_INTERVAL_MS = 1_000;
export const CHAT_READ_TIMEOUT_MS = 5_000;
/** How many trailing lines each `hc read` asks for, and the most the topic keeps. */
export const CHAT_LINES = 200;
/** Chats read at once. A further one goes stale (`too_many_chats`) until another closes. */
export const MAX_ACTIVE_CHATS = 6;
/** `hc ls` is checked on the first read and then every this many reads, to notice a terminal that closed. */
const LS_EVERY = 10;
const MAX_BACKOFF_MS = 5_000;

export interface ChatTopicOptions {
  hub: Hub;
  run: Runner;
  binaries?: Binaries;
  intervalMs?: number;
  readTimeoutMs?: number;
  lines?: number;
}

/** Ids in `hc ls --json`, read tolerantly: the output shape is not verified, so anything else yields `null` (unknown). */
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
      for (const k of ["id", "terminal", "name"]) if (typeof r[k] === "string") ids.add(r[k] as string);
    }
  }
  return ids;
}

function firstArray(o: Record<string, unknown>): unknown[] | undefined {
  for (const k of ["terminals", "items", "ls"]) if (Array.isArray(o[k])) return o[k] as unknown[];
  return undefined;
}

interface Poll {
  timer: NodeJS.Timeout | undefined;
  reads: number;
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
    for (const topic of [...this.polls.keys()]) this.close(topic);
  }

  get activeTopics(): string[] {
    return [...this.polls.keys()];
  }

  private open(topic: string): void {
    if (this.polls.has(topic)) return;
    const id = bridgeApi.chatTerminal(topic);
    if (id === null) return void this.o.hub.setStale(topic, "bad_terminal");
    if (this.polls.size >= MAX_ACTIVE_CHATS) return void this.o.hub.setStale(topic, "too_many_chats");
    const poll: Poll = { timer: undefined, reads: 0, failures: 0, stopped: false };
    this.polls.set(topic, poll);
    void this.tick(topic, id, poll);
  }

  private close(topic: string): void {
    const poll = this.polls.get(topic);
    if (poll) {
      poll.stopped = true;
      clearTimeout(poll.timer);
      this.polls.delete(topic);
    }
    this.o.hub.discard(topic);
  }

  private async tick(topic: string, id: string, poll: Poll): Promise<void> {
    const bin = (this.o.binaries ?? DEFAULT_BINARIES).hc;
    const { hub } = this.o;
    let ok = false;
    try {
      if (poll.reads % LS_EVERY === 0) {
        const ls = await this.o.run(bin, ["ls", "--json"], { timeoutMs: this.o.readTimeoutMs ?? CHAT_READ_TIMEOUT_MS });
        if (poll.stopped) return;
        const ids = ls.code === 0 && !ls.error ? terminalIds(ls.stdout) : null;
        if (ids && !ids.has(id)) {
          hub.setStale(topic, "terminal_not_found");
          poll.failures += 1;
          return this.schedule(topic, id, poll);
        }
      }
      const r = await this.o.run(bin, ["read", id, "--lines", String(this.o.lines ?? CHAT_LINES)], { timeoutMs: this.o.readTimeoutMs ?? CHAT_READ_TIMEOUT_MS });
      if (poll.stopped) return;
      if (r.code === 0 && !r.error) {
        const { lines, truncated } = parseAnsi(r.stdout);
        const value: bridgeApi.ChatTopic = { terminal: id, lines, ...(truncated ? { truncated: true } : {}) };
        hub.publish(topic, value as unknown as Json);
        ok = true;
      } else {
        hub.setStale(topic, "source_unavailable");
      }
    } catch {
      if (poll.stopped) return;
      hub.setStale(topic, "source_unavailable");
    }
    poll.reads += 1;
    poll.failures = ok ? 0 : poll.failures + 1;
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
