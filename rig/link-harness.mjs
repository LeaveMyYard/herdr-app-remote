// Rig harness for the real link mod: the bridge's own LinkServer on loopback inside the rig's
// net namespace, with runtime.json written where the mod looks. Scenarios push commands by
// appending JSON lines ({"run": name, "args": {...}}) to the command file; everything the server
// sees goes to the log as one JSON object per line.
//   node link-harness.mjs <repo root> <app home> <log> <command file>
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
await writeRuntime(runtimePath(appHome), { v: 1, port, token, pid: process.pid, bundle_sha256: null });
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
