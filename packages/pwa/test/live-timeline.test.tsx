import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge/client";
import { ROW_ARM_MS } from "../src/inbox/arm";
import { LiveApp } from "../src/LiveApp";
import { FakeSocket } from "./fake-socket";

// CV5b: `timeline:<t>` in the live chat view. Fake data only. agent-1 is Claude (term-1), agent-2 is Codex (term-2).
const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const read = (p: string) => JSON.parse(readFileSync(resolve(FIX, p), "utf8")) as Record<string, unknown>;
const HOST = read("host/typical.json");
/** HOST plus a second Claude agent (agent-3 on term-3). */
const HOST2 = {
  ...HOST,
  agents: [...(HOST.agents as unknown[]), { id: "agent-3", name: "Agent 3", harness: "claude", state: "working", space_id: "space-1", terminal_id: "term-3" }],
  terminals: [...(HOST.terminals as unknown[]), { id: "term-3", title: "Agent 3", space_id: "space-1", cols: 120, rows: 40 }],
  panes: [...(HOST.panes as unknown[]), { id: "pane-4", space_id: "space-1", terminal_id: "term-3", kind: "terminal" }],
};
const CHAT: Record<string, unknown> = { ...read("bridge-api/chatview/typical.json"), terminal: "term-1" };
const TIMELINE = read("bridge-api/timeline/typical.json");
const FIRST_YOU = "Hello Agent 1. Please look at Project Alpha and run the tests.";
const LAST_AGENT = "Going with Option B.";

let sockets: FakeSocket[];
let client: BridgeClient;
let clock = 0;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
const recv = (s: FakeSocket, m: unknown) => act(async () => s.recv(m));
const subs = (s: FakeSocket) => s.ofType("sub").flatMap((m) => m.topics as string[]);
const snap = (s: FakeSocket, topic: string, seq: number, data: unknown) => recv(s, { type: "snap", topic, epoch: "e1", seq, data });
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
};
/** Past the rows' arm delay (the inbox's ROW_ARM), on the clock `useArmed` reads. */
const armed = async () => {
  clock += ROW_ARM_MS + 1;
  await flush();
};

async function open(agent: string, pruneMs = 10_000, host: unknown = HOST) {
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
  await snap(s, "host", 1, host);
  await go(`#/chat/${agent}`);
  return s;
}
const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await flush();
};
/** The conversation's rows in document order: chat item text or a timeline row's `data-key`. */
const order = () =>
  [...screen.getByRole("log", { name: "Conversation" }).querySelectorAll(".cv-item")].map((el) => {
    const key = el.querySelector("[data-key]")?.getAttribute("data-key");
    return key ?? el.textContent ?? "";
  });

beforeEach(() => {
  sockets = [];
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  client.stop();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LiveApp timeline: subscription", () => {
  it("wants timeline:<t> with chatview:<t> for a Claude agent", async () => {
    const s = await open("agent-1");
    expect(subs(s)).toContain("chatview:term-1");
    expect(subs(s)).toContain("timeline:term-1");
  });

  it("never wants it for Codex (no chat view there)", async () => {
    const s = await open("agent-2");
    expect(subs(s).some((t) => t.startsWith("timeline:"))).toBe(false);
  });

  it("gives it up when the chat is left: past the prune delay the new socket subscribes neither chat topic", async () => {
    const s = await open("agent-1", 40);
    await snap(s, "chatview:term-1", 1, CHAT);
    await snap(s, "timeline:term-1", 1, TIMELINE);
    expect(screen.getByText("6 subagents")).toBeInTheDocument();
    await go("#/agents");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(sockets.length).toBeGreaterThan(1);
    const next = sockets.at(-1)!;
    await act(async () => {
      next.open();
      next.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
    });
    await flush();
    const hello = next.ofType("hello")[0]!;
    const resumed = Object.keys(((hello.resume as { seqs?: Record<string, number> } | undefined)?.seqs ?? {}) as Record<string, number>);
    expect(resumed).not.toContain("timeline:term-1");
    expect(subs(next)).not.toContain("timeline:term-1");
    expect(subs(next)).not.toContain("chatview:term-1");
    expect(client.getSnapshot().topics["timeline:term-1"]).toBeUndefined();
  });

  it("follows the open agent: another Claude chat would want its own terminal's timeline only", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, CHAT);
    // A value for another terminal under this name is not drawn.
    await snap(s, "timeline:term-1", 1, { ...TIMELINE, terminal: "term-9" });
    expect(screen.getByText(FIRST_YOU)).toBeInTheDocument();
    expect(screen.queryByText("6 subagents")).toBeNull();
    expect(document.querySelector("[data-timeline]")).toBeNull();
  });
});

describe("LiveApp timeline: two Claude terminals", () => {
  it("moving to another Claude agent gives up the first timeline and wants the second, and draws only its own", async () => {
    const s = await open("agent-1", 40, HOST2);
    await snap(s, "chatview:term-1", 1, CHAT);
    await snap(s, "timeline:term-1", 1, TIMELINE);
    expect(screen.getByText("6 subagents")).toBeInTheDocument();
    await go("#/chat/agent-3");
    expect(subs(s)).toContain("timeline:term-3");
    expect(subs(s)).toContain("chatview:term-3");
    // term-1's timeline is still held by the client until the prune, but it is not term-3's: nothing is drawn.
    await snap(s, "chatview:term-3", 1, { ...CHAT, terminal: "term-3" });
    expect(screen.queryByText("6 subagents")).toBeNull();
    await snap(s, "timeline:term-3", 1, { ...TIMELINE, terminal: "term-3", strip: [], items: [] });
    expect(document.querySelector("[data-timeline]")).toBeNull();
    // Past the prune delay the socket is replaced and only term-3's topics are asked for again.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const next = sockets.at(-1)!;
    expect(next).not.toBe(s);
    await act(async () => {
      next.open();
      next.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
    });
    await flush();
    expect(subs(next)).toContain("timeline:term-3");
    expect(subs(next)).not.toContain("timeline:term-1");
  });
});

describe("LiveApp timeline: the text view (Claude, chat source unavailable)", () => {
  it("draws the strip with Aa on its row, not in the header", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, { terminal: "term-1", harness: "claude", state: "unavailable", reason: "reader_failed", items: [], older: false, rev: "", status: { state: "idle", since: null } });
    await snap(s, "timeline:term-1", 1, TIMELINE);
    const strip = document.querySelector(".tl-strip") as HTMLElement;
    expect(within(strip).getByRole("button", { name: "Fit width" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fit width" })).toHaveLength(1);
    expect(document.querySelector(".chat-head .chat-fit")).toBeNull();
  });

  it("keeps Aa in the header when the strip is empty", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, { terminal: "term-1", harness: "claude", state: "unavailable", reason: "reader_failed", items: [], older: false, rev: "", status: { state: "idle", since: null } });
    await snap(s, "timeline:term-1", 1, { ...TIMELINE, strip: [] });
    expect(document.querySelector(".tl-strip")).toBeNull();
    expect(document.querySelector(".chat-head .chat-fit")).not.toBeNull();
  });
});

describe("LiveApp timeline: placement", () => {
  it("draws the strip under the header and places each item among the chat items by time", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, CHAT);
    await snap(s, "timeline:term-1", 1, TIMELINE);
    // The strip: subagents and the pane's account chip, between the header and the conversation.
    const strip = document.querySelector(".tl-strip")!;
    expect(within(strip as HTMLElement).getByText("6 subagents")).toBeInTheDocument();
    expect(within(strip as HTMLElement).getByText("Account 2")).toBeInTheDocument();
    expect(strip.previousElementSibling?.classList.contains("chat-head")).toBe(true);
    expect(strip.nextElementSibling?.contains(screen.getByRole("log", { name: "Conversation" }))).toBe(true);
    // failed:119 (10:00:00) is older than every chat item: first. The alert (11:00) and the question (12:00) are
    // newer than all: after the last reply, in time order.
    const rows = order();
    expect(rows[0]).toBe("failed:119");
    const last = rows.findIndex((r) => r.includes(LAST_AGENT));
    expect(rows.slice(last + 1)).toEqual(["alert:456", "group:123"]);
    expect(rows.indexOf("failed:119")).toBeLessThan(rows.findIndex((r) => r.includes(FIRST_YOU)));
  });

  it("draws an anchored question instead of the inbox ask with that tool_use_id", async () => {
    const s = await open("agent-1");
    const items = [
      ...(CHAT.items as unknown[]),
      { id: "b1000000-0000-4000-8000-000000000001", role: "ask", at: "2026-01-02T10:02:00.000Z", ask: { via: "inbox", question: null, header: null, multi: false, options: [] }, tool_use_id: "toolu_01FakeAskOperator123" },
      { id: "b1000000-0000-4000-8000-000000000002", role: "agent", at: "2026-01-02T10:03:00.000Z", text: "After the question." },
    ];
    await snap(s, "chatview:term-1", 1, { ...CHAT, items });
    await snap(s, "timeline:term-1", 1, TIMELINE);
    expect(screen.queryByText("Asked you a question")).toBeNull();
    const rows = order();
    expect(rows.indexOf("group:123")).toBe(rows.findIndex((r) => r.includes("After the question.")) - 1);
  });

  it("with no chat items yet, still shows every item", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, { ...CHAT, items: [] });
    await snap(s, "timeline:term-1", 1, TIMELINE);
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect([...document.querySelectorAll("[data-timeline]")].map((e) => e.getAttribute("data-timeline"))).toEqual(["inbox.failed", "inbox.alert", "inbox.question"]);
  });
});

describe("LiveApp timeline: refused or unavailable", () => {
  it("refused before any value: the chat works, with no strip and no rows", async () => {
    const s = await open("agent-1");
    await recv(s, { type: "stale", topic: "timeline:term-1", reason: "forbidden" });
    await snap(s, "chatview:term-1", 1, CHAT);
    expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByText(FIRST_YOU)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Message/ })).toBeInTheDocument();
    expect(document.querySelector(".tl-strip")).toBeNull();
  });

  it("refused after a value: the strip and rows go, the chat stays", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, CHAT);
    await snap(s, "timeline:term-1", 1, TIMELINE);
    expect(document.querySelectorAll("[data-timeline]")).toHaveLength(3);
    await recv(s, { type: "stale", topic: "timeline:term-1", reason: "forbidden" });
    expect(document.querySelector(".tl-strip")).toBeNull();
    expect(document.querySelector("[data-timeline]")).toBeNull();
    expect(screen.getByText(FIRST_YOU)).toBeInTheDocument();
  });

  it("a value the phone can't read is dropped; the chat stays", async () => {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, CHAT);
    await snap(s, "timeline:term-1", 1, { terminal: "term-1", items: "nope" });
    expect(screen.getByText(FIRST_YOU)).toBeInTheDocument();
    expect(document.querySelector(".tl-strip")).toBeNull();
  });

  it("goes with the chat history when an older page is refused (403)", async () => {
    const s = await open("agent-1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await snap(s, "timeline:term-1", 1, TIMELINE);
    await snap(s, "chatview:term-1", 1, { ...CHAT, older: true });
    await flush();
    expect(screen.getByText("Chat history is off for this phone")).toBeInTheDocument();
    expect(document.querySelector(".tl-strip")).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("LiveApp timeline: acts go through the inbox's own path", () => {
  async function ready() {
    const s = await open("agent-1");
    await snap(s, "chatview:term-1", 1, CHAT);
    await snap(s, "timeline:term-1", 1, TIMELINE);
    return s;
  }
  const acts = (s: FakeSocket) => s.ofType("act").map((m) => ({ kind: m.kind, args: m.args }));

  it("Retry sends inbox.retry for the row's key and rev, once armed, one at a time", async () => {
    const s = await ready();
    const retry = screen.getByRole("button", { name: "Retry delivery" });
    // Before the row's arm delay a tap is dropped.
    await tap(retry);
    expect(acts(s)).toEqual([]);
    await armed();
    await tap(retry);
    await tap(retry);
    expect(acts(s)).toEqual([{ kind: "inbox.retry", args: { key: "failed:119", rev: "rev-f119" } }]);
  });

  it("Seen sends inbox.ack; an unknown effect reads the inbox again and sends nothing more", async () => {
    const s = await ready();
    await armed();
    await tap(screen.getByRole("button", { name: "Seen" }));
    const sent = s.ofType("act")[0]!;
    expect({ kind: sent.kind, args: sent.args }).toEqual({ kind: "inbox.ack", args: { key: "alert:456", rev: "rev-a456" } });
    const before = subs(s).filter((t) => t === "inbox").length;
    await recv(s, { type: "res", id: sent.id, ok: false, code: "timeout", unknown_effect: true });
    await flush();
    expect(subs(s).filter((t) => t === "inbox").length).toBe(before + 1);
    expect(s.ofType("act")).toHaveLength(1);
  });

  it("an option answers the lone question with inbox.answer, as the Question screen sends it", async () => {
    const s = await ready();
    await armed();
    const q = screen.getByRole("region", { name: "Question Q123" });
    await tap(within(q).getByRole("button", { name: /Option A/ }));
    expect(acts(s)).toEqual([{ kind: "inbox.answer", args: { key: "group:123", rev: "rev-g123", question: 123, detail: { choices: [0], notes: {}, text: null } } }]);
  });

  it("Dismiss asks first, then sends inbox.dismiss", async () => {
    const s = await ready();
    await armed();
    const q = screen.getByRole("region", { name: "Question Q123" });
    await tap(within(q).getByRole("button", { name: "Dismiss" }));
    await armed();
    await tap(within(q).getByRole("button", { name: "Dismiss" }));
    expect(acts(s)).toEqual([{ kind: "inbox.dismiss", args: { key: "group:123", rev: "rev-g123" } }]);
  });
});
