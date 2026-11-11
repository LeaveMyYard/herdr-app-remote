// What `terminal.send` (S16) and `terminal.keys` (S16b) share: reading one `hc` call's outcome, and keeping one call
// in flight per device that can be killed when the device loses the right to type. One copy, so a fix to the hold or
// cancel logic reaches both.
import type { ActResult } from "../hub.js";
import type { RunResult } from "../plugins/exec.js";

/** After a timeout or abort the runner kills hc (SIGTERM, SIGKILL 0.5 s later); no new call starts before this has passed. */
export const TIMEOUT_HOLD_MS = 1_000;

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What one `hc <cmd> --json` came to. Exit 0 with a JSON object and no `error` is the only success. A refusal is
 * `{"error":{kind,...}}` on stderr (seen in the rig); a kind in `refused` means nothing happened yet. Anything else
 * (another exit, kind or output, a timeout, a kill) may have reached the terminal: `failed` with `unknown_effect`.
 */
export function readHc(r: RunResult, refused: Readonly<Record<string, string>>, failed: string): ActResult {
  if (r.error === "ENOENT") return { ok: false, code: "hc_missing" };
  if (r.error === "timeout") return { ok: false, code: "timeout", unknown_effect: true };
  // Killed because the device lost the capability mid-call: hc may already have handed it to the core.
  if (r.error === "aborted") return { ok: false, code: "cancelled", unknown_effect: true };
  if (r.error || r.code === null) return { ok: false, code: failed, unknown_effect: true };
  if (r.code === 0) {
    const out = jsonObject(r.stdout);
    return out && out.error === undefined ? { ok: true } : { ok: false, code: failed, unknown_effect: true };
  }
  const err = jsonObject(r.stderr)?.error;
  const kind = err !== null && typeof err === "object" ? (err as { kind?: unknown }).kind : undefined;
  const code = typeof kind === "string" && Object.prototype.hasOwnProperty.call(refused, kind) ? refused[kind] : undefined;
  return code ? { ok: false, code } : { ok: false, code: failed, unknown_effect: true };
}

/**
 * One hc call in flight per key (a device id). A second while one runs is refused (`busy`): calls never overlap or
 * queue, since a queued one could land after the phone gave up on it. A timed-out or killed hc is still being killed
 * for {@link TIMEOUT_HOLD_MS}; the key stays busy until then.
 */
export class InFlight {
  private readonly calls = new Map<string, AbortController>();

  /** Runs `fn` unless `key` is busy (then undefined). */
  async run(key: string, fn: (signal: AbortSignal) => Promise<RunResult>): Promise<RunResult | undefined> {
    if (this.calls.has(key)) return undefined;
    const ac = new AbortController();
    this.calls.set(key, ac);
    let r: RunResult | undefined;
    try {
      r = await fn(ac.signal);
      return r;
    } finally {
      const release = () => {
        if (this.calls.get(key) === ac) this.calls.delete(key);
      };
      if (r?.error === "timeout" || r?.error === "aborted") setTimeout(release, TIMEOUT_HOLD_MS).unref();
      else release();
    }
  }

  /** Kills the call in flight for `key` (every key with none). */
  cancel(key?: string): void {
    for (const [k, ac] of this.calls) if (key === undefined || k === key) ac.abort();
  }
}
