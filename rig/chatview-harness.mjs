// Rig harness for the chat view topic (CV3): `chatview:<t>` and its older pages through the bridge's real API side
// (`startApp`: Security, the Hub's topic gate, the HTTP + WebSocket server, the panorama driver, the chat view
// driver) and its real LinkServer, with the real Claude reader child (dist/claude-reader.mjs, pinned SDK) checked
// against its sha256. Everything it reads is fake and private to the rig: a HOME with fixture transcripts
// (fixtures/claude), a fake agent-usage config naming them, a stand-in panorama contract (hash-pinned by a
// receipt, as the real one is) and a feed v2 that proves the session at terminal t1. The harness plays the link mod
// (host state over the link) and the phone. Every check is one JSON line in <log>.
// Run only by rig/scenarios/chatview.sh, inside the sandbox.
//   node chatview-harness.mjs <repo root> <rig dir> <log>
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
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
const sha = b => createHash('sha256').update(b).digest('hex');

const SERVE = 'desk-1.example-tailnet.ts.net';
const OWNER = 'user-1@example';
const ORIGIN = `https://${SERVE}`;
const S1 = '11111111-1111-4111-8111-111111111111';

// ---- the private world: HOME, agent-usage, transcripts, panorama ----
const home = join(rig, 'chatview-home');
const appHome = join(home, '.config/herdr-app');
const dataDir = join(appHome, 'data/herdr-app-remote');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
cpSync(join(repo, 'fixtures/claude/roots/claude-1'), join(home, 'claude-agent-1'), { recursive: true });
mkdirSync(join(home, '.config/agent-usage'), { recursive: true });
writeFileSync(join(home, '.config/agent-usage/config.toml'), '[[claude.profiles]]\nid = "agent-1"\nlabel = "Agent 1"\nconfig_dir = "~/claude-agent-1"\n');
const transcript = join(home, 'claude-agent-1/projects/-work-project-alpha', `${S1}.jsonl`);
const lines = readFileSync(transcript, 'utf8').split('\n').filter(l => l.endsWith('}'));
writeFileSync(transcript, `${lines.join('\n')}\n`);

// A stand-in for panorama's contract.js (same export names, written here), pinned by a receipt like the real one.
const CONTRACT = `export function parseFeed(text) { const f = JSON.parse(text); if (f.v !== 2 || !Array.isArray(f.roots)) throw Error('feed'); return f; }
export const aged = (p, now = Date.now()) => !Number.isFinite(p?.generated_at) || p.generated_at * 1000 > now || now - p.generated_at * 1000 > 15000;
export const rootKey = root => JSON.stringify(['root', root.host, root.terminal ?? root.pane_id]);
export function readResult(previous, text, error = null) {
  try { if (error || text === null) throw error || Error('feed.json'); const feed = parseFeed(text); return { feed, stale: false, errors: [], generated_at: feed.generated_at }; }
  catch (e) { return { feed: previous?.feed ?? null, stale: true, errors: [String(e)], generated_at: previous?.generated_at ?? null }; }
}
`;
mkdirSync(join(appHome, 'mods/panorama'), { recursive: true });
mkdirSync(join(appHome, 'data/panorama'), { recursive: true });
writeFileSync(join(appHome, 'mods/panorama/contract.js'), CONTRACT);
writeFileSync(join(appHome, 'data/panorama/install.json'), JSON.stringify({ v: 2, files: { 'mods/panorama/contract.js': { sha256: sha(CONTRACT), mode: 420 } } }));
const root = (terminal, harness, session_id, t) => ({
  pane_id: `core:${terminal}`, host: 'herdr-core', terminal, harness, tab_id: null, tab_label: 'Project Alpha', title: 'Agent 1', title_source: 'session',
  session_id, herdr_status: 'working', workspace_id: null, focused: false, cwd: '/work/project-alpha', transcript: t, pending: [], inbox: [],
  inbox_texts: [], hidden_finished: 0, tab_no: null, machine: null, machine_id: null, bg: [], last_activity: null, agents: [],
});
let feedAge = 0;
const writeFeed = () => writeFileSync(join(appHome, 'data/panorama/feed.json'), JSON.stringify({
  v: 2, generated_at: Date.now() / 1000 - feedAge, herdr_ok: true, inbox_ok: true, errors: [], counts: {},
  roots: [root('t1', 'claude', S1, transcript), root('t2', 'codex', null, null)],
}));
writeFeed();
const feedTimer = setInterval(writeFeed, 1000);

// ---- one approved phone, chat history off ----
const token = randomBytes(32).toString('base64url');
const ID = 'd-00000000000000c3';
const now = Date.now();
writeFileSync(join(dataDir, 'devices.json'), JSON.stringify({
  v: 1, paused: false, devices: [{
    id: ID, name: 'Phone 1', login: OWNER, token_sha256: sha(token), state: 'approved',
    caps: { view: true, 'inbox.answer': true, navigate: false, 'terminal.input': false, 'terminal.input.until': null, 'terminal.keys': false, 'terminal.keys.until': null, push: false, 'transcript.read': false },
    created_at: now - 60_000, approved_at: now - 50_000, last_seen: null,
  }],
}), { mode: 0o600 });

const linkToken = B.newLinkToken();
const link = new B.LinkServer({ token: linkToken });
const linkPort = await link.listen();
const script = join(repo, 'packages/bridge/dist/claude-reader.mjs');
const app = await B.startApp({
  appHome, home, link, port: 0, serve: { host: SERVE, login: OWNER }, tailscale: 'tailscale', funnelCheckMs: 600_000,
  claude: { script, sha256: sha(readFileSync(script)) },
});
note({ listening: app.port });

// The link mod: host state with Agent 1 (Claude) at t1 and Agent 2 (Codex) at t2.
const mod = net.connect(linkPort, '127.0.0.1');
await new Promise((r, j) => mod.once('connect', r).once('error', j));
mod.write(`${JSON.stringify({ type: 'hello', v: 1, token: linkToken, copy: 'link', layout: 'herdr-remote', app: { version: 'rig' } })}\n`);
const host = {
  spaces: [{ id: 'space-1', name: 'Project Alpha', focused: true }],
  agents: [
    { id: 'agent-1', name: 'Agent 1', harness: 'claude', program: 'claude', state: 'working', space_id: 'space-1', terminal_id: 't1' },
    { id: 'agent-2', name: 'Agent 2', harness: 'codex', program: 'codex', state: 'idle', space_id: 'space-1', terminal_id: 't2' },
  ],
  terminals: [], panes: [], focused: { space_id: 'space-1', pane_id: null, agent_id: null }, theme: { name: 'Theme 1', mode: 'dark' },
  layout_name: 'herdr-remote', shared: { 'panorama.feed.owner': 'owner-1' },
};
await sleep(200);
mod.write(`${JSON.stringify({ type: 'state', seq: 1, host })}\n`);

const activity = () => app.security.activity(1000).map(e => e.text);
const get = path => new Promise((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port: app.port, method: 'GET', path, setHost: false, headers: { Host: SERVE, 'Tailscale-User-Login': OWNER, 'X-Remote-Api': '1', Cookie: `${B.DEVICE_COOKIE}=${token}` } }, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', reject);
  r.end();
});

try {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { Host: SERVE, 'Tailscale-User-Login': OWNER, Origin: ORIGIN, Cookie: `${B.DEVICE_COOKIE}=${token}` } });
  const frames = [];
  const waiters = [];
  ws.on('message', m => { frames.push(JSON.parse(m.toString())); for (const w of waiters) w(); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const until = (pred, from = 0, ms = 15_000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(frames.slice(from).map(f => [f.type, f.topic, f.data?.state, f.data?.reason]))}`)), ms);
    const c = () => { const v = frames.slice(from).find(pred); if (v) { clearTimeout(t); res(v); } };
    waiters.push(c);
    c();
  });
  const send = m => ws.send(JSON.stringify(m));
  /** The topic's value as the phone holds it, from its snap and the patches after it. */
  const held = topic => {
    let v;
    for (const f of frames) {
      if (f.topic !== topic) continue;
      if (f.type === 'snap') v = f.data;
      else if (f.type === 'patch') v = B.applyPatch(v, f.ops);
    }
    return v;
  };
  send({ type: 'hello', api: 1 });
  await until(m => m.type === 'welcome');

  // 1. Off: refused, the reader never starts.
  send({ type: 'sub', topics: ['chatview:t1'] });
  const st = await until(m => m.type === 'stale' && m.topic === 'chatview:t1');
  check('chat history off: chatview:t1 is stale forbidden', st.reason === 'forbidden', st);

  // 2. On: the real reader reads the fixture session, bound through the feed.
  app.security.setCap(ID, 'transcript.read', true);
  let mark = frames.length;
  send({ type: 'sub', topics: ['chatview:t1'] });
  const snap = await until(m => m.type === 'snap' && m.topic === 'chatview:t1' && m.data.state === 'ok', mark);
  check('the snap validates against the protocol', bridgeApi.ServerMessage.safeParse(snap).success);
  const fixture = JSON.parse(readFileSync(join(repo, 'fixtures/bridge-api/chatview/typical.json'), 'utf8'));
  check('the items are the fixture session mapped (§3)', JSON.stringify(snap.data.items) === JSON.stringify(fixture.items), snap.data.items.map(i => i.role));
  check('the status line is the host agent status (working)', snap.data.status.state === 'working' && snap.data.status.since === '2026-01-02T10:01:15.000Z', snap.data.status);
  check('Activity: Phone 1 opened the chat of t1', activity().includes('Phone 1 opened the chat of t1'), activity().slice(-3));
  const leaks = [transcript, home, S1, 'claude-agent-1', 'Fake thinking', 'Fake test output', 'Fake summary'];
  check('nothing names where the history lives (path, config dir, session id), nor thinking or tool output', !leaks.some(s => JSON.stringify(frames).includes(s)));

  // 3. A new line in the transcript: a patch within a few seconds.
  mark = frames.length;
  const last = JSON.parse(lines.at(-1));
  const next = { ...last, parentUuid: last.uuid, uuid: 'a1000000-0000-4000-8000-000000000030', timestamp: '2026-01-02T10:02:00.000Z', type: 'user', message: { role: 'user', content: 'Thanks, Agent 1. My key is sk-ant-api03-FAKEFAKEFAKEFAKEFAKE.' } };
  delete next.requestId;
  writeFileSync(transcript, `${[...lines, JSON.stringify(next)].join('\n')}\n`);
  await until(m => m.type === 'patch' && m.topic === 'chatview:t1', mark);
  const now1 = held('chatview:t1');
  check('a new message arrives as a patch', now1.items.at(-1)?.text === 'Thanks, Agent 1. My key is [hidden].', now1.items.at(-1));
  check('the secret shape was redacted before it left', !JSON.stringify(frames).includes('FAKEFAKEFAKE'));

  // 4. Older pages: before the second item, one item; by count in Activity.
  const page = await get(`/api/v1/chatview/t1?before=${now1.items[1].id}&n=50&rev=${now1.rev}`);
  const body = JSON.parse(page.body);
  check('GET /api/v1/chatview/t1 returns the page', page.status === 200 && bridgeApi.ChatviewPage.safeParse(body).success && body.items.length === 1 && body.older === false, page);
  check('Activity: Phone 1 loaded 1 earlier message of t1', activity().includes('Phone 1 loaded 1 earlier message of t1'));
  check('Activity never holds chat text', !JSON.stringify(app.security.activity(1000)).includes('Agent 1.'));

  // 5. A Codex pane: no chat view (harness), and no reader for it.
  mark = frames.length;
  send({ type: 'sub', topics: ['chatview:t2'] });
  const codex = await until(m => m.type === 'snap' && m.topic === 'chatview:t2', mark);
  check('a Codex pane is unavailable: harness', codex.data.state === 'unavailable' && codex.data.reason === 'harness' && codex.data.harness === 'codex', codex.data);

  // 6. The feed ages (its writer stopped): the chat is hidden, not guessed.
  mark = frames.length;
  clearInterval(feedTimer);
  feedAge = 60;
  writeFeed();
  await until(m => m.topic === 'chatview:t1' && (m.type === 'snap' || m.type === 'patch') && held('chatview:t1')?.state === 'unavailable', mark);
  const aged = held('chatview:t1');
  check('an aged feed hides the chat: unavailable no_binding, no items', aged.reason === 'no_binding' && aged.items.length === 0, aged);

  // 7. Chat history off: the open chat view ends.
  mark = frames.length;
  app.security.setCap(ID, 'transcript.read', false);
  const end = await until(m => m.type === 'stale' && m.topic === 'chatview:t1', mark);
  check('turning chat history off ends it (stale forbidden)', end.reason === 'forbidden');
  check('the page route refuses it now (403)', (await get(`/api/v1/chatview/t1?before=${now1.items[1].id}`)).status === 403);
  ws.close();
} catch (e) {
  check('harness ran to the end', false, String(e?.message ?? e));
} finally {
  clearInterval(feedTimer);
  mod.destroy();
  await app.stop();
  await link.close();
}
note({ done: true, fails });
process.exit(fails ? 1 : 0);
