// Rig harness for Chat (fix/chat-loading-forever): the real PWA in headless Chromium, through a TLS stand-in for
// `tailscale serve`, against the bridge's real `startApp`, reading terminals of the rig's OWN hc (private
// HC_SESSION, socket inside the rig). Synthetic terminal content only.
//
// The harness runs with a PATH that lacks the directory hc lives in (as when herdr-app starts from a desktop
// launcher), and hc is reachable only as $HOME/.local/bin/hc: the bridge must find it there by itself.
//
// The host topic comes from this harness playing the link copy: the real mod's `buildHost` (mod/herdr-app-remote/
// host.js) over agent records whose addresses are the real hc terminals (the rig's herdr-app has no agents: it
// only knows real Claude/Codex). Every check is one JSON line in <log>; recorded hc output goes to <rig>/rec.
//   node chat-harness.mjs <repo root> <rig dir> <log> <real hc path>
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , repo, rig, log, realHc] = process.argv;
const appHome = process.env.HERDR_APP_HOME;
const home = process.env.HOME;
const note = (o) => appendFileSync(log, `${JSON.stringify(o)}\n`);
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails += 1;
  note({ check: name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const { buildHost } = await import(pathToFileURL(join(repo, 'mod/herdr-app-remote/host.js')).href);
const { chromium } = createRequire(join(repo, 'packages/pwa/package.json'))('@playwright/test');

// ---- hc reachable only through ~/.local/bin ----
const localBin = join(home, '.local/bin');
const linkHc = join(localBin, 'hc');
mkdirSync(localBin, { recursive: true });
const placeHc = () => { rmSync(linkHc, { force: true }); symlinkSync(realHc, linkHc); };
placeHc();
check('hc is not on the harness PATH', spawnSync('hc', ['--version']).error?.code === 'ENOENT');
check('the bridge resolves hc to ~/.local/bin/hc', B.resolveBinary('hc') === linkHc, B.resolveBinary('hc'));

// ---- terminals with synthetic content, and recordings of what hc prints ----
const hc = (...args) => execFileSync(linkHc, args, { encoding: 'utf8' });
const rec = join(rig, 'rec');
const project = join(home, 'project');
mkdirSync(rec, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(rec, 'version.txt'), hc('--version'));
const agentScript = join(rig, 'bin/synthetic-agent.sh');
writeFileSync(agentScript, `#!/bin/sh
printf '\\033[1m*\\033[0m %s: I split the parser into three passes.\\n' "$1"
printf '  \\033[32m+84\\033[0m \\033[31m-212\\033[0m src/parse/mod.rs\\n'
printf '%s says: tests pass, 212 passed\\n' "$1"
while :; do sleep 600; done
`, { mode: 0o755 });
const start = (name) => JSON.parse(hc('run', '--bg', '--cwd', project, '--name', name, agentScript, name)).address;
const t1 = start('agent-one');
const t2 = start('agent-two');
const t3 = start('agent-three');
note({ terminals: [t1, t2, t3] });
await sleep(1500);
const lsOut = hc('ls', '--json');
writeFileSync(join(rec, 'ls.json'), lsOut);
writeFileSync(join(rec, 'read.txt'), hc('read', t1, '--lines', '200'));
const missing = spawnSync(linkHc, ['read', 'no-such-terminal', '--lines', '200'], { encoding: 'utf8' });
writeFileSync(join(rec, 'read-not-found.stderr.json'), missing.stderr);
writeFileSync(join(rec, 'read-not-found.status'), String(missing.status));
check('hc ls --json lists the terminals by address', [t1, t2, t3].every((t) => B.terminalIds(lsOut)?.has(t)), lsOut.slice(0, 300));

// ---- the bridge ----
const token = B.newLinkToken();
const link = new B.LinkServer({ token });
const linkPort = await link.listen();
const SERVE = 'desk-1.example-tailnet.ts.net:8443';
const app = await B.startApp({
  appHome,
  link,
  staticDir: join(repo, 'packages/pwa/dist'),
  port: B.DEFAULT_API_PORT,
  serve: { host: SERVE, login: 'user-1@example' },
  tailscale: join(rig, 'fakebin/tailscale'),
  home,
});
note({ listening: app.port });

// The link copy: the real mod's buildHost over agents at the real terminal addresses.
const space = 'space-1';
const agentsSrc = [
  { address: t1, space, title: 'Agent One', app: 'claude', program: { key: 'claude', name: 'Claude Code' }, status: 'working' },
  { address: t2, space, title: 'Agent Two', app: 'claude', program: { key: 'claude', name: 'Claude Code' }, status: 'blocked' },
  { address: t3, space, title: 'Agent Three', app: 'codex', program: { key: 'codex', name: 'Codex' }, status: 'idle' },
];
const hostState = buildHost({
  spaces: [{ id: space, name: 'Project Alpha', active: true, tabs: [{ id: 'tab-1' }] }],
  agents: agentsSrc,
  terminals: [t1, t2, t3].map((t) => ({ address: t, title: t, cols: 120, rows: 36 })),
  panes: [t1, t2, t3].map((t, i) => ({ pane: `p${i}`, tab: 'tab-1', terminal: t })),
  focused: { space, pane: 'p0', agent: t1 },
  settings: {},
  layoutName: 'rig',
  owner: null,
  now: Date.now(),
});
check('the mod maps an agent to its terminal address', hostState.agents.map((a) => a.terminal_id).join() === [t1, t2, t3].join(), hostState.agents);
const sock = net.connect(linkPort, '127.0.0.1');
sock.setEncoding('utf8');
let buf = '';
sock.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.type === 'ping') sock.write('{"type":"pong"}\n');
  }
});
await new Promise((r) => sock.once('connect', r));
sock.write(`${JSON.stringify({ type: 'hello', v: 1, token, copy: 'link', layout: 'rig', app: { version: 'rig' } })}\n`);
sock.write(`${JSON.stringify({ type: 'state', seq: 1, host: hostState })}\n`);

// ---- TLS stand-in for serve ----
mkdirSync(join(rig, 'tls'), { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=desk-1.example-tailnet.ts.net',
  '-keyout', join(rig, 'tls/key.pem'), '-out', join(rig, 'tls/cert.pem')], { stdio: 'ignore' });
const standin = spawn(process.execPath, [join(rig, 'bin/serve-standin.mjs'), '8443', String(app.port), 'user-1@example', join(rig, 'tls/cert.pem'), join(rig, 'tls/key.pem')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => standin.stdout.once('data', r));

// ---- pair one phone ----
const ORIGIN = `https://${SERVE}`;
const { code } = app.security.issueCode();
const paired = await new Promise((resolve, reject) => {
  const r = https.request({ host: '127.0.0.1', port: 8443, method: 'POST', path: '/api/v1/pair', rejectUnauthorized: false, servername: 'desk-1.example-tailnet.ts.net',
    headers: { Host: SERVE, Origin: ORIGIN, 'X-Remote-Api': '1', 'Content-Type': 'application/json' } }, (res) => {
    let b = '';
    res.on('data', (x) => (b += x));
    res.on('end', () => resolve({ status: res.statusCode, cookie: [res.headers['set-cookie'] ?? []].flat()[0] ?? '', body: b }));
  });
  r.on('error', reject);
  r.end(JSON.stringify({ code, name: 'Rig phone' }));
});
check('phone paired', paired.status === 202, paired.status);
app.security.approve(JSON.parse(paired.body).device.id);
const [cookiePair] = paired.cookie.split(';');
const eq = cookiePair.indexOf('=');

// ---- the phone: the built PWA in Chromium ----
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP desk-1.example-tailnet.ts.net 127.0.0.1'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
await context.addCookies([{ name: cookiePair.slice(0, eq), value: cookiePair.slice(eq + 1), url: `${ORIGIN}/`, secure: true, httpOnly: true, sameSite: 'Strict' }]);
const page = await context.newPage();
page.on('pageerror', (e) => note({ pageerror: String(e) }));
let shot = 0;
const snap = async (name) => page.screenshot({ path: join(rig, `chat-${String(++shot).padStart(2, '0')}-${name}.png`) });
const log$ = () => page.getByRole('log', { name: 'Terminal output' });

/** Waits for `text` in the terminal view; returns ms taken, or -1. */
async function seeLines(text, ms = 8000) {
  const t0 = Date.now();
  try {
    await log$().getByText(text).first().waitFor({ timeout: ms });
    return Date.now() - t0;
  } catch {
    return -1;
  }
}
/** Waits for an alert or status naming `text` on the chat screen; returns ms taken, or -1. */
async function seeState(role, text, ms = 8000) {
  const t0 = Date.now();
  try {
    await page.getByRole(role).filter({ hasText: text }).first().waitFor({ timeout: ms });
    return Date.now() - t0;
  } catch {
    return -1;
  }
}
// A fresh page load each time (a hash-only goto would keep the page and its cached topics).
/** Samples every 500 ms for `ms`: how many samples failed `pred` (0 means it held throughout). */
async function holds(pred, ms = 6000) {
  let misses = 0;
  for (let t = 0; t < ms; t += 500) {
    await sleep(500);
    if (!(await pred())) misses += 1;
  }
  return misses;
}
const open = async (hash, agent) => {
  await page.goto('about:blank');
  await page.goto(`${ORIGIN}/${hash}`);
  await page.getByRole('link', { name: new RegExp(agent) }).first().click({ timeout: 15000 });
};

try {
  // Entry point 1: the Chat tab's picker.
  await open('#/chat', 'Agent One');
  let ms = await seeLines('agent-one says: tests pass');
  await snap('picker-agent-one');
  check('Chat tab picker opens Agent One and shows its terminal lines', ms >= 0, { ms, hash: await page.evaluate(() => location.hash) });
  check('the chat shows the real hc read output', (await log$().textContent())?.includes('I split the parser into three passes.'));

  // Entry point 2: the Agents tab (an agent row: `#/chat/<agent id>`).
  await open('#/agents', 'Agent Two');
  ms = await seeLines('agent-two says: tests pass');
  await snap('agents-agent-two');
  check('Agents tab opens Agent Two and shows its terminal lines', ms >= 0, { ms, hash: await page.evaluate(() => location.hash) });

  // A terminal that closed before the chat opened: an error, not a spinner (the phone's case).
  hc('kill', t3);
  await sleep(1000);
  await open('#/chat', 'Agent Three');
  ms = await seeState('alert', 'This terminal has closed', 5000);
  await snap('closed-before-open');
  check('a closed terminal shows "This terminal has closed" within 5 s', ms >= 0, { ms });
  check('...and not "Waiting for the terminal"', (await page.getByText('Waiting for the terminal').count()) === 0);
  // hc read of a finished terminal still answers: the alert must not give way to its last screen.
  let misses = await holds(async () => (await page.getByRole('alert').filter({ hasText: 'This terminal has closed' }).count()) === 1 && !((await log$().textContent()) ?? '').includes('agent-three says'));
  check('...and it stays closed for 6 s (no last screen shown as live)', misses === 0, { misses });

  // A terminal that closes while its chat is open: the last text stays under a notice.
  await open('#/chat', 'Agent Two');
  await seeLines('agent-two says: tests pass');
  hc('kill', t2);
  ms = await seeState('status', 'This terminal has closed.', 15000);
  await snap('closed-while-open');
  check('a terminal closing under an open chat says so', ms >= 0, { ms });
  check('...and keeps its last text', (await log$().textContent())?.includes('agent-two says: tests pass'));
  misses = await holds(async () => (await page.getByRole('status').filter({ hasText: 'This terminal has closed.' }).count()) === 1);
  check('...and the notice stays for 6 s (no flapping)', misses === 0, { misses });

  // hc gone: the chat says so within a few seconds.
  rmSync(linkHc);
  await page.goto('about:blank');
  await sleep(1000); // the old socket goes, and with it the bridge's chat topic: the next one starts with no text
  await open('#/chat', 'Agent One');
  ms = await seeState('alert', "hc isn't found", 5000);
  await snap('hc-missing');
  check('hc missing shows "hc isn\'t found" within 5 s', ms >= 0, { ms });

  // hc back: the same open chat recovers by itself.
  placeHc();
  ms = await seeLines('agent-one says: tests pass', 15000);
  await snap('hc-back');
  check('the chat recovers when hc is back', ms >= 0, { ms });
} catch (e) {
  check('harness ran to the end', false, String(e?.stack ?? e));
}

await browser.close();
standin.kill();
sock.destroy();
await app.stop();
spawnSync(realHc, ['kill', t1]);
note({ done: true, fails });
process.exit(fails ? 1 : 0);
