import { execFile } from "node:child_process";

export interface RunResult {
  /** Exit code, or null when the process did not exit normally. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command could not run: not installed, timed out, or another spawn error. */
  error?: "ENOENT" | "timeout" | "other";
}

/** Runs a command with no shell. Injected so tests and the rig can use fake CLIs. */
export type Runner = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<RunResult>;

export const run: Runner = (cmd, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.code === "ENOENT") return resolve({ code: null, stdout, stderr, error: "ENOENT" });
      if (e.killed) return resolve({ code: null, stdout, stderr, error: "timeout" });
      if (typeof e.code === "number") return resolve({ code: e.code, stdout, stderr });
      return resolve({ code: null, stdout, stderr, error: "other" });
    });
  });
