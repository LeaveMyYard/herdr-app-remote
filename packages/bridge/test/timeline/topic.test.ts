import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, bridgeApi, type HostState } from "@herdr-remote/protocol";
import type { BindResult, ClaudeMessage, ReadResult } from "../../src/claude/index.js";
import { ChatviewTopicDriver } from "../../src/chatview/topic.js";
import type { Contract } from "../../src/panorama/feed.js";
import type { Json } from "../../src/patch.js";
import { TimelineTopicDriver } from "../../src/timeline/topic.js";
import { join, newHub } from "../helpers.js";
import { hostState, mkFeed, root } from "../panorama/helpers.js";
import { SID, agent as said, oneDay, tool, user } from "../chatview/helpers.js";
import { alert, core, group, inbox, panorama } from "./helpers.js";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

const INBOX_TOOL = "mcp__plugin_herdr-inbox_herdr-inbox__ask_operator";

async function setup(o: { asks?: ReadonlySet<string> | null; ids?: Map<string, string>; host?: HostState } = {}) {
  const hub = newHub({ mayRead: () => true });
  hub.publish("host", (o.host ?? hostState()) as unknown as Json);
  const env = { asks: o.asks ?? null, ids: o.ids ?? new Map<string, string>(), invalid: [] as string[] };
  const drv = new TimelineTopicDriver({ hub, asks: () => env.asks, toolUseIdOf: (k) => env.ids.get(k), onInvalid: (_t, e) => env.invalid.push(e) });
  drv.start();
  stops.push(() => drv.stop());
  return { hub, drv, env };
}

describe("TimelineTopicDriver", () => {
  it("publishes only while subscribed, and follows the inbox and panorama topics", async () => {
    const { hub, drv } = await setup();
    hub.publish("inbox", inbox([group(1, core("t1"))]) as unknown as Json);
    expect(hub.get("timeline:t1")).toBeUndefined();
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["timeline:t1"] });
    expect(drv.activeTopics).toEqual(["timeline:t1"]);
    const v = () => hub.get("timeline:t1") as unknown as bridgeApi.TimelineTopic;
    expect(v().items.map((i) => i.key)).toEqual(["group:1"]);
    // A new row is patched in at once (same tick as the inbox publish), and the client's copy follows.
    hub.publish("inbox", inbox([group(1, core("t1")), alert(2, core("t1"))]) as unknown as Json);
    expect(v().items.map((i) => i.key)).toEqual(["alert:2", "group:1"]);
    hub.publish("panorama", panorama("t1", "agent-1", ["run"]) as unknown as Json);
    expect(v().strip.map((s) => s.label)).toEqual(["1 subagent"]);
    let held: unknown;
    for (const m of c.client.got) {
      if (m.type === "snap" && m.topic === "timeline:t1") held = m.data;
      if (m.type === "patch" && m.topic === "timeline:t1") held = applyPatch(held as Json, m.ops);
    }
    expect(held).toEqual(v());
    // Nobody looks: the value goes, and a later inbox change publishes nothing.
    hub.disconnect(c.conn);
    expect(drv.activeTopics).toEqual([]);
    hub.publish("inbox", inbox([]) as unknown as Json);
    expect(hub.get("timeline:t1")).toBeUndefined();
  });

  it("re-checks anchors when the terminal's chat view changes", async () => {
    const { hub, env } = await setup({ ids: new Map([["group:1", "toolu_1"]]) });
    hub.publish("inbox", inbox([group(1, core("t1"))]) as unknown as Json);
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["timeline:t1"] });
    const v = () => hub.get("timeline:t1") as unknown as bridgeApi.TimelineTopic;
    expect(v().items[0]!.anchor).toBe(null);
    env.asks = new Set(["toolu_1"]);
    // Another terminal's chat view changing is no reason to look again; this one's is.
    hub.publish("chatview:t2", { n: 1 });
    expect(v().items[0]!.anchor).toBe(null);
    hub.publish("chatview:t1", { n: 1 });
    expect(v().items[0]!.anchor).toEqual({ tool_use_id: "toolu_1" });
  });

  it("goes stale on a bad terminal id", async () => {
    const { hub } = await setup();
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["timeline:../x"] });
    expect(hub.isStale("timeline:../x")).toBe("bad_terminal");
  });
});

// End to end: the anchor comes from the chat view the bridge itself read for the terminal.
class History {
  messages: ClaudeMessage[] = [];
  bind(): Promise<BindResult> {
    return Promise.resolve({ ok: true, binding: { sessionId: SID, root: { configDir: "/work/c", projects: "/work/c/projects", profileIds: ["p"] }, via: "transcript" } });
  }
  read(): Promise<ReadResult> {
    return Promise.resolve({ ok: true, messages: this.messages, stats: { total: this.messages.length, failed: 0, droppedBlocks: 0, droppedMessages: 0 } });
  }
}

describe("anchors through the chat view (asker's own transcript only)", () => {
  async function both(messages: ClaudeMessage[]) {
    const h = hostState();
    const host: HostState = { ...h, agents: h.agents.map((a) => (a.id === "agent-1" ? { ...a, program: "claude" } : a)) };
    const hub = newHub({ mayRead: () => true });
    hub.publish("host", host as unknown as Json);
    const history = new History();
    history.messages = messages;
    const transcript = `/work/c/projects/-w/${SID}.jsonl`;
    const feed = { view: { feed: mkFeed([root({ terminal: "t1", harness: "claude", session_id: SID, transcript, cwd: "/w" })]), stale: false, aged: false, error: null }, contract: {} as Contract, at: Date.now() };
    const chatview = new ChatviewTopicDriver({ hub, history, feed: () => ({ ...feed, at: Date.now() }), intervalMs: 1e9, stat: () => Promise.resolve({ size: 10, mtimeMs: 1 }), map: oneDay });
    const ids = new Map([["group:1", "toolu_1"]]);
    const timeline = new TimelineTopicDriver({ hub, asks: (t) => chatview.inboxAsks(t), toolUseIdOf: (k) => ids.get(k) });
    chatview.start();
    timeline.start();
    stops.push(() => {
      timeline.stop();
      chatview.stop();
    });
    hub.publish("inbox", inbox([group(1, core("t1"))]) as unknown as Json);
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["timeline:t1", "chatview:t1"] });
    await chatview.settled("chatview:t1");
    return { hub, chat: () => hub.get("chatview:t1") as unknown as bridgeApi.ChatviewTopic, tl: () => hub.get("timeline:t1") as unknown as bridgeApi.TimelineTopic };
  }

  it("anchors the question on the ask_operator call that carries its id, and the chat item names that id", async () => {
    const { chat, tl } = await both([user(1, "Go"), said(2, [tool("toolu_1", INBOX_TOOL, { question: "?" })])]);
    expect(chat().items.find((i) => i.role === "ask")).toMatchObject({ ask: { via: "inbox" }, tool_use_id: "toolu_1" });
    expect(tl().items[0]!.anchor).toEqual({ tool_use_id: "toolu_1" });
  });

  it("does not anchor on another tool's call with that id", async () => {
    const { chat, tl } = await both([user(1, "Go"), said(2, [tool("toolu_1", "Bash", { command: "ls" })])]);
    expect(chat().items.some((i) => i.role === "ask")).toBe(false);
    expect(tl().items[0]!.anchor).toBe(null);
  });

  it("does not anchor on an ask_operator call of another id", async () => {
    const { tl } = await both([user(1, "Go"), said(2, [tool("toolu_2", INBOX_TOOL, {})])]);
    expect(tl().items[0]!.anchor).toBe(null);
  });
});
