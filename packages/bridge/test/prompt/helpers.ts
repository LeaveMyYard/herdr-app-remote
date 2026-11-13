import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PendingTool } from "../../src/prompt/match.js";

/** The H0 recordings of the pinned Claude Code (fixtures/claude-prompts/<version>/). */
export const PINNED = "2.1.323";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/claude-prompts", PINNED);

export type Screen =
  | "permission"
  | "ask-single"
  | "ask-other"
  | "ask-multi"
  | "ask-multi-after-space"
  | "ask-multi-after-down-enter"
  | "ask-multi-on-submit"
  | "ask-multi-review"
  | "plan"
  // CV8 (Stop), recorded by rig/scenarios/agent-stop.sh.
  | "stop-idle"
  | "stop-idle-after-esc"
  | "stop-idle-after-double-esc"
  | "stop-working-stream"
  | "stop-stream-after-esc"
  | "stop-after-stop-double-esc"
  | "stop-working-tool"
  | "stop-tool-after-esc"
  | "stop-permission-after-esc";
export const screen = (name: Screen): string => readFileSync(join(DIR, `${name}.txt`), "utf8");

/** The tool calls the rig's fake API made for each recording (rig/fake-anthropic.mjs), as pending calls. */
export const BASH: PendingTool = { id: "toolu_perm1", name: "Bash", input: { command: "cargo test --workspace", description: "Run the Project Alpha tests" }, at: null };
export const ASK1: PendingTool = {
  id: "toolu_ask1",
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Question Title 123: which approach should Agent 1 take?",
        header: "Approach",
        multiSelect: false,
        options: [
          { label: "Option A", description: "Rewrite the parser in Project Alpha" },
          { label: "Option B", description: "Patch the existing parser" },
          { label: "Option C", description: "Leave it as it is" },
        ],
      },
    ],
  },
  at: null,
};
export const ASKM: PendingTool = {
  id: "toolu_askm",
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Question Title 123: which checks should Agent 1 run?",
        header: "Checks",
        multiSelect: true,
        options: [
          { label: "Lint", description: "Run the linter" },
          { label: "Typecheck", description: "Run the type checker" },
          { label: "Unit tests", description: "Run cargo test" },
        ],
      },
    ],
  },
  at: null,
};
export const PLAN: PendingTool = {
  id: "toolu_plan",
  name: "ExitPlanMode",
  input: { plan: "# Plan for Project Alpha\n\n1. Split the parser into three passes\n2. Add tests with cargo test\n3. Update the docs" },
  at: null,
};

/** A screen with the cursor moved to row `to` (0-based) of the option list, the way Claude Code redraws it. */
export function moveCursor(text: string, to: number): string {
  const lines = text.split("\n");
  // Rows of the option list nearest the bottom: lines whose number or Submit follow the cursor column.
  const rowLines: number[] = [];
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^ *(❯)? *1\. /.test(lines[i]!)) { first = i; break; }
  for (let i = first; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "") break;
    if (/^ *(❯)? *\d{1,2}\. /.test(l) || /^ *(❯)? *Submit$/.test(l)) rowLines.push(i);
  }
  for (const i of rowLines) lines[i] = lines[i]!.replace("❯ ", "  ").replace("❯", " ");
  const at = rowLines[to]!;
  // Put ❯ where the leading spaces allow (column of the original cursor: 0, 1 or 3).
  const l = lines[at]!;
  const lead = l.length - l.trimStart().length;
  const col = Math.max(0, Math.min(lead - 2, text.includes(" ❯ 1.") ? (text.includes("   ❯ 1.") ? 3 : 1) : 0));
  lines[at] = `${l.slice(0, col)}❯ ${l.slice(col + 2)}`;
  return lines.join("\n");
}

import type { Runner, RunResult } from "../../src/plugins/exec.js";
import { matchPrompt } from "../../src/prompt/match.js";
import type { PromptSource, PublishedPrompt } from "../../src/prompt/answer.js";
import { parseScreen } from "../../src/prompt/screen.js";

/** The screen once a prompt closed: Claude Code's input box, no option list. */
export const IDLE = "● Agent 1 got the answer.\n\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts\n";

const OK: RunResult = { code: 0, stdout: '{"ok":true}', stderr: "" };

/**
 * A terminal running the pinned Claude Code, as far as the answer path can see: `hc read` returns the screen,
 * `hc keys` moves the cursor, ticks boxes and presses Enter the way the H0 recordings show, `hc send --force` on
 * the Other row answers. Every argv is kept in `calls`.
 */
export class FakeTerm {
  calls: string[][] = [];
  /** What Enter (or the Other send) answered: the row labels, or the Other text. */
  answered: string | null = null;
  /** Set to make `hc keys` do nothing (the desk's screen moved on), or to answer with this instead. */
  keysReply: ((args: string[]) => RunResult | undefined) | null = null;
  /** Called before each read: a test can change the screen between steps. */
  beforeRead: ((n: number) => void) | null = null;
  reads = 0;
  constructor(public screen: string) {}

  runner: Runner = async (_cmd, args) => {
    this.calls.push(args);
    if (args[0] === "read") {
      this.beforeRead?.(this.reads++);
      return { code: 0, stdout: this.screen, stderr: "" };
    }
    if (args[0] === "keys") {
      const special = this.keysReply?.(args);
      if (special) return special;
      for (const k of args.slice(args.indexOf("--") + 2)) this.press(k);
      return OK;
    }
    if (args[0] === "send") {
      const p = parseScreen(this.screen);
      if (!args.includes("--force") && p.ok) return { code: 1, stdout: "", stderr: '{"error":{"kind":"blocked"}}' };
      if (p.ok && p.prompt.rows[p.prompt.cursor]!.label.startsWith("Type something")) {
        this.answered = args[args.length - 1]!;
        this.screen = IDLE;
      }
      return OK;
    }
    return { code: 2, stdout: "", stderr: '{"error":{"kind":"usage"}}' };
  };

  private press(k: string): void {
    const r = parseScreen(this.screen);
    if (!r.ok) return;
    const p = r.prompt;
    if (k === "down" || k === "up") {
      const to = Math.max(0, Math.min(p.rows.length - 1, p.cursor + (k === "down" ? 1 : -1)));
      this.screen = moveCursor(this.screen, to);
      return;
    }
    const row = p.rows[p.cursor]!;
    if (k === "space" && row.check !== null) {
      const lines = this.screen.split("\n");
      const i = lines.findIndex((l) => l.includes(`. [${row.check ? "✔" : " "}] ${row.label}`));
      lines[i] = lines[i]!.replace(row.check ? "[✔]" : "[ ]", row.check ? "[ ]" : "[✔]");
      this.screen = lines.join("\n");
      return;
    }
    if (k === "enter") {
      if (row.label === "Submit" && row.n === null) {
        const picked = p.rows.filter((x) => x.check === true).map((x) => x.label);
        this.screen = screen("ask-multi-review").replace("→ Lint, Typecheck", `→ ${picked.join(", ")}`);
        return;
      }
      if (row.check !== null) return void this.press("space");
      this.answered = p.title === "Ready to submit your answers?" ? `review:${row.label}` : row.label;
      this.screen = IDLE;
    }
  }

  /** The argv of every `hc keys`, keys only. */
  get keys(): string[][] {
    return this.calls.filter((a) => a[0] === "keys").map((a) => a.slice(a.indexOf("--") + 2));
  }
  /** Whether any call carried `--force`. */
  get forced(): boolean {
    return this.calls.some((a) => a.includes("--force"));
  }
}

/** A prompt source over a fake terminal: the card as the topic would publish it, T and S as set. */
export function source(term: FakeTerm, pending: PendingTool[], o: { blocked?: boolean; rev?: string } = {}) {
  const state = { pending: [...pending], blocked: o.blocked ?? true, answered: [] as string[] };
  const m = matchPrompt(state.pending, term.screen);
  let pub: PublishedPrompt | undefined = { match: m, rev: o.rev ?? "rev-1" };
  const src: PromptSource = {
    current: () => pub,
    fresh: async () => ({ pending: term.answered !== null ? [] : state.pending, blocked: term.answered !== null ? false : state.blocked }),
    answered: (_t, id) => {
      state.answered.push(id);
      pub = undefined;
    },
    isAnswered: (_t, id) => state.answered.includes(id),
  };
  return { src, state, card: m, setPublished: (p: PublishedPrompt | undefined) => (pub = p) };
}

export const CLIENT = (deviceId = "d-0000000000000001") => ({ principal: { deviceId }, send: () => undefined, close: () => undefined });
