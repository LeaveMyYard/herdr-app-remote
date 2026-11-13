// T + S + V (docs/chatview.md §3a.2, §3a.3): a prompt card only when the transcript's pending tool call (T), the
// host's `blocked` (S) and the screen's prompt block (V) agree. Pure: no I/O.
//
// - permission: a pending `Bash` call whose command is in the block, titled "Do you want to proceed?";
// - question: a pending `AskUserQuestion` with one question; the rows are its options, in order, then the Other row
//   (and "Submit" for a multi-select), then "Chat about this"; its question text is the block's title;
// - question, several (CV9): a pending `AskUserQuestion` with 2 to 4 questions (Claude Code's tabbed question UI). The
//   block's first line is the tab line naming every header in order; the block shows one of the questions (shaped as
//   above, with "Next" for a multi-select that is not the last) or the Submit tab's review. The card is the same on
//   every tab: its id is over the call's questions, not the tab shown;
// - plan: a pending `ExitPlanMode`, the block asking "Would you like to proceed?";
// - other: a block with an Esc footer and no pending call of a kind above (an MCP or edit permission, a dialog the
//   bridge can't classify): the screen's own title and labels;
// - unparsed: the agent is blocked but the screen has no readable option list, or the block does not match the
//   pending call of a kind above: the screen's lines, read-only. Nothing can be pressed on it.
//
// `prompt_id` = sha256 over the tool_use id, the block's title and its ordered labels (§3a.3): a new screen or a new
// tool call is a new id. The same function computes it for the published card and, at answer time, for the screen
// re-read just before pressing; any difference refuses.
import { createHash, createHmac } from "node:crypto";
import { bridgeApi } from "@herdr-remote/protocol";
import type { ClaudeMessage } from "../claude/messages.js";
import { cutBytes, label } from "../chatview/map.js";
import { redact } from "../chatview/redact.js";
import { parseScreen, spaced, squash, type ScreenPrompt } from "./screen.js";

type PromptItem = Extract<bridgeApi.ChatItem, { role: "prompt" }>;
export type PromptKind = PromptItem["kind"];

/** A tool call with no result yet (T). Top-level only: a subagent's calls never show as the main agent's prompt. */
export interface PendingTool {
  id: string;
  name: string;
  input: unknown;
  /** The time of the assistant message that holds it. */
  at: string | null;
}

/** The Other row's label as the pinned Claude Code draws it (H0): "Type something." single, "Type something" multi. */
export const OTHER_SINGLE = "Type something.";
export const OTHER_MULTI = "Type something";
/** The row below the list's rule in AskUserQuestion (H0). Never an answer: not offered on the card. */
export const CHAT_ABOUT = "Chat about this";
export const PERMISSION_TITLE = "Do you want to proceed?";
export const PLAN_TITLE_END = "Would you like to proceed?";
/** The multi-select review step that follows Enter on "Submit" (H0). */
export const REVIEW_TITLE = "Ready to submit your answers?";
export const REVIEW_ROWS = ["Submit answers", "Cancel"] as const;

/** Every top-level tool call with no result, oldest first. */
export function pendingTools(messages: readonly ClaudeMessage[]): PendingTool[] {
  const open = new Map<string, PendingTool>();
  for (const m of messages) {
    if (m.type === "system" || m.parentToolUseId !== null) continue;
    for (const b of m.content) {
      if (m.type === "assistant" && b.type === "tool_use" && !open.has(b.id)) open.set(b.id, { id: b.id, name: b.name, input: b.input, at: m.at });
      else if (m.type === "user" && b.type === "tool_result") open.delete(b.toolUseId);
    }
  }
  return [...open.values()];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The one question of an AskUserQuestion call, or null (none, several, or not the documented shape). */
function oneQuestion(input: unknown): { question: string; header: string | null; multi: boolean; options: { label: string; description: string | null }[] } | null {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length !== 1) return null;
  const q: unknown = input.questions[0];
  if (!isRecord(q) || typeof q.question !== "string" || !Array.isArray(q.options) || q.options.length < 1 || q.options.length > 18) return null;
  const options: { label: string; description: string | null }[] = [];
  for (const o of q.options) {
    if (!isRecord(o) || typeof o.label !== "string") return null;
    options.push({ label: o.label, description: typeof o.description === "string" ? o.description : null });
  }
  return { question: q.question, header: typeof q.header === "string" ? q.header : null, multi: q.multiSelect === true, options };
}

/** One question of an AskUserQuestion call with several (CV9), as the call states it (whitespace runs as one space). */
export interface SeveralQuestion {
  text: string;
  header: string;
  multi: boolean;
  /** The option labels, in order. */
  options: string[];
  descriptions: (string | null)[];
}

/** What a card with several questions is, and where its block is now (CV9). */
export interface Several {
  questions: SeveralQuestion[];
  /** The tab the screen shows: a question's index, or `questions.length` for the Submit tab (the review). */
  tab: number;
  /** Per question, the tab line's mark: ☒ (answered, or a multi-select with a tick) is true, ☐ false. */
  marks: boolean[];
  /** On a single-select question tab: the row the screen marks picked ("Option B ✔"), else null. */
  picked: number | null;
}

/** The questions of an AskUserQuestion call with 2 to 4 of them, or null (not the documented shape). */
function severalQuestions(input: unknown): SeveralQuestion[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length < 2 || input.questions.length > 4) return null;
  const out: SeveralQuestion[] = [];
  for (const q of input.questions as unknown[]) {
    if (!isRecord(q) || typeof q.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options) || q.options.length < 1 || q.options.length > 18) return null;
    const options: string[] = [];
    const descriptions: (string | null)[] = [];
    for (const o of q.options as unknown[]) {
      if (!isRecord(o) || typeof o.label !== "string" || spaced(o.label) === "") return null;
      options.push(spaced(o.label));
      descriptions.push(typeof o.description === "string" ? o.description : null);
    }
    const text = spaced(q.question);
    const header = spaced(q.header);
    if (text === "" || header === "") return null;
    out.push({ text, header, multi: q.multiSelect === true, options, descriptions });
  }
  // A tab is told apart from another only by its question text (the tab line does not show which tab is active).
  if (new Set(out.map((q) => q.text)).size !== out.length) return null;
  return out;
}

/**
 * The tab line of a block with several questions (H0 CV9: "←  ☐ Approach  ☒ Checks  ☐ Target  ✔ Submit  →"): each
 * header in the call's order with its mark, then the Submit tab. The marks, or null when the line is not exactly that.
 */
export function tabMarks(line: string, headers: readonly string[]): boolean[] | null {
  let rest = line;
  if (!rest.startsWith("←  ")) return null;
  rest = rest.slice(3);
  const marks: boolean[] = [];
  for (const h of headers) {
    const mark = rest[0];
    if ((mark !== "☐" && mark !== "☒") || !rest.startsWith(`${mark} ${h}  `)) return null;
    marks.push(mark === "☒");
    rest = rest.slice(`${mark} ${h}  `.length);
  }
  return rest === "✔ Submit  →" ? marks : null;
}

/** The review step's first header line, after the tab line (H0). */
export const REVIEW_HEAD = "Review your answers";
/** The review's warning while a question has no answer (H0 CV9). */
export const REVIEW_UNANSWERED = "⚠ You have not answered all questions";
/** The single-select mark Claude Code adds to the picked row when a question is shown again (H0 CV9: "Nowhere ✔"). */
const PICKED_SUFFIX = " ✔";

/**
 * What a matched card is, before the bridge's own fields (`id`, `rev`, `state`): everything that decides how a choice
 * maps to screen rows. `rows` is the screen's, so the answer path presses against exactly what was matched.
 */
export interface Match {
  kind: PromptKind;
  /** The pending call the block belongs to; null for a generic card with no pending call. */
  toolUseId: string | null;
  prompt: ScreenPrompt | null;
  /** The card's buttons: indexes into `prompt.rows` (question: its options; the Other, Submit and Chat rows are not buttons). */
  buttons: number[];
  /** Question only: the Other row's index, when the card offers Other. */
  otherRow: number | null;
  /** Multi-select only: the Submit row's index. */
  submitRow: number | null;
  multi: boolean;
  /** The id (§3a.3). */
  promptId: string;
  /** CV9: a question card with several questions (null otherwise): the questions, and what the screen shows now. */
  several: Several | null;
  /** The card's fields (what the phone is shown). */
  card: Omit<PromptItem, "id" | "role" | "at" | "rev" | "state" | "prompt_id">;
  at: string | null;
}

/** sha256 over the tool_use id, the title and the ordered labels (multi-select boxes left out: ticking keeps the id). */
export function promptId(toolUseId: string | null, title: string, labels: readonly string[]): string {
  const h = createHash("sha256");
  h.update(`cv7-prompt\0${toolUseId ?? "-"}\0${title}\0${labels.length}`);
  for (const l of labels) h.update(`\0${l}`);
  return h.digest("hex");
}

const promptIdOf = (toolUseId: string | null, p: ScreenPrompt) =>
  promptId(
    toolUseId,
    p.title,
    p.rows.map((r) => r.label),
  );

const optionLabels = (p: ScreenPrompt, rows: readonly number[]) => rows.map((i) => ({ label: label(p.rows[i]!.label, 400) }));
const titleOf = (s: string) => label(s, 400);
const allNumbered = (p: ScreenPrompt) => p.rows.every((r) => r.n !== null && r.check === null);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const hasEsc = (p: ScreenPrompt) => p.footer.some((f) => /\bEsc to cancel\b/.test(f));

/** The first header line of a Bash permission block (H0). */
export const BASH_HEADER = "Bash command";
/** A dashed rule inside a block (H0: around the command of a permission, around a plan). */
const DASHED = /^╌{10,}$/;

/** The header lines between the first two dashed rules, or null when there are not exactly two. */
export function commandRegion(header: readonly string[]): string[] | null {
  const at = header.flatMap((l, i) => (DASHED.test(l) ? [i] : []));
  if (at.length !== 2 || at[1]! - at[0]! < 2) return null;
  return header.slice(at[0]! + 1, at[1]!);
}

/**
 * A block shaped like a prompt the bridge knows (a Bash permission, an AskUserQuestion, a plan approval, the
 * multi-select review). Such a block that no pending top-level call matches (a subagent's prompt, a transcript that
 * lags) is a mismatch: read-only, never a generic card whose buttons would answer something the card doesn't show.
 */
function knownShape(p: ScreenPrompt): boolean {
  return (
    p.header.includes(BASH_HEADER) ||
    p.title === PERMISSION_TITLE ||
    p.title.endsWith(PLAN_TITLE_END) ||
    p.title === REVIEW_TITLE ||
    (p.header[0] ?? "").startsWith("←  ") ||
    p.rows.some((r) => r.label === OTHER_SINGLE || r.label === OTHER_MULTI || r.label === CHAT_ABOUT || (r.n === null && (r.label === "Submit" || r.label === "Next")) || r.check !== null)
  );
}

function permission(t: PendingTool, p: ScreenPrompt): Match | null {
  if (t.name !== "Bash" || !isRecord(t.input) || typeof t.input.command !== "string") return null;
  const cmd = squash(t.input.command);
  if (cmd === "" || p.title !== PERMISSION_TITLE || !allNumbered(p) || !hasEsc(p)) return null;
  // The command as the screen shows it: exactly the lines between the block's two dashed rules (H0), all of it.
  // Equality, not "contains": a longer command on screen (`rm -rf … && cargo test`) is another command.
  if (p.header[0] !== BASH_HEADER) return null;
  const region = commandRegion(p.header);
  if (region === null || squash(region.join("")) !== cmd) return null;
  const buttons = range(p.rows.length);
  return {
    kind: "permission",
    toolUseId: t.id,
    prompt: p,
    buttons,
    otherRow: null,
    submitRow: null,
    multi: false,
    promptId: promptIdOf(t.id, p),
    several: null,
    card: { kind: "permission", title: titleOf(p.title), summary: cutBytes(redact(t.input.command.replace(CONTROLS, " ")), 2000).text.slice(0, 2000), options: optionLabels(p, buttons) },
    at: t.at,
  };
}

function question(t: PendingTool, p: ScreenPrompt): Match | null {
  if (t.name !== "AskUserQuestion") return null;
  const q = oneQuestion(t.input);
  if (!q) return null;
  const k = q.options.length;
  if (spaced(p.title) !== spaced(q.question)) return null;
  // The tab line names the header, and only it (H0): "☐ Approach" (single-select), "←  ☐ Checks  ✔ Submit  →"
  // (multi-select). A tab line of several questions is another call's (CV9).
  const h0 = p.header[0] ?? "";
  if (q.header !== null && !(q.multi ? tabMarks(h0, [spaced(q.header)]) !== null : h0 === `☐ ${spaced(q.header)}` || h0 === `☒ ${spaced(q.header)}`)) return null;
  const rows = p.rows;
  for (let i = 0; i < k; i++) {
    const r = rows[i];
    if (!r || r.n !== i + 1 || r.belowRule || spaced(r.label) !== spaced(q.options[i]!.label)) return null;
    if ((r.check !== null) !== q.multi) return null;
  }
  const other = rows[k];
  if (!other || other.n !== k + 1 || other.belowRule || other.label !== (q.multi ? OTHER_MULTI : OTHER_SINGLE) || (other.check !== null) !== q.multi) return null;
  let next = k + 1;
  let submitRow: number | null = null;
  if (q.multi) {
    const s = rows[next];
    if (!s || s.n !== null || s.label !== "Submit") return null;
    submitRow = next;
    next += 1;
  }
  const chat = rows[next];
  if (!chat || chat.n !== k + 2 || !chat.belowRule || chat.label !== CHAT_ABOUT || chat.check !== null || rows.length !== next + 1) return null;
  const buttons = range(k);
  const text = cutBytes(redact(q.question), 4000).text;
  return {
    kind: "question",
    toolUseId: t.id,
    prompt: p,
    buttons,
    // Other in a multi-select was not recorded (H0): what typing on its box row does is unknown, so it is not offered.
    otherRow: q.multi ? null : k,
    submitRow,
    multi: q.multi,
    promptId: promptIdOf(t.id, p),
    several: null,
    card: {
      kind: "question",
      title: titleOf(q.question),
      questions: [
        {
          text: text.length > 4000 ? text.slice(0, 4000) : text,
          header: q.header === null ? "" : label(q.header, 200),
          multi: q.multi,
          options: q.options.map((o) => ({ label: label(o.label, 400), description: o.description === null ? null : label(o.description, 2000) })),
          other: !q.multi,
        },
      ],
      options: optionLabels(p, buttons),
    },
    at: t.at,
  };
}

/** The id of a card with several questions: over the tool_use id and every question, header and label, in order. */
function severalId(toolUseId: string, qs: readonly SeveralQuestion[]): string {
  return promptId(
    toolUseId,
    "\0several",
    qs.flatMap((q) => [`${q.multi ? "multi" : "single"}\0${q.header}\0${q.text}`, ...q.options]),
  );
}

/**
 * Which question of `qs` the block shows, checked row by row as H0 CV9 recorded it, and the row the screen marks
 * picked; null when the block is not exactly one of them.
 */
function severalTab(qs: readonly SeveralQuestion[], p: ScreenPrompt): { tab: number; picked: number | null } | null {
  const tab = qs.findIndex((q) => q.text === spaced(p.title));
  if (tab < 0) return null;
  const q = qs[tab]!;
  // The header is the tab line, then the question text and nothing else.
  if (spaced(p.header.slice(1).join(" ")) !== q.text) return null;
  const rows = p.rows;
  const k = q.options.length;
  let picked: number | null = null;
  for (let i = 0; i < k; i++) {
    const r = rows[i];
    if (!r || r.n !== i + 1 || r.belowRule || (r.check !== null) !== q.multi) return null;
    let l = spaced(r.label);
    if (!q.multi && l !== q.options[i] && l === `${q.options[i]}${PICKED_SUFFIX}`) {
      if (picked !== null) return null;
      picked = i;
      l = q.options[i]!;
    }
    if (l !== q.options[i]) return null;
  }
  const other = rows[k];
  if (!other || other.n !== k + 1 || other.belowRule || other.label !== (q.multi ? OTHER_MULTI : OTHER_SINGLE) || (other.check !== null) !== q.multi) return null;
  let next = k + 1;
  if (q.multi) {
    // Unticked: a ticked Other holds text the desk typed, which the card does not show.
    if (other.check !== false) return null;
    const s = rows[next];
    if (!s || s.n !== null || s.belowRule || s.label !== (tab === qs.length - 1 ? "Submit" : "Next")) return null;
    next += 1;
  }
  const chat = rows[next];
  if (!chat || chat.n !== k + 2 || !chat.belowRule || chat.label !== CHAT_ABOUT || chat.check !== null || rows.length !== next + 1) return null;
  if (!hasEsc(p)) return null;
  return { tab, picked };
}

/** The Submit tab of a block with several questions: the review step (H0 CV9). */
function isSeveralReview(p: ScreenPrompt): boolean {
  return p.title === REVIEW_TITLE && p.header[1] === REVIEW_HEAD && p.rows.length === 2 && allNumbered(p) && p.rows[0]!.label === REVIEW_ROWS[0] && p.rows[1]!.label === REVIEW_ROWS[1] && !p.rows.some((r) => r.belowRule);
}

/**
 * A pending AskUserQuestion with 2 to 4 questions whose block (any tab) the screen shows (CV9). The card shows every
 * question; the answer path (answer.ts) walks the tabs and checks each step against the screen.
 */
function several(t: PendingTool, p: ScreenPrompt): Match | null {
  if (t.name !== "AskUserQuestion") return null;
  const qs = severalQuestions(t.input);
  if (!qs) return null;
  const marks = tabMarks(p.header[0] ?? "", qs.map((q) => q.header));
  if (!marks) return null;
  let tab: number;
  let picked: number | null = null;
  if (isSeveralReview(p)) tab = qs.length;
  else {
    const at = severalTab(qs, p);
    if (!at) return null;
    ({ tab, picked } = at);
  }
  const input = (t.input as { questions: Record<string, unknown>[] }).questions;
  return {
    kind: "question",
    toolUseId: t.id,
    prompt: p,
    buttons: [],
    otherRow: null,
    submitRow: null,
    multi: false,
    promptId: severalId(t.id, qs),
    several: { questions: qs, tab, marks, picked },
    card: {
      kind: "question",
      title: titleOf(qs[0]!.text),
      questions: qs.map((q, i) => {
        const text = cutBytes(redact(String(input[i]!.question)), 4000).text;
        return {
          text: text.length > 4000 ? text.slice(0, 4000) : text,
          header: label(q.header, 200),
          multi: q.multi,
          options: q.options.map((o, j) => {
            const d = q.descriptions[j] ?? null;
            return { label: label(o, 400), description: d === null ? null : label(d, 2000) };
          }),
          // Other on a multi-select was recorded (H0 CV9) but needs a key sequence of its own: not offered yet.
          other: !q.multi,
        };
      }),
      options: [],
    },
    at: t.at,
  };
}

function plan(t: PendingTool, p: ScreenPrompt): Match | null {
  if (t.name !== "ExitPlanMode" || !p.title.endsWith(PLAN_TITLE_END) || !allNumbered(p)) return null;
  const md = isRecord(t.input) && typeof t.input.plan === "string" ? cutBytes(redact(t.input.plan), bridgeApi.CHATVIEW_MESSAGE_MAX_BYTES).text : undefined;
  const buttons = range(p.rows.length);
  return {
    kind: "plan",
    toolUseId: t.id,
    prompt: p,
    buttons,
    otherRow: null,
    submitRow: null,
    multi: false,
    promptId: promptIdOf(t.id, p),
    several: null,
    card: { kind: "plan", title: titleOf(p.title), ...(md !== undefined ? { plan_md: md } : {}), options: optionLabels(p, buttons) },
    at: t.at,
  };
}

/** Tools whose prompts the bridge knows: a block that doesn't match one of these is never a generic card. */
const KNOWN = new Set(["Bash", "AskUserQuestion", "ExitPlanMode"]);

/** C0 and C1 controls but tab and newline: never in a card's text. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function unparsed(toolUseId: string | null, lines: readonly string[], at: string | null): Match {
  const shown = lines.slice(-60).map((l) => cutBytes(redact(l.replace(CONTROLS, " ")), 400).text.slice(0, 400));
  const id = promptId(toolUseId, "\0unparsed", shown);
  return { kind: "unparsed", toolUseId, prompt: null, buttons: [], otherRow: null, submitRow: null, multi: false, promptId: id, several: null, card: { kind: "unparsed", title: "", options: [], screen_lines: shown }, at };
}

/**
 * The card for a blocked agent (S already holds): from the pending calls (T) and the screen (V). Null when the agent
 * is not blocked on a prompt the phone should show (the caller only asks while S is `blocked`).
 */
export function matchPrompt(pending: readonly PendingTool[], screen: string): Match {
  const v = parseScreen(screen);
  const newest = pending[pending.length - 1] ?? null;
  if (!v.ok) return unparsed(newest?.id ?? null, v.lines, newest?.at ?? null);
  const p = v.prompt;
  const found: Match[] = [];
  for (const t of pending) {
    const m = permission(t, p) ?? question(t, p) ?? several(t, p) ?? plan(t, p);
    if (m) found.push(m);
  }
  // Two calls that both match (the same command twice) can't be told apart: read-only.
  if (found.length === 1) return found[0]!;
  if (found.length > 1) return unparsed(newest?.id ?? null, p.lines, newest?.at ?? null);
  // A known prompt shape that no pending call matched: read-only.
  if (knownShape(p)) return unparsed(newest?.id ?? null, p.lines, newest?.at ?? null);
  const unknown = [...pending].reverse().find((t) => !KNOWN.has(t.name));
  // A pending call of a known kind that the screen doesn't match: a mismatch, not a new kind of prompt.
  if (pending.length > 0 && unknown === undefined) return unparsed(newest!.id, p.lines, newest!.at);
  if (!allNumbered(p) || !hasEsc(p)) return unparsed(unknown?.id ?? null, p.lines, unknown?.at ?? null);
  const toolUseId = unknown?.id ?? null;
  const buttons = range(p.rows.length);
  return {
    kind: "other",
    toolUseId,
    prompt: p,
    buttons,
    otherRow: null,
    submitRow: null,
    multi: false,
    promptId: promptIdOf(toolUseId, p),
    several: null,
    card: { kind: "other", title: titleOf(p.title), options: optionLabels(p, buttons) },
    at: unknown?.at ?? null,
  };
}

/** The multi-select review step (H0: "Review your answers" … "Ready to submit your answers?" / 1. Submit answers / 2. Cancel). */
export function isReview(p: ScreenPrompt, picked: readonly string[]): boolean {
  if (p.title !== REVIEW_TITLE || p.rows.length !== 2 || !allNumbered(p)) return false;
  if (p.rows[0]!.label !== REVIEW_ROWS[0] || p.rows[1]!.label !== REVIEW_ROWS[1]) return false;
  if (!p.header.includes("Review your answers")) return false;
  // The answers it lists: "→ Lint, Typecheck" (the picks, in row order).
  const want = `→ ${picked.map(spaced).join(", ")}`;
  return p.header.filter((h) => h.startsWith("→ ")).map(spaced).join("\n") === want;
}

/**
 * The review of a card with several questions (H0 CV9), listing exactly `answers` (one per question, as the review
 * shows it: the option label, the ticked labels joined with ", ", or the Other text), every tab answered, nothing
 * warned. Compared without whitespace: a long question or answer wraps across lines.
 */
export function isSeveralReviewOf(p: ScreenPrompt, s: Several, answers: readonly string[]): boolean {
  if (!isSeveralReview(p) || answers.length !== s.questions.length) return false;
  const marks = tabMarks(p.header[0] ?? "", s.questions.map((q) => q.header));
  if (!marks || marks.some((m) => !m) || p.header.includes(REVIEW_UNANSWERED)) return false;
  const want = [REVIEW_HEAD, ...s.questions.flatMap((q, i) => [`● ${q.text}`, `→ ${answers[i]!}`]), REVIEW_TITLE];
  return squash(p.header.slice(1).join("")) === squash(want.join(""));
}

/** The HMAC `rev` of a card as published (§3a.3): any change to what the phone is shown is a new rev. */
export function cardRev(key: Buffer, m: Match): string {
  return createHmac("sha256", key).update(m.promptId).update("\0").update(JSON.stringify(m.card)).digest("base64url").slice(0, 32);
}

/** The card item as published. Its id is stable per prompt id, so a re-read of the same prompt is no change. */
export function promptItem(m: Match, rev: string): PromptItem {
  return { id: `prompt-${m.promptId.slice(0, 32)}`, at: m.at, prompt_id: m.promptId, rev, ...m.card, role: "prompt", state: "open" };
}
