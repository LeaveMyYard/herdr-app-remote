// Reader child processes, one per distinct Claude `projects` root (docs/chatview.md §2.2). A child is started
// on first use with CLAUDE_CONFIG_DIR=<root> and a clean env, exits after 60 s idle, and at most 4 run at
// once. A child is killed (by its own pid) when its RSS goes over 512 MB or a call takes over 5 s. Calls to
// one child run one at a time, so the 5 s limit is per call, not per queue. The parse cost stays in the
// children and the bridge's own env is never touched.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeRoot } from "./profiles.js";
import { checkRequest, type ReaderRequest, type WireReply } from "./wire.js";

/** The bundled child's file name, next to bridge.mjs in the build and the install. */
export const READER_FILE = "claude-reader.mjs";
export const READER_IDLE_MS = 60_000;
export const READER_MAX = 4;
export const READER_CALL_TIMEOUT_MS = 5_000;
export const READER_RSS_LIMIT = 512 * 1024 * 1024;
export const READER_RSS_POLL_MS = 250;
/** One reply line may not exceed this; a bigger one kills the child (`too_large`). */
export const READER_MAX_REPLY = 64 * 1024 * 1024;
/** Calls waiting behind the one in flight, per child. */
export const READER_MAX_QUEUE = 8;
/** After an idle stdin close, a child that has not exited by then is killed. */
const EXIT_GRACE_MS = 1_000;

/**
 * Why a call failed. `busy`: 4 children are busy, or this child's queue is full. `timeout`/`rss`/`too_large`:
 * the child was killed for that. `crashed`: it exited or was killed during the call. `failed`: the SDK threw.
 * `bad_request`: the request was refused before it reached the SDK. `spawn`: the child could not be started.
 */
export type ReaderError = "busy" | "timeout" | "rss" | "too_large" | "crashed" | "failed" | "bad_request" | "spawn";
export type ReaderReply = { ok: true; value: unknown } | { ok: false; error: ReaderError };

export type ReaderEvent =
  | { kind: "spawn"; pid: number; projects: string }
  /** The script's hash is not the expected one: nothing was started. */
  | { kind: "refused"; projects: string; why: "hash" }
  | { kind: "kill"; pid: number; projects: string; why: "timeout" | "rss" | "too_large" | "protocol" | "evict" | "close" }
  | { kind: "idle"; pid: number; projects: string }
  | { kind: "exit"; pid: number; projects: string; code: number | null; signal: NodeJS.Signals | null };

export interface ReaderPoolOptions {
  /** Absolute path of the bundled child (`dist/claude-reader.mjs`, or `bin/claude-reader.mjs` when installed). */
  script: string;
  /**
   * The sha256 (hex) the child must have: the one built with this bridge (bundle.mjs injects it into bridge.mjs;
   * the installer records the same file's hash in install.json). Checked before every spawn; a file with another
   * hash (edited, swapped, or left from another build) is never run, and the call fails as `spawn`.
   */
  scriptSha256: string;
  /** HOME for the children. Default: the bridge user's home. Nothing else from the bridge's env is passed on. */
  home?: string;
  idleMs?: number;
  max?: number;
  callTimeoutMs?: number;
  rssLimitBytes?: number;
  rssPollMs?: number;
  maxReplyBytes?: number;
  /** Resident set size of a pid in bytes, or null when it can't be read. Default: `/proc/<pid>/status` VmRSS. */
  rssOf?: (pid: number) => number | null;
  onEvent?: (e: ReaderEvent) => void;
}

/** `VmRSS` from `/proc/<pid>/status`, in bytes. Only our own children's pids are ever passed. */
export function procRss(pid: number): number | null {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * The child's own idle timer is a backstop: it fires a grace period after the bridge's, so the bridge always
 * retires the child first and a call arriving just as the idle time ends is never lost to the child exiting.
 */
export function childIdleMs(idleMs: number): number {
  return idleMs + EXIT_GRACE_MS;
}

/** Node 22.13 and 23.5 renamed `--experimental-permission` to `--permission`. */
export function permissionFlag(version = process.versions.node): string {
  const [maj = 0, min = 0] = version.split(".").map(Number);
  return maj > 23 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13) ? "--permission" : "--experimental-permission";
}

interface Pending {
  id: number;
  line: string;
  resolve: (r: ReaderReply) => void;
}

/** Resolves when the child has exited, or after `ms`. */
function exited(proc: ChildProcess, ms: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

class Reader {
  readonly proc: ChildProcess;
  readonly pid: number;
  readonly queue: Pending[] = [];
  inflight: (Pending & { timer: NodeJS.Timeout }) | undefined;
  lastUsed = 0;
  /** Set once the reader is leaving: it takes no new calls and no longer counts as running in `readers`. */
  leaving = false;
  idleTimer: NodeJS.Timeout | undefined;
  rssTimer: NodeJS.Timeout | undefined;
  buf: Buffer[] = [];
  bufLen = 0;

  constructor(proc: ChildProcess, pid: number) {
    this.proc = proc;
    this.pid = pid;
  }

  get busy(): boolean {
    return this.inflight !== undefined || this.queue.length > 0;
  }
}

export class ReaderPool {
  private readonly o: Required<Omit<ReaderPoolOptions, "onEvent">> & { onEvent: ((e: ReaderEvent) => void) | undefined };
  /** Live readers by projects realpath. */
  private readonly readers = new Map<string, Reader>();
  /** Readers killed or told to exit that have not exited yet: they still count against the cap. */
  private readonly exiting = new Set<Reader>();
  private nextId = 1;
  private closed = false;

  constructor(opts: ReaderPoolOptions) {
    this.o = {
      script: opts.script,
      scriptSha256: opts.scriptSha256,
      home: opts.home ?? homedir(),
      idleMs: opts.idleMs ?? READER_IDLE_MS,
      max: opts.max ?? READER_MAX,
      callTimeoutMs: opts.callTimeoutMs ?? READER_CALL_TIMEOUT_MS,
      rssLimitBytes: opts.rssLimitBytes ?? READER_RSS_LIMIT,
      rssPollMs: opts.rssPollMs ?? READER_RSS_POLL_MS,
      maxReplyBytes: opts.maxReplyBytes ?? READER_MAX_REPLY,
      rssOf: opts.rssOf ?? procRss,
      onEvent: opts.onEvent,
    };
  }

  /** Children alive now, including ones on their way out. */
  get running(): number {
    return this.readers.size + this.exiting.size;
  }

  /** The pid serving a root, if one is running (for tests and logs). */
  pidFor(root: ClaudeRoot): number | undefined {
    return this.readers.get(root.projects)?.pid;
  }

  /** Runs one request in the root's child, starting the child if needed. Never throws. */
  async call(root: ClaudeRoot, req: ReaderRequest): Promise<ReaderReply> {
    if (this.closed) return { ok: false, error: "crashed" };
    const id = this.nextId++;
    const wire = checkRequest({ ...req, id });
    if (!wire) return { ok: false, error: "bad_request" };
    let r = this.readers.get(root.projects);
    if (!r && this.running >= this.o.max) {
      // Make room by stopping the least recently used idle child, and wait for it to be gone: the cap counts
      // every child still alive, so a fifth never runs next to four, even for a moment.
      // A child already on its way out (idle, or killed) is waited for first.
      const leaving = this.exiting.values().next().value;
      const victim = leaving ?? this.evictIdle();
      if (!victim) return { ok: false, error: "busy" };
      await exited(victim.proc, EXIT_GRACE_MS);
      r = this.readers.get(root.projects);
      if (!r && this.running >= this.o.max) return { ok: false, error: "busy" };
    }
    if (this.closed) return { ok: false, error: "crashed" };
    if (!r) {
      r = this.start(root);
      if (!r) return { ok: false, error: "spawn" };
    }
    if (r.queue.length >= READER_MAX_QUEUE) return { ok: false, error: "busy" };
    const reader = r;
    return new Promise((resolve) => {
      reader.queue.push({ id, line: JSON.stringify(wire) + "\n", resolve });
      if (reader.idleTimer) clearTimeout(reader.idleTimer);
      reader.idleTimer = undefined;
      this.pump(reader);
    });
  }

  /** Kills every child. Pending calls resolve `crashed`. */
  close(): void {
    this.closed = true;
    for (const r of [...this.readers.values(), ...this.exiting]) this.kill(r, "close");
  }

  private emit(e: ReaderEvent): void {
    this.o.onEvent?.(e);
  }

  /** Stops the least recently used child with nothing to do, to make room. */
  private evictIdle(): Reader | undefined {
    let lru: Reader | undefined;
    for (const r of this.readers.values()) if (!r.busy && (!lru || r.lastUsed < lru.lastUsed)) lru = r;
    if (lru) this.kill(lru, "evict");
    return lru;
  }

  /** Whether the script on disk is the one this bridge was built with. Read in one go, right before the spawn. */
  private scriptOk(): boolean {
    if (!/^[0-9a-f]{64}$/.test(this.o.scriptSha256)) return false;
    try {
      return createHash("sha256").update(readFileSync(this.o.script)).digest("hex") === this.o.scriptSha256;
    } catch {
      return false;
    }
  }

  private start(root: ClaudeRoot): Reader | undefined {
    if (!this.scriptOk()) {
      this.emit({ kind: "refused", projects: root.projects, why: "hash" });
      return undefined;
    }
    // Read access to the projects dir only, never the config dir itself (it holds `.credentials.json`). Node
    // checks the lexical path, so a symlinked `<configDir>/projects` needs both its own path and its realpath.
    const allow = [this.o.script, join(root.configDir, "projects"), root.projects].map((p) => `--allow-fs-read=${p}`);
    let proc: ChildProcess;
    try {
      proc = spawn(process.execPath, [permissionFlag(), ...allow, this.o.script, "--idle-ms", String(childIdleMs(this.o.idleMs))], {
        // A clean env: no tokens, no NODE_OPTIONS, nothing of the bridge's own. Only where to read from.
        env: { CLAUDE_CONFIG_DIR: root.configDir, HOME: this.o.home },
        cwd: "/",
        stdio: ["pipe", "pipe", "ignore"],
        detached: false,
      });
    } catch {
      return undefined;
    }
    if (proc.pid === undefined) {
      proc.on("error", () => undefined);
      return undefined;
    }
    const r = new Reader(proc, proc.pid);
    r.lastUsed = Date.now();
    this.readers.set(root.projects, r);
    this.emit({ kind: "spawn", pid: r.pid, projects: root.projects });
    proc.on("error", () => undefined);
    proc.stdin?.on("error", () => undefined);
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(r, root, chunk));
    proc.on("exit", (code, signal) => {
      if (r.rssTimer) clearInterval(r.rssTimer);
      if (r.idleTimer) clearTimeout(r.idleTimer);
      this.exiting.delete(r);
      if (this.readers.get(root.projects) === r) this.readers.delete(root.projects);
      r.leaving = true;
      this.failAll(r, "crashed");
      this.emit({ kind: "exit", pid: r.pid, projects: root.projects, code, signal });
    });
    r.rssTimer = setInterval(() => {
      const rss = this.o.rssOf(r.pid);
      if (rss !== null && rss > this.o.rssLimitBytes) this.kill(r, "rss", root);
    }, this.o.rssPollMs);
    r.rssTimer.unref();
    return r;
  }

  private onData(r: Reader, root: ClaudeRoot, chunk: Buffer): void {
    if (r.leaving) return;
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
      const part = chunk.subarray(start, nl);
      const line = r.bufLen === 0 ? part : Buffer.concat([...r.buf, part], r.bufLen + part.length);
      r.buf = [];
      r.bufLen = 0;
      start = nl + 1;
      if (line.length > this.o.maxReplyBytes) return this.kill(r, "too_large", root);
      this.onLine(r, line.toString("utf8"));
      if (r.leaving) return;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      r.buf.push(rest);
      r.bufLen += rest.length;
      if (r.bufLen > this.o.maxReplyBytes) this.kill(r, "too_large", root);
    }
  }

  private onLine(r: Reader, line: string): void {
    let reply: WireReply | undefined;
    try {
      reply = JSON.parse(line) as WireReply;
    } catch {
      reply = undefined;
    }
    const p = r.inflight;
    // A reply for anything but the call in flight means the child is not speaking the protocol.
    if (!p || !reply || typeof reply !== "object" || reply.id !== p.id || typeof reply.ok !== "boolean") return this.kill(r, "protocol");
    clearTimeout(p.timer);
    r.inflight = undefined;
    r.lastUsed = Date.now();
    p.resolve(reply.ok ? { ok: true, value: reply.value } : { ok: false, error: reply.error === "bad_request" ? "bad_request" : "failed" });
    this.pump(r);
  }

  private pump(r: Reader): void {
    if (r.leaving || r.inflight) return;
    const next = r.queue.shift();
    if (!next) {
      r.idleTimer = setTimeout(() => this.retire(r), this.o.idleMs);
      r.idleTimer.unref();
      return;
    }
    const timer = setTimeout(() => this.kill(r, "timeout"), this.o.callTimeoutMs);
    timer.unref();
    r.inflight = { ...next, timer };
    r.proc.stdin?.write(next.line);
  }

  private projectsOf(r: Reader): string {
    for (const [k, v] of this.readers) if (v === r) return k;
    return "";
  }

  /** Idle: close stdin so the child exits by itself; kill it if it has not after a grace period. */
  private retire(r: Reader): void {
    if (r.leaving || r.busy) return;
    const projects = this.projectsOf(r);
    this.leave(r);
    this.emit({ kind: "idle", pid: r.pid, projects });
    r.proc.stdin?.end();
    setTimeout(() => {
      if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill("SIGKILL");
    }, EXIT_GRACE_MS).unref();
  }

  private leave(r: Reader): void {
    r.leaving = true;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    for (const [k, v] of this.readers) if (v === r) this.readers.delete(k);
    if (r.proc.exitCode === null && r.proc.signalCode === null) this.exiting.add(r);
  }

  private kill(r: Reader, why: "timeout" | "rss" | "too_large" | "protocol" | "evict" | "close", root?: ClaudeRoot): void {
    if (r.leaving && why !== "close") return;
    const projects = root?.projects ?? this.projectsOf(r);
    this.leave(r);
    if (r.rssTimer) clearInterval(r.rssTimer);
    this.failAll(r, why === "timeout" || why === "rss" || why === "too_large" ? why : "crashed");
    this.emit({ kind: "kill", pid: r.pid, projects, why });
    // ChildProcess.kill signals exactly this child's pid.
    r.proc.kill("SIGKILL");
  }

  /** The call in flight gets `why`; calls queued behind it get `crashed`. */
  private failAll(r: Reader, why: ReaderError): void {
    const p = r.inflight;
    r.inflight = undefined;
    if (p) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: why });
    }
    for (const q of r.queue.splice(0)) q.resolve({ ok: false, error: "crashed" });
  }
}
