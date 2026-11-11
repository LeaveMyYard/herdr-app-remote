// A stand-in for `tailscale serve` inside the rig: plain HTTP on 127.0.0.1:<listen>, forwarded to the bridge's
// API on 127.0.0.1:<target>. Like serve, it drops any Tailscale-* header the client sent and adds
// `Tailscale-User-Login` for the (fake) tailnet user; the client's Host is passed through, so a spoofed Host
// reaches the bridge as sent. WebSocket upgrades are forwarded the same way.
//   node serve-standin.mjs <listen port> <target port> <login>
import http from 'node:http';
import net from 'node:net';

const [, , listen, target, login] = process.argv;

function forwardHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!/^tailscale-/i.test(k)) h[k] = v;
  h['tailscale-user-login'] = login;
  h['tailscale-user-name'] = 'User 1';
  return h;
}

const server = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: Number(target), method: req.method, path: req.url, headers: forwardHeaders(req), setHost: false }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(target), '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(forwardHeaders(req))) for (const x of [v].flat()) lines.push(`${k}: ${x}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => { up.destroy(); socket.destroy(); };
  up.on('error', end);
  socket.on('error', end);
});

server.listen(Number(listen), '127.0.0.1', () => console.log(JSON.stringify({ standin: Number(listen) })));
