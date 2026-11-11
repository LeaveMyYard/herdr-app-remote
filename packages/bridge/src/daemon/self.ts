// What the bridge knows about its own installation: its bundle's hash, the install record, whether
// a bridge is already live for this app home, and whether the app is still there.
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { install, modLink } from "@herdr-remote/protocol";
import { runtimePath } from "../link/runtime.js";

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** The checked install record; null when there is none. Throws when it is there but can't be used. */
export async function readReceipt(appHome: string): Promise<install.InstallReceipt | null> {
  const path = join(appHome, install.RECEIPT_PATH);
  let info;
  try {
    info = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!info.isFile() || info.size > install.RECEIPT_LIMIT) throw new Error("install record unusable");
  return install.InstallReceipt.parse(JSON.parse(await readFile(path, "utf8")));
}

export type BundleCheck = { ok: true; sha256: string } | { ok: false; reason: "not_installed" | "bad_receipt" | "wrong_path" | "mismatch" | "unreadable" };

/**
 * The bundle at `bundle` is the installed one and matches the record. The launcher and the server
 * both check this; the mod checked it too before it ran us. None of these is proof against a swap
 * between the check and node reading the file (same as panorama's binary.js): the folder is the
 * user's own, 0700.
 */
export async function checkBundle(appHome: string, bundle: string): Promise<BundleCheck> {
  let receipt;
  try {
    receipt = await readReceipt(appHome);
  } catch {
    return { ok: false, reason: "bad_receipt" };
  }
  if (!receipt) return { ok: false, reason: "not_installed" };
  let sha256;
  try {
    // Links on the way to the home are the operator's; the bundle itself must be the installed file.
    const [want, have] = await Promise.all([realpath(join(appHome, install.BUNDLE_PATH)), realpath(bundle)]);
    if (want !== have) return { ok: false, reason: "wrong_path" };
    sha256 = await sha256File(bundle);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (sha256 !== receipt.files[install.BUNDLE_PATH]?.sha256) return { ok: false, reason: "mismatch" };
  return { ok: true, sha256 };
}

/** True if a process with this pid exists and is ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: someone else's, so not our bridge.
    return false;
  }
}

/** Connects to 127.0.0.1:port and closes at once; true if something accepted. Sends nothing. */
export function portAnswers(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function readRuntimeFile(appHome: string): Promise<modLink.Runtime | null> {
  try {
    const parsed = modLink.Runtime.safeParse(JSON.parse(await readFile(runtimePath(appHome), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The runtime of another live bridge for this home, or null. Live means: runtime.json names a pid
 * other than `self` that we can signal, and its link port accepts a connection.
 */
export async function liveBridge(appHome: string, self: number = process.pid): Promise<modLink.Runtime | null> {
  const rt = await readRuntimeFile(appHome);
  if (!rt || rt.pid === self || !pidAlive(rt.pid)) return null;
  return (await portAnswers(rt.port)) ? rt : null;
}

/**
 * Whether herdr-app still runs for this home: its socket accepts a connection. Only "no such socket"
 * and "refused" count as gone, the same rule as herdr-inbox's installer. Nothing is sent.
 */
export function appRuns(appHome: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ path: join(appHome, "herdr-app.sock") });
    const done = (alive: boolean) => {
      s.destroy();
      resolve(alive);
    };
    s.setTimeout(timeoutMs, () => done(true));
    s.once("connect", () => done(true));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code !== "ENOENT" && e.code !== "ECONNREFUSED"));
  });
}
