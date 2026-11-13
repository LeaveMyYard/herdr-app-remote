import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeApi, modLink } from '@herdr-remote/protocol';
import Remote from '../herdr-app-remote/main.js';
import { SETUP_PROBLEM_CODES, SETUP_SERVING, SETUP_STEP_IDS, sanitize } from '../herdr-app-remote/panel.js';
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

  it('special keys (S16b) mirror terminal input: an expiry first, then minutes; off at once; until shown', async () => {
    await push(view());
    click('tab-devices');
    click(`settings-${P2}`);
    expect(text(m)).toContain('Special keys');
    expect(text(m)).toContain('Lets this phone press Esc, Ctrl-C and the arrow keys in a terminal.');
    click(`cap-${P2}-terminal.keys`);
    expect(conn.lines.filter((l) => l.msg.type === 'panel_act')).toEqual([]);
    expect(find(m.tree, `expiry-${P2}-keys`)).not.toBeNull();
    // Only the special keys row asks: the terminal input row's chooser stays closed.
    expect(find(m.tree, `expiry-${P2}`)).toBeNull();
    click(`expiry-${P2}-keys-480`);
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(a).toMatchObject({ kind: 'device.cap', args: { id: P2, cap: 'terminal.keys', on: true, minutes: 480 } });
    expect(modLink.checkPanelAct(a.kind, a.args).ok).toBe(true);
    click(`cap-${P2}-terminal.keys`);
    click(`expiry-${P2}-keys-none`);
    expect((await FakeBridge.next(conn, (x) => x.type === 'panel_act')).args).toEqual({ id: P2, cap: 'terminal.keys', on: true });
    const v = view();
    v.devices[1].caps['terminal.keys'] = true;
    v.devices[1].terminal_keys_until = Date.now() + 3600_000;
    await push(v);
    expect(text(m)).toContain('until');
    expect(text(m)).toContain('special keys');
    click(`cap-${P2}-terminal.keys`);
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ args: { id: P2, cap: 'terminal.keys', on: false } });
  });

  it('chat history (CV1) is its own switch, off by default, and flips at once with no expiry', async () => {
    await push(view());
    click('tab-devices');
    click(`settings-${P2}`);
    expect(text(m)).toContain('Chat history');
    expect(text(m)).toContain("Lets this phone read agents' conversations, not just the screen.");
    // Off by default: the summary does not name it (a view without the field, from an older bridge, reads as off).
    expect(text(m)).not.toContain('chat history');
    click(`cap-${P2}-transcript.read`);
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    // No "Allow for" chooser first, and never `minutes`.
    expect(a).toMatchObject({ kind: 'device.cap' });
    expect(a.args).toEqual({ id: P2, cap: 'transcript.read', on: true });
    expect(modLink.checkPanelAct(a.kind, a.args).ok).toBe(true);
    expect(find(m.tree, `expiry-${P2}`)).toBeNull();
    const v = view();
    v.devices[1].caps['transcript.read'] = true;
    await push(v);
    expect(text(m)).toContain('chat history');
    expect(text(m)).not.toContain('until');
    click(`cap-${P2}-transcript.read`);
    expect((await FakeBridge.next(conn, (x) => x.type === 'panel_act')).args).toEqual({ id: P2, cap: 'transcript.read', on: false });
    // The bridge refuses a time limit on it.
    expect(modLink.checkPanelAct('device.cap', { id: P2, cap: 'transcript.read', on: true, minutes: 60 }).ok).toBe(false);
  });

  it('sanitize keeps transcript.read only when it is exactly true', () => {
    const v = view();
    v.devices[1].caps['transcript.read'] = 'yes';
    expect(sanitize(v).devices[1].caps['transcript.read']).toBe(false);
    v.devices[1].caps['transcript.read'] = true;
    expect(sanitize(v).devices[1].caps['transcript.read']).toBe(true);
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

const SETUP_FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/mod-link/bridge-to-mod/panel-setup.json', import.meta.url)), 'utf8'));
const HTTPS_OFF = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/bridge-api/setup/https-off.json', import.meta.url)), 'utf8'));

/** A not-yet-serving view: the Setup view, at step 4 with the operator problem unless overridden. */
function setupView(setup = {}) {
  const v = JSON.parse(JSON.stringify(SETUP_FIXTURE.view));
  Object.assign(v.setup, setup);
  return v;
}
async function pushSetup(v, want = 'Set up remote access') {
  FakeBridge.send(conn, { type: 'panel', seq: 1, view: v });
  for (let i = 0; i < 100 && !text(m).includes(want); i += 1) await settle(10);
  await settle(20);
}
const acts = () => conn.lines.filter((l) => l.msg.type === 'panel_act').map((l) => l.msg);

describe('setup view (DesktopSetup)', () => {
  it('sanitize keeps the setup state; the shared fixture validates', () => {
    expect(modLink.PanelView.safeParse(SETUP_FIXTURE.view).success).toBe(true);
    const s = sanitize(SETUP_FIXTURE.view).setup;
    expect(s).toMatchObject({ step: 4, can_start: true, can_stop: false, busy: false });
    expect(s.steps[3].problem).toMatchObject({ code: 'operator', fix: 'sudo tailscale set --operator=$USER' });
    expect(sanitize(FIXTURE.view).setup).toBeNull();
  });

  it('sanitize drops a problem URL outside the Tailscale admin, unknown codes and odd step lists', () => {
    const bad = JSON.parse(JSON.stringify(SETUP_FIXTURE.view));
    bad.setup.steps[3].problem.url = 'https://evil.example/admin/dns';
    expect(sanitize(bad).setup.steps[3].problem.url).toBeNull();
    bad.setup.steps[3].problem.url = 'file:///etc/passwd';
    expect(sanitize(bad).setup.steps[3].problem.url).toBeNull();
    bad.setup.steps[3].problem.code = 'rm -rf';
    expect(sanitize(bad).setup.steps[3].problem).toBeNull();
    expect(sanitize({ ...SETUP_FIXTURE.view, setup: { ...SETUP_FIXTURE.view.setup, steps: [] } }).setup).toBeNull();
    expect(sanitize({ ...SETUP_FIXTURE.view, setup: { ...SETUP_FIXTURE.view.setup, can_start: 'yes' } }).setup.can_start).toBe(false);
  });

  it('draws the five steps with the board copy, replacing the tabs', async () => {
    await pushSetup(setupView(HTTPS_OFF));
    const t = text(m);
    expect(t).toContain('Set up remote access');
    expect(t).toContain('step 3 of 5');
    expect(t).toContain('Use herdr from your phone over your private Tailscale network. Each step is checked by itself.');
    for (const title of ['Tailscale installed', 'Signed in to a tailnet', 'HTTPS on the tailnet', 'Share herdr on the tailnet', 'Add your phone']) expect(t).toContain(title);
    expect(t).toContain('HTTPS certificates are off for this tailnet.');
    expect(t).toContain('Open Tailscale admin › DNS');
    expect(t).toContain('Turn on MagicDNS and HTTPS Certificates there. Checking again every 5 s…');
    expect(t).toContain('Check now');
    expect(t).toContain('Start serving');
    expect(find(m.tree, 'tabs')).toBeNull();
    expect(find(m.tree, 'pause')).toBeNull();
    // Done steps get the check mark, the current one its number.
    expect(find(m.tree, 'mark-installed').children[0].type).toBe('svg');
    expect(texts(find(m.tree, 'mark-https'))).toEqual(['3']);
  });

  it('Open Tailscale admin opens only the admin page; nothing is sent to the bridge', async () => {
    await pushSetup(setupView(HTTPS_OFF));
    click('open-admin');
    expect(m.opened).toEqual(['https://login.tailscale.com/admin/dns']);
    await settle(30);
    expect(acts()).toEqual([]);
  });

  it('Start serving is disabled (no click handler) until the bridge offers it', async () => {
    await pushSetup(setupView(HTTPS_OFF));
    expect(find(m.tree, 'setup-start').handlers.on_click).toBeUndefined();
  });

  it('a periodic check (busy) does not flicker the buttons', async () => {
    await pushSetup(setupView({ busy: true }));
    expect(find(m.tree, 'setup-start').handlers.on_click).toBeTypeOf('function');
    expect(text(m)).toContain('Check now');
    expect(text(m)).not.toContain('Checking…');
  });

  it('the protocol enums the mod copies match bridgeApi', () => {
    expect([...SETUP_PROBLEM_CODES]).toEqual([...bridgeApi.SETUP_PROBLEMS]);
    expect([...SETUP_STEP_IDS]).toEqual([...bridgeApi.SETUP_STEPS]);
    expect([...SETUP_SERVING]).toEqual(bridgeApi.SetupServing.options);
  });

  it('"herdr never runs this" only under a fix command; a fix-less failure says nothing of the kind', async () => {
    const steps = setupView().setup.steps;
    steps[3].problem = { code: 'failed', message: 'Tailscale did not serve herdr as expected. Nothing of yours was changed.' };
    await pushSetup(setupView({ steps }));
    expect(text(m)).toContain('Tailscale did not serve herdr as expected.');
    expect(text(m)).not.toContain('herdr never runs this for you.');
    expect(find(m.tree, 'fix')).toBeNull();
    steps[3].problem = { code: 'funnel_on', message: 'Funnel is on for port 8443.' };
    await pushSetup(setupView({ steps }), 'Funnel is on');
    expect(text(m)).not.toContain('herdr never runs this for you.');
  });

  it('MagicDNS off: the admin link, and its message is not repeated', async () => {
    const v = setupView(HTTPS_OFF);
    v.setup.steps[2].problem = { code: 'magicdns_off', message: 'MagicDNS is off for this tailnet. Turn on MagicDNS and HTTPS Certificates there.', url: 'https://login.tailscale.com/admin/dns' };
    await pushSetup(v);
    expect(text(m).split('Turn on MagicDNS and HTTPS Certificates there.').length).toBe(2);
  });

  it('a failed Check now is reported', async () => {
    await pushSetup(setupView());
    click('setup-check');
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    FakeBridge.send(conn, { type: 'panel_res', id: a.id, ok: false, code: 'failed' });
    for (let i = 0; i < 100 && !find(m.tree, 'error'); i += 1) await settle(10);
    expect(text(m)).toContain("That didn't work (failed).");
  });

  it('with phones known, not serving keeps the tabs: the steps sit in Status, Devices stays reachable', async () => {
    const v = view({ status: 'setup', url: null, setup: setupView().setup });
    await push(v);
    expect(find(m.tree, 'tabs')).not.toBeNull();
    expect(find(m.tree, 'setup-steps')).not.toBeNull();
    expect(text(m)).toContain('Share herdr on the tailnet');
    click('setup-start');
    expect(await FakeBridge.next(conn, (x) => x.type === 'panel_act')).toMatchObject({ kind: 'setup.start', args: {} });
    click('tab-devices');
    expect(find(m.tree, `revoke-${P2}`)).not.toBeNull();
  });

  it('Check now and Start serving send exactly the argument-free acts', async () => {
    await pushSetup(setupView());
    click('setup-check');
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(a).toMatchObject({ kind: 'setup.check', args: {} });
    expect(modLink.checkPanelAct(a.kind, a.args).ok).toBe(true);
    FakeBridge.send(conn, { type: 'panel_res', id: a.id, ok: true });
    for (let i = 0; i < 100 && text(m).includes('Checking…'); i += 1) await settle(10);
    click('setup-start');
    const b = await FakeBridge.next(conn, (x) => x.type === 'panel_act' && x.kind === 'setup.start');
    expect(b.args).toEqual({});
    expect(modLink.checkPanelAct(b.kind, b.args).ok).toBe(true);
    // While it runs, a second click sends nothing more.
    await settle(20);
    expect(text(m)).toContain('Starting…');
    expect(find(m.tree, 'setup-start').handlers.on_click).toBeUndefined();
    FakeBridge.send(conn, { type: 'panel_res', id: b.id, ok: false, code: 'operator' });
    await settle(50);
    // The step explains a setup refusal itself: no second message in the footer.
    expect(find(m.tree, 'error')).toBeNull();
    expect(acts()).toEqual([]); // nothing beyond the two acts read above
  });

  it('the operator fix is shown to copy, and never sent or run', async () => {
    await pushSetup(setupView());
    expect(texts(find(m.tree, 'fix-command'))).toEqual(['sudo tailscale set --operator=$USER']);
    expect(text(m)).toContain('herdr never runs this for you.');
    click('fix-copy');
    expect(m.clipboard).toBe('sudo tailscale set --operator=$USER');
    await settle(30);
    expect(acts()).toEqual([]);
    expect(world.ran).toEqual([]);
  });

  it('a transport failure on a setup act is still reported', async () => {
    await pushSetup(setupView());
    click('setup-check');
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    FakeBridge.send(conn, { type: 'panel_res', id: a.id, ok: false, code: 'no_setup' });
    for (let i = 0; i < 100 && !find(m.tree, 'error'); i += 1) await settle(10);
    expect(text(m)).toContain('This bridge does not manage Tailscale serve.');
  });

  it('Serving: the tabs return, and Stop serving asks once more before it sends setup.stop', async () => {
    const v = view({ setup: { ...setupView().setup, step: 6, serving: 'ours', can_start: false, can_stop: true } });
    await push(v);
    expect(find(m.tree, 'tabs')).not.toBeNull();
    click('stop-serving');
    await settle(30);
    expect(acts()).toEqual([]);
    expect(text(m)).toContain('Phones lose access until you start again.');
    click('stop-no');
    expect(find(m.tree, 'stop-confirm')).toBeNull();
    click('stop-serving');
    click('stop-yes');
    const a = await FakeBridge.next(conn, (x) => x.type === 'panel_act');
    expect(a).toMatchObject({ kind: 'setup.stop', args: {} });
    await settle(20);
    expect(text(m)).toContain('Stopping…');
    FakeBridge.send(conn, { type: 'panel_res', id: a.id, ok: false, code: 'operator' });
    await settle(50);
    // The bridge's view explains it (the notice); no second message in the footer.
    expect(find(m.tree, 'error')).toBeNull();
  });

  it('the notice (a Stop refused by the operator rule, or a Start herdr could not record) is drawn with its fix to copy', async () => {
    const notice = { code: 'operator', message: 'Tailscale lets only its operator change serve settings. Run this once in a terminal, then try again.', fix: 'sudo tailscale set --operator=$USER' };
    await push(view({ setup: { ...setupView().setup, step: 6, serving: 'ours', can_start: false, can_stop: true, notice } }));
    expect(find(m.tree, 'setup-notice')).not.toBeNull();
    expect(texts(find(m.tree, 'fix-command'))).toEqual(['sudo tailscale set --operator=$USER']);
    click('fix-copy');
    expect(m.clipboard).toBe('sudo tailscale set --operator=$USER');
    const unrecorded = { code: 'failed', message: 'herdr is served on the tailnet, but could not record that it set this up, so it will not stop serving by itself. To stop, run this in a terminal.', fix: 'tailscale serve --https=8443 off' };
    await push(view({ setup: { ...setupView().setup, step: 5, serving: 'identical', can_start: false, can_stop: false, notice: unrecorded } }));
    for (let i = 0; i < 100 && !text(m).includes('could not record'); i += 1) await settle(10);
    expect(texts(find(m.tree, 'fix-command'))).toEqual(['tailscale serve --https=8443 off']);
    expect(find(m.tree, 'stop-serving')).toBeNull();
    await settle(30);
    expect(acts()).toEqual([]);
  });

  it('no Stop serving for a handler herdr did not create', async () => {
    await push(view({ setup: { ...setupView().setup, step: 6, serving: 'identical', can_start: false, can_stop: false } }));
    expect(find(m.tree, 'stop-serving')).toBeNull();
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
    // The link copy has no panel: it keeps no view, and act() refuses without writing anything.
    expect(m.view.view).toBeUndefined();
    expect(await m.view.link.act(m.cx(), 'remote.pause', {})).toEqual({ ok: false, code: 'no_link' });
    await settle(50);
    expect(c.lines.filter((l) => l.msg.type === 'panel_act')).toEqual([]);
  });

  it('a notify with action open_panel makes the toast open the panel', async () => {
    await m.close();
    await bridge.close();
    bridge = new FakeBridge();
    await bridge.listen();
    m = new Mounted(Remote, { props: { role: 'link' } });
    const c = await bridge.conn();
    FakeBridge.send(c, { type: 'notify', level: 'info', message: 'Approve a new phone?', action: 'open_panel' });
    FakeBridge.send(c, { type: 'notify', level: 'info', message: 'plain' });
    for (let i = 0; i < 100 && world.ran.filter(([k]) => k === 'notify').length < 2; i += 1) await settle(10);
    const toasts = world.ran.filter(([k]) => k === 'notify').map(([, n]) => n);
    expect(toasts[0].action).toEqual({ name: 'herdr-app-remote.open' });
    expect(toasts[1].action).toBeUndefined();
  });
});
