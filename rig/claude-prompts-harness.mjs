// Rig harness for H0: Claude Code's native prompts, recorded from the real `claude` binary running in the rig's own hc
// terminals against a scripted fake Anthropic API on the rig's loopback (fake-anthropic.mjs). No credentials: the key is
// a made-up string, the HOME is the rig's, the network namespace has no egress. Fake data only. Every check is one JSON
// line in <log>; the screens are written to <out>/*.txt (these become fixtures/claude-prompts/<version>/).
//   node claude-prompts-harness.mjs <rig dir> <out dir> <log> <fake api port>
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
const readAsync = (t) => new Promise((res) => {
  const p = spawn('hc', ['read', t, '--lines', '80'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let s = '';
  p.stdout.on('data', (d) => (s += d));
  p.on('close', () => res(s.split('\n').filter((l) => !l.startsWith('[hc] ')).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '\n')));
});
const keys = (t, ...k) => hc('keys', t, ...k);
const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
check(`claude is the pinned version ${pinned} (re-record the fixtures and move the pin together)`, version.split(' ')[0] === pinned, version);

// Claude Code's state in the rig's private HOME: onboarding done, the project trusted, the fake key pre-approved.
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', numStartups: 5,
  customApiKeyResponses: { approved: ['fakefakefakefakefake'], rejected: [] },
  projects: { [project]: { hasTrustDialogAccepted: true, allowedTools: [] } },
}));
writeFileSync(join(rig, 'bin/launch-claude.sh'), `#!/bin/sh
cd ${project}
export ANTHROPIC_BASE_URL=http://127.0.0.1:${port} ANTHROPIC_API_KEY=sk-ant-api03-fakefakefakefakefakefakefakefake
export DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
exec claude "$@"
`, { mode: 0o755 });

/** Every transcript line on disk, parsed. */
const transcriptLines = () => {
  const base = join(home, '.claude/projects');
  if (!existsSync(base)) return [];
  const lines = [];
  for (const d of readdirSync(base)) for (const f of readdirSync(join(base, d))) if (f.endsWith('.jsonl')) {
    for (const l of readFileSync(join(base, d, f), 'utf8').split('\n')) { try { lines.push(JSON.parse(l)); } catch { /* partial line */ } }
  }
  return lines;
};
const pendingToolUse = (name) => {
  const lines = transcriptLines();
  const done = new Set();
  for (const l of lines) for (const b of (Array.isArray(l.message?.content) ? l.message.content : [])) if (b.type === 'tool_result') done.add(b.tool_use_id);
  for (const l of lines) if (l.type === 'assistant') for (const b of l.message.content ?? []) if (b.type === 'tool_use' && b.name === name && !done.has(b.id)) return b.id;
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
// The plan dialog prints the plan file's path under the config dir; fixtures carry no config-dir path.
const save = (name, text) => writeFileSync(join(out, `${name}.txt`), text.replace(/~\/\.claude\/plans\/[\w.-]+\.md/g, '~/CONFIG/plans/plan-1.md'));

/** R5: the tool_use is on disk before the dialog shows. File is polled every 5 ms in its own timer, the screen
 *  continuously; both first-sighting times are compared. */
async function r5(t, toolName, marker, trigger) {
  let tFile = null;
  let id = null;
  const timer = setInterval(() => { if (tFile === null && (id = pendingToolUse(toolName))) tFile = Date.now(); }, 5);
  hc('send', t, trigger);
  const end = Date.now() + 30000;
  let screen = '';
  let tScreen = null;
  while (Date.now() < end) {
    screen = await readAsync(t);
    if (marker.test(screen)) { tScreen = Date.now(); break; }
  }
  clearInterval(timer);
  await sleep(0);
  if (tFile === null && (id = pendingToolUse(toolName))) tFile = Date.now() + 1e9; // seen only after the screen
  return { screen, tFile, tScreen, id };
}

/** The text of the tool_result for a tool_use id, polled up to 10 s. */
async function toolResultText(id) {
  for (let i = 0; i < 40; i++) {
    const lines = transcriptLines();
    const ids = new Set([id]);
    for (const l of lines) for (const b of (Array.isArray(l.message?.content) ? l.message.content : [])) {
      if (b.type === 'tool_result' && ids.has(b.tool_use_id)) return typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
    }
    await sleep(250);
  }
  return null;
}
const cases = [];
async function dialogCase(name, args, trigger, tool, marker) {
  const t = launch(args);
  await untilScreen(t, /^❯/m, 20000);
  await sleep(1000);
  const r = await r5(t, tool, marker, trigger);
  const ok = r.tFile !== null && r.tScreen !== null && r.tFile <= r.tScreen;
  check(`R5 ${name}: tool_use on disk before the dialog shows`, ok, { toolUseId: r.id, fileFirstMs: r.tFile && r.tScreen ? r.tScreen - r.tFile : null });
  cases.push({ name, tool, tool_use_before_dialog: ok, lead_ms: r.tFile && r.tScreen ? r.tScreen - r.tFile : null });
  await sleep(700);
  return { t, screen: read(t), id: r.id };
}

// ---- permission ----
{
  const { t, screen } = await dialogCase('permission', ['--permission-mode', 'default'], 'H0-PERM please', 'Bash', /Do you want to proceed\?/);
  save('permission', screen);
  check('permission: has Yes / don\'t ask again / switch to auto mode / No', /1\. Yes\n[\s\S]*2\. Yes, and don’t ask again for: cargo test \*[\s\S]*3\. Yes, and switch to auto mode[\s\S]*4\. No/.test(screen));
  keys(t, 'esc');
}
// ---- AskUserQuestion single, then Other ----
{
  const { t, screen, id } = await dialogCase('ask-single', ['--permission-mode', 'default'], 'H0-ASK1 please', 'AskUserQuestion', /Question Title 123/);
  save('ask-single', screen);
  keys(t, 'down', 'down', 'down');
  await sleep(500);
  save('ask-other', read(t));
  check('ask-single: Other row is the 4th option, "Type something."', /❯ 4\. Type something\./.test(read(t)));
  const plain = spawnSync('hc', ['send', t, 'Project Alpha answer 1'], { encoding: 'utf8' });
  check('ask-single: plain hc send is refused while the terminal is blocked on its dialog', plain.status !== 0 && /"kind":"blocked"/.test(plain.stderr), plain.stderr.slice(0, 200));
  hc('send', '--force', t, 'Project Alpha answer 1');
  const tr = await toolResultText(id);
  check('ask-single: hc send on the Other row answers with the text', tr !== null && tr.includes('Project Alpha answer 1'), tr?.slice(0, 200));
  await sleep(500);
}
// ---- AskUserQuestion multi-select: toggle keys ----
{
  const { t, screen, id } = await dialogCase('ask-multi', ['--permission-mode', 'default'], 'H0-ASKM please', 'AskUserQuestion', /Question Title 123/);
  save('ask-multi', screen);
  keys(t, 'space'); await sleep(500); save('ask-multi-after-space', read(t));
  keys(t, 'down'); await sleep(400); keys(t, 'enter'); await sleep(500); save('ask-multi-after-down-enter', read(t));
  const a = read(t);
  check('ask-multi: space toggles the row under the cursor', /\[✔\] Lint/.test(read(t)) && /❯ 2\. \[✔\] Typecheck/.test(a));
  keys(t, 'down', 'down', 'down'); await sleep(500); save('ask-multi-on-submit', read(t));
  keys(t, 'enter'); await sleep(700); save('ask-multi-review', read(t));
  check('ask-multi: Enter on Submit opens a review step (Submit answers / Cancel)', /Ready to submit your answers\?[\s\S]*1\. Submit answers[\s\S]*2\. Cancel/.test(read(t)));
  keys(t, 'enter');
  const tr = await toolResultText(id);
  check('ask-multi: Enter on Submit, then on Submit answers, answers with both picks', tr !== null && /Lint/.test(tr) && /Typecheck/.test(tr) && !/Unit tests/.test(tr), tr?.slice(0, 200));
  await sleep(500);
}
// ---- plan ----
{
  const { t, screen } = await dialogCase('plan', ['--permission-mode', 'plan'], 'H0-PLAN please', 'ExitPlanMode', /Would you like to proceed\?/);
  save('plan', screen);
  keys(t, 'esc');
}
note({ version, cases });
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({
  claudeCode: version.split(' ')[0],
  recorded: 'by rig/scenarios/claude-prompts.sh: the real claude binary in a rig hc terminal, private HOME, a scripted fake Anthropic API on the rig loopback, no network, no credentials; all content fake',
  terminal: { cols: 200, rows: 120 },
  files: {
    permission: 'Bash permission dialog (default mode). Options: Yes / Yes, and don’t ask again for: cargo test * / Yes, and switch to auto mode / No. Footer: Esc to cancel · Tab to amend',
    'ask-single': 'AskUserQuestion, one question, single select. 3 options + "Type something." (Other) + "Chat about this" below a rule',
    'ask-other': 'ask-single with the cursor on the Other row ("4. Type something."): typing there is the Other input',
    'ask-multi': 'AskUserQuestion multiSelect: rows "[ ]", an unnumbered "Submit" row after the Other row, tab bar with Submit tab',
    'ask-multi-after-space': 'after one space on row 1: "[✔] Lint"; the tab icon changed from ☐ to ☒',
    'ask-multi-after-down-enter': 'after down then enter on row 2: both rows toggled; Enter toggles too',
    'ask-multi-on-submit': 'cursor on the unnumbered Submit row',
    'ask-multi-review': 'Enter on Submit opens a review step: "Submit answers" / "Cancel"; a second Enter answers',
    plan: 'ExitPlanMode in plan mode: plan text, then "Yes, and use auto mode" / "Yes, manually approve edits" / "Tell Claude what to change"',
  },
  keys: {
    multiSelectToggle: 'space or enter toggles the row under the cursor; down moves; Submit is the row after Other; Enter on it opens a review step with 1. Submit answers / 2. Cancel',
    other: 'hc send is refused while the terminal is blocked on a dialog (kind "blocked"); hc send --force on the Other row pastes the text and answers',
    cursor: 'the row with the cursor starts with ❯',
  },
  r5: cases,
}, null, 2)}\n`);
for (const t of terms) { try { hc('kill', t); } catch { /* already gone */ } }
note({ done: true });
