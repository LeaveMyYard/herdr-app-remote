import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modLink } from '@herdr-remote/protocol';
import Remote from '../herdr-app-remote/main.js';
import { sanitize } from '../herdr-app-remote/panel.js';
import { Mounted, settle } from './shim/runtime.js';
import { resetWorld, world } from './shim/herdr.js';
import { FakeBridge } from './fake-bridge.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/mod-link/bridge-to-mod/panel.json', import.meta.url)), 'utf8'));
const P1 = 'd-0000000000000001';
const P2 = 'd-0000000000000002';

/** A view with a pending phone and an approved laptop. */
function view(over = {}) {
  const v = JSON.parse(JSON.stringify(FIXTURE.view));
  v.devices.push({
    id: P2, name: 'Laptop 1', login: 'user-1@example', state: 'approved',
    caps: { view: true, 'inbox.answer': true, navigate: false, 'terminal.input': false, push: false },
    terminal_input_until: null, created_at: Date.now() - 1000, last_seen: Date.now() - 3 * 3600_000, live: 0,
  });
  v.pairing = null;
  return Object.assign(v, over);
}

const find = (n, id) => {
  if (!n || typeof n === 'string') return null;
  if (n.id === id) return n;
  for (const c of n.children) { const f = find(c, id); if (f) return f; }
  return null;
};
const texts = (n, out = []) => {
  if (typeof n === 'string') out.push(n);
  else for (const c of n?.children ?? []) texts(c, out);
  return out;
};
const text = (m) => texts(m.tree).join(' | ');

let bridge;
let m;
let conn;
const click = (id, cx) => find(m.tree, id).handlers.on_click({}, cx ?? m.cx());

beforeEach(async () => {
  resetWorld();
  bridge = new FakeBridge();
  await bridge.listen();
  m = new Mounted(Remote, { props: { role: 'panel' } });
  conn = await bridge.conn();
  await FakeBridge.next(conn, (x) => x.type === 'hello');
});
afterEach(async () => {
  if (!m.stopped) await m.close();
  await bridge.close();
});

async function push(v) {
  FakeBridge.send(conn, { type: 'panel', seq: 1, view: v });
  for (let i = 0; i < 100 && !text(m).includes(v.devices[0]?.name ?? 'Remote'); i += 1) await settle(10);
  await settle(20);
}

describe('sanitize', () => {
  it('accepts the shared fixture and keeps its content', () => {
    const v = sanitize(FIXTURE.view);
    expect(v.devices[0]).toMatchObject({ id: P1, name: 'Phone 1', state: 'pending' });
    expect(v.pairing.qr).toHaveLength(4);
    expect(modLink.PanelView.safeParse(FIXTURE.view).success).toBe(true);
  });
  it('rejects junk and drops devices with odd ids, so no act can carry one', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize({ status: 'serving; rm -rf' })).toBeNull();
    const v = sanitize({ ...FIXTURE.view, devices: [{ ...FIXTURE.view.devices[0], id: '../../x' }, FIXTURE.view.devices[0]] });
    expect(v.devices.map((d) => d.id)).toEqual([P1]);
  });
  it('clips long text and drops a malformed QR', () => {
    const v = sanitize({ ...FIXTURE.view, url: 'x'.repeat(999), pairing: { url: 'u', expires_at: 1, qr: ['0102'] } });
    expect(v.url).toHaveLength(300);
    expect(v.pairing).toBeNull();
  });
});

describe('panel copy', () => {
  it('shows a waiting state, then Status from the bridge view', async () => {
    expect(text(m)).toContain('Waiting for the bridge');
    await push(view());
    const t = text(m);
    expect(t).toContain('Remote');
    expect(t).toContain('Open on your phone');
    expect(t).toContain('https://desk-1.example-tailnet.ts.net');
    expect(t).toContain('Bridge running');
    expect(t).toContain('Devices 2');
    expect(t).toContain('Pause remote access');
  });

  it('never sends host state', async () => {
    await push(view());
    await settle(250);
    expect(conn.lines.filter((l) => l.msg.type === 'state')).toEqual([]);
  });

  it('Devices: a pending phone has Approve and Refuse, which send exactly the allowed acts', async () => {
    await push(view());
    click('tab-devices');
    await settle(10);
    expect(text(m)).toContain('Waiting for approval');
    expect(text(m)).toContain('Away · 3h');
    click(`approve-${P1}`);
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(a).toMatchObject({ kind: 'device.approve', args: { id: P1 } });
    expect(modLink.checkPanelAct(a.kind, a.args).ok).toBe(true);
    FakeBridge.send(conn, { type: 'panel_res', id: a.id, ok: true });
    click(`refuse-${P1}`);
    const r = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(r).toMatchObject({ kind: 'device.revoke', args: { id: P1 } });
  });

  it('a refusal from the bridge shows as a message and clears on the next try', async () => {
    await push(view());
    click(`tab-devices`);
    click(`revoke-${P2}`);
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    FakeBridge.send(conn, { type: 'panel_res', id: a.id, ok: false, code: 'not_found' });
    for (let i = 0; i < 100 && !find(m.tree, 'error'); i += 1) await settle(10);
    expect(text(m)).toContain('That device is gone.');
    click('tab-status');
    expect(find(m.tree, 'error')).toBeNull();
  });

  it('terminal input asks for an expiry first; the choice becomes minutes (or none)', async () => {
    await push(view());
    click('tab-devices');
    click(`settings-${P2}`);
    click(`cap-${P2}-terminal.input`);
    expect(conn.lines.filter((l) => l.msg.type === 'panel_act')).toEqual([]); // nothing sent before a choice
    expect(find(m.tree, `expiry-${P2}`)).not.toBeNull();
    click(`expiry-${P2}-60`);
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(a).toMatchObject({ kind: 'device.cap', args: { id: P2, cap: 'terminal.input', on: true, minutes: 60 } });
    click(`cap-${P2}-terminal.input`);
    click(`expiry-${P2}-none`);
    const b = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(b.args).toEqual({ id: P2, cap: 'terminal.input', on: true });
    expect(modLink.checkPanelAct(b.kind, b.args).ok).toBe(true);
  });

  it('other switches flip at once, and an enabled terminal input turns off at once', async () => {
    const v = view();
    v.devices[1].caps['terminal.input'] = true;
    v.devices[1].terminal_input_until = Date.now() + 3600_000;
    await push(v);
    click('tab-devices');
    click(`settings-${P2}`);
    expect(text(m)).toContain('until');
    click(`cap-${P2}-navigate`);
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ args: { id: P2, cap: 'navigate', on: true } });
    click(`cap-${P2}-terminal.input`);
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ args: { id: P2, cap: 'terminal.input', on: false } });
  });

  it('Pause becomes Resume while paused', async () => {
    await push(view());
    click('pause');
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ kind: 'remote.pause', args: {} });
    await push(view({ status: 'paused' }));
    expect(text(m)).toContain('Resume remote access');
    click('resume');
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ kind: 'remote.resume' });
  });

  it('shows a QR with a countdown, and Copy puts the link on the clipboard', async () => {
    await push(view({ pairing: { url: 'https://desk-1.example-tailnet.ts.net/pair#c=AAAAAAAAAAAAAAAAAAAAAA', expires_at: Date.now() + 90_000, qr: ['0110', '1001', '1001', '0110'] } }));
    click('tab-devices');
    expect(find(m.tree, 'qr')).not.toBeNull();
    expect(text(m)).toMatch(/Expires in 1:[23]\d/);
    click('pair-copy');
    expect(m.clipboard).toContain('/pair#c=');
    click('pair-hide');
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ kind: 'pair.hide' });
  });

  it('Plugins and Activity tabs draw the view', async () => {
    await push(view());
    click('tab-plugins');
    expect(text(m)).toContain('too old: update');
    expect(text(m)).toContain('Powers: Usage');
    click('tab-activity');
    expect(text(m)).toContain('Phone 1 asked to pair');
  });

  it('an act with no bridge connection fails clearly instead of hanging', async () => {
    await push(view());
    click('tab-devices');
    conn.socket.destroy();
    await settle(50);
    click(`revoke-${P2}`);
    for (let i = 0; i < 100 && !find(m.tree, 'error'); i += 1) await settle(10);
    expect(find(m.tree, 'error')).not.toBeNull();
  });
});

describe('link copy', () => {
  it('ignores a panel view and panel_res, and never sends panel_act', async () => {
    await m.close();
    await bridge.close();
    bridge = new FakeBridge();
    await bridge.listen();
    m = new Mounted(Remote, { props: { role: 'link' } });
    const c = await bridge.conn();
    FakeBridge.send(c, { type: 'panel', seq: 1, view: view() });
    FakeBridge.send(c, { type: 'panel_res', id: 'p-1', ok: true });
    await settle(150);
    expect(m.error).toBeUndefined();
    expect(c.lines.filter((l) => l.msg.type === 'panel_act')).toEqual([]);
  });

  it('a notify with action open_panel makes the toast open the panel', async () => {
    await m.close();
    await bridge.close();
    bridge = new FakeBridge();
    await bridge.listen();
    m = new Mounted(Remote, { props: { role: 'link' } });
    const c = await bridge.conn();
    FakeBridge.send(c, { type: 'notify', level: 'info', message: 'Approve Phone 1?', action: 'open_panel' });
    FakeBridge.send(c, { type: 'notify', level: 'info', message: 'plain' });
    for (let i = 0; i < 100 && world.ran.filter(([k]) => k === 'notify').length < 2; i += 1) await settle(10);
    const toasts = world.ran.filter(([k]) => k === 'notify').map(([, n]) => n);
    expect(toasts[0].action).toEqual({ name: 'herdr-app-remote.open' });
    expect(toasts[1].action).toBeUndefined();
  });
});
