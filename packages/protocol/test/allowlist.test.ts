import { describe, expect, it } from "vitest";
import { modLink } from "../src/index.js";

const { checkRun, RUN_ALLOWLIST, encodeLine } = modLink;

describe("run allowlist", () => {
  it("is exactly the navigate commands", () => {
    expect(RUN_ALLOWLIST).toEqual(["agent.focus", "pane.focus", "space.select", "tab.select"]);
  });

  it.each([
    ["agent.focus", { terminal: "t3" }],
    ["agent.focus", { terminal: "machine-1/t3" }],
    ["pane.focus", { pane: "p1" }],
    ["pane.focus", { terminal: "t3" }],
    ["space.select", { id: "space-1" }],
    ["space.select", { index: 2 }],
    ["tab.select", { id: "tab-1" }],
    ["tab.select", { index: 1 }],
  ])("accepts %s %j", (name, args) => {
    expect(checkRun(name, args)).toEqual({ ok: true, name, args });
  });

  it("returns a parsed copy of the args, not the caller's object", () => {
    const input = { index: 1, toJSON: () => ({ argv: ["sh"] }) };
    const r = checkRun("tab.select", { index: 1 });
    expect(r.ok && r.args).toEqual({ index: 1 });
    expect(checkRun("tab.select", input)).toEqual({ ok: false, error: "bad_args" });
    const plain = { id: "tab-1" };
    const r2 = checkRun("tab.select", plain);
    expect(r2.ok && r2.args).not.toBe(plain);
  });

  it.each([
    "tab.new",
    "space.new",
    "terminal.open",
    "terminal.kill",
    "layout.switch",
    "app.reset",
    "herdr-inbox.focus",
    "__proto__",
    "toString",
    "constructor",
    "",
    42,
    null,
  ])("refuses %j as not_allowed", (name) => {
    expect(checkRun(name, {})).toEqual({ ok: false, error: "not_allowed" });
  });

  it.each([
    ["agent.focus", {}],
    ["agent.focus", { terminal: "t3", argv: ["sh"] }],
    ["agent.focus", { terminal: "" }],
    ["agent.focus", { terminal: "t3 --x" }],
    ["agent.focus", { terminal: "t\n3" }],
    ["agent.focus", { terminal: "x".repeat(129) }],
    ["agent.focus", { terminal: 3 }],
    ["pane.focus", { pane: "p1", terminal: "t3" }],
    ["space.select", { index: 0 }],
    ["space.select", { index: 1.5 }],
    ["space.select", { id: "space-1", index: 1 }],
    ["tab.select", { index: "1" }],
    ["tab.select", null],
    ["tab.select", []],
    ["tab.select", "tab-1"],
  ])("refuses %s %j as bad_args", (name, args) => {
    expect(checkRun(name, args)).toEqual({ ok: false, error: "bad_args" });
  });
});

describe("encodeLine", () => {
  it("emits one ASCII-only line that round-trips", () => {
    const msg = { type: "notify", level: "info", message: "Agent 1 — 🙂 done\nnext" };
    const line = encodeLine(msg);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(/^[\x20-\x7e]*\n$/.test(line)).toBe(true);
    expect(JSON.parse(line)).toEqual(msg);
  });
});
