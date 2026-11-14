// CV9: AskUserQuestion with several questions (Claude Code's tabbed question UI), against the H0 CV9 recordings.
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { promptAnswerActor } from "../../src/prompt/answer.js";
import { isSeveralReviewOf, matchPrompt, tabMarks, type PendingTool } from "../../src/prompt/match.js";
import { confirmOtherField, otherSendArgs } from "../../src/prompt/other.js";
import { parseScreen } from "../../src/prompt/screen.js";
import { ASK1, ASKM, CLIENT, FakeTerm, screen, source, type Screen } from "./helpers.js";
import { ASKQ, ASKR, blockOf, FakeSeveral } from "./several.js";
import type { PromptSource, PublishedPrompt } from "../../src/prompt/answer.js";

const T = "t3";

describe("the fake tabbed UI draws what the rig recorded", () => {
  const steps: [Screen, PendingTool, (f: FakeSeveral) => void][] = [
    ["askq-q1", ASKQ, () => {}],
    ["askq-q2", ASKQ, (f) => f.press("right")],
    ["askq-review-unanswered", ASKQ, (f) => ["right", "right", "right"].forEach((k) => f.press(k))],
    ["askq-q1-on-option2", ASKQ, (f) => f.press("down")],
    ["askq-q2-after-enter", ASKQ, (f) => ["down", "enter"].forEach((k) => f.press(k))],
    ["askq-q2-ticked", ASKQ, (f) => ["down", "enter", "space", "down", "down", "space"].forEach((k) => f.press(k))],
    ["askq-q2-on-next", ASKQ, (f) => ["down", "enter", "space", "down", "down", "space", "down", "down"].forEach((k) => f.press(k))],
    ["askq-q3-after-next", ASKQ, (f) => ["down", "enter", "space", "down", "down", "space", "down", "down", "enter"].forEach((k) => f.press(k))],
    ["askq-q3-on-other", ASKQ, (f) => ["down", "enter", "space", "down", "down", "space", "down", "down", "enter", "down", "down"].forEach((k) => f.press(k))],
    ["askr-q1", ASKR, () => {}],
    ["askr-q2-on-submit", ASKR, (f) => ["enter", "space", "down", "down", "down"].forEach((k) => f.press(k))],
    ["askr-review", ASKR, (f) => ["enter", "space", "down", "down", "down", "enter"].forEach((k) => f.press(k))],
  ];
  it.each(steps)("%s", (name, call, act) => {
    const f = new FakeSeveral(call);
    act(f);
    expect(blockOf(f.screen)).toBe(blockOf(screen(name)));
  });

  it("askq-review and askq-q3-revisit (an Other answer)", async () => {
    const f = new FakeSeveral(ASKQ);
    ["down", "enter", "space", "down", "down", "space", "down", "down", "enter", "down", "down"].forEach((k) => f.press(k));
    await f.runner("hc", ["send", "--json", "--force", "--", T, "Project Alpha answer 3"], {} as never);
    expect(blockOf(f.screen)).toBe(blockOf(screen("askq-review")));
    f.press("left");
    expect(blockOf(f.screen)).toBe(blockOf(screen("askq-q3-revisit")));
  });
});

describe("matching (T + S + V)", () => {
  const card = matchPrompt([ASKQ], screen("askq-q1"));

  it("every tab of the recorded prompt is the same card, at its own tab", () => {
    expect(card.kind).toBe("question");
    expect(card.several?.tab).toBe(0);
    const tabs: [Screen, number][] = [
      ["askq-q2", 1],
      ["askq-q1-on-option2", 0],
      ["askq-q2-after-enter", 1],
      ["askq-q2-ticked", 1],
      ["askq-q2-on-next", 1],
      ["askq-q3-after-next", 2],
      ["askq-q3-on-other", 2],
      ["askq-review", 3],
      ["askq-review-unanswered", 3],
      ["askq-q2-after-other", 1],
      ["askq-q1-typed", 0],
    ];
    for (const [name, tab] of tabs) {
      const m = matchPrompt([ASKQ], screen(name));
      expect(m.promptId, name).toBe(card.promptId);
      expect(m.several?.tab, name).toBe(tab);
      expect(m.card, name).toEqual(card.card);
    }
    expect(matchPrompt([ASKQ], screen("askq-q2-after-enter")).several?.marks).toEqual([true, false, false]);
    expect(matchPrompt([ASKR], screen("askr-q2-on-submit")).several?.tab).toBe(1);
    expect(matchPrompt([ASKR], screen("askr-review")).several?.tab).toBe(2);
  });

  it("the card shows every question; Other only on the single-select ones; no buttons of its own", () => {
    expect(card.card.questions?.map((q) => [q.header, q.multi, q.other, q.options.length])).toEqual([
      ["Approach", false, true, 3],
      ["Checks", true, false, 3],
      ["Target", false, true, 2],
    ]);
    expect(card.card.options).toEqual([]);
    expect(card.buttons).toEqual([]);
    expect(card.otherRow).toBeNull();
    // It is a valid chat item.
    expect(bridgeApi.ChatItem.safeParse({ id: "p", at: null, role: "prompt", prompt_id: card.promptId, rev: "r", state: "open", ...card.card }).success).toBe(true);
  });

  it("a tab whose Other holds desk text, or a ticked multi-select Other, is read-only", () => {
    expect(matchPrompt([ASKQ], screen("askq-q3-revisit")).kind).toBe("unparsed");
    expect(matchPrompt([ASKQ], screen("askq-q2-other-typed")).kind).toBe("unparsed");
  });

  it("a picked single-select row (\"Nowhere ✔\") is still the card, and says which row", () => {
    const f = new FakeSeveral(ASKQ);
    ["enter", "down", "down", "down", "down", "enter", "down", "enter", "left"].forEach((k) => f.press(k));
    const m = matchPrompt([ASKQ], f.screen);
    expect(m.promptId).toBe(card.promptId);
    expect(m.several).toMatchObject({ tab: 2, picked: 1 });
  });

  it("anything that is not exactly the call is read-only (never a card that could press)", () => {
    const q1 = screen("askq-q1");
    const variants: [string, PendingTool[], string][] = [
      ["another call", [{ ...ASKR }], q1],
      ["a one-question call", [ASK1], q1],
      ["the headers in another order", [{ ...ASKQ, input: { questions: [...(ASKQ.input as { questions: unknown[] }).questions].reverse() } }], q1],
      ["two questions with the same text", [{ ...ASKQ, input: { questions: (ASKQ.input as { questions: Record<string, unknown>[] }).questions.map((q, i, all) => (i === 2 ? { ...q, question: all[0]!.question } : q)) } }], q1],
      ["a multi-select's Other ticked (desk text the card can't show)", [ASKQ], screen("askq-q2").replace("4. [ ] Type something", "4. [✔] Type something")],
      ["a tab line without the Submit tab", [ASKQ], q1.replace("  ✔ Submit  →", "  →")],
      ["a tab line with an extra header", [ASKQ], q1.replace("☐ Target", "☐ Target  ☐ Extra")],
      ["an option renamed", [ASKQ], q1.replace("2. Option B", "2. Option Z")],
      ["an extra option", [ASKQ], q1.replace("  4. Type something.", "  4. Option D\n  5. Type something.").replace("5. Chat about this", "6. Chat about this")],
      ["no Esc footer", [ASKQ], q1.replace(" · Esc to cancel", "")],
      ["a multi-select's Next on the last question", [ASKR], screen("askr-q2-on-submit").replace("❯    Submit", "❯    Next")],
      ["a multi-select's Submit before the last question", [ASKQ], screen("askq-q2-on-next").replace("❯    Next", "❯    Submit")],
      ["two picked rows", [ASKQ], q1.replace("1. Option A", "1. Option A ✔").replace("2. Option B", "2. Option B ✔")],
    ];
    for (const [what, pending, text] of variants) expect(matchPrompt(pending, text).kind, what).toBe("unparsed");
  });

  it("the tab line, exactly", () => {
    expect(tabMarks("←  ☐ Approach  ☒ Checks  ✔ Submit  →", ["Approach", "Checks"])).toEqual([false, true]);
    expect(tabMarks("←  ☐ Approach  ☒ Checks  ✔ Submit  →", ["Approach"])).toBeNull();
    expect(tabMarks(" ☐ Approach  ☒ Checks  ✔ Submit  →", ["Approach", "Checks"])).toBeNull();
    expect(tabMarks("←  ☐ Approach  ☒ Checks  ✔ Submit  → ", ["Approach", "Checks"])).toBeNull();
  });

  it("the review lists exactly the answers given", () => {
    const m = matchPrompt([ASKQ], screen("askq-review"));
    const p = parseScreen(screen("askq-review"));
    if (!p.ok || !m.several) throw new Error("no review");
    expect(isSeveralReviewOf(p.prompt, m.several, ["Option B", "Lint, Unit tests", "Project Alpha answer 3"])).toBe(true);
    expect(isSeveralReviewOf(p.prompt, m.several, ["Option A", "Lint, Unit tests", "Project Alpha answer 3"])).toBe(false);
    expect(isSeveralReviewOf(p.prompt, m.several, ["Option B", "Lint", "Project Alpha answer 3"])).toBe(false);
    expect(isSeveralReviewOf(p.prompt, m.several, ["Option B", "Lint, Unit tests"])).toBe(false);
    // Every tab must read answered.
    const half = parseScreen(screen("askq-review").replace("☒ Target", "☐ Target"));
    if (!half.ok) throw new Error("no review");
    expect(isSeveralReviewOf(half.prompt, m.several, ["Option B", "Lint, Unit tests", "Project Alpha answer 3"])).toBe(false);
    const u = parseScreen(screen("askq-review-unanswered"));
    if (!u.ok) throw new Error("no review");
    expect(isSeveralReviewOf(u.prompt, m.several, ["", "", ""])).toBe(false);
  });
});

/** The answer path over a fake tabbed UI, the card as the topic publishes it. */
function rig(call: PendingTool = ASKQ, o: { heldMs?: number; now?: () => number; prep?: (f: FakeSeveral) => void } = {}) {
  const f = new FakeSeveral(call);
  o.prep?.(f);
  const card = matchPrompt([call], f.screen);
  let pub: PublishedPrompt | undefined = { match: card, rev: "rev-1" };
  const done: string[] = [];
  const src: PromptSource = {
    current: () => pub,
    fresh: async () => ({ pending: f.answered !== null ? [] : [call], blocked: f.answered === null }),
    answered: (_t, id) => {
      done.push(id);
      pub = undefined;
    },
    isAnswered: (_t, id) => done.includes(id),
  };
  const actor = promptAnswerActor({ run: (c, a, x) => f.runner(c, a, x), source: src, binaries: { hc: "hc" } as never, sleep: async () => {}, postCheckMs: 30, ...(o.heldMs !== undefined ? { heldMs: o.heldMs } : {}), ...(o.now ? { now: o.now } : {}) });
  const answer = async (choice: unknown, rev = "rev-1") => (await actor(CLIENT() as never, "prompt.answer", { terminal: T, prompt_id: card.promptId, rev, choice }))!;
  return { f, card, answer, done };
}

describe("answering a card with several questions", () => {
  it("an option, ticks and an Other text: each step on its own checked screen, then Submit answers", async () => {
    const { f, answer, done, card } = rig();
    const r = await answer({ answers: [{ option: 1 }, { picks: [2, 0] }, { other: "Project Alpha answer 3" }] });
    expect(r).toMatchObject({ ok: true });
    expect(f.answered).toEqual(["Option B", "Lint, Unit tests", "Project Alpha answer 3"]);
    expect(done).toEqual([card.promptId]);
    // One press per call: arrows/space (phase A), then Enter alone; the Other text is the one forced send.
    expect(f.keys).toEqual([["down"], ["enter"], ["space"], ["down", "down", "space"], ["down", "down"], ["enter"], ["down", "down"], ["enter"]]);
    expect(f.forced).toEqual([["send", "--json", "--force", "--", T, "Project Alpha answer 3"]]);
    // Every press but the first follows a read.
    const kinds = f.calls.map((a) => a[0]);
    for (let i = 1; i < kinds.length; i++) if (kinds[i] !== "read") expect(kinds[i - 1], `call ${i}`).toBe("read");
    expect((r as { audit_label?: string }).audit_label).toBe("a question\n3 questions: option 2 of 3; options 1, 3 of 3; own answer (22 chars)");
  });

  it("the multi-select last: Enter on its Submit row opens the review", async () => {
    const { f, answer } = rig(ASKR);
    expect(await answer({ answers: [{ option: 0 }, { picks: [1] }] })).toMatchObject({ ok: true });
    expect(f.answered).toEqual(["main", "CHANGELOG"]);
    expect(f.forced).toEqual([]);
  });

  it("from another tab: back to question 1 with left, one tab at a time, the cursor first on row 1", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => ["right", "right", "down"].forEach((k) => x.press(k)) });
    expect(await answer({ answers: [{ option: 0 }, { picks: [1] }, { option: 1 }] })).toMatchObject({ ok: true });
    expect(f.keys.slice(0, 3)).toEqual([["up"], ["left"], ["left"]]);
    expect(f.answered).toEqual(["Option A", "Typecheck", "Nowhere"]);
  });

  it("from the review tab", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => ["right", "right", "right"].forEach((k) => x.press(k)) });
    expect(await answer({ answers: [{ option: 2 }, { picks: [0, 1, 2] }, { option: 0 }] })).toMatchObject({ ok: true });
    expect(f.keys.slice(0, 3)).toEqual([["left"], ["left"], ["left"]]);
    expect(f.answered).toEqual(["Option C", "Lint, Typecheck, Unit tests", "Staging"]);
  });

  it("what the desk already picked or ticked is overridden by the answers given", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => ["down", "enter", "space", "down", "space"].forEach((k) => x.press(k)) });
    // Desk: Option B, Lint + Typecheck; now on question 2.
    expect(await answer({ answers: [{ option: 0 }, { picks: [2] }, { option: 1 }] })).toMatchObject({ ok: true });
    expect(f.answered).toEqual(["Option A", "Unit tests", "Nowhere"]);
  });

  it("choices that don't fit the card: bad_choice, nothing run", async () => {
    for (const choice of [
      { answers: [{ option: 0 }, { picks: [0] }] }, // too few
      { answers: [{ option: 0 }, { picks: [0] }, { option: 0 }, { option: 0 }] }, // too many
      { answers: [{ picks: [0] }, { picks: [0] }, { option: 0 }] }, // picks on a single-select
      { answers: [{ option: 0 }, { option: 0 }, { option: 0 }] }, // option on a multi-select
      { answers: [{ option: 0 }, { other: "Lint please" }, { option: 0 }] }, // Other on a multi-select: not offered
      { answers: [{ option: 3 }, { picks: [0] }, { option: 0 }] }, // out of range
      { answers: [{ option: 0 }, { picks: [3] }, { option: 0 }] },
      { option: 0 },
      { picks: [0] },
      { other: "Project Alpha" },
    ]) {
      const { f, answer } = rig();
      expect((await answer(choice)).code, JSON.stringify(choice)).toBe("bad_choice");
      expect(f.calls).toEqual([]);
    }
    // And {answers} on a one-question card.
    const one = rig(ASKQ);
    one.card.several = null;
    expect((await one.answer({ answers: [{ option: 0 }, { option: 0 }] })).code).toBe("bad_choice");
  });

  it("a stale rev presses nothing", async () => {
    const { f, answer } = rig();
    expect((await answer({ answers: [{ option: 0 }, { picks: [0] }, { option: 0 }] }, "rev-0")).code).toBe("prompt_changed");
    expect(f.calls).toEqual([]);
  });

  it("an Enter that doesn't move on: prompt_moved, nothing more pressed", async () => {
    const { f, answer } = rig();
    f.reply = (a) => (a[0] === "keys" && a.includes("enter") ? { code: 0, stdout: "{}", stderr: "" } : undefined);
    expect((await answer({ answers: [{ option: 1 }, { picks: [0] }, { option: 0 }] })).code).toBe("prompt_moved");
    expect(f.keys).toEqual([["down"], ["enter"]]);
    expect(f.answered).toBeNull();
  });

  it("the desk moves the cursor between steps: prompt_moved before any Enter", async () => {
    const { f, answer } = rig();
    f.beforeRead = (n) => {
      if (n === 1) f.press("down"); // after our down, the desk presses down too
    };
    expect((await answer({ answers: [{ option: 1 }, { picks: [0] }, { option: 0 }] })).code).toBe("prompt_moved");
    expect(f.keys).toEqual([["down"]]);
  });

  it("the desk answers question 2 meanwhile: the screen shows question 3, not 2 with our ticks; nothing more pressed", async () => {
    const { f, answer } = rig();
    f.beforeRead = (n) => {
      // After our Enter on question 1, the desk ticks and moves on.
      if (n === 2) ["space", "down", "down", "down", "down", "enter"].forEach((k) => f.press(k));
    };
    const r = await answer({ answers: [{ option: 1 }, { picks: [2] }, { option: 0 }] });
    expect(r.ok).toBe(false);
    expect(f.answered).toBeNull();
    expect(f.keys.at(-1)).toEqual(["enter"]);
    expect(f.keys.filter((k) => k[0] === "enter").length).toBe(1);
  });

  it("a review that lists something else: stopped after 3 of 3, Submit answers never pressed", async () => {
    const { f, answer } = rig();
    f.beforeRead = () => {
      if (f.tab === 3 && f.ticks[1]![1] === false) f.ticks[1]![1] = true; // the desk ticks Typecheck on the way
    };
    expect((await answer({ answers: [{ option: 1 }, { picks: [0] }, { option: 0 }] })).code).toBe("prompt_partial");
    expect(f.answered).toBeNull();
    expect(f.tab).toBe(3);
  });

  it("an intermediate Enter held by the desk: unknown_effect, nothing more pressed", async () => {
    let t = 0;
    const { f, answer } = rig(ASKQ, { now: () => t, heldMs: 1000 });
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("enter")) t += 2000;
      return undefined;
    };
    const r = await answer({ answers: [{ option: 0 }, { picks: [0] }, { option: 0 }] });
    expect(r).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(f.keys).toEqual([["enter"]]);
  });

  it("the Other send held by the desk: unknown_effect, nothing more pressed", async () => {
    let t = 0;
    const { f, answer } = rig(ASKQ, { now: () => t, heldMs: 1000 });
    f.reply = (a) => {
      if (a[0] === "send") t += 2000;
      return undefined;
    };
    const r = await answer({ answers: [{ other: "Project Alpha answer 1" }, { picks: [0] }, { option: 0 }] });
    expect(r).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(f.forced.length).toBe(1);
    expect(f.keys).toEqual([["down", "down", "down"]]);
  });

  it("the Other send is timed by its effect: hc's own ~5 s wait for a turn (rig CV9) is not a hold", async () => {
    let t = 0;
    const { f, answer } = rig(ASKQ, { now: () => t, heldMs: 1000 });
    // Each read takes 150 ms of the fake clock; hc pastes and presses Enter at once, then returns 5.7 s later.
    f.beforeRead = () => void (t += 150);
    const runner = f.runner;
    f.runner = async (cmd, args, opts) => {
      if (args[0] !== "send") return runner(cmd, args, opts);
      const r = await runner(cmd, args, opts);
      const end = t + 5700;
      while (t < end) {
        t += 50;
        await new Promise<void>((res) => setImmediate(res));
      }
      return { ...r, stdout: '{"started":false,"status":"blocked","turn":1}' };
    };
    const r = await answer({ answers: [{ other: "Project Alpha answer 1" }, { picks: [0] }, { other: "Project Alpha answer 3" }] });
    expect(r).toMatchObject({ ok: true });
    expect(f.answered).toEqual(["Project Alpha answer 1", "Lint", "Project Alpha answer 3"]);
  });

  it("the Other send whose next tab shows only after 1 s (the desk was typing): unknown_effect, nothing more pressed", async () => {
    let t = 0;
    const { f, answer } = rig(ASKQ, { now: () => t, heldMs: 1000 });
    f.beforeRead = () => void (t += 150);
    const runner = f.runner;
    let sent = false;
    f.runner = async (cmd, args, opts) => {
      if (args[0] !== "send") return runner(cmd, args, opts);
      // hc waits for the desk first: the text lands 2 s later.
      const end = t + 2000;
      while (t < end) {
        t += 50;
        await new Promise<void>((res) => setImmediate(res));
      }
      sent = true;
      return runner(cmd, args, opts);
    };
    const r = await answer({ answers: [{ other: "Project Alpha answer 1" }, { picks: [0] }, { option: 0 }] });
    expect(r, JSON.stringify(r)).toMatchObject({ code: "unknown_effect" });
    expect(sent).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(f.keys).toEqual([["down", "down", "down"]]);
  });

  it("an Enter that shows the next tab without marking the question answered: never followed", async () => {
    const { f, answer } = rig();
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("enter") && f.tab === 0) {
        f.tab = 1;
        f.cursor = 0;
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return undefined;
    };
    const r = await answer({ answers: [{ option: 0 }, { picks: [0] }, { option: 0 }] });
    expect(r.ok).toBe(false);
    expect(f.keys).toEqual([["enter"]]);
  });

  it("a tick whose re-read shows the cursor elsewhere: nothing more is ticked", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => ["enter"].forEach((k) => x.press(k)) });
    let ticks = 0;
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("space") && ++ticks === 1) {
        f.press("space");
        f.press("down"); // the desk moves the cursor right after
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return undefined;
    };
    expect((await answer({ answers: [{ option: 0 }, { picks: [0, 2] }, { option: 0 }] })).code).toBe("prompt_partial");
    expect(f.keys.filter((k) => k.includes("space")).length).toBe(1);
  });

  it("a box the desk unticks while the bridge ticks another: refused before Enter on Next", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => ["enter"].forEach((k) => x.press(k)) });
    let ticks = 0;
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("space") && ++ticks === 2) {
        for (const k of a.slice(a.indexOf("--") + 2)) f.press(k);
        f.ticks[1]![0] = false; // the desk unticks Lint
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return undefined;
    };
    expect((await answer({ answers: [{ option: 0 }, { picks: [0, 2] }, { option: 0 }] })).code).toBe("prompt_partial");
    expect(f.keys.filter((k) => k[0] === "enter").length).toBe(1);
  });

  it("the review with the cursor on Cancel: Enter never pressed there", async () => {
    const { f, answer } = rig();
    f.beforeRead = () => {
      if (f.tab === 3) f.cursor = 1;
    };
    expect((await answer({ answers: [{ option: 0 }, { picks: [0] }, { option: 0 }] })).code).toBe("prompt_partial");
    expect(f.answered).toBeNull();
    expect(f.keys.filter((k) => k[0] === "enter").length).toBe(3);
  });

  it("a left that doesn't move the tab: prompt_moved, no second left", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => x.press("right") });
    f.reply = (a) => (a[0] === "keys" && a.includes("left") ? { code: 0, stdout: "{}", stderr: "" } : undefined);
    expect((await answer({ answers: [{ option: 0 }, { picks: [0] }, { option: 0 }] })).code).toBe("prompt_moved");
    expect(f.keys).toEqual([["left"]]);
  });

  it("an Enter that leaves the prompt (the desk answered it): unknown_effect", async () => {
    const { f, answer } = rig();
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("enter")) f.answered = "esc";
      return undefined;
    };
    expect(await answer({ answers: [{ option: 0 }, { picks: [0] }, { option: 0 }] })).toMatchObject({ code: "unknown_effect", unknown_effect: true });
  });

  it("the Other field not confirmed (the cursor did not reach it): no forced send", async () => {
    const { f, answer } = rig();
    f.reply = (a) => (a[0] === "keys" ? { code: 0, stdout: "{}", stderr: "" } : undefined);
    expect((await answer({ answers: [{ other: "Project Alpha answer 1" }, { picks: [0] }, { option: 0 }] })).code).toBe("prompt_moved");
    expect(f.forced).toEqual([]);
  });

  it("hc refuses a phase A press (the desk typing): busy, nothing answered", async () => {
    const { f, answer } = rig();
    f.reply = (a) => (a[0] === "keys" ? { code: 1, stdout: "", stderr: "", error: "timeout" } : undefined);
    expect((await answer({ answers: [{ option: 1 }, { picks: [0] }, { option: 0 }] })).code).toBe("busy");
    expect(f.answered).toBeNull();
  });
});

describe("every step's own check (review M2)", () => {
  const ANS = { answers: [{ option: 1 }, { picks: [0, 2] }, { option: 0 }] };

  it("the desk switches tab while the cursor lands on the same row number: no Enter on the other question", async () => {
    const { f, answer } = rig();
    f.reply = (a) => {
      if (a[0] === "keys" && f.tab === 0 && a.includes("down")) {
        f.press("right");
        f.cursor = 1;
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return undefined;
    };
    expect((await answer(ANS)).code).toBe("prompt_moved");
    expect(f.keys.some((k) => k.includes("enter"))).toBe(false);
  });

  it("the cursor is not on Next after the move there (the desk moved it): no Enter", async () => {
    const { f, answer } = rig();
    f.reply = (a) => {
      const ks = a.slice(a.indexOf("--") + 2);
      if (a[0] === "keys" && f.tab === 1 && ks.every((k) => k === "down") && f.cursor + ks.length === 4) {
        ks.forEach((k) => f.press(k));
        f.press("up");
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return undefined;
    };
    expect((await answer(ANS)).code).toBe("prompt_partial");
    expect(f.keys.filter((k) => k.includes("enter")).length).toBe(1);
  });

  it("a left that skips a tab: refused, nothing picked", async () => {
    const { f, answer } = rig(ASKQ, { prep: (x) => ["right", "right"].forEach((k) => x.press(k)) });
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("left")) {
        f.press("left");
        f.press("left");
        return { code: 0, stdout: "{}", stderr: "" };
      }
      return undefined;
    };
    expect((await answer(ANS)).code).toBe("prompt_moved");
    expect(f.keys).toEqual([["left"]]);
  });

  it("the final Enter on Submit answers held by the desk: unknown_effect, held in Activity", async () => {
    let t = 0;
    const { f, answer } = rig(ASKQ, { now: () => t, heldMs: 1000 });
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("enter") && f.tab === 3) t += 3000;
      return undefined;
    };
    const r = await answer(ANS);
    expect(r).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(r.audit_label).toMatch(/held 3 s while the desk was typing$/);
    expect(f.answered).not.toBeNull();
  });

  it("a header line between the tab line and the question: read-only", () => {
    // Its own paragraph, so the title (the last paragraph) is still the question's.
    const text = screen("askq-q1").replace("\nQuestion Title 123", "\nNote from Agent 1\n\nQuestion Title 123");
    const p = parseScreen(text);
    expect(p.ok && p.prompt.title).toBe("Question Title 123: which approach should Agent 1 take?");
    expect(matchPrompt([ASKQ], text).kind).toBe("unparsed");
  });
});

describe("a walk that stops partway says how far it got (review H1)", () => {
  const ANS = { answers: [{ option: 1 }, { picks: [0, 2] }, { option: 0 }] };
  const refusedKeys = (kind: string) => ({ code: 1, stdout: "", stderr: `{"error":{"kind":"${kind}"}}` });

  it("hc refuses a tick after question 1 was answered: prompt_partial 1 of 3, never 'nothing was pressed'", async () => {
    const { f, answer } = rig();
    f.reply = (a) => (a[0] === "keys" && a.includes("space") ? refusedKeys("usage") : undefined);
    const r = await answer(ANS);
    expect(r).toMatchObject({ ok: false, code: "prompt_partial", message: "Stopped after 1 of 3 answers. Nothing was submitted." });
    expect(r.audit_label).toBe("a question\nstopped after 1 of 3: option 2 of 3; options 1, 3 of 3; option 1 of 2");
    expect(f.picked[0]).toBe(1);
  });

  it("hc says the terminal is gone on question 2's Enter: prompt_partial 1 of 3, not 'already answered'", async () => {
    const { answer, f } = rig();
    let enters = 0;
    f.reply = (a) => (a[0] === "keys" && a.includes("enter") && ++enters === 2 ? refusedKeys("not_found") : undefined);
    expect(await answer(ANS)).toMatchObject({ code: "prompt_partial", message: "Stopped after 1 of 3 answers. Nothing was submitted." });
  });

  it("a phase A timeout after question 1: prompt_partial, not 'desk is typing, try again' alone", async () => {
    const { answer, f } = rig();
    f.reply = (a) => (a[0] === "keys" && a.includes("space") ? { code: null, stdout: "", stderr: "", error: "timeout" } : undefined);
    expect((await answer(ANS)).code).toBe("prompt_partial");
  });

  it("question 3's Enter that doesn't move on: prompt_partial 2 of 3", async () => {
    const { answer, f } = rig();
    f.reply = (a) => (a[0] === "keys" && a.includes("enter") && f.tab === 2 ? { code: 0, stdout: "{}", stderr: "" } : undefined);
    expect(await answer(ANS)).toMatchObject({ code: "prompt_partial", message: "Stopped after 2 of 3 answers. Nothing was submitted." });
  });

  it("an unknown effect partway stays one, and Activity says how far it got and that it was held", async () => {
    let t = 0;
    const { f, answer } = rig(ASKQ, { now: () => t, heldMs: 1000 });
    let enters = 0;
    f.reply = (a) => {
      if (a[0] === "keys" && a.includes("enter") && ++enters === 2) t += 2000;
      return undefined;
    };
    const r = await answer(ANS);
    expect(r).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(r.audit_label).toBe("a question\nstopped after 1 of 3, held 2 s while the desk was typing: option 2 of 3; options 1, 3 of 3; option 1 of 2");
  });

  it("an Other send that doesn't move on, with no key pressed before it: prompt_moved (the text went), not 'nothing pressed'", async () => {
    const { answer, f } = rig(ASKQ, { prep: (x) => ["down", "down", "down"].forEach((k) => x.press(k)) });
    f.reply = (a) => (a[0] === "send" ? { code: 0, stdout: "{}", stderr: "" } : undefined);
    const r = await answer({ answers: [{ other: "Project Alpha answer 1" }, { picks: [0] }, { option: 0 }] });
    expect(r.code).toBe("prompt_moved");
    expect(f.calls.some((a) => a.includes("--force"))).toBe(true);
  });

  it("hc refuses the final Enter before pressing it: prompt_partial 3 of 3 (nothing submitted)", async () => {
    const { answer, f } = rig();
    f.reply = (a) => (a[0] === "keys" && a.includes("enter") && f.tab === 3 ? refusedKeys("not_found") : undefined);
    expect(await answer(ANS)).toMatchObject({ code: "prompt_partial", message: "Stopped after 3 of 3 answers. Nothing was submitted." });
  });

  it("a stop before any question was answered: the CV7 codes (nothing pressed / nothing answered)", async () => {
    const first = rig();
    first.f.reply = (a) => (a[0] === "keys" ? refusedKeys("usage") : undefined);
    expect((await first.answer(ANS)).code).toBe("prompt_changed");
    const second = rig();
    let n = 0;
    second.f.reply = (a) => (a[0] === "keys" && ++n === 2 ? refusedKeys("usage") : undefined);
    expect((await second.answer(ANS)).code).toBe("prompt_moved");
  });

  it("the one-question multi-select (CV7): a refused tick after an earlier one is prompt_moved, not 'nothing was pressed'", async () => {
    const f = new FakeTerm(screen("ask-multi"));
    const s = source(f, [ASKM]);
    let n = 0;
    f.keysReply = () => (++n === 2 ? refusedKeys("usage") : undefined);
    const actor = promptAnswerActor({ run: f.runner, source: s.src, binaries: { hc: "hc" } as never, sleep: async () => {}, postCheckMs: 30 });
    const r = await actor(CLIENT() as never, "prompt.answer", { terminal: T, prompt_id: s.card.promptId, rev: "rev-1", choice: { picks: [0, 2] } });
    expect(r?.code).toBe("prompt_moved");
  });
});

describe("the Other confirmation names its question", () => {
  const card = matchPrompt([ASKQ], screen("askq-q1"));
  const exp = { promptId: card.promptId, toolUseId: ASKQ.id, pending: [ASKQ] };

  it("confirms only that question's own Other row, on its own tab", () => {
    expect(confirmOtherField(T, screen("askq-q3-on-other"), { ...exp, question: 2 }, 1000)).not.toBeNull();
    expect(confirmOtherField(T, screen("askq-q3-on-other"), { ...exp, question: 0 }, 1000)).toBeNull();
    expect(confirmOtherField(T, screen("askq-q3-on-other"), exp, 1000)).toBeNull(); // no question: a one-question card only
    expect(confirmOtherField(T, screen("askq-q3-after-next"), { ...exp, question: 2 }, 1000)).toBeNull(); // cursor on row 1
    expect(confirmOtherField(T, screen("askq-q2-on-next"), { ...exp, question: 1 }, 1000)).toBeNull(); // a multi-select
    const f = new FakeSeveral(ASKQ);
    ["right", "down", "down", "down"].forEach((k) => f.press(k));
    expect(confirmOtherField(T, f.screen, { ...exp, question: 1 }, 1000)).toBeNull(); // a multi-select's Other row
  });

  it("never confirms another question's field because its row number matches (the tab must be that question's)", () => {
    const qs = (ASKQ.input as { questions: Record<string, unknown>[] }).questions;
    // Question 3 with three options too: its Other row is row 4, as question 1's.
    const call: PendingTool = { ...ASKQ, input: { questions: [qs[0], qs[1], { ...qs[2], options: [...(qs[2]!.options as unknown[]), { label: "Production", description: "The Project Alpha production box" }] }] } };
    const f = new FakeSeveral(call);
    ["down", "down", "down"].forEach((k) => f.press(k));
    const m = matchPrompt([call], f.screen);
    expect(m.several?.tab).toBe(0);
    const e = { promptId: m.promptId, toolUseId: call.id, pending: [call] };
    expect(confirmOtherField(T, f.screen, { ...e, question: 0 }, 1000)).not.toBeNull();
    expect(confirmOtherField(T, f.screen, { ...e, question: 2 }, 1000)).toBeNull();
  });

  it("a confirmation for one question can't send for another", () => {
    const c = confirmOtherField(T, screen("askq-q3-on-other"), { ...exp, question: 2 }, 1000)!;
    expect(() => otherSendArgs(c, T, card.promptId, "x", 1500, 0)).toThrow();
    const d = confirmOtherField(T, screen("askq-q3-on-other"), { ...exp, question: 2 }, 1000)!;
    expect(() => otherSendArgs(d, T, card.promptId, "x", 1500)).toThrow();
    const e = confirmOtherField(T, screen("askq-q3-on-other"), { ...exp, question: 2 }, 1000)!;
    expect(otherSendArgs(e, T, card.promptId, "x", 1500, 2)).toEqual(["send", "--json", "--force", "--", T, "x"]);
  });
});
