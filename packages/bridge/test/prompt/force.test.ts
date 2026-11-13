// `hc send --force` is allowed only on the Other path, after phase A moved the cursor to the prompt's own Other field
// and a fresh `hc read` confirmed the same prompt with that field active (binding decision, CV7). These tests pin
// that it is unreachable from every other path, and that removing the guard fails them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promptAnswerActor } from "../../src/prompt/answer.js";
import { confirmOtherField, OTHER_CONFIRM_MAX_MS, otherSendArgs, type OtherFieldConfirmation } from "../../src/prompt/other.js";
import { matchPrompt } from "../../src/prompt/match.js";
import { terminalSendActor } from "../../src/terminal/send.js";
import { terminalKeysActor } from "../../src/terminal/keys.js";
import { routeActs } from "../../src/app/act.js";
import type { Runner } from "../../src/plugins/exec.js";
import { ASK1, ASKM, BASH, CLIENT, FakeTerm, moveCursor, screen, source, type Screen } from "./helpers.js";
import type { PendingTool } from "../../src/prompt/match.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
/** Source without comment lines (they may name the flag). */
const code = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));

describe("--force in the source", () => {
  it("appears as a string in exactly one file: prompt/other.ts", () => {
    const hits = files(SRC)
      .filter((f) => /\.(ts|mjs|js)$/.test(f))
      .filter((f) => /["'`]--force["'`]/.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual(["prompt/other.ts"]);
  });

  it("only otherSendArgs builds it, behind the confirmation check", () => {
    const src = readFileSync(join(SRC, "prompt/other.ts"), "utf8");
    expect(src.match(/--force/g)!.length).toBeGreaterThan(0);
    const fn = src.slice(src.indexOf("export function otherSendArgs"));
    // The guard comes before the argv.
    expect(fn.indexOf("issued.has(c)")).toBeGreaterThan(0);
    expect(fn.indexOf("issued.has(c)")).toBeLessThan(fn.indexOf('"--force"'));
  });
});

/** Every argv a runner saw. */
function recorder(term: FakeTerm) {
  const calls: string[][] = [];
  const run: Runner = async (c, a, o) => {
    calls.push(a);
    return term.runner(c, a, o);
  };
  return { calls, run };
}
const forced = (calls: string[][]) => calls.some((a) => a.includes("--force"));

/** All the bridge's terminal actors over one fake terminal, routed as the app routes them. */
function all(name: Screen, pending: PendingTool[]) {
  const term = new FakeTerm(screen(name));
  const rec = recorder(term);
  const s = source(term, pending);
  const prompts = promptAnswerActor({ run: rec.run, source: s.src, binaries: { hc: "hc" } as never, sleep: async () => {}, postCheckMs: 30 });
  const send = terminalSendActor({ run: rec.run, binaries: { hc: "hc" } as never });
  const keys = terminalKeysActor({ run: rec.run, binaries: { hc: "hc" } as never, menu: { current: () => ({ rev: "0123456789abcdef", keys: [{ id: "esc", label: "Esc", keys: ["esc"] }] }) } as never });
  const route = routeActs([send, keys, prompts]);
  const act = (kind: string, args: Record<string, unknown>) => route(CLIENT() as never, kind, args);
  return { term, rec, s, act };
}

describe("--force is unreachable from every other path", () => {
  it("composer send (terminal.send), even with the text --force", async () => {
    const { rec, act } = all("ask-single", [ASK1]);
    await act("terminal.send", { terminal: "t3", text: "--force" });
    await act("terminal.send", { terminal: "t3", text: "hello" });
    expect(rec.calls.length).toBe(2);
    for (const a of rec.calls) expect(a.slice(0, 3)).toEqual(["send", "--json", "--"]);
  });

  it("Stop (agent.stop is CV8: no actor here runs anything for it)", async () => {
    const { rec, act } = all("permission", [BASH]);
    expect(await act("agent.stop", { terminal: "t3" })).toEqual({ ok: false, code: "unsupported_action" });
    // The key menu's Esc presses keys, never sends.
    await act("terminal.keys", { terminal: "t3", key: "esc", rev: "0123456789abcdef" });
    expect(forced(rec.calls)).toBe(false);
  });

  it("option presses (permission, plan-like, question option, multi-select)", async () => {
    for (const [name, pending, choice] of [
      ["permission", [BASH], { option: 3 }],
      ["ask-single", [ASK1], { option: 2 }],
      ["ask-multi", [ASKM], { picks: [0, 1] }],
    ] as const) {
      const { rec, s, act, term } = all(name, [...pending]);
      const r = await act("prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice });
      expect(r.ok).toBe(true);
      expect(term.answered).not.toBeNull();
      expect(forced(rec.calls)).toBe(false);
      expect(rec.calls.some((a) => a[0] === "send")).toBe(false);
    }
  });

  it("an unparseable prompt", async () => {
    const { rec, s, act } = all("ask-single", [{ ...ASK1, id: "x", input: { questions: [] } }]);
    expect(s.card.kind).toBe("unparsed");
    expect((await act("prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { other: "x" } })).code).toBe("bad_choice");
    expect(rec.calls).toEqual([]);
  });

  it("a stale prompt_id or rev", async () => {
    const { rec, s, act } = all("ask-single", [ASK1]);
    expect((await act("prompt.answer", { terminal: "t3", prompt_id: "f".repeat(64), rev: "rev-1", choice: { other: "x" } })).code).toBe("prompt_changed");
    expect((await act("prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "old", choice: { other: "x" } })).code).toBe("prompt_changed");
    expect(rec.calls).toEqual([]);
  });

  it("an unconfirmed field: the cursor never reached Other", async () => {
    const { rec, s, act, term } = all("ask-single", [ASK1]);
    term.keysReply = () => ({ code: 0, stdout: "{}", stderr: "" });
    expect((await act("prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { other: "x" } })).code).toBe("prompt_moved");
    expect(forced(rec.calls)).toBe(false);
  });

  it("an unconfirmed field: the cursor landed on Chat about this instead", async () => {
    const { rec, s, act, term } = all("ask-single", [ASK1]);
    term.keysReply = () => {
      term.screen = moveCursor(screen("ask-single"), 4);
      return { code: 0, stdout: "{}", stderr: "" };
    };
    expect((await act("prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { other: "x" } })).code).toBe("prompt_moved");
    expect(forced(rec.calls)).toBe(false);
  });

  it("the confirmed Other path is the one that does force (so the checks above are not vacuous)", async () => {
    const { rec, s, act } = all("ask-single", [ASK1]);
    expect((await act("prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { other: "Project Alpha answer 1" } })).ok).toBe(true);
    expect(rec.calls.filter((a) => a.includes("--force"))).toEqual([["send", "--json", "--force", "--", "t3", "Project Alpha answer 1"]]);
  });
});

describe("the guard itself (fails if it is deleted)", () => {
  const card = matchPrompt([ASK1], screen("ask-single"));
  const exp = { promptId: card.promptId, toolUseId: ASK1.id, pending: [ASK1] };

  it("a look-alike confirmation is refused", () => {
    const forged = { terminal: "t3", promptId: card.promptId, at: 1000 } as unknown as OtherFieldConfirmation;
    expect(() => otherSendArgs(forged, "t3", card.promptId, "x", 1000)).toThrow();
  });

  it("only the H0 Other shape confirms", () => {
    expect(confirmOtherField("t3", screen("ask-single"), exp, 1000)).toBeNull(); // cursor on Option A
    expect(confirmOtherField("t3", moveCursor(screen("ask-single"), 4), exp, 1000)).toBeNull(); // Chat about this
    expect(confirmOtherField("t3", screen("ask-other"), { ...exp, toolUseId: "other" }, 1000)).toBeNull();
    expect(confirmOtherField("t3", screen("ask-other"), { ...exp, promptId: "0".repeat(64) }, 1000)).toBeNull();
    expect(confirmOtherField("t3", screen("permission"), exp, 1000)).toBeNull();
    expect(confirmOtherField("t3", screen("ask-other").replace("Type something.", "Type something else."), exp, 1000)).toBeNull();
    expect(confirmOtherField("t3", screen("ask-other"), exp, 1000)).not.toBeNull();
  });

  it("a confirmation is used once, for its own terminal and prompt, while fresh", () => {
    const c = confirmOtherField("t3", screen("ask-other"), exp, 1000)!;
    expect(otherSendArgs(c, "t3", card.promptId, "hi", 1500)).toEqual(["send", "--json", "--force", "--", "t3", "hi"]);
    expect(() => otherSendArgs(c, "t3", card.promptId, "hi", 1500)).toThrow();
    const d = confirmOtherField("t3", screen("ask-other"), exp, 1000)!;
    expect(() => otherSendArgs(d, "t4", card.promptId, "hi", 1500)).toThrow();
    const e = confirmOtherField("t3", screen("ask-other"), exp, 1000)!;
    expect(() => otherSendArgs(e, "t3", "1".repeat(64), "hi", 1500)).toThrow();
    const f = confirmOtherField("t3", screen("ask-other"), exp, 1000)!;
    expect(() => otherSendArgs(f, "t3", card.promptId, "hi", 1000 + OTHER_CONFIRM_MAX_MS + 1)).toThrow();
    const g = confirmOtherField("t3", screen("ask-other"), exp, 1000)!;
    expect(() => otherSendArgs(g, "t3", card.promptId, "a\nb", 1500)).toThrow();
  });
});

describe("the confirm footer (review L3)", () => {
  it("the Other field is confirmed only with the H0 footer (Enter to select …)", () => {
    const card = matchPrompt([ASK1], screen("ask-single"));
    const exp = { promptId: card.promptId, toolUseId: ASK1.id, pending: [ASK1] };
    const other = screen("ask-other");
    expect(confirmOtherField("t3", other, exp, 1000)).not.toBeNull();
    // A field being edited shows another footer: not the recorded shape.
    const editing = other.replace(/^Enter to select .*$/m, "Esc to cancel · ctrl+g to edit in VS Code");
    expect(confirmOtherField("t3", editing, exp, 1000)).toBeNull();
  });
});
