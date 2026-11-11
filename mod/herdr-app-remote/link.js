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
/** A panel act that gets no `panel_res` in this long is reported as timed out. */
export const ACT_TIMEOUT_MS = 10000;
/**
 * Start and Stop serving may wait on `tailscale serve` (cut off by the bridge after 20 s) between two rounds
 * of reads, so `setup.*` acts get longer; the panel shows the bridge's busy state meanwhile.
 */
export const SETUP_ACT_TIMEOUT_MS = 90000;
/** The key command that shows the Remote panel (main.js handles `open`). */
const OPEN_ACTION = 'herdr-app-remote.open';

const LEVELS = Object.freeze(Object.assign(Object.create(null), { info: 'info', warn: 'warning', error: 'error' }));

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
  const pid = Number.isInteger(rt.pid) && rt.pid > 0 ? rt.pid : null;
  const sha = typeof rt.bundle_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rt.bundle_sha256) ? rt.bundle_sha256 : null;
  return { port: rt.port, token: rt.token, pid, bundle_sha256: sha };
}

function decodeAscii(bytes) {
  // The bridge sends ASCII-only lines (encodeLine), so a byte is a char.
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

export class Link {
  /**
   * @param {object} o
   * @param {'link'|'panel'} o.copy
   * @param {() => {layout: string, app: {version: string}}} o.hello
   * @param {(name: string, args: object) => unknown} [o.run]   herdr's run
   * @param {(n: object) => unknown} [o.notify]                herdr's notify
   * @param {() => Promise<{port: number, token: string, pid: number|null, bundle_sha256: string|null} | null>} [o.runtime]
   * @param {(rt: object) => Promise<boolean>} [o.trust]   whether to connect to this runtime (default: yes)
   * @param {() => unknown} [o.unreachable]   called, not awaited, when an attempt found no usable bridge
   * @param {(host: string, port: number) => Promise<any>} [o.connect]
   * @param {number} [o.healthyMs]
   * @param {(view: object, cx: object) => void} [o.onPanel]   the panel copy got a `panel` view (raw: the caller checks it)
   * @param {(up: boolean, cx: object) => void} [o.onStatus]   the connection came up or went down
   */
  constructor(o) {
    this.copy = o.copy;
    this.helloInfo = o.hello;
    this.runFn = o.run ?? herdrRun;
    this.notifyFn = o.notify ?? herdrNotify;
    this.runtimeFn = o.runtime ?? (() => readRuntime());
    this.connectFn = o.connect ?? ((host, port) => net.connect(host, port));
    this.healthyMs = o.healthyMs ?? HEALTHY_MS;
    this.trustFn = o.trust ?? (async () => true);
    this.unreachableFn = o.unreachable ?? (() => {});
    this.panelFn = o.onPanel ?? (() => {});
    this.statusFn = o.onStatus ?? (() => {});
    this.acts = new Map(); // panel act id -> resolve
    this.actCounter = 0;
    this.unblock = null; // ends the reader's pending read() when the connection is dropped
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
    this.drop();
  }

  async loop(cx) {
    let delay = BACKOFF_MS.min;
    while (!this.closed) {
      const started = Date.now();
      let healthy = false;
      let reached = false;
      try {
        const rt = await this.runtimeFn();
        if (!rt || this.closed) throw new Error('no runtime');
        if (!(await this.trustFn(rt)) || this.closed) throw new Error('runtime not trusted');
        const sock = await this.connectFn('127.0.0.1', rt.port);
        reached = true;
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
        // A dropped connection must end the reader even if close() leaves a read() pending.
        const dropped = new Promise((r) => { this.unblock = () => r(null); });
        const info = this.helloInfo();
        await this.write(sock, { type: 'hello', v: 1, token: rt.token, copy: this.copy, layout: info.layout, app: info.app });
        if (this.copy === 'link') cx.spawn(async (cx) => this.sender(cx, sock));
        this.statusFn(true, cx);
        healthy = await this.reader(cx, sock, dropped);
      } catch {
        // connect refused, no runtime, write or read failed: retry below
      }
      this.drop();
      if (reached && !this.closed) this.statusFn(false, cx);
      if (this.closed) return;
      if (!reached) {
        try {
          Promise.resolve(this.unreachableFn()).catch(() => {});
        } catch { /* a launcher failure must not end the loop */ }
      }
      if (healthy || Date.now() - started >= this.healthyMs) delay = BACKOFF_MS.min;
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
    const u = this.unblock;
    this.unblock = null;
    if (u) u();
    for (const [id, resolve] of this.acts) {
      this.acts.delete(id);
      resolve({ ok: false, code: 'link_lost' });
    }
    this.poke();
  }

  /**
   * The panel copy asks the bridge for a desktop-only operation (approve, revoke, a capability, pause,
   * a pairing code, Tailscale setup: `PANEL_ACT_ARGS` in mod-link.ts). The bridge validates it against its own strict
   * allowlist; this only carries it. Resolves `{ok, code?}`; never rejects.
   */
  act(cx, kind, args) {
    const sock = this.sock;
    if (this.copy !== 'panel' || !sock || this.closed) return Promise.resolve({ ok: false, code: 'no_link' });
    this.actCounter += 1;
    const id = `p-${this.actCounter}`;
    return new Promise((resolve) => {
      this.acts.set(id, resolve);
      cx.spawn(async (cx) => {
        await cx.sleep(kind.startsWith('setup.') ? SETUP_ACT_TIMEOUT_MS : ACT_TIMEOUT_MS);
        if (this.acts.delete(id)) resolve({ ok: false, code: 'timeout' });
      });
      this.write(sock, { type: 'panel_act', id, kind, args }).catch(() => {
        if (this.acts.delete(id)) resolve({ ok: false, code: 'no_link' });
      });
    });
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

  /** Reads lines until EOF, error or drop. Resolves true if any message arrived. */
  async reader(cx, sock, dropped) {
    let parts = []; // unterminated bytes, waiting for their newline
    let size = 0;
    let got = false;
    for (;;) {
      const bytes = await Promise.race([sock.read(), dropped]);
      if (bytes === null || this.sock !== sock) return got;
      let start = 0;
      for (let i = bytes.indexOf(0x0a); ; i = bytes.indexOf(0x0a, start)) {
        const end = i < 0 ? bytes.length : i;
        if (size + end - start > MAX_LINE) return got;
        if (i < 0) {
          if (end > start) { parts.push(bytes.subarray(start)); size += end - start; }
          break;
        }
        let line = decodeAscii(bytes.subarray(start, i));
        if (parts.length) line = parts.map(decodeAscii).join('') + line;
        parts = [];
        size = 0;
        start = i + 1;
        if (line.trim() === '') continue;
        got = true;
        this.handle(cx, sock, line);
        if (this.sock !== sock) return got;
      }
    }
  }

  handle(cx, sock, line) {
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
      const level = typeof msg.level === 'string' ? LEVELS[msg.level] : undefined;
      if (!level || typeof msg.message !== 'string') return;
      const n = { title: 'Remote', body: msg.message.slice(0, MAX_TOAST), level };
      if (msg.action === 'open_panel') n.action = { name: OPEN_ACTION };
      try {
        this.notifyFn(n);
      } catch { /* a toast is best-effort */ }
    } else if (this.copy === 'panel' && msg.type === 'panel') {
      this.panelFn(msg.view, cx);
    } else if (this.copy === 'panel' && msg.type === 'panel_res') {
      const resolve = typeof msg.id === 'string' ? this.acts.get(msg.id) : undefined;
      if (!resolve) return;
      this.acts.delete(msg.id);
      resolve(msg.ok === true ? { ok: true } : { ok: false, code: typeof msg.code === 'string' ? msg.code.slice(0, 40) : 'failed' });
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
