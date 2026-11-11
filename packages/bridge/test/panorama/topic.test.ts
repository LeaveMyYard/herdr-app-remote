import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { PanoramaTopicDriver } from "../../src/panorama/topic.js";
import { FeedReader } from "../../src/panorama/feed.js";
import type { Json } from "../../src/patch.js";
import { join as joinHub, newHub } from "../helpers.js";
import { agent, home, hostState, mkFeed, NOW, put, root, CONTRACT } from "./helpers.js";

let driver: PanoramaTopicDriver | undefined;
afterEach(() => driver?.stop());

const FEED = "data/panorama/feed.json";
const feedPath = (h: string) => join(h, FEED);
const topic = (hub: ReturnType<typeof newHub>) => bridgeApi.PanoramaTopic.parse(hub.get("panorama"));

function setup(h: string, clock = { t: NOW }) {
  const hub = newHub();
  hub.publish("host", hostState() as unknown as Json);
  driver = new PanoramaTopicDriver({ hub, appHome: h, now: () => clock.t, intervalMs: 3_600_000 });
  return { hub, driver, clock };
}

describe("FeedReader", () => {
  it("keeps the last good feed through an invalid, oversized, deleted and unreadable feed, with a fixed sentence and no path", async () => {
    const h = home(mkFeed([root({ agents: [agent("a")] })]));
    const reader = new FeedReader(h, () => NOW);
    const first = await reader.read();
    expect(first).toMatchObject({ stale: false, aged: false, error: null });
    expect(first.feed?.roots[0]?.agents).toHaveLength(1);

    const cases: [() => void, string][] = [
      [() => writeFileSync(feedPath(h), "{not json"), "feed invalid"],
      [() => writeFileSync(feedPath(h), JSON.stringify({ v: 3, roots: [] })), "feed invalid"],
      [() => writeFileSync(feedPath(h), "x".repeat(1_048_577)), "feed too large"],
      [() => rmSync(feedPath(h)), "feed missing"],
      [() => mkdirSync(feedPath(h)), "feed unreadable"],
      [() => { rmSync(feedPath(h), { recursive: true }); writeFileSync(feedPath(h), JSON.stringify(mkFeed([]))); }, ""],
    ];
    for (const [change, error] of cases) {
      change();
      const v = await reader.read();
      if (error) {
        expect(v).toMatchObject({ stale: true, error });
        expect(v.feed?.roots[0]?.agents).toHaveLength(1);
        expect(v.error).not.toContain(h);
      } else {
        expect(v).toMatchObject({ stale: false, error: null });
        expect(v.feed?.roots).toHaveLength(0);
      }
    }
  });

  it("reports a missing feed without ever having had one as stale with no feed", async () => {
    const reader = new FeedReader(home(null), () => NOW);
    expect(await reader.read()).toMatchObject({ feed: null, stale: true, error: "feed missing" });
  });

  it("marks a feed older than 15 s as aged and stale, and a failed contract as unusable", async () => {
    const reader = new FeedReader(home(mkFeed([], { generated_at: NOW / 1000 - 16 })), () => NOW);
    expect(await reader.read()).toMatchObject({ aged: true, stale: true, error: null });
    // The receipt pins the original bytes; the file on disk is the tampered one.
    const h = home(mkFeed());
    put(h, "mods/panorama/contract.js", CONTRACT + "// tampered");
    expect(await new FeedReader(h, () => NOW).read()).toMatchObject({ feed: null, stale: true, error: "contract unavailable" });
  });
});

describe("panorama topic driver", () => {
  it("goes basic with the contract error when contract.js stops verifying mid-run", async () => {
    const h = home();
    const { hub, driver, clock } = setup(h);
    await driver.start();
    expect(topic(hub).mode).toBe("rich");
    put(h, "mods/panorama/contract.js", CONTRACT + "// tampered");
    clock.t = NOW + 61_000;
    writeFileSync(feedPath(h), JSON.stringify(mkFeed([root()], { generated_at: clock.t / 1000 - 1 })));
    await driver.refresh();
    expect(topic(hub)).toMatchObject({ mode: "basic", stale: true, error: "contract unavailable", roots: [] });
  });

  it("publishes nothing until the host topic exists", async () => {
    const hub = newHub();
    driver = new PanoramaTopicDriver({ hub, appHome: home(), now: () => NOW, intervalMs: 3_600_000 });
    await driver.start();
    expect(hub.get("panorama")).toBeUndefined();
    hub.publish("host", hostState() as unknown as Json);
    await driver.refresh();
    expect(topic(hub).mode).toBe("rich");
  });

  it("a feed error never shows an empty swarm: the retained roots stay, marked stale", async () => {
    const h = home(mkFeed([root({ terminal: "t1", agents: [agent("a"), agent("b", { parent: "a" })] })]));
    const { hub, driver } = setup(h);
    await driver.start();
    expect(topic(hub).roots[0]?.agents).toHaveLength(2);
    writeFileSync(feedPath(h), "garbage");
    await driver.refresh();
    expect(topic(hub)).toMatchObject({ mode: "rich", stale: true, error: "feed invalid" });
    expect(topic(hub).roots[0]?.agents).toHaveLength(2);
    writeFileSync(feedPath(h), JSON.stringify(mkFeed([root({ terminal: "t1", agents: [agent("a")] })])));
    await driver.refresh();
    expect(topic(hub)).toMatchObject({ stale: false, error: null });
    expect(topic(hub).roots[0]?.agents).toHaveLength(1);
  });

  it("falls back to basic when the lease owner goes away, and back to rich when it returns", async () => {
    const { hub, driver } = setup(home());
    await driver.start();
    expect(topic(hub).mode).toBe("rich");
    hub.publish("host", hostState({ shared: { "panorama.feed.owner": null } }) as unknown as Json);
    await driver.refresh();
    expect(topic(hub)).toMatchObject({ mode: "basic", roots: [] });
    hub.publish("host", hostState() as unknown as Json);
    await driver.refresh();
    expect(topic(hub).mode).toBe("rich");
  });

  it("drops the join when the feed turns 15 s old, and restores it on a fresh collection", async () => {
    const h = home(mkFeed([root({ terminal: "t1" })]));
    const { hub, driver, clock } = setup(h);
    await driver.start();
    expect(topic(hub).roots[0]).toMatchObject({ agent_id: "agent-1", space_id: "space-1" });
    clock.t = NOW + 20_000;
    await driver.refresh();
    expect(topic(hub)).toMatchObject({ aged: true, stale: true });
    expect(topic(hub).roots[0]).toMatchObject({ agent_id: null, space_id: null, live: false, shadowed: true });
    writeFileSync(feedPath(h), JSON.stringify(mkFeed([root({ terminal: "t1" })], { generated_at: clock.t / 1000 - 1 })));
    await driver.refresh();
    expect(topic(hub)).toMatchObject({ aged: false, stale: false });
    expect(topic(hub).roots[0]?.agent_id).toBe("agent-1");
  });

  it("sends a subscriber a snap and then only a patch for what changed", async () => {
    const h = home(mkFeed([root({ agents: [agent("a")] })]));
    const { hub, driver } = setup(h);
    await driver.start();
    const c = await joinHub(hub);
    await c.send({ type: "sub", topics: ["panorama"] });
    expect(c.client.ofType("snap")).toHaveLength(1);
    writeFileSync(feedPath(h), JSON.stringify(mkFeed([root({ agents: [agent("a", { activity: "other" })] })])));
    await driver.refresh();
    const patches = c.client.ofType("patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.ops.every((o) => o.path.includes("activity"))).toBe(true);
  });
});
