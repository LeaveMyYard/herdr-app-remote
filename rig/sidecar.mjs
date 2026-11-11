// Rig sidecar: the stand-in for the bridge's link server. It takes the probe mod's TCP
// connection and logs every line the mod streams. Scenarios push commands back by appending
// JSON lines to the command file; each new line is written to the socket.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';

const [, , log, port = '47123', cmdFile] = process.argv;
const note = s => appendFileSync(log, `${Date.now()} ${s}\n`);
let sock = null;
let sent = 0;
const pump = () => {
  if (!sock || !cmdFile || !existsSync(cmdFile)) return;
  const lines = readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean);
  for (; sent < lines.length; sent += 1) sock.write(`${lines[sent]}\n`);
};
setInterval(pump, 200);
net.createServer(s => {
  sock = s;
  note('connection');
  let buf = '';
  s.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      note(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  s.on('error', () => {});
  s.on('close', () => { note('closed'); if (sock === s) sock = null; });
}).listen(Number(port), '127.0.0.1', () => note(`listening ${port}`));
