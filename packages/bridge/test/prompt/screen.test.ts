import { describe, expect, it } from "vitest";
import { parseScreen } from "../../src/prompt/screen.js";
import { moveCursor, screen } from "./helpers.js";

const ok = (text: string) => {
  const r = parseScreen(text);
  if (!r.ok) throw new Error(`not parsed:\n${r.lines.join("\n")}`);
  return r.prompt;
};

describe("parseScreen on the H0 recordings", () => {
  it("permission: four rows, cursor on Yes, the command in the header, the Esc footer", () => {
    const p = ok(screen("permission"));
    expect(p.rows.map((r) => r.label)).toEqual(["Yes", "Yes, and don’t ask again for: cargo test *", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    expect(p.cursor).toBe(0);
    expect(p.title).toBe("Do you want to proceed?");
    expect(p.header).toContain("cargo test --workspace");
    expect(p.header[0]).toBe("Bash command");
    expect(p.footer).toEqual(["Esc to cancel · Tab to amend"]);
    // The echoed user message above ("❯ H0-PERM please") is not the cursor.
    expect(p.rows.every((r) => r.check === null && r.n !== null)).toBe(true);
  });

  it("ask-single: options with descriptions, Other, then Chat about this below a rule", () => {
    const p = ok(screen("ask-single"));
    expect(p.rows.map((r) => [r.n, r.label, r.belowRule])).toEqual([
      [1, "Option A", false],
      [2, "Option B", false],
      [3, "Option C", false],
      [4, "Type something.", false],
      [5, "Chat about this", true],
    ]);
    expect(p.rows[0]!.desc).toEqual(["Rewrite the parser in Project Alpha"]);
    expect(p.title).toBe("Question Title 123: which approach should Agent 1 take?");
    expect(p.header[0]).toBe("☐ Approach");
    expect(p.cursor).toBe(0);
  });

  it("ask-other: the cursor on the Other row", () => {
    expect(ok(screen("ask-other")).cursor).toBe(3);
  });

  it("ask-multi: boxes, the unnumbered Submit row, and the toggles the rig recorded", () => {
    const p = ok(screen("ask-multi"));
    expect(p.rows.map((r) => [r.n, r.label, r.check])).toEqual([
      [1, "Lint", false],
      [2, "Typecheck", false],
      [3, "Unit tests", false],
      [4, "Type something", false],
      [null, "Submit", null],
      [5, "Chat about this", null],
    ]);
    expect(ok(screen("ask-multi-after-space")).rows.map((r) => r.check)).toEqual([true, false, false, false, null, null]);
    const two = ok(screen("ask-multi-after-down-enter"));
    expect(two.rows.map((r) => r.check)).toEqual([true, true, false, false, null, null]);
    expect(two.cursor).toBe(1);
    expect(ok(screen("ask-multi-on-submit")).cursor).toBe(4);
  });

  it("ask-multi-review: the review step, no footer", () => {
    const p = ok(screen("ask-multi-review"));
    expect(p.rows.map((r) => r.label)).toEqual(["Submit answers", "Cancel"]);
    expect(p.title).toBe("Ready to submit your answers?");
    expect(p.header).toContain("→ Lint, Typecheck");
    expect(p.footer).toEqual([]);
  });

  it("plan: the options below the plan, not the plan's own numbered list", () => {
    const p = ok(screen("plan"));
    expect(p.rows.map((r) => r.label)).toEqual(["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]);
    expect(p.rows[2]!.desc).toEqual(["shift+tab to approve with this feedback"]);
    expect(p.title.endsWith("Would you like to proceed?")).toBe(true);
    expect(p.cursor).toBe(0);
  });

  it("the test helper moves the cursor the way the recordings show it", () => {
    expect(moveCursor(screen("ask-single"), 3).split("\n")).toEqual(screen("ask-other").split("\n").map((l) => l.replace(" · ctrl+g to edit in VS Code", "")));
    expect(ok(moveCursor(screen("permission"), 3)).cursor).toBe(3);
    expect(ok(moveCursor(screen("plan"), 2)).cursor).toBe(2);
    expect(ok(moveCursor(screen("ask-multi"), 4)).cursor).toBe(4);
  });
});

describe("parseScreen fails closed", () => {
  const perm = screen("permission");
  it("no option list", () => {
    const r = parseScreen("● Agent 1 is working\n\n────────────────────────────────────\n❯ \n────────────────────────────────────\n  ? for shortcuts\n");
    expect(r.ok).toBe(false);
  });
  it("two cursors", () => {
    expect(parseScreen(perm.replace("   2. Yes, and", " ❯ 2. Yes, and")).ok).toBe(false);
  });
  it("no cursor", () => {
    expect(parseScreen(perm.replace(" ❯ 1. Yes", "   1. Yes")).ok).toBe(false);
  });
  it("a cursor in the header", () => {
    expect(parseScreen(perm.replace(" This command requires approval", " ❯ This command requires approval")).ok).toBe(false);
  });
  it("a cursor in the footer", () => {
    expect(parseScreen(perm.replace(" Esc to cancel", " ❯ Esc to cancel")).ok).toBe(false);
  });
  it("no rule above the list", () => {
    expect(parseScreen(perm.replace(/^─+$/m, "")).ok).toBe(false);
  });
  it("a row that skips a number ends the list early, and a lone row is not a list", () => {
    const r = parseScreen("────────────────────────\n Title?\n ❯ 1. Yes\n   3. No\n");
    expect(r.ok).toBe(false);
  });
  it("a long footer", () => {
    expect(parseScreen(`${perm}\nx\ny\nz\n`).ok).toBe(false);
  });
  it("text typed into the input box that looks like a list is still a list (the matcher refuses it without an Esc footer)", () => {
    const r = parseScreen("────────────────────────\n❯ 1. foo\n  2. bar\n────────────────────────\n  ? for shortcuts\n");
    // The list ends on the rule: refused here already.
    expect(r.ok).toBe(false);
  });
  it("hc's own notice lines are ignored", () => {
    expect(parseScreen(`${perm}\n[hc] only its screen: it is working; read again once it stops for its history\n`).ok).toBe(true);
  });
});
