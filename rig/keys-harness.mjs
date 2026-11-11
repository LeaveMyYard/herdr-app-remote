// Rig harness for the special-keys menu (S16b): the bridge's real Security, Hub, HTTP + WebSocket server, key menu and
// terminal.keys actor, driving the rig's OWN hc (private HC_SESSION, socket inside the rig) against a terminal running
// a raw-mode program that logs every byte it gets as hex. Proves: every token the protocol allows is accepted by the
// real `hc keys` and sends a control byte or an escape sequence (never plain text), an unknown name presses nothing,
// off by default, the menu round trip, a stale menu refused, a damaged keys.json set aside, a closed terminal refused,
// the rate limit, expiry, and Activity holding entry ids only. Fake data only. Every check is one JSON line in <log>.
// Run only by rig/scenarios/terminal-keys.sh, inside the sandbox.
//   node keys-harness.mjs <repo root> <rig dir> <terminal id> <bytes log> <log>
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, rig, term, bytesLog, log] = process.argv;
const note = o => appendFileSync(log, `${JSON.stringify(o)}\n`);
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails += 1;
  note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
};
const bridge = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const { bridgeApi } = await import(pathToFileURL(join(repo, 'packages/protocol/dist/index.js')).href);
const WebSocket = createRequire(join(repo, 'packages/bridge/package.json'))('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The hex chunks the raw program has logged so far, one per read. */
const chunks = () => (existsSync(bytesLog) ? readFileSync(bytesLog, 'utf8').split('\n').filter(Boolean) : []);
async function nextChunks(before, want = 1, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const c = chunks();
    if (c.length >= before + want) return c.slice(before);
    await sleep(10);
  }
  return chunks().slice(before);
}
/** Control byte (C0 or DEL) anywhere in the hex: a key, not text. */
const hasControl = hex => (hex.match(/../g) ?? []).some(b => parseInt(b, 16) < 0x20 || parseInt(b, 16) === 0x7f);
const hcKeys = (...keys) => spawnSync('hc', ['keys', '--json', '--', term, ...keys], { encoding: 'utf8' });

// ---- 1. Every allowed token through the real hc keys ----
const tokens = bridgeApi.allKeyTokens();
const refused = [];
const textual = [];
for (const t of tokens) {
  const before = chunks().length;
  const r = hcKeys(t);
  if (r.status !== 0) {
    refused.push(`${t}:${r.status}`);
    continue;
  }
  const got = await nextChunks(before);
  const hex = got.join('');
  if (!hex || !hasControl(hex)) textual.push(`${t}:${hex}`);
}
check(`hc keys accepts all ${tokens.length} allowed tokens`, refused.length === 0, refused.slice(0, 20));
check('every allowed token sends a control byte or escape (never plain text)', textual.length === 0, textual.slice(0, 20));
// Tokens the grammar refuses because hc would type text with them (recorded so a change in hc shows up here).
const asText = [];
for (const t of ['a', 'shift+a', 'ctrl+0', 'space', 'shift+space', 'super+x']) {
  const before = chunks().length;
  const r = hcKeys(t);
  const hex = r.status === 0 ? (await nextChunks(before)).join('') : '';
  if (r.status === 0 && !hasControl(hex)) asText.push(t);
  check(`refused token ${t} is also refused by the grammar`, !bridgeApi.isKeyToken(t));
}
check('hc keys still types text for a, shift+a, ctrl+0, space, shift+space, super+x (why they are refused)', asText.length === 6, asText);
{
  const before = chunks().length;
  const r = hcKeys('left', 'bogus');
  await sleep(700);
  check('an unknown key name is invalid_params and presses nothing, not even the keys before it', r.status !== 0 && /"invalid_params"/.test(r.stderr) && chunks().length === before, { status: r.status });
}

// ---- 2. The bridge ----
const SERVE = 'desk-1.example-tailnet.ts.net';
const OWNER = 'user-1@example';
const ORIGIN = `https://${SERVE}`;
const dataDir = join(rig, 'bridge-keys-data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// A damaged menu first: set aside, never used.
writeFileSync(join(dataDir, 'keys.json'), JSON.stringify({ v: 1, keys: [{ label: 'Question Title 123', keys: ['hello'] }] }));
const notes = [];
let sec;
const menu = new bridge.KeysMenu(dataDir, l => notes.push(l.load));
check('a damaged keys.json is set aside', notes[0]?.state === 'damaged' && notes[0]?.setAside === true && existsSync(join(dataDir, 'keys.json.damaged')) && !existsSync(join(dataDir, 'keys.json')), notes[0]);
check('the default menu is in force', menu.current().rev === bridge.menuTopic(bridge.DEFAULT_KEYS).rev);
sec = new bridge.Security({ dataDir, serve: { host: SERVE, login: OWNER }, inner: bridge.routeActs([bridge.terminalKeysActor({ run: bridge.run, menu })]) });
const hub = new bridge.Hub({ bridgeVersion: 'rig', onAct: sec.act });
hub.publish('keys', menu.current());
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
  // terminal.input on, terminal.keys off: one does not grant the other.
  sec.setCap(id, 'terminal.input', true);

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
  ws.send(JSON.stringify({ type: 'sub', topics: ['keys'] }));
  const snap = await until(m => m.type === 'snap' && m.topic === 'keys');
  check('the keys topic is the default menu, valid against the protocol', bridgeApi.KeysTopic.safeParse(snap.data).success && snap.data.keys.map(k => k.id).join(',') === 'esc,tab,shift-tab,ctrl-c,up,down,left,right', snap.data);
  let rev = snap.data.rev;
  let n = 0;
  const act = async (kind, args) => {
    const aid = `rig-${++n}`;
    ws.send(JSON.stringify({ type: 'act', id: aid, kind, args }));
    return until(m => m.type === 'res' && m.id === aid);
  };
  const press = (key, r = rev, terminal = term) => act('terminal.keys', { terminal, key, rev: r });

  // 1. Off by default (terminal.input alone doesn't grant it): refused, nothing pressed.
  let before = chunks().length;
  const off = await press('ctrl-c');
  check('terminal.keys off by default: forbidden', off.ok === false && off.code === 'forbidden', off);
  await sleep(800);
  check('nothing was pressed while off', chunks().length === before);

  // 2. On, with an expiry: Ctrl-C and Shift-Tab arrive as their bytes.
  const expires = Date.now() + 20_000;
  sec.setCap(id, 'terminal.keys', true, expires);
  before = chunks().length;
  const cc = await press('ctrl-c');
  check('ctrl-c res ok', cc.ok === true, cc);
  check('the terminal got 03 (Ctrl-C)', (await nextChunks(before)).join('') === '03');
  before = chunks().length;
  const st = await press('shift-tab');
  check('shift-tab res ok', st.ok === true, st);
  check('the terminal got ESC [ Z (Shift-Tab)', (await nextChunks(before)).join('') === '1b5b5a');

  // 3. The phone can't name keys: a key name as the id, or extra fields, are bad_args.
  const named = await act('terminal.keys', { terminal: term, key: 'ctrl+c', rev });
  check('a key name as the entry id is bad_args', named.code === 'bad_args', named);
  const extra = await act('terminal.keys', { terminal: term, key: 'esc', rev, keys: ['a'] });
  check('extra keys in the args are bad_args', extra.code === 'bad_args', extra);
  const unknown = await press('ctrl-z');
  check('an id not in the menu is unknown_key', unknown.code === 'unknown_key', unknown);

  // 4. The desktop edits keys.json: the old rev is refused, the new menu's multi-key entry presses its keys in order.
  writeFileSync(join(dataDir, 'keys.json'), JSON.stringify({ v: 1, keys: [{ id: 'two-up', label: 'Up twice', keys: ['up', 'up'] }, { label: 'Esc', keys: ['esc'] }] }));
  // A file changed under a second ago is left for the next look (an in-place save may be half-written).
  await sleep(1200);
  before = chunks().length;
  const stale = await press('esc', rev);
  check('a press from the old menu is keys_changed', stale.code === 'keys_changed', stale);
  rev = menu.current().rev;
  const two = await press('two-up');
  check('the new menu entry res ok', two.ok === true, two);
  await nextChunks(before, 1);
  await sleep(300);
  check('the terminal got Up, Up and nothing for the stale press', chunks().slice(before).join('') === '1b5b411b5b41', chunks().slice(before));

  // 5. A terminal hc doesn't know: refused before any key.
  const missing = await press('esc', rev, 't99');
  check('unknown terminal: terminal_not_found', missing.ok === false && missing.code === 'terminal_not_found' && !missing.unknown_effect, missing);

  // 6. The rate limit (10 per 10 s): a burst of 14 is cut off, and nothing past the cut is pressed.
  await sleep(10_500); // let the window of the presses above age out
  before = chunks().length;
  const burst = [];
  for (let i = 0; i < 14; i++) burst.push(await press('esc'));
  const cut = burst.findIndex(r => r.code === 'rate_limited');
  check('the burst is cut off with rate_limited', cut >= 0 && burst.slice(cut).every(r => r.code === 'rate_limited'), burst.map(r => r.code ?? 'ok'));
  await sleep(1000);
  check('only the presses before the cut reached the terminal', chunks().slice(before).join('') === '1b'.repeat(cut), { cut, got: chunks().slice(before).length });

  // 7. Expiry: once the time is up the bridge turns it off by itself and refuses.
  await sleep(Math.max(0, expires + 500 - Date.now()));
  before = chunks().length;
  const late = await press('esc');
  check('after expiry: forbidden', late.ok === false && late.code === 'forbidden', late);
  check('the device shows terminal.keys off', sec.devices().find(d => d.id === id)?.caps['terminal.keys'] === false);
  await sleep(800);
  check('nothing pressed after expiry', chunks().length === before);

  // 8. A finished terminal.
  sec.setCap(id, 'terminal.keys', true);
  await sleep(10_500); // the burst's rate-limit window ages out
  spawnSync('hc', ['kill', term]);
  await sleep(1000);
  const gone = await press('esc');
  check('a finished terminal is terminal_finished or terminal_not_found', gone.ok === false && ['terminal_finished', 'terminal_not_found'].includes(gone.code) && !gone.unknown_effect, gone);

  ws.close();
  const activity = readFileSync(join(dataDir, 'activity.jsonl'), 'utf8');
  appendFileSync(join(rig, 'keys-activity-copy.jsonl'), activity);
  check('audit: a press names the entry id and count', activity.includes(`Phone 1 pressed ctrl-c (1 key) in ${term}`) && activity.includes(`Phone 1 pressed two-up (2 keys) in ${term}`));
  check('audit: the refusal while off names no key', activity.includes(`Phone 1 pressed a key in ${term}: refused`));
  check('audit: the expiry', activity.includes('Phone 1: terminal.keys expired'));
  check('audit: no labels, no key names, no file content', !/Up twice|Shift-Tab|Ctrl-C|shift\+tab|ctrl\+c|Question Title|hello/.test(activity));
} catch (e) {
  check('harness ran to the end', false, String(e));
} finally {
  sec.close();
  await srv.close();
  note({ done: true, fails });
}
process.exit(fails === 0 ? 0 : 1);
