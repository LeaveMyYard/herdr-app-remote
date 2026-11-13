// The prompt card in `chatview:<t>` (CV7, §3a.2): only when T, S and V agree.
import { afterEach, describe, expect, it } from "vitest";
import { bridgeApi, type HostState } from "@herdr-remote/protocol";
import type { BindResult, ClaudeMessage, ReadResult } from "../../src/claude/index.js";
import { ChatviewTopicDriver, type FeedSnapshot, type StatResult } from "../../src/chatview/topic.js";
import type { Contract, FeedRoot } from "../../src/panorama/feed.js";
import type { Json } from "../../src/patch.js";
import { join, newHub } from "../helpers.js";
import { hostState, mkFeed, root } from "../panorama/helpers.js";
import { SID, agent, oneDay, tool, user } from "../chatview/helpers.js";
import { ASK1, BASH, IDLE, screen } from "./helpers.js";

const TRANSCRIPT = `/work/claude-1/projects/-work-project-alpha/${SID}.jsonl`;
const TOPIC = "chatview:t1";
const claudeRoot = (): FeedRoot => root({ terminal: "t1", harness: "claude", session_id: SID, transcript: TRANSCRIPT, cwd: "/work/project-alpha" });
const host = (state: HostState["agents"][number]["state"]): HostState => {
  const h = hostState();
  return { ...h, agents: h.agents.map((a) => (a.id === "agent-1" ? { ...a, program: "claude", state } : a)) };
};

class FakeHistory {
  messages: ClaudeMessage[] = [];
  bind(): Promise<BindResult> {
    return Promise.resolve({ ok: true, binding: { sessionId: SID, root: { configDir: "/work/claude-1", projects: "/work/claude-1/projects", profileIds: ["a"] }, via: "transcript" } });
  }
  read(): Promise<ReadResult> {
    return Promise.resolve({ ok: true, messages: this.messages, stats: { total: this.messages.length, failed: 0, droppedBlocks: 0, droppedMessages: 0 } });
  }
}

const drivers: ChatviewTopicDriver[] = [];
/** The feed's root for t1; a test can swap it (another session) without a look. */
let feedRoot = claudeRoot;
afterEach(() => {
  feedRoot = claudeRoot;
  for (const d of drivers.splice(0)) d.stop();
});

async function setup(state: HostState["agents"][number]["state"], messages: ClaudeMessage[], scr: string | null) {
  const hub = newHub({ mayRead: () => true });
  hub.publish("host", host(state) as unknown as Json);
  const history = new FakeHistory();
  history.messages = messages;
  const env = { screen: scr, reads: 0, stat: { size: 100, mtimeMs: 1 } as StatResult };
  const drv = new ChatviewTopicDriver({
    hub,
    history,
    feed: (): FeedSnapshot => ({ view: { feed: mkFeed([feedRoot()]), stale: false, aged: false, error: null }, contract: {} as Contract, at: 1_000_000 }),
    intervalMs: 1e9,
    now: () => 1_000_000,
    stat: () => Promise.resolve(env.stat),
    map: oneDay,
    prompts: {
      read: (t) => {
        expect(t).toBe("t1");
        env.reads += 1;
        return Promise.resolve(env.screen);
      },
      revKey: Buffer.alloc(32, 7),
    },
  });
  drivers.push(drv);
  drv.start();
  const c = await join(hub);
  await c.send({ type: "sub", topics: [TOPIC] });
  await drv.settled(TOPIC);
  const value = () => hub.get(TOPIC) as unknown as bridgeApi.ChatviewTopic;
  const card = () => value().items.find((i) => i.role === "prompt") as Extract<bridgeApi.ChatItem, { role: "prompt" }> | undefined;
  return { hub, drv, env, history, value, card, poll: () => drv.poll(TOPIC) };
}

const askTurn = [user(1, "Split the parser"), agent(2, [tool(ASK1.id, "AskUserQuestion", ASK1.input)])];
const bashTurn = [user(1, "Run the tests"), agent(2, [tool(BASH.id, "Bash", BASH.input)])];

describe("chatview prompt cards", () => {
  it("T + S + V: the card is last, and replaces the call's ask item", async () => {
    const { value, card } = await setup("waiting", askTurn, screen("ask-single"));
    const v = value();
    expect(bridgeApi.ChatviewTopic.safeParse(v).success).toBe(true);
    expect(v.items[v.items.length - 1]!.role).toBe("prompt");
    expect(v.items.some((i) => i.role === "ask")).toBe(false);
    expect(card()!.kind).toBe("question");
    expect(card()!.state).toBe("open");
  });

  it("not blocked (S): no card and no screen read", async () => {
    const { card, env, value } = await setup("working", askTurn, screen("ask-single"));
    expect(card()).toBeUndefined();
    expect(env.reads).toBe(0);
    expect(value().items.some((i) => i.role === "ask")).toBe(true);
  });

  it("the screen can't be read: no card", async () => {
    const { card } = await setup("waiting", bashTurn, null);
    expect(card()).toBeUndefined();
  });

  it("a screen that doesn't match the pending call: read-only lines", async () => {
    const { card } = await setup("waiting", bashTurn, screen("ask-single"));
    expect(card()!.kind).toBe("unparsed");
    expect(card()!.options).toEqual([]);
    expect(card()!.screen_lines!.length).toBeGreaterThan(0);
  });

  it("the card goes when the agent is no longer blocked, and the rev is stable between looks", async () => {
    const { card, poll, hub } = await setup("waiting", bashTurn, screen("permission"));
    const first = card()!;
    await poll();
    expect(card()!.rev).toBe(first.rev);
    hub.publish("host", host("working") as unknown as Json);
    await poll();
    expect(card()).toBeUndefined();
  });

  it("the prompt source: current card, fresh T and S, and answered drops the card until the screen changes", async () => {
    const { drv, card, env, poll } = await setup("waiting", bashTurn, screen("permission"));
    const cur = drv.promptSource.current("t1")!;
    expect(cur.match.promptId).toBe(card()!.prompt_id);
    expect(cur.rev).toBe(card()!.rev);
    const f = await drv.promptSource.fresh("t1");
    expect(f).toEqual({ pending: [{ id: BASH.id, name: "Bash", input: BASH.input, at: expect.any(String) }], blocked: true });
    drv.promptSource.answered("t1", cur.match.promptId);
    expect(card()).toBeUndefined();
    expect(drv.promptSource.isAnswered("t1", cur.match.promptId)).toBe(true);
    await drv.settled(TOPIC);
    // Still on screen (the desk hasn't redrawn yet): not published again.
    await poll();
    expect(card()).toBeUndefined();
    env.screen = IDLE;
    await poll();
    expect(card()!.kind).toBe("unparsed");
    // The screen showed no prompt: the same dialog asked again is a new card (review L4), and no longer "answered".
    expect(drv.promptSource.isAnswered("t1", cur.match.promptId)).toBe(false);
    env.screen = screen("permission");
    await poll();
    expect(card()!.prompt_id).toBe(cur.match.promptId);
  });

  it("no prompts option: never a card", async () => {
    const hub = newHub({ mayRead: () => true });
    hub.publish("host", host("waiting") as unknown as Json);
    const h = new FakeHistory();
    h.messages = bashTurn;
    const drv = new ChatviewTopicDriver({
      hub,
      history: h,
      feed: () => ({ view: { feed: mkFeed([claudeRoot()]), stale: false, aged: false, error: null }, contract: {} as Contract, at: 1_000_000 }),
      intervalMs: 1e9,
      now: () => 1_000_000,
      stat: () => Promise.resolve({ size: 1, mtimeMs: 1 }),
    });
    drivers.push(drv);
    drv.start();
    const c = await join(hub);
    await c.send({ type: "sub", topics: [TOPIC] });
    await drv.settled(TOPIC);
    expect((hub.get(TOPIC) as unknown as bridgeApi.ChatviewTopic).items.some((i) => i.role === "prompt")).toBe(false);
  });
});

describe("Stop's view of the chat view (CV8)", () => {
  it("the host's state only for an open, good chat view; a published card shows", async () => {
    const working = await setup("working", bashTurn, null);
    expect(working.drv.stopSource.state("t1")).toEqual({ working: true, blocked: false });
    expect(working.drv.stopSource.hasCard("t1")).toBe(false);
    // Another terminal has no open chat view.
    expect(working.drv.stopSource.state("t2")).toBeNull();
    const blocked = await setup("waiting", bashTurn, screen("permission"));
    expect(blocked.drv.stopSource.state("t1")).toEqual({ working: false, blocked: true });
    expect(blocked.drv.stopSource.hasCard("t1")).toBe(true);
    const idle = await setup("idle", bashTurn, IDLE);
    expect(idle.drv.stopSource.state("t1")).toEqual({ working: false, blocked: false });
  });

  it("is null once the binding is gone (the host no longer has the agent there)", async () => {
    const { hub, drv } = await setup("working", bashTurn, null);
    const h = hostState();
    hub.publish("host", { ...h, agents: h.agents.filter((a) => a.id !== "agent-1") } as unknown as Json);
    expect(drv.stopSource.state("t1")).toBeNull();
  });

  it("is null when the terminal now runs another Claude session than the one the chat view holds (final pass L1)", async () => {
    const { drv } = await setup("working", bashTurn, null);
    expect(drv.stopSource.state("t1")).toEqual({ working: true, blocked: false });
    feedRoot = () => root({ terminal: "t1", harness: "claude", session_id: "22222222-2222-4222-8222-222222222222", transcript: TRANSCRIPT, cwd: "/work/project-alpha" });
    expect(drv.stopSource.state("t1")).toBeNull();
  });

  it("is null while the chat view is not good (reader_failed), though the host still says working (final pass L2)", async () => {
    const { drv, history, env, value, poll } = await setup("working", bashTurn, null);
    history.read = () => Promise.resolve({ ok: false, reason: "reader_failed", detail: "shape" });
    env.stat = { size: 200, mtimeMs: 2 };
    await poll();
    expect(value().state).toBe("unavailable");
    expect(drv.stopSource.state("t1")).toBeNull();
  });
});
