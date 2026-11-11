// The bridge process: the link server, runtime.json, and the rules that end it.
//
// It stops when:
// - `uninstalled`: the install record is gone;
// - `superseded`: the record names another bundle (an upgrade), so the new one can take the lock;
// - `replaced`: runtime.json names another pid (a second bridge won a race, where flock is missing);
// - `app_gone`: no link copy has been connected for `graceMs` and the app's socket is gone;
// - `signal`: SIGTERM/SIGINT (wired by the CLI).
//
// S12 runs the link listener only. The API listener (P1) needs S5's guards and lands with them.
import { install } from "@herdr-remote/protocol";
import { LinkServer } from "../link/server.js";
import { newLinkToken, removeRuntime, runtimePath, writeRuntime } from "../link/runtime.js";
import { appRuns, liveBridge, readReceipt, readRuntimeFile } from "./self.js";

export type StopReason = "uninstalled" | "superseded" | "replaced" | "app_gone" | "signal" | "error";

export interface ServeOptions {
  appHome: string;
  /** The hash of the bundle this process runs (checked against the record by the caller). */
  bundleSha256: string;
  checkMs?: number;
  /** How long without a link copy before the app's socket is asked. Default 30 s. */
  graceMs?: number;
  /** Test seams. */
  appAlive?: () => Promise<boolean>;
  pid?: number;
  now?: () => number;
  linkOptions?: { pingIntervalMs?: number; helloTimeoutMs?: number };
}

export interface Bridge {
  readonly link: LinkServer;
  readonly port: number;
  /** Resolves once the bridge stopped and cleaned up. */
  readonly stopped: Promise<StopReason>;
  stop(reason: StopReason): Promise<StopReason>;
}

export const CHECK_MS = 5_000;
export const GRACE_MS = 30_000;

/** Starts the bridge; resolves null when another live bridge already serves this home. */
export async function serve(o: ServeOptions): Promise<Bridge | null> {
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  const checkMs = o.checkMs ?? CHECK_MS;
  const graceMs = o.graceMs ?? GRACE_MS;
  const appAlive = o.appAlive ?? (() => appRuns(o.appHome));
  // flock keeps a second bridge out. Where there is no flock, this narrows the window to a race.
  if (await liveBridge(o.appHome, pid)) return null;

  const token = newLinkToken();
  const link = new LinkServer({ token, ...o.linkOptions });
  const port = await link.listen();
  const path = runtimePath(o.appHome);
  try {
    await writeRuntime(path, { v: 1, port, token, pid, bundle_sha256: o.bundleSha256 });
  } catch (e) {
    await link.close();
    throw e;
  }

  let lastLink = now();
  let timer: NodeJS.Timeout | null = null;
  let stopping: Promise<StopReason> | null = null;
  let resolveStopped!: (r: StopReason) => void;
  const stopped = new Promise<StopReason>((r) => (resolveStopped = r));

  const stop = (reason: StopReason): Promise<StopReason> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      await link.close().catch(() => {});
      await removeRuntime(path, pid).catch(() => {});
      resolveStopped(reason);
      return reason;
    })();
    return stopping;
  };

  const check = async (): Promise<StopReason | null> => {
    let receipt;
    try {
      receipt = await readReceipt(o.appHome);
    } catch {
      return "uninstalled"; // an unusable record proves nothing about us: don't keep serving on it
    }
    if (!receipt) return "uninstalled";
    if (receipt.files[install.BUNDLE_PATH]?.sha256 !== o.bundleSha256) return "superseded";
    const rt = await readRuntimeFile(o.appHome);
    if (!rt || rt.pid !== pid) return "replaced";
    if (link.connected("link")) {
      lastLink = now();
      return null;
    }
    if (now() - lastLink >= graceMs && !(await appAlive())) return "app_gone";
    return null;
  };

  const tick = () => {
    timer = setTimeout(async () => {
      if (stopping) return;
      let reason: StopReason | null;
      try {
        reason = await check();
      } catch {
        reason = "error";
      }
      if (stopping) return;
      if (reason) void stop(reason);
      else tick();
    }, checkMs);
  };
  link.on("link", () => (lastLink = now()));
  link.on("unlink", () => (lastLink = now()));
  tick();
  return { link, port, stopped, stop };
}
