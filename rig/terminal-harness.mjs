// Rig harness for terminal input (S16): the bridge's real Security, Hub, HTTP + WebSocket server and terminal.send
// actor, driving the rig's OWN hc (private HC_SESSION, socket inside the rig) against a terminal running a line
// echoer. Proves: off by default (refused, nothing typed), the send round trip, `--force` typed as text, a closed
// terminal refused, the rate limit, expiry, and Activity holding lengths only. Fake data only. Every check is one
// JSON line in <log>. Run only by rig/scenarios/terminal-input.sh, inside the sandbox.
//   node terminal-harness.mjs <repo root> <rig dir> <terminal id> <log>
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, rig, term, log] = process.argv;
const note = o => appendFileSync(log, `${JSON.stringify(o)}\n`);
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails += 1;
  note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
};
const bridge = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const WebSocket = createRequire(join(repo, 'packages/bridge/package.json'))('ws');

/** The terminal's screen as hc reads it (the rig's own hc, private session). */
const screen = () => execFileSync('hc', ['read', term, '--lines', '60'], { encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function seen(text, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (screen().includes(text)) return true;
    await sleep(250);
  }
  return false;
}

const SERVE = 'desk-1.example-tailnet.ts.net';
const OWNER = 'user-1@example';
const ORIGIN = `https://${SERVE}`;
const dataDir = join(rig, 'bridge-data');
const sec = new bridge.Security({ dataDir, serve: { host: SERVE, login: OWNER }, inner: bridge.routeActs([bridge.terminalSendActor({ run: bridge.run })]) });
const hub = new bridge.Hub({ bridgeVersion: 'rig', onAct: sec.act });
const srv = bridge.createBridgeServer({ hub, guard: sec.guard, routes: sec.routes, onConnect: sec.onConnect });
const { port } = await srv.listen();
note({ listening: port, terminal: term });

const post = (path, body) => new Promise((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, method: 'POST', path, setHost: false, headers: { Host: SERVE, 'Tailscale-User-Login': OWNER, Origin: ORIGIN, 'X-Remote-Api': '1', 'Content-Type': 'application/json' } }, res => {
    let b = '';
    res.on('data', x => (b += x));
    res.on('end', () => {
      const sc = res.headers['set-cookie'];
      resolve({ status: res.statusCode, cookie: ((Array.isArray(sc) ? sc[0] : sc) ?? '').split(';')[0], body: b });
    });
  });
  r.on('error', reject);
  r.end(JSON.stringify(body));
});

try {
  const { code } = sec.issueCode();
  const paired = await post('/api/v1/pair', { code, name: 'Phone 1' });
  check('pairing request accepted', paired.status === 202, paired.status);
  const id = JSON.parse(paired.body).device.id;
  sec.approve(id);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, ['herdr-remote.v1'], { headers: { Host: SERVE, 'Tailscale-User-Login': OWNER, Origin: ORIGIN, Cookie: paired.cookie } });
  const frames = [];
  const waiters = [];
  ws.on('message', m => {
    frames.push(JSON.parse(m.toString()));
    for (const w of waiters) w();
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const until = (pred, ms = 30000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    const c = () => { const v = frames.find(pred); if (v) { clearTimeout(t); res(v); } };
    waiters.push(c);
    c();
  });
  ws.send(JSON.stringify({ type: 'hello', api: 1 }));
  await until(m => m.type === 'welcome');
  let n = 0;
  const act = async (kind, args) => {
    const aid = `rig-${++n}`;
    ws.send(JSON.stringify({ type: 'act', id: aid, kind, args }));
    return until(m => m.type === 'res' && m.id === aid);
  };
  const send = text => act('terminal.send', { terminal: term, text });

  // 1. Off by default: refused, and nothing reaches the terminal.
  const off = await send('Question Title 123 should not appear');
  check('terminal.input off by default: forbidden', off.ok === false && off.code === 'forbidden', off);
  await sleep(1500);
  check('nothing was typed while off', !screen().includes('Question Title 123'));

  // 2. On (with an expiry a few seconds out): the round trip through the real hc send.
  const expires = Date.now() + 15_000;
  sec.setCap(id, 'terminal.input', true, expires);
  const one = await send('hello from Phone 1');
  check('send res ok', one.ok === true, one);
  check('the terminal got the line, submitted with Enter', await seen('GOT[hello from Phone 1]'));

  // 3. Text that looks like hc's own flag is typed, not obeyed (the `--` in the argv).
  const flag = await send('--force');
  check('--force is sent as text', flag.ok === true, flag);
  check('the terminal got --force as a line', await seen('GOT[--force]'));

  // 4. Enter alone.
  const enter = await send('');
  check('Enter alone is ok', enter.ok === true, enter);
  check('the terminal got an empty line', await seen('GOT[]'));

  // 5. A control character never leaves the bridge.
  const esc = await send('\u001b[201~x');
  check('ESC is refused as bad_args', esc.ok === false && esc.code === 'bad_args', esc);

  // 6. A terminal hc doesn't know: refused before typing, no unknown effect.
  const missing = await act('terminal.send', { terminal: 't99', text: 'x' });
  check('unknown terminal: terminal_not_found', missing.ok === false && missing.code === 'terminal_not_found' && !missing.unknown_effect, missing);

  // 7. The send rate limit (6 per 10 s per device): a quick burst of 8 is cut off, and the rest never run.
  const burst = [];
  for (let i = 0; i < 8; i++) burst.push(await send(`burst ${i}`));
  const cut = burst.findIndex(r => r.code === 'rate_limited');
  check('the burst is cut off with rate_limited', cut >= 0 && burst.slice(cut).every(r => r.code === 'rate_limited'), burst.map(r => r.code ?? 'ok'));
  await sleep(1500);
  check('no line past the cut reached the terminal', !screen().includes(`GOT[burst ${cut}]`));

  // 8. Expiry: once the time is up the bridge turns it off by itself and refuses.
  await sleep(Math.max(0, expires + 500 - Date.now()));
  const late = await send('after expiry');
  check('after expiry: forbidden', late.ok === false && late.code === 'forbidden', late);
  check('the device shows terminal.input off', sec.devices().find(d => d.id === id)?.caps['terminal.input'] === false);
  await sleep(1000);
  check('nothing typed after expiry', !screen().includes('after expiry'));

  ws.close();
  const activity = readFileSync(join(dataDir, 'activity.jsonl'), 'utf8');
  appendFileSync(join(rig, 'activity-copy.jsonl'), activity);
  check('audit: the send as a length', activity.includes('Phone 1 sent 18 chars to ' + term));
  check('audit: the refusal while off', activity.includes(`Phone 1 sent 36 chars to ${term}: refused`));
  check('audit: the expiry', activity.includes('Phone 1: terminal.input expired'));
  check('audit: no text', !/hello from|Question Title|after expiry|burst/.test(activity));
} catch (e) {
  check('harness ran to the end', false, String(e));
} finally {
  sec.close();
  await srv.close();
  note({ done: true, fails });
}
process.exit(fails === 0 ? 0 : 1);
