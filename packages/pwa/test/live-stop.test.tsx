import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge/client";
import { LiveApp } from "../src/LiveApp";
import { FakeSocket } from "./fake-socket";

// CV8: Stop through the live app (LiveApp wiring). Fake data only. agent-1 is Claude (term-1).
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

async function open(agent: string, prompts: boolean, pruneMs = 10_000) {
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
  render(<LiveApp client={client} hostName="desk-1" readHostName={async () => null} readTerminalInput={async () => ({ enabled: true, until: null, keys: { enabled: false, until: null }, prompts: { enabled: prompts, until: null } })} />);
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
});

const working = { ...TYPICAL, terminal: "term-1", status: { state: "working", since: "2026-01-02T10:00:00.000Z" } };

describe("LiveApp Stop (CV8)", () => {
  it("with prompt.answer on, a working agent's composer has Stop, and a press sends agent.stop once with the terminal only", async () => {
    const s = await open("agent-1", true);
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: working });
    await userEvent.click(screen.getByRole("button", { name: "Stop Agent 1" }));
    await flush();
    const acts = s.ofType("act").filter((a) => a.kind === "agent.stop");
    expect(acts).toHaveLength(1);
    expect(acts[0]!.args).toEqual({ terminal: "term-1" });
    // An unknown effect: never pressed again, the chat view is read again.
    const before = s.sent.length;
    await recv(s, { type: "res", id: acts[0]!.id, ok: false, code: "unknown_effect", unknown_effect: true });
    await flush();
    expect(screen.getByText("Agent 1 may have been stopped. Look before you stop it again.")).toBeInTheDocument();
    expect(s.ofType("act").filter((a) => a.kind === "agent.stop")).toHaveLength(1);
    expect(s.sent.length).toBeGreaterThan(before);
  });

  it("with prompt.answer off there is no Stop, only Send", async () => {
    const s = await open("agent-1", false);
    await recv(s, { type: "snap", topic: "chatview:term-1", epoch: "e1", seq: 1, data: working });
    expect(screen.queryByRole("button", { name: "Stop Agent 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
