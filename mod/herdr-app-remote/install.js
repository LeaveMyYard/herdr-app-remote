// The parts of the install record (packages/protocol/src/install.ts) the mod needs: where the bridge
// bundle is, its hash, and the node that runs it. A parity test keeps these equal to the protocol's.
//
// Host modules: `crypto` and `fs/promises` are herdr-app's native adapters (panorama's binary.js
// uses the same two), not a Node dependency.
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { appHome, exec as herdrExec, readTextFile } from 'herdr';

export const DATA_DIR = 'data/herdr-app-remote';
export const RECEIPT_PATH = `${DATA_DIR}/install.json`;
export const BUNDLE_PATH = `${DATA_DIR}/bin/bridge.mjs`;
export const RECEIPT_LIMIT = 1024 * 1024;
/** The bundle is about 160 KiB; refuse to hash anything absurd. */
export const BUNDLE_LIMIT = 64 * 1024 * 1024;
export const LAUNCH_INTERVAL_MS = 10000;
export const LAUNCH_TIMEOUT_MS = 10000;

const SHA256 = /^[0-9a-f]{64}$/;
const INSTALL_ID = /^[0-9a-f]{32}$/;
const FIELDS = ['v', 'install_id', 'node', 'dirs', 'files', 'previous', 'keys'];

/** {node, bundleSha256} from the record's text; null when it is missing or not a record we wrote. */
export function parseReceipt(text) {
  if (typeof text !== 'string' || text.length > RECEIPT_LIMIT) return null;
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const keys = Object.keys(r);
  if (keys.length !== FIELDS.length || FIELDS.some((k) => !Object.hasOwn(r, k))) return null;
  if (r.v !== 1 || typeof r.install_id !== 'string' || !INSTALL_ID.test(r.install_id)) return null;
  if (typeof r.node !== 'string' || !r.node.startsWith('/') || r.node.length > 4096) return null;
  const entry = r.files && typeof r.files === 'object' ? r.files[BUNDLE_PATH] : undefined;
  if (!entry || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) return null;
  return { node: r.node, bundleSha256: entry.sha256 };
}

export async function loadReceipt(read = readTextFile, home = appHome) {
  try {
    return parseReceipt(await read(`${home()}/${RECEIPT_PATH}`));
  } catch {
    return null;
  }
}

/**
 * The bundle's path and node, once its bytes hash to the recorded value; null otherwise.
 * Like panorama's binary.js this can't prove the file isn't swapped before node reads it; the
 * bridge checks itself again when it starts.
 */
export async function verifiedBundle(receipt, { home = appHome, readBytes = readFile } = {}) {
  if (!receipt) return null;
  const path = `${home()}/${BUNDLE_PATH}`;
  let bytes;
  try {
    bytes = await readBytes(path);
  } catch {
    return null;
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > BUNDLE_LIMIT) return null;
  if (createHash('sha256').update(bytes).digest('hex') !== receipt.bundleSha256) return null;
  return { node: receipt.node, bundle: path };
}

/** True when a process with this pid exists and the user may signal it. Never throws. */
export async function pidAlive(pid, exec = herdrExec) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    const r = await exec('sh', ['-c', 'kill -0 "$1" 2>/dev/null', 'sh', String(pid)], { timeout: 3000 });
    return r?.code === 0;
  } catch {
    return false;
  }
}

/**
 * Whether to connect to the bridge runtime.json names. It must run the bundle the record names
 * (so a stale file from an older install, or one written by something else, is ignored) and its
 * pid must be alive (so a dead bridge's port, which anything could have bound since, is never
 * sent the token). This narrows, not closes, the gap mod-link-v1.md's security notes describe.
 */
export async function trustRuntime(rt, { receipt = loadReceipt, alive = pidAlive } = {}) {
  if (!rt || typeof rt.bundle_sha256 !== 'string') return false;
  const r = await receipt();
  if (!r || r.bundleSha256 !== rt.bundle_sha256) return false;
  return alive(rt.pid);
}

/** Starts the bridge when the link finds none: verified, at most once per LAUNCH_INTERVAL_MS. */
export class Launcher {
  constructor({ exec = herdrExec, home = appHome, receipt = loadReceipt, verify = verifiedBundle, now = () => Date.now(), intervalMs = LAUNCH_INTERVAL_MS } = {}) {
    this.exec = exec;
    this.home = home;
    this.receipt = receipt;
    this.verify = verify;
    this.now = now;
    this.intervalMs = intervalMs;
    this.lastAt = -Infinity;
    this.running = false;
    this.launches = 0;
    this.lastError = null;
  }

  /** Resolves true when a launch ran (the bridge itself decides if one already serves). */
  async maybe() {
    if (this.running || this.now() - this.lastAt < this.intervalMs) return false;
    this.running = true;
    this.lastAt = this.now();
    try {
      const ok = await this.verify(await this.receipt(), { home: this.home });
      if (!ok) {
        this.lastError = 'bundle not installed or does not match install.json';
        return false;
      }
      this.launches += 1;
      // argv only, no shell: the paths are never parsed as shell text.
      const r = await this.exec(ok.node, [ok.bundle, 'launch', '--app-home', this.home()], { timeout: LAUNCH_TIMEOUT_MS });
      this.lastError = r?.code === 0 ? null : `launch exited ${r?.code}`;
      return true;
    } catch (e) {
      this.lastError = String(e?.message ?? e).slice(0, 200);
      return false;
    } finally {
      this.running = false;
    }
  }
}
