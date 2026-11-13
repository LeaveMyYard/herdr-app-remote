// The one place the bridge ever runs `hc send --force` (CV7, binding decision of the main session).
//
// `hc send` refuses while the terminal is blocked on a dialog (kind `blocked`); the rig showed that `--force` on
// AskUserQuestion's Other row ("Type something.") pastes the text and answers (H0, manifest `keys.other`). `--force`
// skips that refusal, so it is fenced in here:
//
// 1. Only the Other answer of a single-select question card reaches this file (prompt/answer.ts), or (CV9) the Other
//    answer of one single-select question of a card with several, for that question's own field.
// 2. `confirmOtherField` takes a fresh `hc read` made after phase A moved the cursor, and returns a confirmation
//    only when that screen is the same prompt (same `prompt_id`, recomputed) with the cursor on its Other row, shaped
//    exactly as the H0 recording `ask-other` shows it: the row right after the question's own options, labelled
//    "Type something.", with "Chat about this" below the list's rule. With several questions (CV9) the screen must
//    also show that very question's tab (recording `askq-q3-on-other`), and the confirmation names the question.
// 3. `otherSendArgs` builds the `--force` argv only from such a confirmation: one this module made (a WeakSet, so a
//    look-alike object is refused), for the same terminal and prompt, used once, and no older than a few seconds.
//
// Composer sends (`terminal.send`), option presses, Stop and every refusal never reach here; tests pin that.
import { bridgeApi } from "@herdr-remote/protocol";
import { matchPrompt, OTHER_SINGLE, type PendingTool } from "./match.js";

/** A confirmation older than this is refused: the screen it vouches for is too old. */
export const OTHER_CONFIRM_MAX_MS = 3_000;

declare const CONFIRMED_BRAND: unique symbol;
/** Proof that the Other field of prompt `promptId` in `terminal` was the active row on a fresh screen. */
export interface OtherFieldConfirmation {
  readonly terminal: string;
  readonly promptId: string;
  /** CV9: the question (of a card with several) whose field it is; null for a one-question card. */
  readonly question: number | null;
  readonly at: number;
  readonly [CONFIRMED_BRAND]: true;
}

/** Confirmations this module made and nobody used yet. */
const issued = new WeakSet<object>();

/**
 * A confirmation that `screen` (a fresh `hc read` of `terminal`) shows prompt `promptId`, belonging to pending call
 * `toolUseId`, with the cursor on its Other row; null otherwise. `question` (CV9): the field is that question's of a
 * card with several, and the screen must show its tab; absent for a one-question card.
 */
export function confirmOtherField(
  terminal: string,
  screen: string,
  expected: { promptId: string; toolUseId: string; pending: readonly PendingTool[]; question?: number },
  now: number,
): OtherFieldConfirmation | null {
  const m = matchPrompt(expected.pending, screen);
  if (m.kind !== "question" || m.toolUseId !== expected.toolUseId || m.promptId !== expected.promptId) return null;
  const p = m.prompt;
  if (!p) return null;
  let k: number;
  const question = expected.question ?? null;
  if (question === null) {
    // A multi-select never gets here: its card has no Other row (`otherRow` null), pinned in match.test.ts.
    if (m.several !== null || m.otherRow === null) return null;
    k = m.buttons.length;
    if (m.otherRow !== k) return null;
  } else {
    // Several questions: the screen shows that question's tab, a single-select one (its card offers Other).
    const s = m.several;
    const q = s?.questions[question];
    if (!s || !q || q.multi || s.tab !== question) return null;
    k = q.options.length;
  }
  // The H0 shape: Other is row k (right after the k options) and the cursor is on it. "Chat about this" below a rule as
  // the last row is already required by match.ts's question() and several() (pinned there), so it is not checked twice.
  if (p.cursor !== k) return null;
  const row = p.rows[k];
  if (!row || row.label !== OTHER_SINGLE || row.n !== k + 1 || row.check !== null || row.belowRule) return null;
  if (!p.footer.some((f) => f.startsWith("Enter to select"))) return null;
  const c = Object.freeze({ terminal, promptId: expected.promptId, question, at: now }) as OtherFieldConfirmation;
  issued.add(c);
  return c;
}

/**
 * The argv of the one `hc send --force`: the Other text into the confirmed field. Throws (nothing runs) unless `c`
 * is an unused confirmation from {@link confirmOtherField} for this terminal, prompt and question (null: a
 * one-question card), made within {@link OTHER_CONFIRM_MAX_MS}, and the text passes the Other rules. `--` ends hc's
 * options, as for every send.
 */
export function otherSendArgs(c: OtherFieldConfirmation, terminal: string, promptId: string, text: string, now: number, question: number | null = null): string[] {
  if (!issued.has(c)) throw new Error("other: no confirmation of the Other field");
  issued.delete(c);
  if (c.terminal !== terminal || c.promptId !== promptId) throw new Error("other: the confirmation is for another prompt");
  if (c.question !== question) throw new Error("other: the confirmation is for another question");
  if (now < c.at || now - c.at > OTHER_CONFIRM_MAX_MS) throw new Error("other: the confirmation is too old");
  if (!bridgeApi.TERMINAL_ID.test(terminal)) throw new Error("other: bad terminal");
  const ok = bridgeApi.PromptChoice.safeParse({ other: text });
  if (!ok.success) throw new Error("other: the text breaks the Other rules");
  return ["send", "--json", "--force", "--", terminal, text];
}
