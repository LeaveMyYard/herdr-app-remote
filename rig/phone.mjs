// The phone, for the S14 rig scenario: requests through the serve stand-in (127.0.0.1:8443) or straight to the
// bridge (127.0.0.1:47391, no identity headers). Prints one JSON line per result.
//   node phone.mjs <repo> <rig> get <path> [host] [direct]
//   node phone.mjs <repo> <rig> pair            (posts the code in <rig>/pair.code, keeps the cookie)
//   node phone.mjs <repo> <rig> me
//   node phone.mjs <repo> <rig> ws <seconds>    (hello, sub host+setup; prints frames and the close code)
import http from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , repo, rig, cmd, ...rest] = process.argv;
const HOST = 'desk-1.example-tailnet.ts.net:8443';
const ORIGIN = `https://${HOST}`;
const STANDIN = 8443;
const API = 47391;
const cookieFile = join(rig, 'phone.cookie');
const cookie = () => (existsSync(cookieFile) ? readFileSync(cookieFile, 'utf8').trim() : '');
const say = (o) => console.log(JSON.stringify(o));

function req(method, path, { host = HOST, port = STANDIN, headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...headers }, setHost: false }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    r.end(body);
  });
}

if (cmd === 'get') {
  const [path, host = HOST, how] = rest;
  const r = await req('GET', path, { host, port: how === 'direct' ? API : STANDIN });
  say({ get: path, host, how: how ?? 'standin', status: r.status, body: r.body.slice(0, 80) });
} else if (cmd === 'pair') {
  const code = readFileSync(join(rig, 'pair.code'), 'utf8').trim();
  const r = await req('POST', '/api/v1/pair', {
    headers: { Origin: ORIGIN, 'X-Remote-Api': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: 'Phone 1' }),
  });
  const sc = [r.headers['set-cookie'] ?? []].flat()[0] ?? '';
  if (sc) writeFileSync(cookieFile, sc.split(';')[0]);
  let state = null;
  try { state = JSON.parse(r.body).device.state; } catch { /* not a device */ }
  say({ pair: r.status, state, cookie: sc ? sc.split(';').slice(1).map((x) => x.trim()).join('; ') : null });
} else if (cmd === 'me') {
  const r = await req('GET', '/api/v1/me', { headers: { Cookie: cookie() } });
  let state = null;
  try { state = JSON.parse(r.body).device.state; } catch { /* unpaired */ }
  say({ me: r.status, state });
} else if (cmd === 'ws') {
  const require = createRequire(join(repo, 'packages/bridge/package.json'));
  const WebSocket = require('ws');
  const secs = Number(rest[0] ?? 10);
  const ws = new WebSocket(`ws://127.0.0.1:${STANDIN}/api/v1/ws`, ['herdr-remote.v1'], { headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie() } });
  ws.on('unexpected-response', (_q, res) => { say({ ws: 'refused', status: res.statusCode }); process.exit(0); });
  ws.on('open', () => {
    say({ ws: 'open', protocol: ws.protocol });
    ws.send(JSON.stringify({ type: 'hello', api: 1 }));
    ws.send(JSON.stringify({ type: 'sub', topics: ['host', 'setup'] }));
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const o = { frame: m.type, topic: m.topic };
    if (m.type === 'snap' && m.topic === 'host') o.spaces = (m.data?.spaces ?? []).map((s) => s.name);
    if (m.type === 'snap' && m.topic === 'setup') o.step = m.data?.step;
    say(o);
  });
  ws.on('close', (code) => { say({ ws: 'closed', code }); process.exit(0); });
  ws.on('error', (e) => say({ ws: 'error', error: e.message }));
  setTimeout(() => { say({ ws: 'timeout' }); process.exit(0); }, secs * 1000);
} else {
  say({ error: `unknown command ${cmd}` });
  process.exit(2);
}
