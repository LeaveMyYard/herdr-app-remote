import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { buildPanoramaTopic, normalizeParents } from "../../src/panorama/join.js";
import type { Contract, FeedView } from "../../src/panorama/feed.js";
import { agent, mkFeed, root, hostState } from "./helpers.js";

const contract = { rootKey: (r: { host: string; terminal: string | null; pane_id: string }) => JSON.stringify(["root", r.host, r.terminal ?? r.pane_id]) } as unknown as Contract;
const view = (over: Partial<FeedView> = {}): FeedView => ({ feed: mkFeed(), stale: false, aged: false, error: null, ...over });
const build = (feed: ReturnType<typeof mkFeed>, host = hostState(), v: Partial<FeedView> = {}) => buildPanoramaTopic(host, view({ feed, ...v }), contract);

describe("buildPanoramaTopic", () => {
  it("joins a core root to the host agent by exact terminal address and takes its space and name", () => {
    const t = build(mkFeed([root({ terminal: "t2", pane_id: "core:t2" })]));
    expect(t.mode).toBe("rich");
    expect(t.roots[0]).toMatchObject({ agent_id: "agent-2", space_id: "space-2", live: true, title: "Agent 2", shadowed: false });
    expect(bridgeApi.PanoramaTopic.safeParse(t).success).toBe(true);
  });

  it("never joins by anything but the address: title, cwd, pane id, a TUI host or a remote prefix", () => {
    const t = build(
      mkFeed([
        root({ terminal: "vps/t1", pane_id: "core:vps/t1", title: "Agent 1" }),
        root({ host: "herdr-tui", terminal: "t1", pane_id: "pane-9", title: "Agent 1" }),
        root({ host: "unknown", terminal: null, pane_id: "t1" }),
        root({ terminal: null, pane_id: "t1" }),
      ]),
    );
    expect(t.roots.map((r) => [r.agent_id, r.space_id, r.live])).toEqual([
      [null, null, false],
      [null, null, false],
      [null, null, false],
      [null, null, false],
    ]);
  });

  it("is basic without a lease owner, and basic without any feed", () => {
    const noOwner = build(mkFeed(), hostState({ shared: { "panorama.feed.owner": null } }));
    expect(noOwner).toMatchObject({ mode: "basic", roots: [] });
    const noFeed = buildPanoramaTopic(hostState(), view({ feed: null, stale: true, error: "feed missing" }), contract);
    expect(noFeed).toMatchObject({ mode: "basic", stale: true, error: "feed missing", roots: [] });
  });

  it("applies no join while aged, keeps the retained roots, and marks a root with a live row shadowed", () => {
    const t = build(mkFeed([root({ terminal: "t1" }), root({ terminal: "t9", pane_id: "core:t9" })]), hostState(), { aged: true, stale: true });
    expect(t.mode).toBe("rich");
    expect(t.roots.map((r) => [r.agent_id, r.space_id, r.live, r.shadowed])).toEqual([
      [null, null, false, true],
      [null, null, false, false],
    ]);
    expect(t.roots[0]?.title).toBe("Root title");
  });

  it("keeps the join for a failed read that is not aged", () => {
    const t = build(mkFeed([root({ terminal: "t1" })]), hostState(), { stale: true, error: "feed invalid" });
    expect(t).toMatchObject({ stale: true, aged: false, error: "feed invalid" });
    expect(t.roots[0]?.agent_id).toBe("agent-1");
  });

  it("maps statuses, titles and parents; unknown codes stay visible", () => {
    const t = build(
      mkFeed([
        root({
          herdr_status: "weird",
          title: "",
          tab_label: "",
          terminal: null,
          pane_id: "pane-x",
          agents: [agent("a", { status: "zzz", title: "", role: "" }), agent("b", { status: "blk", parent: "a" })],
        }),
      ]),
    );
    const r = t.roots[0]!;
    expect(r.status).toBe("unknown");
    expect(r.title).toBe("pane-x");
    expect(r.agents.map((a) => [a.id, a.title, a.status, a.parent])).toEqual([
      ["a", "a", "unknown", null],
      ["b", "Title b", "blk", "a"],
    ]);
  });

  it("caps long display text", () => {
    const t = build(mkFeed([root({ agents: [agent("a", { last_message: "x".repeat(5000) })] })]));
    expect(t.roots[0]!.agents[0]!.last_message.length).toBe(1000);
  });

  it("does not carry the local transcript path", () => {
    const feed = mkFeed([root({ agents: [{ ...agent("a"), transcript: "/home/user-1/t.jsonl" } as never] })]);
    expect(JSON.stringify(build(feed))).not.toContain("jsonl");
  });
});

describe("normalizeParents", () => {
  const p = (spec: [string, string | null][]) => Object.fromEntries(normalizeParents(spec.map(([id, parent]) => agent(id, { parent }))));
  it("turns dangling, self and cyclic parents (and what hangs off a cycle) into root children, and keeps real ones", () => {
    expect(p([["a", null], ["b", "a"], ["c", "ghost"], ["d", "d"], ["e", "f"], ["f", "e"], ["g", "e"]])).toEqual({
      a: null,
      b: "a",
      c: null,
      d: null,
      e: null,
      f: null,
      g: null,
    });
  });
});
