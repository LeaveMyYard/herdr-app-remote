// A fake bridge for mod tests: a raw TCP server on 127.0.0.1 that records every line and lets
// the test write lines back. It also writes a runtime.json into the shim's world.
import net from 'node:net';
import { world } from './shim/herdr.js';

export const TOKEN = 'token-0123456789abcdef0123456789abcdef';
export const RUNTIME_PATH = '/app-home/data/herdr-app-remote/runtime.json';

export class FakeBridge {
  constructor() {
    this.conns = [];
    this.server = net.createServer((s) => this.accept(s));
  }

  async listen(port = 0) {
    await new Promise((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = this.server.address().port;
    this.advertise();
    return this.port;
  }

  advertise(token = TOKEN) {
    world.files[RUNTIME_PATH] = JSON.stringify({ v: 1, port: this.port, token, pid: 4242, bundle_sha256: null });
  }

  accept(s) {
    const c = { socket: s, lines: [], raw: '', closed: false, waiters: [] };
    s.setEncoding('utf8');
    s.on('data', (d) => {
      c.raw += d;
      let i;
      while ((i = c.raw.indexOf('\n')) >= 0) {
        c.lines.push({ at: Date.now(), msg: JSON.parse(c.raw.slice(0, i)) });
        c.raw = c.raw.slice(i + 1);
      }
      for (const w of c.waiters.splice(0)) w();
    });
    s.on('error', () => {});
    c.done = new Promise((r) => s.on('close', () => { c.closed = true; r(); }));
    this.conns.push(c);
    for (const w of (this.connWaiters ?? []).splice(0)) w();
  }

  async conn(n = 0, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!this.conns[n]) {
      if (Date.now() > deadline) throw new Error(`no connection #${n}`);
      await new Promise((r) => { (this.connWaiters ??= []).push(r); setTimeout(r, 20); });
    }
    return this.conns[n];
  }

  static async next(c, pred = () => true, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = c.lines.findIndex((l) => pred(l.msg));
      if (i >= 0) return c.lines.splice(i, 1)[0].msg;
      if (Date.now() > deadline) throw new Error('timed out waiting for a line');
      await new Promise((r) => { c.waiters.push(r); setTimeout(r, 20); });
    }
  }

  static send(c, obj) {
    c.socket.write(`${JSON.stringify(obj)}\n`);
  }

  async close() {
    for (const c of this.conns) c.socket.destroy();
    await new Promise((r) => this.server.close(r));
  }
}
