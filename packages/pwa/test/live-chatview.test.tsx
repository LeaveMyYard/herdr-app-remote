import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
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

async function open(agent: string) {
  window.location.hash = "#/agents";
  client = new BridgeClient({
    url: "wss://desk-1.example-tailnet.ts.net/api/v1/ws",
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    checkMe: async () => 200,
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
});
