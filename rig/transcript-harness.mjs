// Rig harness for chat history (CV1): the capability `transcript.read`, through the bridge's real API side
// (`startApp`: Security, Hub with its topic gate, the HTTP + WebSocket server) and its real LinkServer, with the
// harness playing the desktop Remote panel over its own panel connection (the same `panel_act` the mod sends).
// Proves: a devices.json from before CV1 loads with it off; the transcript topics are refused (`stale forbidden`,
// no snap) while every other topic still works; the panel switch refuses a time limit, turns it on (stored in
// devices.json) and off; turning it off ends an open subscription without closing the socket; Activity holds
// identifiers only. Fake data only. Every check is one JSON line in <log>.
// Run only by rig/scenarios/transcript-read.sh, inside the sandbox.
//   node transcript-harness.mjs <repo root> <rig dir> <log>
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, rig, log] = process.argv;
const note = o => appendFileSync(log, `${JSON.stringify(o)}\n`);
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails += 1;
  note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
};
const B = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const { bridgeApi } = await import(pathToFileURL(join(repo, 'packages/protocol/dist/index.js')).href);
const WebSocket = createRequire(join(repo, 'packages/bridge/package.json'))('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SERVE = 'desk-1.example-tailnet.ts.net';
const OWNER = 'user-1@example';
const ORIGIN = `https://${SERVE}`;
const appHome = join(rig, 'transcript-app');
const dataDir = join(appHome, 'data/herdr-app-remote');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

// A devices.json as a bridge from before S16b and CV1 wrote it: no terminal.keys, no transcript.read.
const token = randomBytes(32).toString('base64url');
const ID = 'd-00000000000000a1';
const now = Date.now();
writeFileSync(join(dataDir, 'devices.json'), JSON.stringify({
  v: 1, paused: false, devices: [{
    id: ID, name: 'Phone 1', login: OWNER, token_sha256: createHash('sha256').update(token).digest('hex'), state: 'approved',
    caps: { view: true, 'inbox.answer': true, navigate: false, 'terminal.input': false, 'terminal.input.until': null, push: false },
    created_at: now - 60_000, approved_at: now - 50_000, last_seen: null,
  }],
}), { mode: 0o600 });

const linkToken = B.newLinkToken();
const link = new B.LinkServer({ token: linkToken });
const linkPort = await link.listen();
const app = await B.startApp({ appHome, link, port: 0, serve: { host: SERVE, login: OWNER }, tailscale: 'tailscale', funnelCheckMs: 600_000 });
note({ listening: app.port });

/** One panel_act as the Remote panel copy sends it, over its own panel connection; resolves with the panel_res. */
function panelAct(kind, args) {
  return new Promise((resolve, reject) => {
    const s = net.connect(linkPort, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error('no panel_res')); }, 20_000);
    s.setEncoding('utf8');
    s.on('error', e => { clearTimeout(timer); reject(e); });
    s.on('connect', () => {
      s.write(`${JSON.stringify({ type: 'hello', v: 1, token: linkToken, copy: 'panel', layout: 'rig-harness', app: { version: 'rig' } })}\n`);
      s.write(`${JSON.stringify({ type: 'panel_act', id: 'h-1', kind, args })}\n`);
    });
    s.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === 'panel_res' && m.id === 'h-1') {
          clearTimeout(timer);
          s.destroy();
          resolve(m);
        }
      }
    });
  });
}
const storedCaps = () => JSON.parse(readFileSync(join(dataDir, 'devices.json'), 'utf8')).devices[0].caps;
const activity = () => app.security.activity(1000).map(e => e.text);

try {
  check('a devices.json from before CV1 loads, with transcript.read off', app.security.devices()[0]?.caps['transcript.read'] === false, app.security.devices()[0]?.caps);

  // A stand-in for the CV3 / CV5 sources: values the hub would snap at once to an allowed subscriber.
  app.hub.publish('chatview:t1', { terminal: 't1', text: 'Question Title 123' });
  app.hub.publish('timeline:t1', { terminal: 't1', items: [] });

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { Host: SERVE, 'Tailscale-User-Login': OWNER, Origin: ORIGIN, Cookie: `${B.DEVICE_COOKIE}=${token}` } });
  const frames = [];
  const waiters = [];
  let closed = null;
  ws.on('message', m => {
    frames.push(JSON.parse(m.toString()));
    for (const w of waiters) w();
  });
  ws.on('close', c => { closed = c; });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const until = (pred, from = 0, ms = 10_000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(frames.slice(from).map(f => [f.type, f.topic]))}`)), ms);
    const c = () => { const v = frames.slice(from).find(pred); if (v) { clearTimeout(t); res(v); } };
    waiters.push(c);
    c();
  });
  const send = m => ws.send(JSON.stringify(m));
  send({ type: 'hello', api: 1 });
  await until(m => m.type === 'welcome');

  // 1. Off: refused with stale forbidden, nothing sent; the keys topic (needs only view) still snaps.
  send({ type: 'sub', topics: ['chatview:t1', 'timeline:t1', 'keys'] });
  const st = await until(m => m.type === 'stale' && m.topic === 'chatview:t1');
  check('chatview:t1 refused: stale forbidden', st.reason === 'forbidden' && bridgeApi.ServerMessage.safeParse(st).success, st);
  const st2 = await until(m => m.type === 'stale' && m.topic === 'timeline:t1');
  check('timeline:t1 refused: stale forbidden', st2.reason === 'forbidden', st2);
  await until(m => m.type === 'snap' && m.topic === 'keys');
  check('every other topic still works (keys snapped)', true);
  check('no transcript data reached the phone while off', !frames.some(f => (f.type === 'snap' || f.type === 'patch') && bridgeApi.isTranscriptTopic(f.topic)) && !JSON.stringify(frames).includes('Question Title'));
  check('the refusal is in Activity, by terminal id only', activity().includes('Phone 1 opened the chat of t1: refused, chat history is off'), activity().slice(-4));

  // 2. The panel switch: no time limit; on is stored in devices.json.
  const timed = await panelAct('device.cap', { id: ID, cap: 'transcript.read', on: true, minutes: 60 });
  check('the panel switch refuses a time limit (bad_args)', timed.ok === false && timed.code === 'bad_args', timed);
  check('still off after the refused grant', storedCaps()['transcript.read'] === false);
  const on = await panelAct('device.cap', { id: ID, cap: 'transcript.read', on: true });
  check('Chat history on from the panel', on.ok === true, on);
  check('devices.json now stores transcript.read true (and the S16b fields)', storedCaps()['transcript.read'] === true && storedCaps()['terminal.keys'] === false, storedCaps());
  check('Activity: Phone 1: transcript.read on', activity().includes('Phone 1: transcript.read on'));

  // 3. Allowed: the topics snap.
  let mark = frames.length;
  send({ type: 'sub', topics: ['chatview:t1', 'timeline:t1'] });
  const snap = await until(m => m.type === 'snap' && m.topic === 'chatview:t1', mark);
  check('with chat history on, chatview:t1 snaps', snap.data?.text === 'Question Title 123', snap);
  await until(m => m.type === 'snap' && m.topic === 'timeline:t1', mark);
  check('with chat history on, timeline:t1 snaps', true);

  // 4. Off again from the panel: the open subscriptions end now; the socket stays.
  mark = frames.length;
  const off = await panelAct('device.cap', { id: ID, cap: 'transcript.read', on: false });
  check('Chat history off from the panel', off.ok === true, off);
  const end1 = await until(m => m.type === 'stale' && m.topic === 'chatview:t1', mark);
  const end2 = await until(m => m.type === 'stale' && m.topic === 'timeline:t1', mark);
  check('turning it off ends both open subscriptions with stale forbidden', end1.reason === 'forbidden' && end2.reason === 'forbidden');
  app.hub.publish('chatview:t1', { terminal: 't1', text: 'Question Title 124' });
  send({ type: 'ping' });
  await until(m => m.type === 'pong', mark);
  await sleep(200);
  check('the socket stays open', closed === null);
  check('nothing more arrived on the ended topic', !frames.slice(mark).some(f => (f.type === 'snap' || f.type === 'patch') && f.topic === 'chatview:t1') && !JSON.stringify(frames).includes('Question Title 124'));
  check('Activity: Phone 1: transcript.read off', activity().includes('Phone 1: transcript.read off'));
  check('devices.json stores it off', storedCaps()['transcript.read'] === false);
  check('Activity never holds transcript text', !JSON.stringify(app.security.activity(1000)).includes('Question Title'));
  ws.close();
} catch (e) {
  check('harness ran to the end', false, String(e?.message ?? e));
} finally {
  await app.stop();
  await link.close();
}
note({ done: true, fails });
process.exit(fails ? 1 : 0);
