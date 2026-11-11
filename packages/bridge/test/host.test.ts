import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostTopic, type HostSink, type HostSource } from "../src/host.js";
import { fixture, join, newHub } from "./helpers.js";

class FakeSource implements HostSource {
  sink!: HostSink;
  probe: boolean | undefined = false;
  probes = 0;
  started = false;
  subscribe(sink: HostSink): void {
    this.sink = sink;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
  async layoutHasLink(): Promise<boolean | undefined> {
    this.probes++;
    return this.probe;
  }
}

async function setup(grace = 5000) {
  const hub = newHub();
  const source = new FakeSource();
  const invalid: string[] = [];
  const topic = new HostTopic({ hub, source, layoutGraceMs: grace, onInvalid: (e) => invalid.push(e) });
  await topic.start();
  const c = await join(hub);
  await c.send({ type: "sub", topics: ["host"] });
  return { hub, source, topic, c, invalid };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("host topic", () => {
  it("before any state, subscribers see stale reconnecting and no snap", async () => {
    const { c, source } = await setup();
    expect(source.started).toBe(true);
    expect(c.client.got.map((m) => m.type)).toEqual(["welcome", "stale"]);
  });

  it("publishes state as snap then patches", async () => {
    const { c, source } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.state(fixture("idle-and-done"));
    expect(c.client.got.map((m) => m.type)).toEqual(["welcome", "stale", "snap", "patch"]);
  });

  it("drops invalid state without publishing or clearing staleness", async () => {
    const { c, source, hub, invalid } = await setup();
    source.sink.state({ spaces: "nope" });
    expect(invalid).toHaveLength(1);
    expect(hub.get("host")).toBeUndefined();
    expect(c.client.ofType("snap")).toHaveLength(0);
    expect(hub.isStale("host")).toBe("reconnecting");
  });

  it("disconnect goes stale reconnecting and keeps the last state", async () => {
    const { c, source, hub } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.disconnected();
    expect(hub.isStale("host")).toBe("reconnecting");
    expect(hub.get("host")).toEqual(fixture("typical"));
    expect(c.client.ofType("stale").at(-1)?.reason).toBe("reconnecting");
  });

  it("a new hello within the grace period clears stale with a snap and never probes", async () => {
    const { c, source, hub } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.disconnected();
    await vi.advanceTimersByTimeAsync(4000);
    source.sink.state(fixture("typical"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(source.probes).toBe(0);
    expect(hub.isStale("host")).toBeNull();
    expect(c.client.ofType("snap")).toHaveLength(2);
  });

  it("after 5 s with no hello and a layout without the link: layout_without_remote", async () => {
    const { source, hub } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.disconnected();
    await vi.advanceTimersByTimeAsync(4999);
    expect(hub.isStale("host")).toBe("reconnecting");
    expect(source.probes).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(source.probes).toBe(1);
    expect(hub.isStale("host")).toBe("layout_without_remote");
  });

  it("stays reconnecting when the layout has the link, or the probe can't tell or throws", async () => {
    const { source, hub } = await setup();
    source.sink.state(fixture("typical"));
    for (const p of [true, undefined]) {
      source.probe = p;
      source.sink.disconnected();
      await vi.advanceTimersByTimeAsync(5001);
      expect(hub.isStale("host")).toBe("reconnecting");
    }
    source.layoutHasLink = () => Promise.reject(new Error("x"));
    source.sink.disconnected();
    await vi.advanceTimersByTimeAsync(5001);
    expect(hub.isStale("host")).toBe("reconnecting");
  });

  it("a hello that lands while the probe is in flight wins", async () => {
    const { source, hub } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.disconnected();
    let release!: (v: boolean) => void;
    source.layoutHasLink = () => new Promise<boolean>((r) => (release = r));
    await vi.advanceTimersByTimeAsync(5001);
    source.sink.state(fixture("typical"));
    release(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.isStale("host")).toBeNull();
  });

  it("recovers from layout_without_remote when a link returns", async () => {
    const { source, hub } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.disconnected();
    await vi.advanceTimersByTimeAsync(5001);
    expect(hub.isStale("host")).toBe("layout_without_remote");
    source.sink.state(fixture("idle-and-done"));
    expect(hub.isStale("host")).toBeNull();
    expect(hub.get("host")).toEqual(fixture("idle-and-done"));
  });

  it("unavailable marks source_unavailable and stop ignores later events", async () => {
    const { source, hub, topic } = await setup();
    source.sink.state(fixture("typical"));
    source.sink.unavailable();
    expect(hub.isStale("host")).toBe("source_unavailable");
    await topic.stop();
    expect(source.started).toBe(false);
    source.sink.state(fixture("idle-and-done"));
    expect(hub.get("host")).toEqual(fixture("typical"));
  });
});
