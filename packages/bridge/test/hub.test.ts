import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { applyPatch, type Json } from "../src/patch.js";
import { HOST, fixture, join, newHub } from "./helpers.js";

describe("hub snap/patch", () => {
  it("welcomes, snaps on sub, then patches with seq + 1", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const { client, send } = await join(hub);
    expect(client.got[0]).toEqual({ type: "welcome", api: 1, bridge: "0.0.0-test", epoch: "epoch-1" });
    await send({ type: "sub", topics: ["host"] });
    const snap = client.ofType("snap")[0]!;
    expect(snap).toMatchObject({ topic: "host", epoch: "epoch-1", data: HOST(1) });
    hub.publish("host", HOST(2));
    hub.publish("host", HOST(3));
    const patches = client.ofType("patch");
    expect(patches.map((p) => p.seq)).toEqual([snap.seq + 1, snap.seq + 2]);
    let data = snap.data as Json;
    for (const p of patches) data = applyPatch(data, p.ops);
    expect(data).toEqual(HOST(3));
  });

  it("publishes nothing for an unchanged value", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const { client, send } = await join(hub);
    await send({ type: "sub", topics: ["host"] });
    const before = client.got.length;
    hub.publish("host", HOST(1));
    expect(client.got.length).toBe(before);
  });

  it("keeps seq per topic", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    hub.publish("plugins", { a: 1 });
    hub.publish("plugins", { a: 2 });
    hub.publish("plugins", { a: 3 });
    expect(hub.seqOf("host")).toBe(1);
    expect(hub.seqOf("plugins")).toBe(3);
  });

  it("a gap recovery: re-subscribing a topic yields a fresh snap for that topic only", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    hub.publish("plugins", { a: 1 });
    const { client, send } = await join(hub);
    await send({ type: "sub", topics: ["host", "plugins"] });
    hub.publish("host", HOST(2));
    const n = client.got.length;
    await send({ type: "sub", topics: ["host"] });
    const fresh = client.got.slice(n);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ type: "snap", topic: "host", data: HOST(2), seq: hub.seqOf("host") });
  });

  it("resume with a covered seq replays only the missed patches", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const seq = hub.seqOf("host");
    hub.publish("host", HOST(2));
    hub.publish("host", HOST(3));
    const { client, send } = await join(hub, { epoch: "epoch-1", seqs: { host: seq } });
    await send({ type: "sub", topics: ["host"] });
    expect(client.ofType("snap")).toHaveLength(0);
    expect(client.ofType("patch").map((p) => p.seq)).toEqual([seq + 1, seq + 2]);
  });

  it("resume at the current seq sends nothing", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const { client, send } = await join(hub, { epoch: "epoch-1", seqs: { host: hub.seqOf("host") } });
    await send({ type: "sub", topics: ["host"] });
    expect(client.got.map((m) => m.type)).toEqual(["welcome"]);
  });

  it("resume with an unknown epoch, a seq gap or a future seq gets a snap", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    for (let i = 2; i < 100; i++) hub.publish("host", HOST(i));
    for (const resume of [
      { epoch: "other", seqs: { host: hub.seqOf("host") } },
      { epoch: "epoch-1", seqs: { host: 1 } }, // older than the 64-patch log
      { epoch: "epoch-1", seqs: { host: 9999 } },
    ]) {
      const { client, send } = await join(hub, resume);
      await send({ type: "sub", topics: ["host"] });
      expect(client.ofType("snap")).toHaveLength(1);
      expect(client.ofType("patch")).toHaveLength(0);
    }
  });

  it("resume does not apply to a second subscription of the same topic", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const seq = hub.seqOf("host");
    hub.publish("host", HOST(2));
    const { client, send } = await join(hub, { epoch: "epoch-1", seqs: { host: seq } });
    await send({ type: "sub", topics: ["host"] });
    await send({ type: "sub", topics: ["host"] });
    expect(client.ofType("snap")).toHaveLength(1);
  });

  it("a topic with no data sends no snap until one is published", async () => {
    const hub = newHub();
    const { client, send } = await join(hub);
    await send({ type: "sub", topics: ["host"] });
    expect(client.ofType("snap")).toHaveLength(0);
    hub.publish("host", HOST(1));
    expect(client.ofType("snap")).toHaveLength(1);
  });

  it("only subscribers get a topic's messages", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const a = await join(hub);
    const b = await join(hub);
    await a.send({ type: "sub", topics: ["host"] });
    hub.publish("host", HOST(2));
    expect(a.client.ofType("patch")).toHaveLength(1);
    expect(b.client.ofType("patch")).toHaveLength(0);
  });

  it("every server message validates against the protocol schema", async () => {
    const hub = newHub();
    hub.publish("host", fixture("typical"));
    const { client, send } = await join(hub);
    await send({ type: "sub", topics: ["host", "chat:t1"] });
    hub.publish("host", fixture("idle-and-done"));
    hub.publish("chat:t1", { q: 1 });
    hub.publish("chat:t1", { q: 2 });
    hub.setStale("chat:t1", "source_unavailable");
    await send({ type: "ping" });
    await send({ type: "act", id: "a1", kind: "x", args: {} });
    for (const m of client.got) expect(bridgeApi.ServerMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });
});

describe("hub stale", () => {
  it("sends stale to subscribers and to late subscribers, keeps the data", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const a = await join(hub);
    await a.send({ type: "sub", topics: ["host"] });
    hub.setStale("host", "reconnecting");
    hub.setStale("host", "reconnecting");
    expect(a.client.ofType("stale")).toEqual([{ type: "stale", topic: "host", reason: "reconnecting" }]);
    const b = await join(hub);
    await b.send({ type: "sub", topics: ["host"] });
    expect(b.client.got.map((m) => m.type)).toEqual(["welcome", "snap", "stale"]);
  });

  it("a publish after stale clears it with a fresh snap, not a patch", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const a = await join(hub);
    await a.send({ type: "sub", topics: ["host"] });
    hub.setStale("host", "reconnecting");
    hub.publish("host", HOST(2));
    expect(hub.isStale("host")).toBeNull();
    expect(a.client.got.map((m) => m.type)).toEqual(["welcome", "snap", "stale", "snap"]);
    expect(a.client.ofType("snap")[1]).toMatchObject({ data: HOST(2), seq: hub.seqOf("host") });
    // a client resuming from before the stale period gets a snap too
    const b = await join(hub, { epoch: "epoch-1", seqs: { host: 1 } });
    await b.send({ type: "sub", topics: ["host"] });
    expect(b.client.ofType("snap")).toHaveLength(1);
  });
});

describe("hub protocol discipline", () => {
  it("closes on bad json, bad schema, early frames and a second hello", async () => {
    const hub = newHub();
    const c1 = hub.connect(new (await import("./helpers.js")).FakeClient());
    await hub.handleRaw(c1, "{nope");
    expect((c1.client as import("./helpers.js").FakeClient).closed?.code).toBe(1003);

    const f2 = new (await import("./helpers.js")).FakeClient();
    const c2 = hub.connect(f2);
    await hub.handleRaw(c2, JSON.stringify({ type: "sub", topics: ["host"] }));
    expect(f2.closed?.code).toBe(1002);

    const j = await join(hub);
    await j.send({ type: "hello", api: 1 });
    expect(j.client.closed?.code).toBe(1002);

    const j2 = await join(hub);
    await j2.send({ type: "sub", topics: [] });
    expect(j2.client.closed?.code).toBe(1003);
  });

  it("answers ping and refuses acts with no handler", async () => {
    const hub = newHub();
    const { client, send } = await join(hub);
    await send({ type: "ping" });
    await send({ type: "act", id: "a1", kind: "tab.new", args: {} });
    expect(client.ofType("pong")).toHaveLength(1);
    expect(client.ofType("res")[0]).toEqual({ type: "res", id: "a1", ok: false, code: "unsupported_action" });
  });

  it("routes acts to the handler; a throw is an unknown effect", async () => {
    const hub = newHub({
      onAct: (_c, kind) => {
        if (kind === "boom") throw new Error("x");
        return { ok: true };
      },
    });
    const { client, send } = await join(hub);
    await send({ type: "act", id: "1", kind: "fine", args: {} });
    await send({ type: "act", id: "2", kind: "boom", args: {} });
    expect(client.ofType("res")).toEqual([
      { type: "res", id: "1", ok: true },
      { type: "res", id: "2", ok: false, code: "internal_error", unknown_effect: true },
    ]);
  });

  it("disconnect removes the subscription", async () => {
    const hub = newHub();
    hub.publish("host", HOST(1));
    const { client, conn, send } = await join(hub);
    await send({ type: "sub", topics: ["host"] });
    hub.disconnect(conn);
    hub.publish("host", HOST(2));
    expect(client.ofType("patch")).toHaveLength(0);
    expect(hub.connectionCount).toBe(0);
  });
});

describe("hub robustness", () => {
  it("drops frames after a protocol close, so a pipelined act never runs", async () => {
    let ran = 0;
    const hub = newHub({ onAct: () => (ran++, { ok: true }) });
    const { conn } = await join(hub);
    await hub.handleRaw(conn, "{bad");
    await hub.handleRaw(conn, JSON.stringify({ type: "act", id: "1", kind: "x", args: {} }));
    expect(ran).toBe(0);
  });

  it("does not leak topic state for subscriptions to unknown topics", async () => {
    const hub = newHub();
    const { conn, send } = await join(hub);
    await send({ type: "sub", topics: ["chat:a", "chat:b", "host"] });
    hub.setStale("host", "reconnecting");
    hub.disconnect(conn);
    expect(hub.topicCount).toBe(1); // only "host", which carries stale state
  });

  it("closes a connection that subscribes to too many topics", async () => {
    const hub = newHub();
    const { client, send } = await join(hub);
    await send({ type: "sub", topics: Array.from({ length: 65 }, (_, i) => `chat:${i}`) });
    expect(client.closed?.code).toBe(1008);
  });
});

describe("watchSubscribers", () => {
  it("reports the subscriber count on every change and stops after unwatch", async () => {
    const hub = newHub();
    const counts: number[] = [];
    const off = hub.watchSubscribers("usage", (n) => counts.push(n));
    const a = await join(hub);
    const b = await join(hub);
    await a.send({ type: "sub", topics: ["usage"] });
    await a.send({ type: "sub", topics: ["usage"] });
    await b.send({ type: "sub", topics: ["usage"] });
    hub.disconnect(a.conn);
    hub.disconnect(b.conn);
    expect(counts).toEqual([1, 2, 1, 0]);
    off();
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["usage"] });
    expect(counts).toEqual([1, 2, 1, 0]);
  });
});
