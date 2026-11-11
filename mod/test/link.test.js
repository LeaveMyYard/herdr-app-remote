import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostState, modLink } from '@herdr-remote/protocol';
import { LinkServer } from '@herdr-remote/bridge';
import Remote, { snapshot } from '../herdr-app-remote/main.js';
import { BACKOFF_MS, Link } from '../herdr-app-remote/link.js';
import { Mounted, settle } from './shim/runtime.js';
import { resetWorld, world } from './shim/herdr.js';
import { FakeBridge, RUNTIME_PATH, TOKEN } from './fake-bridge.js';
import { fakeWorld } from './fixtures.js';

let bridge;
let mounted = [];
const next = FakeBridge.next;
const send = FakeBridge.send;

function load() {
  resetWorld();
  const w = fakeWorld();
  Object.assign(world, { spaces: w.spaces, agents: w.agents, terminals: w.terminals, panes: w.panes, focused: w.focused, settings: w.settings, shared: w.shared });
  world.shared['panorama.feed.owner'] = { v: 1, token: 'lease-token-1', role: 'sidebar', seen_at: Date.now() };
}

function mount(opts = {}) {
  const m = new Mounted(Remote, { props: { role: 'link' }, ...opts });
  mounted.push(m);
  return m;
}

const waitFor = async (cond, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await settle(10);
  }
};

beforeEach(async () => {
  load();
  bridge = new FakeBridge();
  await bridge.listen();
});

afterEach(async () => {
  for (const m of mounted.splice(0)) if (!m.stopped) await m.close();
  await bridge.close();
});

describe('link mod: hello and state', () => {
  it('says hello with the runtime token, then sends a full valid state', async () => {
    mount();
    const c = await bridge.conn();
    const hello = await next(c, (m) => m.type === 'hello');
    expect(hello).toEqual({ type: 'hello', v: 1, token: TOKEN, copy: 'link', layout: 'herdr-remote', app: { version: '0.0.1' } });
    expect(modLink.Hello.safeParse(hello).success).toBe(true);
    const state = await next(c, (m) => m.type === 'state');
    expect(state.seq).toBe(1);
    expect(modLink.State.safeParse(state).success).toBe(true);
    expect(state.host).toEqual(snapshot());
    expect(HostState.parse(state.host).shared['panorama.feed.owner']).toBe('sidebar');
    expect(c.lines.findIndex((l) => l.msg.type === 'hello')).toBe(-1); // hello came first and once
  });

  it('dedupes: renders with unchanged content send nothing; a change sends the next seq', async () => {
    const m = mount();
    const c = await bridge.conn();
    await next(c, (x) => x.type === 'state');
    for (let i = 0; i < 20; i += 1) m.render();
    await settle(250);
    expect(c.lines.filter((l) => l.msg.type === 'state')).toEqual([]);
    world.agents[0].status = 'done';
    m.render();
    const s2 = await next(c, (x) => x.type === 'state');
    expect(s2.seq).toBe(2);
    expect(s2.host.agents[0].state).toBe('done');
  });

  it('coalesces a burst to at most one state per 100 ms, ending on the latest content', async () => {
    const m = mount();
    const c = await bridge.conn();
    await next(c, (x) => x.type === 'state');
    const t0 = Date.now();
    for (let i = 0; i < 60; i += 1) {
      world.spaces[0].name = `Project Alpha ${i}`;
      m.render();
      if (i % 10 === 0) await settle(5);
    }
    const burstMs = Date.now() - t0;
    await settle(350);
    const states = c.lines.filter((l) => l.msg.type === 'state');
    expect(states.length).toBeGreaterThan(0);
    expect(states.length).toBeLessThanOrEqual(Math.ceil(burstMs / 100) + 2);
    for (let i = 1; i < states.length; i += 1) expect(states[i].at - states[i - 1].at).toBeGreaterThanOrEqual(90);
    expect(states.at(-1).msg.host.spaces[0].name).toBe('Project Alpha 59');
    expect(states.map((l) => l.msg.seq)).toEqual(states.map((_, i) => i + 2));
  });

  it('rechecks on a timer without a render, so an expired panorama lease shows', async () => {
    world.shared['panorama.feed.owner'].seen_at = Date.now() - 14_850;
    mount({ scale: 0.01 }); // recheck every 50 ms
    const c = await bridge.conn();
    const first = await next(c, (x) => x.type === 'state');
    expect(first.host.shared['panorama.feed.owner']).toBe('sidebar');
    const later = await next(c, (x) => x.type === 'state', 2000);
    expect(later.host.shared['panorama.feed.owner']).toBeNull();
  });

  it('the panel copy links as "panel" and never sends state', async () => {
    mount({ props: { role: 'panel' } });
    const c = await bridge.conn();
    expect(await next(c, (x) => x.type === 'hello')).toMatchObject({ copy: 'panel' });
    await settle(250);
    expect(c.lines.filter((l) => l.msg.type === 'state')).toEqual([]);
  });
});

describe('link mod: close and reconnect', () => {
  it('close() closes the socket and the mod never reconnects', async () => {
    const m = mount({ scale: 0.01 });
    const c = await bridge.conn();
    await next(c, (x) => x.type === 'state');
    const t0 = Date.now();
    await m.close();
    await c.done;
    expect(Date.now() - t0).toBeLessThan(250);
    await settle(300);
    expect(bridge.conns).toHaveLength(1);
  });

  it('close() during backoff stops the loop', async () => {
    delete world.files[RUNTIME_PATH];
    const m = mount({ scale: 0.01 });
    await waitFor(() => m.sleeps.length >= 2);
    await m.close();
    bridge.advertise();
    await settle(300);
    expect(bridge.conns).toHaveLength(0);
  });

  it('reconnects after the bridge drops it, with a fresh hello and a full state from seq 1', async () => {
    mount({ scale: 0.01 });
    const c0 = await bridge.conn(0);
    await next(c0, (x) => x.type === 'state');
    c0.socket.destroy();
    const c1 = await bridge.conn(1);
    expect(await next(c1, (x) => x.type === 'hello')).toMatchObject({ token: TOKEN });
    const s = await next(c1, (x) => x.type === 'state');
    expect(s.seq).toBe(1);
    expect(s.host).toEqual(snapshot());
  });

  it('backs off 0.5 s doubling to 10 s while there is no runtime.json', async () => {
    delete world.files[RUNTIME_PATH];
    const m = mount({ scale: 0.001 });
    await waitFor(() => m.sleeps.length >= 9);
    expect(m.sleeps.slice(0, 9)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000]);
    expect(bridge.conns).toHaveLength(0);
  });

  it('backs off while the port refuses connections, and connects once the bridge is up', async () => {
    const port = bridge.port;
    await bridge.close();
    const m = mount({ scale: 0.001 });
    await waitFor(() => m.sleeps.length >= 6);
    expect(m.sleeps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
    bridge = new FakeBridge();
    await bridge.listen(port);
    const c = await bridge.conn(0, 5000);
    expect(await next(c, (x) => x.type === 'hello')).toMatchObject({ copy: 'link' });
  });

  it('resets the backoff after a connection that got a message', async () => {
    delete world.files[RUNTIME_PATH];
    const m = mount({ scale: 0.001 });
    await waitFor(() => m.sleeps.length >= 4); // 500, 1000, 2000, 4000: the delay has grown
    bridge.advertise();
    const c0 = await bridge.conn(0, 15000);
    await next(c0, (x) => x.type === 'state');
    const before = m.sleeps.filter((ms) => ms >= BACKOFF_MS.min).length;
    // slam every later connection shut at once: that is not healthy, so the delay grows again
    bridge.server.on('connection', (s) => s.destroy());
    send(c0, { type: 'ping' });
    await next(c0, (x) => x.type === 'pong');
    c0.socket.destroy();
    await waitFor(() => m.sleeps.filter((ms) => ms >= BACKOFF_MS.min).length >= before + 3);
    expect(m.sleeps.filter((ms) => ms >= BACKOFF_MS.min).slice(before, before + 3)).toEqual([500, 1000, 2000]);
  });

  it('ignores a malformed runtime.json', async () => {
    world.files[RUNTIME_PATH] = JSON.stringify({ v: 1, port: bridge.port, token: 'short', pid: 1, bundle_sha256: null });
    const m = mount({ scale: 0.001 });
    await waitFor(() => m.sleeps.length >= 3);
    expect(bridge.conns).toHaveLength(0);
    world.files[RUNTIME_PATH] = '{not json';
    await waitFor(() => m.sleeps.length >= 5);
    expect(bridge.conns).toHaveLength(0);
  });

  it('drops a connection whose line runs past the limit, then reconnects', async () => {
    mount({ scale: 0.01 });
    const c0 = await bridge.conn(0);
    await next(c0, (x) => x.type === 'state');
    c0.socket.write('x'.repeat(1024 * 1024 + 100));
    await c0.done;
    const c1 = await bridge.conn(1);
    expect(await next(c1, (x) => x.type === 'hello')).toMatchObject({ copy: 'link' });
  });
});

describe('link mod: commands in', () => {
  async function linked() {
    mount();
    const c = await bridge.conn();
    await next(c, (x) => x.type === 'state');
    return c;
  }
  const runs = () => world.ran.filter(([k]) => k === 'run');

  it('runs an allowlisted command and answers ok', async () => {
    const c = await linked();
    send(c, { type: 'run', id: 'run-1', name: 'space.select', args: { id: 'space-2' } });
    expect(await next(c, (x) => x.type === 'result')).toEqual({ type: 'result', id: 'run-1', ok: true });
    expect(runs()).toEqual([['run', { name: 'space.select', args: { id: 'space-2' } }]]);
  });

  it('refuses a command that is not on its own allowlist, even if the bridge sends it', async () => {
    const c = await linked();
    send(c, { type: 'run', id: 'run-1', name: 'tab.new', args: { argv: ['sh', '-c', 'echo'] } });
    send(c, { type: 'run', id: 'run-2', name: 'terminal.open', args: {} });
    expect(await next(c, (x) => x.id === 'run-1')).toEqual({ type: 'result', id: 'run-1', ok: false, error: 'not_allowed' });
    expect(await next(c, (x) => x.id === 'run-2')).toEqual({ type: 'result', id: 'run-2', ok: false, error: 'not_allowed' });
    expect(runs()).toEqual([]);
  });

  it('refuses bad arguments for an allowlisted command', async () => {
    const c = await linked();
    send(c, { type: 'run', id: 'run-1', name: 'tab.select', args: { index: 1, argv: ['sh'] } });
    expect(await next(c, (x) => x.type === 'result')).toEqual({ type: 'result', id: 'run-1', ok: false, error: 'bad_args' });
    expect(runs()).toEqual([]);
  });

  it('reports a failing run without it reading as a refusal', async () => {
    const c = await linked();
    world.runThrows = 'not_allowed';
    send(c, { type: 'run', id: 'run-1', name: 'tab.select', args: { index: 1 } });
    const r = await next(c, (x) => x.type === 'result');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('run_failed: not_allowed');
  });

  it('ignores a run without a usable id', async () => {
    const c = await linked();
    send(c, { type: 'run', name: 'tab.select', args: { index: 1 } });
    send(c, { type: 'run', id: 'x'.repeat(200), name: 'tab.select', args: { index: 1 } });
    await settle(150);
    expect(c.lines.filter((l) => l.msg.type === 'result')).toEqual([]);
    expect(runs()).toEqual([]);
  });

  it('answers ping with pong and shows notify as a toast', async () => {
    const c = await linked();
    send(c, { type: 'ping' });
    expect(await next(c, (x) => x.type === 'pong')).toEqual({ type: 'pong' });
    send(c, { type: 'notify', level: 'warn', message: 'Question Title 123' });
    send(c, { type: 'notify', level: 'shout', message: 'ignored' });
    send(c, { type: 'notify', level: 'constructor', message: 'ignored' });
    send(c, { type: 'notify', level: '__proto__', message: 'ignored' });
    await waitFor(() => world.ran.some(([k]) => k === 'notify'));
    await settle(50);
    expect(world.ran.filter(([k]) => k === 'notify')).toEqual([['notify', { title: 'Remote', body: 'Question Title 123', level: 'warning' }]]);
  });

  it('survives garbage lines', async () => {
    const c = await linked();
    c.socket.write('{nope\n\n[1]\nnull\n');
    send(c, { type: 'ping' });
    expect(await next(c, (x) => x.type === 'pong')).toEqual({ type: 'pong' });
    expect(bridge.conns).toHaveLength(1);
  });
});

describe('link mod against the real bridge link server', () => {
  it('links, mirrors host, runs allowlisted commands, and unlinks on close', async () => {
    const token = 'real-token-0123456789abcdef0123456789';
    const server = new LinkServer({ token });
    const port = await server.listen();
    world.files[RUNTIME_PATH] = JSON.stringify({ v: 1, port, token, pid: 4242, bundle_sha256: null });
    try {
      const host = new Promise((r) => server.once('host', r));
      const m = mount();
      const snap = await host;
      expect(snap.state).toEqual(snapshot());
      expect(snap.layout).toBe('herdr-remote');
      expect(await server.run('space.select', { id: 'space-2' })).toEqual({ ok: true });
      expect(world.ran.filter(([k]) => k === 'run')).toEqual([['run', { name: 'space.select', args: { id: 'space-2' } }]]);
      expect(await server.run('tab.new', { argv: ['sh'] })).toEqual({ ok: false, code: 'not_allowed', unknown_effect: false });
      const down = new Promise((r) => server.once('unlink', r));
      await m.close();
      expect(await down).toEqual({ copy: 'link' });
    } finally {
      await server.close();
    }
  });

  it('a wrong token never links', async () => {
    const server = new LinkServer({ token: 'real-token-0123456789abcdef0123456789' });
    const port = await server.listen();
    world.files[RUNTIME_PATH] = JSON.stringify({ v: 1, port, token: 'other-token-0123456789abcdef0123456789', pid: 4242, bundle_sha256: null });
    try {
      const m = mount({ scale: 0.001 });
      await waitFor(() => m.sleeps.length >= 3);
      expect(server.connected()).toBe(false);
      expect(server.lastHost).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe('stray copies', () => {
  it.each([[{}], [{ role: 'other' }], [{ file: 'x' }]])('a copy with props %j stays inert and never connects', async (props) => {
    const m = mount({ props, scale: 0.01 });
    await settle(300);
    expect(bridge.conns).toHaveLength(0);
    expect(m.tree.id).toBe('remote-inert');
  });
});

/** A scripted socket: writes wait for `release()`, reads for `push()`; close() never ends a read. */
function fakeSocket() {
  const s = {
    written: [], pendingWrites: [], reads: [], closed: false, failWrites: false,
    write(line) {
      if (s.failWrites) return Promise.reject(new Error('broken pipe'));
      s.written.push(line);
      return new Promise((r) => s.pendingWrites.push(r));
    },
    read() { return new Promise((r) => s.reads.push(r)); }, // like a runtime whose close() leaves it pending
    close() { s.closed = true; },
    release() { for (const r of s.pendingWrites.splice(0)) r(); },
    push(text) { s.reads.shift()?.(new TextEncoder().encode(text)); },
  };
  return s;
}

describe('Link unit', () => {
  // A cx whose sleeps are never cancelled: only Link.close() can stop the loop.
  const freeCx = () => {
    const cx = { spawn: (t) => { Promise.resolve().then(() => t(cx)).catch(() => {}); }, sleep: (ms) => new Promise((r) => setTimeout(r, ms / 100)) };
    return cx;
  };

  it('close() stops the loop by itself, even while it is backing off', async () => {
    delete world.files[RUNTIME_PATH];
    const l = new Link({ copy: 'link', hello: () => ({ layout: 'x', app: { version: '1' } }) });
    l.start(freeCx());
    await settle(30);
    l.close();
    bridge.advertise();
    await settle(300);
    expect(bridge.conns).toHaveLength(0);
  });

  it('close() while connected closes the socket and does not reconnect', async () => {
    const l = new Link({ copy: 'link', hello: () => ({ layout: 'x', app: { version: '1' } }) });
    l.start(freeCx());
    const c = await bridge.conn();
    await next(c, (x) => x.type === 'hello');
    l.close();
    await c.done;
    await settle(300);
    expect(bridge.conns).toHaveLength(1);
  });


  const rt = async () => ({ port: 1, token: TOKEN });
  const hello = () => ({ layout: 'x', app: { version: '1' } });
  const cxFast = () => {
    const sleeps = [];
    const cx = { sleeps, spawn: (t) => { Promise.resolve().then(() => t(cx)).catch(() => {}); }, sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, Math.min(ms, 5))); } };
    return cx;
  };
  const states = (s) => s.written.filter((l) => l.includes('"type":"state"'));

  it('keeps at most one state write in flight; a slow socket coalesces to the latest', async () => {
    const sock = fakeSocket();
    const l = new Link({ copy: 'link', hello, runtime: rt, connect: async () => sock });
    l.offer({ n: 0 });
    l.start(cxFast());
    await settle(20);
    sock.release(); // hello
    await settle(150);
    expect(states(sock)).toHaveLength(1);
    for (let n = 1; n <= 5; n += 1) { l.offer({ n }); await settle(120); }
    expect(states(sock)).toHaveLength(1); // the first state write is still in flight
    sock.release();
    await settle(150);
    expect(states(sock)).toHaveLength(2);
    expect(JSON.parse(states(sock)[1]).host).toEqual({ n: 5 });
    l.close();
  });

  it('a write failure drops the connection and reconnects even if close() never ends read()', async () => {
    const socks = [fakeSocket(), fakeSocket()];
    let i = 0;
    const l = new Link({ copy: 'link', hello, runtime: rt, connect: async () => socks[i++] });
    l.start(cxFast());
    await settle(20);
    socks[0].release();
    await settle(20);
    socks[0].failWrites = true;
    l.offer({ n: 1 });
    await settle(150);
    expect(socks[0].closed).toBe(true);
    expect(i).toBe(2);
    expect(socks[1].written[0]).toContain('"type":"hello"');
    l.close();
  });

  it('a connection that lasted healthyMs resets the backoff even with no message', async () => {
    let n = 0;
    const socks = [];
    const l = new Link({
      copy: 'link', hello, runtime: rt, healthyMs: 100,
      connect: async () => {
        n += 1;
        if (n <= 3 || n >= 5) throw new Error('refused');
        const s = fakeSocket();
        socks.push(s);
        return s;
      },
    });
    const cx = cxFast();
    l.start(cx);
    await waitFor(() => n === 4);
    socks[0].release();
    await settle(150); // longer than healthyMs, and nothing received
    socks[0].reads.shift()(null); // EOF
    await waitFor(() => cx.sleeps.length >= 5);
    expect(cx.sleeps.slice(0, 5)).toEqual([500, 1000, 2000, 500, 1000]);
    l.close();
  });

  it('offer() is a no-op for the panel copy', () => {
    const l = new Link({ copy: 'panel', hello: () => ({ layout: 'x', app: { version: '1' } }) });
    l.offer({ a: 1 });
    expect(l.latest).toBeNull();
  });
});

describe('render smoke (shim)', () => {
  it('renders both roles without errors', async () => {
    const link = mount();
    expect(link.tree.id).toBe('remote-link');
    expect(link.tree.children).toEqual([]);
    const panel = mount({ props: { role: 'panel' } });
    expect(panel.tree.id).toBe('remote-panel');
  });
});
