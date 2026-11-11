// Rig harness for the inbox answer path (S11): pairing, an inbox answer through a STUB launcher, and the audit
// entry, over the bridge's real HTTP + WebSocket server on loopback inside the rig's net namespace. The real
// herdr-inbox binary is never run: the "plugin root" is a stub whose scripts/launch only logs and replies.
// The plugin's pure JS (feed.js, commands.js, words.js) is taken from a sibling herdr-inbox checkout when
// one is there (read-only), else from minimal stand-ins. Fake data only. Every check is one JSON line in <log>.
//   node inbox-harness.mjs <repo root> <app home> <rig dir> <log>
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, appHome, rig, log] = process.argv;
const note = o => appendFileSync(log, `${JSON.stringify(o)}\n`);
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails += 1;
  note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
};
const bridge = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const WebSocket = createRequire(join(repo, 'packages/bridge/package.json'))('ws');

// ---- the stub plugin: install record, pinned JS, a launcher that never runs herdr-inbox ----
const put = (p, text) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const sha = t => createHash('sha256').update(t).digest('hex');
const sibling = [join(repo, '../herdr-inbox'), join(repo, '../../herdr-inbox')].map(r => join(r, 'app/mods/herdr-inbox')).find(d => existsSync(join(d, 'commands.js')));
const STANDIN = {
  'feed.js': `export function parseFeed(t){let f;try{f=JSON.parse(t)}catch{return{problem:'unreadable',errors:[]}}return f&&f.v===1&&f.ok===true?{feed:f}:{problem:'unsupported',errors:[]}}
export const isStale=(g,n)=>typeof g!=='number'||g>n||n-g>15;export const leftOut=f=>0;export const incompleteness=f=>null;`,
  'commands.js': `export const showArgs=q=>['app','show','--question',String(q),'--json'];
export function verbArgs({verb,entry,qids=[],detail,clear=false},token){if(!token)return null;const h=['app',verb,'--entry',entry,'--token',token,...qids.flatMap(q=>['--question',String(q)])];if(clear)return[...h,'--clear','--json'];return detail?[...h,'--detail',JSON.stringify({choices:detail.choices,notes:detail.notes,text:detail.text}),'--json']:[...h,'--json']}
export function readResult(r,verb,entry){if(r===null)return{kind:'unknown',why:'not started'};if(r.code===2)return{kind:'refused',code:'error',closed:null,message:''};if(r.code!==0&&r.code!==1)return{kind:'unknown',why:'exit '+r.code};let v;try{v=JSON.parse(r.stdout)}catch{return{kind:'unknown',why:'not a result'}}if(!v||v.v!==1||v.verb!==verb||(entry!==null&&v.entry!==entry))return{kind:'unknown',why:'not a result'};if(r.code===0&&v.ok===true)return verb==='show'?{kind:'shown',row:v.row}:{kind:'done',token:v.token,done:v.done,skipped:v.skipped,delivery:v.delivery};if(r.code===1&&v.ok===false)return{kind:'refused',code:v.code,closed:v.closed??null,message:v.message??''};return{kind:'unknown',why:'disagree'}}`,
  'words.js': `export const deliveryWords=r=>({warn:true,line:'waits'});export const knownDelivery=()=>true;export const retryLabel=()=>'Retry delivery';export const severity=w=>w;export const alertKind=w=>w==='blocked'?w:'agent';
export const refusalWords=(v,{code,closed})=>code==='stale'?(closed?'it was '+closed:'changed'):'refused '+code;export const unknownWords=w=>'The result is unknown ('+w+')';export const heldWords=(v,d)=>'held';export const queuedWords=d=>'Sending '+d.map(x=>'Q'+x).join(', ');export const skippedWords=s=>'skipped';`,
};
const root = join(rig, 'stub-inbox');
const receipt = {};
for (const n of ['feed.js', 'commands.js', 'words.js']) {
  const text = sibling ? readFileSync(join(sibling, n), 'utf8') : STANDIN[n];
  put(join(appHome, 'mods/herdr-inbox', n), text);
  receipt[`mods/herdr-inbox/${n}`] = sha(text);
}
note({ plugin_js: sibling ? 'sibling checkout (read-only copy)' : 'stand-ins' });
put(join(appHome, 'data/herdr-inbox/install.json'), JSON.stringify({ v: 1, plugin_root: root, plugin_moves: false, claude_config: null, dirs: [], files: receipt }));
put(join(root, 'herdr-plugin.toml'), "name = 'stub'\n");
put(join(root, 'scripts/launch'), `#!/bin/sh
# STUB herdr-inbox launcher: logs its arguments and prints canned results. It never runs herdr-inbox.
shift
echo "$*" >> "${rig}/stub-calls.log"
case "$1 $2" in
  "app --help") echo "herdr-inbox app v1"; exit 0;;
  "app-feed --ensure") exit 0;;
  "app answer") echo '{"v":1,"ok":true,"verb":"answer","entry":"group:127","token":null,"done":[127],"skipped":[],"delivery":"queued"}'; exit 0;;
  "app ack") echo 'garbage, not a result'; exit 0;;
esac
exit 2
`);
chmodSync(join(root, 'scripts/launch'), 0o755);
const stubCalls = () => (existsSync(join(rig, 'stub-calls.log')) ? readFileSync(join(rig, 'stub-calls.log'), 'utf8').split('\n').filter(Boolean) : []);
const verbCalls = () => stubCalls().filter(c => /^app (answer|draft|dismiss|retry|stop-showing|ack) /.test(c));

const asker = { host: 'herdr-core', pane: null, terminal: 't1', tab_label: null, cwd: '/work/project-alpha' };
const opt = label => ({ label, description: null, preview: null });
const feed = () => ({
  v: 1, generated_at: Date.now() / 1000, ok: true, errors: [],
  omitted: { groups: 0, questions: 0, failed: 0, alerts: 0, remote: 0, question_ids: [] },
  new_since: { question_id: 200, alert_id: 500 },
  entries: [
    { key: 'alert:456', kind: 'alert', token: 'tok-alert-456', actions: ['ack'], id: 456, alert_kind: 'agent', severity: 'warning', title: 'Alert Title 456', message: null, asked_by: 'agent-3', created_at: '2026-01-01T00:00:00+00:00', asker },
    { key: 'group:127', kind: 'group', token: 'tok-group-127', actions: ['answer', 'draft', 'dismiss'], group: 127, title: 'Question Title 127', created_at: '2026-01-01T00:00:00+00:00', asker,
      questions: [{ id: 127, header: 'Choice', question: 'Question Text 127', options: [opt('Option A'), opt('Option B')], multi_select: false, context: null, asked_by: 'agent-1', draft: null, cut: false }] },
  ],
});
const feedPath = join(appHome, 'data/herdr-inbox/feed.json');
put(feedPath, JSON.stringify(feed()));
const feedTimer = setInterval(() => put(feedPath, JSON.stringify(feed())), 2000);

// ---- the bridge: security, hub, inbox driver, server ----
const SERVE = 'desk-1.example-tailnet.ts.net';
const OWNER = 'user-1@example';
const ORIGIN = `https://${SERVE}`;
const dataDir = join(rig, 'bridge-data');
const ref = {};
const sec = new bridge.Security({ dataDir, serve: { host: SERVE, login: OWNER }, inner: async (_c, kind, args) => (await ref.d?.act(kind, args)) ?? { ok: false, code: 'unsupported_action' } });
const hub = new bridge.Hub({ bridgeVersion: 'rig', onAct: sec.act });
const d = (ref.d = new bridge.InboxTopicDriver({ hub, appHome, run: bridge.run, intervalMs: 500 }));
await d.start();
const srv = bridge.createBridgeServer({ hub, guard: sec.guard, routes: sec.routes, onConnect: sec.onConnect });
const { port } = await srv.listen();
note({ listening: port });

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
  // Pairing: code -> pending device -> desktop approval.
  const { code } = sec.issueCode();
  const paired = await post('/api/v1/pair', { code, name: 'Phone 1' });
  check('pairing request accepted', paired.status === 202, paired.status);
  const id = JSON.parse(paired.body).device.id;
  sec.approve(id);
  check('device approved', sec.devices().some(x => x.id === id && x.state === 'approved'));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, ['herdr-remote.v1'], { headers: { Host: SERVE, 'Tailscale-User-Login': OWNER, Origin: ORIGIN, Cookie: paired.cookie } });
  const frames = [];
  const waiters = [];
  ws.on('message', m => {
    frames.push(m.toString());
    for (const w of waiters) w();
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const until = (pred, ms = 15000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    const c = () => { const v = pred(); if (v) { clearTimeout(t); res(v); } };
    waiters.push(c);
    c();
  });
  const msgs = () => frames.map(f => JSON.parse(f));
  ws.send(JSON.stringify({ type: 'hello', api: 1 }));
  ws.send(JSON.stringify({ type: 'sub', topics: ['inbox'] }));
  const snap = await until(() => msgs().find(m => m.type === 'snap' && m.topic === 'inbox' && m.data.state === 'ok'));
  const rowOf = key => snap.data.entries.find(e => e.key === key);
  check('inbox snapshot has the group and the alert', !!rowOf('group:127') && !!rowOf('alert:456'));
  let n = 0;
  const act = async (kind, args) => {
    const aid = `rig-${++n}`;
    ws.send(JSON.stringify({ type: 'act', id: aid, kind, args }));
    return until(() => msgs().find(m => m.type === 'res' && m.id === aid));
  };

  // A rev the bridge did not publish: refused before the launcher.
  const stale = await act('inbox.answer', { key: 'group:127', rev: 'not-the-rev', question: 127, detail: { choices: [1], notes: {}, text: null } });
  check('a foreign rev is refused as stale', stale.ok === false && stale.code === 'stale', stale);
  check('nothing reached the stub for it', verbCalls().length === 0, verbCalls());

  // The answer: option index 1 and a note; the bridge resolves "Option B" from its own row.
  const ans = await act('inbox.answer', { key: 'group:127', rev: rowOf('group:127').rev, question: 127, detail: { choices: [1], notes: { 1: 'secret note words' }, text: null } });
  check('answer res ok, row closed', ans.ok === true && ans.closed === 'answered', ans);
  const calls = verbCalls();
  check('one answer reached the stub launcher', calls.length === 1, calls);
  check('it carried the bridge-held token and the bridge-resolved label', calls[0] === 'app answer --entry group:127 --token tok-group-127 --question 127 --detail {"choices":["Option B"],"notes":{"Option B":"secret note words"},"text":null} --json', calls[0]);

  // Unknown effect: the stub prints no result. Said once, not repeated.
  const unk = await act('inbox.ack', { key: 'alert:456', rev: rowOf('alert:456').rev });
  check('ack with bad stdout is an unknown effect', unk.ok === false && unk.unknown_effect === true, unk);
  check('the ack ran once', verbCalls().filter(c => c.startsWith('app ack')).length === 1);

  // Capability off: refused and logged, nothing runs.
  sec.setCap(id, 'inbox.answer', false);
  const forb = await act('inbox.dismiss', { key: 'alert:456', rev: rowOf('alert:456').rev });
  check('inbox.answer off: forbidden', forb.ok === false && forb.code === 'forbidden', forb);
  check('no verb ran for it', verbCalls().length === 2, verbCalls());

  check('no token in any frame the phone got', !frames.join('\n').includes('tok-'));
  check('no option label or note in any res', !msgs().filter(m => m.type === 'res').some(m => JSON.stringify(m).includes('Option') || JSON.stringify(m).includes('secret')));
  ws.close();

  const activity = readFileSync(join(dataDir, 'activity.jsonl'), 'utf8');
  appendFileSync(join(rig, 'activity-copy.jsonl'), activity);
  check('audit: answer with the bridge-resolved label', activity.includes('Phone 1 answered Q127 (Option B)'));
  check('audit: unknown effect recorded', activity.includes('Phone 1 acknowledged A456: result unknown'));
  check('audit: refusal recorded', activity.includes('Phone 1 dismissed A456: refused'));
  check('audit: no free text', !activity.includes('secret note'));
} catch (e) {
  check('harness ran to the end', false, String(e));
} finally {
  clearInterval(feedTimer);
  d.stop();
  await srv.close();
  note({ done: true, fails });
}
process.exit(fails === 0 ? 0 : 1);
