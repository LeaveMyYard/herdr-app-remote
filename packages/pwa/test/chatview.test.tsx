import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { bridgeApi } from "@herdr-remote/protocol";
import { HostNameProvider } from "../src/bridge/host-name";
import { applyTopic, initHeld, prepend } from "../src/chatview/merge";
import { inline, Markdown, safeHref } from "../src/chatview/markdown";
import { chatMode } from "../src/chatview/mode";
import * as W from "../src/chatview/words";
import { ChatView } from "../src/screens/ChatView";
import { ChatRoute } from "../src/screens/ChatRoute";
import type { ChatAgent } from "../src/screens/Chat";
import { chatTopic } from "../src/chat-fixtures";

// Fake data only.
type Item = bridgeApi.ChatItem;
const agent: ChatAgent = { name: "Agent 1", folder: "~/code/alpha", harness: "claude", status: "working" };
const NOW = Date.parse("2026-11-13T21:14:12Z");
const topic = (items: Item[], extra: Partial<bridgeApi.ChatviewTopic> = {}): bridgeApi.ChatviewTopic => ({
  terminal: "t1",
  harness: "claude",
  state: "ok",
  items,
  older: false,
  rev: "r1",
  status: { state: "idle", since: null },
  ...extra,
});
const you = (id: string, text: string): Item => ({ id, role: "you", at: null, text });
const ai = (id: string, text: string): Item => ({ id, role: "agent", at: null, text });
const tools = (id: string, kind: bridgeApi.ToolKind, count: number, o: { running?: number; failed?: number; names?: string[] } = {}): Item => ({
  id,
  role: "tools",
  at: null,
  tools: { kind, count, running: o.running ?? 0, failed: o.failed ?? 0, names: o.names ?? [] },
});
const view = (t: bridgeApi.ChatviewTopic, p: Partial<Parameters<typeof ChatView>[0]> = {}) => render(<HostNameProvider name="desk-1"><ChatView agent={agent} topic={t} now={() => NOW} {...p} /></HostNameProvider>);

/** Linear is about 4 and quadratic about 16; the bound sits between them with room for noise on a shared runner. */
const GROWTH_MAX = 10;
/**
 * How much longer `run` takes on the full input than on a quarter of it, each the best of three runs after a warm-up.
 * A quarter-size run under 1 ms counts as 1 ms, so timer noise on a tiny run can't make a large ratio.
 */
function growth(make: (k: number) => string, run: (text: string) => void): number {
  const best = (text: string) => {
    let min = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      run(text);
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };
  const small = make(0.25);
  const full = make(1);
  run(small);
  return best(full) / Math.max(best(small), 1);
}

describe("markdown", () => {
  it("never makes elements from raw html, and keeps it as text", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"><script>alert(1)</script>\n\n<b>bold</b>'} />);
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("links only http, https and mailto, and always with noopener", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref(" //evil.example")).toBeNull();
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    const { container } = render(<Markdown text="[ok](https://example.com) [bad](javascript:alert(1))" />);
    const a = container.querySelectorAll("a");
    expect(a).toHaveLength(1);
    expect(a[0]).toHaveTextContent("https://example.com");
    expect(a[0]).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(container.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("renders lists, code, emphasis, headings, quotes and tables", () => {
    const md = "# Title\n\n- one\n  - nested\n- two\n\n1. a\n2. b\n\n**bold** *it* `code` ~~gone~~\n\n```sh\nnpm test\n```\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const { container } = render(<Markdown text={md} />);
    expect(container.querySelector("[role=heading]")).toHaveTextContent("Title");
    expect(container.querySelectorAll("ul ul li")).toHaveLength(1);
    expect(container.querySelector("ol")?.children).toHaveLength(2);
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("it");
    expect(container.querySelector("del")).toHaveTextContent("gone");
    expect(container.querySelector("pre code")?.textContent).toBe("npm test");
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("shows a link's full URL beside its label", () => {
    const { container } = render(<Markdown text="[Open the docs](https://evil.example/login) and [https://ok.example](https://ok.example)" />);
    const [a1, a2] = [...container.querySelectorAll("a")];
    expect(a1).toHaveTextContent("Open the docs https://evil.example/login");
    expect(a2?.textContent).toBe("https://ok.example");
  });

  // Each case is one hostile line of at most 32 KB at full size (k = 1). Wall-clock bounds flaked on shared CI
  // runners, so the cases are timed by growth instead: four times the input should take about four times as long
  // (linear), where a quadratic scan takes sixteen times. The best of three runs keeps a slow run from counting.
  const HOSTILE: [string, (k: number) => string][] = [
    ["heading with a space run", (k) => "## Results" + " ".repeat(16000 * k) + "done"],
    ["heading with a hash and space run", (k) => "# a" + " #".repeat(8000 * k) + " ".repeat(8000 * k) + "x"],
    ["fence with a space run", (k) => "```" + " ".repeat(32000 * k) + "!"],
    ["table separator candidate", (k) => "a | b\n" + "|" + " ".repeat(32000 * k) + "x"],
    ["table separator of dashes and spaces", (k) => "a | b\n" + "- ".repeat(16000 * k)],
    ["rule of spaced marks", (k) => "- - - " + " ".repeat(32000 * k) + "x"],
    ["brackets", (k) => "[".repeat(32768 * k)],
    ["stars", (k) => "*".repeat(32768 * k)],
    ["backticks", (k) => "`".repeat(32768 * k)],
    ["open links", (k) => "[a](".repeat(8000 * k)],
    ["empty brackets", (k) => "[]".repeat(16384 * k)],
    ["brackets with a stray close", (k) => "[a]]".repeat(8000 * k)],
    ["links with no closing paren", (k) => "[](".repeat(10000 * k)],
    ["stars before spaces", (k) => "*a *".repeat(8000 * k)],
    ["open bold", (k) => "**a ".repeat(8000 * k)],
    ["list markers", (k) => "- ".repeat(16000 * k)],
    ["quote markers", (k) => "> ".repeat(16000 * k)],
    ["nested lists", (k) => Array.from({ length: 600 * k }, (_, i) => " ".repeat(i % 40) + "- x").join("\n")],
  ];
  for (const [name, make] of HOSTILE) {
    it(`stays linear on ${name}`, () => {
      expect(growth(make, (text) => render(<Markdown text={text} />).unmount())).toBeLessThan(GROWTH_MAX);
    });
  }
  // A code, bold or strike opener is itself the mark it looks for, so its search stops at the next opener. These
  // inputs make thousands of elements, so the scan is timed without the DOM.
  const OPENERS: [string, (k: number) => string][] = [
    ["backtick runs of mixed length", (k) => "``a`".repeat(8000 * k)],
    ["bold openers among single stars", (k) => "**a*".repeat(8000 * k)],
    ["strike openers among single tildes", (k) => "~~a~".repeat(8000 * k)],
  ];
  for (const [name, make] of OPENERS) {
    it(`scans linearly on ${name}`, () => {
      expect(growth(make, (text) => void inline(text))).toBeLessThan(GROWTH_MAX);
    });
  }
  it("renders a heading and a fence the same as before the hand-written scan", () => {
    const { container } = render(<Markdown text={"## Title ##\n\n```ts extra!\nx\n```\n\n~~~\ny\n~~~"} />);
    expect(container.querySelector("[role=heading]")?.textContent).toBe("Title");
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.textContent).toContain("```ts extra!");
  });
  it("inline parses a bold run", () => {
    expect(inline("**a**")).toHaveLength(1);
  });
});

describe("merge", () => {
  const A = you("a", "1");
  const B = ai("b", "2");
  const C = you("c", "3");
  const D = ai("d", "4");
  it("keeps older pages when the window slides, and the topic wins from its first item", () => {
    let h = initHeld(topic([B, C], { older: true }));
    h = prepend(h, { items: [A], older: false, rev: "r1" }, "b");
    expect(h.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    const h2 = applyTopic(h, topic([C, D], { older: true }));
    expect(h2.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(h2.older).toBe(false);
  });
  it("starts over for another rev or a window that joins nothing", () => {
    const h = prepend(initHeld(topic([B, C], { older: true })), { items: [A], older: false, rev: "r1" }, "b");
    expect(applyTopic(h, topic([B, C], { rev: "r2" })).items.map((i) => i.id)).toEqual(["b", "c"]);
    expect(applyTopic(h, topic([D])).items.map((i) => i.id)).toEqual(["d"]);
  });
  it("ignores a page for another rev, or one that no longer sits before the head", () => {
    const h = initHeld(topic([B, C], { older: true }));
    expect(prepend(h, { items: [A], older: false, rev: "r9" }, "b")).toBe(h);
    expect(prepend(h, { items: [A], older: false, rev: "r1" }, "x")).toBe(h);
  });
});

describe("chatMode", () => {
  const ok = topic([]);
  it("chooses the view and the notice", () => {
    const base = { claude: true, harnessId: "claude", topic: undefined, stale: null };
    expect(chatMode(base)).toEqual({ kind: "pending" });
    expect(chatMode({ ...base, topic: ok })).toEqual({ kind: "chat" });
    expect(chatMode({ ...base, claude: false, harnessId: "codex" })).toEqual({ kind: "text", notice: "codex" });
    expect(chatMode({ ...base, claude: false, harnessId: "gemini" })).toEqual({ kind: "text", notice: null });
    expect(chatMode({ ...base, topic: ok, stale: "forbidden" })).toEqual({ kind: "text", notice: "forbidden" });
    expect(chatMode({ ...base, topic: { ...ok, state: "unavailable", reason: "no_binding" } })).toEqual({ kind: "text", notice: "no_binding" });
    expect(chatMode({ ...base, stale: "audit_unavailable" })).toEqual({ kind: "text", notice: "reader_failed" });
    expect(chatMode({ ...base, waitedOut: true })).toEqual({ kind: "text", notice: "reader_failed" });
  });
});

describe("words", () => {
  it("has the approved copy", () => {
    expect(W.toolsLabel("shell", 1, false)).toBe("Ran 1 shell command");
    expect(W.toolsLabel("shell", 2, false)).toBe("Ran 2 shell commands");
    expect(W.toolsLabel("read", 3, false)).toBe("Read 3 files");
    expect(W.toolsLabel("read", 2, true)).toBe("Reading 2 files");
    expect(W.toolsLabel("edit", 2, false)).toBe("Edited 2 files");
    expect(W.toolsLabel("search", 4, false)).toBe("Searched 4 times");
    expect(W.toolsLabel("subagent", 3, false)).toBe("Ran 3 subagents");
    expect(W.toolsLabel("other", 2, false)).toBe("Used 2 tools");
    expect(W.failedLabel("shell", 1)).toBe("1 command failed");
    expect(W.jumpLabel(4)).toBe("4 new");
    expect(W.jumpLabel(0)).toBe("Latest");
    expect(W.elapsed(72_000)).toBe("1m 12s");
    expect(W.noticeWords("forbidden", "desk-1")).toEqual({ title: "Chat history is off for this phone", body: "Turn it on in Remote on desk-1." });
  });
  it("labels days in local time", () => {
    const d = new Date(2026, 10, 13, 21, 2).toISOString();
    expect(W.dayLabel(d, new Date(2026, 10, 13, 22).getTime())).toBe("Today 21:02");
    expect(W.dayLabel(d, new Date(2026, 10, 14, 8).getTime())).toBe("Yesterday 21:02");
    expect(W.dayLabel(d, new Date(2026, 10, 20, 8).getTime())).toBe("13 Nov 21:02");
  });
});

describe("ChatView", () => {
  it("draws bubbles, replies as markdown and tool rows with their counts", () => {
    view(topic([you("1", "Hello <b>there</b>"), ai("2", "Reply with `code`"), tools("3", "shell", 2), tools("4", "read", 3, { running: 1 })], { status: { state: "working", since: new Date(NOW - 72_000).toISOString() } }));
    expect(screen.getByText("Hello <b>there</b>")).toBeInTheDocument();
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("Ran 2 shell commands")).toBeInTheDocument();
    expect(screen.getByText("Reading 3 files")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Working · 1m 12s");
  });

  it("shows no spinner for a call with no result while the agent is idle", () => {
    view(topic([tools("1", "read", 2, { running: 2 })]));
    expect(screen.getByText("Read 2 files")).toBeInTheDocument();
  });

  it("expands a row to its call names, and shows a failed row as such", async () => {
    view(topic([tools("1", "shell", 2, { names: ["Bash", "Bash"] }), tools("2", "shell", 1, { failed: 1 })]));
    await userEvent.click(screen.getByRole("button", { name: /Ran 2 shell commands/ }));
    expect(screen.getAllByText("Bash")).toHaveLength(2);
    expect(screen.getByText("1 command failed")).toBeInTheDocument();
  });

  it("says Waiting for you when blocked, and nothing when idle", () => {
    const { unmount } = view(topic([ai("1", "hi")], { status: { state: "blocked", since: null } }));
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for you");
    unmount();
    view(topic([ai("1", "hi")]));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows chips, dividers, the cut mark and the inbox question row", () => {
    view(topic([{ id: "d", role: "divider", at: null, divider: "compact" }, { id: "c", role: "you", at: null, text: "/compact", command: true }, { id: "y", role: "you", at: null, text: "long", cut: true }, { id: "q", role: "ask", at: null, ask: { via: "inbox", question: null, header: null, multi: false, options: [] } }]));
    expect(screen.getByText("Earlier messages were summarised")).toBeInTheDocument();
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("Cut here")).toBeInTheDocument();
    expect(screen.getByText("Asked you a question")).toBeInTheDocument();
  });

  it("draws no divider for a day without a time", () => {
    view(topic([{ id: "d", role: "divider", at: null, divider: "day" }, ai("1", "hi")]));
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("says when there are no messages yet", () => {
    view(topic([]));
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(screen.getByText("New session in ~/code/alpha. What you send appears here.")).toBeInTheDocument();
  });

  it("has a text composer only: no key bar, no Keys menu, and the chat view's placeholder", () => {
    view(topic([ai("1", "hi")]), { input: { enabled: true, until: null, send: async () => ({ ok: true }) }, terminal: "t1" });
    expect(screen.getByPlaceholderText("Message Agent 1…")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /Keys/ })).toBeNull();
  });

  it("is read-only with the copy when typing is off", () => {
    view(topic([ai("1", "hi")]), { input: { enabled: false, until: null, send: async () => ({ ok: true }) }, terminal: "t1" });
    expect(screen.getByText("Read-only here. Typing is off for this phone.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("locks the composer while a prompt is open", () => {
    view(topic([ai("1", "hi")]), { input: { enabled: true, until: null, send: async () => ({ ok: true }) }, terminal: "t1", locked: true });
    expect(screen.getByPlaceholderText("Answer the prompt above first")).toHaveAttribute("readonly");
  });

  it("lets a slot draw an item, give the default back, and add a tail", () => {
    view(topic([you("1", "mine"), ai("2", "theirs")]), {
      tail: <p>the tail</p>,
      renderItem: (item, _prev, draw) => (item.id === "1" ? <p>replaced</p> : <><p>before</p>{draw()}</>),
    });
    expect(screen.queryByText("mine")).toBeNull();
    expect(screen.getByText("replaced")).toBeInTheDocument();
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("theirs")).toBeInTheDocument();
    expect(screen.getByText("the tail")).toBeInTheDocument();
  });

  describe("older pages and the jump button", () => {
    const geometry = (el: HTMLElement, g: { height: number; client: number; top: number }) => {
      Object.defineProperty(el, "scrollHeight", { configurable: true, value: g.height });
      Object.defineProperty(el, "clientHeight", { configurable: true, value: g.client });
      el.scrollTop = g.top;
    };

    it("loads the page before the first item when the top is reached, keeps the order, and says it is loading", async () => {
      let done: (r: unknown) => void = () => undefined;
      const loadOlder = vi.fn(() => new Promise((res) => { done = res; })) as unknown as NonNullable<Parameters<typeof ChatView>[0]["loadOlder"]>;
      view(topic([you("b", "second")], { older: true }), { loadOlder });
      // The screen is short, so the first page is asked for without a scroll.
      expect(loadOlder).toHaveBeenCalledWith("b", "r1");
      expect(screen.getByText("Loading earlier messages…")).toBeInTheDocument();
      await act(async () => done({ ok: true, page: { items: [you("a", "first")], older: false, rev: "r1" } }));
      const log = screen.getByRole("log");
      expect(within(log).getAllByText(/first|second/).map((e) => e.textContent)).toEqual(["first", "second"]);
      expect(screen.queryByText("Loading earlier messages…")).toBeNull();
    });

    it("offers Show earlier messages when a page fails, and asks again on tap", async () => {
      const loadOlder = vi.fn().mockResolvedValueOnce({ ok: false, code: "failed" }).mockResolvedValue({ ok: true, page: { items: [], older: false, rev: "r1" } });
      view(topic([you("b", "second")], { older: true }), { loadOlder });
      await act(async () => undefined);
      await userEvent.click(await screen.findByRole("button", { name: "Show earlier messages" }));
      expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it("does not ask again for the same page after another history answered", async () => {
      const loadOlder = vi.fn().mockResolvedValue({ ok: false, code: "rev_changed" });
      const { rerender } = view(topic([you("b", "second")], { older: true }), { loadOlder });
      await act(async () => undefined);
      rerender(<HostNameProvider name="desk-1"><ChatView agent={agent} topic={topic([you("b", "second")], { older: true })} now={() => NOW} loadOlder={loadOlder} /></HostNameProvider>);
      await act(async () => undefined);
      expect(loadOlder).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Show earlier messages" })).toBeNull();
    });

    it("drops to the text view's notice path on 403 by calling onForbidden", async () => {
      const onForbidden = vi.fn();
      view(topic([you("b", "second")], { older: true }), { loadOlder: async () => ({ ok: false, code: "forbidden" }), onForbidden });
      await act(async () => undefined);
      expect(onForbidden).toHaveBeenCalled();
    });

    it("counts what arrived while scrolled up, and jumps to the end", async () => {
      const t1 = topic([you("1", "a"), ai("2", "b")]);
      const { rerender } = view(t1);
      const log = screen.getByRole("log");
      geometry(log, { height: 2000, client: 500, top: 0 });
      fireEvent.scroll(log);
      expect(screen.getByRole("button", { name: /Latest/ })).toBeInTheDocument();
      const t2 = topic([you("1", "a"), ai("2", "b"), ai("3", "c"), tools("4", "shell", 1)]);
      rerender(<HostNameProvider name="desk-1"><ChatView agent={agent} topic={t2} now={() => NOW} /></HostNameProvider>);
      const jump = screen.getByRole("button", { name: /new/ });
      expect(jump).toHaveTextContent("2 new");
      await userEvent.click(jump);
      expect(screen.queryByRole("button", { name: /new|Latest/ })).toBeNull();
    });
  });
});

describe("ChatRoute", () => {
  const text = { agent, topic: chatTopic, terminal: "t1", input: { enabled: true, until: null, send: async () => ({ ok: true }) } };
  const r = (mode: Parameters<typeof ChatRoute>[0]["mode"], t?: bridgeApi.ChatviewTopic) => (
    <HostNameProvider name="desk-1"><ChatRoute mode={mode} text={text} view={{ topic: t }} /></HostNameProvider>
  );

  it("shows no text view while pending, and the notice with the text view when unavailable", () => {
    const { rerender } = render(r({ kind: "pending" }));
    expect(screen.queryByRole("log", { name: "Terminal output" })).toBeNull();
    rerender(r({ kind: "text", notice: "no_binding" }));
    expect(screen.getByText("Can't match this agent to its history")).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Terminal output" })).toBeInTheDocument();
  });

  it("closes a notice for the session", async () => {
    render(r({ kind: "text", notice: "codex" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("No chat view for Codex yet")).toBeNull();
  });

  it("waits to move to the chat view while a draft is typed, then moves", async () => {
    const { rerender } = render(r({ kind: "text", notice: "reader_failed" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Message to the agent" }), "half a thought");
    rerender(r({ kind: "chat" }, topic([ai("1", "hi")])));
    expect(screen.getByRole("log", { name: "Terminal output" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message to the agent" })).toHaveValue("half a thought");
    await userEvent.clear(screen.getByRole("textbox", { name: "Message to the agent" }));
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
  });

  it("moves at once when nothing is open", () => {
    const { rerender } = render(r({ kind: "text", notice: "reader_failed" }));
    rerender(r({ kind: "chat" }, topic([ai("1", "hi")])));
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
  });
});

describe("prompt cards in the chat view (CV7)", () => {
  const card: Item = {
    id: "prompt-1",
    role: "prompt",
    at: null,
    prompt_id: "1".repeat(64),
    rev: "r1",
    kind: "permission",
    title: "Do you want to proceed?",
    summary: "cargo test -p parser",
    options: [{ label: "Yes" }, { label: "No" }],
    state: "open",
  };

  it("draws the card, locks the composer, and says nothing more than the card does", () => {
    const input = { enabled: true, until: null, send: vi.fn(async () => ({ ok: true })) };
    view(topic([ai("a1", "Running the parser tests next."), card], { status: { state: "blocked", since: null } }), { terminal: "t1", input, promptAct: vi.fn() });
    expect(screen.getByRole("region", { name: "Permission request" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Answer the prompt above first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // "Waiting for you" is not drawn: the card already says it.
    expect(screen.queryByText(W.WAITING)).toBeNull();
  });

  it("a press sends prompt.answer for this terminal with the card's id and rev", async () => {
    const promptAct = vi.fn(async () => ({ ok: false, code: "prompt_changed" }));
    view(topic([card], { status: { state: "blocked", since: null } }), { terminal: "t1", promptAct });
    await userEvent.click(screen.getByRole("button", { name: /^No/ }));
    expect(promptAct).toHaveBeenCalledWith("prompt.answer", { terminal: "t1", prompt_id: "1".repeat(64), rev: "r1", choice: { option: 1 } });
    expect(screen.getByRole("alert")).toHaveTextContent("The prompt changed. Look again.");
  });

  it("without a card the composer is open and the waiting line shows", () => {
    const input = { enabled: true, until: null, send: vi.fn(async () => ({ ok: true })) };
    view(topic([ai("a1", "Hi.")], { status: { state: "blocked", since: null } }), { terminal: "t1", input });
    expect(screen.queryByPlaceholderText("Answer the prompt above first")).toBeNull();
    expect(screen.getByText(W.WAITING)).toBeInTheDocument();
  });
});
