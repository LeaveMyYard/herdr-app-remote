// App-home file operations, all on relative paths inside one home.
//
// The operator names the home (links on the way to it count, as herdr-app follows them). Inside it,
// no link is followed: every parent component is lstat'ed and must be a real directory, and the last
// component is opened with O_NOFOLLOW. Node has no openat(), so this is a check-then-use; herdr-inbox's
// installer walks directory fds instead. The home is the user's own, so what this guards against is a
// mistake (a link where a folder should be), not a hostile local user.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeSync, fchmodSync, chmodSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

export type Kind = "file" | "dir" | "other" | null;

export const digest = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** The components of a safe relative path; throws on anything absolute, empty, `.` or `..`. */
export function parts(path: string): string[] {
  const norm = posix.normalize(path);
  if (!path || isAbsolute(path) || norm !== path || path.endsWith("/")) throw new Error(`Unsafe relative path: ${path}`);
  const ps = path.split("/");
  if (ps.some((p) => p === "" || p === "." || p === "..")) throw new Error(`Unsafe relative path: ${path}`);
  return ps;
}

export class Home {
  readonly path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("--app-home must be absolute");
    this.path = realpathSync(path);
    if (!statSync(this.path).isDirectory()) throw new Error("--app-home must be a folder");
  }

  /** The absolute path of `rel`, after checking that no parent component is a link or a non-folder. */
  private abs(rel: string): string {
    const ps = parts(rel);
    let cur = this.path;
    for (const p of ps.slice(0, -1)) {
      cur = join(cur, p);
      let st;
      try {
        st = lstatSync(cur);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return join(this.path, ...ps); // nothing there yet
        throw e;
      }
      if (!st.isDirectory()) throw new Error(`Not a folder (a link or a file is in the way): ${ps.slice(0, ps.indexOf(p) + 1).join("/")}`);
    }
    return join(this.path, ...ps);
  }

  kind(rel: string): Kind {
    let st;
    try {
      st = lstatSync(this.abs(rel));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  }

  /** Bytes and mode of a regular file; null when nothing is there. Refuses a link or a special file. */
  read(rel: string, limit?: number): { data: Buffer; mode: number } | null {
    let fd;
    try {
      fd = openSync(this.abs(rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new Error(`Not a regular file (a link): ${rel}`);
      throw e;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error(`Not a regular file: ${rel}`);
      if (limit !== undefined && st.size > limit) throw new Error(`File too large: ${rel}`);
      const chunks: Buffer[] = [];
      const buf = Buffer.alloc(64 * 1024);
      let total = 0;
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        total += n;
        if (limit !== undefined && total > limit) throw new Error(`File too large: ${rel}`);
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
      return { data: Buffer.concat(chunks), mode: st.mode & 0o7777 };
    } finally {
      closeSync(fd);
    }
  }

  list(rel: string): string[] {
    if (this.kind(rel) !== "dir") return [];
    return readdirSync(this.abs(rel)).sort();
  }

  /** Every file, link and empty folder below a directory, depth first. Links are not followed. */
  walk(rel: string): string[] {
    const out: string[] = [];
    for (const name of this.list(rel)) {
      const child = `${rel}/${name}`;
      if (this.kind(child) === "dir" && this.list(child).length) out.push(...this.walk(child));
      else out.push(child);
    }
    return out;
  }

  /** Creates a directory; false when one was there already. Refuses anything else in the way. */
  mkdir(rel: string, mode = 0o755): boolean {
    const k = this.kind(rel);
    if (k === "dir") return false;
    if (k !== null) throw new Error(`Name collision: ${rel} is not a folder`);
    mkdirSync(this.abs(rel), { mode });
    return true;
  }

  chmod(rel: string, mode: number): void {
    if (this.kind(rel) === null) return;
    if (this.kind(rel) === "other") throw new Error(`Not a file or folder: ${rel}`);
    chmodSync(this.abs(rel), mode);
  }

  /** Publishes the whole file at once (temp file + rename in the same folder), replacing what is there. */
  write(rel: string, data: Buffer | string, mode: number): void {
    if (this.kind(rel) === "dir" || this.kind(rel) === "other") throw new Error(`Name collision: ${rel} is not a file`);
    const target = this.abs(rel);
    const temp = join(target, "..", `.herdr-app-remote-${randomBytes(8).toString("hex")}`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off);
      fchmodSync(fd, mode);
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temp, target);
    } catch (e) {
      try {
        closeSync(fd);
      } catch {
        /* closed already */
      }
      rmSync(temp, { force: true });
      throw e;
    }
  }

  /** Creates an empty file only if nothing is there; false when something was. */
  create(rel: string, mode: number): boolean {
    try {
      closeSync(openSync(this.abs(rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  remove(rel: string): void {
    try {
      unlinkSync(this.abs(rel));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** Removes an empty directory; false when something is left in it. */
  rmdir(rel: string): boolean {
    try {
      rmdirSync(this.abs(rel));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return true;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") return false;
      throw e;
    }
    return true;
  }

  /** Removes a directory tree we own (the stage). Links inside are removed, never followed. */
  rmtree(rel: string): void {
    if (this.kind(rel) !== null) rmSync(this.abs(rel), { recursive: true, force: true });
  }

  /** Renames within the home. Refuses to replace anything. */
  rename(from: string, to: string): void {
    if (this.kind(to) !== null) throw new Error(`Name collision: ${to}`);
    renameSync(this.abs(from), this.abs(to));
  }
}
