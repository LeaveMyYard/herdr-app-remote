// The bridge's end of mod-link v1: a loopback-only NDJSON server for the herdr-app-remote mod.
//
// Security rules (docs/protocol/mod-link-v1.md, PLAN §2):
// - binds 127.0.0.1 only;
// - the first line must be a valid `hello` carrying the runtime token; anything else, a slow or
//   oversized preamble, or a wrong token drops the peer;
// - one connection slot per `copy`: the newest valid hello wins, `link` and `panel` never displace
//   each other; only the `link` copy's `state` feeds `host`;
// - `run` is checked against the allowlist before anything is sent; the mod checks it again.
import { EventEmitter } from "node:events";
import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { modLink, type HostState } from "@herdr-remote/protocol";

type Copy = modLink.ModCopy;

export interface LinkServerOptions {
  /** The runtime token every `hello` must carry. */
  token: string;
  /** 0 (default) picks a free port. */
  port?: number;
  /** Only loopback addresses are accepted; the default and only sensible value is 127.0.0.1. */
  host?: string;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  /** A peer that sends nothing for this long (pongs included) is dropped. Default 2.5 × ping. */
  idleTimeoutMs?: number;
  runTimeoutMs?: number;
  maxConnections?: number;
  log?: (event: LinkLogEvent) => void;
}

/** Structured log events. They never carry tokens, state contents or command arguments. */
export type LinkLogEvent =
  | { event: "listening"; port: number }
  | { event: "auth_failed"; reason: "not_hello" | "bad_hello" | "bad_token" | "timeout" | "too_long" | "closed" }
  | { event: "link"; copy: Copy; replaced: boolean }
  | { event: "unlink"; copy: Copy }
  | { event: "dropped_line"; copy: Copy; reason: "invalid" | "panel_state" | "stale_seq" | "unknown_result" }
  | { event: "dropped_peer"; copy: Copy; reason: "too_long" | "idle" | "backpressure" }
  | { event: "run_refused"; name: string; error: modLink.RunRefusal };

export interface HostSnapshot {
  state: HostState;
  seq: number;
  layout: string;
  app: { version: string };
}

export type RunOutcome =
  | { ok: true }
  | {
      ok: false;
      /** `not_allowed`/`bad_args`: refused here or by the mod, nothing ran. `no_link`: nothing sent. */
      code: "not_allowed" | "bad_args" | "no_link" | "failed" | "timeout" | "link_lost";
      error?: string;
      /** True when the command may have run: never retry it automatically. */
      unknown_effect: boolean;
    };

interface Pending {
  resolve: (r: RunOutcome) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  socket: net.Socket;
  hello: modLink.Hello | null;
  buf: Buffer;
  lastSeq: number;
  lastInbound: number;
  pending: Map<string, Pending>;
  closed: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1"]);
const MAX_ERROR_LEN = 200;
/** Bridge-to-mod bytes we let queue before deciding the mod is not reading. */
const MAX_QUEUED_OUT = 4 * modLink.LINE_LIMITS.bridgeToMod;

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Events: `link` `{copy, hello}` (a copy authenticated), `unlink` `{copy}` (the current connection
 * of that copy went; not emitted for a replaced one), `host` {@link HostSnapshot} (a new `state`
 * from the link copy).
 */
export class LinkServer extends EventEmitter {
  private readonly opts: Required<Omit<LinkServerOptions, "log" | "idleTimeoutMs">> & { idleTimeoutMs: number };
  private readonly tokenDigest: Buffer;
  private readonly log: (e: LinkLogEvent) => void;
  private readonly server: net.Server;
  private readonly conns = new Set<Conn>();
  private readonly slots = new Map<Copy, Conn>();
  private pingTimer: NodeJS.Timeout | null = null;
  private runCounter = 0;
  private lastHostSnapshot: HostSnapshot | null = null;

  constructor(options: LinkServerOptions) {
    super();
    if (typeof options.token !== "string" || options.token.length < 32) throw new Error("link token must be at least 32 chars");
    const host = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1") throw new Error("the link server binds 127.0.0.1 only");
    const pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.opts = {
      token: options.token,
      port: options.port ?? 0,
      host,
      helloTimeoutMs: options.helloTimeoutMs ?? 5_000,
      pingIntervalMs,
      idleTimeoutMs: options.idleTimeoutMs ?? Math.round(pingIntervalMs * 2.5),
      runTimeoutMs: options.runTimeoutMs ?? 10_000,
      maxConnections: options.maxConnections ?? 8,
    };
    this.tokenDigest = digest(options.token);
    this.log = options.log ?? (() => {});
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.maxConnections = this.opts.maxConnections;
  }

  /** Starts listening; resolves with the bound port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: this.opts.host, port: this.opts.port, exclusive: true }, () => {
        this.server.off("error", reject);
        const port = this.port;
        this.pingTimer = setInterval(() => this.heartbeat(), this.opts.pingIntervalMs);
        this.pingTimer.unref();
        this.log({ event: "listening", port });
        resolve(port);
      });
    });
  }

  get port(): number {
    const a = this.server.address();
    if (!a || typeof a === "string") throw new Error("not listening");
    return a.port;
  }

  /** The bound address (for tests and diagnostics). */
  get address(): string {
    const a = this.server.address();
    if (!a || typeof a === "string") throw new Error("not listening");
    return a.address;
  }

  /** The latest `state` from the link copy, kept after the link drops (shown as stale). */
  get lastHost(): HostSnapshot | null {
    return this.lastHostSnapshot;
  }

  connected(copy: Copy = "link"): boolean {
    return this.slots.has(copy);
  }

  /** Runs an allowlisted command through a mod copy. Never throws. */
  run(name: string, args: Record<string, unknown>, opts: { copy?: Copy; timeoutMs?: number } = {}): Promise<RunOutcome> {
    const check = modLink.checkRun(name, args);
    if (!check.ok) {
      this.log({ event: "run_refused", name: check.error === "not_allowed" ? "(not allowed)" : name, error: check.error });
      return Promise.resolve({ ok: false, code: check.error, unknown_effect: false });
    }
    const conn = this.slots.get(opts.copy ?? "link");
    if (!conn) return Promise.resolve({ ok: false, code: "no_link", unknown_effect: false });
    this.runCounter += 1;
    const id = `run-${this.runCounter}`;
    return new Promise<RunOutcome>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ ok: false, code: "timeout", unknown_effect: true });
      }, opts.timeoutMs ?? this.opts.runTimeoutMs);
      timer.unref();
      conn.pending.set(id, { resolve, timer });
      this.send(conn, { type: "run", id, name: check.name, args });
    });
  }

  /** Shows a toast through a mod copy. Returns false when that copy is not linked. */
  notify(level: modLink.Notify["level"], message: string, copy: Copy = "link"): boolean {
    const conn = this.slots.get(copy);
    if (!conn) return false;
    this.send(conn, { type: "notify", level, message: message.slice(0, 500) });
    return true;
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const c of [...this.conns]) this.drop(c);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- connections ----

  private accept(socket: net.Socket): void {
    if (!socket.remoteAddress || !LOOPBACK.has(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const conn: Conn = {
      socket,
      hello: null,
      buf: Buffer.alloc(0),
      lastSeq: -1,
      lastInbound: Date.now(),
      pending: new Map(),
      closed: false,
    };
    this.conns.add(conn);
    socket.setNoDelay(true);
    const helloTimer = setTimeout(() => {
      if (!conn.hello) this.reject(conn, "timeout");
    }, this.opts.helloTimeoutMs);
    helloTimer.unref();
    socket.on("data", (chunk: Buffer) => this.onData(conn, chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!conn.hello && !conn.closed) this.log({ event: "auth_failed", reason: "closed" });
      this.drop(conn);
    });
  }

  private onData(conn: Conn, chunk: Buffer): void {
    if (conn.closed) return;
    conn.lastInbound = Date.now();
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    for (;;) {
      if (conn.closed) return;
      const i = conn.buf.indexOf(0x0a);
      const limit = conn.hello ? modLink.LINE_LIMITS.modToBridge : modLink.LINE_LIMITS.preHello;
      if (i < 0) {
        if (conn.buf.length > limit) this.tooLong(conn);
        return;
      }
      if (i > limit) {
        this.tooLong(conn);
        return;
      }
      const line = conn.buf.subarray(0, i).toString("utf8");
      conn.buf = conn.buf.subarray(i + 1);
      if (line.trim() === "") continue;
      if (conn.hello) this.onMessage(conn, conn.hello.copy, line);
      else this.onHello(conn, line);
    }
  }

  private tooLong(conn: Conn): void {
    if (conn.hello) {
      this.log({ event: "dropped_peer", copy: conn.hello.copy, reason: "too_long" });
      this.drop(conn);
    } else {
      this.reject(conn, "too_long");
    }
  }

  private onHello(conn: Conn, line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.reject(conn, "not_hello");
      return;
    }
    if (!json || typeof json !== "object" || (json as { type?: unknown }).type !== "hello") {
      this.reject(conn, "not_hello");
      return;
    }
    const parsed = modLink.Hello.safeParse(json);
    if (!parsed.success) {
      this.reject(conn, "bad_hello");
      return;
    }
    if (!timingSafeEqual(digest(parsed.data.token), this.tokenDigest)) {
      this.reject(conn, "bad_token");
      return;
    }
    const hello = parsed.data;
    conn.hello = hello;
    const previous = this.slots.get(hello.copy);
    this.slots.set(hello.copy, conn);
    if (previous) this.drop(previous);
    this.log({ event: "link", copy: hello.copy, replaced: Boolean(previous) });
    this.emit("link", { copy: hello.copy, hello });
  }

  private reject(conn: Conn, reason: Extract<LinkLogEvent, { event: "auth_failed" }>["reason"]): void {
    this.log({ event: "auth_failed", reason });
    conn.closed = true;
    this.conns.delete(conn);
    conn.socket.destroy();
  }

  private onMessage(conn: Conn, copy: Copy, line: string): void {
    const r = modLink.parseLine(modLink.ModToBridge, line);
    if (!r.success) {
      this.log({ event: "dropped_line", copy, reason: "invalid" });
      return;
    }
    const msg = r.data;
    switch (msg.type) {
      case "hello":
        // A second hello on an open connection is not a re-auth; ignore it.
        this.log({ event: "dropped_line", copy, reason: "invalid" });
        return;
      case "state":
        if (copy !== "link") {
          this.log({ event: "dropped_line", copy, reason: "panel_state" });
          return;
        }
        if (msg.seq <= conn.lastSeq) {
          this.log({ event: "dropped_line", copy, reason: "stale_seq" });
          return;
        }
        conn.lastSeq = msg.seq;
        if (this.slots.get("link") !== conn || !conn.hello) return;
        this.lastHostSnapshot = { state: msg.host, seq: msg.seq, layout: conn.hello.layout, app: conn.hello.app };
        this.emit("host", this.lastHostSnapshot);
        return;
      case "result": {
        const p = conn.pending.get(msg.id);
        if (!p) {
          this.log({ event: "dropped_line", copy, reason: "unknown_result" });
          return;
        }
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) {
          p.resolve({ ok: true });
        } else {
          const error = (msg.error ?? "failed").slice(0, MAX_ERROR_LEN);
          const refused = error === "not_allowed" || error === "bad_args";
          p.resolve(
            refused
              ? { ok: false, code: error, unknown_effect: false }
              : { ok: false, code: "failed", error, unknown_effect: true },
          );
        }
        return;
      }
      case "pong":
        return;
    }
  }

  private send(conn: Conn, msg: modLink.BridgeToMod): void {
    if (conn.closed) return;
    if (conn.socket.writableLength > MAX_QUEUED_OUT) {
      if (conn.hello) this.log({ event: "dropped_peer", copy: conn.hello.copy, reason: "backpressure" });
      this.drop(conn);
      return;
    }
    conn.socket.write(modLink.encodeLine(msg));
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const conn of [...this.slots.values()]) {
      if (now - conn.lastInbound > this.opts.idleTimeoutMs) {
        if (conn.hello) this.log({ event: "dropped_peer", copy: conn.hello.copy, reason: "idle" });
        this.drop(conn);
        continue;
      }
      this.send(conn, { type: "ping" });
    }
  }

  private drop(conn: Conn): void {
    conn.closed = true;
    this.conns.delete(conn);
    if (!conn.socket.destroyed) conn.socket.destroy();
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: "link_lost", unknown_effect: true });
      conn.pending.delete(id);
    }
    const copy = conn.hello?.copy;
    if (copy && this.slots.get(copy) === conn) {
      this.slots.delete(copy);
      this.log({ event: "unlink", copy });
      this.emit("unlink", { copy });
    }
  }
}
