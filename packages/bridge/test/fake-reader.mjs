// A fake Claude reader child for the ReaderPool tests. It speaks the same wire protocol as
// src/claude/reader-child.ts (one JSON request per stdin line, one reply per stdout line) but never loads the
// SDK: the session id picks a behaviour. The last group of the id selects it:
//   ...000000000001  echo: replies {env, argv, cwd, pid}
//   ...000000000002  hang: never replies
//   ...000000000003  alloc: grows its RSS by about 300 MB, then never replies
//   ...000000000004  crash: exits 3 without replying
//   ...000000000005  big: replies with a 2 MB string
//   ...000000000006  wrong id: replies to a different request id
//   ...000000000007  probe: tries to write a file and start a process, reports what was denied
//   ...000000000008  slow: replies after 150 ms
//   anything else    replies {session}
// Like the real child it exits when stdin closes and after --idle-ms with no request.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const idleMs = Number(process.argv[process.argv.indexOf('--idle-ms') + 1]);
let idle;
const arm = () => {
  clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), idleMs);
};
const reply = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const keep = [];

createInterface({ input: process.stdin }).on('line', (line) => {
  clearTimeout(idle);
  const req = JSON.parse(line);
  const kind = req.session.slice(-2);
  if (kind === '01') reply({ id: req.id, ok: true, value: { env: process.env, argv: process.argv.slice(1), cwd: process.cwd(), pid: process.pid } });
  else if (kind === '02') return;
  else if (kind === '03') {
    for (let i = 0; i < 30; i++) keep.push(Buffer.alloc(10 * 1024 * 1024, 1));
    return;
  } else if (kind === '04') process.exit(3);
  else if (kind === '05') reply({ id: req.id, ok: true, value: 'x'.repeat(2 * 1024 * 1024) });
  else if (kind === '06') reply({ id: req.id + 1000, ok: true, value: null });
  else if (kind === '07') {
    const denied = {};
    try {
      writeFileSync(`${process.env.HOME}/written-by-reader`, 'x');
      denied.write = false;
    } catch (e) {
      denied.write = e.code;
    }
    try {
      spawnSync('/bin/true');
      denied.spawn = false;
    } catch (e) {
      denied.spawn = e.code;
    }
    reply({ id: req.id, ok: true, value: denied });
  } else if (kind === '08') {
    setTimeout(() => {
      reply({ id: req.id, ok: true, value: { session: req.session } });
      arm();
    }, 150);
    return;
  } else reply({ id: req.id, ok: true, value: { session: req.session } });
  arm();
});
process.stdin.on('end', () => process.exit(0));
arm();
