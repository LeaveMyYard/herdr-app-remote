// The bridge client: one WebSocket to `/api/v1/ws` (bridge-api v1).
//
// - `hello` with `resume` (the epoch and each topic's last applied seq), then `sub` for every wanted topic.
// - `snap` replaces a topic, `patch` applies RFC 6902 ops when its seq is the next one; a gap, a patch before any
//   snap or a patch that doesn't apply re-subscribes that topic, which answers with a fresh snap.
// - `stale` keeps the last data and records the reason; the next snap clears it.
// - No optimistic UI: state changes only on snap, patch, stale and res. `act` resolves with the bridge's `res`.
// - iOS kills background sockets, so it reconnects on `visibilitychange` and `online`, plus backoff (0.5–10 s).
import { applyPatch, bridgeApi, type Json } from "@herdr-remote/protocol";

export type ClientStatus =
  /** Opening (first time, or straight after a wake). */
  | "connecting"
  | "online"
  /** The last attempt failed; retrying with backoff. */
  | "offline"
  /** `/api/v1/me` says this phone has no approved device. */
  | "unpaired"
  /** Revoked, `view` turned off, or the identity checks refused it. Not retried on its own. */
  | "refused"
  /** Remote access is paused on the desktop. Not retried on its own. */
  | "paused"
  /** The bridge refuses to serve for now (Funnel is on, or it is starting); retried with backoff. */
  | "unavailable";

export interface TopicView {
  /** Undefined while the topic has a `stale` reason but no snap yet. */
  data: Json | undefined;
  seq: number;
  /** The bridge's `stale {reason}`, or null. */
  stale: string | null;
}

export interface ClientSnapshot {
  status: ClientStatus;
  topics: Readonly<Record<string, TopicView>>;
}

export interface ActOutcome {
  ok: boolean;
  code?: string;
  /** The action may have run: say so, refresh, and never retry it by itself. */
  unknown_effect?: boolean;
}

/** The subset of the DOM WebSocket the client uses (injectable for tests). */
export interface SocketLike {
  readonly readyState: number;
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface BridgeClientOptions {
  /** Default: `wss://<this host>/api/v1/ws`. */
  url?: string;
  openSocket?: (url: string, protocols: string[]) => SocketLike;
  /** The status of `GET /api/v1/me`, or null when the request failed (network). */
  checkMe?: () => Promise<number | null>;
  /** Where `visibilitychange`, `online` and `offline` come from; omitted means no wake-ups. */
  events?: { win: Pick<Window, "addEventListener" | "removeEventListener">; doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> };
  pingMs?: number;
  /** No frame at all for this long means the socket is dead. */
  deadMs?: number;
  /** After a wake, a pong must arrive within this long. */
  wakeProbeMs?: number;
  backoff?: { min: number; max: number };
}

const OPEN = 1;
/** Security close codes (bridge-api v1) and the Funnel refusal. */
const CLOSE_REVOKED = 4001;
const CLOSE_PAUSED = 4002;
const CLOSE_NO_VIEW = 4003;
const CLOSE_FUNNEL = 4004;

function defaultUrl(): string {
  const l = window.location;
  return `${l.protocol === "http:" ? "ws" : "wss"}://${l.host}/api/v1/ws`;
}

async function defaultCheckMe(): Promise<number | null> {
  try {
    const r = await fetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
    return r.status;
  } catch {
    return null;
  }
}

export class BridgeClient {
  private readonly o: Required<Omit<BridgeClientOptions, "events">> & { events: BridgeClientOptions["events"] | undefined };
  private snap: ClientSnapshot = { status: "connecting", topics: {} };
  private readonly listeners = new Set<() => void>();
  /** Wanted topics, reference-counted. */
  private readonly wanted = new Map<string, number>();
  /** Topics subscribed on the current socket. */
  private subscribed = new Set<string>();
  private ws: SocketLike | null = null;
  private epoch: string | null = null;
  private greeted = false;
  private pending = new Map<string, (r: ActOutcome) => void>();
  private nextId = 1;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastInbound = 0;
  /** Frames received on the current socket (the wake probe compares it). */
  private inbound = 0;
  private running = false;
  /** Bumped per connection attempt, so a stale `checkMe` or socket can't act on a newer one. */
  private generation = 0;

  constructor(opts: BridgeClientOptions = {}) {
    this.o = {
      url: opts.url ?? defaultUrl(),
      openSocket: opts.openSocket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike),
      checkMe: opts.checkMe ?? defaultCheckMe,
      events: opts.events,
      pingMs: opts.pingMs ?? 20_000,
      deadMs: opts.deadMs ?? 45_000,
      wakeProbeMs: opts.wakeProbeMs ?? 5_000,
      backoff: opts.backoff ?? { min: 500, max: 10_000 },
    };
  }

  // ---- store (for useSyncExternalStore) ----

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly getSnapshot = (): ClientSnapshot => this.snap;

  private set(next: Partial<ClientSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const fn of [...this.listeners]) fn();
  }

  private setTopic(name: string, view: TopicView): void {
    this.set({ topics: { ...this.snap.topics, [name]: view } });
  }

  // ---- lifecycle ----

  start(): void {
    if (this.running) return;
    this.running = true;
    const ev = this.o.events;
    if (ev) {
      ev.doc.addEventListener("visibilitychange", this.onVisibility);
      ev.win.addEventListener("online", this.wake);
      ev.win.addEventListener("offline", this.onOffline);
    }
    void this.connect();
  }

  stop(): void {
    this.running = false;
    const ev = this.o.events;
    if (ev) {
      ev.doc.removeEventListener("visibilitychange", this.onVisibility);
      ev.win.removeEventListener("online", this.wake);
      ev.win.removeEventListener("offline", this.onOffline);
    }
    this.generation += 1;
    this.clearTimers();
    this.dropSocket();
  }

  private readonly onVisibility = (): void => {
    if (this.o.events?.doc.visibilityState === "visible") this.wake();
  };

  private readonly onOffline = (): void => {
    if (this.snap.status === "online" || this.snap.status === "connecting") this.set({ status: "offline" });
  };

  /**
   * The app came back to the foreground or the network returned: reconnect now if there is no socket, otherwise
   * check the socket with a ping (iOS may have killed it without a close event).
   */
  readonly wake = (): void => {
    if (!this.running) return;
    if (this.ws && this.ws.readyState === OPEN && this.greeted) {
      const seen = this.inbound;
      this.sendRaw({ type: "ping" });
      if (this.probeTimer) clearTimeout(this.probeTimer);
      this.probeTimer = setTimeout(() => {
        if (this.inbound === seen) this.reconnectNow();
      }, this.o.wakeProbeMs);
      return;
    }
    this.reconnectNow();
  };

  private reconnectNow(): void {
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.dropSocket();
    void this.connect();
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.retryTimer = this.pingTimer = this.probeTimer = undefined;
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.greeted = false;
    this.subscribed = new Set();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "reconnect");
      } catch {
        // already closed
      }
    }
    this.failPending();
  }

  /** Acts in flight when the socket went: the bridge may have run them. */
  private failPending(): void {
    const pending = this.pending;
    this.pending = new Map();
    for (const resolve of pending.values()) resolve({ ok: false, code: "connection_lost", unknown_effect: true });
  }

  private retry(status: ClientStatus, atMax = false): void {
    this.set({ status });
    if (!this.running) return;
    const { min, max } = this.o.backoff;
    const delay = atMax ? max : Math.min(max, min * 2 ** this.attempt);
    this.attempt += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const gen = ++this.generation;
    if (this.snap.status !== "offline") this.set({ status: "connecting" });
    // The upgrade's refusal is invisible to a browser (just a close), so ask first why it would fail.
    const me = await this.o.checkMe();
    if (gen !== this.generation || !this.running) return;
    if (me === null) return this.retry("offline");
    if (me === 401) return this.retry("unpaired", true);
    if (me === 403) return this.set({ status: "refused" });
    if (me === 503) return this.retry("unavailable", true);
    if (me !== 200) return this.retry("offline");
    let ws: SocketLike;
    try {
      ws = this.o.openSocket(this.o.url, [bridgeApi.WS_PROTOCOL]);
    } catch {
      return this.retry("offline");
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastInbound = Date.now();
      const resume = this.resumeInfo();
      this.sendRaw(resume ? { type: "hello", api: bridgeApi.API_VERSION, resume } : { type: "hello", api: bridgeApi.API_VERSION });
      this.pingTimer = setInterval(() => this.heartbeat(), this.o.pingMs);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastInbound = Date.now();
      this.inbound += 1;
      if (typeof ev.data === "string") this.onFrame(ev.data);
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.greeted = false;
      this.subscribed = new Set();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      this.failPending();
      this.onClosed(ev.code);
    };
  }

  private onClosed(code: number): void {
    if (code === CLOSE_REVOKED || code === CLOSE_NO_VIEW) return this.set({ status: "refused" });
    if (code === CLOSE_PAUSED) return this.set({ status: "paused" });
    if (code === CLOSE_FUNNEL) return this.retry("unavailable", true);
    this.retry("offline");
  }

  private heartbeat(): void {
    if (Date.now() - this.lastInbound > this.o.deadMs) {
      this.reconnectNow();
      return;
    }
    this.sendRaw({ type: "ping" });
  }

  private resumeInfo(): { epoch: string; seqs: Record<string, number> } | undefined {
    if (this.epoch === null) return undefined;
    const seqs: Record<string, number> = {};
    for (const [name, t] of Object.entries(this.snap.topics)) if (t.data !== undefined && t.seq >= 0) seqs[name] = t.seq;
    return { epoch: this.epoch, seqs };
  }

  private sendRaw(msg: bridgeApi.ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  // ---- topics ----

  /** Asks for a topic; the returned function gives it up. (The protocol has no unsub: it lasts the socket.) */
  want(topic: string): () => void {
    this.wanted.set(topic, (this.wanted.get(topic) ?? 0) + 1);
    this.flushSubs();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.wanted.get(topic) ?? 1) - 1;
      if (n <= 0) this.wanted.delete(topic);
      else this.wanted.set(topic, n);
    };
  }

  private flushSubs(): void {
    if (!this.greeted) return;
    const topics = [...this.wanted.keys()].filter((t) => !this.subscribed.has(t));
    if (topics.length === 0) return;
    if (this.sendRaw({ type: "sub", topics })) for (const t of topics) this.subscribed.add(t);
  }

  /** Asks the bridge for a topic's current state again (after an action with an unknown effect). */
  refresh(topic: string): void {
    if (this.subscribed.has(topic)) this.resubscribe(topic);
  }

  private resubscribe(topic: string): void {
    this.sendRaw({ type: "sub", topics: [topic] });
  }

  private onFrame(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = bridgeApi.ServerMessage.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    switch (msg.type) {
      case "welcome": {
        if (this.epoch !== msg.epoch) {
          // A new bridge: old seqs mean nothing. The data stays on screen until its fresh snap arrives.
          this.epoch = msg.epoch;
          const topics: Record<string, TopicView> = {};
          for (const [name, t] of Object.entries(this.snap.topics)) topics[name] = { ...t, seq: -1 };
          this.set({ topics });
        }
        this.greeted = true;
        this.attempt = 0;
        this.set({ status: "online" });
        this.flushSubs();
        return;
      }
      case "snap":
        if (msg.epoch !== this.epoch) return;
        this.setTopic(msg.topic, { data: msg.data as Json, seq: msg.seq, stale: null });
        return;
      case "patch": {
        const cur = this.snap.topics[msg.topic];
        if (!cur || cur.data === undefined || cur.seq < 0 || msg.seq !== cur.seq + 1) {
          // Already current (a resume replay of an old patch) is not a gap.
          if (!cur || msg.seq > cur.seq) this.resubscribe(msg.topic);
          return;
        }
        let data: Json;
        try {
          data = applyPatch(cur.data, msg.ops);
        } catch {
          this.resubscribe(msg.topic);
          return;
        }
        this.setTopic(msg.topic, { data, seq: msg.seq, stale: cur.stale });
        return;
      }
      case "stale": {
        const cur = this.snap.topics[msg.topic];
        // A topic with no state yet still records why (host before the first link hello).
        this.setTopic(msg.topic, cur ? { ...cur, stale: msg.reason } : { data: undefined, seq: -1, stale: msg.reason });
        return;
      }
      case "res": {
        const resolve = this.pending.get(msg.id);
        if (!resolve) return;
        this.pending.delete(msg.id);
        resolve(msg.ok ? { ok: true } : { ok: false, code: msg.code ?? "failed", ...(msg.unknown_effect ? { unknown_effect: true } : {}) });
        return;
      }
      default:
        return;
    }
  }

  // ---- actions ----

  /** Sends an `act`; resolves with the bridge's answer. Never retried: an unknown effect is reported as such. */
  act(kind: string, args: Record<string, unknown> = {}): Promise<ActOutcome> {
    if (!this.greeted) return Promise.resolve({ ok: false, code: "offline" });
    const id = `a${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (!this.sendRaw({ type: "act", id, kind, args })) {
        this.pending.delete(id);
        resolve({ ok: false, code: "offline" });
      }
    });
  }
}
