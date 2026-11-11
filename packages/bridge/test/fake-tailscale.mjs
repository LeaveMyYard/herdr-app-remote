#!/usr/bin/env node
// A fake `tailscale` CLI for tests and the rig. It never talks to a real tailscaled: it replays the recorded
// outputs in fixtures/tailscale and keeps the serve config in a state directory.
//   node fake-tailscale.mjs <state dir> <tailscale args...>
// State dir:
//   conf.json   {version, status, serveStatus, set, off} (see DEFAULTS); edited by the test between calls
//   serve.json  the current serve config (`tailscale serve status --json` prints it)
//   calls.log   one JSON argv per line, appended for every call
// Only the commands the bridge may run are known; anything else exits 64 and is logged, so a test can
// assert that nothing else was ever run.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , dir, ...args] = process.argv;
const FIX = process.env.FAKE_TS_FIXTURES || join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tailscale');
const DEFAULTS = {
  version: 'version.txt', // a fixture name, or "garbage", or "fail"
  status: 'status-running.json', // a fixture name, or "daemon-down", or "garbage"
  serveStatus: 'state', // "state" prints serve.json; "fail", "garbage", "empty-output"
  set: 'ok', // serve --bg: "ok", "operator", "disabled" (prints the enable URL and waits), "foreign" (applies another handler), "noop"
  off: 'ok', // serve ... off: "ok", "operator", "noop"
};
appendFileSync(join(dir, 'calls.log'), JSON.stringify(args) + '\n');
const conf = { ...DEFAULTS, ...(existsSync(join(dir, 'conf.json')) ? JSON.parse(readFileSync(join(dir, 'conf.json'), 'utf8')) : {}) };
const fx = (n) => readFileSync(join(FIX, n), 'utf8');
const statePath = join(dir, 'serve.json');
const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {});
const save = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
const out = (s) => process.stdout.write(s);
const err = (s, code = 1) => {
  process.stderr.write(s);
  process.exit(code);
};
const dnsName = () => JSON.parse(fx('status-running.json')).Self.DNSName.replace(/\.$/, '');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

if (same(args, ['version'])) {
  if (conf.version === 'fail') err('error\n');
  out(conf.version === 'garbage' ? 'not a version\n' : fx(conf.version));
} else if (same(args, ['status', '--json'])) {
  if (conf.status === 'daemon-down') err(fx('err-daemon-down.txt'));
  out(conf.status === 'garbage' ? '{"nope":' : fx(conf.status));
} else if (same(args, ['serve', 'status', '--json'])) {
  if (conf.serveStatus === 'fail') err(fx('err-daemon-down.txt'));
  if (conf.serveStatus === 'garbage') out('{"TCP":');
  else if (conf.serveStatus === 'empty-output') out('');
  else out(JSON.stringify(state(), null, 2) + '\n');
} else if (args[0] === 'serve' && args[1] === '--bg' && /^--https=\d+$/.test(args[2] ?? '') && args.length === 4) {
  const port = args[2].slice('--https='.length);
  const hp = `${dnsName()}:${port}`;
  if (conf.set === 'operator') err(fx('err-operator.txt'));
  if (conf.set === 'disabled') {
    out(fx('err-serve-disabled.txt'));
    setInterval(() => {}, 1000); // waits for the tailnet, like the real CLI
  } else if (conf.set === 'noop') {
    out('');
  } else {
    const s = state();
    s.TCP = { ...(s.TCP ?? {}), [port]: { HTTPS: true } };
    const target = conf.set === 'foreign' ? 'http://127.0.0.1:3000' : args[3];
    s.Web = { ...(s.Web ?? {}), [hp]: { Handlers: { '/': { Proxy: target } } } };
    save(s);
    out(`Available within your tailnet:\n\nhttps://${hp}/\n|-- proxy ${target}\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=${port} off\n`);
  }
} else if (args[0] === 'serve' && /^--https=\d+$/.test(args[1] ?? '') && args[2] === 'off' && args.length === 3) {
  const port = args[1].slice('--https='.length);
  if (conf.off === 'operator') err(fx('err-operator.txt'));
  if (conf.off !== 'noop') {
    const s = state();
    if (s.TCP) delete s.TCP[port];
    for (const k of Object.keys(s.Web ?? {})) if (k.endsWith(`:${port}`)) delete s.Web[k];
    for (const k of Object.keys(s.AllowFunnel ?? {})) if (k.endsWith(`:${port}`)) delete s.AllowFunnel[k];
    for (const k of ['TCP', 'Web', 'AllowFunnel']) if (s[k] && Object.keys(s[k]).length === 0) delete s[k];
    save(s);
  }
} else {
  err(`fake tailscale: unknown command: ${args.join(' ')}\n`, 64);
}
