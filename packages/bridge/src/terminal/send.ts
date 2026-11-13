// `terminal.send` (S16): the only way a phone types into a terminal. It runs `hc send`, which pastes the text and
// presses Enter, and nothing else: no `exec`, no `run`, no `hc keys`, never `--force` (the one forced send is a
// prompt card's Other answer, prompt/other.ts, behind a confirmed screen).
//
// Capability (`terminal.input`, with its expiry), the rate limits and the audit line are `Security.act`'s; this
// actor only checks the arguments, keeps one send in flight per device, and reads hc's answer.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActResult } from "../hub.js";
import type { Actor } from "../app/act.js";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import type { Runner, RunResult } from "../plugins/exec.js";
import { InFlight, readHc, TIMEOUT_HOLD_MS } from "./hc-act.js";

export { TIMEOUT_HOLD_MS };

export const TERMINAL_SEND = "terminal.send";
/** `hc send` waits for a person at the desktop to pause typing; past this it may still type, so the effect is unknown. */
export const SEND_TIMEOUT_MS = 15_000;

export interface TerminalSendOptions {
  run: Runner;
  binaries?: Binaries;
  timeoutMs?: number;
}

/**
 * The argv for one send. `--` ends the options: without it a text such as `--force` is read as hc's own flag (the
 * rig showed `-x` refused as an unexpected argument). The terminal id already passed {@link bridgeApi.TERMINAL_ID}.
 */
export function sendArgs(terminal: string, text: string): string[] {
  return ["send", "--json", "--", terminal, text];
}

/**
 * hc's error kinds that are refusals before anything was typed: the CLI's own (`usage`, `needs_target`, seen in the
 * rig) and the send method's errors listed by `hc schema` (hc 0.1.19). `blocked`: the program is on a dialog and hc
 * types nothing without `--force`. `unavailable` and `config` stay unknown: the schema doesn't say when they happen.
 */
const REFUSED: Readonly<Record<string, string>> = {
  not_found: "terminal_not_found",
  machine_unknown: "terminal_not_found",
  needs_target: "terminal_not_found",
  finished: "terminal_finished",
  blocked: "terminal_blocked",
  invalid_params: "send_refused",
  status_mismatch: "send_refused",
  usage: "send_refused",
};

/** What one `hc send` came to (see {@link readHc}). */
export function readSend(r: RunResult): ActResult {
  return readHc(r, REFUSED, "send_failed");
}

export interface TerminalSendActor extends Actor {
  /**
   * Kills the `hc send` in flight for a device (every device with no id). Security calls it when a device loses the
   * right to type (revoke, pause, terminal.input off or expired, serve change): hc holds a send while someone types at
   * the desktop (about 3 s after the last key), which is exactly when they may reach for Revoke.
   */
  cancel(deviceId?: string): void;
}

/**
 * The actor for `terminal.send`. A second send from the same device while one is running is refused as `busy`
 * (sends never overlap or queue: a queued one could land after the phone gave up on it).
 */
export function terminalSendActor(o: TerminalSendOptions): TerminalSendActor {
  const inFlight = new InFlight();
  const actor = async (client: Parameters<Actor>[0], kind: string, args: Record<string, unknown>) => {
    if (kind !== TERMINAL_SEND) return undefined;
    const parsed = bridgeApi.TerminalSendArgs.safeParse(args);
    if (!parsed.success) return { ok: false, code: "bad_args" };
    // Security.act only lets an approved device through, so there is always a principal; the fallback is for tests.
    const key = client.principal?.deviceId ?? "";
    const { terminal, text } = parsed.data;
    const bin = (o.binaries ?? DEFAULT_BINARIES).hc;
    const r = await inFlight.run(key, (signal) => o.run(bin, sendArgs(terminal, text), { timeoutMs: o.timeoutMs ?? SEND_TIMEOUT_MS, signal }));
    return r === undefined ? { ok: false, code: "busy" } : readSend(r);
  };
  return Object.assign(actor, { cancel: (deviceId?: string) => inFlight.cancel(deviceId) });
}
