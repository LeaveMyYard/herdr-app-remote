import { spawn } from "node:child_process";

export interface RunResult {
  /** Exit code, or null when the process did not exit normally. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not run: not installed, timed out, or another spawn error. */
  error?: "ENOENT" | "timeout" | "aborted" | "other";
}

/** Runs a command with no shell. Injected so tests and the rig can use fake CLIs. */
export type Runner = (cmd: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;
/** After SIGTERM a process gets this long before SIGKILL. */
const KILL_GRACE_MS = 500;

/**
 * Owns its timeout: on expiry it resolves `timeout` straight away, sends SIGTERM and then SIGKILL, so a CLI
 * that ignores TERM can't hold the caller (and the plugins topic) hostage.
 */
export const run: Runner = (cmd, args, { timeoutMs, signal }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: RunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    // Already aborted: nothing is started at all.
    if (signal?.aborted) return resolve({ code: null, stdout, stderr, error: "aborted" });
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ code: null, stdout, stderr, error: "other" });
    }
    const stop = (error: "timeout" | "aborted") => {
      finish({ code: null, stdout, stderr, error });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    // Aborting (S16: the device lost terminal.input mid-send) kills the command the same way a timeout does.
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const take = (which: "out" | "err") => (chunk: Buffer) => {
      if (which === "out") stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
      else stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    child.on("error", (e: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, error: e.code === "ENOENT" ? "ENOENT" : "other" }));
    child.on("close", (code) => finish({ code, stdout, stderr, ...(code === null ? { error: "other" as const } : {}) }));
  });
