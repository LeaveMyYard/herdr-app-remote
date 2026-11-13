import { act as rtlAct, render, screen, fireEvent, cleanup } from "@testing-library/react";
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

  it("several questions step with Next and Skip, and never send (not answerable yet)", async () => {
    const { act } = mount(PROMPT_FIXTURES.askm!.item);
    expect(screen.getByText("1 of 2")).toBeTruthy();
    await click(screen.getByRole("button", { name: /^Option A/ }));
    expect(screen.getByRole("button", { name: "Next: 1 picked" })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText("2 of 2")).toBeTruthy();
    await click(screen.getByRole("button", { name: /^Option A/ }));
    expect((screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(act).not.toHaveBeenCalled();
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
