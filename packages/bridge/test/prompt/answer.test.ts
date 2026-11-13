import { describe, expect, it } from "vitest";
import { promptAnswerActor } from "../../src/prompt/answer.js";
import { ASK1, ASKM, BASH, CLIENT, FakeTerm, IDLE, PLAN, screen, source, type Screen } from "./helpers.js";
import type { PendingTool } from "../../src/prompt/match.js";

const fast = { sleep: async () => {}, postCheckMs: 50 };

function setup(name: Screen, pending: PendingTool[], o: { blocked?: boolean } = {}) {
  const term = new FakeTerm(screen(name));
  const s = source(term, pending, o);
  const actor = promptAnswerActor({ run: term.runner, source: s.src, binaries: { hc: "hc" } as never, ...fast });
  const answer = async (choice: unknown, over: Record<string, unknown> = {}) =>
    (await actor(CLIENT(), "prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice, ...over }))!;
  return { term, s, actor, answer };
}

describe("prompt.answer: option presses", () => {
  it("the cursor's own row: no phase A, then Enter alone", async () => {
    const { term, answer, s } = setup("permission", [BASH]);
    const r = await answer({ option: 0 });
    expect(r).toEqual({ ok: true, audit_label: "a permission prompt\noption 1 of 4 (Yes)" });
    expect(term.keys).toEqual([["enter"]]);
    expect(term.answered).toBe("Yes");
    expect(s.state.answered).toEqual([s.card.promptId]);
  });

  it("another row: arrows only, a re-read on that row, then Enter", async () => {
    const { term, answer } = setup("permission", [BASH]);
    const r = await answer({ option: 3 });
    expect(r.ok).toBe(true);
    expect(term.keys).toEqual([["down", "down", "down"], ["enter"]]);
    expect(term.answered).toBe("No");
    // read (check), read (phase A verify), then post-check reads.
    const kinds = term.calls.map((c) => c[0]);
    expect(kinds.slice(0, 4)).toEqual(["read", "keys", "read", "keys"]);
  });

  it("\"don't ask again\" is pressable; Activity gets the label up to its colon, never the command", async () => {
    const { answer } = setup("permission", [BASH]);
    const r = await answer({ option: 1 });
    expect(r.ok).toBe(true);
    expect(r.audit_label).toBe("a permission prompt\noption 2 of 4 (Yes, and don’t ask again for)");
  });

  it("the plan's auto-mode option is pressable", async () => {
    const { term, answer } = setup("plan", [PLAN]);
    expect((await answer({ option: 0 })).ok).toBe(true);
    expect(term.answered).toBe("Yes, and use auto mode");
  });

  it("a single-select question by its option", async () => {
    const { term, answer } = setup("ask-single", [ASK1]);
    const r = await answer({ option: 1 });
    expect(r).toEqual({ ok: true, audit_label: "a question\noption 2 of 3 (Option B)" });
    expect(term.keys).toEqual([["down"], ["enter"]]);
  });

  it("digits are never pressed, and only up/down/space/enter ever are", async () => {
    const { term, answer } = setup("permission", [BASH]);
    await answer({ option: 2 });
    for (const k of term.keys.flat()) expect(["up", "down", "space", "enter"]).toContain(k);
  });
});

describe("prompt.answer: refusals press nothing", () => {
  it("a stale prompt_id or rev", async () => {
    const { term, answer } = setup("permission", [BASH]);
    expect((await answer({ option: 0 }, { prompt_id: "0".repeat(64) })).code).toBe("prompt_changed");
    expect((await answer({ option: 0 }, { rev: "rev-0" })).code).toBe("prompt_changed");
    expect(term.calls).toEqual([]);
  });

  it("the screen shows another prompt now", async () => {
    const { term, answer } = setup("permission", [BASH]);
    term.screen = screen("permission").replace("4. No", "4. Nope");
    expect((await answer({ option: 0 })).code).toBe("prompt_changed");
    expect(term.keys).toEqual([]);
  });

  it("the prompt left the screen: already answered on the desk", async () => {
    const { term, answer } = setup("permission", [BASH]);
    term.screen = IDLE;
    expect((await answer({ option: 0 })).code).toBe("prompt_gone");
    expect(term.keys).toEqual([]);
  });

  it("the transcript no longer has the call pending, or the host is not blocked", async () => {
    const a = setup("permission", [BASH]);
    a.s.state.pending = [];
    expect((await a.answer({ option: 0 })).code).toBe("prompt_changed");
    expect(a.term.keys).toEqual([]);
    const b = setup("permission", [BASH]);
    b.s.state.blocked = false;
    expect((await b.answer({ option: 0 })).code).toBe("prompt_changed");
    expect(b.term.keys).toEqual([]);
  });

  it("a choice that doesn't fit the card", async () => {
    const { term, answer } = setup("permission", [BASH]);
    expect((await answer({ option: 4 })).code).toBe("bad_choice");
    expect((await answer({ picks: [0] })).code).toBe("bad_choice");
    expect((await answer({ other: "x" })).code).toBe("bad_choice");
    expect(term.calls).toEqual([]);
  });

  it("an unparsed card has no buttons", async () => {
    const { term, answer } = setup("permission", [{ ...BASH, input: { command: "something else" } }]);
    expect((await answer({ option: 0 })).code).toBe("bad_choice");
    expect(term.calls).toEqual([]);
  });

  it("bad arguments", async () => {
    const { term, actor } = setup("permission", [BASH]);
    expect((await actor(CLIENT(), "prompt.answer", { terminal: "t3", prompt_id: "x", rev: "r", choice: { option: 0 } }))!.code).toBe("bad_args");
    expect((await actor(CLIENT(), "prompt.answer", { terminal: "t3", prompt_id: "0".repeat(64), rev: "r", choice: { other: "a\nb" } }))!.code).toBe("bad_args");
    expect(term.calls).toEqual([]);
  });

  it("phase A lands elsewhere (the screen moved under it): no Enter", async () => {
    const { term, answer } = setup("permission", [BASH]);
    term.keysReply = () => ({ code: 0, stdout: "{}", stderr: "" }); // pressed, but the cursor didn't move
    expect((await answer({ option: 2 })).code).toBe("prompt_changed");
    expect(term.keys).toEqual([["down", "down"]]);
  });

  it("phase A kept waiting by the desk: busy, no Enter", async () => {
    const { term, answer } = setup("permission", [BASH]);
    term.keysReply = () => ({ code: null, stdout: "", stderr: "", error: "timeout" });
    expect((await answer({ option: 2 })).code).toBe("busy");
    expect(term.keys.flat()).not.toContain("enter");
  });

  it("one answer at a time per terminal, across devices", async () => {
    const { term, s, actor } = setup("permission", [BASH]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = term.runner;
    const slow = promptAnswerActor({
      run: async (c, a, o) => {
        if (a[0] === "keys") await gate;
        return orig(c, a, o);
      },
      source: s.src,
      binaries: { hc: "hc" } as never,
      ...fast,
    });
    const args = { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { option: 0 } };
    const first = slow(CLIENT("d-0000000000000001"), "prompt.answer", args);
    await new Promise((r) => setTimeout(r, 5));
    expect((await slow(CLIENT("d-0000000000000002"), "prompt.answer", args))!.code).toBe("busy");
    release();
    expect((await first)!.ok).toBe(true);
    void actor;
  });

  it("a prompt answered once is gone for a second answer", async () => {
    const { s, answer, term } = setup("permission", [BASH]);
    const card = s.card;
    expect((await answer({ option: 0 })).ok).toBe(true);
    s.setPublished({ match: card, rev: "rev-1" });
    term.calls = [];
    expect((await answer({ option: 0 })).code).toBe("prompt_gone");
    expect(term.calls).toEqual([]);
  });
});

describe("prompt.answer: the effect", () => {
  it("Enter that changes nothing within the window: unknown_effect, never pressed again", async () => {
    const { term, answer } = setup("permission", [BASH]);
    term.keysReply = (a) => (a.includes("enter") ? { code: 0, stdout: "{}", stderr: "" } : undefined);
    const r = await answer({ option: 0 });
    expect(r).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(term.keys.filter((k) => k.includes("enter")).length).toBe(1);
  });

  it("hc fails on Enter in a way that may have pressed it: unknown_effect", async () => {
    const { term, answer } = setup("permission", [BASH]);
    term.keysReply = (a) => (a.includes("enter") ? { code: null, stdout: "", stderr: "", error: "timeout" } : undefined);
    expect(await answer({ option: 0 })).toMatchObject({ ok: false, unknown_effect: true });
  });

  it("cancel (the device lost prompt.answer) stops the answer in flight", async () => {
    const term = new FakeTerm(screen("permission"));
    const s = source(term, [BASH]);
    const actor: ReturnType<typeof promptAnswerActor> = promptAnswerActor({
      run: async (c, a, o) => {
        if (a[0] === "keys") actor.cancel("d-0000000000000001");
        if (o.signal?.aborted) return { code: null, stdout: "", stderr: "", error: "aborted" };
        return term.runner(c, a, o);
      },
      source: s.src,
      binaries: { hc: "hc" } as never,
      ...fast,
    });
    const r = await actor(CLIENT(), "prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { option: 2 } });
    expect(r).toMatchObject({ ok: false, code: "cancelled" });
    expect(term.keys).toEqual([]);
  });
});

describe("prompt.answer: multi-select", () => {
  it("ticks each pick in phase A, verifies, Submit, checks the review, then confirms", async () => {
    const { term, answer } = setup("ask-multi", [ASKM]);
    const r = await answer({ picks: [2, 0] });
    expect(r).toEqual({ ok: true, audit_label: "a question\noptions 1, 3 of 3 (Lint, Unit tests)" });
    expect(term.keys).toEqual([["space"], ["down", "down", "space"], ["down", "down"], ["enter"], ["enter"]]);
    expect(term.answered).toBe("review:Submit answers");
  });

  it("a box ticked at the desk is unticked to match the phone's picks", async () => {
    const { term, answer } = setup("ask-multi-after-space", [ASKM]);
    expect((await answer({ picks: [1] })).ok).toBe(true);
    expect(term.keys.slice(0, 2)).toEqual([["space"], ["down", "space"]]);
  });

  it("a review that doesn't list the picks: no second Enter", async () => {
    const { term, answer } = setup("ask-multi", [ASKM]);
    term.beforeRead = () => {
      if (term.screen.includes("Review your answers")) term.screen = term.screen.replace(/→ .*/, "→ Typecheck");
    };
    expect((await answer({ picks: [0] })).code).toBe("prompt_changed");
    expect(term.keys.filter((k) => k[0] === "enter").length).toBe(1);
    expect(term.answered).toBeNull();
  });

  it("Other on a multi-select is refused (not recorded)", async () => {
    const { term, answer } = setup("ask-multi", [ASKM]);
    expect((await answer({ other: "x" })).code).toBe("bad_choice");
    expect((await answer({ option: 0 })).code).toBe("bad_choice");
    expect(term.calls).toEqual([]);
  });
});

describe("prompt.answer: Other", () => {
  it("moves to the Other row, confirms the field on a fresh read, then the one forced send", async () => {
    const { term, answer } = setup("ask-single", [ASK1]);
    const r = await answer({ other: "Project Alpha answer 1" });
    expect(r).toEqual({ ok: true, audit_label: "a question\nown answer (22 chars)" });
    expect(term.keys).toEqual([["down", "down", "down"]]);
    const sends = term.calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--json", "--force", "--", "t3", "Project Alpha answer 1"]]);
    expect(term.answered).toBe("Project Alpha answer 1");
  });

  it("the cursor already on Other (ask-other): no arrows", async () => {
    const term = new FakeTerm(screen("ask-other"));
    const s = source(term, [ASK1]);
    const actor = promptAnswerActor({ run: term.runner, source: s.src, binaries: { hc: "hc" } as never, ...fast });
    const r = await actor(CLIENT(), "prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { other: "a" } });
    expect(r!.ok).toBe(true);
    expect(term.keys).toEqual([]);
  });

  it("the field not confirmed (the cursor didn't reach Other): refused, no --force", async () => {
    const { term, answer } = setup("ask-single", [ASK1]);
    term.keysReply = () => ({ code: 0, stdout: "{}", stderr: "" });
    expect((await answer({ other: "x" })).code).toBe("prompt_changed");
    expect(term.forced).toBe(false);
    expect(term.calls.some((c) => c[0] === "send")).toBe(false);
  });

  it("the prompt changed between phase A and the confirming read: refused, no --force", async () => {
    const { term, answer } = setup("ask-single", [ASK1]);
    term.beforeRead = (n) => {
      if (n === 1) term.screen = term.screen.replace("Option C", "Option Z");
    };
    expect((await answer({ other: "x" })).code).toBe("prompt_changed");
    expect(term.forced).toBe(false);
  });
});
