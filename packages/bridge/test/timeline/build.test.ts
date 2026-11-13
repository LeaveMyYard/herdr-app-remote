import { bridgeApi } from "@herdr-remote/protocol";
import { describe, expect, it } from "vitest";
import { askerIs, buildTimeline, isoAt, type TimelineInput } from "../../src/timeline/build.js";
import { alert, core, failed, group, host, inbox, panorama, tui } from "./helpers.js";

const T = "term-1";
const input = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  terminal: T,
  inbox: inbox([]),
  panorama: undefined,
  host: host(),
  asks: null,
  toolUseIdOf: () => undefined,
  ...over,
});
const build = (over: Partial<TimelineInput> = {}) => {
  const v = buildTimeline(input(over));
  const r = bridgeApi.TimelineTopic.safeParse(v);
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  return v;
};

describe("inbox items (§4)", () => {
  it("drops only a row the topic can't carry: a time past year 9999, a key over 200 characters", () => {
    const late = group(123, core(T), { created_at: "+012000-01-01T00:00:00Z" });
    const long = alert(456, core(T));
    long.key = `alert:${"x".repeat(200)}`;
    const v = build({ inbox: inbox([late, long, failed(119, core(T)), group(124, core(T))]) });
    expect(v.items.map((i) => i.key)).toEqual(["failed:119", "group:124"]);
  });

  it("passes on the terminal's group, alert and failed rows as they are, and nothing of another terminal", () => {
    const rows = [group(123, core(T)), group(124, core("term-2")), alert(456, core(T)), alert(457, core("term-2")), failed(119, core(T)), failed(120, core("term-2"))];
    const v = build({ inbox: inbox(rows) });
    expect(v.items.map((i) => [i.kind, i.key])).toEqual([
      ["inbox.failed", "failed:119"],
      ["inbox.alert", "alert:456"],
      ["inbox.question", "group:123"],
    ]);
    // `data` is the inbox's own row, so the phone acts on it with the same key and rev.
    expect(v.items.find((i) => i.key === "group:123")!.data).toEqual(rows[0]);
    expect(v.items.find((i) => i.key === "alert:456")!.data).toEqual(rows[2]);
  });

  it("gives every item a generic fallback: title, line and a phone route", () => {
    const v = build({ inbox: inbox([group(123, core(T)), alert(456, core(T)), failed(119, core(T))]) });
    expect(v.items.map(({ title, line, href, at, plugin }) => ({ title, line, href, at, plugin }))).toEqual([
      { title: "Answer to Q119 not delivered", line: "Delivery failed.", href: "#/inbox", at: "2026-01-02T10:00:00.000Z", plugin: "herdr-inbox" },
      { title: "Alert Title 456", line: "", href: "#/inbox", at: "2026-01-02T11:00:00.000Z", plugin: "herdr-inbox" },
      { title: "Question Title 123", line: "Question Text 123: pick one option.", href: "#/inbox/q/group%3A123/123", at: "2026-01-02T12:00:03.000Z", plugin: "herdr-inbox" },
    ]);
  });

  it("finds a herdr-tui asker by its pane's terminal, and only by an exact, single pane", () => {
    expect(askerIs(tui("pane-1"), T, host())).toBe(true);
    expect(askerIs(tui("pane-2"), T, host())).toBe(false);
    expect(askerIs(tui("pane-9"), T, host())).toBe(false);
    expect(askerIs(tui("pane-1"), T, null)).toBe(false);
    expect(askerIs({ host: "unknown", pane: null, terminal: T, tab_label: null, cwd: null }, T, host())).toBe(false);
  });

  it("leaves remote rows out, and shows nothing from an unavailable inbox", () => {
    expect(build({ inbox: inbox([group(1, core(T))], { state: "unavailable", plugin: "missing", entries: [] }) }).items).toEqual([]);
    expect(build({ inbox: undefined }).items).toEqual([]);
    expect(build({ inbox: { nope: true } }).items).toEqual([]);
  });

  it("puts an item with no readable time last", () => {
    const v = build({ inbox: inbox([group(1, core(T), { created_at: "garbage" }), group(2, core(T))]) });
    expect(v.items.map((i) => [i.key, i.at])).toEqual([
      ["group:2", "2026-01-02T12:00:02.000Z"],
      ["group:1", null],
    ]);
    expect(isoAt("")).toBe(null);
  });
});

describe("anchors: only the asker's own ask_operator call", () => {
  const ids = new Map([
    ["group:123", "toolu_A"],
    ["group:124", "toolu_B"],
  ]);
  const of = (k: string) => ids.get(k);

  it("anchors a question whose recorded call id is an ask_operator call in this terminal's transcript", () => {
    const v = build({ inbox: inbox([group(123, core(T)), group(124, core(T))]), asks: new Set(["toolu_A"]), toolUseIdOf: of });
    expect(v.items.find((i) => i.key === "group:123")!.anchor).toEqual({ tool_use_id: "toolu_A" });
    // Its id is not in this transcript (another session, another tool's call, or not read yet): placed by time.
    expect(v.items.find((i) => i.key === "group:124")!.anchor).toBe(null);
  });

  it("anchors nothing without an open chat view of the terminal", () => {
    const v = build({ inbox: inbox([group(123, core(T))]), asks: null, toolUseIdOf: of });
    expect(v.items[0]!.anchor).toBe(null);
  });

  it("anchors neither of two rows that claim one id", () => {
    const v = build({ inbox: inbox([group(123, core(T)), group(124, core(T))]), asks: new Set(["toolu_A"]), toolUseIdOf: () => "toolu_A" });
    expect(v.items.map((i) => i.anchor)).toEqual([null, null]);
  });

  it("never anchors an alert or a failed row, and never a badly shaped id", () => {
    const v = build({ inbox: inbox([alert(1, core(T)), failed(2, core(T)), group(3, core(T))]), asks: new Set(["toolu_A", "bad id"]), toolUseIdOf: (k) => (k === "group:3" ? "bad id" : "toolu_A") });
    expect(v.items.map((i) => i.anchor)).toEqual([null, null, null]);
  });
});

describe("the panorama strip (§4)", () => {
  it("counts the joined root's subagents per status, finished together, with the one that needs you", () => {
    const v = build({ panorama: panorama(T, "agent-1", ["run", "run", "done", "cxl", "wait"], {}, { hidden_finished: 1 }) });
    expect(v.strip).toEqual([
      {
        key: 'panorama.swarm:["root","herdr-core","term-1"]',
        plugin: "herdr-panorama",
        kind: "panorama.swarm",
        label: "6 subagents",
        tone: "warn",
        href: "#/swarm/space-1",
        data: { root_key: '["root","herdr-core","term-1"]', space_id: "space-1", counts: [{ code: "run", n: 2 }, { code: "done", n: 3 }, { code: "wait", n: 1 }], total: 6, needs: "n5" },
      },
    ]);
  });

  it("says bad for a blocked or failed subagent, ok while they run, muted when all are done", () => {
    expect(build({ panorama: panorama(T, "agent-1", ["run", "blk"]) }).strip[0]!.tone).toBe("bad");
    expect(build({ panorama: panorama(T, "agent-1", ["run"]) }).strip[0]).toMatchObject({ tone: "ok", label: "1 subagent" });
    expect(build({ panorama: panorama(T, "agent-1", ["done"]) }).strip[0]!.tone).toBe("muted");
  });

  it("is empty unless one fresh, live root is joined to the one host agent at this terminal", () => {
    expect(build({ panorama: panorama(T, "agent-1", []) }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, null, ["run"]) }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, "agent-2", ["run"]) }).strip).toEqual([]);
    expect(build({ panorama: panorama("term-9", "agent-1", ["run"]) }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, "agent-1", ["run"], { aged: true }) }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, "agent-1", ["run"], { stale: true }) }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, "agent-1", ["run"], { mode: "basic" }) }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, "agent-1", ["run"], {}, { live: false }) }).strip).toEqual([]);
    const two = panorama(T, "agent-1", ["run"]);
    two.roots.push({ ...two.roots[0]!, key: "other" });
    expect(build({ panorama: two }).strip).toEqual([]);
    expect(build({ panorama: panorama(T, "agent-1", ["run"]), host: undefined }).strip).toEqual([]);
  });
});

describe("the topic schema", () => {
  it("checks a known kind's data, and lets an unknown kind through with its fallback", () => {
    const base = { key: "k", plugin: "herdr-inbox", at: null, anchor: null, title: "t", line: "", href: null };
    expect(bridgeApi.TimelineItem.safeParse({ ...base, kind: "inbox.question", data: { nope: 1 } }).success).toBe(false);
    expect(bridgeApi.TimelineItem.safeParse({ ...base, kind: "someplugin.thing", data: { anything: 1 } }).success).toBe(true);
    // A link is a phone route, never a URL elsewhere.
    expect(bridgeApi.TimelineItem.safeParse({ ...base, kind: "x.y", href: "https://example.invalid/", data: null }).success).toBe(false);
    expect(bridgeApi.TimelineItem.safeParse({ ...base, kind: "x.y", href: "#/inbox", data: null }).success).toBe(true);
  });
});
