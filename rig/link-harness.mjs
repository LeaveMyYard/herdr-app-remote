// Rig harness for the real link mod: the bridge's own LinkServer on loopback inside the rig's
// net namespace, with runtime.json written where the mod looks. Scenarios push commands by
// appending JSON lines ({"run": name, "args": {...}}) to the command file; everything the server
// sees goes to the log as one JSON object per line.
//   node link-harness.mjs <repo root> <app home> <log> <command file>
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [, , repo, appHome, log, cmdFile] = process.argv;
const { LinkServer, newLinkToken, runtimePath, writeRuntime } =
  await import(pathToFileURL(join(repo, 'packages/bridge/dist/link/index.js')).href);
const note = o => appendFileSync(log, `${JSON.stringify(o)}\n`);
const token = newLinkToken();
const server = new LinkServer({ token, log: e => note({ log: e }) });
server.on('link', e => note({ link: e.copy, hello: e.hello }));
server.on('host', h => note({
  host: { seq: h.seq, layout: h.layout, app: h.app, spaces: h.state.spaces.map(s => s.name), focused: h.state.focused },
}));
const port = await server.listen();
// The mod connects only to a runtime naming the bundle hash of the install record (S12), so the
// harness writes a stand-in record with a fake hash. No bundle exists at that path, so the mod's
// launcher can never verify one and never launches anything.
const FAKE_SHA = 'ab'.repeat(32);
mkdirSync(join(appHome, 'data/herdr-app-remote'), { recursive: true, mode: 0o700 });
writeFileSync(join(appHome, 'data/herdr-app-remote/install.json'), JSON.stringify({
  v: 1, install_id: '0123456789abcdef0123456789abcdef', node: '/nonexistent/node', dirs: [],
  files: { 'data/herdr-app-remote/bin/bridge.mjs': { sha256: FAKE_SHA, mode: 0o644 } }, previous: {}, keys: null,
}), { mode: 0o600 });
await writeRuntime(runtimePath(appHome), { v: 1, port, token, pid: process.pid, bundle_sha256: FAKE_SHA });
note({ listening: port });
let sent = 0;
setInterval(async () => {
  if (!existsSync(cmdFile)) return;
  const lines = readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean);
  for (; sent < lines.length; sent += 1) {
    const c = JSON.parse(lines[sent]);
    note({ run: c.run, outcome: await server.run(c.run, c.args ?? {}) });
  }
}, 200);
