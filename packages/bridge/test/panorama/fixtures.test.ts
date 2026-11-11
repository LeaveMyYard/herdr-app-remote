import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { FeedReader, loadContract } from "../../src/panorama/feed.js";
import { buildPanoramaTopic } from "../../src/panorama/join.js";
import { home, hostState } from "./helpers.js";

const dir = new URL("../fixtures/panorama-feed/", import.meta.url);
const text = (n: string) => readFileSync(new URL(`${n}.json`, dir), "utf8");

/** The plugin's own fixtures, through the reader and the join, with the test contract. */
describe("copied panorama feed fixtures", () => {
  const host = hostState({
    agents: [
      { id: "agent-1", name: "Agent 1", harness: "codex", state: "working", space_id: "space-1", terminal_id: "t2" },
      { id: "agent-2", name: "Agent 2", harness: "claude", state: "idle", space_id: "space-2", terminal_id: "t7" },
    ],
  });

  it("swarm.json: one tree of 13 agents, joined by address; remote t7 stays unmatched", async () => {
    const h = home(JSON.parse(text("swarm")) as unknown);
    const reader = new FeedReader(h, () => 1_800_000_000_000);
    const view = await reader.read();
    expect(view).toMatchObject({ stale: false, aged: false });
    const t = buildPanoramaTopic(host, view, reader.contractFor());
    expect(bridgeApi.PanoramaTopic.safeParse(t).success).toBe(true);
    expect(t.roots).toHaveLength(6);
    const billing = t.roots.find((r) => r.terminal === "t2")!;
    expect(billing).toMatchObject({ agent_id: "agent-1", space_id: "space-1", title: "Agent 1", hidden_finished: 2, inbox: [14, 15] });
    expect(billing.agents).toHaveLength(13);
    expect(new Set(billing.agents.map((a) => a.id)).size).toBe(13);
    expect(t.roots.find((r) => r.terminal === "vps/t7")).toMatchObject({ agent_id: null, live: false });
    expect(t.roots.filter((r) => r.agent_id !== null)).toHaveLength(1);
  });

  it("degraded.json: sources unavailable is data, not an empty successful swarm marker", async () => {
    const reader = new FeedReader(home(JSON.parse(text("degraded")) as unknown), () => 1_800_000_000_000);
    const view = await reader.read();
    const t = buildPanoramaTopic(host, view, reader.contractFor());
    expect(t).toMatchObject({ mode: "rich", roots: [] });
  });

  it("own-blocked.json: the blocked root maps to blk", async () => {
    const reader = new FeedReader(home(JSON.parse(text("own-blocked")) as unknown), () => 1_800_000_000_000);
    const t = buildPanoramaTopic(host, await reader.read(), reader.contractFor());
    expect(t.roots.some((r) => r.status === "blk")).toBe(true);
  });
});

/** Local only: the installed plugin's real contract.js against the copied fixtures (CI has no plugin). */
const installed = join(process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app"), "mods/panorama/contract.js");
const real = process.env.S8_REAL_CONTRACT === "1" && existsSync(installed);
describe.runIf(real)("real contract.js (S8_REAL_CONTRACT=1)", () => {
  it.each(["swarm", "own-blocked", "degraded"])("%s validates, and the topic builds from it", async (n) => {
    const appHome = process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app");
    const loaded = await loadContract(appHome);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const feed = loaded.contract.parseFeed(text(n));
    const t = buildPanoramaTopic(hostState(), { feed, stale: false, aged: false, error: null }, loaded.contract);
    expect(bridgeApi.PanoramaTopic.safeParse(t).success).toBe(true);
  });
});
