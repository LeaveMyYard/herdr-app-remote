// A fake Claude Code tabbed question UI (AskUserQuestion with several questions), drawn the way the H0 CV9 rig
// recorded it (fixtures/claude-prompts/<pin>/askq-*, askr-*). several.test.ts checks the drawings against the
// recordings, so the answer tests below press against what the real binary shows.
import type { Runner, RunResult } from "../../src/plugins/exec.js";
import type { PendingTool } from "../../src/prompt/match.js";
import { IDLE, screen } from "./helpers.js";

/** The rig's fake API calls (rig/fake-anthropic.mjs H0-ASKQ, H0-ASKR). */
export const ASKQ: PendingTool = {
  id: "toolu_askq",
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
      {
        question: "Question Title 456: which checks should Agent 1 run?",
        header: "Checks",
        multiSelect: true,
        options: [
          { label: "Lint", description: "Run the linter" },
          { label: "Typecheck", description: "Run the type checker" },
          { label: "Unit tests", description: "Run cargo test" },
        ],
      },
      {
        question: "Question Title 789: where should Agent 1 deploy?",
        header: "Target",
        multiSelect: false,
        options: [
          { label: "Staging", description: "The Project Alpha staging box" },
          { label: "Nowhere", description: "Do not deploy yet" },
        ],
      },
    ],
  },
  at: null,
};
export const ASKR: PendingTool = {
  id: "toolu_askr",
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "Question Title 321: which branch should Agent 1 use?",
        header: "Branch",
        multiSelect: false,
        options: [
          { label: "main", description: "The Project Alpha main branch" },
          { label: "next", description: "The Project Alpha next branch" },
        ],
      },
      {
        question: "Question Title 654: which docs should Agent 1 update?",
        header: "Docs",
        multiSelect: true,
        options: [
          { label: "README", description: "The top README" },
          { label: "CHANGELOG", description: "The change log" },
        ],
      },
    ],
  },
  at: null,
};

interface Q {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

const RULE = "─".repeat(200);
const FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const FOOTER_G = "Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in VS Code · Esc to cancel";
const OK: RunResult = { code: 0, stdout: '{"ok":true}', stderr: "" };

/** The lines above the block: the banner and the echoed message, from the recording. */
const head = (trigger: string) => screen("askq-q1").split("\n").slice(0, 9).join("\n").replace("H0-ASKQ tabs please", trigger);

/**
 * The tabbed question UI: `tab` (a question, or `qs.length` for the review), a cursor per tab, a single-select's
 * pick (an index or Other text), a multi-select's ticks. Keys behave as the rig recorded (manifest `multiQuestion`).
 */
export class FakeSeveral {
  qs: Q[];
  tab = 0;
  cursor = 0;
  picked: (number | string | null)[];
  ticks: boolean[][];
  /** The footer offers ctrl+g once the cursor has been on an Other row (recorded). */
  g = false;
  /** What "Submit answers" answered with: one string per question; or "cancel", "chat", "esc". */
  answered: string[] | string | null = null;
  calls: string[][] = [];
  /** Called before each read (n counts reads): a test can change the state between steps. */
  beforeRead: ((n: number) => void) | null = null;
  /** Set to answer `hc keys` / `hc send` itself (return undefined to fall through). */
  reply: ((args: string[]) => RunResult | undefined) | null = null;
  reads = 0;
  constructor(
    public call: PendingTool,
    public trigger = "H0-ASKQ answer please",
  ) {
    this.qs = (call.input as { questions: Q[] }).questions;
    this.picked = this.qs.map(() => null);
    this.ticks = this.qs.map((q) => q.options.map(() => false));
  }

  private answeredQ(i: number): boolean {
    return this.qs[i]!.multiSelect ? this.ticks[i]!.some((x) => x) : this.picked[i] !== null;
  }
  private rowsOf(i: number): number {
    const q = this.qs[i]!;
    return q.options.length + (q.multiSelect ? 2 : 1) + 1;
  }
  answerText(i: number): string {
    const q = this.qs[i]!;
    if (q.multiSelect) return q.options.filter((_, j) => this.ticks[i]![j]).map((o) => o.label).join(", ");
    const p = this.picked[i];
    return typeof p === "number" ? q.options[p]!.label : (p ?? "");
  }

  get screen(): string {
    if (this.answered !== null) return IDLE;
    const tabs = `←  ${this.qs.map((q, i) => `${this.answeredQ(i) ? "☒" : "☐"} ${q.header}`).join("  ")}  ✔ Submit  →`;
    const at = (row: number) => (this.cursor === row ? "❯" : " ");
    if (this.tab === this.qs.length) {
      const all = this.qs.every((_, i) => this.answeredQ(i));
      const list = all ? this.qs.flatMap((q, i) => [` ● ${q.question}`, `   → ${this.answerText(i)}`]) : ["⚠ You have not answered all questions"];
      return [head(this.trigger), "", RULE, tabs, "", "Review your answers", "", ...list, "", "Ready to submit your answers?", "", `${at(0)} 1. Submit answers`, `${at(1)} 2. Cancel`].join("\n") + "\n";
    }
    const q = this.qs[this.tab]!;
    const k = q.options.length;
    const lines = [head(this.trigger), RULE, tabs, "", q.question, ""];
    q.options.forEach((o, j) => {
      if (q.multiSelect) lines.push(`${at(j)} ${j + 1}. [${this.ticks[this.tab]![j] ? "✔" : " "}] ${o.label}`, `         ${o.description}`);
      else lines.push(`${at(j)} ${j + 1}. ${o.label}${this.picked[this.tab] === j ? " ✔" : ""}`, `     ${o.description}`);
    });
    const p = this.picked[this.tab];
    if (q.multiSelect) lines.push(`${at(k)} ${k + 1}. [ ] Type something`, `${at(k + 1)}    ${this.tab === this.qs.length - 1 ? "Submit" : "Next"}`);
    else lines.push(`${at(k)} ${k + 1}. ${typeof p === "string" ? `${p} ✔` : "Type something."}`);
    const chat = q.multiSelect ? k + 2 : k + 1;
    lines.push(RULE, `${at(chat)} ${k + 2}. Chat about this`, "", this.g ? FOOTER_G : FOOTER);
    return lines.join("\n") + "\n";
  }

  private move(to: number): void {
    this.cursor = to;
    if (this.tab < this.qs.length && to === this.qs[this.tab]!.options.length) this.g = true;
  }
  private toTab(t: number): void {
    this.tab = Math.max(0, Math.min(this.qs.length, t));
    this.cursor = 0;
  }
  /** The cursor is on a question's Other row (a text field: arrows left and right stay in it). */
  private onOther(): boolean {
    return this.tab < this.qs.length && this.cursor === this.qs[this.tab]!.options.length;
  }

  press(k: string): void {
    if (this.answered !== null) return;
    const review = this.tab === this.qs.length;
    const rows = review ? 2 : this.rowsOf(this.tab);
    if (k === "down") return this.move(Math.min(rows - 1, this.cursor + 1));
    if (k === "up") return this.move(Math.max(0, this.cursor - 1));
    if (k === "esc") return void (this.answered = "esc");
    if (k === "right" || k === "tab") return this.onOther() ? undefined : this.toTab(this.tab + 1);
    if (k === "left" || k === "shift+tab") return this.onOther() ? undefined : this.toTab(this.tab - 1);
    if (review) {
      if (k === "enter") this.answered = this.cursor === 0 ? this.qs.map((_, i) => this.answerText(i)) : "cancel";
      return;
    }
    const q = this.qs[this.tab]!;
    const n = q.options.length;
    if (k === "space" || (k === "enter" && q.multiSelect && this.cursor < n)) {
      if (q.multiSelect && this.cursor < n) this.ticks[this.tab]![this.cursor] = !this.ticks[this.tab]![this.cursor];
      return;
    }
    if (k !== "enter") return;
    if (this.cursor === this.rowsOf(this.tab) - 1) return void (this.answered = "chat");
    if (q.multiSelect && this.cursor === n + 1) return this.toTab(this.tab + 1);
    if (!q.multiSelect && this.cursor < n) {
      this.picked[this.tab] = this.cursor;
      this.toTab(this.tab + 1);
    }
  }

  runner: Runner = async (_cmd, args) => {
    this.calls.push(args);
    if (args[0] === "read") {
      this.beforeRead?.(this.reads++);
      return { code: 0, stdout: this.screen, stderr: "" };
    }
    const special = this.reply?.(args);
    if (special) return special;
    if (args[0] === "keys") {
      for (const k of args.slice(args.indexOf("--") + 2)) this.press(k);
      return OK;
    }
    if (args[0] === "send") {
      if (!args.includes("--force")) return { code: 1, stdout: "", stderr: '{"error":{"kind":"blocked"}}' };
      const text = args[args.length - 1]!;
      const q = this.qs[this.tab];
      // Recorded: on a single-select Other row the text is the answer and the next tab shows.
      if (q && !q.multiSelect && this.onOther()) {
        this.picked[this.tab] = text;
        this.toTab(this.tab + 1);
      }
      return OK;
    }
    return { code: 2, stdout: "", stderr: '{"error":{"kind":"usage"}}' };
  };

  get keys(): string[][] {
    return this.calls.filter((a) => a[0] === "keys").map((a) => a.slice(a.indexOf("--") + 2));
  }
  get forced(): string[][] {
    return this.calls.filter((a) => a.includes("--force"));
  }
}

/** A screen's block from its opening rule down, with the footer's ctrl+g segment left out (compared to recordings). */
export function blockOf(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  const i = lines.findIndex((l) => l.startsWith("←  "));
  return lines
    .slice(i)
    .join("\n")
    .replace(" · ctrl+g to edit in VS Code", "");
}
