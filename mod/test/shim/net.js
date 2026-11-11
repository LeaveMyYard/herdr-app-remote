// A test stand-in for herdr-app's `net` module, over node:net:
// connect(host, port) -> { write(str): Promise, read(): Promise<Uint8Array|null>, close() }.
import nodeNet from 'node:net';

export const sockets = [];

export function connect(host, port) {
  return new Promise((resolve, reject) => {
    const s = nodeNet.connect(port, host);
    const chunks = [];
    const readers = [];
    let ended = false;
    const flush = () => {
      while (readers.length && (chunks.length || ended)) {
        const r = readers.shift();
        r(chunks.length ? chunks.shift() : null);
      }
    };
    s.on('data', (d) => { chunks.push(new Uint8Array(d)); flush(); });
    s.on('end', () => { ended = true; flush(); });
    s.on('close', () => { ended = true; flush(); });
    s.once('error', (e) => { if (!api.connected) reject(e); ended = true; flush(); });
    const api = {
      connected: false,
      closed: false,
      write: (data) => new Promise((res, rej) => {
        if (api.closed || s.destroyed) return rej(new Error('socket closed'));
        s.write(data, (err) => (err ? rej(err) : res()));
      }),
      read: () => new Promise((res) => { readers.push(res); flush(); }),
      close: () => { api.closed = true; s.destroy(); ended = true; flush(); },
    };
    s.once('connect', () => { api.connected = true; sockets.push(api); resolve(api); });
  });
}

export default { connect };
