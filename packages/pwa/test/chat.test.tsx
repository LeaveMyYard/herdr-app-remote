import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { bridgeApi } from "@herdr-remote/protocol";
import { App } from "../src/App";
import { AnsiText, spanStyle } from "../src/components/AnsiText";
import { chatAgent, chatQuestion, chatTopic } from "../src/chat-fixtures";
import { Chat, ChatPicker } from "../src/screens/Chat";

const topic = (lines: bridgeApi.ChatLine[]): bridgeApi.ChatTopic => ({ terminal: "t3", lines });

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

describe("AnsiText", () => {
  it("renders hostile text as text, never as elements", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(1)</script> &amp;';
    const { container } = render(<AnsiText lines={[[{ t: evil }], [{ t: evil, fg: 1 }]]} />);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toBe(evil + evil);
  });

  it("maps palette indexes to the theme variables and hex to itself", () => {
    expect(spanStyle({ t: "x", fg: 2, bg: "#010203" })).toEqual({ color: "var(--ans-2)", backgroundColor: "#010203" });
    expect(spanStyle({ t: "x" })).toBeUndefined();
  });

  it("drops a colour that is not valid, instead of passing it into CSS", () => {
    const bad = { t: "x", fg: "red; background:url(//evil)", bg: 99 } as unknown as bridgeApi.ChatSpan;
    expect(spanStyle(bad)).toBeUndefined();
  });

  it("applies weight, italic, underline and dim", () => {
    expect(spanStyle({ t: "x", b: true, i: true, u: true, d: true })).toEqual({ fontWeight: 600, fontStyle: "italic", textDecoration: "underline", opacity: 0.6 });
  });

  it("swaps colours for reverse video, falling back to the terminal's own", () => {
    expect(spanStyle({ t: "x", r: true })).toEqual({ color: "var(--t-background)", backgroundColor: "var(--t-foreground)" });
    expect(spanStyle({ t: "x", r: true, fg: 1, bg: 4 })).toEqual({ color: "var(--ans-4)", backgroundColor: "var(--ans-1)" });
  });

  it("keeps empty lines as line boxes", () => {
    const { container } = render(<AnsiText lines={[[{ t: "a" }], [], [{ t: "b" }]]} />);
    expect(container.querySelectorAll(".cl")).toHaveLength(3);
  });
});

describe("Chat", () => {
  const props = { agent: chatAgent, topic: chatTopic, question: chatQuestion };

  it("shows the agent in the header and the terminal text in a log", () => {
    render(<Chat {...props} />);
    expect(screen.getByText("Agent 1 · Parser rewrite")).toBeInTheDocument();
    expect(screen.getByText("~/code/alpha")).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Terminal output" });
    expect(log).toHaveTextContent("Tests pass: 212 passed, 0 failed.");
    expect(within(log).getByText("Q123 · Question Title 123")).toHaveStyle({ color: "#e5c07b" });
  });

  it("links the inbox banner to the question", () => {
    render(<Chat {...props} />);
    const banner = screen.getByRole("link", { name: /Q123 waits for you/ });
    expect(banner).toHaveAttribute("href", "#/inbox");
    expect(banner).toHaveTextContent("Answer ›");
  });

  it("has no banner without a question", () => {
    render(<Chat {...props} question={undefined} />);
    expect(screen.queryByText(/waits for you/)).toBeNull();
  });

  it("is read-only: no composer, send button or key bar, and says why", () => {
    render(<Chat {...props} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
  });

  it("says it is waiting before the first snap, and when the terminal is blank", () => {
    const { rerender } = render(<Chat {...props} topic={undefined} />);
    expect(screen.getByText("Waiting for the terminal…")).toBeInTheDocument();
    rerender(<Chat {...props} topic={topic([])} />);
    expect(screen.getByText("Nothing on screen yet.")).toBeInTheDocument();
  });

  it.each([
    ["source_unavailable", "Can't reach the terminal. Showing the last text."],
    ["terminal_not_found", "This terminal has closed."],
    ["too_many_chats", "Too many chats are open. Close one to read this."],
    ["bad_terminal", "This isn't a terminal herdr knows."],
    ["something_new", "Showing older text."],
  ])("explains a stale topic (%s) and keeps the last text", (reason, text) => {
    render(<Chat {...props} stale={reason} />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.getByRole("log")).toHaveTextContent("Tests pass");
  });

  it("shows no notice while fresh", () => {
    render(<Chat {...props} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("toggles fit width and remembers it", async () => {
    const { unmount } = render(<Chat {...props} />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("data-fit", "true");
    await userEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(log).toHaveAttribute("data-fit", "false");
    unmount();
    render(<Chat {...props} />);
    expect(screen.getByRole("log")).toHaveAttribute("data-fit", "false");
  });

  it("shows each agent state in the header", () => {
    const { rerender } = render(<Chat {...props} />);
    expect(screen.getByRole("img", { name: "Working" })).toBeInTheDocument();
    rerender(<Chat {...props} agent={{ ...chatAgent, status: "needs-you" }} />);
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    rerender(<Chat {...props} agent={{ ...chatAgent, status: "done" }} />);
    expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
    rerender(<Chat {...props} agent={{ ...chatAgent, status: "idle" }} />);
    expect(screen.getByRole("img", { name: "Idle" })).toBeInTheDocument();
  });

  it("follows new output while pinned to the end, and stops following once scrolled up", () => {
    const { rerender } = render(<Chat {...props} />);
    const log = screen.getByRole("log");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    rerender(<Chat {...props} topic={topic([[{ t: "more" }]])} />);
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 100;
    act(() => {
      log.dispatchEvent(new Event("scroll"));
    });
    rerender(<Chat {...props} topic={topic([[{ t: "even more" }]])} />);
    expect(log.scrollTop).toBe(100);
  });

  it("marks the animated spinner, the pulsing tile, the terminal text and the footer slot for the visual harness", () => {
    const { container } = render(<Chat {...props} />);
    expect(container.querySelectorAll("[data-vis-mask]")).toHaveLength(4);
  });
});

describe("ChatPicker and routing", () => {
  it("lists agents on the Chat tab", () => {
    render(<ChatPicker agents={[{ id: "a-1", name: "Agent 1", tab: "tab 2" }]} />);
    expect(screen.getByRole("link", { name: /Agent 1/ })).toHaveAttribute("href", "#/chat/a-1");
  });

  it("opens an agent's chat full screen from #/chat/<id>, without the tab bar", () => {
    window.location.hash = "#/chat/a-1";
    render(<App />);
    expect(screen.getByRole("log")).toHaveTextContent("Tests pass");
    expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
  });

  it("goes back to Agents from the chat", async () => {
    window.location.hash = "#/chat/a-1";
    render(<App />);
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "#/agents");
  });

  it("opens an agent with no demo text and waits for it", () => {
    window.location.hash = "#/chat/a-2";
    render(<App />);
    expect(screen.getByText("Waiting for the terminal…")).toBeInTheDocument();
  });

  it("shows the picker for #/chat and for an unknown agent id", () => {
    window.location.hash = "#/chat";
    const { unmount } = render(<App />);
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link", { name: /Agent \d/ }).length).toBeGreaterThan(0);
    unmount();
    window.location.hash = "#/chat/nope";
    render(<App />);
    expect(screen.queryByRole("log")).toBeNull();
  });
});
