// T + S + V (docs/chatview.md §3a.2, §3a.3): a prompt card only when the transcript's pending tool call (T), the
// host's `blocked` (S) and the screen's prompt block (V) agree. Pure: no I/O.
//
// - permission: a pending `Bash` call whose command is in the block, titled "Do you want to proceed?";
// - question: a pending `AskUserQuestion` with one question; the rows are its options, in order, then the Other row
//   (and "Submit" for a multi-select), then "Chat about this"; its question text is the block's title;
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
    p.rows.some((r) => r.label === OTHER_SINGLE || r.label === OTHER_MULTI || r.label === CHAT_ABOUT || (r.n === null && r.label === "Submit") || r.check !== null)
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
  // The tab line ("☐ Approach", "←  ☐ Checks  ✔ Submit  →") names the header.
  if (q.header !== null && !(p.header[0] ?? "").includes(spaced(q.header))) return null;
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
  return { kind: "unparsed", toolUseId, prompt: null, buttons: [], otherRow: null, submitRow: null, multi: false, promptId: id, card: { kind: "unparsed", title: "", options: [], screen_lines: shown }, at };
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
    const m = permission(t, p) ?? question(t, p) ?? plan(t, p);
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

/** The HMAC `rev` of a card as published (§3a.3): any change to what the phone is shown is a new rev. */
export function cardRev(key: Buffer, m: Match): string {
  return createHmac("sha256", key).update(m.promptId).update("\0").update(JSON.stringify(m.card)).digest("base64url").slice(0, 32);
}

/** The card item as published. Its id is stable per prompt id, so a re-read of the same prompt is no change. */
export function promptItem(m: Match, rev: string): PromptItem {
  return { id: `prompt-${m.promptId.slice(0, 32)}`, at: m.at, prompt_id: m.promptId, rev, ...m.card, role: "prompt", state: "open" };
}
