import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const scenario = readFileSync(join(root, "rig/scenarios/claude-prompts.sh"), "utf8");
const pin = /^PINNED_CLAUDE_VERSION=(\S+)$/m.exec(scenario)?.[1] ?? "";
const dir = join(root, "fixtures/claude-prompts", pin);
const screen = (n: string) => readFileSync(join(dir, `${n}.txt`), "utf8");

describe("recorded Claude Code prompt screens (H0)", () => {
  it("are pinned to the version the scenario asserts", () => {
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.claudeCode).toBe(pin);
  });

  it("R5: the tool_use was on disk before every dialog", () => {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.r5.map((c: { name: string }) => c.name)).toEqual(["permission", "ask-single", "ask-multi", "plan"]);
    for (const c of m.r5) expect(c.tool_use_before_dialog).toBe(true);
  });

  it("permission: Yes, don't ask again, auto mode, No, cursor on the first", () => {
    const s = screen("permission");
    expect(s).toMatch(/Do you want to proceed\?\n ❯ 1\. Yes\n   2\. Yes, and don’t ask again for: cargo test \*\n   3\. Yes, and switch to auto mode.*\n   4\. No\n/);
  });

  it("ask-single: options, Other ('Type something.') and Chat about this", () => {
    const s = screen("ask-single");
    expect(s).toMatch(/☐ Approach\n\nQuestion Title 123.*\n\n❯ 1\. Option A\n/);
    expect(s).toMatch(/4\. Type something\.\n/);
    expect(s).toMatch(/5\. Chat about this\n/);
    expect(screen("ask-other")).toMatch(/\n❯ 4\. Type something\./);
  });

  it("ask-multi: unchecked rows, toggles by space and enter, Submit then a review step", () => {
    expect(screen("ask-multi")).toMatch(/❯ 1\. \[ \] Lint[\s\S]*4\. \[ \] Type something\n {5}Submit\n/);
    expect(screen("ask-multi-after-space")).toMatch(/❯ 1\. \[✔\] Lint/);
    expect(screen("ask-multi-after-down-enter")).toMatch(/1\. \[✔\] Lint[\s\S]*❯ 2\. \[✔\] Typecheck/);
    expect(screen("ask-multi-on-submit")).toMatch(/\n❯ {4}Submit\n/);
    expect(screen("ask-multi-review")).toMatch(/→ Lint, Typecheck[\s\S]*❯ 1\. Submit answers\n {2}2\. Cancel/);
  });

  it("plan: the auto-mode option comes first", () => {
    expect(screen("plan")).toMatch(/❯ 1\. Yes, and use auto mode\n {5}2\. Yes, manually approve edits\n {5}3\. Tell Claude what to change/);
  });

  it("Stop (CV8): the agent-stop scenario pins the same version; Esc's working footer and its effects", () => {
    const stop = readFileSync(join(root, "rig/scenarios/agent-stop.sh"), "utf8");
    expect(/^PINNED_CLAUDE_VERSION=(\S+)$/m.exec(stop)?.[1]).toBe(pin);
    const last = (n: string) => screen(n).trimEnd().split("\n").at(-1)!;
    expect(last("stop-working-stream")).toMatch(/· esc to interrupt ·/);
    expect(last("stop-working-tool")).toMatch(/· esc to interrupt ·/);
    for (const n of ["stop-idle", "stop-stream-after-esc", "stop-tool-after-esc", "stop-permission-after-esc"]) expect(last(n)).not.toMatch(/esc to interrupt/);
    expect(screen("stop-stream-after-esc")).toMatch(/Interrupted · What should Claude do instead\?/);
    expect(screen("stop-after-stop-double-esc")).toMatch(/\n {3}Rewind\n/);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m.stop.key).toMatch(/^esc, once/);
  });

  it("carry no machine-specific paths", () => {
    for (const n of readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4))) expect(screen(n)).not.toMatch(/\/home\/|\.claude|\/mnt\//);
  });
});
