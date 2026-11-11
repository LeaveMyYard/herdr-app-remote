import { act, render as rtlRender, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { HostNameProvider } from "../src/bridge/host-name";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { chatAgent, chatTopic, demoKeysMenu, typingDemo } from "../src/chat-fixtures";
import { Chat } from "../src/screens/Chat";
import { forgetConfirmations, typingLine, type ChatInput, type SendOutcome } from "../src/screens/ChatComposer";
import type { KeysInput } from "../src/screens/KeysSheet";

/** Every chat here is on "desk-1", the board's computer. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ({ children }: { children: ReactNode }) => <HostNameProvider name="desk-1">{children}</HostNameProvider> });

// Fake data only (design/PhoneKeys).
const T2140 = new Date(2026, 10, 11, 21, 40).getTime();

function keysInput(over: Partial<KeysInput> = {}, reply: SendOutcome = { ok: true }) {
  const pressed: { key: string; rev: string }[] = [];
  const press = vi.fn(async (key: string, rev: string) => {
    pressed.push({ key, rev });
    return reply;
  });
  return { pressed, keys: { enabled: true, menu: demoKeysMenu, press, ...over } satisfies KeysInput };
}

function chatInput(keys: KeysInput | undefined, over: Partial<ChatInput> = {}): ChatInput {
  return { enabled: true, until: null, send: vi.fn(async () => ({ ok: true })), keys, ...over };
}

const props = { agent: chatAgent, topic: chatTopic, terminal: "t3" };
const openSheet = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Keys: open the special keys menu" }));
  return screen.getByRole("dialog", { name: "Special keys" });
};

beforeEach(() => forgetConfirmations());
afterEach(() => vi.useRealTimers());

describe("typing-time line", () => {
  it("says until when, turns amber with a countdown under 10 minutes, and is absent with no limit", () => {
    expect(typingLine(null, T2140)).toBeNull();
    expect(typingLine(T2140, T2140 - 3 * 3_600_000)).toEqual({ text: "Typing is on until 21:40", soon: false });
    expect(typingLine(T2140, T2140 - 10 * 60_000)).toEqual({ text: "Typing is on until 21:40", soon: false });
    expect(typingLine(T2140, T2140 - 4 * 60_000 + 1)).toEqual({ text: "Typing turns off in 4 min, at 21:40", soon: true });
    expect(typingLine(T2140, T2140 - 1)).toEqual({ text: "Typing turns off in 1 min, at 21:40", soon: true });
  });

  it("is drawn above the key bar, and counts down by itself", () => {
    vi.useFakeTimers();
    let now = T2140 - 10 * 60_000 - 30_000;
    render(<Chat {...props} now={() => now} input={chatInput(undefined, { until: T2140 })} />);
    expect(screen.getByText("Typing is on until 21:40")).toBeInTheDocument();
    act(() => {
      now += 60_000;
      vi.advanceTimersByTime(60_000);
    });
    const line = screen.getByText("Typing turns off in 10 min, at 21:40");
    expect(line.parentElement).toHaveClass("chat-expiry-soon");
  });

  it("no limit: no line", () => {
    render(<Chat {...props} input={chatInput(undefined)} />);
    expect(screen.queryByText(/Typing is on until/)).toBeNull();
  });
});

describe("Keys sheet (S16b)", () => {
  it("opens from the key bar only: no special key is on the bar itself", async () => {
    const { pressed, keys } = keysInput();
    render(<Chat {...props} input={chatInput(keys)} />);
    const bar = screen.getByRole("toolbar", { name: "Keys" });
    for (const k of ["Esc", "Ctrl-C", "↑"]) expect(within(bar).queryByText(k)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const sheet = await openSheet();
    expect(within(sheet).getByText("Pressed at once in Agent 1's terminal.")).toBeInTheDocument();
    expect(pressed).toEqual([]);
  });

  it("draws the default keys first, the desktop's own under Your keys, each with its keys", async () => {
    render(<Chat {...props} input={chatInput(keysInput().keys)} />);
    const sheet = await openSheet();
    const labels = [...sheet.querySelectorAll(".keys-cell .keys-label")].map((e) => e.textContent);
    expect(labels).toEqual(["Esc", "Tab", "Shift-Tab", "Ctrl-C", "↑", "↓", "←", "→", "Accept ✓", "Clear line"]);
    const grids = sheet.querySelectorAll(".keys-grid");
    expect(grids).toHaveLength(2);
    expect(within(sheet).getByText("Your keys")).toBeInTheDocument();
    expect(within(sheet).getByText("shift+tab")).toBeInTheDocument();
    expect(within(sheet).getByText("Change this list in keys.json on desk-1.")).toBeInTheDocument();
    // Ctrl-C is set apart.
    expect(within(sheet).getByText("Ctrl-C").closest("button")).toHaveClass("keys-warn");
    expect(within(sheet).getByText("Esc").closest("button")).not.toHaveClass("keys-warn");
  });

  it("with no own keys there is no Your keys rule", async () => {
    render(<Chat {...props} input={chatInput(keysInput({ menu: { rev: "0123456789abcdef", keys: [...bridgeApi.DEFAULT_KEYS] } }).keys)} />);
    const sheet = await openSheet();
    expect(within(sheet).queryByText("Your keys")).toBeNull();
  });

  it("a press sends the entry id and the rev it was shown at, never key names, and says what was pressed", async () => {
    const { pressed, keys } = keysInput();
    render(<Chat {...props} input={chatInput(keys)} />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByText("Ctrl-C").closest("button")!);
    expect(pressed).toEqual([{ key: "ctrl-c", rev: demoKeysMenu.rev }]);
    expect(within(sheet).getByText("Pressed Ctrl-C.")).toBeInTheDocument();
    expect(within(sheet).getByText("Ctrl-C").closest("button")).toHaveAttribute("data-pressed");
    // No first-press confirmation: the sheet itself is the guard.
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each([
    [{ ok: false, code: "keys_changed" }, "The key list changed on desk-1. Look again."],
    [{ ok: false, code: "terminal_blocked" }, "The agent is waiting on a dialog at the desktop. Nothing was pressed."],
    [{ ok: false, code: "forbidden" }, "Special keys are off for this phone. Turn them on in Remote on desk-1."],
  ] as [SendOutcome, string][])("says what %j means, and never presses again", async (reply, words) => {
    const { pressed, keys } = keysInput({}, reply);
    render(<Chat {...props} input={chatInput(keys)} />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByText("Esc").closest("button")!);
    expect(within(sheet).getByText(words)).toBeInTheDocument();
    expect(within(sheet).queryByText("Pressed Esc.")).toBeNull();
    expect(pressed).toHaveLength(1);
  });

  it.each([
    [{ ok: false, code: "rate_limited" }, "Couldn't press Esc. Try again."],
    [{ ok: false, code: "busy" }, "Couldn't press Esc. Try again."],
    [{ ok: false, code: "timeout", unknown_effect: true }, "Couldn't press Esc. Try again."],
    [{ ok: false, code: "terminal_finished" }, "Agent 1's terminal is closed."],
    [{ ok: false, code: "terminal_not_found" }, "Agent 1's terminal is closed."],
  ] as [SendOutcome, string][])("a failed press %j says it in the approved words, never 'sent'", async (reply, words) => {
    const { pressed, keys } = keysInput({}, reply);
    render(<Chat {...props} input={chatInput(keys)} />);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByText("Esc").closest("button")!);
    expect(within(sheet).getByRole("status")).toHaveTextContent(words);
    expect(within(sheet).queryByText(/sent/)).toBeNull();
    expect(pressed).toHaveLength(1);
  });

  it("special keys on with typing off: a bar with only the Keys button, and the keys press", async () => {
    const { pressed, keys } = keysInput();
    render(<Chat {...props} input={chatInput(keys, { enabled: false })} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    const bar = screen.getByRole("toolbar", { name: "Keys" });
    expect([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Keys: open the special keys menu"]);
    expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByText("Tab").closest("button")!);
    expect(pressed).toEqual([{ key: "tab", rev: demoKeysMenu.rev }]);
  });

  it("special keys on after typing ran out: the ran-out footer keeps the Keys bar", () => {
    const until = T2140;
    render(<Chat {...props} now={() => until + 60_000} input={chatInput(keysInput().keys, { until })} />);
    expect(screen.getByText("Typing turned off at 21:40.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keys: open the special keys menu" })).toBeInTheDocument();
  });

  it("both off: no Keys button at all", () => {
    render(<Chat {...props} input={chatInput(keysInput({ enabled: false }).keys, { enabled: false })} />);
    expect(screen.queryByRole("button", { name: "Keys: open the special keys menu" })).toBeNull();
  });

  it("with terminal.keys off: the button is dimmed, keys are drawn but can't be pressed, and the note says where", async () => {
    const { pressed, keys } = keysInput({ enabled: false });
    render(<Chat {...props} input={chatInput(keys)} />);
    expect(screen.getByRole("button", { name: "Keys: open the special keys menu" })).toHaveClass("chat-keys-off");
    const sheet = await openSheet();
    expect(within(sheet).getByText("Agent 1's terminal")).toBeInTheDocument();
    expect(within(sheet).getByText("Special keys are off for this phone. Turn them on in Remote on desk-1.")).toBeInTheDocument();
    const esc = within(sheet).getByText("Esc").closest("button")!;
    expect(esc).toBeDisabled();
    await userEvent.click(esc);
    expect(pressed).toEqual([]);
    expect(within(sheet).queryByText(/keys\.json/)).toBeNull();
  });

  it("closes with the X, the backdrop or Escape", async () => {
    render(<Chat {...props} input={chatInput(keysInput().keys)} />);
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openSheet();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await openSheet();
    await userEvent.click(document.querySelector(".keys-scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps focus inside while open, and gives it back to the Keys button when it closes", async () => {
    render(<Chat {...props} input={chatInput(keysInput().keys)} />);
    const button = screen.getByRole("button", { name: "Keys: open the special keys menu" });
    const sheet = await openSheet();
    expect(document.activeElement).toBe(sheet);
    const buttons = [...sheet.querySelectorAll("button")];
    for (let i = 0; i < buttons.length + 2; i++) {
      await userEvent.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(sheet.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(button);
  });

  it("labels are text, never HTML", async () => {
    const menu = { rev: "0123456789abcdef", keys: [{ id: "x", label: "<b>X</b>", keys: ["esc"] }] };
    render(<Chat {...props} input={chatInput(keysInput({ menu }).keys)} />);
    const sheet = await openSheet();
    expect(within(sheet).getByText("<b>X</b>")).toBeInTheDocument();
    expect(sheet.querySelector("b")).toBeNull();
  });
});

describe("first send asks once per terminal (copy)", () => {
  it("says it is asked once for each terminal, for text but not for Enter alone", async () => {
    render(<Chat {...props} input={chatInput(undefined)} />);
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.queryByText("Asked once for each terminal while the app is open.")).toBeNull();
    await userEvent.click(within(screen.getByRole("alertdialog")).getByText("Cancel"));
    await userEvent.type(screen.getByRole("textbox", { name: "Message to the agent" }), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Asked once for each terminal while the app is open.")).toBeInTheDocument();
  });
});

describe("PhoneKeys demo states", () => {
  it("each board state is fake data with the board's times", () => {
    for (const s of ["bar", "menu", "off", "soon", "gone"]) expect(typingDemo(s)).not.toBeNull();
    expect(typingDemo("other")).toBeNull();
    expect(typingDemo(null)).toBeNull();
    expect(typingDemo("off")!.input.keys!.enabled).toBe(false);
    expect(typingDemo("menu")).toMatchObject({ sheet: true, pressed: "ctrl-c" });
  });
});
