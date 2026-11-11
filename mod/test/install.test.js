import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install as proto } from '@herdr-remote/protocol';
import Remote, { PANEL_CHILD, PANEL_COLUMN, PANEL_STACK, openPanel } from '../herdr-app-remote/main.js';
import {
  BUNDLE_PATH, DATA_DIR, LAUNCH_INTERVAL_MS, Launcher, RECEIPT_PATH, loadReceipt, parseReceipt, pidAlive, trustRuntime, verifiedBundle,
} from '../herdr-app-remote/install.js';
import { Mounted, settle } from './shim/runtime.js';
import { resetWorld, sendCommand, world } from './shim/herdr.js';
import { BUNDLE_SHA, FakeBridge, RECEIPT_PATH as FAKE_RECEIPT, fakeReceipt } from './fake-bridge.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const BYTES = new TextEncoder().encode('// fake bundle for Project Alpha\n');
const BYTES_SHA = sha(BYTES);
const HOME = '/app-home';

const waitFor = async (cond, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await settle(10);
  }
};

let mounted = [];
let bridges = [];
beforeEach(() => resetWorld());
afterEach(async () => {
  for (const m of mounted.splice(0)) if (!m.stopped) await m.close();
  for (const b of bridges.splice(0)) await b.close();
});

describe('install record (mod side)', () => {
  it('names the same paths and limits as the protocol package', () => {
    expect(DATA_DIR).toBe(proto.DATA_DIR);
    expect(RECEIPT_PATH).toBe(proto.RECEIPT_PATH);
    expect(BUNDLE_PATH).toBe(proto.BUNDLE_PATH);
    expect(PANEL_COLUMN).toBe(proto.PANEL_COLUMN_ID);
    expect(PANEL_STACK).toBe(proto.PANEL_PARENT_ID);
    expect(PANEL_CHILD).toBe(proto.PANEL_BLOCK_ID);
  });

  it('accepts exactly the records the protocol schema accepts', () => {
    const good = JSON.parse(fakeReceipt());
    expect(proto.InstallReceipt.safeParse(good).success).toBe(true);
    expect(parseReceipt(JSON.stringify(good))).toEqual({ node: '/usr/bin/node-fake', bundleSha256: BUNDLE_SHA });
    const bad = [
      { ...good, v: 2 },
      { ...good, extra: 1 },
      { ...good, node: 'node' },
      { ...good, install_id: 'xyz' },
      { ...good, files: {} },
      { ...good, files: { [BUNDLE_PATH]: { sha256: 'AB'.repeat(32), mode: 0o644 } } },
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'keys')),
    ];
    for (const r of bad) {
      expect(proto.InstallReceipt.safeParse(r).success).toBe(false);
      expect(parseReceipt(JSON.stringify(r))).toBeNull();
    }
    expect(parseReceipt('not json')).toBeNull();
    expect(parseReceipt(null)).toBeNull();
    expect(parseReceipt('x'.repeat(1024 * 1024 + 1))).toBeNull();
  });

  it('loads the record from the app home', async () => {
    world.files[`${HOME}/${RECEIPT_PATH}`] = fakeReceipt();
    expect(await loadReceipt()).toEqual({ node: '/usr/bin/node-fake', bundleSha256: BUNDLE_SHA });
    delete world.files[`${HOME}/${RECEIPT_PATH}`];
    expect(await loadReceipt()).toBeNull();
  });
});

describe('bundle verification', () => {
  const receipt = { node: '/usr/bin/node-fake', bundleSha256: BYTES_SHA };

  it('returns the bundle and node only when the bytes hash to the record', async () => {
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    expect(await verifiedBundle(receipt)).toEqual({ node: '/usr/bin/node-fake', bundle: `${HOME}/${BUNDLE_PATH}` });
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = new TextEncoder().encode('// swapped\n');
    expect(await verifiedBundle(receipt)).toBeNull();
    delete world.bytes[`${HOME}/${BUNDLE_PATH}`];
    expect(await verifiedBundle(receipt)).toBeNull();
    expect(await verifiedBundle(null)).toBeNull();
  });
});

describe('runtime trust', () => {
  const receipt = async () => ({ node: '/n', bundleSha256: BUNDLE_SHA });

  it('needs the recorded bundle hash and a live pid', async () => {
    const alive = async () => true;
    expect(await trustRuntime({ pid: 7, bundle_sha256: BUNDLE_SHA }, { receipt, alive })).toBe(true);
    expect(await trustRuntime({ pid: 7, bundle_sha256: 'cd'.repeat(32) }, { receipt, alive })).toBe(false);
    expect(await trustRuntime({ pid: 7, bundle_sha256: null }, { receipt, alive })).toBe(false);
    expect(await trustRuntime({ pid: 7, bundle_sha256: BUNDLE_SHA }, { receipt: async () => null, alive })).toBe(false);
    expect(await trustRuntime({ pid: 7, bundle_sha256: BUNDLE_SHA }, { receipt, alive: async () => false })).toBe(false);
  });

  it('asks kill -0 for the pid, as an argument and never as shell text', async () => {
    world.exec = (cmd, args) => ({ code: args[3] === '4242' ? 0 : 1 });
    expect(await pidAlive(4242)).toBe(true);
    expect(await pidAlive(4243)).toBe(false);
    expect(world.execs[0]).toEqual(['sh', ['-c', 'kill -0 "$1" 2>/dev/null', 'sh', '4242'], { timeout: 3000 }]);
    const before = world.execs.length;
    expect(await pidAlive('4242; rm -rf /')).toBe(false);
    expect(await pidAlive(0)).toBe(false);
    expect(world.execs.length).toBe(before);
    world.exec = () => { throw new Error('cannot start'); };
    expect(await pidAlive(4242)).toBe(false);
  });
});

describe('launcher', () => {
  function launcher(over = {}) {
    let t = 1000;
    const l = new Launcher({
      receipt: async () => ({ node: '/usr/bin/node-fake', bundleSha256: BYTES_SHA }),
      now: () => t,
      ...over,
    });
    l.advance = (ms) => { t += ms; };
    return l;
  }

  it('runs node on the verified bundle with argv only, at most once per interval', async () => {
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    const l = launcher();
    expect(await l.maybe()).toBe(true);
    expect(world.execs).toEqual([['/usr/bin/node-fake', [`${HOME}/${BUNDLE_PATH}`, 'launch', '--app-home', HOME], { timeout: 10000 }]]);
    expect(await l.maybe()).toBe(false);
    l.advance(LAUNCH_INTERVAL_MS - 1);
    expect(await l.maybe()).toBe(false);
    l.advance(1);
    expect(await l.maybe()).toBe(true);
    expect(world.execs.length).toBe(2);
  });

  it('never runs a bundle that does not match the record', async () => {
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = new TextEncoder().encode('// not the recorded bundle\n');
    const l = launcher();
    expect(await l.maybe()).toBe(false);
    expect(world.execs).toEqual([]);
    expect(l.lastError).toMatch(/does not match/);
  });

  it('never runs anything without a record', async () => {
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    const l = launcher({ receipt: async () => null });
    expect(await l.maybe()).toBe(false);
    expect(world.execs).toEqual([]);
  });

  it('runs one launch at a time', async () => {
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    let release;
    world.exec = () => new Promise((r) => { release = () => r({ code: 0 }); });
    const l = launcher({ intervalMs: 0 });
    const a = l.maybe();
    await settle(5);
    expect(await l.maybe()).toBe(false);
    release();
    expect(await a).toBe(true);
  });

  it('survives a launch that throws', async () => {
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    world.exec = () => { throw new Error('timed out'); };
    const l = launcher();
    expect(await l.maybe()).toBe(false);
    expect(l.lastError).toBe('timed out');
  });
});

describe('mounted copies', () => {
  function mount(role) {
    const m = new Mounted(Remote, { props: { role }, scale: 0.01 });
    mounted.push(m);
    return m;
  }
  const launches = () => world.execs.filter(([cmd]) => cmd === '/usr/bin/node-fake');

  it('the link copy launches the verified bundle when there is no runtime', async () => {
    world.files[FAKE_RECEIPT] = fakeReceipt(BYTES_SHA);
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    mount('link');
    await waitFor(() => launches().length === 1);
    expect(launches()[0][1]).toEqual([`${HOME}/${BUNDLE_PATH}`, 'launch', '--app-home', HOME]);
  });

  it('the panel copy never launches', async () => {
    world.files[FAKE_RECEIPT] = fakeReceipt(BYTES_SHA);
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    const m = mount('panel');
    await waitFor(() => m.sleeps.length >= 3);
    expect(launches()).toEqual([]);
  });

  it('does not connect to a runtime from another bundle, and launches instead', async () => {
    world.files[FAKE_RECEIPT] = fakeReceipt(BYTES_SHA);
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    const b = new FakeBridge();
    bridges.push(b);
    await b.listen(); // advertises BUNDLE_SHA, which is not the recorded BYTES_SHA
    const m = mount('link');
    await waitFor(() => launches().length === 1 && m.sleeps.length >= 2);
    expect(b.conns).toEqual([]);
  });

  it('does not connect when the runtime pid is dead', async () => {
    world.files[FAKE_RECEIPT] = fakeReceipt();
    world.exec = (cmd) => ({ code: cmd === 'sh' ? 1 : 0 });
    const b = new FakeBridge();
    bridges.push(b);
    await b.listen();
    const m = mount('link');
    await waitFor(() => m.sleeps.length >= 2);
    expect(b.conns).toEqual([]);
  });

  it('connects when the runtime is trusted', async () => {
    const b = new FakeBridge();
    bridges.push(b);
    await b.listen();
    mount('link');
    const c = await b.conn();
    expect((await FakeBridge.next(c, (x) => x.type === 'hello')).copy).toBe('link');
    expect(launches()).toEqual([]);
  });

  it('a link that was reached and then dropped launches nothing', async () => {
    world.files[FAKE_RECEIPT] = fakeReceipt(BYTES_SHA);
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES; // a launch would verify, so only the gate stops it
    const b = new FakeBridge();
    bridges.push(b);
    await b.listen();
    b.advertise(undefined, { sha: BYTES_SHA });
    mount('link');
    (await b.conn(0)).socket.destroy();
    (await b.conn(1)).socket.destroy();
    await b.conn(2);
    expect(launches()).toEqual([]);
  });

  it('the open command shows the panel column and selects the Remote child', async () => {
    mount('link');
    sendCommand('open');
    await waitFor(() => world.ran.length >= 2);
    expect(world.ran).toEqual([
      ['run', { name: 'layout.show', args: { id: 'panel' } }],
      ['run', { name: 'layout.select', args: { stack: 'panel-body', child: 'remote' } }],
    ]);
  });

  it('an inert copy takes no commands and never connects or launches', async () => {
    world.files[FAKE_RECEIPT] = fakeReceipt(BYTES_SHA);
    world.bytes[`${HOME}/${BUNDLE_PATH}`] = BYTES;
    const m = mount(undefined);
    sendCommand('open');
    await settle(50);
    expect(world.ran).toEqual([]);
    expect(world.execs).toEqual([]);
    expect(m.sleeps).toEqual([]);
    expect(world.commands).toEqual(['open']);
  });

  it('openPanel swallows a run that throws', () => {
    expect(() => openPanel(() => { throw new Error('no such node'); })).not.toThrow();
  });
});
