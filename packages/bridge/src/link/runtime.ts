// runtime.json: how the link mod finds the bridge. Written atomically with mode 0600 under a 0700
// directory, so only the desktop user can read the token.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modLink } from "@herdr-remote/protocol";

/** A fresh 256-bit link token. */
export function newLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `<appHome>/data/herdr-app-remote/runtime.json`. */
export function runtimePath(appHome: string): string {
  return join(appHome, modLink.RUNTIME_RELATIVE_PATH);
}

export async function writeRuntime(path: string, runtime: modLink.Runtime): Promise<void> {
  const value = modLink.Runtime.parse(runtime);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = join(dir, `.runtime.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify(value) + "\n", "utf8");
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Removes runtime.json only if it still names this process (another bridge may have replaced it). */
export async function removeRuntime(path: string, pid: number = process.pid): Promise<void> {
  let current: unknown;
  try {
    current = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return;
  }
  const parsed = modLink.Runtime.safeParse(current);
  if (parsed.success && parsed.data.pid === pid) await rm(path, { force: true });
}
