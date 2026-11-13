import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { cardRev, isReview, matchPrompt, pendingTools, promptId, promptItem } from "../../src/prompt/match.js";
import { parseScreen } from "../../src/prompt/screen.js";
import { agent, result, tool, user } from "../chatview/helpers.js";
import { ASK1, ASKM, BASH, moveCursor, PLAN, screen } from "./helpers.js";

const item = (m: ReturnType<typeof matchPrompt>) => {
  const it = promptItem(m, cardRev(Buffer.alloc(32, 1), m));
  // Every card is a valid ChatItem.
  expect(bridgeApi.ChatItem.safeParse(it).success).toBe(true);
  return it;
};

describe("pendingTools (T)", () => {
  it("top-level calls with no result, oldest first; subagent calls never", () => {
    const ms = [
      agent(1, [tool("a", "Bash"), tool("b", "Read")]),
      user(2, [result("a")]),
      agent(3, [tool("c", "AskUserQuestion")]),
      agent(4, [tool("d", "Bash")], { parentToolUseId: "x" }),
    ];
    expect(pendingTools(ms).map((p) => p.id)).toEqual(["b", "c"]);
  });
});

describe("matchPrompt on the H0 recordings (T + V)", () => {
  it("permission: the Bash command in the block", () => {
    const m = matchPrompt([BASH], screen("permission"));
    expect(m.kind).toBe("permission");
    expect(m.toolUseId).toBe(BASH.id);
    const it = item(m);
    expect(it.options.map((o) => o.label)).toEqual(["Yes", "Yes, and don’t ask again for: cargo test *", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    expect(it.summary).toBe("cargo test --workspace");
    expect(it.title).toBe("Do you want to proceed?");
  });

  it("permission: another command is not this prompt (read-only)", () => {
    const m = matchPrompt([{ ...BASH, input: { command: "rm -rf build" } }], screen("permission"));
    expect(m.kind).toBe("unparsed");
    expect(item(m).screen_lines!.length).toBeGreaterThan(3);
  });

  it("question, single select: options from T, the Other row, no Chat button", () => {
    const m = matchPrompt([ASK1], screen("ask-single"));
    expect(m.kind).toBe("question");
    expect(m.otherRow).toBe(3);
    const it = item(m);
    expect(it.options.map((o) => o.label)).toEqual(["Option A", "Option B", "Option C"]);
    expect(it.questions).toEqual([
      {
        text: "Question Title 123: which approach should Agent 1 take?",
        header: "Approach",
        multi: false,
        options: [
          { label: "Option A", description: "Rewrite the parser in Project Alpha" },
          { label: "Option B", description: "Patch the existing parser" },
          { label: "Option C", description: "Leave it as it is" },
        ],
        other: true,
      },
    ]);
  });

  it("question: the cursor moving keeps the id; another option label is another prompt", () => {
    const a = matchPrompt([ASK1], screen("ask-single"));
    expect(matchPrompt([ASK1], screen("ask-other")).promptId).toBe(a.promptId);
    expect(matchPrompt([ASK1], screen("ask-single").replace("Option B", "Option X")).kind).toBe("unparsed");
  });

  it("question, multi select: no Other offered (not recorded), ticking keeps the id", () => {
    const m = matchPrompt([ASKM], screen("ask-multi"));
    expect(m.kind).toBe("question");
    expect(m.multi).toBe(true);
    expect(m.otherRow).toBeNull();
    expect(m.submitRow).toBe(4);
    expect(item(m).questions![0]!.other).toBe(false);
    expect(matchPrompt([ASKM], screen("ask-multi-after-down-enter")).promptId).toBe(m.promptId);
  });

  it("two questions in one call were never recorded: read-only", () => {
    const two = { ...ASK1, input: { questions: [(ASK1.input as { questions: unknown[] }).questions[0], (ASK1.input as { questions: unknown[] }).questions[0]] } };
    expect(matchPrompt([two], screen("ask-single")).kind).toBe("unparsed");
  });

  it("plan: ExitPlanMode with its plan text", () => {
    const m = matchPrompt([PLAN], screen("plan"));
    expect(m.kind).toBe("plan");
    const it = item(m);
    expect(it.plan_md).toContain("Split the parser into three passes");
    expect(it.options.map((o) => o.label)).toEqual(["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]);
  });

  /** A dialog the bridge can't classify (no Bash header, another title): stands in for an MCP or new prompt type. */
  const GENERIC = screen("permission").replace(/^ Bash command$/m, " Edit file").replace(" Do you want to proceed?", " Do you want to make this edit to main.rs?");

  it("no pending call (S + V only): a generic card from the screen, when it has the Esc footer", () => {
    const m = matchPrompt([], GENERIC);
    expect(m.kind).toBe("other");
    expect(m.toolUseId).toBeNull();
    expect(item(m).title).toBe("Do you want to make this edit to main.rs?");
    // The plan block has no Esc footer: read-only.
    expect(matchPrompt([], screen("plan")).kind).toBe("unparsed");
  });

  it("a pending call of an unknown tool: a generic card bound to that call", () => {
    const m = matchPrompt([{ id: "toolu_mcp", name: "mcp__x__y", input: {}, at: null }], GENERIC);
    expect(m.kind).toBe("other");
    expect(m.toolUseId).toBe("toolu_mcp");
  });

  it("H2: a Bash permission block that no pending top-level Bash matches is read-only, never a generic card", () => {
    // A subagent asks (its calls are not top-level T) while the main agent runs Task; or the transcript lags (none).
    for (const pending of [[{ id: "toolu_task", name: "Task", input: { prompt: "x" }, at: null }], []]) {
      const m = matchPrompt(pending, screen("permission"));
      expect(m.kind).toBe("unparsed");
      expect(item(m).options).toEqual([]);
    }
    // The other known shapes too: a question, a plan, the review step, with nothing pending.
    for (const n of ["ask-single", "ask-multi", "plan", "ask-multi-review"] as const) expect(matchPrompt([], screen(n)).kind, n).toBe("unparsed");
  });

  it("H1: the command on screen must equal the pending command, not contain it", () => {
    const longer = screen("permission").replace(/^ cargo test --workspace$/m, " rm -rf ~/project-cargo-cache && cargo test --workspace");
    expect(matchPrompt([{ ...BASH, input: { command: "cargo" } }], longer).kind).toBe("unparsed");
    expect(matchPrompt([{ ...BASH, input: { command: "cargo test --workspace" } }], longer).kind).toBe("unparsed");
    expect(matchPrompt([{ ...BASH, input: { command: "rm -rf ~/project-cargo-cache && cargo test --workspace" } }], longer).kind).toBe("permission");
    // A substring of the original screen's command, or the description line, is not the command either.
    expect(matchPrompt([{ ...BASH, input: { command: "cargo" } }], screen("permission")).kind).toBe("unparsed");
    expect(matchPrompt([{ ...BASH, input: { command: "Run the Project Alpha tests" } }], screen("permission")).kind).toBe("unparsed");
    // A command wrapped over two screen lines still matches (whitespace is ignored on both sides).
    const wrapped = screen("permission").replace(/^ cargo test --workspace$/m, " cargo test\n --workspace");
    expect(matchPrompt([BASH], wrapped).kind).toBe("permission");
  });

  it("a known call that doesn't match fails closed even with an unknown one pending too... only if none is unknown", () => {
    expect(matchPrompt([ASK1], screen("permission")).kind).toBe("unparsed");
  });

  it("the same command pending twice can't be told apart: read-only", () => {
    expect(matchPrompt([BASH, { ...BASH, id: "toolu_perm2" }], screen("permission")).kind).toBe("unparsed");
  });

  it("no option list: the screen's last lines, read-only", () => {
    const m = matchPrompt([BASH], "● working\n────────────────────\n some dialog\n");
    expect(m.kind).toBe("unparsed");
    expect(item(m).screen_lines).toEqual([" some dialog"]);
  });

  it("the id covers the tool_use id, the title and the labels", () => {
    const base = promptId("a", "T", ["x", "y"]);
    expect(promptId("b", "T", ["x", "y"])).not.toBe(base);
    expect(promptId("a", "U", ["x", "y"])).not.toBe(base);
    expect(promptId("a", "T", ["y", "x"])).not.toBe(base);
    expect(promptId("a", "T", ["x", "y"])).toBe(base);
    expect(matchPrompt([{ ...BASH, id: "other" }], screen("permission")).promptId).not.toBe(matchPrompt([BASH], screen("permission")).promptId);
  });

  it("the review step", () => {
    const p = parseScreen(screen("ask-multi-review"));
    if (!p.ok) throw new Error("x");
    expect(isReview(p.prompt, ["Lint", "Typecheck"])).toBe(true);
    expect(isReview(p.prompt, ["Lint"])).toBe(false);
    expect(isReview(p.prompt, ["Typecheck", "Lint"])).toBe(false);
  });

  it("secrets in a command are hidden in the card", () => {
    const cmd = "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' x";
    const s = screen("permission").replace(/^ cargo test --workspace$/m, ` ${cmd}`);
    const m = matchPrompt([{ ...BASH, input: { command: cmd } }], s);
    expect(m.kind).toBe("permission");
    expect(item(m).summary).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("moved cursors still match", () => {
    expect(matchPrompt([BASH], moveCursor(screen("permission"), 2)).promptId).toBe(matchPrompt([BASH], screen("permission")).promptId);
  });
});
