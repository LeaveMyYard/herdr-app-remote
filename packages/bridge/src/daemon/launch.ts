// `bridge.mjs launch`: what the link mod runs. It returns at once and leaves at most one bridge.
//
// 1. The bundle must be the installed one and match the record (the mod checked it too).
// 2. A live bridge for this home running this same bundle: nothing to do.
// 3. Otherwise start `serve` in a session of its own (detached), under `flock -n` on the lock file
//    where flock(1) exists, so two launches can't both serve. Without flock (stock macOS), `serve`'s
//    own live-bridge check and its `replaced` rule keep it to one bridge after a short race.
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { install } from "@herdr-remote/protocol";
import { checkBundle, liveBridge, type BundleCheck } from "./self.js";

export type LaunchResult = { ok: true; started: boolean } | { ok: false; reason: Exclude<BundleCheck, { ok: true }>["reason"] };

export interface LaunchOptions {
  appHome: string;
  bundle: string;
  node: string;
  /** flock(1); undefined searches PATH, null means none. */
  flock?: string | null;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => { unref(): void; on(event: "error", f: () => void): unknown };
}

export function findOnPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir.startsWith("/")) continue; // a relative PATH entry depends on the cwd: never trust it
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The argv that starts the server. Exported for tests. */
export function serveArgv(o: { appHome: string; bundle: string; node: string; flock: string | null }): [string, string[]] {
  const serve = [o.bundle, "serve", "--app-home", o.appHome];
  if (o.flock) return [o.flock, ["-n", join(o.appHome, install.LOCK_PATH), o.node, ...serve]];
  return [o.node, serve];
}

export async function launch(o: LaunchOptions): Promise<LaunchResult> {
  const check = await checkBundle(o.appHome, o.bundle);
  if (!check.ok) return check;
  const live = await liveBridge(o.appHome, -1); // the launcher is never the bridge: no pid is "self"
  if (live && live.bundle_sha256 === check.sha256) return { ok: true, started: false };
  const dir = join(o.appHome, install.DATA_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const flock = o.flock === undefined ? findOnPath("flock") : o.flock;
  const [cmd, args] = serveArgv({ appHome: o.appHome, bundle: o.bundle, node: o.node, flock });
  const child = (o.spawn ?? nodeSpawn)(cmd, args, { detached: true, stdio: "ignore", cwd: dir });
  child.on("error", () => {}); // a missing node or flock: the mod sees no bridge and tries again later
  child.unref();
  return { ok: true, started: true };
}
