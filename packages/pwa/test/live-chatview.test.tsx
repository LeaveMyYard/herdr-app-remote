import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge/client";
import { LiveApp } from "../src/LiveApp";
import { FakeSocket } from "./fake-socket";

// Fake data only. agent-1 is Claude (term-1), agent-2 is Codex (term-2).
const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const HOST = JSON.parse(readFileSync(resolve(FIX, "host/typical.json"), "utf8")) as unknown;
const TYPICAL = JSON.parse(readFileSync(resolve(FIX, "bridge-api/chatview/typical.json"), "utf8")) as Record<string, unknown>;

let sockets: FakeSocket[];
let client: BridgeClient;
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
const recv = (s: FakeSocket, m: unknown) => act(async () => s.recv(m));
const subs = (s: FakeSocket) => s.ofType("sub").flatMap((m) => m.topics as string[]);

async function open(agent: string, pruneMs = 10_000) {
  window.location.hash = "#/agents";
  client = new BridgeClient({
    url: "wss://desk-1.example-tailnet.ts.net/api/v1/ws",
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    checkMe: async () => 200,
    pruneMs,
  });
  client.start();
  render(<LiveApp client={client} hostName="desk-1" readHostName={async () => null} readTerminalInput={async () => ({ enabled: true, until: null, keys: { enabled: false, until: null } })} />);
  await flush();
  const s = sockets.at(-1)!;
  await act(async () => {
    s.open();
    s.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
  });
  await recv(s, { type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
  await act(async () => {
    window.location.hash = `#/chat/${agent}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await flush();
  return s;
}

beforeEach(() => {
  sockets = [];
});
afterEach(() => {
  client.stop();
  window.location.hash = "";
  vi.useRealTimers();
});

describe("LiveApp chat view", () => {
  it("subscribes chatview:<t> for a Claude agent, not the terminal text, and shows the chat when it arrives", async () => {
    const s = await open("agent-1");
    expect(subs(s)).toContain("chatview:term-1");
    expect(subs(s)).not.toContain("chat:term-1");
    expect(subs(s)).not.toContain("keys");
    expect(screen.queryByRole("log")).toBeNull();
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: { ...TYPICAL, terminal: "term-1" } });
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByText("Hello Agent 1. Please look at Project Alpha and run the tests.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Keys/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fit width" })).toBeNull();
  });

  it("keeps Codex on the text view with its notice, and never subscribes chatview", async () => {
    const s = await open("agent-2");
    expect(subs(s)).not.toContain("chatview:term-2");
    expect(subs(s)).toContain("chat:term-2");
    expect(screen.getByText("No chat view for Codex yet")).toBeInTheDocument();
  });

  it("falls back to the terminal with the reason's notice when the chat source is unavailable", async () => {
    const s = await open("agent-1");
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: { terminal: "term-1", harness: "claude", state: "unavailable", reason: "no_profiles", items: [], older: false, rev: "", status: { state: "idle", since: null } } });
    expect(screen.getByText("Chat view needs herdr-agent-usage")).toBeInTheDocument();
    expect(screen.getByText("Showing the terminal.")).toBeInTheDocument();
    expect(subs(s)).toContain("chat:term-1");
    expect(subs(s)).toContain("keys");
  });

  it("drops the history on forbidden (capability off) and says so", async () => {
    const s = await open("agent-1");
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: { ...TYPICAL, terminal: "term-1" } });
    expect(screen.getByText("Hello Agent 1. Please look at Project Alpha and run the tests.")).toBeInTheDocument();
    await recv(s, { type: "stale", topic: "chatview:term-1", reason: "forbidden" });
    expect(screen.queryByText("Hello Agent 1. Please look at Project Alpha and run the tests.")).toBeNull();
    expect(screen.getByText("Chat history is off for this phone")).toBeInTheDocument();
    expect(screen.getByText("Turn it on in Remote on desk-1.")).toBeInTheDocument();
  });

  it("with forbidden before any value, shows the same notice", async () => {
    const s = await open("agent-1");
    await recv(s, { type: "stale", topic: "chatview:term-1", reason: "forbidden" });
    expect(screen.getByText("Chat history is off for this phone")).toBeInTheDocument();
  });

  it("treats another stale reason with no value as the reader failing", async () => {
    const s = await open("agent-1");
    await recv(s, { type: "stale", topic: "chatview:term-1", reason: "audit_unavailable" });
    expect(screen.getByText("Can't read this agent's history right now")).toBeInTheDocument();
  });

  it("gives up waiting for the first value after a while and shows the terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = await open("agent-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(subs(s)).toContain("chat:term-1");
    expect(screen.getByText("Can't read this agent's history right now")).toBeInTheDocument();
  });

  it("keeps the terminal text and key menu subscribed while a draft holds the text view", async () => {
    const s = await open("agent-1", 40);
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: { terminal: "term-1", harness: "claude", state: "unavailable", reason: "reader_failed", items: [], older: false, rev: "", status: { state: "idle", since: null } } });
    await userEvent.type(screen.getByRole("textbox", { name: "Message to the agent" }), "half a thought");
    const before = { chat: subs(s).filter((t) => t === "chat:term-1").length, keys: subs(s).filter((t) => t === "keys").length };
    // The chat source comes up while the draft is open: the text view stays, and its topics stay wanted.
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 2, data: { ...TYPICAL, terminal: "term-1" } });
    expect(screen.getByRole("textbox", { name: "Message to the agent" })).toHaveValue("half a thought");
    expect(screen.getByRole("log", { name: "Terminal output" })).toBeInTheDocument();
    // Past the client's prune delay, a topic nobody wants would have been dropped and the socket replaced.
    await recv(s, { type: "snap", topic: "chat:term-1", epoch: "e1", seq: 1, data: { terminal: "term-1", lines: [[{ t: "still here" }]] } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(sockets).toHaveLength(1);
    expect(client.getSnapshot().topics["chat:term-1"]?.data).toBeDefined();
    expect(before).toEqual({ chat: 1, keys: 1 });
    // Clearing the draft moves the screen to the chat view.
    await userEvent.clear(screen.getByRole("textbox", { name: "Message to the agent" }));
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
  });

  it("clears a 403 on an older page when the topic brings a newer value", async () => {
    const s = await open("agent-1");
    const older = { ...TYPICAL, terminal: "term-1", older: true };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: older });
    await flush();
    expect(screen.getByText("Chat history is off for this phone")).toBeInTheDocument();
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 2, data: { ...older, older: false } });
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe("LiveApp prompt cards (CV7)", () => {
  it("draws a prompt card from chatview:<t> and sends prompt.answer through the socket", async () => {
    const PERM = JSON.parse(readFileSync(resolve(FIX, "bridge-api/chatview/prompt-permission.json"), "utf8")) as { items: { role: string; prompt_id?: string; rev?: string }[] };
    const s = await open("agent-1");
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: { ...PERM, terminal: "term-1" } });
    expect(screen.getByRole("region", { name: "Permission request" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^No/ }));
    await flush();
    const acts = s.ofType("act");
    const card = PERM.items.find((i) => i.role === "prompt")!;
    expect(acts).toContainEqual(expect.objectContaining({ kind: "prompt.answer", args: { terminal: "term-1", prompt_id: card.prompt_id, rev: card.rev, choice: { option: 3 } } }));
  });
});
