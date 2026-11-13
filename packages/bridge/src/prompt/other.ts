// The one place the bridge ever runs `hc send --force` (CV7, binding decision of the main session).
//
// `hc send` refuses while the terminal is blocked on a dialog (kind `blocked`); the rig showed that `--force` on
// AskUserQuestion's Other row ("Type something.") pastes the text and answers (H0, manifest `keys.other`). `--force`
// skips that refusal, so it is fenced in here:
//
// 1. Only the Other answer of a single-select question card reaches this file (prompt/answer.ts).
// 2. `confirmOtherField` takes a fresh `hc read` made after phase A moved the cursor, and returns a confirmation
//    only when that screen is the same prompt (same `prompt_id`, recomputed) with the cursor on its Other row, shaped
//    exactly as the H0 recording `ask-other` shows it: the row right after the question's own options, labelled
//    "Type something.", with "Chat about this" below the list's rule.
// 3. `otherSendArgs` builds the `--force` argv only from such a confirmation: one this module made (a WeakSet, so a
//    look-alike object is refused), for the same terminal and prompt, used once, and no older than a few seconds.
//
// Composer sends (`terminal.send`), option presses, Stop and every refusal never reach here; tests pin that.
import { bridgeApi } from "@herdr-remote/protocol";
import { matchPrompt, OTHER_SINGLE, CHAT_ABOUT, type PendingTool } from "./match.js";

/** A confirmation older than this is refused: the screen it vouches for is too old. */
export const OTHER_CONFIRM_MAX_MS = 3_000;

declare const CONFIRMED_BRAND: unique symbol;
/** Proof that the Other field of prompt `promptId` in `terminal` was the active row on a fresh screen. */
export interface OtherFieldConfirmation {
  readonly terminal: string;
  readonly promptId: string;
  readonly at: number;
  readonly [CONFIRMED_BRAND]: true;
}

/** Confirmations this module made and nobody used yet. */
const issued = new WeakSet<object>();

/**
 * A confirmation that `screen` (a fresh `hc read` of `terminal`) shows prompt `promptId`, belonging to pending call
 * `toolUseId`, with the cursor on its Other row; null otherwise.
 */
export function confirmOtherField(
  terminal: string,
  screen: string,
  expected: { promptId: string; toolUseId: string; pending: readonly PendingTool[] },
  now: number,
): OtherFieldConfirmation | null {
  const m = matchPrompt(expected.pending, screen);
  if (m.kind !== "question" || m.multi || m.toolUseId !== expected.toolUseId || m.promptId !== expected.promptId) return null;
  const p = m.prompt;
  if (!p || m.otherRow === null) return null;
  const k = m.buttons.length;
  // The H0 shape: Other is row k (right after the k options), the cursor is on it, "Chat about this" follows below a rule.
  if (m.otherRow !== k || p.cursor !== k) return null;
  const row = p.rows[k];
  const chat = p.rows[k + 1];
  if (!row || row.label !== OTHER_SINGLE || row.n !== k + 1 || row.check !== null || row.belowRule) return null;
  if (!chat || chat.label !== CHAT_ABOUT || !chat.belowRule || p.rows.length !== k + 2) return null;
  if (!p.footer.some((f) => f.startsWith("Enter to select"))) return null;
  const c = Object.freeze({ terminal, promptId: expected.promptId, at: now }) as OtherFieldConfirmation;
  issued.add(c);
  return c;
}

/**
 * The argv of the one `hc send --force`: the Other text into the confirmed field. Throws (nothing runs) unless `c`
 * is an unused confirmation from {@link confirmOtherField} for this terminal and prompt, made within
 * {@link OTHER_CONFIRM_MAX_MS}, and the text passes the Other rules. `--` ends hc's options, as for every send.
 */
export function otherSendArgs(c: OtherFieldConfirmation, terminal: string, promptId: string, text: string, now: number): string[] {
  if (!issued.has(c)) throw new Error("other: no confirmation of the Other field");
  issued.delete(c);
  if (c.terminal !== terminal || c.promptId !== promptId) throw new Error("other: the confirmation is for another prompt");
  if (now < c.at || now - c.at > OTHER_CONFIRM_MAX_MS) throw new Error("other: the confirmation is too old");
  if (!bridgeApi.TERMINAL_ID.test(terminal)) throw new Error("other: bad terminal");
  const ok = bridgeApi.PromptChoice.safeParse({ other: text });
  if (!ok.success) throw new Error("other: the text breaks the Other rules");
  return ["send", "--json", "--force", "--", terminal, text];
}
