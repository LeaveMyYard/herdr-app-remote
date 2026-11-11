// Rig harness for S14 (pairing over a stand-in for serve): the bridge's own LinkServer plus its API side
// (`startApp`, with no serve identity, so Tailscale setup supplies it) on 127.0.0.1:47391 inside the rig's net
// namespace. `tailscale` is the fake CLI on the rig's PATH. The harness plays the desktop panel: scenarios
// append JSON lines ({"op": ...}) to the command file, and every outcome goes to the log as one JSON line.
//   node pairing-harness.mjs <repo root> <app home> <log> <command file>
// Ops: check, start, stop, code (issue a pairing code), approve (the pending device), funnel (re-read Funnel).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [, , repo, appHome, log, cmdFile] = process.argv;
const B = await import(pathToFileURL(join(repo, 'packages/bridge/dist/index.js')).href);
const note = (o) => appendFileSync(log, `${JSON.stringify(o)}\n`);
const token = B.newLinkToken();
const link = new B.LinkServer({ token });
link.on('link', (e) => note({ link: e.copy }));
const port = await link.listen();
// As in link-harness.mjs: a stand-in install record with a fake bundle hash, so the real mod trusts this
// runtime and never finds a bundle it could launch.
const FAKE_SHA = 'ab'.repeat(32);
mkdirSync(join(appHome, 'data/herdr-app-remote'), { recursive: true, mode: 0o700 });
writeFileSync(join(appHome, 'data/herdr-app-remote/install.json'), JSON.stringify({
  v: 1, install_id: '0123456789abcdef0123456789abcdef', node: '/nonexistent/node', dirs: [],
  files: { 'data/herdr-app-remote/bin/bridge.mjs': { sha256: FAKE_SHA, mode: 0o644 } }, previous: {}, keys: null,
}), { mode: 0o600 });
await B.writeRuntime(B.runtimePath(appHome), { v: 1, port, token, pid: process.pid, bundle_sha256: FAKE_SHA });

const app = await B.startApp({
  appHome,
  link,
  port: B.DEFAULT_API_PORT,
  tailscale: 'tailscale',
  funnelCheckMs: 600_000, // the scenario re-reads Funnel itself (op "funnel")
  onPending: (d) => note({ pending: d.name }),
  log: (e) => { if (e.event !== 'funnel') note({ app: e }); },
});
note({ listening: app.port, setup: app.setup !== null });

const pick = (s) => ({ step: s.step, serving: s.serving, url: s.url, login: s.login, can_start: s.can_start, can_stop: s.can_stop,
  problem: s.steps.find((x) => x.problem)?.problem ?? null });

const ops = {
  check: async () => pick(await app.setup.check()),
  start: async () => ({ res: await app.setup.start(), state: pick(app.setup.state) }),
  stop: async () => ({ res: await app.setup.stop(), state: pick(app.setup.state) }),
  code: async () => {
    const { code, url } = app.security.issueCode();
    writeFileSync(join(process.env.RIG ?? '.', 'pair.code'), code);
    return { url };
  },
  approve: async () => {
    const d = app.security.devices().find((x) => x.state === 'pending');
    if (!d) return { error: 'no pending device' };
    const v = app.security.approve(d.id);
    return { approved: v.name, state: v.state, step: app.setup.state.step };
  },
  funnel: async () => ({ verdict: await app.checkFunnel(), now: app.funnel }),
};

let done = 0;
let busy = false;
setInterval(async () => {
  if (busy || !existsSync(cmdFile)) return;
  busy = true;
  try {
    const lines = readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean);
    for (; done < lines.length; done += 1) {
      const c = JSON.parse(lines[done]);
      try {
        note({ op: c.op, n: done, out: await ops[c.op]() });
      } catch (e) {
        note({ op: c.op, n: done, error: String(e?.message ?? e) });
      }
    }
  } finally {
    busy = false;
  }
}, 100);
