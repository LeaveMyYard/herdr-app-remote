// `act prompt.answer` (CV7, docs/chatview.md §3a.4): answers a native prompt card by pressing keys the bridge derives
// from a verified screen. The phone names the card (`prompt_id`, `rev`) and a choice; it never names keys.
//
//   1. capability, rate limit and audit are `Security.act`'s (`prompt.answer`, 6 per 10 s, refused without Activity);
//      here: one answer at a time per terminal, across all devices;
//   2. the card is the one published now (`prompt_id` and `rev`), and was not answered already;
//   3. the transcript still has the same call pending (T) and the host still says `blocked` (S);
//   4. a fresh `hc read` gives the same `prompt_id` (V); the cursor row is read from it;
//   5. phase A presses only `up`/`down` (and `space` to tick a multi-select row), then the screen is read again and
//      the cursor must be on the expected row of the same prompt; phase B presses `enter` alone. An Other answer
//      moves to the Other row, confirms the field on a fresh read (other.ts) and pastes the text with the one
//      `hc send --force` the bridge has;
//   6. post-check for 2 s: the prompt left the screen, or the call got its result: `ok`; else `unknown_effect`.
//
// Nothing is ever pressed again by itself. Digits are never pressed. Residual risk R6 (§3a.5): `hc keys` and
// `hc send` wait for the desk to be quiet (up to 15 s), so the screen can change between the phase B read and Enter.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActResult } from "../hub.js";
import type { Actor } from "../app/act.js";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import type { Runner, RunResult } from "../plugins/exec.js";
import { readHc } from "../terminal/hc-act.js";
import { isReview, matchPrompt, type Match, type PendingTool } from "./match.js";
import { confirmOtherField, otherSendArgs } from "./other.js";
import { parseScreen, PROMPT_READ_LINES } from "./screen.js";

export const PROMPT_ANSWER = bridgeApi.PROMPT_ANSWER;
/** `hc keys` / `hc send` wait for the desk to pause typing (S16), up to about 15 s. */
export const PRESS_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 4_000;
/** The post-check window (§3a.4 step 6). */
export const POST_CHECK_MS = 2_000;
/** How long to wait for a redraw after a press before reading again. */
export const SETTLE_MS = 150;
/** Prompt ids answered recently, per terminal (a second answer to one is `prompt_gone`). */
const CONSUMED_MAX = 32;

/** The only keys this module presses: arrows and space in phase A, enter in phase B. */
const PHASE_A_KEYS: ReadonlySet<string> = new Set(["up", "down", "space"]);

/** The card published for a terminal now, as matched (prompt/match.ts). */
export interface PublishedPrompt {
  match: Match;
  rev: string;
}

/** What the answer path needs of the chat view topic. */
export interface PromptSource {
  /** The card published now for `terminal`, if any. */
  current(terminal: string): PublishedPrompt | undefined;
  /** T and S now: the pending calls from a fresh transcript read, and whether the host says `blocked`. Null: can't tell. */
  fresh(terminal: string): Promise<{ pending: PendingTool[]; blocked: boolean } | null>;
  /** The card was answered: it is dropped and the topic looks again. */
  answered(terminal: string, promptId: string): void;
}

export interface PromptAnswerOptions {
  run: Runner;
  source: PromptSource;
  binaries?: Binaries;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pressTimeoutMs?: number;
  readTimeoutMs?: number;
  postCheckMs?: number;
}

/** The refusal or result codes of this act (bridge-api PROMPT_ANSWER_CODES, plus hc's own). */
const changed = (audit_label?: string): ActResult => ({ ok: false, code: "prompt_changed", ...(audit_label ? { audit_label } : {}) });
const gone = (audit_label?: string): ActResult => ({ ok: false, code: "prompt_gone", ...(audit_label ? { audit_label } : {}) });

/** hc's refusals before anything was pressed (as for `terminal.keys`); anything else is an unknown effect. */
const KEYS_REFUSED: Readonly<Record<string, string>> = {
  not_found: "prompt_gone",
  machine_unknown: "prompt_gone",
  needs_target: "prompt_gone",
  finished: "prompt_gone",
  blocked: "busy",
  invalid_params: "prompt_changed",
  usage: "prompt_changed",
};
const SEND_REFUSED: Readonly<Record<string, string>> = { ...KEYS_REFUSED, status_mismatch: "prompt_changed" };

/** The Activity words for a card (§3a.4): "a permission prompt", and "option 1 of 3 (Yes)". Never the command. */
function auditLabel(m: Match, detail: string): string {
  const what = m.kind === "permission" ? "a permission prompt" : m.kind === "question" ? "a question" : m.kind === "plan" ? "a plan approval" : "a prompt";
  return `${what}\n${detail}`;
}
/** An option's label for Activity: a permission or plan label is cut at its first colon (the command prefix follows). */
function shownLabel(m: Match, row: number): string {
  const l = m.prompt?.rows[row]?.label ?? "";
  const cut = m.kind === "question" ? l : l.split(":")[0]!;
  return cut.split(" · ")[0]!.trim();
}

/** The arrow keys from row `from` to row `to`. */
const arrows = (from: number, to: number): string[] => Array.from({ length: Math.abs(to - from) }, () => (to > from ? "down" : "up"));

class Aborted extends Error {}

/**
 * The actor for `prompt.answer`. `cancel(deviceId)` stops a device's answer in flight (it lost `prompt.answer`):
 * hc is killed, and the answer stops before its next press.
 */
export interface PromptAnswerActor extends Actor {
  cancel(deviceId?: string): void;
}

export function promptAnswerActor(o: PromptAnswerOptions): PromptAnswerActor {
  const locks = new Set<string>();
  const inflight = new Map<string, Set<AbortController>>();
  const consumed = new Map<string, string[]>();
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bin = () => (o.binaries ?? DEFAULT_BINARIES).hc;

  const actor = async (client: Parameters<Actor>[0], kind: string, args: Record<string, unknown>): Promise<ActResult | undefined> => {
    if (kind !== PROMPT_ANSWER) return undefined;
    const parsed = bridgeApi.PromptAnswerArgs.safeParse(args);
    if (!parsed.success) return { ok: false, code: "bad_args" };
    const a = parsed.data;
    // One answer at a time per terminal, whichever device sends it.
    if (locks.has(a.terminal)) return { ok: false, code: "busy" };
    locks.add(a.terminal);
    const device = client.principal?.deviceId ?? "";
    const ac = new AbortController();
    let set = inflight.get(device);
    if (!set) inflight.set(device, (set = new Set()));
    set.add(ac);
    try {
      return await answer(a, ac.signal);
    } catch (e) {
      if (e instanceof Aborted) return { ok: false, code: "cancelled", unknown_effect: true };
      throw e;
    } finally {
      locks.delete(a.terminal);
      set.delete(ac);
      if (set.size === 0) inflight.delete(device);
    }
  };

  function check(signal: AbortSignal): void {
    if (signal.aborted) throw new Aborted();
  }

  async function read(t: string, signal: AbortSignal): Promise<string | null> {
    check(signal);
    const r = await o.run(bin(), ["read", t, "--lines", String(PROMPT_READ_LINES)], { timeoutMs: o.readTimeoutMs ?? READ_TIMEOUT_MS, signal });
    check(signal);
    return r.code === 0 && !r.error ? r.stdout : null;
  }

  /** Presses phase A keys (arrows, space) or phase B's lone enter. The token lists are this module's own. */
  async function keys(t: string, ks: readonly string[], phase: "A" | "B", signal: AbortSignal): Promise<RunResult> {
    if (phase === "A" ? !ks.every((k) => PHASE_A_KEYS.has(k)) : !(ks.length === 1 && ks[0] === "enter")) throw new Error(`prompt: bad keys for phase ${phase}`);
    check(signal);
    return o.run(bin(), ["keys", "--json", "--", t, ...ks], { timeoutMs: o.pressTimeoutMs ?? PRESS_TIMEOUT_MS, signal });
  }

  /** The prompt on a fresh screen, matched against the pending calls the card was matched with. */
  async function look(t: string, pending: readonly PendingTool[], signal: AbortSignal): Promise<{ text: string; m: Match } | null> {
    const text = await read(t, signal);
    return text === null ? null : { text, m: matchPrompt(pending, text) };
  }

  /** Phase A's verify: the same prompt, the cursor on `row`. */
  const at = (v: { m: Match } | null, id: string, row: number) => v !== null && v.m.promptId === id && v.m.prompt?.cursor === row;

  // The pending calls a card was matched with, for the post-check's re-match of the same screen.
  const pendingFor = new WeakMap<Match, PendingTool[]>();

  /** Step 6: the prompt left the screen (or another took its place), or its call got a result, within the window. */
  async function postCheck(t: string, card: Match, signal: AbortSignal): Promise<boolean> {
    const end = now() + (o.postCheckMs ?? POST_CHECK_MS);
    for (;;) {
      await sleep(SETTLE_MS * 2);
      const text = await read(t, signal);
      if (text !== null && (!parseScreen(text).ok || matchPrompt(pendingFor.get(card) ?? [], text).promptId !== card.promptId)) return true;
      if (card.toolUseId !== null) {
        const f = await o.source.fresh(t);
        check(signal);
        if (f && !f.pending.some((p) => p.id === card.toolUseId)) return true;
      }
      if (now() >= end) return false;
    }
  }

  function consume(t: string, id: string): void {
    const list = consumed.get(t) ?? [];
    list.push(id);
    if (list.length > CONSUMED_MAX) list.shift();
    consumed.set(t, list);
    o.source.answered(t, id);
  }

  /** The result of Enter (or the Other send): hc's verdict, then the post-check. */
  async function settle(t: string, card: Match, r: RunResult, refused: Readonly<Record<string, string>>, label: string, signal: AbortSignal): Promise<ActResult> {
    const res = readHc(r, refused, "unknown_effect");
    if (!res.ok) {
      // A refusal before anything was pressed keeps its code; anything else may have reached the agent.
      return res.unknown_effect ? { ok: false, code: res.code ?? "unknown_effect", unknown_effect: true, audit_label: label } : { ok: false, code: res.code ?? "prompt_changed", audit_label: label };
    }
    try {
      if (await postCheck(t, card, signal)) {
        consume(t, card.promptId);
        return { ok: true, audit_label: label };
      }
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
    }
    return { ok: false, code: "unknown_effect", unknown_effect: true, audit_label: label };
  }

  /** Phase A keys whose own failure leaves nothing decided: hc's code, or `busy` when the desk kept it waiting. */
  function phaseAFailed(r: RunResult, label: string): ActResult | null {
    const res = readHc(r, KEYS_REFUSED, "prompt_changed");
    if (res.ok) return null;
    if (r.error === "aborted") throw new Aborted();
    return { ok: false, code: r.error === "timeout" ? "busy" : res.unknown_effect ? "prompt_changed" : (res.code ?? "prompt_changed"), audit_label: label };
  }

  async function answer(a: bridgeApi.PromptAnswerArgs, signal: AbortSignal): Promise<ActResult> {
    const t = a.terminal;
    // Step 2: the card the phone was shown is the one published now.
    if (consumed.get(t)?.includes(a.prompt_id)) return gone();
    const pub = o.source.current(t);
    if (!pub || pub.match.promptId !== a.prompt_id || pub.rev !== a.rev) return changed();
    const card = pub.match;
    const p0 = card.prompt;
    if (card.kind === "unparsed" || p0 === null) return { ok: false, code: "bad_choice" };
    const c = a.choice;
    // The choice fits the card.
    let label: string;
    if ("option" in c) {
      if (card.multi || c.option >= card.buttons.length) return { ok: false, code: "bad_choice" };
      label = auditLabel(card, `option ${c.option + 1} of ${card.buttons.length} (${shownLabel(card, card.buttons[c.option]!)})`);
    } else if ("picks" in c) {
      if (!card.multi || card.submitRow === null || c.picks.some((i) => i >= card.buttons.length)) return { ok: false, code: "bad_choice" };
      const sorted = [...c.picks].sort((x, y) => x - y);
      label = auditLabel(card, `options ${sorted.map((i) => i + 1).join(", ")} of ${card.buttons.length} (${sorted.map((i) => shownLabel(card, card.buttons[i]!)).join(", ")})`);
    } else {
      if (card.otherRow === null || card.toolUseId === null) return { ok: false, code: "bad_choice" };
      label = auditLabel(card, `own answer (${[...c.other].length} chars)`);
    }

    // Step 3: T and S now.
    const f = await o.source.fresh(t);
    check(signal);
    const pending = f?.pending ?? [];
    pendingFor.set(card, pending);
    const tOk = f !== null && f.blocked && (card.toolUseId === null ? true : pending.some((p) => p.id === card.toolUseId));
    // Step 4: the screen now.
    const v0 = await look(t, pending, signal);
    if (v0 === null) return changed(label);
    if (!parseScreen(v0.text).ok) return gone(label);
    if (!tOk || v0.m.promptId !== card.promptId || v0.m.prompt === null) return changed(label);
    const p = v0.m.prompt;
    const m = v0.m;
    pendingFor.set(m, pending);

    if ("option" in c) {
      const row = m.buttons[c.option]!;
      // Phase A: arrows only, then the cursor must be on that row of the same prompt.
      const ks = arrows(p.cursor, row);
      if (ks.length > 0) {
        const fail = phaseAFailed(await keys(t, ks, "A", signal), label);
        if (fail) return fail;
        await sleep(SETTLE_MS);
        if (!at(await look(t, pending, signal), card.promptId, row)) return changed(label);
      }
      // Phase B: Enter alone.
      return settle(t, m, await keys(t, ["enter"], "B", signal), KEYS_REFUSED, label, signal);
    }

    if ("picks" in c) {
      const want = new Set(c.picks.map((i) => m.buttons[i]!));
      // The Other box must stay empty: typing there was not recorded (H0).
      if (m.otherRow !== null || p.rows.some((r, i) => r.check === true && !m.buttons.includes(i))) return changed(label);
      let cur = p.cursor;
      let marks = p.rows.map((r) => r.check);
      // Phase A, one row at a time: move, tick, and verify the cursor and the box.
      for (const row of m.buttons) {
        if ((marks[row] === true) === want.has(row)) continue;
        const fail = phaseAFailed(await keys(t, [...arrows(cur, row), "space"], "A", signal), label);
        if (fail) return fail;
        await sleep(SETTLE_MS);
        const v = await look(t, pending, signal);
        if (!at(v, card.promptId, row) || v!.m.prompt!.rows[row]!.check !== want.has(row)) return changed(label);
        cur = row;
        marks = v!.m.prompt!.rows.map((r) => r.check);
      }
      // Then to Submit; every box must read as picked.
      const submit = m.submitRow!;
      const toSubmit = arrows(cur, submit);
      if (toSubmit.length > 0) {
        const fail = phaseAFailed(await keys(t, toSubmit, "A", signal), label);
        if (fail) return fail;
        await sleep(SETTLE_MS);
      }
      const v = await look(t, pending, signal);
      if (!at(v, card.promptId, submit)) return changed(label);
      const rows = v!.m.prompt!.rows;
      if (!m.buttons.every((i) => rows[i]!.check === want.has(i)) || rows[m.buttons.length]!.check !== false) return changed(label);
      // Phase B, first Enter: Submit opens the review step (H0); nothing is decided yet.
      const r1 = await keys(t, ["enter"], "B", signal);
      const r1res = readHc(r1, KEYS_REFUSED, "unknown_effect");
      if (!r1res.ok) return r1res.unknown_effect ? { ok: false, code: r1res.code ?? "unknown_effect", unknown_effect: true, audit_label: label } : { ok: false, code: r1res.code ?? "prompt_changed", audit_label: label };
      const picked = m.buttons.filter((i) => want.has(i)).map((i) => p.rows[i]!.label);
      // The review must list exactly the picks, with the cursor on "Submit answers".
      const end = now() + (o.postCheckMs ?? POST_CHECK_MS);
      let review: { text: string } | null = null;
      for (;;) {
        await sleep(SETTLE_MS);
        const text = await read(t, signal);
        const rv = text === null ? null : parseScreen(text);
        if (rv?.ok && isReview(rv.prompt, picked) && rv.prompt.cursor === 0) {
          review = { text: text! };
          break;
        }
        if (now() >= end) break;
      }
      // Enter on Submit was pressed, but the answer is only sent from the review: nothing was decided.
      if (review === null) return changed(label);
      // The post-check watches the review screen leave, or the original call's result.
      const reviewCard: Match = { ...m, promptId: matchPrompt([], review.text).promptId };
      pendingFor.set(reviewCard, []);
      // Phase B, second Enter: "Submit answers".
      const r2 = await keys(t, ["enter"], "B", signal);
      const res = await settle(t, reviewCard, r2, KEYS_REFUSED, label, signal);
      if (res.ok) consume(t, card.promptId);
      return res;
    }

    // Other: phase A to the Other row, a fresh read that confirms the field, then the one forced send.
    const row = m.otherRow!;
    const ks = arrows(p.cursor, row);
    if (ks.length > 0) {
      const fail = phaseAFailed(await keys(t, ks, "A", signal), label);
      if (fail) return fail;
      await sleep(SETTLE_MS);
    }
    const fresh = await read(t, signal);
    const conf = fresh === null ? null : confirmOtherField(t, fresh, { promptId: card.promptId, toolUseId: card.toolUseId!, pending }, now());
    if (conf === null) return changed(label);
    check(signal);
    const argv = otherSendArgs(conf, t, card.promptId, c.other, now());
    const r = await o.run(bin(), argv, { timeoutMs: o.pressTimeoutMs ?? PRESS_TIMEOUT_MS, signal });
    return settle(t, m, r, SEND_REFUSED, label, signal);
  }

  return Object.assign(actor, {
    cancel: (deviceId?: string) => {
      for (const [d, set] of inflight) if (deviceId === undefined || d === deviceId) for (const ac of set) ac.abort();
    },
  });
}
