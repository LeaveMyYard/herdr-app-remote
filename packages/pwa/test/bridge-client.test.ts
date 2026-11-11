import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type BridgeClientOptions } from "../src/bridge/client";
import { FakeSocket, FakeTarget } from "./fake-socket";

let sockets: FakeSocket[];
let me: number | null;
let win: FakeTarget;
let doc: FakeTarget;
let client: BridgeClient;

const last = () => sockets[sockets.length - 1]!;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function make(over: BridgeClientOptions = {}) {
  client = new BridgeClient({
    url: "wss://desk-1.example-tailnet.ts.net/api/v1/ws",
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    checkMe: async () => me,
    events: { win: win as unknown as Window, doc: doc as unknown as Document },
    ...over,
  });
  return client;
}

/** Starts, opens and greets: returns the live socket. */
async function online(epoch = "e1"): Promise<FakeSocket> {
  if (!sockets.length || last().readyState === 3) {
    client.start();
    await flush();
  }
  const s = last();
  s.open();
  s.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch });
  return s;
}

const HOST = { n: 1, items: ["a"] };

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  me = 200;
  win = new FakeTarget();
  doc = new FakeTarget();
});
afterEach(() => {
  client?.stop();
  vi.useRealTimers();
});

describe("BridgeClient: handshake and topics", () => {
  it("offers the subprotocol, says hello first, then subscribes every wanted topic", async () => {
    make();
    client.want("host");
    client.want("plugins");
    const s = await online();
    expect(s.protocols).toEqual(["herdr-remote.v1"]);
    expect(s.sent[0]).toEqual({ type: "hello", api: 1 });
    expect(s.ofType("sub")).toEqual([{ type: "sub", topics: ["host", "plugins"] }]);
    expect(client.getSnapshot().status).toBe("online");
    client.want("usage");
    expect(s.ofType("sub").at(-1)).toEqual({ type: "sub", topics: ["usage"] });
  });

  it("applies a snap, then patches in seq order", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 3, data: HOST });
    expect(client.getSnapshot().topics.setup).toEqual({ data: HOST, seq: 3, stale: null });
    s.recv({ type: "patch", topic: "setup", seq: 4, ops: [{ op: "replace", path: "/n", value: 2 }] });
    expect(client.getSnapshot().topics.setup!.data).toEqual({ n: 2, items: ["a"] });
  });

  it("re-subscribes on a seq gap, a patch before any snap, or a patch that doesn't apply, without applying it", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "patch", topic: "setup", seq: 1, ops: [] });
    expect(s.ofType("sub").at(-1)).toEqual({ type: "sub", topics: ["setup"] });
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 3, data: HOST });
    const subs = s.ofType("sub").length;
    s.recv({ type: "patch", topic: "setup", seq: 5, ops: [{ op: "replace", path: "/n", value: 9 }] });
    expect(s.ofType("sub").length).toBe(subs + 1);
    expect(client.getSnapshot().topics.setup!.data).toEqual(HOST);
    // The fresh snap after the gap, then a patch that doesn't apply.
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 5, data: HOST });
    s.recv({ type: "patch", topic: "setup", seq: 6, ops: [{ op: "remove", path: "/missing" }] });
    expect(s.ofType("sub").length).toBe(subs + 2);
    expect(client.getSnapshot().topics.setup!.seq).toBe(5);
  });

  it("keeps the data on stale, records the reason, and clears it with the next snap", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "stale", topic: "setup", reason: "reconnecting" });
    expect(client.getSnapshot().topics.setup).toEqual({ data: undefined, seq: -1, stale: "reconnecting" });
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 1, data: HOST });
    s.recv({ type: "stale", topic: "setup", reason: "layout_without_remote" });
    expect(client.getSnapshot().topics.setup).toEqual({ data: HOST, seq: 1, stale: "layout_without_remote" });
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 2, data: HOST });
    expect(client.getSnapshot().topics.setup!.stale).toBeNull();
  });

  it("ignores a snap from another epoch and frames that aren't valid server messages", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "snap", topic: "setup", epoch: "other", seq: 1, data: HOST });
    s.onmessage?.({ data: "{nope" });
    s.recv({ type: "bogus" });
    expect(client.getSnapshot().topics.setup).toBeUndefined();
  });
});

describe("BridgeClient: reconnecting", () => {
  it("resumes with the epoch and each topic's seq, and keeps the data on screen meanwhile", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 7, data: HOST });
    s.drop(1006);
    expect(client.getSnapshot().status).toBe("offline");
    expect(client.getSnapshot().topics.setup!.data).toEqual(HOST);
    await vi.advanceTimersByTimeAsync(500);
    const s2 = last();
    expect(s2).not.toBe(s);
    s2.open();
    expect(s2.sent[0]).toEqual({ type: "hello", api: 1, resume: { epoch: "e1", seqs: { setup: 7 } } });
    s2.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
    expect(s2.ofType("sub")).toEqual([{ type: "sub", topics: ["setup"] }]);
    // Same epoch: a replayed patch still applies.
    s2.recv({ type: "patch", topic: "setup", seq: 8, ops: [{ op: "replace", path: "/n", value: 3 }] });
    expect(client.getSnapshot().topics.setup!.data).toEqual({ n: 3, items: ["a"] });
  });

  it("after a bridge restart (new epoch) takes no patch until the fresh snap", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 7, data: HOST });
    s.drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    const s2 = last();
    s2.open();
    s2.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e2" });
    s2.recv({ type: "patch", topic: "setup", seq: 8, ops: [{ op: "replace", path: "/n", value: 3 }] });
    expect(client.getSnapshot().topics.setup!.data).toEqual(HOST);
    s2.recv({ type: "snap", topic: "setup", epoch: "e2", seq: 1, data: { n: 5 } });
    expect(client.getSnapshot().topics.setup).toEqual({ data: { n: 5 }, seq: 1, stale: null });
  });

  it("backs off from 0.5 s, doubling, up to 10 s, and opens no socket while /me fails", async () => {
    let tries = 0;
    make({ checkMe: async () => (tries++, null) });
    client.start();
    await flush();
    const at: number[] = [];
    for (let t = 0; t < 60_000; t += 100) {
      const before = tries;
      await vi.advanceTimersByTimeAsync(100);
      if (tries > before) at.push(t + 100);
    }
    const gaps = at.map((x, i) => x - (i === 0 ? 0 : at[i - 1]!));
    expect(gaps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
    expect(gaps.slice(6).every((g) => g === 10000)).toBe(true);
    expect(sockets.length).toBe(0);
    expect(client.getSnapshot().status).toBe("offline");
  });

  it("reconnects at once on visibilitychange to visible and on online, skipping the backoff", async () => {
    make();
    const s = await online();
    s.drop(1006);
    doc.fire("visibilitychange");
    await flush();
    expect(sockets.length).toBe(2);
    last().drop(1006);
    win.fire("online");
    await flush();
    expect(sockets.length).toBe(3);
  });

  it("on wake with an open socket, pings and reconnects if no answer comes", async () => {
    make();
    const s = await online();
    doc.fire("visibilitychange");
    expect(s.ofType("ping").length).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(s.closedWith).toBe(1000);
    expect(sockets.length).toBe(2);
  });

  it("keeps the socket when the wake ping is answered", async () => {
    make();
    const s = await online();
    doc.fire("visibilitychange");
    s.recv({ type: "pong" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets.length).toBe(1);
  });

  it("drops a socket that has been silent too long", async () => {
    make({ pingMs: 1_000, deadMs: 3_000 });
    await online();
    await vi.advanceTimersByTimeAsync(4_000);
    await flush();
    expect(sockets.length).toBe(2);
  });
});

describe("BridgeClient: review fixes", () => {
  it("goes back online when a frame arrives after the browser's offline event", async () => {
    make();
    const s = await online();
    win.fire("offline");
    expect(client.getSnapshot().status).toBe("offline");
    win.fire("online");
    s.recv({ type: "pong" });
    expect(client.getSnapshot().status).toBe("online");
    expect(sockets.length).toBe(1);
  });

  it("fails an act in flight when the wake probe replaces a dead socket", async () => {
    make();
    await online();
    const p = client.act("tab.select", { index: 1 });
    doc.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual({ ok: false, code: "connection_lost", unknown_effect: true });
  });

  it("asks once for a fresh snap on a gap, dropping later patches until it comes", async () => {
    make();
    client.want("setup");
    const s = await online();
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 1, data: { n: 1 } });
    const subs = s.ofType("sub").length;
    s.recv({ type: "patch", topic: "setup", seq: 3, ops: [] });
    s.recv({ type: "patch", topic: "setup", seq: 4, ops: [] });
    s.recv({ type: "patch", topic: "setup", seq: 5, ops: [] });
    expect(s.ofType("sub").length).toBe(subs + 1);
    s.recv({ type: "snap", topic: "setup", epoch: "e1", seq: 5, data: { n: 5 } });
    s.recv({ type: "patch", topic: "setup", seq: 6, ops: [{ op: "replace", path: "/n", value: 6 }] });
    expect(client.getSnapshot().topics.setup!.data).toEqual({ n: 6 });
  });

  it("replaces the socket quietly once a given-up topic is still subscribed, resubscribing only what is wanted", async () => {
    make({ pruneMs: 1_000 });
    client.want("host");
    const release = client.want("chat:t3");
    const s = await online();
    s.recv({ type: "snap", topic: "chat:t3", epoch: "e1", seq: 1, data: { lines: [] } });
    const seen: string[] = [];
    client.subscribe(() => seen.push(client.getSnapshot().status));
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(sockets.length).toBe(2);
    expect(seen).not.toContain("connecting");
    expect(client.getSnapshot().topics["chat:t3"]).toBeUndefined();
    const s2 = last();
    s2.open();
    s2.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
    expect(s2.ofType("sub")).toEqual([{ type: "sub", topics: ["host"] }]);
  });

  it("waits for acts in flight before pruning, and doesn't prune a topic wanted again", async () => {
    make({ pruneMs: 1_000 });
    const release = client.want("chat:t3");
    const s = await online();
    const p = client.act("tab.select", { index: 1 });
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.length).toBe(1);
    s.recv({ type: "res", id: s.ofType("act")[0]!.id, ok: true });
    expect(await p).toEqual({ ok: true });
    client.want("chat:t3");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets.length).toBe(1);
  });
});

describe("BridgeClient: refusals", () => {
  it("doesn't reconnect on its own after a revoke, view off or pause", async () => {
    for (const [code, status] of [
      [4001, "refused"],
      [4003, "refused"],
      [4002, "paused"],
    ] as const) {
      sockets = [];
      make();
      const s = await online();
      s.drop(code);
      expect(client.getSnapshot().status).toBe(status);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sockets.length).toBe(1);
      client.stop();
    }
  });

  it("retries slowly while the bridge refuses to serve (Funnel)", async () => {
    make();
    const s = await online();
    s.drop(4004);
    expect(client.getSnapshot().status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sockets.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets.length).toBe(2);
  });

  it("asks /api/v1/me first: an unpaired phone opens no socket", async () => {
    me = 401;
    make();
    client.start();
    await flush();
    expect(client.getSnapshot().status).toBe("unpaired");
    expect(sockets.length).toBe(0);
    me = 403;
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(client.getSnapshot().status).toBe("refused");
    expect(sockets.length).toBe(0);
  });
});

describe("BridgeClient: actions", () => {
  it("resolves with the bridge's res, and changes nothing on screen by itself", async () => {
    make();
    client.want("usage");
    const s = await online();
    s.recv({ type: "snap", topic: "usage", epoch: "e1", seq: 1, data: { filter: "open-panes" } });
    const before = client.getSnapshot();
    const p = client.act("usage.set_filter", { filter: "all" });
    const sent = s.ofType("act")[0]!;
    expect(sent).toMatchObject({ kind: "usage.set_filter", args: { filter: "all" } });
    expect(client.getSnapshot()).toBe(before);
    s.recv({ type: "res", id: sent.id, ok: false, code: "timeout" });
    expect(await p).toEqual({ ok: false, code: "timeout" });
    expect(client.getSnapshot()).toBe(before);
  });

  it("reports an unknown effect when the socket goes with the act in flight, and never resends it", async () => {
    make();
    const s = await online();
    const p = client.act("tab.select", { index: 1 });
    s.drop(1006);
    expect(await p).toEqual({ ok: false, code: "connection_lost", unknown_effect: true });
    await vi.advanceTimersByTimeAsync(500);
    const s2 = last();
    s2.open();
    s2.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
    expect(s2.ofType("act")).toEqual([]);
  });

  it("refuses to act while not connected, sending nothing", async () => {
    make();
    expect(await client.act("usage.refresh")).toEqual({ ok: false, code: "offline" });
  });

  it("passes unknown_effect through", async () => {
    make();
    const s = await online();
    const p = client.act("tab.select", { index: 1 });
    s.recv({ type: "res", id: s.ofType("act")[0]!.id, ok: false, code: "timeout", unknown_effect: true });
    expect(await p).toEqual({ ok: false, code: "timeout", unknown_effect: true });
  });
});
