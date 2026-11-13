import { act as flush, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActFn, ActResult } from "../src/inbox/act";
import { GRACE_MS, ROW_ARM_MS, VIEW_ARM_MS } from "../src/inbox/arm";
import { placeTimeline } from "../src/timeline/model";
import { TimelineRow, TimelineStrip } from "../src/timeline/Timeline";
import { boardAlert, boardFailed, boardQuestion, boardStrip } from "../src/timeline/TimelineBoard";

let clock = 0;
beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  window.location.hash = "";
});
afterEach(() => vi.restoreAllMocks());
const wait = (ms: number) => {
  clock += ms;
};

function fakeAct(results: ActResult[] = []) {
  const calls: { kind: string; args: Record<string, unknown> }[] = [];
  const fn: ActFn = (kind, args) => {
    calls.push({ kind, args });
    return Promise.resolve(results.shift() ?? { ok: true });
  };
  return { calls, fn };
}
const tap = async (el: HTMLElement) => {
  await flush(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
};
const NOW = Date.parse("2026-01-02T21:04:00Z") / 1000;

type Item = bridgeApi.TimelineItem;
type Chat = bridgeApi.ChatItem;
const at = (m: number) => new Date(Date.UTC(2026, 0, 2, 21, m)).toISOString();
const you = (id: string, m: number): Chat => ({ id, role: "you", at: at(m), text: "Hi" });
const inboxAsk = (id: string, m: number, tid?: string): Chat => ({ id, role: "ask", at: at(m), ask: { via: "inbox", question: null, header: null, multi: false, options: [] }, ...(tid ? { tool_use_id: tid } : {}) });
const tools = (id: string, m: number): Chat => ({ id, role: "tools", at: at(m), tools: { kind: "other", count: 1, running: 0, failed: 0, names: ["x"] } });
const tl = (key: string, m: number | null, anchor?: string): Item => ({ ...boardQuestion, key, at: m === null ? null : at(m), anchor: anchor ? { tool_use_id: anchor } : null });

it("the board's fake items are valid topic items", () => {
  for (const i of [boardQuestion, boardAlert, boardFailed]) expect(bridgeApi.TimelineItem.safeParse(i).success).toBe(true);
  expect(bridgeApi.StripItem.safeParse(boardStrip).success).toBe(true);
});

describe("placeTimeline", () => {
  it("replaces only the inbox ask item with the anchor's tool_use_id", () => {
    const items = [you("u1", 1), inboxAsk("a1", 2, "toolu_1"), tools("t1", 3)];
    const p = placeTimeline(items, [tl("g1", 2, "toolu_1")]);
    expect([...p.replace]).toEqual([["a1", expect.objectContaining({ key: "g1" })]]);
    expect(p.tail).toEqual([]);
  });

  it("never replaces a tool row or an ask of another id: it goes by time instead", () => {
    const items = [you("u1", 1), inboxAsk("a1", 2, "toolu_2"), tools("t1", 5)];
    const p = placeTimeline(items, [tl("g1", 3, "toolu_1")]);
    expect(p.replace.size).toBe(0);
    expect(p.before.get("t1")?.map((i) => i.key)).toEqual(["g1"]);
  });

  it("puts an item before the first later message, and one with no time or newer than all at the end", () => {
    const items = [you("u1", 1), tools("t1", 5)];
    const p = placeTimeline(items, [tl("old", 0), tl("mid", 3), tl("new", 9), tl("none", null)]);
    expect(p.before.get("u1")?.map((i) => i.key)).toEqual(["old"]);
    expect(p.before.get("t1")?.map((i) => i.key)).toEqual(["mid"]);
    expect(p.tail.map((i) => i.key)).toEqual(["new", "none"]);
  });

  it("anchors one item per ask: a second item with the same anchor goes by time; an id on two asks anchors neither", () => {
    const one = placeTimeline([inboxAsk("a1", 2, "toolu_1")], [tl("g1", 2, "toolu_1"), tl("g2", 2, "toolu_1")]);
    expect(one.replace.get("a1")?.key).toBe("g1");
    expect(one.tail.map((i) => i.key)).toEqual(["g2"]);
    const two = placeTimeline([inboxAsk("a1", 2, "toolu_1"), inboxAsk("a2", 3, "toolu_1")], [tl("g1", 1, "toolu_1")]);
    expect(two.replace.size).toBe(0);
    expect(two.before.get("a1")?.map((i) => i.key)).toEqual(["g1"]);
  });

  it("never replaces a Claude ask, even one carrying the anchor's id", () => {
    const claudeAsk: Chat = { id: "a1", role: "ask", at: at(2), ask: { via: "claude", question: "Pick one", header: null, multi: false, options: [] }, tool_use_id: "toolu_1" };
    const p = placeTimeline([claudeAsk, tools("t1", 5)], [tl("g1", 3, "toolu_1")]);
    expect(p.replace.size).toBe(0);
    expect(p.before.get("t1")?.map((i) => i.key)).toEqual(["g1"]);
  });

  it("drops nothing on an empty chat", () => {
    expect(placeTimeline([], [tl("g1", 1), tl("g2", null, "toolu_1")]).tail.map((i) => i.key)).toEqual(["g1", "g2"]);
  });
});

describe("inline question", () => {
  it("answers a lone single-select question with one tap, bound to the row's key and rev, once armed", async () => {
    const a = fakeAct();
    render(<TimelineRow item={boardQuestion} act={a.fn} now={NOW} />);
    const optB = screen.getByRole("button", { name: /Option B/ });
    await tap(optB);
    expect(a.calls).toEqual([]);
    wait(ROW_ARM_MS);
    await tap(optB);
    expect(a.calls).toEqual([{ kind: "inbox.answer", args: { key: "group:123", rev: "rev-fake-123", question: 123, detail: { choices: [1], notes: {}, text: null } } }]);
    expect(screen.getByText("Q123 · 2m")).toBeInTheDocument();
  });

  it("says a refusal in the inbox's words and re-arms before the next tap", async () => {
    const a = fakeAct([{ ok: false, code: "stale", message: "This changed, look again." }]);
    render(<TimelineRow item={boardQuestion} act={a.fn} now={NOW} />);
    wait(ROW_ARM_MS);
    await tap(screen.getByRole("button", { name: /Option A/ }));
    expect(screen.getByRole("status")).toHaveTextContent("This changed, look again.");
    await tap(screen.getByRole("button", { name: /Option A/ }));
    expect(a.calls).toHaveLength(1);
    wait(GRACE_MS);
    await tap(screen.getByRole("button", { name: /Option A/ }));
    expect(a.calls).toHaveLength(2);
  });

  it("re-arms when the row's content changes under the finger", async () => {
    const a = fakeAct();
    const { rerender } = render(<TimelineRow item={boardQuestion} act={a.fn} now={NOW} />);
    wait(ROW_ARM_MS);
    const data = { ...(boardQuestion.data as object), rev: "rev-fake-124" };
    rerender(<TimelineRow item={{ ...boardQuestion, data }} act={a.fn} now={NOW} />);
    await tap(screen.getByRole("button", { name: /Option A/ }));
    expect(a.calls).toEqual([]);
    wait(GRACE_MS);
    await tap(screen.getByRole("button", { name: /Option A/ }));
    expect(a.calls[0]!.args.rev).toBe("rev-fake-124");
  });

  it("dismisses only after the confirm bar's own armed tap", async () => {
    const a = fakeAct();
    render(<TimelineRow item={boardQuestion} act={a.fn} now={NOW} />);
    wait(ROW_ARM_MS);
    await tap(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText("Dismiss Q123 without answering?")).toBeInTheDocument();
    await tap(screen.getByRole("button", { name: "Dismiss" }));
    expect(a.calls).toEqual([]);
    wait(VIEW_ARM_MS);
    await tap(screen.getByRole("button", { name: "Dismiss" }));
    expect(a.calls).toEqual([{ kind: "inbox.dismiss", args: { key: "group:123", rev: "rev-fake-123" } }]);
  });

  it("offers no one-tap answer for a multi-select question: More options… opens the Question screen", () => {
    const d = boardQuestion.data as { questions: Record<string, unknown>[] };
    const multi = { ...boardQuestion, data: { ...d, questions: [{ ...d.questions[0], multi_select: true }] } };
    render(<TimelineRow item={multi} now={NOW} />);
    expect(screen.queryByRole("button", { name: /Option A/ })).toBeNull();
    expect(screen.getByRole("link", { name: "More options…" })).toHaveAttribute("href", "#/inbox/q/group%3A123/123");
  });

  it("offers no one-tap answer for several single-select questions", () => {
    const d = boardQuestion.data as { questions: Record<string, unknown>[] };
    const two = { ...boardQuestion, data: { ...d, questions: [d.questions[0], { ...d.questions[0], id: 124 }] } };
    render(<TimelineRow item={two} now={NOW} />);
    expect(screen.queryByRole("button", { name: /Option A/ })).toBeNull();
    expect(screen.getByRole("link", { name: "More options…" })).toBeInTheDocument();
  });

  it("shows only the acts the row allows: no options without answer, no Dismiss without dismiss", () => {
    const d = boardQuestion.data as Record<string, unknown>;
    const noAnswer = render(<TimelineRow item={{ ...boardQuestion, data: { ...d, actions: ["dismiss"] } }} now={NOW} />);
    expect(screen.queryByRole("button", { name: /Option A/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    noAnswer.unmount();
    const noDismiss = render(<TimelineRow item={{ ...boardQuestion, data: { ...d, actions: ["answer"] } }} now={NOW} />);
    expect(screen.getByRole("button", { name: /Option A/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    noDismiss.unmount();
    render(<TimelineRow item={{ ...boardQuestion, data: { ...d, actions: [] } }} now={NOW} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "More options…" })).toBeInTheDocument();
  });

  it("sends one act at a time: a second tap before the first answer comes back sends nothing", async () => {
    const calls: string[] = [];
    let settle: (r: ActResult) => void = () => {};
    const fn: ActFn = (kind) => {
      calls.push(kind);
      return new Promise<ActResult>((res) => {
        settle = res;
      });
    };
    render(<TimelineRow item={boardQuestion} act={fn} now={NOW} />);
    wait(ROW_ARM_MS);
    const optA = screen.getByRole("button", { name: /Option A/ });
    // Both taps land before React re-renders the row as busy, so only the in-flight check is left to stop the second.
    await flush(async () => {
      fireEvent.click(optA);
      fireEvent.click(optA);
      await Promise.resolve();
    });
    expect(calls).toEqual(["inbox.answer"]);
    await flush(async () => {
      settle({ ok: true });
      await Promise.resolve();
    });
  });
});

describe("alert, failed and unknown rows", () => {
  it("drops a Seen or Retry tap that lands before the row is armed", async () => {
    const a = fakeAct();
    const alertRow = render(<TimelineRow item={boardAlert} act={a.fn} now={NOW} />);
    await tap(screen.getByRole("button", { name: "Seen" }));
    expect(a.calls).toEqual([]);
    alertRow.unmount();
    render(<TimelineRow item={boardFailed} act={a.fn} now={NOW} />);
    await tap(screen.getByRole("button", { name: "Retry delivery" }));
    expect(a.calls).toEqual([]);
  });

  it("marks an alert seen with inbox.ack", async () => {
    const a = fakeAct();
    render(<TimelineRow item={boardAlert} act={a.fn} now={NOW} />);
    expect(screen.getByText("Needs no answer.")).toBeInTheDocument();
    wait(ROW_ARM_MS);
    await tap(screen.getByRole("button", { name: "Seen" }));
    expect(a.calls).toEqual([{ kind: "inbox.ack", args: { key: "alert:456", rev: "rev-fake-456" } }]);
  });

  it("retries a failed delivery with the row's own retry label", async () => {
    const a = fakeAct();
    render(<TimelineRow item={boardFailed} act={a.fn} now={NOW} />);
    expect(screen.getByText("Answer to Q119 not delivered")).toBeInTheDocument();
    wait(ROW_ARM_MS);
    await tap(screen.getByRole("button", { name: "Retry delivery" }));
    expect(a.calls).toEqual([{ kind: "inbox.retry", args: { key: "failed:119", rev: "rev-fake-119" } }]);
  });

  it("draws a kind it doesn't know (or known data that fails its check) from the fallback fields", () => {
    const { container, unmount } = render(<TimelineRow item={{ ...boardAlert, kind: "someplugin.note", title: "Note Title 1", line: "A line", href: "#/inbox" }} now={NOW} />);
    expect(container.querySelector("a.tl-plain")).toHaveAttribute("href", "#/inbox");
    expect(container).toHaveTextContent("Note Title 1 · A line");
    unmount();
    const broken = render(<TimelineRow item={{ ...boardQuestion, data: { nope: true } }} now={NOW} />);
    expect(broken.container).toHaveTextContent("Question Title 123");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never links outside the phone", () => {
    const { container } = render(<TimelineRow item={{ ...boardAlert, kind: "x.y", href: "https://example.invalid/" }} now={NOW} />);
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("the strip", () => {
  it("shows the tiles per status and the label, linked to Swarm", () => {
    const { container } = render(<TimelineStrip strip={[boardStrip]} />);
    const link = container.querySelector("a.tl-strip-link")!;
    expect(link).toHaveAttribute("href", "#/swarm/space-1");
    expect(link).toHaveTextContent("6 subagents");
    expect(container.querySelectorAll(".tile")).toHaveLength(3);
  });

  it("long-press opens Peek of the subagent that needs you", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<TimelineStrip strip={[boardStrip]} />);
      const link = container.querySelector("a.tl-strip-link")!;
      fireEvent.pointerDown(link);
      vi.advanceTimersByTime(600);
      expect(window.location.hash).toBe(`#/swarm/peek/${encodeURIComponent('["root","herdr-core","t1"]\u0000n6')}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a long-press still pending when the strip goes away opens nothing", () => {
    vi.useFakeTimers();
    try {
      const { container, unmount } = render(<TimelineStrip strip={[boardStrip]} />);
      fireEvent.pointerDown(container.querySelector("a.tl-strip-link")!);
      unmount();
      vi.advanceTimersByTime(600);
      expect(window.location.hash).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws nothing without strip items", () => {
    const { container } = render(<TimelineStrip strip={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
