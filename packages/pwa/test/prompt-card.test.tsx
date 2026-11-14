import { act as rtlAct, render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { hasOpenPrompt, PromptCard, PromptTail, resetPromptTails, type PromptAct, type PromptItem } from "../src/chatview/prompt/PromptCard";
import { PROMPT_FIXTURES } from "../src/chatview/prompt/fixtures";

afterEach(() => {
  cleanup();
  resetPromptTails();
});

const perm = PROMPT_FIXTURES.perm!.item;
const ask1 = PROMPT_FIXTURES.ask1!.item;
const plan = PROMPT_FIXTURES.plan!.item;
const several = PROMPT_FIXTURES.several!.item;

function mount(item: PromptItem, reply: Awaited<ReturnType<PromptAct>> = { ok: true }) {
  const act = vi.fn<PromptAct>(() => Promise.resolve(reply));
  const r = render(<PromptCard item={item} terminal="t1" agent="Agent 1" desk="desk-1" act={act} />);
  return { act, ...r };
}
const click = async (el: HTMLElement) => {
  await rtlAct(async () => {
    fireEvent.click(el);
  });
};

describe("the fixtures are valid chat items", () => {
  it.each(Object.keys(PROMPT_FIXTURES))("%s", (k) => {
    expect(bridgeApi.ChatItem.safeParse(PROMPT_FIXTURES[k]!.item).success).toBe(true);
  });
});

describe("PromptCard", () => {
  it("permission: the board's words, the screen's labels, one press sends the option once", async () => {
    const { act } = mount(perm);
    expect(screen.getByText("PERMISSION")).toBeTruthy();
    expect(screen.getByText("Allow this command?")).toBeTruthy();
    expect(screen.getByText("Shell command")).toBeTruthy();
    expect(screen.getByText("cargo test -p parser")).toBeTruthy();
    expect(screen.getByText("Then tell Agent 1 what to do instead")).toBeTruthy();
    await click(screen.getByRole("button", { name: /^Yes, and don’t ask again/ }));
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith("prompt.answer", { terminal: "t1", prompt_id: perm.prompt_id, rev: perm.rev, choice: { option: 1 } });
    // Taken: nothing more can be pressed.
    await click(screen.getByRole("button", { name: /^No/ }));
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("an option label with a ' · ' part shows it as the sub line", () => {
    mount({ ...perm, options: [{ label: "Yes" }, { label: "Yes, and switch to auto mode · auto mode handles these prompts for you" }, { label: "No" }] });
    expect(screen.getByText("Yes, and switch to auto mode")).toBeTruthy();
    expect(screen.getByText("auto mode handles these prompts for you")).toBeTruthy();
  });

  it("question: answers only on Answer; a pick or the Other text", async () => {
    const { act } = mount(ask1);
    const answer = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    await click(screen.getByRole("button", { name: /^Option B/ }));
    expect(act).not.toHaveBeenCalled();
    expect(answer.disabled).toBe(false);
    // Typing Other drops the pick.
    fireEvent.change(screen.getByPlaceholderText("Other: type your own answer…"), { target: { value: "Project Alpha\tanswer 1" } });
    await click(answer);
    expect(act).toHaveBeenCalledWith("prompt.answer", { terminal: "t1", prompt_id: ask1.prompt_id, rev: ask1.rev, choice: { other: "Project Alpha answer 1" } });
  });

  it("N1: a double tap sends one act", async () => {
    let release!: (r: { ok: boolean }) => void;
    const act = vi.fn<PromptAct>(() => new Promise((r) => (release = r)));
    render(<PromptCard item={perm} terminal="t1" agent="Agent 1" desk="desk-1" act={act} />);
    const yes = screen.getByRole("button", { name: /^Yes$/ });
    // Two taps in the same render: the second must not reach the bridge.
    rtlAct(() => {
      fireEvent.click(yes);
      fireEvent.click(yes);
    });
    expect(act).toHaveBeenCalledTimes(1);
    await rtlAct(async () => release({ ok: true }));
  });

  it("Other text that starts with !, / or # can't be sent", () => {
    mount(ask1);
    const field = screen.getByPlaceholderText("Other: type your own answer…");
    const answer = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    for (const v of ["/clear", "!ls", "# note", " /x"]) {
      fireEvent.change(field, { target: { value: v } });
      expect(answer.disabled, v).toBe(true);
    }
    fireEvent.change(field, { target: { value: "a / b" } });
    expect(answer.disabled).toBe(false);
  });

  it("question: a single pick sends its option", async () => {
    const { act } = mount(ask1);
    await click(screen.getByRole("button", { name: /^Option C/ }));
    await click(screen.getByRole("button", { name: "Answer" }));
    expect(act.mock.calls[0]![1]).toMatchObject({ choice: { option: 2 } });
  });

  it("multi-select: picks, no Skip on the only question", async () => {
    const item: PromptItem = { ...ask1, questions: [{ ...ask1.questions![0]!, multi: true, other: false }] };
    const { act } = mount(item);
    expect(screen.queryByPlaceholderText("Other: type your own answer…")).toBeNull();
    expect(screen.queryByText("Skip")).toBeNull();
    await click(screen.getByRole("button", { name: /^Option C/ }));
    await click(screen.getByRole("button", { name: /^Option A/ }));
    await click(screen.getByRole("button", { name: "Answer" }));
    expect(act.mock.calls[0]![1]).toMatchObject({ choice: { picks: [0, 2] } });
  });

  it("several questions (CV9): one block each, Submit once every one is answered, all answers in one act", async () => {
    const { act, container } = mount(several);
    expect(container.querySelectorAll(".pc-q").length).toBe(3);
    expect(screen.getByText("1 · Approach")).toBeTruthy();
    expect(screen.getByText("3 of 3")).toBeTruthy();
    // Other only on the single-select questions.
    expect(screen.getAllByPlaceholderText("Other: type your own answer…").length).toBe(2);
    expect(screen.queryByText("Skip")).toBeNull();
    const submit = () => screen.getByRole("button", { name: /^(Submit|\d of 3 answered)$/ }) as HTMLButtonElement;
    expect(submit().textContent).toBe("0 of 3 answered");
    expect(submit().disabled).toBe(true);
    const groups = screen.getAllByRole("radiogroup").concat(screen.getAllByRole("group"));
    const [q1, q3, q2] = groups as [HTMLElement, HTMLElement, HTMLElement];
    await click(within(q1).getByRole("button", { name: /^Option B/ }));
    await click(within(q2).getByRole("button", { name: /^Unit tests/ }));
    await click(within(q2).getByRole("button", { name: /^Lint/ }));
    expect(submit().textContent).toBe("2 of 3 answered");
    // A command-like Other text doesn't count; a plain one does.
    const other3 = within(q3).getByPlaceholderText("Other: type your own answer…");
    fireEvent.change(other3, { target: { value: "/deploy" } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(other3, { target: { value: "  Project Alpha answer 3 " } });
    expect(submit().textContent).toBe("Submit");
    expect(act).not.toHaveBeenCalled();
    await click(submit());
    expect(act).toHaveBeenCalledTimes(1);
    expect(act.mock.calls[0]![1]).toEqual({ terminal: "t1", prompt_id: several.prompt_id, rev: several.rev, choice: { answers: [{ option: 1 }, { picks: [0, 2] }, { other: "Project Alpha answer 3" }] } });
    expect(bridgeApi.PromptAnswerArgs.safeParse(act.mock.calls[0]![1]).success).toBe(true);
    await click(submit());
    expect(act).toHaveBeenCalledTimes(1);
  });

  it("several questions: picking an option clears that question's Other text, and typing clears its pick", async () => {
    const { act } = mount(several);
    const [q1] = screen.getAllByRole("radiogroup") as [HTMLElement];
    const other1 = within(q1).getByPlaceholderText("Other: type your own answer…") as HTMLInputElement;
    fireEvent.change(other1, { target: { value: "Project Alpha" } });
    await click(within(q1).getByRole("button", { name: /^Option A/ }));
    expect(other1.value).toBe("");
    fireEvent.change(other1, { target: { value: "Project Alpha" } });
    expect(within(q1).getByRole("button", { name: /^Option A/ }).getAttribute("aria-pressed")).toBe("false");
    expect(act).not.toHaveBeenCalled();
  });

  it("several questions: a refusal dims the card and shows why", async () => {
    mount(several, { ok: false, code: "prompt_moved" });
    const [q1, q3] = screen.getAllByRole("radiogroup") as [HTMLElement, HTMLElement];
    const [q2] = screen.getAllByRole("group") as [HTMLElement];
    await click(within(q1).getByRole("button", { name: /^Option A/ }));
    await click(within(q2).getByRole("button", { name: /^Lint/ }));
    await click(within(q3).getByRole("button", { name: /^Staging/ }));
    await click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("The prompt changed. Look again.")).toBeTruthy();
    expect(screen.getByText("Nothing was answered.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("several questions: a walk stopped partway says how far, where the picks are, and dims the card", async () => {
    mount(several, { ok: false, code: "prompt_partial", message: "Stopped after 1 of 3 answers. Nothing was submitted." });
    const [q1, q3] = screen.getAllByRole("radiogroup") as [HTMLElement, HTMLElement];
    const [q2] = screen.getAllByRole("group") as [HTMLElement];
    await click(within(q1).getByRole("button", { name: /^Option A/ }));
    await click(within(q2).getByRole("button", { name: /^Lint/ }));
    await click(within(q3).getByRole("button", { name: /^Staging/ }));
    await click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Stopped after 1 of 3 answers. Nothing was submitted.")).toBeTruthy();
    expect(screen.getByText("Those answers stay picked in Agent 1's terminal. Finish it there.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("plan: the plan as text, collapsed until asked", async () => {
    const { container } = mount(plan);
    expect(screen.getByText("PLAN")).toBeTruthy();
    expect(screen.getByText("Ready to start?")).toBeTruthy();
    expect(screen.getByText("Plan: Parser rewrite")).toBeTruthy();
    expect(container.querySelector("code")!.textContent).toBe("parse.rs");
    expect(screen.getByText("Tell Agent 1 what to change")).toBeTruthy();
    await click(screen.getByRole("button", { name: "Show the whole plan ›" }));
    expect(screen.queryByRole("button", { name: "Show the whole plan ›" })).toBeNull();
  });

  it("plan text is never HTML", () => {
    const { container } = mount({ ...plan, plan_md: '<img src=x onerror="alert(1)"> **x** [a](javascript:alert(1))' });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("unparsed: the screen's lines read-only, no buttons, Answer it on desk-1.", () => {
    const item: PromptItem = { ...perm, kind: "unparsed", title: "", options: [], screen_lines: [" Some dialog", " ❯ 1. Something"] };
    delete (item as { summary?: string }).summary;
    mount(item);
    expect(screen.getByText("Agent 1 asks", { selector: ".pc-title" })).toBeTruthy();
    expect(screen.getByText("Answer it on desk-1.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("generic: Agent 1 asks, the screen's title and labels", async () => {
    const item: PromptItem = { ...perm, kind: "other", title: "Do you want to make this edit to main.rs?", options: [{ label: "Yes" }, { label: "No" }] };
    const { act } = mount(item);
    expect(screen.getByText("Agent 1 asks", { selector: ".pc-title" })).toBeTruthy();
    expect(screen.getByText("Do you want to make this edit to main.rs?")).toBeTruthy();
    await click(screen.getByRole("button", { name: /^No/ }));
    expect(act.mock.calls[0]![1]).toMatchObject({ choice: { option: 1 } });
  });

  it.each([
    [{ ok: false, code: "prompt_changed" }, ["The prompt changed. Look again.", "Nothing was pressed."], true],
    [{ ok: false, code: "prompt_moved" }, ["The prompt changed. Look again.", "Nothing was answered."], true],
    [{ ok: false, code: "prompt_gone" }, ["Already answered on desk-1."], true],
    [{ ok: false, code: "unknown_effect", unknown_effect: true }, ["Agent 1 may have got your answer. Look before you answer again."], true],
    [{ ok: false, code: "timeout", unknown_effect: true }, ["Agent 1 may have got your answer. Look before you answer again."], true],
    [{ ok: false, code: "busy" }, ["desk-1 is typing. Try again in a moment."], false],
    [{ ok: false, code: "forbidden" }, ["Answering prompts is off for this phone.", "Turn it on in Remote on desk-1."], false],
    [{ ok: false, code: "rate_limited" }, ["Too many answers. Wait a moment and try again."], false],
    [{ ok: false, code: "audit_unavailable" }, ["Not sent: the activity log can't be written. Nothing changed."], false],
  ] as const)("refusal %o", async (reply, lines, dims) => {
    const { act, container } = mount(perm, reply);
    await click(screen.getByRole("button", { name: /^Yes$/ }));
    const alert = screen.getByRole("alert");
    for (const l of lines) expect(alert.textContent).toContain(l);
    expect(container.querySelector(".pc-card")!.hasAttribute("data-dim")).toBe(dims);
    await click(screen.getByRole("button", { name: /^No/ }));
    // Never a second press after the prompt moved on or an unknown effect; a retry is the person's after busy etc.
    expect(act).toHaveBeenCalledTimes(dims ? 1 : 2);
  });

  it("a new prompt resets the card", async () => {
    const { rerender, act } = mount(perm, { ok: false, code: "prompt_changed" });
    await click(screen.getByRole("button", { name: /^Yes$/ }));
    expect(screen.queryByRole("alert")).not.toBeNull();
    rerender(<PromptCard item={{ ...perm, prompt_id: "9".repeat(64) }} terminal="t1" agent="Agent 1" desk="desk-1" act={act} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("hasOpenPrompt and PromptTail", () => {
  it("an open card locks the composer", () => {
    expect(hasOpenPrompt([])).toBe(false);
    expect(hasOpenPrompt([perm])).toBe(true);
    expect(hasOpenPrompt([{ ...perm, state: "gone" }])).toBe(false);
  });

  it("keeps the refused card, dimmed with its refusal, once the topic dropped it; a new card clears it", async () => {
    mount(perm, { ok: false, code: "prompt_changed" });
    await click(screen.getByRole("button", { name: /^Yes$/ }));
    cleanup();
    const tail = render(<PromptTail terminal="t1" items={[]} agent="Agent 1" desk="desk-1" />);
    expect(tail.container.querySelector(".pc-card[data-dim]")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("The prompt changed. Look again.");
    tail.rerender(<PromptTail terminal="t1" items={[{ ...perm, prompt_id: "8".repeat(64) }]} agent="Agent 1" desk="desk-1" />);
    expect(tail.container.textContent).toBe("");
    tail.rerender(<PromptTail terminal="t1" items={[]} agent="Agent 1" desk="desk-1" />);
    expect(tail.container.textContent).toBe("");
    // Another terminal never shows it.
    render(<PromptTail terminal="t2" items={[]} agent="Agent 1" desk="desk-1" />);
  });
});
