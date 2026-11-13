// `act agent.stop` (CV8, docs/chatview.md §3a.6): presses Esc once in a working Claude Code agent. The phone names the
// terminal and nothing else; the key is this module's own, never the phone's.
//
//   1. capability (`prompt.answer`, off by default, expires), rate limit and audit are `Security.act`'s (refused while
//      Activity can't be written); here: the per-terminal lock shared with `prompt.answer` (one press sequence at a
//      time per terminal, across devices) and a 3 s per-terminal cooldown. The rig shows two Escs 300 ms apart on an
//      idle agent open Rewind, while one second Esc 0.3 to 3.5 s after an interrupt does not; the 3 s is a margin
//      against Stop's Esc pairing with another, not a measured window;
//   2. S: the host says the agent is `working` (not `blocked`), and no prompt card is published;
//   3. V: a fresh `hc read` shows no prompt block, the composer holds no desk draft, and Claude Code's own footer says
//      "esc to interrupt" (the H0 rig recording `stop-working-*`): Esc on a dialog cancels it
//      (`stop-permission-after-esc`), so a prompt on screen refuses with nothing pressed; a draft hides the footer hint
//      (`stop-working-draft`) and hc would hold the press for it, so it is `desk_draft`; S is checked again after the read;
//   4. `hc keys esc`, alone, timed: a press hc held over 1 s waited for the desk (S16's quiet rule), so the screen may
//      have changed meanwhile: `unknown_effect` ("held N s while the desk was typing");
//   5. post-check for 2 s: the footer no longer says "esc to interrupt": `ok`; else `unknown_effect`.
//
// Never `hc send`, never `--force` (force.test.ts pins it). Nothing is ever pressed again by itself.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActResult } from "../hub.js";
import type { Actor } from "../app/act.js";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import type { Runner, RunResult } from "../plugins/exec.js";
import { readHc, TIMEOUT_HOLD_MS } from "../terminal/hc-act.js";
import { HELD_MS, POST_CHECK_MS, PRESS_TIMEOUT_MS, READ_TIMEOUT_MS, SETTLE_MS } from "./answer.js";
import { TerminalLocks } from "./lock.js";
import { parseScreen, PROMPT_READ_LINES, screenLines } from "./screen.js";

export const AGENT_STOP = bridgeApi.AGENT_STOP;
export const STOP_COOLDOWN_MS = bridgeApi.STOP_COOLDOWN_MS;
/** The one key Stop presses (H0 rig: Esc interrupts Claude Code 2.1.323 while it streams or runs a tool). */
const STOP_KEYS: readonly string[] = Object.freeze(["esc"]);
/** Claude Code's footer segment while Esc interrupts it (rig, `stop-working-stream`, `stop-working-tool`). */
export const INTERRUPT_HINT = "esc to interrupt";

/** What Stop needs of the chat view (chatview/topic.ts). */
export interface StopSource {
  /**
   * S now, from the host topic for a terminal whose chat view is open and bound to a proved Claude session (null
   * otherwise): `working` and `blocked` as the host says them.
   */
  state(terminal: string): { working: boolean; blocked: boolean } | null;
  /** A prompt card is published for `terminal` now. */
  hasCard(terminal: string): boolean;
}

export interface AgentStopOptions {
  run: Runner;
  source: StopSource;
  /** Shared with `prompt.answer`. */
  locks: TerminalLocks;
  binaries?: Binaries;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pressTimeoutMs?: number;
  readTimeoutMs?: number;
  postCheckMs?: number;
  heldMs?: number;
  cooldownMs?: number;
  /** After a timed-out or killed press, the lock is kept this long. Default {@link TIMEOUT_HOLD_MS}. */
  holdMs?: number;
}

/**
 * Whether a screen is Claude Code working with Esc as its interrupt: no prompt block, and the last line (the footer
 * under the composer) has the segment "esc to interrupt". Anything else is not (fail closed).
 */
export function interruptible(screen: string): boolean {
  if (parseScreen(screen).ok) return false;
  const lines = screenLines(screen).filter((l) => l.trim() !== "");
  const footer = lines[lines.length - 1];
  if (footer === undefined) return false;
  return footer.split(" · ").some((seg) => seg.trim() === INTERRUPT_HINT);
}

/** A full-width rule of Claude Code's composer box. */
const RULE = /^ *─{20,} *$/;

/**
 * Whether the composer (the lines between the last two full-width rules) holds text: a desk draft. Null when no
 * composer box can be found (the caller refuses: fail closed).
 */
export function composerDraft(screen: string): boolean | null {
  const lines = screenLines(screen);
  const rules: number[] = [];
  for (let i = lines.length - 1; i >= 0 && rules.length < 2; i--) if (RULE.test(lines[i]!)) rules.push(i);
  if (rules.length < 2) return null;
  const inner = lines.slice(rules[1]! + 1, rules[0]!);
  if (inner.length === 0 || !inner[0]!.startsWith("❯")) return null;
  return inner.map((l, i) => (i === 0 ? l.slice(1) : l)).some((l) => l.trim() !== "");
}

/** hc's refusals before anything was pressed; anything else may have pressed (`unknown_effect`). */
const KEYS_REFUSED: Readonly<Record<string, string>> = {
  not_found: "not_working",
  machine_unknown: "not_working",
  needs_target: "not_working",
  finished: "not_working",
  blocked: "prompt_open",
  invalid_params: "failed",
  usage: "failed",
};

export interface AgentStopActor extends Actor {
  /** Stops a device's Stop in flight (it lost `prompt.answer`): hc is killed. */
  cancel(deviceId?: string): void;
}

export function agentStopActor(o: AgentStopOptions): AgentStopActor {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bin = () => (o.binaries ?? DEFAULT_BINARIES).hc;
  /** Per terminal: no Stop before this time. */
  const coolUntil = new Map<string, number>();
  const inflight = new Map<string, Set<AbortController>>();

  async function read(t: string, signal: AbortSignal): Promise<string | null> {
    const r = await o.run(bin(), ["read", t, "--lines", String(PROMPT_READ_LINES)], { timeoutMs: o.readTimeoutMs ?? READ_TIMEOUT_MS, signal });
    return r.code === 0 && !r.error ? r.stdout : null;
  }

  /** S and the card, as a refusal or null. */
  function refuseByState(t: string): ActResult | null {
    const s = o.source.state(t);
    if (s === null) return { ok: false, code: "not_open" };
    if (s.blocked || o.source.hasCard(t)) return { ok: false, code: "prompt_open" };
    if (!s.working) return { ok: false, code: "not_working" };
    return null;
  }

  async function stop(t: string, signal: AbortSignal): Promise<ActResult> {
    const until = coolUntil.get(t);
    if (until !== undefined && now() < until) return { ok: false, code: "cooldown" };
    const s0 = refuseByState(t);
    if (s0) return s0;
    // V: a fresh screen, read before the press (two-phase: read, then press).
    const screen = await read(t, signal);
    if (signal.aborted) return { ok: false, code: "cancelled" };
    if (screen === null) return { ok: false, code: "screen_unreadable" };
    if (parseScreen(screen).ok) return { ok: false, code: "prompt_open" };
    const draft = composerDraft(screen);
    if (draft === true) return { ok: false, code: "desk_draft" };
    if (draft === null || !interruptible(screen)) return { ok: false, code: "not_working" };
    // S again: the read took time.
    const s1 = refuseByState(t);
    if (s1) return s1;
    // From here Esc may reach the agent: the cooldown runs from now, and again from the end of the press.
    coolUntil.set(t, now() + (o.cooldownMs ?? STOP_COOLDOWN_MS));
    const t0 = now();
    const r: RunResult = await o.run(bin(), ["keys", "--json", "--", t, ...STOP_KEYS], { timeoutMs: o.pressTimeoutMs ?? PRESS_TIMEOUT_MS, signal });
    const ms = Math.max(0, now() - t0);
    coolUntil.set(t, now() + (o.cooldownMs ?? STOP_COOLDOWN_MS));
    const res = readHc(r, KEYS_REFUSED, "unknown_effect");
    if (!res.ok) {
      // Refused before acting: no Esc went, so no cooldown either.
      if (!res.unknown_effect) coolUntil.delete(t);
      return res;
    }
    // Held by the desk: the screen may have changed before Esc landed (a prompt it cancelled, the composer).
    if (ms > (o.heldMs ?? HELD_MS)) return { ok: false, code: "unknown_effect", unknown_effect: true, audit_label: `held ${Math.round(ms / 1000)} s while the desk was typing` };
    // Post-check: the footer no longer offers "esc to interrupt".
    const end = now() + (o.postCheckMs ?? POST_CHECK_MS);
    for (;;) {
      await sleep(SETTLE_MS * 2);
      if (signal.aborted) break;
      const after = await read(t, signal);
      if (after !== null && !interruptible(after)) return { ok: true };
      if (now() >= end) break;
    }
    return { ok: false, code: "unknown_effect", unknown_effect: true };
  }

  const actor = async (client: Parameters<Actor>[0], kind: string, args: Record<string, unknown>): Promise<ActResult | undefined> => {
    if (kind !== AGENT_STOP) return undefined;
    const parsed = bridgeApi.AgentStopArgs.safeParse(args);
    if (!parsed.success) return { ok: false, code: "bad_args" };
    const t = parsed.data.terminal;
    if (!o.locks.take(t)) return { ok: false, code: "busy" };
    const device = client.principal?.deviceId ?? "";
    const ac = new AbortController();
    let set = inflight.get(device);
    if (!set) inflight.set(device, (set = new Set()));
    set.add(ac);
    let res: ActResult | undefined;
    try {
      res = await stop(t, ac.signal);
      return res;
    } finally {
      // A timed-out or killed hc is still being killed (SIGKILL 0.5 s after TERM) and may yet press Esc: the terminal
      // stays locked until that is over, so an answer can't start under it (as `InFlight` does for typing).
      if (res?.code === "timeout" || res?.code === "cancelled") setTimeout(() => o.locks.release(t), o.holdMs ?? TIMEOUT_HOLD_MS).unref();
      else o.locks.release(t);
      set.delete(ac);
      if (set.size === 0) inflight.delete(device);
    }
  };

  return Object.assign(actor, {
    cancel: (deviceId?: string) => {
      for (const [d, set] of inflight) if (deviceId === undefined || d === deviceId) for (const ac of set) ac.abort();
    },
  });
}
