// Rig harness for the Remote panel (S13): the bridge's real LinkServer, Security and PanelDriver on
// loopback inside the rig's net namespace, seeded with FAKE devices, plugin states and activity so the
// panel can be compared with design/DesktopRemote.dc.html. runtime.json goes where the mod looks.
//   node panel-harness.mjs <repo root> <app home> <log>
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [, , repo, appHome, log] = process.argv;
const B = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const note = o => appendFileSync(log, `${JSON.stringify(o)}\n`);
const dataDir = join(appHome, 'data/herdr-app-remote');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const now = Date.now();
const caps = (over = {}) => ({ ...B.defaultCaps(), ...over });
const dev = (n, name, state, o = {}) => ({
  id: `d-000000000000000${n}`, name, login: 'user-1@example', token_sha256: 'a'.repeat(64), state,
  caps: caps(o.caps), created_at: now - 60_000 * n, approved_at: state === 'approved' ? now - 3_600_000 : null, last_seen: o.seen ?? null,
});
const store = new B.DeviceStore(dataDir);
store.add(dev(1, 'Phone 1', 'approved', { seen: now - 5_000, caps: { push: true } }));
store.add(dev(2, 'Laptop 1', 'approved', { seen: now - 3 * 3_600_000 }));
// Fake activity, written through a real AuditLog so the format is the bridge's own.
const audit = new B.AuditLog({ dir: dataDir });
for (const [ago, text] of [[22, 'Bridge started'], [21, 'Phone 1 connected'], [8, 'Phone 1 answered Q119 (Option B)'], [4, 'Laptop 1 disconnected']]) {
  audit.record({ ts: now - ago * 60_000, event: 'act', text });
}

const security = new B.Security({ dataDir, serve: { host: 'desk-1.example-tailnet.ts.net', login: 'user-1@example' } });
const hub = new B.Hub({ bridgeVersion: '0.0.0' });
hub.publish('plugins', {
  panorama: { state: 'ready' }, inbox: { state: 'ready' }, usage: { state: 'too_old' },
  hc: { state: 'ready' }, host: { state: 'ready' },
});
const token = B.newLinkToken();
const server = new B.LinkServer({ token, log: e => note({ log: e }) });
server.on('link', e => note({ link: e.copy }));
const port = await server.listen();
const driver = new B.PanelDriver({
  link: server, security, hub, funnel: () => 'off',
  extraChecks: () => [
    { id: 'tailscale', label: 'Tailscale connected', detail: 'example-tailnet · desk-1 · 100.64.0.10', state: 'ok' },
    { id: 'cert', label: 'HTTPS certificate', detail: 'valid for 61 days, renews by itself', state: 'ok' },
  ],
});
await driver.act('pair.code', {}); // a QR on screen, as in the board
// The mod connects only to a runtime naming the bundle hash of the install record: a stand-in record.
const FAKE_SHA = 'ab'.repeat(32);
writeFileSync(join(dataDir, 'install.json'), JSON.stringify({
  v: 1, install_id: '0123456789abcdef0123456789abcdef', node: '/nonexistent/node', dirs: [],
  files: { 'data/herdr-app-remote/bin/bridge.mjs': { sha256: FAKE_SHA, mode: 0o644 } }, previous: {}, keys: null,
}), { mode: 0o600 });
await B.writeRuntime(B.runtimePath(appHome), { v: 1, port, token, pid: process.pid, bundle_sha256: FAKE_SHA });
note({ listening: port, devices: security.devices().length });
setInterval(() => note({ tick: driver.view().devices.map(d => `${d.name}:${d.state}`).join(',') }), 5_000).unref();
