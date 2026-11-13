import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { bridgeApi } from "@herdr-remote/protocol";
import { HostNameProvider } from "../src/bridge/host-name";
import type { OlderResult } from "../src/bridge/chatview";
import type { ActFn } from "../src/inbox/act";
import { ROW_ARM_MS } from "../src/inbox/arm";
import type { ChatAgent } from "../src/screens/Chat";
import { ChatView } from "../src/screens/ChatView";
import { boardQuestion } from "../src/timeline/TimelineBoard";
import { PROMPT_FIXTURES } from "../src/chatview/prompt/fixtures";

// CV5b: a timeline row keeps its component when placement moves it, so the inbox's one-act-in-flight guard holds.
// Fake data only. The question is asked at 21:02 (boardQuestion.at).
type Item = bridgeApi.ChatItem;
const agent: ChatAgent = { name: "Agent 1", folder: "~/code/alpha", harness: "claude", status: "working" };
const NOW = Date.parse("2026-01-02T21:10:00Z");
const at = (m: number, sec = 0) => new Date(Date.UTC(2026, 0, 2, 21, m, sec)).toISOString();
const ai = (id: string, m: number): Item => ({ id, role: "agent", at: at(m), text: `Reply ${id}` });
const ask = (id: string, m: number): Item => ({ id, role: "ask", at: at(m), ask: { via: "inbox", question: null, header: null, multi: false, options: [] }, tool_use_id: "toolu_01FakeAskOperator123" });
const topic = (items: Item[], older = false): bridgeApi.ChatviewTopic => ({ terminal: "t1", harness: "claude", state: "ok", items, older, rev: "r1", status: { state: "working", since: null } });
/** The question, unanchored unless `anchored`. */
const question = (anchored = false): bridgeApi.TimelineItem => ({ ...boardQuestion, anchor: anchored ? boardQuestion.anchor : null });

let clock = 0;
beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

/** An `act` that never answers: the first one stays in flight. */
function pending() {
  const sent: { kind: string; args: Record<string, unknown> }[] = [];
  const fn: ActFn = (kind, args) => {
    sent.push({ kind, args });
    return new Promise(() => undefined);
  };
  return { sent, fn };
}

function mount(t: bridgeApi.ChatviewTopic, timeline: bridgeApi.TimelineItem[], act: ActFn, loadOlder?: (before: string, rev: string) => Promise<OlderResult>) {
  const el = (tp: bridgeApi.ChatviewTopic, tl: bridgeApi.TimelineItem[]) => (
    <HostNameProvider name="desk-1">
      <ChatView agent={agent} topic={tp} now={() => NOW} timeline={{ items: tl, act }} loadOlder={loadOlder} />
    </HostNameProvider>
  );
  const r = render(el(t, timeline));
  return { rerender: (tp: bridgeApi.ChatviewTopic, tl = timeline) => r.rerender(el(tp, tl)) };
}

const pass = async (ms: number) => {
  clock += ms;
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const optionA = () => within(screen.getByRole("region", { name: "Question Q123" })).getByRole("button", { name: /Option A/ });
const tapA = async () => {
  await act(async () => {
    fireEvent.click(optionA());
    await Promise.resolve();
  });
};

describe("a timeline row that moves keeps its act in flight", () => {
  it("a newer message arrives: the question moves from the end to before it", async () => {
    const { sent, fn } = pending();
    const v = mount(topic([ai("m1", 1)]), [question()], fn);
    await pass(ROW_ARM_MS + 1);
    await tapA();
    expect(sent).toHaveLength(1);
    v.rerender(topic([ai("m1", 1), ai("m2", 5)]));
    await pass(ROW_ARM_MS + 1);
    expect(optionA()).toBeDisabled();
    await tapA();
    expect(sent).toHaveLength(1);
  });

  it("its anchored ask loads: the question moves into the ask's place", async () => {
    const { sent, fn } = pending();
    const v = mount(topic([ai("m1", 1), ai("m3", 6)]), [question(true)], fn);
    await pass(ROW_ARM_MS + 1);
    await tapA();
    v.rerender(topic([ai("m1", 1), ask("m2", 2), ai("m3", 6)]));
    expect(screen.queryByText("Asked you a question")).toBeNull();
    await pass(ROW_ARM_MS + 1);
    await tapA();
    expect(sent).toHaveLength(1);
  });

  it("an older page goes in above: the question moves before the older item", async () => {
    const { sent, fn } = pending();
    let give: (r: OlderResult) => void = () => undefined;
    const loadOlder = vi.fn(() => new Promise<OlderResult>((res) => (give = res)));
    mount(topic([ai("m5", 9)], true), [question()], fn, loadOlder);
    await pass(ROW_ARM_MS + 1);
    await tapA();
    expect(loadOlder).toHaveBeenCalled();
    // The page: an item later than the question, so the question now goes before it, not before m5.
    await act(async () => {
      give({ ok: true, page: { items: [ai("m4", 4)], older: false, rev: "r1" } });
      await Promise.resolve();
    });
    expect(screen.getByText("Reply m4")).toBeInTheDocument();
    await pass(ROW_ARM_MS + 1);
    await tapA();
    expect(sent).toHaveLength(1);
  });

  it("an empty chat gets its first message", async () => {
    const { sent, fn } = pending();
    const v = mount(topic([]), [question()], fn);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    await pass(ROW_ARM_MS + 1);
    await tapA();
    v.rerender(topic([ai("m1", 5)]));
    expect(screen.queryByText("No messages yet")).toBeNull();
    await pass(ROW_ARM_MS + 1);
    await tapA();
    expect(sent).toHaveLength(1);
  });
});

describe("an inline question and an open prompt card (CV7)", () => {
  const prompt = (state: "open" | "answered" = "open"): Item => ({ ...PROMPT_FIXTURES.perm!.item, id: "p1", at: at(1, 30), state });
  /** The list's rows in order: a timeline row's data-key, a prompt card's "prompt", else the item's text. */
  const order = () =>
    [...document.querySelectorAll(".cv-list > .cv-item")].map((el) => el.querySelector("[data-key]")?.getAttribute("data-key") ?? (el.querySelector(".pc-card") ? "prompt" : (el.textContent ?? "")));

  it("the question newer than every item goes above an open card that ends the list; the card stays last", () => {
    mount(topic([ai("m1", 1), prompt()]), [question()], pending().fn);
    expect(order()).toEqual(["Agent 1Reply m1", "group:123", "prompt"]);
  });

  it("a card that is no longer open does not hold the end", () => {
    mount(topic([ai("m1", 1), prompt("answered")]), [question()], pending().fn);
    expect(order().at(-1)).toBe("group:123");
  });

  it("the card arriving moves the question above it without dropping its act in flight", async () => {
    const { sent, fn } = pending();
    const v = mount(topic([ai("m1", 1)]), [question()], fn);
    await pass(ROW_ARM_MS + 1);
    await tapA();
    v.rerender(topic([ai("m1", 1), prompt()]));
    expect(order().slice(-2)).toEqual(["group:123", "prompt"]);
    await pass(ROW_ARM_MS + 1);
    await tapA();
    expect(sent).toHaveLength(1);
  });
});
