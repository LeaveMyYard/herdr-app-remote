// Claude Code's native prompt block, read from the terminal screen (`hc read`), docs/chatview.md §3a.2 (signal V).
//
// The shapes are the ones the rig recorded for the pinned Claude Code (fixtures/claude-prompts/<version>/, H0):
//
//   ──────────────────────────────           <- the rule that opens the block (the nearest one above option 1)
//    Bash command                            <- header lines: everything between that rule and option 1
//    ...
//    Do you want to proceed?                 <- the title: the last paragraph of the header
//    ❯ 1. Yes                                <- numbered rows; exactly one carries the cursor ❯
//      2. Yes, and don’t ask again for: …
//      3. No
//                                            <- a blank line ends the rows
//    Esc to cancel · Tab to amend            <- the footer
//
// AskUserQuestion rows have description lines indented under them, an Other row ("Type something."), and a rule
// with "Chat about this" below it; multi-select rows start with "[ ]" / "[✔]" and have an unnumbered "Submit" row.
//
// Pure: no I/O. Anything that is not exactly this shape is `null` (the caller shows the screen read-only and
// presses nothing): fail closed.

/** A screen row of the option list. `n` is its number, null for the unnumbered multi-select "Submit" row. */
export interface PromptRow {
  n: number | null;
  /** The label as the screen shows it, without the cursor, the number or a multi-select box. */
  label: string;
  /** A multi-select row's box: true for "[✔]", false for "[ ]", null for a row without one. */
  check: boolean | null;
  /** Lines indented under the row (an option's description), trimmed. */
  desc: string[];
  /** The row sits below a rule inside the list ("Chat about this"). */
  belowRule: boolean;
}

export interface ScreenPrompt {
  rows: PromptRow[];
  /** Index into `rows` of the row with the cursor. */
  cursor: number;
  /** Non-blank lines between the opening rule and option 1, trimmed. */
  header: string[];
  /** The last paragraph of the header, one line (wrapped lines joined with a space). */
  title: string;
  /** Non-blank lines after the rows, trimmed. */
  footer: string[];
  /** The block as shown: the opening rule's next line to the end, trailing blanks trimmed (for read-only display). */
  lines: string[];
}

/** The parse of a whole screen: a prompt block, or the bottom lines when no option list could be read. */
export type ScreenRead = { ok: true; prompt: ScreenPrompt } | { ok: false; lines: string[] };

/** A full-width rule: a line of box-drawing `─` only (some dialogs indent it). */
const RULE = /^ *─{20,} *$/;
/** An option row: optional cursor, a number, ". ", the label. */
const OPTION = /^( *)(❯)?( *)(\d{1,2})\. (\S.*)$/;
/** The multi-select Submit row: unnumbered. */
const SUBMIT = /^( *)(❯)?( *)Submit$/;
/** A multi-select box at the start of a label. */
const BOX = /^\[( |✔)\] (\S.*)$/;
/** The most lines between the opening rule and option 1 (a long command, a wrapped question). */
const HEADER_MAX = 60;
/** The most lines after the rows (the footer). */
const FOOTER_MAX = 3;
/** Lines kept for a read-only card. */
export const SCREEN_LINES_MAX = 60;
/** Lines asked of `hc read` for a prompt check: room for a long command or plan header above the options. */
export const PROMPT_READ_LINES = 100;

const cursorIn = (s: string) => s.includes("❯");

/** The screen's lines, trailing blanks and hc's own notice lines (`[hc] …`) removed. */
export function screenLines(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/\s+$/, ""))
    .filter((l) => !l.startsWith("[hc] "));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The bottom of the screen for a read-only card: from the last rule, else the last lines. */
function tail(lines: readonly string[]): string[] {
  let from = Math.max(0, lines.length - SCREEN_LINES_MAX);
  for (let i = lines.length - 1; i >= from; i--) {
    if (RULE.test(lines[i]!)) {
      from = i + 1;
      break;
    }
  }
  return lines.slice(from, from + SCREEN_LINES_MAX);
}

/** Reads a prompt block from `hc read` output. */
export function parseScreen(text: string): ScreenRead {
  const lines = screenLines(text);
  const fail = (): ScreenRead => ({ ok: false, lines: tail(lines) });
  // Option 1 nearest the bottom: anything numbered above it (a plan's own list, the agent's text) is not the list.
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION.exec(lines[i]!);
    if (m && m[4] === "1") {
      first = i;
      break;
    }
  }
  if (first < 0) return fail();
  // The opening rule: the nearest above option 1.
  let top = -1;
  for (let i = first - 1; i >= Math.max(0, first - HEADER_MAX - 1); i--) {
    if (RULE.test(lines[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return fail();
  const headerRaw = lines.slice(top + 1, first);
  // The cursor is searched only inside the block, and only on rows (the echoed prompt above also starts with ❯).
  if (headerRaw.some(cursorIn)) return fail();
  const header = headerRaw.map((l) => l.trim()).filter((l) => l !== "");

  const rows: PromptRow[] = [];
  let cursor = -1;
  let expected = 1;
  let belowRule = false;
  /** Indentation of the last row's number (description lines are deeper). */
  let numberCol = 0;
  let i = first;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    if (RULE.test(line)) {
      if (rows.length === 0) return fail();
      belowRule = true;
      continue;
    }
    const m = OPTION.exec(line);
    if (m && Number(m[4]) === expected) {
      const cur = m[2] !== undefined;
      if (cur) {
        if (cursor >= 0) return fail();
        cursor = rows.length;
      }
      const box = BOX.exec(m[5]!);
      rows.push({ n: expected, label: (box ? box[2]! : m[5]!).trim(), check: box ? box[1] === "✔" : null, desc: [], belowRule });
      numberCol = m[1]!.length + (cur ? 1 : 0) + m[3]!.length;
      expected += 1;
      continue;
    }
    const s = SUBMIT.exec(line);
    // "Submit" comes only after boxed rows, and only once.
    if (s && rows.length > 0 && rows.every((r) => r.check !== null) && !belowRule) {
      if (s[2] !== undefined) {
        if (cursor >= 0) return fail();
        cursor = rows.length;
      }
      rows.push({ n: null, label: "Submit", check: null, desc: [], belowRule });
      continue;
    }
    // A description: indented deeper than the last row's number, under a numbered row.
    const indent = line.length - line.trimStart().length;
    const last = rows[rows.length - 1];
    if (last && last.n !== null && indent > numberCol && !cursorIn(line) && !m) {
      last.desc.push(line.trim());
      continue;
    }
    break;
  }
  if (rows.length < 2 || cursor < 0) return fail();
  const rest = lines.slice(i);
  if (rest.some(cursorIn)) return fail();
  const footer = rest.map((l) => l.trim()).filter((l) => l !== "");
  if (footer.length > FOOTER_MAX) return fail();
  // A list must not end on a rule.
  if (RULE.test(lines[i - 1] ?? "")) return fail();
  // The title: the header's last paragraph.
  let t = headerRaw.length;
  while (t > 0 && headerRaw[t - 1]!.trim() === "") t--;
  let s0 = t;
  while (s0 > 0 && headerRaw[s0 - 1]!.trim() !== "") s0--;
  const title = headerRaw
    .slice(s0, t)
    .map((l) => l.trim())
    .join(" ");
  if (title === "") return fail();
  return { ok: true, prompt: { rows, cursor, header, title, footer, lines: lines.slice(top + 1).slice(-SCREEN_LINES_MAX) } };
}

/** Text with every run of whitespace removed: a long command wraps across screen lines with indentation. */
export const squash = (s: string): string => s.replace(/\s+/g, "");
/** Text with runs of whitespace as one space, trimmed. */
export const spaced = (s: string): string => s.replace(/\s+/g, " ").trim();
