import { bridgeApi } from "@herdr-remote/protocol";
import { describe, expect, it } from "vitest";
import { agentsTopic, BOARD_NOW, boardHost, swarmTopic } from "../src/fixtures";
import { age, statusWord } from "../src/panorama/format";
import { buildSwarmRows, nodeUid, rootTiles, selectAgents, selectBasic, selectSpaces, swarmScope, swarmStats, type SwarmUi } from "../src/panorama/select";

type Root = bridgeApi.PanoramaRoot;
type Node = bridgeApi.PanoramaNode;

const node = (id: string, over: Partial<Node> = {}): Node => ({
  id,
  parent: null,
  harness: "claude",
  title: `Title ${id}`,
  role: "",
  model: null,
  status: "run",
  activity: "",
  last_message: "",
  pending: [],
  question_ids: [],
  error: null,
  tool_calls: 0,
  started: null,
  ended: null,
  last_at: null,
  seq: 0,
  ...over,
});
const root = (over: Partial<Root> = {}): Root => ({
  key: "r1",
  agent_id: null,
  space_id: null,
  terminal: null,
  live: false,
  shadowed: false,
  harness: "claude",
  title: "Root 1",
  tab_no: null,
  status: "run",
  inbox: [],
  hidden_finished: 0,
  last_activity: null,
  agents: [],
  ...over,
});
const topic = (roots: Root[], over: Partial<bridgeApi.PanoramaTopic> = {}): bridgeApi.PanoramaTopic => ({ mode: "rich", stale: false, aged: false, error: null, collected_at: BOARD_NOW, roots, ...over });
const ui = (over: Partial<SwarmUi> = {}): SwarmUi => ({ open: {}, sel: null, ...over });

describe("fixtures", () => {
  it("the board topics are valid panorama topics", () => {
    expect(bridgeApi.PanoramaTopic.safeParse(agentsTopic).success).toBe(true);
    expect(bridgeApi.PanoramaTopic.safeParse(swarmTopic).success).toBe(true);
  });
});

describe("format", () => {
  it("ages are coarse and never negative", () => {
    expect([age(100, 130), age(100, 100 + 59 * 60), age(100, 100 + 7200), age(100, 100 + 3 * 86400), age(200, 100), age(null, 1)]).toEqual(["<1m", "59m", "2h", "3d", "<1m", ""]);
  });
  it("every status has a word", () => {
    for (const c of bridgeApi.AGENT_CODES) expect(statusWord(c)).not.toBe("");
  });
});

describe("rootTiles", () => {
  it("one tile per live agent in feed order, then one finished tile counting finished agents and hidden_finished", () => {
    const r = root({ hidden_finished: 1, agents: [node("a", { status: "run" }), node("b", { status: "rev" }), node("c", { status: "done" }), node("d", { status: "cxl" }), node("e", { status: "run" })] });
    expect(rootTiles(r)).toEqual([{ code: "run" }, { code: "rev" }, { code: "run" }, { code: "done", count: 3 }]);
  });
  it("caps live tiles at six and shows no finished tile when there is none", () => {
    const r = root({ agents: Array.from({ length: 9 }, (_, i) => node(`a${i}`)) });
    expect(rootTiles(r)).toHaveLength(6);
  });
});

describe("selectAgents", () => {
  const view = selectAgents(boardHost, agentsTopic);
  it("groups by space in host order with every joined root as an enriched card", () => {
    expect(view.groups.map((g) => [g.label, g.cards.length])).toEqual([["Project Alpha", 3], ["Project Beta", 3], ["Sandbox", 1]]);
    const a1 = view.groups[0]!.cards[0]!;
    expect(a1).toMatchObject({ n: 2, st: "run", questions: 1, sweep: true, meta: "Project Alpha · tab 2 · 2 active · 3 agents" });
    expect(a1.tiles).toEqual([{ code: "run" }, { code: "run" }, { code: "done", count: 1 }]);
  });
  it("totals open questions only across roots joined to a space", () => {
    expect(view.questions).toBe(1);
  });
  it("gives each space its needs and working tiles", () => {
    expect(view.spaces.map((s) => s.tiles)).toEqual([[{ code: "wait", count: 1 }, { code: "run" }], [{ code: "run" }], [{ code: "run" }]]);
  });
  it("keeps every host agent row, even with no feed root (including an unsupported harness)", () => {
    const t = topic(agentsTopic.roots.filter((r) => r.agent_id !== "a-2"));
    const v = selectAgents({ ...boardHost, agents: boardHost.agents.map((a) => (a.id === "a-2" ? { ...a, harness: "gemini" } : a)) }, t);
    const card = v.groups[0]!.cards.find((c) => c.title.startsWith("Agent 2"))!;
    expect(card).toMatchObject({ harness: "gemini", st: "run", tiles: [], href: "#/chat/a-2", meta: "Project Alpha" });
  });
  it("lists a feed root that matched no live row, but not a stale duplicate of a live one", () => {
    const loose = root({ key: "x", title: "Loose root" });
    const dup = root({ key: "y", title: "Duplicate", shadowed: true });
    const v = selectAgents(boardHost, topic([loose, dup]));
    expect(v.groups.at(-1)).toMatchObject({ id: "roots", label: "Other roots" });
    expect(v.groups.at(-1)?.cards.map((c) => c.title)).toEqual(["Loose root"]);
    expect(v.groups.at(-1)?.cards[0]?.meta).toContain("Not in a space");
  });
  it("shows host agents of an unknown space under Other", () => {
    const v = selectAgents({ ...boardHost, agents: [{ id: "z", name: "Agent Z", harness: "claude", state: "idle", space_id: "nope" }] }, topic([]));
    expect(v.groups).toEqual([expect.objectContaining({ id: "other", label: "Other" })]);
  });
  it("tiles counts fail and blocked agents and root questions", () => {
    const r = root({ agent_id: "a-1", space_id: "sp-1", status: "blk", inbox: [1, 2], agents: [node("f", { status: "fail" }), node("b", { status: "blk" })] });
    const [s1] = selectSpaces(boardHost, topic([r]));
    expect(s1?.tiles).toEqual([{ code: "fail", count: 1 }, { code: "blk", count: 2 }, { code: "wait", count: 2 }]);
  });
});

describe("selectBasic", () => {
  it("maps host agent states, leaving tab and age empty", () => {
    const rows = selectBasic({ ...boardHost, agents: [{ id: "1", name: "A", harness: "codex", state: "waiting", space_id: "sp-1", terminal_id: "t2" }, { id: "2", name: "B", harness: "claude", state: "error", space_id: "sp-1" }, { id: "3", name: "C", harness: "claude", state: "unknown", space_id: "sp-1" }] });
    expect(rows.map((r) => [r.status, r.tab, r.age])).toEqual([["needs-you", "t2", ""], ["needs-you", "", ""], ["idle", "", ""]]);
  });
});

describe("swarmScope", () => {
  it("a space shows the roots joined to it", () => {
    expect(swarmScope(boardHost, agentsTopic, "sp-2").roots.map((r) => r.title)).toHaveLength(3);
    expect(swarmScope(boardHost, agentsTopic, "sp-2").label).toBe("Project Beta");
  });
  it("never goes empty while aged: every retained root is shown, since nothing is joined", () => {
    const aged = topic(agentsTopic.roots.map((r) => ({ ...r, agent_id: null, space_id: null, live: false })), { aged: true, stale: true });
    const scope = swarmScope(boardHost, aged, "sp-1");
    expect(scope.roots).toHaveLength(7);
    expect(scope.label).toBe("All roots");
  });
});

describe("swarmStats", () => {
  it("counts roots, agents and questions, and lights needs and working", () => {
    expect(swarmStats(swarmTopic.roots)).toEqual({ roots: 3, agents: 7, questions: 1, needs: true, working: true, done: false });
    expect(swarmStats([root({ status: "done", agents: [node("a", { status: "done" })] })])).toMatchObject({ needs: false, working: false, done: true });
  });
});

describe("buildSwarmRows", () => {
  const r1 = swarmTopic.roots[0]!;
  const open = ui({ open: { [r1.key]: true, [nodeUid(r1, "k2")]: true }, sel: nodeUid(r1, "a1b2c3d4e5f6") });
  const rows = buildSwarmRows(swarmTopic.roots, open, BOARD_NOW);

  it("lists roots and open nodes in order, folding the finished leaves of a parent into one row", () => {
    expect(rows.map((r) => [r.kind, r.title])).toEqual([
      ["root", "Agent 1 · Parser rewrite"],
      ["node", "Explore · token passes"],
      ["node", "Plan · split strategy"],
      ["node", "Explore · lexer edge cases"],
      ["node", "Explore · old fixtures"],
      ["fold", "1 finished · Docs · README pass"],
      ["node", "Review · parse/mod.rs"],
      ["root", "Agent 2 · Test cleanup"],
      ["root", "Agent 3 · Docs pass"],
    ]);
  });
  it("draws the tree guides: tee for a middle sibling, end for the last, pass columns below a continuing parent", () => {
    const g = (title: string) => rows.find((r) => r.title === title)?.guides;
    expect(g("Explore · token passes")).toEqual(["tee"]);
    expect(g("Review · parse/mod.rs")).toEqual(["end"]);
    expect(g("Explore · lexer edge cases")).toEqual(["pass", "tee"]);
    expect(g("Explore · old fixtures")).toEqual(["pass", "end"]);
    expect(g("Agent 1 · Parser rewrite")).toEqual([]);
  });
  it("marks the selected row, its ancestors, carets and the needs state", () => {
    const sel = rows.find((r) => r.selected)!;
    expect(sel.title).toBe("Explore · token passes");
    expect(sel.agentLine).toBe("Explore a1b2c3d4e5f6 · opus · <1m · 42 calls");
    expect(rows.filter((r) => r.onPath).map((r) => r.title)).toEqual(["Agent 1 · Parser rewrite"]);
    const caret = (t: string) => rows.find((r) => r.title === t);
    expect([caret("Plan · split strategy")?.open, caret("Explore · lexer edge cases")?.hasKids, caret("Explore · lexer edge cases")?.open, caret("Explore · old fixtures")?.hasKids]).toEqual([true, true, false, false]);
    expect(caret("Review · parse/mod.rs")?.needs).toBe(true);
    expect(caret("Agent 1 · Parser rewrite")?.questions).toBe(1);
  });
  it("shows children only for open nodes", () => {
    const closed = buildSwarmRows(swarmTopic.roots, ui(), BOARD_NOW);
    expect(closed.map((r) => r.kind)).toEqual(["root", "root", "root"]);
  });
  it("shows the older finished count in the root's fold, even with no finished leaf", () => {
    const r = root({ hidden_finished: 4, agents: [node("a")] });
    const out = buildSwarmRows([r], ui({ open: { r1: true } }), 0);
    expect(out.map((x) => x.title)).toEqual(["Root 1", "Title a", "+4 older"]);
    const withLeaf = root({ hidden_finished: 2, agents: [node("a", { status: "done" })] });
    expect(buildSwarmRows([withLeaf], ui({ open: { r1: true } }), 0).at(-1)?.title).toBe("1 finished · Title a · +2 older");
  });
  it("keeps agent ids that repeat across roots apart", () => {
    const a = root({ key: "A", agents: [node("same")] });
    const b = root({ key: "B", agents: [node("same")] });
    const out = buildSwarmRows([a, b], ui({ open: { A: true, B: true } }), 0);
    expect(new Set(out.map((r) => r.uid)).size).toBe(out.length);
  });
  it("a finished node that still has children stays a card, not a fold", () => {
    const r = root({ agents: [node("p", { status: "done" }), node("c", { parent: "p" })] });
    const out = buildSwarmRows([r], ui({ open: { r1: true, [nodeUid(r, "p")]: true } }), 0);
    expect(out.map((o) => [o.kind, o.title])).toEqual([["root", "Root 1"], ["node", "Title p"], ["node", "Title c"]]);
  });
});
