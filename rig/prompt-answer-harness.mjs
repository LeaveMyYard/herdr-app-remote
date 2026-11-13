// Rig harness for CV7: the bridge's real `prompt.answer` actor (packages/bridge/dist, prompt/answer.ts) pressing the
// real `claude` binary's prompts in the rig's own hc terminals, against the scripted fake Anthropic API on the rig
// loopback (fake-anthropic.mjs, the H0 scripts). No credentials, no network, a private HOME. Fake data only.
//
// T comes from the session's transcript on disk (pending tool_use without tool_result), V from `hc read`; S is taken as
// `blocked` while the screen shows the prompt (the host topic's state is covered by the bridge's unit tests). Each
// case: the card is matched, a stale rev is refused with nothing pressed, then the real answer runs and the
// tool_result in the transcript must say what was chosen. It also checks that `hc send --force` still waits for an
// unfinished desk draft (S16's quiet rule), with a person typing through `hc attach` in a pty.
// Every check is one JSON line in <log>.
//   node prompt-answer-harness.mjs <repo root> <rig dir> <log> <fake api port> <pinned claude version>
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, rig, log, port, pinned] = process.argv;
const B = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const P = B.prompt;
const home = process.env.HOME;
const project = join(home, 'project');
const note = (o) => appendFileSync(log, `${JSON.stringify(o)}\n`);
const check = (name, ok, detail) => note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(project, { recursive: true });

const hc = (...a) => { const r = spawnSync('hc', a, { encoding: 'utf8' }); if (r.status !== 0) { note({ hcFailed: a, status: r.status, stderr: r.stderr.slice(0, 400) }); throw new Error(`hc ${a[0]} failed`); } return r.stdout; };
const read = (t) => hc('read', t, '--lines', String(P.PROMPT_READ_LINES));
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

/** Every transcript line on disk, parsed (the harness's own read: the bridge never parses transcripts). */
const transcriptLines = () => {
  const base = join(home, '.claude/projects');
  if (!existsSync(base)) return [];
  const lines = [];
  for (const d of readdirSync(base)) for (const f of readdirSync(join(base, d))) if (f.endsWith('.jsonl')) {
    for (const l of readFileSync(join(base, d, f), 'utf8').split('\n')) { try { lines.push(JSON.parse(l)); } catch { /* partial line */ } }
  }
  return lines;
};
/** T: top-level tool calls with no result. */
const pending = () => {
  const open = new Map();
  for (const l of transcriptLines()) {
    if (l.isSidechain) continue;
    const c = Array.isArray(l.message?.content) ? l.message.content : [];
    for (const b of c) {
      if (l.type === 'assistant' && b.type === 'tool_use') open.set(b.id, { id: b.id, name: b.name, input: b.input, at: null });
      if (l.type === 'user' && b.type === 'tool_result') open.delete(b.tool_use_id);
    }
  }
  return [...open.values()];
};
const resultOf = async (id) => {
  for (let i = 0; i < 40; i++) {
    for (const l of transcriptLines()) for (const b of (Array.isArray(l.message?.content) ? l.message.content : [])) {
      if (b.type === 'tool_result' && b.tool_use_id === id) return typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
    }
    await sleep(250);
  }
  return null;
};

const terms = [];
function launch(args) {
  const t = JSON.parse(hc('run', '--bg', '--cwd', project, join(rig, 'bin/launch-claude.sh'), ...args)).address;
  terms.push(t);
  return t;
}
async function untilScreen(t, marker, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = read(t); if (marker.test(s)) return s; await sleep(250); }
  return read(t);
}

/** Every argv the actor ran. */
const calls = [];
const run = (cmd, args, o) => { calls.push(args); return B.run(cmd, args, o); };
const client = { principal: { deviceId: 'd-0000000000000001' }, send: () => undefined, close: () => undefined };

/** Opens a prompt in a fresh claude, returns the terminal, the card and an actor bound to it. */
async function prompt(name, args, trigger, marker) {
  const t = launch(args);
  await untilScreen(t, /^❯/m, 20000);
  await sleep(1000);
  hc('send', t, trigger);
  await untilScreen(t, marker);
  await sleep(700);
  const T = pending();
  const m = P.matchPrompt(T, read(t));
  let pub = { match: m, rev: 'rev-1' };
  const source = { current: () => pub, fresh: async () => ({ pending: pending(), blocked: true }), answered: () => { pub = undefined; } };
  const actor = P.promptAnswerActor({ run, source, binaries: { hc: 'hc' } });
  const answer = (choice, rev = 'rev-1') => actor(client, 'prompt.answer', { terminal: t, prompt_id: m.promptId, rev, choice });
  return { t, m, answer, toolUseId: m.toolUseId };
}

/** A stale rev is refused and presses nothing. */
async function stale(name, p, choice) {
  const before = calls.length;
  const r = await p.answer(choice, 'rev-0');
  check(`${name}: a stale rev is refused (prompt_changed) and runs nothing`, r.code === 'prompt_changed' && calls.length === before, r);
}
const forcedSince = (i) => calls.slice(i).filter((a) => a.includes('--force'));

// ---- permission: "No" (option 4), arrows then Enter ----
{
  const p = await prompt('permission', ['--permission-mode', 'default'], 'H0-PERM please', /Do you want to proceed\?/);
  check('permission: T + V match a permission card with the screen labels', p.m.kind === 'permission' && p.m.card.options.length === 4, p.m.card);
  await stale('permission', p, { option: 3 });
  const i = calls.length;
  const r = await p.answer({ option: 3 });
  check('permission: answered (ok) with Activity words from the screen', r.ok === true && r.audit_label === 'a permission prompt\noption 4 of 4 (No)', r);
  const keys = calls.slice(i).filter((a) => a[0] === 'keys').map((a) => a.slice(4));
  check('permission: phase A arrows only, then Enter alone', JSON.stringify(keys) === JSON.stringify([['down', 'down', 'down'], ['enter']]), keys);
  const tr = await resultOf(p.toolUseId);
  check('permission: the call was refused by the person (tool_result)', tr !== null && !/cargo test.*passed/.test(tr), tr?.slice(0, 200));
  check('permission: no --force', forcedSince(i).length === 0);
}
// ---- AskUserQuestion single: an option ----
{
  const p = await prompt('ask-single', ['--permission-mode', 'default'], 'H0-ASK1 please', /Question Title 123/);
  check('ask-single: a question card', p.m.kind === 'question' && p.m.otherRow === 3, p.m.card);
  await stale('ask-single', p, { option: 1 });
  const i = calls.length;
  const r = await p.answer({ option: 1 });
  check('ask-single: answered (ok)', r.ok === true, r);
  const tr = await resultOf(p.toolUseId);
  check('ask-single: the answer is Option B', tr !== null && tr.includes('Option B') && !tr.includes('Option A'), tr?.slice(0, 200));
  check('ask-single: no --force', forcedSince(i).length === 0);
}
// ---- AskUserQuestion single: Other, the one forced send ----
{
  const p = await prompt('ask-other', ['--permission-mode', 'default'], 'H0-ASK1 please', /Question Title 123/);
  const i = calls.length;
  const started = Date.now();
  const r = await p.answer({ other: 'Project Alpha answer 2' });
  check('ask-other: answered (ok)', r.ok === true, r);
  const tr = await resultOf(p.toolUseId);
  check('ask-other: the answer is the Other text', tr !== null && tr.includes('Project Alpha answer 2'), tr?.slice(0, 200));
  const forced = forcedSince(i);
  check('ask-other: exactly one --force, the send of the Other text after the cursor reached Other', forced.length === 1 && forced[0].join(' ') === `send --json --force -- ${p.t} Project Alpha answer 2`, forced);
  note({ otherAnswerMs: Date.now() - started });
}
// ---- AskUserQuestion multi: picks, Submit, review, confirm ----
{
  const p = await prompt('ask-multi', ['--permission-mode', 'default'], 'H0-ASKM please', /Question Title 123/);
  check('ask-multi: a multi-select card without Other', p.m.kind === 'question' && p.m.multi === true && p.m.otherRow === null, p.m.card);
  await stale('ask-multi', p, { picks: [0, 2] });
  const r0 = await p.answer({ other: 'x' });
  check('ask-multi: Other is refused on a multi-select (not recorded)', r0.code === 'bad_choice', r0);
  const i = calls.length;
  const r = await p.answer({ picks: [0, 2] });
  check('ask-multi: answered (ok)', r.ok === true, r);
  const tr = await resultOf(p.toolUseId);
  check('ask-multi: the answer is Lint and Unit tests only', tr !== null && /Lint/.test(tr) && /Unit tests/.test(tr) && !/Typecheck/.test(tr), tr?.slice(0, 200));
  check('ask-multi: no --force', forcedSince(i).length === 0);
}
// ---- plan: the second option ----
{
  const p = await prompt('plan', ['--permission-mode', 'plan'], 'H0-PLAN please', /Would you like to proceed\?/);
  check('plan: a plan card', p.m.kind === 'plan', p.m.card);
  const i = calls.length;
  const r = await p.answer({ option: 1 });
  check('plan: answered (ok)', r.ok === true, r);
  const tr = await resultOf(p.toolUseId);
  check('plan: the plan was approved (tool_result)', tr !== null, tr?.slice(0, 200));
  check('plan: no --force', forcedSince(i).length === 0);
}
// ---- the desk moved the cursor after the card was shown: the arrows start from where the cursor is now ----
{
  const p = await prompt('moved', ['--permission-mode', 'default'], 'H0-ASK1 please', /Question Title 123/);
  hc('keys', p.t, 'down', 'down');
  await sleep(500);
  const i = calls.length;
  const r = await p.answer({ option: 0 });
  const keys = calls.slice(i).filter((a) => a[0] === 'keys').map((a) => a.slice(4));
  check('moved: answered (ok), pressing up twice from the moved cursor', r.ok === true && JSON.stringify(keys) === JSON.stringify([['up', 'up'], ['enter']]), { r, keys });
  const tr = await resultOf(p.toolUseId);
  check('moved: the answer is Option A', tr !== null && tr.includes('Option A'), tr?.slice(0, 200));
}
// ---- answered at the desk first (R3): prompt_gone, nothing pressed ----
{
  const p = await prompt('desk-first', ['--permission-mode', 'default'], 'H0-ASK1 please', /Question Title 123/);
  hc('keys', p.t, 'enter');
  await resultOf(p.toolUseId);
  await sleep(500);
  const i = calls.length;
  const r = await p.answer({ option: 1 });
  check('desk-first: refused as already answered (prompt_gone or prompt_changed), no key pressed', (r.code === 'prompt_gone' || r.code === 'prompt_changed') && !calls.slice(i).some((a) => a[0] === 'keys' || a[0] === 'send'), { r, calls: calls.slice(i) });
}
// ---- hc send --force still waits for an unfinished desk draft (S16's quiet rule) ----
{
  const p = await prompt('draft', ['--permission-mode', 'default'], 'H0-ASK1 please', /Question Title 123/);
  hc('keys', p.t, 'down', 'down', 'down');
  await sleep(500);
  // A person at the desk: `hc attach` in a pty, typing a few characters and then nothing.
  const desk = spawn('script', ['-qfec', `hc attach ${p.t}`, '/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await sleep(1500);
  desk.stdin.write('ab');
  await sleep(100);
  const started = Date.now();
  const r = spawnSync('hc', ['send', '--json', '--force', '--', p.t, 'Project Alpha answer 3'], { encoding: 'utf8' });
  const ms = Date.now() - started;
  check('draft: hc send --force waited for the desk to go quiet (over 2 s after the last key)', r.status === 0 && ms >= 2000, { ms, status: r.status, stderr: r.stderr.slice(0, 200) });
  desk.stdin.write('\u001c');
  await sleep(300);
  try { process.kill(desk.pid); } catch { /* exited */ }
  const tr = await resultOf(p.toolUseId);
  note({ draftResult: tr?.slice(0, 200) ?? null, draftWaitMs: ms });
}
// ---- the same, with hc killed at the bridge's 15 s press timeout: does the held send still land later? ----
{
  const p = await prompt('draft-killed', ['--permission-mode', 'default'], 'H0-ASK1 please', /Question Title 123/);
  hc('keys', p.t, 'down', 'down', 'down');
  await sleep(500);
  const desk = spawn('script', ['-qfec', `hc attach ${p.t}`, '/dev/null'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await sleep(1500);
  desk.stdin.write('cd');
  await sleep(100);
  // The bridge's runner: TERM at the timeout, KILL half a second later.
  const r = await B.run('hc', ['send', '--json', '--force', '--', p.t, 'Project Alpha answer 4'], { timeoutMs: 15_000 });
  check('draft-killed: the bridge gives up on a send held by a draft at 15 s (timeout: unknown effect)', r.error === 'timeout', r);
  await sleep(60_000);
  desk.stdin.write('\u001c');
  await sleep(300);
  try { process.kill(desk.pid); } catch { /* exited */ }
  let landed = null;
  for (const l of transcriptLines()) for (const b of (Array.isArray(l.message?.content) ? l.message.content : [])) {
    if (b.type === 'tool_result' && b.tool_use_id === p.toolUseId) landed = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
  }
  // Recorded, not judged: whether a killed hc send still reaches the terminal once the draft wait ends.
  note({ killedSendLanded: landed !== null && landed.includes('Project Alpha answer 4'), killedSendResult: landed?.slice(0, 200) ?? null, screen: read(p.t).split('\n').slice(-12) });
}
for (const t of terms) { try { hc('kill', t); } catch { /* already gone */ } }
note({ done: true });
