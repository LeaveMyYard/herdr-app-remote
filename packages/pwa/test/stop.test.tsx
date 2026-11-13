// CV8: Stop in the chat view's composer, and the "Stopped by you" row. Fake data only.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { bridgeApi } from "@herdr-remote/protocol";
import { HostNameProvider } from "../src/bridge/host-name";
import * as W from "../src/chatview/words";
import { ChatView } from "../src/screens/ChatView";
import type { ChatAgent } from "../src/screens/Chat";
import type { ChatInput, SendOutcome } from "../src/screens/ChatComposer";

type Item = bridgeApi.ChatItem;
const agent: ChatAgent = { name: "Agent 1", folder: "~/code/alpha", harness: "claude", status: "working" };
const NOW = Date.parse("2026-11-13T21:14:12Z");
const WORKING = { state: "working" as const, since: "2026-11-13T21:13:00Z" };
const IDLE = { state: "idle" as const, since: null };
const topic = (status: bridgeApi.ChatviewStatus, items: Item[] = [{ id: "m1", role: "you", at: null, text: "Split the parser" }]): bridgeApi.ChatviewTopic => ({
  terminal: "t1",
  harness: "claude",
  state: "ok",
  items,
  older: false,
  rev: "r1",
  status,
});
function input(o: { stop?: boolean; press?: () => Promise<SendOutcome>; send?: () => Promise<SendOutcome> } = {}) {
  const press = vi.fn(o.press ?? (async () => ({ ok: true })));
  const send = vi.fn(o.send ?? (async () => ({ ok: true })));
  const i: ChatInput = { enabled: true, until: null, send, ...(o.stop === false ? {} : { stop: { enabled: o.stop ?? true, press } }) };
  return { i, press, send };
}
const view = (t: bridgeApi.ChatviewTopic, i: ChatInput) =>
  render(
    <HostNameProvider name="desk-1">
      <ChatView agent={agent} topic={t} now={() => NOW} input={i} terminal="t1" />
    </HostNameProvider>,
  );
const stopButton = () => screen.queryByRole("button", { name: "Stop Agent 1" });
const sendButton = () => screen.queryByRole("button", { name: "Send" });

describe("Stop in the composer (CV8)", () => {
  it("shows Stop instead of Send while the agent works and nothing is typed; one press sends agent.stop once", async () => {
    const { i, press } = input();
    view(topic(WORKING), i);
    expect(stopButton()).not.toBeNull();
    expect(sendButton()).toBeNull();
    await userEvent.click(stopButton()!);
    expect(press).toHaveBeenCalledTimes(1);
    // No note on success: the chat view shows "Stopped by you" from the transcript.
    expect(screen.queryByText(/stopped/i)).toBeNull();
  });

  it("typing brings Send back, so a message can still be queued", async () => {
    const { i, press } = input();
    view(topic(WORKING), i);
    await userEvent.type(screen.getByRole("textbox"), "and the docs too");
    expect(stopButton()).toBeNull();
    expect(sendButton()).not.toBeNull();
    expect(press).not.toHaveBeenCalled();
  });

  it("no Stop when idle, without prompt.answer, or with no stop at all", () => {
    for (const [t, o] of [
      [topic(IDLE), {}],
      [topic({ state: "blocked", since: null }), {}],
      [topic(WORKING), { stop: false as const }],
    ] as const) {
      const { unmount } = view(t, input(o).i);
      expect(stopButton()).toBeNull();
      expect(sendButton()).not.toBeNull();
      unmount();
    }
    const off = input();
    off.i.stop!.enabled = false;
    view(topic(WORKING), off.i);
    expect(stopButton()).toBeNull();
  });

  it("no Stop while a prompt card is open (the composer is locked)", () => {
    const card: Item = { id: "p", role: "prompt", at: null, prompt_id: "a".repeat(64), rev: "r", kind: "permission", title: "Do you want to proceed?", options: [{ label: "Yes" }, { label: "No" }], state: "open" };
    view(topic(WORKING, [card]), input().i);
    expect(stopButton()).toBeNull();
  });

  it("is disabled while the press runs, so a double tap sends once", async () => {
    let done!: (r: SendOutcome) => void;
    const { i, press } = input({ press: () => new Promise<SendOutcome>((r) => (done = r)) });
    view(topic(WORKING), i);
    const b = stopButton()!;
    await userEvent.click(b);
    expect(b).toBeDisabled();
    await userEvent.click(b);
    expect(press).toHaveBeenCalledTimes(1);
    await act(async () => done({ ok: true }));
  });

  it("says each refusal plainly and never presses again by itself", async () => {
    for (const [r, words] of [
      [{ ok: false, code: "not_working" }, "Agent 1 already stopped."],
      [{ ok: false, code: "prompt_open" }, "Answer the prompt above first"],
      [{ ok: false, code: "busy" }, "Another answer or Stop is running for Agent 1. Try again in a moment."],
      [{ ok: false, code: "desk_draft" }, "desk-1 has unsent text in Agent 1's box. Nothing was pressed."],
      [{ ok: false, code: "cooldown" }, "Agent 1 was just stopped. Try again in a few seconds."],
      [{ ok: false, code: "unknown_effect", unknown_effect: true }, "Agent 1 may have been stopped. Look before you stop it again."],
      [{ ok: false, code: "timeout", unknown_effect: true }, "Agent 1 may have been stopped. Look before you stop it again."],
      [{ ok: false, code: "forbidden" }, "Stop is off for this phone. Turn on Answer prompts in Remote on desk-1."],
    ] as const) {
      const { i, press } = input({ press: async () => r });
      const { unmount } = view(topic(WORKING), i);
      await userEvent.click(stopButton()!);
      expect(await screen.findByText(words)).toBeInTheDocument();
      expect(press).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("a press that throws is an unknown effect", async () => {
    const { i } = input({ press: () => Promise.reject(new Error("socket")) });
    view(topic(WORKING), i);
    await userEvent.click(stopButton()!);
    expect(await screen.findByText("Agent 1 may have been stopped. Look before you stop it again.")).toBeInTheDocument();
  });
});

describe("the stopped row (CV8)", () => {
  it('draws "Stopped by you · hh:mm" in the phone\'s local time, and nothing for the transcript marker as a bubble', () => {
    const at = "2026-11-13T21:14:00Z";
    const d = new Date(at);
    const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    view(topic(IDLE, [{ id: "m1", role: "you", at: null, text: "Split the parser" }, { id: "m2", role: "status", at, status: "stopped" }]), input().i);
    expect(screen.getByText(`Stopped by you · ${clock}`)).toBeInTheDocument();
  });

  it("without a time it says only Stopped by you", () => {
    expect(W.stoppedAt(null)).toBe("Stopped by you");
    expect(W.stoppedAt("not a date")).toBe("Stopped by you");
  });
});
