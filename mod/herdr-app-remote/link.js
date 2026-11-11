// The mod's end of mod-link v1 (docs/protocol/mod-link-v1.md): one TCP connection to the bridge
// on 127.0.0.1, `hello` with the runtime token, then `state` out and `run`/`notify`/`ping` in.
//
// - `offer(host)` keeps only the latest snapshot; a sender task writes it when its content
//   differs from what was last sent on this connection, at most once per STATE_MIN_INTERVAL_MS,
//   with at most one write in flight (so a slow socket coalesces instead of queueing).
// - `run` is checked against our own allowlist before herdr's run() is called.
// - The connection loop reconnects with backoff from 0.5 s to 10 s and stops for good on close().
// - Never keep a cx: every loop runs in its own cx.spawn task and uses that task's cx.
import net from 'net';
import { appHome, notify as herdrNotify, readTextFile, run as herdrRun } from 'herdr';
import { checkRun } from './allowlist.js';

export const RUNTIME_RELATIVE_PATH = 'data/herdr-app-remote/runtime.json';
export const BACKOFF_MS = Object.freeze({ min: 500, max: 10000 });
export const STATE_MIN_INTERVAL_MS = 100;
/** A connection that lasted this long, or got any message, resets the backoff. */
export const HEALTHY_MS = 5000;
/** Bridge-to-mod line limit (LINE_LIMITS.bridgeToMod). */
export const MAX_LINE = 1024 * 1024;
const MAX_TOAST = 500;

const LEVELS = { info: 'info', warn: 'warning', error: 'error' };

/** Reads and checks runtime.json; null when absent or malformed. */
export async function readRuntime(read = readTextFile, home = appHome) {
  let text;
  try {
    text = await read(`${home()}/${RUNTIME_RELATIVE_PATH}`);
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  let rt;
  try {
    rt = JSON.parse(text);
  } catch {
    return null;
  }
  if (!rt || rt.v !== 1) return null;
  if (!Number.isInteger(rt.port) || rt.port < 1 || rt.port > 65535) return null;
  if (typeof rt.token !== 'string' || rt.token.length < 32 || rt.token.length > 256) return null;
  return { port: rt.port, token: rt.token };
}

function decodeAscii(bytes) {
  // The bridge sends ASCII-only lines (encodeLine), so a byte is a char.
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class Link {
  /**
   * @param {object} o
   * @param {'link'|'panel'} o.copy
   * @param {() => {layout: string, app: {version: string}}} o.hello
   * @param {(name: string, args: object) => unknown} [o.run]   herdr's run
   * @param {(n: object) => unknown} [o.notify]                herdr's notify
   * @param {() => Promise<{port: number, token: string} | null>} [o.runtime]
   * @param {(host: string, port: number) => Promise<any>} [o.connect]
   */
  constructor(o) {
    this.copy = o.copy;
    this.helloInfo = o.hello;
    this.runFn = o.run ?? herdrRun;
    this.notifyFn = o.notify ?? herdrNotify;
    this.runtimeFn = o.runtime ?? (() => readRuntime());
    this.connectFn = o.connect ?? ((host, port) => net.connect(host, port));
    this.closed = false;
    this.sock = null;
    this.latest = null; // latest offered snapshot, serialized
    this.sent = null; // last serialized snapshot written on this connection
    this.seq = 0;
    this.lastSentAt = 0;
    this.wake = null; // resolves the sender's wait
    this.writes = Promise.resolve();
    this.stats = { connects: 0, states: 0 };
  }

  start(cx) {
    cx.spawn(async (cx) => this.loop(cx));
  }

  /** Latest host snapshot (from render or a timer). Cheap: it only stores and wakes the sender. */
  offer(host) {
    if (this.copy !== 'link') return;
    let json;
    try {
      json = JSON.stringify(host);
    } catch {
      return;
    }
    if (json === this.latest) return;
    this.latest = json;
    this.poke();
  }

  poke() {
    const w = this.wake;
    this.wake = null;
    if (w) w();
  }

  /** Stops for good: closes the socket now and ends every loop. */
  close() {
    this.closed = true;
    const s = this.sock;
    this.sock = null;
    if (s) {
      try { s.close(); } catch { /* already closed */ }
    }
    this.poke();
  }

  async loop(cx) {
    let delay = BACKOFF_MS.min;
    while (!this.closed) {
      const started = Date.now();
      let healthy = false;
      try {
        const rt = await this.runtimeFn();
        if (!rt || this.closed) throw new Error('no runtime');
        const sock = await this.connectFn('127.0.0.1', rt.port);
        if (this.closed) {
          try { sock.close(); } catch { /* ignore */ }
          return;
        }
        this.stats.connects += 1;
        this.sock = sock;
        this.sent = null;
        this.seq = 0;
        this.lastSentAt = 0;
        this.writes = Promise.resolve();
        const info = this.helloInfo();
        await this.write(sock, { type: 'hello', v: 1, token: rt.token, copy: this.copy, layout: info.layout, app: info.app });
        if (this.copy === 'link') cx.spawn(async (cx) => this.sender(cx, sock));
        healthy = await this.reader(sock);
      } catch {
        // connect refused, no runtime, write or read failed: retry below
      }
      this.drop();
      if (this.closed) return;
      if (healthy || Date.now() - started >= HEALTHY_MS) delay = BACKOFF_MS.min;
      await cx.sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_MS.max);
    }
  }

  drop() {
    const s = this.sock;
    this.sock = null;
    if (s) {
      try { s.close(); } catch { /* ignore */ }
    }
    this.poke();
  }

  /** Writes one line; failures close the connection (the reader then ends). */
  write(sock, msg) {
    const line = `${JSON.stringify(msg)}\n`;
    const p = this.writes.then(() => sock.write(line));
    this.writes = p.catch(() => {
      if (this.sock === sock) this.drop();
    });
    return p;
  }

  async sender(cx, sock) {
    while (this.sock === sock && !this.closed) {
      if (this.latest === null || this.latest === this.sent) {
        await new Promise((r) => { this.wake = r; });
        continue;
      }
      const wait = this.lastSentAt + STATE_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) {
        await cx.sleep(wait);
        continue;
      }
      const json = this.latest;
      this.seq += 1;
      this.sent = json;
      this.lastSentAt = Date.now();
      this.stats.states += 1;
      const line = `{"type":"state","seq":${this.seq},"host":${json}}\n`;
      try {
        const p = this.writes.then(() => sock.write(line));
        this.writes = p.catch(() => {});
        await p;
      } catch {
        if (this.sock === sock) this.drop();
        return;
      }
    }
  }

  /** Reads lines until EOF or error. Resolves true if any message arrived. */
  async reader(sock) {
    let buf = new Uint8Array(0);
    let got = false;
    for (;;) {
      const bytes = await sock.read();
      if (bytes === null || this.sock !== sock) return got;
      buf = concat(buf, bytes);
      let start = 0;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] !== 0x0a) continue;
        if (i - start > MAX_LINE) return got;
        const line = decodeAscii(buf.subarray(start, i));
        start = i + 1;
        if (line.trim() === '') continue;
        got = true;
        this.handle(sock, line);
        if (this.sock !== sock) return got;
      }
      buf = buf.subarray(start);
      if (buf.length > MAX_LINE) return got;
    }
  }

  handle(sock, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      this.write(sock, { type: 'pong' }).catch(() => {});
    } else if (msg.type === 'run') {
      if (typeof msg.id !== 'string' || msg.id.length < 1 || msg.id.length > 128) return;
      this.write(sock, { type: 'result', id: msg.id, ...this.execute(msg.name, msg.args) }).catch(() => {});
    } else if (msg.type === 'notify') {
      const level = LEVELS[msg.level];
      if (!level || typeof msg.message !== 'string') return;
      try {
        this.notifyFn({ title: 'Remote', body: msg.message.slice(0, MAX_TOAST), level });
      } catch { /* a toast is best-effort */ }
    }
  }

  execute(name, args) {
    const check = checkRun(name, args);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      this.runFn(name, args);
      return { ok: true };
    } catch (e) {
      // Prefixed so a thrown message can never read as a refusal (not_allowed/bad_args).
      return { ok: false, error: `run_failed: ${String(e?.message ?? e)}`.slice(0, 200) };
    }
  }
}
