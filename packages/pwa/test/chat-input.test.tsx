import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatAgent, chatTopic } from "../src/chat-fixtures";
import { fetchTerminalInput, terminalInputOf } from "../src/bridge/me";
import { HostNameProvider } from "../src/bridge/host-name";
import { Chat } from "../src/screens/Chat";
import { forgetConfirmations, sendWords, textProblem, type ChatInput, type SendOutcome } from "../src/screens/ChatComposer";

/** Every chat here is on "desk-1", the board's computer. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ({ children }: { children: ReactNode }) => <HostNameProvider name="desk-1">{children}</HostNameProvider> });

// Fake data only.
function input(over: Partial<ChatInput> = {}, reply: SendOutcome = { ok: true }) {
  const sent: string[] = [];
  const send = vi.fn(async (text: string) => {
    sent.push(text);
    return reply;
  });
  return { sent, send, input: { enabled: true, until: null, send, ...over } satisfies ChatInput };
}

const props = { agent: chatAgent, topic: chatTopic, terminal: "t3" };
const box = () => screen.getByRole("textbox", { name: "Message to the agent" });
const confirm = () => screen.getByRole("alertdialog");

beforeEach(() => forgetConfirmations());
afterEach(() => vi.useRealTimers());

describe("Chat composer (terminal.input)", () => {
  it("is read-only while terminal.input is off, or without an input", () => {
    const { rerender } = render(<Chat {...props} input={input({ enabled: false }).input} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
    rerender(<Chat {...props} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the composer, the keys hc send can press, and the Keys menu button (special keys only in the sheet)", () => {
    render(<Chat {...props} input={input().input} />);
    expect(box()).toHaveAttribute("placeholder", "Type to the terminal…");
    const keys = screen.getByRole("toolbar", { name: "Keys" });
    expect([...keys.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Enter", "Type a slash", "Keys: open the special keys menu"]);
    for (const k of ["Esc", "Tab", "⇧Tab", "Ctrl-C", "↑", "↓"]) expect(screen.queryByRole("button", { name: k })).toBeNull();
    expect(screen.queryByText(/Read-only here/)).toBeNull();
  });

  it("asks before the first send to a terminal; Cancel sends nothing", async () => {
    const { sent, input: i } = input();
    render(<Chat {...props} input={i} />);
    await userEvent.type(box(), "hello agent");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(confirm()).toHaveTextContent("Type this into Agent 1's terminal?");
    expect(confirm()).toHaveTextContent("Asked once for each terminal while the app is open.");
    expect(sent).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toEqual([]);
    expect(box()).toHaveValue("hello agent");
  });

  it("freezes the text while the confirmation is up, so what is confirmed is what is on screen", async () => {
    const { sent, input: i } = input();
    render(<Chat {...props} input={i} />);
    await userEvent.type(box(), "rm -rf build");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box()).toHaveAttribute("readonly");
    await userEvent.type(box(), "ls");
    // Even a change event that gets past readonly (a paste, an IME) is ignored.
    fireEvent.change(box(), { target: { value: "ls" } });
    expect(box()).toHaveValue("rm -rf build");
    await userEvent.click(confirmSend());
    expect(sent).toEqual(["rm -rf build"]);
    expect(box()).not.toHaveAttribute("readonly");
  });

  it("the Send button looks ready with an empty box, as on the board, and sends nothing", async () => {
    const { sent, input: i } = input();
    render(<Chat {...props} input={i} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("sends after the confirmation, clears the text, and doesn't ask again for that terminal", async () => {
    const { sent, input: i } = input();
    const { rerender } = render(<Chat {...props} input={i} />);
    await userEvent.type(box(), "first");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(confirmSend());
    expect(sent).toEqual(["first"]);
    expect(box()).toHaveValue("");
    await userEvent.type(box(), "second");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(sent).toEqual(["first", "second"]);
    // Another terminal asks again.
    rerender(<Chat {...props} terminal="t4" input={i} />);
    await userEvent.type(box(), "third");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(confirm()).toBeInTheDocument();
    expect(sent).toEqual(["first", "second"]);
  });

  it("⏎ presses Enter alone (an empty send, confirmed the first time) and keeps the draft", async () => {
    const { sent, input: i } = input();
    render(<Chat {...props} input={i} />);
    await userEvent.type(box(), "draft");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(confirm()).toHaveTextContent("Press Enter in");
    expect(confirm()).not.toHaveTextContent("Asked once");
    await userEvent.click(confirmSend());
    expect(sent).toEqual([""]);
    expect(box()).toHaveValue("draft");
  });

  it("/ types a slash into the composer and sends nothing", async () => {
    const { sent, input: i } = input();
    render(<Chat {...props} input={i} />);
    await userEvent.click(screen.getByRole("button", { name: "Type a slash" }));
    expect(box()).toHaveValue("/");
    expect(sent).toEqual([]);
  });

  it.each([
    [{ ok: false, code: "forbidden" }, /^Typing to the terminal is off for this phone\. Turn it on in Remote on desk-1\.$/],
    [{ ok: false, code: "rate_limited" }, /too fast/],
    [{ ok: false, code: "busy" }, /Still sending/],
    [{ ok: false, code: "terminal_finished" }, /has closed/],
    [{ ok: false, code: "terminal_blocked" }, /waiting on a dialog/],
    [{ ok: false, code: "cancelled", unknown_effect: true }, /may have been sent/],
    [{ ok: false, code: "audit_unavailable" }, /can't record/],
    [{ ok: false, code: "timeout", unknown_effect: true }, /may have been sent/],
  ] as [SendOutcome, RegExp][])("says what %j means and keeps the text, never resending", async (reply, words) => {
    const { sent, input: i } = input({}, reply);
    render(
      <HostNameProvider name="desk-1">
        <Chat {...props} input={i} />
      </HostNameProvider>,
    );
    await userEvent.type(box(), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(confirmSend());
    expect(screen.getByRole("status")).toHaveTextContent(words);
    expect(box()).toHaveValue("hello");
    expect(sent).toEqual(["hello"]);
  });

  it("refuses control characters and overlong text before sending", () => {
    expect(textProblem("ok\n\ttab")).toBeNull();
    expect(textProblem("esc \u001b[A")).toMatch(/control characters/);
    expect(textProblem("x".repeat(4001))).toMatch(/Too long/);
    expect(sendWords({ ok: false, code: "something_new" }, "desk-1")).toBe("Not sent.");
  });

  it("goes read-only by itself when the expiry passes, saying when it turned off", () => {
    vi.useFakeTimers();
    const until = new Date(2026, 10, 11, 21, 40).getTime();
    let now = until - 60_000;
    render(<Chat {...props} now={() => now} input={input({ until }).input} />);
    expect(box()).toHaveAttribute("placeholder", "Type to the terminal…");
    act(() => {
      now += 60_000;
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Typing turned off at 21:40.")).toBeInTheDocument();
    expect(screen.getByText("Turn it on again in Remote on desk-1.")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("turned off from the desktop before its time is the plain read-only footer, not 'turned off at'", () => {
    const until = new Date(2026, 10, 11, 21, 40).getTime();
    const now = until - 3_600_000;
    const { rerender } = render(<Chat {...props} now={() => now} input={input({ until }).input} />);
    rerender(<Chat {...props} now={() => now} input={{ ...input().input, enabled: false, until: null }} />);
    expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
    expect(screen.queryByText(/Typing turned off at/)).toBeNull();
  });

  it("an early turn-off is not later shown as running out when the old limit passes", () => {
    vi.useFakeTimers();
    const until = new Date(2026, 10, 11, 21, 40).getTime();
    let now = until - 3_600_000;
    const { rerender } = render(<Chat {...props} now={() => now} input={input({ until }).input} />);
    rerender(<Chat {...props} now={() => now} input={{ ...input().input, enabled: false, until: null }} />);
    now = until + 60_000;
    rerender(<Chat {...props} now={() => now} input={{ ...input().input, enabled: false, until: null }} />);
    expect(screen.queryByText(/Typing turned off at/)).toBeNull();
    expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
  });

  it("an expiry already past shows no composer", () => {
    render(<Chat {...props} now={() => 2_000} input={input({ until: 1_000 }).input} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("fetchTerminalInput (/api/v1/me)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown = {}) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("reads 200, says off for 401 and 403, and keeps what it had (null) for anything else", async () => {
    reply(200, { device: { caps: { "terminal.input": true }, terminal_input_until: null } });
    expect(await fetchTerminalInput()).toEqual({ enabled: true, until: null, keys: { enabled: false, until: null } });
    reply(401);
    expect(await fetchTerminalInput()).toEqual({ enabled: false, until: null, keys: { enabled: false, until: null } });
    reply(403);
    expect(await fetchTerminalInput()).toEqual({ enabled: false, until: null, keys: { enabled: false, until: null } });
    reply(503);
    expect(await fetchTerminalInput()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await fetchTerminalInput()).toBeNull();
  });
});

describe("terminalInputOf (/api/v1/me)", () => {
  it("reads the capability and expiry, and anything odd as off", () => {
    const off = { enabled: false, until: null };
    expect(terminalInputOf({ device: { caps: { "terminal.input": true }, terminal_input_until: 5 } })).toEqual({ enabled: true, until: 5, keys: off });
    expect(terminalInputOf({ device: { caps: { "terminal.input": "yes" } } })).toEqual({ ...off, keys: off });
    expect(terminalInputOf(null)).toEqual({ ...off, keys: off });
    expect(terminalInputOf({ device: { caps: { "terminal.input": true }, terminal_input_until: "soon" } })).toEqual({ enabled: true, until: null, keys: off });
    // terminal.keys (S16b) is read on its own.
    expect(terminalInputOf({ device: { caps: { "terminal.keys": true }, terminal_keys_until: 9 } })).toEqual({ ...off, keys: { enabled: true, until: 9 } });
    expect(terminalInputOf({ device: { caps: { "terminal.keys": 1 }, terminal_keys_until: "x" } })).toEqual({ ...off, keys: off });
  });
});

/** The confirmation's own Send button (the composer has one too). */
function confirmSend(): HTMLElement {
  const dlg = confirm();
  return [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Send")! as HTMLElement;
}
