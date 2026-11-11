import { randomBytes } from "node:crypto";
import { bridgeApi } from "@herdr-remote/protocol";
import { diff, type Json } from "./patch.js";

type ServerMessage = bridgeApi.ServerMessage;
type PatchOp = bridgeApi.PatchOp;

/** How many patches per topic are kept for `hello.resume` replay. */
const LOG_SIZE = 64;
/** Subscriptions one connection may hold; the real topic set is small (`chat:<t>` is the open-ended one). */
const MAX_TOPICS_PER_CONN = 64;

/** Who a connection acts as: set by the request guard at upgrade (S5). */
export interface Principal {
  readonly deviceId: string;
}

/** One connected client, transport-agnostic. */
export interface HubClient {
  /** The authenticated device, when the server's guard supplied one. */
  readonly principal?: Principal;
  /** Sends one server message. Must not throw. */
  send(msg: ServerMessage): void;
  /** Closes the connection. */
  close(code: number, reason: string): void;
  /** Drops the transport at once, without waiting for the peer's close handshake. */
  terminate?(): void;
}

export interface ActResult {
  ok: boolean;
  code?: string;
  unknown_effect?: boolean;
  /**
   * The option label the bridge itself resolved for an answer (S11), for the audit log.
   * Never sent to the client, and never taken from the client's args.
   */
  audit_label?: string;
  /** Plain text the PWA may show (the plugin's own words). Never free text the client sent. */
  message?: string;
  /** For an inbox `act`: the row is closed now, and why. */
  closed?: bridgeApi.Res["closed"];
}

/** Handles an `act`. `Security.act` wraps the real handler with capability checks and the audit log. */
export type ActHandler = (client: HubClient, kind: string, args: Record<string, unknown>) => Promise<ActResult> | ActResult;

interface TopicState {
  seq: number;
  data: Json | undefined;
  stale: string | null;
  /** Recent patches, oldest first; `log[i].seq` are consecutive. */
  log: { seq: number; ops: PatchOp[] }[];
  subscribers: Set<ConnState>;
  /** Called with the new subscriber count whenever it changes. */
  watchers: Set<(count: number) => void>;
}

interface ConnState {
  client: HubClient;
  greeted: boolean;
  /** Resume info from `hello`, consumed per topic on first `sub`. */
  resume: { epoch: string; seqs: Record<string, number> } | undefined;
  topics: Set<string>;
  /** Set once the connection was closed for a protocol error: later frames are dropped. */
  dead: boolean;
}

export interface HubOptions {
  bridgeVersion: string;
  epoch?: string;
  onAct?: ActHandler;
}

/**
 * The snap/patch engine. Sources publish whole topic values with `publish`; the hub
 * diffs against the previous value and fans an RFC 6902 patch out to subscribers.
 * `seq` is per topic within an epoch.
 */
export class Hub {
  readonly epoch: string;
  readonly bridgeVersion: string;
  private readonly topics = new Map<string, TopicState>();
  /** Last `seq` of discarded topics, so a topic that comes back never reuses a number a client may have applied. */
  private readonly retired = new Map<string, number>();
  private readonly conns = new Set<ConnState>();
  private readonly prefixWatchers = new Set<{ prefix: string; fn: (topic: string, count: number) => void }>();
  private readonly onAct: ActHandler | undefined;

  constructor(opts: HubOptions) {
    this.epoch = opts.epoch ?? randomBytes(16).toString("hex");
    this.bridgeVersion = opts.bridgeVersion;
    this.onAct = opts.onAct;
  }

  private topic(name: string): TopicState {
    let t = this.topics.get(name);
    if (!t) {
      t = { seq: this.retired.get(name) ?? 0, data: undefined, stale: null, log: [], subscribers: new Set(), watchers: new Set() };
      this.topics.set(name, t);
    }
    return t;
  }

  /** Current value of a topic, if any source has published one. */
  get(name: string): Json | undefined {
    return this.topics.get(name)?.data;
  }

  isStale(name: string): string | null {
    return this.topics.get(name)?.stale ?? null;
  }

  seqOf(name: string): number {
    return this.topics.get(name)?.seq ?? 0;
  }

  /**
   * Calls `fn` with the topic's subscriber count at once if there are subscribers, and each time it changes (a `sub`, or a client going away),
   * so a source can poll only while someone is looking. Returns a function that removes the watcher.
   */
  watchSubscribers(name: string, fn: (count: number) => void): () => void {
    const t = this.topic(name);
    t.watchers.add(fn);
    if (t.subscribers.size > 0) fn(t.subscribers.size);
    return () => {
      t.watchers.delete(fn);
    };
  }

  /**
   * Like {@link watchSubscribers} for every topic whose name starts with `prefix` (`chat:`): `fn` hears each topic's count
   * whenever it changes, and gets a call at once for each such topic that already has subscribers.
   */
  watchPrefix(prefix: string, fn: (topic: string, count: number) => void): () => void {
    const entry = { prefix, fn };
    this.prefixWatchers.add(entry);
    for (const [name, t] of [...this.topics]) if (name.startsWith(prefix) && t.subscribers.size > 0) fn(name, t.subscribers.size);
    return () => {
      this.prefixWatchers.delete(entry);
    };
  }

  /** Forgets a topic nobody subscribes to, so an open-ended family (`chat:<t>`) does not keep its last value forever. */
  discard(name: string): void {
    const t = this.topics.get(name);
    if (t && t.subscribers.size === 0 && t.watchers.size === 0) {
      this.topics.delete(name);
      this.retired.delete(name);
      this.retired.set(name, t.seq);
      if (this.retired.size > 1024) this.retired.delete(this.retired.keys().next().value as string);
    }
  }

  private notifyWatchers(name: string, t: TopicState): void {
    for (const w of [...t.watchers]) w(t.subscribers.size);
    for (const { prefix, fn } of [...this.prefixWatchers]) if (name.startsWith(prefix)) fn(name, t.subscribers.size);
  }

  /** Publishes the new full value of a topic. Clears staleness (with a fresh snap) and patches otherwise. */
  publish(name: string, data: Json): void {
    const t = this.topic(name);
    if (t.data === undefined || t.stale !== null) {
      // First value, or leaving a stale period: subscribers get a fresh snap.
      t.data = data;
      t.stale = null;
      this.rebase(name, t);
      return;
    }
    const ops = diff(t.data, data);
    if (ops.length === 0) return;
    t.data = data;
    t.seq += 1;
    t.log.push({ seq: t.seq, ops });
    if (t.log.length > LOG_SIZE) t.log.shift();
    const msg: ServerMessage = { type: "patch", topic: name, seq: t.seq, ops };
    for (const c of t.subscribers) c.client.send(msg);
  }

  /** Marks a topic stale; the last value stays. Idempotent per reason. */
  setStale(name: string, reason: string): void {
    const t = this.topic(name);
    if (t.stale === reason) return;
    t.stale = reason;
    const msg: ServerMessage = { type: "stale", topic: name, reason };
    for (const c of t.subscribers) c.client.send(msg);
  }

  /** New seq, drop the patch log (replay across a snap is meaningless), snap everyone. */
  private rebase(name: string, t: TopicState): void {
    t.seq += 1;
    t.log = [];
    for (const c of t.subscribers) this.sendSnap(c, name, t);
  }

  private sendSnap(c: ConnState, name: string, t: TopicState): void {
    if (t.data === undefined) return;
    c.client.send({ type: "snap", topic: name, epoch: this.epoch, seq: t.seq, data: t.data });
  }

  connect(client: HubClient): ConnState {
    const c: ConnState = { client, greeted: false, resume: undefined, topics: new Set(), dead: false };
    this.conns.add(c);
    return c;
  }

  disconnect(c: ConnState): void {
    this.conns.delete(c);
    for (const name of c.topics) {
      const t = this.topics.get(name);
      if (!t) continue;
      if (t.subscribers.delete(c)) this.notifyWatchers(name, t);
      // Don't let subscriptions to arbitrary topic names (`chat:<anything>`) leak state.
      if (t.subscribers.size === 0 && t.data === undefined && t.stale === null && t.watchers.size === 0) this.topics.delete(name);
    }
    c.topics.clear();
  }

  get topicCount(): number {
    return this.topics.size;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Drops every client (used when the bridge pauses or shuts down). */
  closeAll(code: number, reason: string): void {
    for (const c of [...this.conns]) c.client.close(code, reason);
  }

  private kill(c: ConnState, code: number, reason: string): void {
    c.dead = true;
    c.client.close(code, reason);
  }

  /** Handles one raw text frame from a client. */
  async handleRaw(c: ConnState, raw: string): Promise<void> {
    if (c.dead) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.kill(c, 1003, "bad json");
      return;
    }
    const parsed = bridgeApi.ClientMessage.safeParse(json);
    if (!parsed.success) {
      this.kill(c, 1003, "bad message");
      return;
    }
    await this.handle(c, parsed.data);
  }

  private async handle(c: ConnState, msg: bridgeApi.ClientMessage): Promise<void> {
    if (msg.type === "hello") {
      if (c.greeted) {
        this.kill(c, 1002, "duplicate hello");
        return;
      }
      c.greeted = true;
      c.resume = msg.resume;
      c.client.send({ type: "welcome", api: bridgeApi.API_VERSION, bridge: this.bridgeVersion, epoch: this.epoch });
      return;
    }
    if (!c.greeted) {
      this.kill(c, 1002, "hello first");
      return;
    }
    switch (msg.type) {
      case "ping":
        c.client.send({ type: "pong" });
        return;
      case "sub":
        for (const name of new Set(msg.topics)) {
          if (!c.topics.has(name) && c.topics.size >= MAX_TOPICS_PER_CONN) {
            this.kill(c, 1008, "too many topics");
            return;
          }
          this.subscribe(c, name);
        }
        return;
      case "act": {
        let res: ActResult;
        try {
          res = this.onAct ? await this.onAct(c.client, msg.kind, msg.args) : { ok: false, code: "unsupported_action" };
        } catch {
          res = { ok: false, code: "internal_error", unknown_effect: true };
        }
        c.client.send(toRes(msg.id, res));
        return;
      }
    }
  }

  /**
   * Subscribes to a topic. Always (re)sends state, so re-subscribing is how a client
   * recovers from a seq gap: a snap, or a patch replay when `hello.resume` is still
   * covered by the log.
   */
  private subscribe(c: ConnState, name: string): void {
    const t = this.topic(name);
    const added = !t.subscribers.has(c);
    t.subscribers.add(c);
    c.topics.add(name);
    const resumeSeq = c.resume && c.resume.epoch === this.epoch ? c.resume.seqs[name] : undefined;
    if (c.resume) delete c.resume.seqs[name];
    if (t.data !== undefined) {
      const replay = resumeSeq !== undefined ? this.replayFrom(t, resumeSeq) : null;
      if (replay === null) this.sendSnap(c, name, t);
      else for (const p of replay) c.client.send({ type: "patch", topic: name, seq: p.seq, ops: p.ops });
    }
    if (t.stale !== null) c.client.send({ type: "stale", topic: name, reason: t.stale });
    if (added) this.notifyWatchers(name, t);
  }

  /** Patches after `seq`, [] if already current, or null if the log can't cover it. */
  private replayFrom(t: TopicState, seq: number): { seq: number; ops: PatchOp[] }[] | null {
    if (seq === t.seq) return [];
    if (seq > t.seq) return null;
    const first = t.log[0];
    if (!first || first.seq > seq + 1) return null;
    return t.log.filter((p) => p.seq > seq);
  }
}

/** The client's copy of a result: `audit_label` (and anything else) stays on the bridge. */
export function toRes(id: string, r: ActResult): bridgeApi.Res {
  const out: bridgeApi.Res = r.ok ? { type: "res", id, ok: true } : { type: "res", id, ok: false, code: r.code ?? "failed" };
  if (!r.ok && r.unknown_effect) out.unknown_effect = true;
  if (typeof r.message === "string" && r.message !== "") out.message = r.message.slice(0, 2000);
  if (r.closed !== undefined && (bridgeApi.INBOX_CLOSED as readonly string[]).includes(r.closed)) out.closed = r.closed;
  return out;
}

export type { ConnState };
