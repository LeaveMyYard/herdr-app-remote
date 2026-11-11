// A test stand-in for herdr-app's `fs/promises` adapter: readFile(path) -> Uint8Array from world.bytes.
import { world } from './herdr.js';

export async function readFile(path) {
  const b = world.bytes[path];
  if (!b) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return b;
}
