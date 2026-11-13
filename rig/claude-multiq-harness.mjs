// Rig harness for CV9 (H0 style): Claude Code's multi-question AskUserQuestion (the tabbed question UI), recorded from
// the real `claude` binary in the rig's own hc terminals against the scripted fake Anthropic API (fake-anthropic.mjs,
// "H0-ASKQ": three questions: single, multi-select, single). No credentials, no network, a private HOME. Fake data only.
// Every key press is followed by a screen written to <out>/<step>.txt; every check is one JSON line in <log>.
//   node claude-multiq-harness.mjs <rig dir> <out dir> <log> <fake api port> <pinned claude version>
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [, , rig, out, log, port, pinned] = process.argv;
const home = process.env.HOME;
const project = join(home, 'project');
const note = (o) => appendFileSync(log, `${JSON.stringify(o)}\n`);
const check = (name, ok, detail) => note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
mkdirSync(project, { recursive: true });

const hc = (...a) => { const r = spawnSync('hc', a, { encoding: 'utf8' }); if (r.status !== 0) { note({ hcFailed: a, status: r.status, stderr: r.stderr.slice(0, 400), stdout: r.stdout.slice(0, 400) }); throw new Error(`hc ${a[0]} failed`); } return r.stdout; };
const read = (t) => hc('read', t, '--lines', '80').split('\n').filter((l) => !l.startsWith('[hc] ')).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '\n');
const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
check(`claude is the pinned version ${pinned} (re-record the fixtures and move the pin together)`, version.split(' ')[0] === pinned, version);
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

const transcriptLines = () => {
  const base = join(home, '.claude/projects');
  if (!existsSync(base)) return [];
  const lines = [];
  for (const d of readdirSync(base)) for (const f of readdirSync(join(base, d))) if (f.endsWith('.jsonl')) {
    for (const l of readFileSync(join(base, d, f), 'utf8').split('\n')) { try { lines.push(JSON.parse(l)); } catch { /* partial line */ } }
  }
  return lines;
};
const pendingAsk = () => {
  const lines = transcriptLines();
  const done = new Set();
  for (const l of lines) for (const b of (Array.isArray(l.message?.content) ? l.message.content : [])) if (b.type === 'tool_result') done.add(b.tool_use_id);
  for (const l of lines) if (l.type === 'assistant') for (const b of l.message.content ?? []) if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && !done.has(b.id)) return b.id;
  return null;
};
async function resultOf(id, tries = 40) {
  for (let i = 0; i < tries; i++) {
    for (const l of transcriptLines()) for (const b of (Array.isArray(l.message?.content) ? l.message.content : [])) {
      if (b.type === 'tool_result' && b.tool_use_id === id) return typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
    }
    await sleep(250);
  }
  return null;
}
const terms = [];
async function open(trigger, title) {
  const t = JSON.parse(hc('run', '--bg', '--cwd', project, join(rig, 'bin/launch-claude.sh'), '--permission-mode', 'default')).address;
  terms.push(t);
  const end = Date.now() + 20000;
  while (Date.now() < end && !/^❯/m.test(read(t))) await sleep(250);
  await sleep(1000);
  hc('send', t, `${trigger} please`);
  const end2 = Date.now() + 30000;
  while (Date.now() < end2 && !title.test(read(t))) await sleep(250);
  await sleep(800);
  return { t, id: pendingAsk() };
}
/** The prompt block (from its tab line down), or the screen's last lines when there is none. */
const block = (screen) => {
  const lines = screen.split('\n');
  const i = lines.findLastIndex((l) => l.startsWith('←  '));
  return (i >= 0 ? lines.slice(i) : lines.slice(-12)).join('\n');
};
/** Presses (or the forced Other send), waits, saves the screen as <name>.txt when named. */
async function step(s, name, action, ms = 700) {
  if (action) action();
  await sleep(ms);
  const screen = read(s.t);
  if (name) writeFileSync(join(out, `${name}.txt`), screen);
  note({ step: name ?? '(unsaved)' });
  return block(screen);
}
const press = (s, ...k) => () => hc('keys', s.t, ...k);
const force = (s, text) => () => hc('send', '--force', s.t, text);
const Q1 = /Question Title 123/;
const Q2 = /Question Title 456/;
const Q3 = /Question Title 789/;
const REVIEW = /Review your answers[\s\S]*Ready to submit your answers\?[\s\S]*1\. Submit answers[\s\S]*2\. Cancel/;
const findings = {};

// ---- 1. tabs: right / left / tab / shift+tab move between the questions and the Submit tab; nothing is answered ----
{
  const s = await open('H0-ASKQ tabs', Q1);
  const b0 = await step(s, 'askq-q1');
  check('tabs: the tab line lists every header, all unanswered, and the Submit tab', /^←  ☐ Approach  ☐ Checks  ☐ Target  ✔ Submit  →$/m.test(b0) && Q1.test(b0), b0.slice(0, 300));
  const r1 = await step(s, 'askq-q2', press(s, 'right'));
  check('tabs: right shows question 2 (multi-select: boxes, then an unnumbered "Next" row)', Q2.test(r1) && /^ {5}Next$/m.test(r1) && /4\. \[ \] Type something$/m.test(r1), r1.slice(0, 600));
  const r2 = await step(s, null, press(s, 'right'));
  check('tabs: right again shows question 3', Q3.test(r2));
  const r3 = await step(s, 'askq-review-unanswered', press(s, 'right'));
  check('tabs: right on the last question shows the Submit tab, which warns that not every question is answered', REVIEW.test(r3) && /⚠ You have not answered all questions/.test(r3), r3);
  const r4 = await step(s, null, press(s, 'right'));
  check('tabs: right on the Submit tab stays there', REVIEW.test(r4));
  const l1 = await step(s, null, press(s, 'left'));
  check('tabs: left from the Submit tab shows question 3', Q3.test(l1));
  const t1 = await step(s, null, press(s, 'tab'));
  check('tabs: tab moves right like the right arrow', REVIEW.test(t1));
  const st = await step(s, null, press(s, 'shift+tab'));
  check('tabs: shift+tab moves left', Q3.test(st));
  await step(s, null, press(s, 'left'));
  const l3 = await step(s, null, press(s, 'left'));
  check('tabs: left twice more shows question 1', Q1.test(l3));
  const l4 = await step(s, null, press(s, 'left'));
  check('tabs: left on question 1 stays there (no wrap)', Q1.test(l4));
  findings.activeTab = 'the tab line does not show which tab is active in hc read (only the shown question text does): ☐ unanswered, ☒ answered (a multi-select tab turns ☒ with its first tick)';
  const x = await step(s, 'askq-q1-typed', press(s, 'x'));
  check('typing a letter with the cursor on an option row changes nothing', x === l4, x.slice(0, 600));
  findings.typing = 'a printable key on an option row changes nothing; the bridge never types except the confirmed Other send';
  const e = await step(s, 'askq-after-esc', press(s, 'esc'), 1500);
  check('tabs: Esc on question 1 cancels the whole prompt (no block left on screen)', !/Ready to submit|Question Title/.test(e), e);
  const r = await resultOf(s.id, 32);
  findings.esc = `Esc on a question cancels the whole AskUserQuestion: ${r === null ? 'no tool_result within 8 s' : 'the call gets a rejection result'}`;
  note({ escResult: r?.slice(0, 300) ?? null });
}
// ---- 2. answer: Enter on a single-select option, ticks and Enter on Next, Other on the last question, the review ----
{
  const s = await open('H0-ASKQ answer', Q1);
  const a = await step(s, 'askq-q1-on-option2', press(s, 'down'));
  check('answer: down moves the cursor to option 2 of question 1', /❯ 2\. Option B$/m.test(a));
  const b = await step(s, 'askq-q2-after-enter', press(s, 'enter'));
  check('answer: Enter on a single-select option picks it and shows the next question; its tab turns ☒', Q2.test(b) && /^←  ☒ Approach  ☐ Checks  ☐ Target  ✔ Submit  →$/m.test(b) && /❯ 1\. \[ \] Lint$/m.test(b), b.slice(0, 600));
  const c = await step(s, null, press(s, 'space'));
  check('answer: space ticks the row under the cursor and the multi-select tab turns ☒', /❯ 1\. \[✔\] Lint$/m.test(c) && /☒ Checks/.test(c));
  const d = await step(s, null, press(s, 'down', 'down'));
  const d2 = await step(s, 'askq-q2-ticked', press(s, 'space'));
  check('answer: down down space ticks row 3', /❯ 3\. \[✔\] Unit tests$/m.test(d2) && /1\. \[✔\] Lint$/m.test(d2) && /2\. \[ \] Typecheck$/m.test(d2), d);
  const e = await step(s, null, press(s, 'down'));
  check('answer: down from the last option goes to the Other row (a text field: the footer offers ctrl+g)', /❯ 4\. \[ \] Type something$/m.test(e));
  const f = await step(s, 'askq-q2-on-next', press(s, 'down'));
  check('answer: down again puts the cursor on the unnumbered Next row', /^❯ {4}Next$/m.test(f), f.slice(0, 700));
  const g = await step(s, 'askq-q3-after-next', press(s, 'enter'));
  check('answer: Enter on Next shows question 3; the ticks stay', Q3.test(g) && /☒ Approach  ☒ Checks  ☐ Target/.test(g), g.slice(0, 600));
  const h = await step(s, 'askq-q3-on-other', press(s, 'down', 'down'));
  check('answer: down down on question 3 puts the cursor on its Other row "Type something."', /❯ 3\. Type something\.$/m.test(h));
  const i = await step(s, 'askq-review', force(s, 'Project Alpha answer 3'), 1200);
  check('answer: the forced send on the last question\'s Other row picks the text and shows the review, listing each question and its answer', REVIEW.test(i) && /→ Option B\n[\s\S]*→ Lint, Unit tests\n[\s\S]*→ Project Alpha answer 3\n/.test(`${i}\n`) && !/⚠/.test(i), i);
  const j = await step(s, null, press(s, 'down'));
  check('answer: down on the review moves to Cancel', /❯ 2\. Cancel$/m.test(j));
  const k = await step(s, null, press(s, 'up'));
  check('answer: up moves back to Submit answers', /❯ 1\. Submit answers$/m.test(k));
  const l = await step(s, 'askq-q3-revisit', press(s, 'left'));
  check('answer: left on the review shows question 3 again, its cursor on row 1', Q3.test(l) && /❯ 1\. Staging$/m.test(l), l.slice(0, 600));
  const m = await step(s, null, press(s, 'right'));
  check('answer: right shows the review again, cursor on Submit answers', REVIEW.test(m) && /❯ 1\. Submit answers$/m.test(m));
  await step(s, 'askq-after-submit', press(s, 'enter'), 1200);
  const r = await resultOf(s.id);
  check('answer: Enter on Submit answers answers every question', r !== null && r.includes('"Question Title 123: which approach should Agent 1 take?"="Option B"') && r.includes('="Lint, Unit tests"') && r.includes('="Project Alpha answer 3"'), r?.slice(0, 400));
}
// ---- 3. Other on the first question (not the last): the forced send picks the text and moves on ----
{
  const s = await open('H0-ASKQ other', Q1);
  const a = await step(s, null, press(s, 'down', 'down', 'down'));
  check('other: the Other row of question 1 is "4. Type something."', /❯ 4\. Type something\.$/m.test(a));
  const b = await step(s, 'askq-q2-after-other', force(s, 'Project Alpha answer 1'), 1200);
  check('other: the forced send on question 1\'s Other row shows question 2, question 1 answered', Q2.test(b) && /☒ Approach  ☐ Checks/.test(b), b.slice(0, 500));
  const c = await step(s, null, press(s, 'down', 'down', 'down'));
  const c2 = await step(s, 'askq-q2-other-typed', press(s, 'y'));
  check('other: typing on a multi-select\'s Other row ticks its box (multi-select + Other: not offered)', /❯ 4\. \[✔\] y$/m.test(c2), c);
  const d = await step(s, null, press(s, 'enter'));
  check('other: Enter on that Other row toggles its box off again, it does not move on', /❯ 4\. \[ \] y$/m.test(d) && Q2.test(d), d.slice(0, 600));
  findings.multiOther = 'on a multi-select Other row, typing ticks the box, Enter toggles it, and hc send (paste + Enter) leaves it unticked: multi-select + Other needs a key sequence of its own (not offered)';
  await step(s, null, press(s, 'esc'), 1200);
}
// ---- 4. the multi-select question last ----
{
  const s = await open('H0-ASKR last', /Question Title 321/);
  const a = await step(s, 'askr-q1');
  check('last: two questions, tab line', /^←  ☐ Branch  ☐ Docs  ✔ Submit  →$/m.test(a), a.slice(0, 300));
  await step(s, null, press(s, 'enter'));
  const b = await step(s, null, press(s, 'space'));
  const c = await step(s, 'askr-q2-on-submit', press(s, 'down', 'down', 'down'));
  check('last: the last question, multi-select, ends in "Submit" (not "Next")', /Question Title 654/.test(c) && /^❯ {4}Submit$/m.test(c), `${b}\n----\n${c}`);
  findings.lastRow = 'a multi-select question ends in an unnumbered "Next" row, or "Submit" when it is the last question; Enter on either moves on (Next: the next question; Submit: the review)';
  const d = await step(s, 'askr-review', press(s, 'enter'), 1200);
  check('last: Enter on its Submit shows the review', REVIEW.test(d) && /→ main\n[\s\S]*→ README\n/.test(`${d}\n`), d);
  const e = await step(s, 'askr-after-esc', press(s, 'esc'), 1500);
  check('last: Esc on the review cancels the whole prompt', !/Ready to submit/.test(e), e);
  const r = await resultOf(s.id, 32);
  note({ reviewEscResult: r?.slice(0, 300) ?? null });
  findings.reviewEsc = `Esc on the review cancels the whole AskUserQuestion: ${r === null ? 'no tool_result within 8 s' : 'the call gets a rejection result'}`;
}
// ---- 5. how long `hc send --force` takes on one question of several (rig CV9): the text lands and the next tab shows
// within a second, then hc waits about 5 s more for a turn that an answer to one question never starts ----
const timedSend = (t, text) => { const t0 = Date.now(); const r = spawnSync('hc', ['send', '--json', '--force', '--', t, text], { encoding: 'utf8' }); return { ms: Date.now() - t0, status: r.status, stdout: r.stdout.slice(0, 300) }; };
{
  const s = await open('H0-ASKQ wait1', Q1);
  hc('keys', s.t, 'down', 'down', 'down');
  await sleep(300);
  const r = timedSend(s.t, 'Project Alpha answer 1');
  note({ sendWait: 'q1 Other right after arrows', ...r });
  findings.sendWaitQ1Ms = r.ms;
  await step(s, null, press(s, 'esc'), 1200);
}
{
  const s = await open('H0-ASKQ wait3', Q1);
  for (const k of [['enter'], ['space'], ['down', 'down', 'down', 'down'], ['enter'], ['down', 'down']]) { hc('keys', s.t, ...k); await sleep(300); }
  await sleep(4000);
  const r = timedSend(s.t, 'Project Alpha answer 3');
  note({ sendWait: 'q3 Other, 4 s after the last key', ...r });
  findings.sendWaitQ3After4sMs = r.ms;
  check('send: on several questions hc send --force returns "started":false after about 5 s, even 4 s after the last key', r.status === 0 && r.ms >= 4000 && /"started":false/.test(r.stdout), r);
  await step(s, null, press(s, 'esc'), 1200);
}
{
  const s = await open('H0-ASK1 wait5', Q1);
  hc('keys', s.t, 'down', 'down', 'down');
  await sleep(300);
  const r = timedSend(s.t, 'Project Alpha answer 1');
  note({ sendWait: 'one-question Other right after arrows', ...r });
  findings.sendWaitOneQuestionMs = r.ms;
  check('send: on one question hc send --force returns "started":true within 2 s (the answer starts a turn)', r.status === 0 && r.ms < 2000 && /"started":true/.test(r.stdout), r);
}
{
  // The screen while the forced send runs on question 1 of several: when the text shows, when the next tab shows.
  const s = await open('H0-ASKQ wait6', Q1);
  hc('keys', s.t, 'down', 'down', 'down');
  await sleep(300);
  const t0 = Date.now();
  const child = spawn('hc', ['send', '--json', '--force', '--', s.t, 'Project Alpha answer 1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const seen = [];
  let doneAt = null;
  child.on('close', () => (doneAt = Date.now() - t0));
  while (doneAt === null && Date.now() - t0 < 15000) {
    const b = block(read(s.t));
    const key = `${(b.match(/Question Title \d+/) ?? [''])[0]} | ${(b.match(/^.*4\. .*$/m) ?? [''])[0]}`;
    if (seen.length === 0 || seen[seen.length - 1].key !== key) seen.push({ ms: Date.now() - t0, key });
    await sleep(100);
  }
  note({ sendWatch: seen, doneAt, out: out.slice(0, 300) });
  const next = seen.find((x) => x.key.startsWith('Question Title 456'));
  findings.sendWatch = { nextTabMs: next?.ms ?? null, hcReturnedMs: doneAt };
  check('send: the next tab shows within 1.5 s of the forced send; hc returns seconds later', next !== undefined && next.ms <= 1500 && doneAt !== null && doneAt - next.ms >= 3000, { seen, doneAt });
  await step(s, null, press(s, 'esc'), 1200);
}
findings.sendWait = 'on one question of several, hc send --force pastes and presses Enter at once (the next tab shows within about 0.8 s) and then waits about 5 s for a turn to start, which never comes, returning "started":false; on a one-question prompt the answer starts a turn and hc returns in under a second. So the bridge times the Other send of a card with several questions by when the next tab shows, not by when hc returns';
note({ version, findings });
writeFileSync(join(out, 'multiq.json'), `${JSON.stringify(findings, null, 2)}\n`);
for (const t of terms) { try { hc('kill', t); } catch { /* already gone */ } }
note({ done: true });
