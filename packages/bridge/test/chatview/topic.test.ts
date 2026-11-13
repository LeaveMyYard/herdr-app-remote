import { afterEach, describe, expect, it } from "vitest";
import { applyPatch, bridgeApi, type HostState } from "@herdr-remote/protocol";
import type { BindResult, ClaudeMessage, ProvedSession, ReadResult } from "../../src/claude/index.js";
import { ChatviewTopicDriver, continues, resolve, statOnly, windowOps, type FeedSnapshot, type StatResult } from "../../src/chatview/topic.js";
import type { Contract, FeedRoot, FeedView } from "../../src/panorama/feed.js";
import type { Json } from "../../src/patch.js";
import { join, newHub } from "../helpers.js";
import { hostState, mkFeed, root } from "../panorama/helpers.js";
import { AT, SID, U, agent, oneDay, result, tool, user } from "./helpers.js";

const SID2 = "22222222-2222-4222-8222-222222222222";
const TRANSCRIPT = `/work/claude-1/projects/-work-project-alpha/${SID}.jsonl`;
const CONFIG = "/work/claude-1";
const TOPIC = "chatview:t1";
const CONTRACT = {} as Contract;

const claudeRoot = (over: Partial<FeedRoot> = {}): FeedRoot => root({ terminal: "t1", harness: "claude", session_id: SID, transcript: TRANSCRIPT, cwd: "/work/project-alpha", ...over });
/** Read "now" by default (`at` is the resolve tests' NOW; setup's feed stamps its own clock unless `at` is pinned). */
const NOW = 1_000_000;
const view = (roots: FeedRoot[] = [claudeRoot()], over: Partial<FeedView> = {}, at?: number): FeedSnapshot & { pinned?: boolean } => ({
  view: { feed: mkFeed(roots), stale: false, aged: false, error: null, ...over },
  contract: CONTRACT,
  at: at ?? NOW,
  ...(at !== undefined ? { pinned: true } : {}),
});
const host = (over: Partial<HostState> = {}, agent1: Partial<HostState["agents"][number]> = {}): HostState => {
  const h = hostState(over);
  return { ...h, agents: h.agents.map((a) => (a.id === "agent-1" ? { ...a, program: "claude", ...agent1 } : a)) };
};

class FakeHistory {
  binds: ProvedSession[] = [];
  reads = 0;
  bindResult: BindResult = { ok: true, binding: { sessionId: SID, root: { configDir: CONFIG, projects: `${CONFIG}/projects`, profileIds: ["agent-1"] }, via: "transcript" } };
  messages: ClaudeMessage[] = [user(1, "Hello Agent 1"), agent(2, "Hi.")];
  readResult: ReadResult | undefined;
  bind(s: ProvedSession): Promise<BindResult> {
    this.binds.push(s);
    return Promise.resolve(this.bindResult.ok ? { ok: true, binding: { ...this.bindResult.binding, sessionId: s.sessionId } } : this.bindResult);
  }
  read(): Promise<ReadResult> {
    this.reads += 1;
    return Promise.resolve(this.readResult ?? { ok: true, messages: this.messages, stats: { total: this.messages.length, failed: 0, droppedBlocks: 0, droppedMessages: 0 } });
  }
}

const drivers: ChatviewTopicDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.stop();
});

async function setup(o: { host?: HostState; feed?: ReturnType<typeof view> | undefined; history?: FakeHistory | null; topic?: string } = {}) {
  const hub = newHub({ mayRead: () => true });
  hub.publish("host", (o.host ?? host()) as unknown as Json);
  const history = o.history === undefined ? new FakeHistory() : o.history;
  const env = {
    feed: "feed" in o ? o.feed : view(),
    stat: { size: 100, mtimeMs: 1 } as StatResult,
    statCalls: [] as string[],
    clock: 1_000_000,
  };
  const drv = new ChatviewTopicDriver({
    hub,
    history,
    feed: () => (env.feed && !env.feed.pinned ? { ...env.feed, at: env.clock } : env.feed),
    intervalMs: 1e9,
    retryMs: 5_000,
    now: () => env.clock,
    stat: (p) => {
      env.statCalls.push(p);
      return Promise.resolve(env.stat);
    },
    map: oneDay,
  });
  drivers.push(drv);
  drv.start();
  const topic = o.topic ?? TOPIC;
  const c = await join(hub);
  await c.send({ type: "sub", topics: [topic] });
  await drv.settled(topic);
  const value = () => hub.get(topic) as unknown as bridgeApi.ChatviewTopic;
  return { hub, drv, history, env, client: c.client, conn: c.conn, value, poll: () => drv.poll(topic) };
}

const itemIds = (t: bridgeApi.ChatviewTopic) => t.items.filter((i) => !(i.role === "divider" && i.divider === "day")).map((i) => i.id);

describe("resolve: only panorama's proved join (§2.1, §6)", () => {
  const ok = resolve("t1", host(), view(), NOW);
  it("binds the exact terminal's root to its live agent", () => {
    expect(ok).toEqual({ ok: true, harness: "claude", session: { sessionId: SID, transcript: TRANSCRIPT, cwd: "/work/project-alpha" }, agentState: "working" });
  });

  it.each([
    ["host says codex (no panorama needed)", host({ shared: { "panorama.feed.owner": null } }, { program: "codex" }), view(), "harness", "codex"],
    ["the root's harness is codex", host({}, { program: undefined }), view([claudeRoot({ harness: "codex" })]), "harness", "codex"],
    ["no lease owner (basic mode)", host({ shared: { "panorama.feed.owner": null } }), view(), "no_panorama", "claude"],
    ["no feed", host(), undefined, "no_panorama", "claude"],
    ["no verified contract", host(), { ...view(), contract: undefined }, "no_panorama", "claude"],
    ["an aged feed", host(), view(undefined, { aged: true, stale: true }), "no_binding", "claude"],
    ["a stale feed (failed read)", host(), view(undefined, { stale: true, error: "feed invalid" }), "no_binding", "claude"],
    ["no root at the address", host(), view([claudeRoot({ terminal: "t9" })]), "no_binding", "claude"],
    ["two roots at the address", host(), view([claudeRoot(), claudeRoot({ pane_id: "core:t1b" })]), "no_binding", "claude"],
    ["a root of another host", host(), view([claudeRoot({ host: "vps" })]), "no_binding", "claude"],
    ["no live agent at the address", host({ agents: [] }), view(), "no_binding", "claude"],
    ["two live agents at the address", host({ agents: [hostState().agents[0]!, { ...hostState().agents[0]!, id: "agent-9" }] }), view(), "no_binding", "claude"],
    ["no session id", host(), view([claudeRoot({ session_id: null })]), "no_binding", "claude"],
    ["a session id that is not a uuid", host(), view([claudeRoot({ session_id: "../../etc" })]), "no_binding", "claude"],
    ["no transcript", host(), view([claudeRoot({ transcript: null })]), "no_binding", "claude"],
    ["a relative transcript", host(), view([claudeRoot({ transcript: "x.jsonl" })]), "no_binding", "claude"],
    ["no host topic", undefined, view(), "no_binding", "unknown"],
  ] as const)("%s: %s", (_name, h, fv, reason, harness) => {
    const r = resolve("t1", h, fv, NOW);
    expect(r).toMatchObject({ ok: false, reason, harness });
  });

  it("checks the feed's age at use: a snapshot panorama's driver stopped refreshing, or one the contract calls aged, binds nothing", () => {
    expect(resolve("t1", host(), view(undefined, {}, NOW - 3_001), NOW)).toMatchObject({ ok: false, reason: "no_binding" });
    expect(resolve("t1", host(), view(undefined, {}, NOW - 2_000), NOW)).toMatchObject({ ok: true });
    expect(resolve("t1", host(), view(undefined, {}, NOW + 10_000), NOW)).toMatchObject({ ok: false, reason: "no_binding" });
    // The view says fresh, the contract (asked now) says aged.
    const agedContract = { aged: () => true } as unknown as Contract;
    expect(resolve("t1", host(), { ...view(), contract: agedContract }, NOW)).toMatchObject({ ok: false, reason: "no_binding" });
    const throwing = { aged: () => { throw new Error("x"); } } as unknown as Contract;
    expect(resolve("t1", host(), { ...view(), contract: throwing }, NOW)).toMatchObject({ ok: false, reason: "no_binding" });
    expect(resolve("t1", host(), { ...view(), contract: { aged: () => false } as unknown as Contract }, NOW)).toMatchObject({ ok: true });
  });

  it("never matches by cwd, title or pane id", () => {
    expect(resolve("t1", host(), view([claudeRoot({ terminal: null, pane_id: "t1", title: "t1", cwd: "/work/t1" })]), NOW)).toMatchObject({ ok: false, reason: "no_binding" });
  });
});

describe("chatview:<t> topic", () => {
  it("publishes the bound session's items, and nothing that says where the history lives", async () => {
    const { value, history, env, client } = await setup();
    const v = value();
    expect(bridgeApi.ChatviewTopic.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ terminal: "t1", harness: "claude", state: "ok", older: false, status: { state: "working", since: AT(1) } });
    expect(v.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(itemIds(v)).toEqual([U(1), U(2)]);
    expect(history!.binds).toEqual([{ sessionId: SID, transcript: TRANSCRIPT, cwd: "/work/project-alpha" }]);
    // The only file operation on the transcript is a stat.
    expect(env.statCalls).toEqual([TRANSCRIPT]);
    const sent = JSON.stringify(client.got);
    for (const never of [TRANSCRIPT, "claude-1/projects", CONFIG, SID, "/work/project-alpha"]) expect(sent).not.toContain(never);
    expect(client.ofType("snap")).toHaveLength(1);
  });

  it("reads only when the transcript's size or mtime changed", async () => {
    const { history, env, poll } = await setup();
    expect(history!.reads).toBe(1);
    await poll();
    await poll();
    expect(history!.reads).toBe(1);
    expect(env.statCalls).toHaveLength(3);
    env.stat = { size: 100, mtimeMs: 2 };
    await poll();
    expect(history!.reads).toBe(2);
    env.stat = { size: 120, mtimeMs: 2 };
    await poll();
    expect(history!.reads).toBe(3);
  });

  it("new messages go out as a patch that applies to what the phone holds", async () => {
    const { history, env, client, value, poll } = await setup();
    const before = structuredClone(value());
    history!.messages = [...history!.messages, agent(3, [tool("t1", "Bash", { command: "x" })]), user(4, [result("t1", true)])];
    env.stat = { size: 200, mtimeMs: 2 };
    await poll();
    expect(client.ofType("snap")).toHaveLength(1);
    const patches = client.ofType("patch");
    expect(patches).toHaveLength(1);
    expect(applyPatch(before as unknown as Json, patches[0]!.ops)).toEqual(value());
    expect(value().items.at(-1)).toMatchObject({ role: "tools", tools: { kind: "shell", failed: 1, running: 0 } });
  });

  it("a rewritten chain (compaction, rewind) is a fresh snap with a new rev", async () => {
    const { history, env, client, value, poll } = await setup();
    const rev = value().rev;
    history!.messages = [user(10, "A rewound branch"), agent(11, "Other reply")];
    env.stat = { size: 50, mtimeMs: 3 };
    await poll();
    expect(client.ofType("snap")).toHaveLength(2);
    expect(client.ofType("patch")).toHaveLength(0);
    expect(value().rev).not.toBe(rev);
    expect(itemIds(value())).toEqual([U(10), U(11)]);
  });

  it("a session moved by continued-in binds again and starts over (snap, new rev)", async () => {
    const { history, env, client, value, poll } = await setup();
    const rev = value().rev;
    env.feed = view([claudeRoot({ session_id: SID2, transcript: TRANSCRIPT.replace(SID, SID2) })]);
    history!.messages = [user(1, "Hello Agent 1"), agent(2, "Hi.")];
    await poll();
    expect(history!.binds.map((b) => b.sessionId)).toEqual([SID, SID2]);
    expect(env.statCalls.at(-1)).toBe(TRANSCRIPT.replace(SID, SID2));
    // Same items, but another session: never patched across.
    expect(client.ofType("snap")).toHaveLength(2);
    expect(value().rev).not.toBe(rev);
  });

  it("the window slides by removes at the front, not by replacing every item", async () => {
    const history = new FakeHistory();
    history.messages = Array.from({ length: 120 }, (_, i) => user(i + 1, `message ${i + 1}`));
    const { env, client, value, poll } = await setup({ history });
    expect(value().items).toHaveLength(100);
    expect(value().older).toBe(true);
    const before = structuredClone(value());
    history.messages = [...history.messages, user(121, "message 121"), user(122, "message 122")];
    env.stat = { size: 999, mtimeMs: 9 };
    await poll();
    const [p] = client.ofType("patch");
    expect(p).toBeDefined();
    expect(p!.ops.length).toBeLessThanOrEqual(6);
    expect(p!.ops.filter((o) => o.op === "remove")).toEqual([
      { op: "remove", path: "/items/0" },
      { op: "remove", path: "/items/0" },
    ]);
    expect(applyPatch(before as unknown as Json, p!.ops)).toEqual(value());
    expect(itemIds(value()).at(-1)).toBe(U(122));
  });

  it("keeps a snap at or under 512 KB", async () => {
    const history = new FakeHistory();
    history.messages = Array.from({ length: 100 }, (_, i) => agent(i + 1, "w".repeat(30_000)));
    const { value } = await setup({ history });
    const bytes = Buffer.byteLength(JSON.stringify(value()));
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
    expect(value().items.length).toBeLessThan(100);
    expect(value().older).toBe(true);
  });

  it("the status line is the host's agent status, not the transcript", async () => {
    const { hub, value, poll, client, history } = await setup();
    expect(value().status).toEqual({ state: "working", since: AT(1) });
    hub.publish("host", host({}, { state: "waiting" }) as unknown as Json);
    await poll();
    expect(value().status).toEqual({ state: "blocked", since: null });
    expect(history!.reads).toBe(1);
    expect(client.ofType("patch")).toHaveLength(1);
    hub.publish("host", host({}, { state: "idle" }) as unknown as Json);
    await poll();
    expect(value().status).toEqual({ state: "idle", since: null });
  });

  it("an empty session is ok with no items; a session file that has messages but reads not_found is reader_failed", async () => {
    const history = new FakeHistory();
    history.messages = [];
    const a = await setup({ history });
    expect(a.value()).toMatchObject({ state: "ok", items: [] });
    // Not found while the transcript is missing: a new session, no messages yet.
    const h2 = new FakeHistory();
    h2.readResult = { ok: false, reason: "not_found" };
    const b = await setup({ history: h2 });
    b.env.stat = "missing";
    await b.drv.poll(TOPIC);
    // The first look saw size 100: reader_failed. With the file missing (after the retry wait): ok and empty.
    b.env.clock += 5_000;
    await b.poll();
    expect(b.value()).toMatchObject({ state: "ok", items: [] });
    // Not found while the transcript has a size: the reader can't see it.
    const h3 = new FakeHistory();
    h3.readResult = { ok: false, reason: "not_found" };
    const c = await setup({ history: h3 });
    expect(c.value()).toMatchObject({ state: "unavailable", reason: "reader_failed", items: [] });
  });

  it("bind and read failures give their reason, drop the history held, and retry after a wait", async () => {
    const { history, env, value, poll } = await setup();
    expect(value().state).toBe("ok");
    history!.readResult = { ok: false, reason: "reader_failed", detail: "timeout" };
    env.stat = { size: 300, mtimeMs: 5 };
    await poll();
    expect(value()).toMatchObject({ state: "unavailable", reason: "reader_failed", items: [], rev: "" });
    history!.readResult = undefined;
    history!.bindResult = { ok: false, reason: "no_profiles", detail: "missing" };
    await poll();
    expect(history!.binds).toHaveLength(1);
    env.clock += 5_000;
    await poll();
    expect(history!.binds).toHaveLength(2);
    expect(value()).toMatchObject({ state: "unavailable", reason: "no_profiles" });
    await poll();
    expect(history!.binds).toHaveLength(2);
    history!.bindResult = new FakeHistory().bindResult;
    env.clock += 5_000;
    await poll();
    expect(value()).toMatchObject({ state: "ok" });
    expect(itemIds(value())).toEqual([U(1), U(2)]);
  });

  it("a stat error is reader_failed; a feed that turns aged hides the chat at once", async () => {
    const a = await setup();
    a.env.stat = "error";
    await a.poll();
    expect(a.value()).toMatchObject({ state: "unavailable", reason: "reader_failed" });
    const b = await setup();
    b.env.feed = view(undefined, { aged: true, stale: true });
    await b.poll();
    expect(b.value()).toMatchObject({ state: "unavailable", reason: "no_binding", items: [] });
    expect(JSON.stringify(b.value())).not.toContain("Hello Agent 1");
  });

  it("a panorama driver that stopped refreshing hides the chat once its snapshot is 3 s old", async () => {
    const { env, value, poll } = await setup();
    expect(value().state).toBe("ok");
    env.feed = view(undefined, {}, env.clock);
    env.clock += 3_001;
    await poll();
    expect(value()).toMatchObject({ state: "unavailable", reason: "no_binding", items: [] });
  });

  it("a value that fails its own schema waits before reading again, and keeps the binding", async () => {
    const history = new FakeHistory();
    history.messages = [user(1, "Hello"), { ...agent(2, "Hi."), uuid: "not a valid id!" }];
    const { env, value, poll } = await setup({ history });
    expect(value()).toMatchObject({ state: "unavailable", reason: "reader_failed" });
    expect(history.reads).toBe(1);
    await poll();
    await poll();
    expect(history.reads).toBe(1);
    env.clock += 5_000;
    await poll();
    expect(history.reads).toBe(2);
    expect(history.binds).toHaveLength(1);
  });

  it("after a failure the same session starts over: a new rev and a snap, never the items held before", async () => {
    const { history, env, client, value, poll } = await setup();
    const rev = value().rev;
    history!.readResult = { ok: false, reason: "reader_failed", detail: "timeout" };
    env.stat = { size: 300, mtimeMs: 5 };
    await poll();
    history!.readResult = undefined;
    env.clock += 5_000;
    await poll();
    expect(value().state).toBe("ok");
    expect(value().rev).not.toBe(rev);
    expect(client.ofType("snap").at(-1)?.data).toEqual(value());
  });

  it("a read whose binding went bad meanwhile is not published", async () => {
    const history = new FakeHistory();
    const { env, value, poll } = await setup({ history });
    const before = structuredClone(value());
    // The feed ages while the read runs.
    history.read = () => {
      env.feed = view(undefined, { aged: true, stale: true });
      return Promise.resolve({ ok: true, messages: [user(1, "Hello Agent 1"), agent(2, "Hi."), user(3, "Late")], stats: { total: 3, failed: 0, droppedBlocks: 0, droppedMessages: 0 } });
    };
    env.stat = { size: 500, mtimeMs: 7 };
    await poll();
    expect(value()).toEqual(before);
    await poll();
    expect(value()).toMatchObject({ state: "unavailable", reason: "no_binding" });
  });

  it("statOnly reads size and mtime without opening the file", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pjoin } = await import("node:path");
    const d = mkdtempSync(pjoin(tmpdir(), "cv3-stat-"));
    try {
      const f = pjoin(d, "t.jsonl");
      writeFileSync(f, "x".repeat(42));
      chmodSync(f, 0o000);
      expect(await statOnly(f)).toMatchObject({ size: 42 });
      expect(await statOnly(pjoin(d, "missing.jsonl"))).toBe("missing");
      expect(await statOnly(d)).toBe("error");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("without a verified reader the Claude chat view is reader_failed", async () => {
    const { value } = await setup({ history: null });
    expect(value()).toMatchObject({ state: "unavailable", reason: "reader_failed", harness: "claude" });
  });

  it("a Codex pane is `harness` and never binds", async () => {
    const history = new FakeHistory();
    const { value } = await setup({ history, host: host({}, { program: "codex" }) });
    expect(value()).toMatchObject({ state: "unavailable", reason: "harness", harness: "codex" });
    expect(history.binds).toEqual([]);
  });

  it("a bad terminal id is stale bad_terminal; past the cap a chat view waits (too_many_chats)", async () => {
    const bad = await setup({ topic: "chatview:-rf" });
    expect(bad.hub.isStale("chatview:-rf")).toBe("bad_terminal");
    const { hub, client, conn } = await setup();
    void client;
    void conn;
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["chatview:t2", "chatview:t3", "chatview:t4", "chatview:t5", "chatview:t6"] });
    expect(hub.isStale("chatview:t6")).toBe(null);
    await c.send({ type: "sub", topics: ["chatview:t7"] });
    expect(hub.isStale("chatview:t7")).toBe("too_many_chats");
  });

  it("stops looking when nobody is subscribed", async () => {
    const { hub, drv, conn, env } = await setup();
    hub.disconnect(conn);
    expect(drv.activeTopics).toEqual([]);
    const n = env.statCalls.length;
    await drv.poll(TOPIC);
    expect(env.statCalls).toHaveLength(n);
    expect(hub.get(TOPIC)).toBeUndefined();
  });
});

describe("older pages", () => {
  it("returns up to n items just before the cursor, oldest first", async () => {
    const history = new FakeHistory();
    history.messages = Array.from({ length: 160 }, (_, i) => user(i + 1, `message ${i + 1}`));
    const { drv, value } = await setup({ history });
    const first = value().items[0]!.id;
    const p = drv.page("t1", first, 50);
    if (!p.ok) throw new Error(p.code);
    expect(p.page.items).toHaveLength(50);
    expect(p.page.items.at(-1)!.id).not.toBe(first);
    expect(p.page.older).toBe(true);
    expect(p.page.rev).toBe(value().rev);
    expect(bridgeApi.ChatviewPage.safeParse(p.page).success).toBe(true);
    const all = [...p.page.items];
    let cursor = p.page.items[0]!.id;
    for (;;) {
      const q = drv.page("t1", cursor, 50);
      if (!q.ok) throw new Error(q.code);
      all.unshift(...q.page.items);
      if (!q.page.older) break;
      cursor = q.page.items[0]!.id;
    }
    // Every item from the first, exactly once, in order.
    expect([...all, ...value().items].filter((i) => i.role === "you").map((i) => i.id)).toEqual(history.messages.map((m) => m.uuid));
  });

  it("refuses an unknown cursor, another rev, and a chat view that is not open", async () => {
    const { drv, value, hub, conn } = await setup();
    expect(drv.page("t1", "a9999999-0000-4000-8000-000000000000", 10)).toEqual({ ok: false, status: 404, code: "unknown_cursor" });
    expect(drv.page("t1", U(2), 10, "ffff")).toEqual({ ok: false, status: 409, code: "rev_changed" });
    expect(drv.page("t1", U(2), 10, value().rev)).toMatchObject({ ok: true, page: { older: false } });
    expect(drv.page("t2", U(2), 10)).toEqual({ ok: false, status: 409, code: "not_open" });
    hub.disconnect(conn);
    expect(drv.page("t1", U(2), 10)).toEqual({ ok: false, status: 409, code: "not_open" });
  });
});

describe("windowOps and continues", () => {
  const item = (i: number, text = `m${i}`): bridgeApi.ChatItem => ({ id: U(i), role: "you", at: null, text });
  const topic = (ids: number[], over: Partial<bridgeApi.ChatviewTopic> = {}): bridgeApi.ChatviewTopic => ({
    terminal: "t1",
    harness: "claude",
    state: "ok",
    items: ids.map((i) => item(i)),
    older: false,
    rev: "ab",
    status: { state: "idle", since: null },
    ...over,
  });

  it.each([
    [[1, 2, 3], [1, 2, 3, 4]],
    [[1, 2, 3], [3, 4, 5]],
    [[1, 2, 3], [2, 3]],
    [[], [1, 2]],
    [[1, 2], []],
    [[1, 2, 3], [1, 2, 3]],
  ])("%j -> %j applies exactly", (a, b) => {
    const prev = topic(a);
    const next = topic(b, { older: true });
    const ops = windowOps(prev, next);
    expect(ops).not.toBeNull();
    expect(applyPatch(structuredClone(prev) as unknown as Json, ops!)).toEqual(next);
  });

  it("is null when the new window starts before the old one", () => {
    expect(windowOps(topic([3, 4]), topic([1, 2, 3, 4]))).toBeNull();
  });

  it("continues: appended, cut at the front, or rewritten", () => {
    const l = (ids: number[]) => ids.map((i) => item(i));
    expect(continues(l([]), l([1]))).toBe(true);
    expect(continues(l([1, 2]), l([1, 2, 3]))).toBe(true);
    expect(continues(l([1, 2, 3]), l([2, 3, 4]))).toBe(true);
    expect(continues(l([1, 2, 3]), l([1, 3, 4]))).toBe(false);
    expect(continues(l([1, 2, 3]), l([1, 2]))).toBe(false);
    expect(continues(l([1, 2]), l([5, 6]))).toBe(false);
    expect(continues(l([1]), l([]))).toBe(false);
  });
});
