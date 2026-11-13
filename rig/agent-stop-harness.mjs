// Rig harness for CV8 (Stop). Part 1 records what Esc does in the pinned `claude` (fixtures/claude-prompts/<version>/
// stop-*.txt and the manifest's `stop` section): while it streams a reply, while it runs a long tool, while idle,
// twice in a row, and on a permission prompt (where Esc cancels the prompt). Part 2 runs the bridge's real
// `agent.stop` actor (packages/bridge/dist, prompt/stop.ts) against those states, with S taken from herdr-core itself
// (`hc get`: status.state), and reads the session back through the pinned SDK and the bridge's own mapping.
// The real claude binary in the rig's own hc terminals, the scripted fake Anthropic API on the rig loopback
// (fake-anthropic.mjs: "H0-SLOW", "H0-TOOL", "H0-PERM"), a private HOME, no network, no credentials. Fake data only.
// Every check is one JSON line in <log>.
//   node agent-stop-harness.mjs <repo root> <rig dir> <out dir> <log> <fake api port> <pinned claude version>
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, rig, out, log, port, pinned] = process.argv;
const B = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const P = B.prompt;
const sdk = await import(pathToFileURL(createRequire(join(repo, 'packages/bridge/package.json')).resolve('@anthropic-ai/claude-agent-sdk')).href);
const home = process.env.HOME;
const project = join(home, 'project');
const note = (o) => appendFileSync(log, `${JSON.stringify(o)}\n`);
const check = (name, ok, detail) => note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
mkdirSync(project, { recursive: true });

const hc = (...a) => { const r = spawnSync('hc', a, { encoding: 'utf8' }); if (r.status !== 0) { note({ hcFailed: a, status: r.status, stderr: r.stderr.slice(0, 400), stdout: r.stdout.slice(0, 400) }); throw new Error(`hc ${a[0]} failed`); } return r.stdout; };
const tidy = (s) => s.split('\n').filter((l) => !l.startsWith('[hc] ')).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '\n');
const read = (t) => tidy(hc('read', t, '--lines', '80'));
const keys = (t, ...k) => hc('keys', t, ...k);
/** S from herdr-core: the terminal's agent status (`working`, `blocked`, `idle`). */
const status = (t) => { try { return JSON.parse(hc('get', '--json', t)).status?.state ?? null; } catch { return null; } };
const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
check(`claude is the pinned version ${pinned}`, version.split(' ')[0] === pinned, version);
if (version.split(' ')[0] !== pinned) { note({ aborted: 'version is not the pin' }); process.exit(1); }

writeFileSync(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
  customApiKeyResponses: { approved: ['fakefakefakefakefake'], rejected: [] },
  projects: { [project]: { hasTrustDialogAccepted: true, allowedTools: [] } },
}));
writeFileSync(join(rig, 'bin/launch-claude.sh'), `#!/bin/sh
cd ${project}
export ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_API_KEY=fakekey-fakefakefakefakefake
export DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
exec claude "$@"
`, { mode: 0o755 });
writeFileSync(join(project, 'notes.txt'), 'Project Alpha notes\n');

/** The session file whose text holds `tag` (each case sends its own), as [session id, parsed lines]. */
function session(tag) {
  const base = join(home, '.claude/projects');
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) for (const f of readdirSync(join(base, d))) if (f.endsWith('.jsonl')) {
    const text = readFileSync(join(base, d, f), 'utf8');
    if (!text.includes(tag)) continue;
    const lines = [];
    for (const l of text.split('\n')) { try { lines.push(JSON.parse(l)); } catch { /* partial line */ } }
    return { id: f.slice(0, -'.jsonl'.length), lines };
  }
  return null;
}
/** User and assistant lines, reduced to what the manifest needs (no ids, paths, times or harness context). */
const shape = (l) => ({
  type: l.type,
  content: typeof l.message?.content === 'string' ? l.message.content : (l.message?.content ?? []).map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_result' ? { type: 'tool_result', is_error: b.is_error ?? false, content: b.content } : { type: b.type, ...(b.name ? { name: b.name } : {}) })),
  ...(typeof l.toolUseResult === 'string' ? { toolUseResult: l.toolUseResult } : {}),
});
/** The session's lines after its trigger message, user and assistant only. */
function after(tag) {
  const s = session(tag);
  if (!s) return [];
  const i = s.lines.findIndex((l) => l.type === 'user' && JSON.stringify(l.message?.content ?? '').includes(tag));
  return s.lines.slice(i + 1).filter((l) => (l.type === 'user' || l.type === 'assistant') && !l.isMeta).map(shape);
}
const interrupted = (lines) => lines.some((l) => l.type === 'user' && Array.isArray(l.content) && l.content.some((b) => b.type === 'text' && /^\[Request interrupted by user( for tool use)?\]$/.test(b.text)));

const terms = [];
function launch(args = []) {
  const t = JSON.parse(hc('run', '--bg', '--cwd', project, join(rig, 'bin/launch-claude.sh'), '--permission-mode', 'default', ...args)).address;
  terms.push(t);
  return t;
}
async function untilScreen(t, marker, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = read(t); if (marker.test(s)) return s; await sleep(250); }
  return read(t);
}
async function untilStatus(t, want, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (status(t) === want) return true; await sleep(250); }
  return false;
}
const save = (name, text) => writeFileSync(join(out, `${name}.txt`), text);
const ready = async (t) => { await untilScreen(t, /^❯/m, 20000); await sleep(1000); };
const WORKING = /esc to interrupt/;
/** A claude that is working: streaming a held reply ("H0-SLOW"), or running a long Bash call ("H0-TOOL"). */
async function working(kind, tag) {
  const t = kind === 'tool' ? launch(['--allowedTools', 'Bash(timeout 40 tail -f notes.txt)']) : launch();
  await ready(t);
  hc('send', t, `${kind === 'tool' ? 'H0-TOOL' : 'H0-SLOW'} please (${tag})`);
  await untilScreen(t, kind === 'tool' ? /tail -f[\s\S]*esc to interrupt/ : WORKING, 20000);
  await sleep(1500);
  return t;
}

// ---- part 1: recordings ----
const rec = {};
{
  const t = launch();
  await ready(t);
  save('stop-idle', read(t));
  rec.idleStatus = status(t);
  keys(t, 'esc');
  await sleep(800);
  save('stop-idle-after-esc', read(t));
  keys(t, 'esc', 'esc');
  await sleep(1000);
  save('stop-idle-after-double-esc', read(t));
}
{
  const t = await working('stream', 'rec-stream');
  save('stop-working-stream', read(t));
  rec.streamStatus = status(t);
  keys(t, 'esc');
  await sleep(2000);
  save('stop-stream-after-esc', read(t));
  rec.stream = after('rec-stream');
  // A second Esc, at once, now that it is idle with a history.
  keys(t, 'esc');
  await sleep(300);
  keys(t, 'esc');
  await sleep(1000);
  save('stop-after-stop-double-esc', read(t));
  keys(t, 'esc');
}
{
  const t = await working('tool', 'rec-tool');
  save('stop-working-tool', read(t));
  rec.toolStatus = status(t);
  keys(t, 'esc');
  await sleep(2000);
  save('stop-tool-after-esc', read(t));
  rec.tool = after('rec-tool');
}
{
  const t = launch();
  await ready(t);
  hc('send', t, 'H0-PERM please (rec-perm)');
  await untilScreen(t, /Do you want to proceed\?/, 20000);
  await sleep(700);
  rec.promptStatus = status(t);
  keys(t, 'esc');
  await sleep(1500);
  save('stop-permission-after-esc', read(t));
  rec.perm = after('rec-perm');
}
check('recorded: herdr-core says working while streaming and while a tool runs, blocked on a prompt, idle at rest', rec.streamStatus === 'working' && rec.toolStatus === 'working' && rec.promptStatus === 'blocked' && rec.idleStatus === 'idle', rec);
check('recorded: Esc while streaming writes "[Request interrupted by user]"', interrupted(rec.stream), rec.stream);
check('recorded: Esc while a tool runs rejects the call and writes the tool-use marker', interrupted(rec.tool) && rec.tool.some((l) => Array.isArray(l.content) && l.content.some((b) => b.type === 'tool_result' && b.is_error)), rec.tool);
check('recorded: Esc on a permission prompt cancels it (why Stop refuses on a prompt)', interrupted(rec.perm), rec.perm);
note({ rec });
for (const t of terms) { try { hc('kill', t); } catch { /* already gone */ } }
terms.length = 0;

// ---- part 2: the bridge's agent.stop actor ----
const calls = [];
const run = (cmd, args, o) => { calls.push(args); return B.run(cmd, args, o); };
const client = { principal: { deviceId: 'd-0000000000000001' }, send: () => undefined, close: () => undefined };
/** An actor whose S is herdr-core's own status, unless `lie` overrides it (to prove the screen check stands alone). */
function actorFor(lie = null, runner = run) {
  const source = {
    state: (t) => { const s = lie ?? status(t); return s === null ? null : { working: s === 'working', blocked: s === 'blocked' }; },
    hasCard: () => false,
  };
  return P.agentStopActor({ run: runner, source, locks: new P.TerminalLocks(), binaries: { hc: 'hc' } });
}
const since = (i) => calls.slice(i);
const pressedSince = (i) => since(i).filter((a) => a[0] !== 'read');
const noForce = (i) => !since(i).some((a) => a.includes('--force') || a[0] === 'send');

/** The session as the bridge maps it: the pinned SDK's getSessionMessages, then checkMessages and mapMessages. */
async function mapped(tag) {
  const s = session(tag);
  if (!s) return null;
  const raw = await sdk.getSessionMessages(s.id, { includeSystemMessages: true });
  const c = B.claude.checkMessages(raw);
  return c.ok ? B.chatview.mapMessages(c.messages) : null;
}

// A working agent (streaming): ok, Esc alone, the transcript says interrupted, the chat view shows "Stopped".
{
  const t = await working('stream', 'act-stream');
  const stop = actorFor();
  const i = calls.length;
  const r = await stop(client, 'agent.stop', { terminal: t });
  check('stream: Stop is ok', r.ok === true, r);
  check('stream: one hc keys, Esc alone, nothing else pressed or sent', JSON.stringify(pressedSince(i)) === JSON.stringify([['keys', '--json', '--', t, 'esc']]), pressedSince(i));
  check('stream: no --force, no hc send', noForce(i));
  // At once again: the cooldown refuses with nothing read or pressed.
  const j = calls.length;
  const r2 = await stop(client, 'agent.stop', { terminal: t });
  check('stream: a second Stop within 3 s is cooldown, nothing pressed', r2.code === 'cooldown' && since(j).length === 0, { r2, calls: since(j) });
  await sleep(1500);
  check('stream: the transcript says interrupted', interrupted(after('act-stream')), after('act-stream'));
  check('stream: herdr-core no longer says working', await untilStatus(t, 'idle', 5000), status(t));
  const items = await mapped('act-stream');
  const st = items?.filter((x) => x.role === 'status') ?? [];
  check('stream: the bridge maps the marker to one stopped status row, not a bubble', st.length === 1 && st[0].status === 'stopped' && st[0].at !== null && !items.some((x) => x.role === 'you' && /interrupted/.test(x.text)), items?.slice(-3));
  await sleep(3200);
  const k = calls.length;
  const r3 = await stop(client, 'agent.stop', { terminal: t });
  check('stream: after the cooldown, the stopped (idle) agent is not_working, nothing pressed', r3.code === 'not_working' && pressedSince(k).length === 0, { r3, calls: since(k) });
}
// A working agent (a long tool): ok, the call is rejected.
{
  const t = await working('tool', 'act-tool');
  const i = calls.length;
  const r = await actorFor()(client, 'agent.stop', { terminal: t });
  check('tool: Stop is ok', r.ok === true, r);
  check('tool: Esc alone', JSON.stringify(pressedSince(i)) === JSON.stringify([['keys', '--json', '--', t, 'esc']]), pressedSince(i));
  await sleep(1500);
  const tr = after('act-tool');
  check('tool: the Bash call got an error result and the turn was interrupted', interrupted(tr) && tr.some((l) => Array.isArray(l.content) && l.content.some((b) => b.type === 'tool_result' && b.is_error)), tr);
  check('tool: no --force, no hc send', noForce(i));
}
// Idle: refused with nothing pressed, by S, and by V alone when S is wrong.
{
  const t = launch();
  await ready(t);
  hc('send', t, 'hello (act-idle)');
  await sleep(3000);
  const before = read(t);
  const i = calls.length;
  const r = await actorFor()(client, 'agent.stop', { terminal: t });
  check('idle: not_working, nothing read or pressed (S says idle)', r.code === 'not_working' && since(i).length === 0, { r, calls: since(i) });
  const j = calls.length;
  const r2 = await actorFor('working')(client, 'agent.stop', { terminal: t });
  check('idle, S wrongly working: the screen has no "esc to interrupt": not_working, nothing pressed', r2.code === 'not_working' && pressedSince(j).length === 0, { r2, calls: since(j) });
  await sleep(500);
  check('idle: the screen did not change', read(t) === before);
}
// A permission prompt open: refused with nothing pressed, by S, and by V alone; the prompt is still there after.
{
  const t = launch();
  await ready(t);
  hc('send', t, 'H0-PERM please (act-perm)');
  await untilScreen(t, /Do you want to proceed\?/, 20000);
  await sleep(700);
  const i = calls.length;
  const r = await actorFor()(client, 'agent.stop', { terminal: t });
  check('prompt: prompt_open, nothing pressed (S says blocked)', r.code === 'prompt_open' && pressedSince(i).length === 0, { r, calls: since(i) });
  const j = calls.length;
  const r2 = await actorFor('working')(client, 'agent.stop', { terminal: t });
  check('prompt, S wrongly working: the screen shows a prompt block: prompt_open, nothing pressed', r2.code === 'prompt_open' && pressedSince(j).length === 0, { r2, calls: since(j) });
  await sleep(500);
  check('prompt: the dialog is still open, nothing answered or cancelled', /Do you want to proceed\?/.test(read(t)) && !interrupted(after('act-perm')));
  keys(t, 'esc');
}
// The desk types while hc holds the Esc (S16's quiet rule): never reported ok.
{
  const t = await working('stream', 'act-held');
  const desk = spawn('script', ['-qfec', `hc attach ${t}`, '/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await sleep(1500);
  let typed = false;
  const heldRun = async (cmd, args, o) => {
    if (!typed && args[0] === 'keys') {
      typed = true;
      desk.stdin.write('x');
      await sleep(80);
      desk.stdin.write('\u007f');
      await sleep(80);
    }
    return run(cmd, args, o);
  };
  const started = Date.now();
  const r = await actorFor(null, heldRun)(client, 'agent.stop', { terminal: t });
  check('held: Esc held by hc for the desk: unknown_effect with the held words, not ok', r.ok === false && r.unknown_effect === true && /held \d+ s while the desk was typing/.test(r.audit_label ?? ''), { r, ms: Date.now() - started });
  desk.stdin.write('\u001c');
  await sleep(300);
  try { process.kill(desk.pid); } catch { /* exited */ }
}
for (const t of terms) { try { hc('kill', t); } catch { /* already gone */ } }
check('no call in part 2 used --force or hc send', !calls.some((a) => a.includes('--force') || a[0] === 'send'));
note({ statSize: statSync(log).size });
note({ done: true });
