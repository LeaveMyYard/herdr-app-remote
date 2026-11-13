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

/** A `usage` topic value: claude-1 lists term-1 as a pane (primary window 62% left), claude-2 lists term-2. */
const usage = (over: { limit?: "used" | "remaining"; providers?: Record<string, unknown>[]; report?: boolean } = {}) => ({
  filter: "open-panes",
  updatedAtMs: 1,
  report:
    over.report === false
      ? null
      : {
          version: 1,
          generatedAtMs: 1,
          filter: "open-panes",
          limitPercent: over.limit ?? "remaining",
          providers: over.providers ?? [account("claude-1", "Account 1", ["term-1"], 62, "high"), account("claude-2", "Account 2", ["term-2"], 10, "low")],
        },
});
const account = (id: string, profile: string, panes: string[], display: number, band: string, over: Record<string, unknown> = {}) => ({
  providerId: id,
  family: "claude",
  label: id,
  profileLabel: profile,
  accountLabel: "user-1@example.com",
  status: "ok",
  inUse: true,
  windows: [{ slot: "primary", tag: "5h", windowMinutes: 300, displayPercent: display, barFill: display / 100, band, resetIn: "2h" }],
  paneActivity: { panes: panes.map((paneId) => ({ paneId })) },
  ...over,
});

describe("the account strip chip (CV6)", () => {
  it("names the terminal's account by its profile and says how much of its first window is used", () => {
    expect(build({ usage: usage() }).strip).toEqual([
      {
        key: "usage.account:claude-1",
        plugin: "herdr-agent-usage",
        kind: "usage.account",
        label: "Account 1 · 38% used",
        tone: "ok",
        href: "#/usage",
        data: { provider_id: "claude-1", account: "Account 1", used_percent: 38, window: "5h" },
      },
    ]);
  });

  it("counts used whichever way the report prints, and takes the tone from the band", () => {
    expect(build({ usage: usage({ limit: "used", providers: [account("claude-1", "Account 1", [T], 38, "high")] }) }).strip[0]).toMatchObject({ label: "Account 1 · 38% used", tone: "ok" });
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 30, "mid")] }) }).strip[0]).toMatchObject({ label: "Account 1 · 70% used", tone: "warn" });
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 5, "low")] }) }).strip[0]).toMatchObject({ label: "Account 1 · 95% used", tone: "bad" });
  });

  it("falls back to the account label, then the provider's, and shows no use when there is no window", () => {
    const p = account("claude-1", "", [T], 62, "high", { windows: [], status: "no-data" });
    expect(build({ usage: usage({ providers: [p] }) }).strip[0]).toMatchObject({ label: "user-1@example.com", tone: "muted", data: { used_percent: null, window: null } });
    const q = account("claude-1", "", [T], 62, "high", { accountLabel: null });
    expect(build({ usage: usage({ providers: [q] }) }).strip[0]).toMatchObject({ label: "claude-1 · 38% used" });
  });

  it("clamps the use to 0..100, since the report's displayPercent has no bounds", () => {
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 130, "high")] }) }).strip[0]).toMatchObject({ label: "Account 1 · 0% used", data: { used_percent: 0 } });
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], -5, "low")] }) }).strip[0]).toMatchObject({ label: "Account 1 · 100% used", data: { used_percent: 100 } });
    expect(build({ usage: usage({ limit: "used", providers: [account("claude-1", "Account 1", [T], 250, "low")] }) }).strip[0]).toMatchObject({ data: { used_percent: 100 } });
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 61.6, "high")] }) }).strip[0]).toMatchObject({ data: { used_percent: 38 } });
  });

  it("cuts a long name or window tag to fit instead of losing the chip; an empty name draws none", () => {
    const long = account("claude-1", "N".repeat(500), [T], 62, "high", { windows: [{ slot: "primary", tag: "w".repeat(90), windowMinutes: 1, displayPercent: 62, barFill: 0.62, band: "high", resetIn: "" }] });
    const [chip] = build({ usage: usage({ providers: [long] }) }).strip;
    expect(chip!.label.length).toBeLessThanOrEqual(200);
    expect(chip!.label.endsWith(" · 38% used")).toBe(true);
    expect((chip!.data as bridgeApi.UsageStripData).window!.length).toBeLessThanOrEqual(40);
    expect(build({ usage: usage({ providers: [account("claude-1", "", [T], 62, "high", { accountLabel: null, label: "" })] }) }).strip).toEqual([]);
  });

  it("shows the primary window whatever the order the report lists them in", () => {
    const w = (slot: string, tag: string, display: number) => ({ slot, tag, windowMinutes: 1, displayPercent: display, barFill: 0, band: "high", resetIn: "" });
    const p = account("claude-1", "Account 1", [T], 0, "high", { windows: [w("secondary", "7d", 10), w("primary", "5h", 80)] });
    expect(build({ usage: usage({ providers: [p] }) }).strip[0]).toMatchObject({ label: "Account 1 · 20% used", data: { window: "5h" } });
  });

  it("sits after the subagent link", () => {
    const v = build({ panorama: panorama(T, "agent-1", ["run"]), usage: usage() });
    expect(v.strip.map((s) => s.kind)).toEqual(["panorama.swarm", "usage.account"]);
  });

  it("draws nothing for a terminal no account lists, an unused entry, or no usable report", () => {
    expect(build({ usage: usage({ providers: [account("claude-2", "Account 2", ["term-2"], 10, "low")] }) }).strip).toEqual([]);
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 62, "high", { inUse: false })] }) }).strip).toEqual([]);
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 62, "high", { paneActivity: null })] }) }).strip).toEqual([]);
    expect(build({ usage: usage({ report: false }) }).strip).toEqual([]);
    expect(build({ usage: undefined }).strip).toEqual([]);
    expect(build({ usage: { nonsense: true } }).strip).toEqual([]);
  });

  it("treats two entries of one account as one, and two accounts for one terminal as ambiguous", () => {
    // What agent-usage produces: a pane is listed under one entry only, here the duplicate; the chip is the canonical
    // account's (the Usage row it links to), with the canonical entry's label, key and window.
    const dup = [account("claude-2", "Account 2", [], 40, "mid", { paneActivity: null }), account("claude-2-dup", "claude", [T], 62, "high", { sameAccountAs: "claude-2" })];
    expect(build({ usage: usage({ providers: dup }) }).strip).toMatchObject([{ key: "usage.account:claude-2", label: "Account 2 · 60% used", tone: "warn" }]);
    // Both entries listing the pane is still one account.
    const both = [account("claude-2-dup", "claude", [T], 62, "high", { sameAccountAs: "claude-2" }), account("claude-2", "Account 2", [T], 62, "high")];
    expect(build({ usage: usage({ providers: both }) }).strip.map((s) => s.label)).toEqual(["Account 2 · 38% used"]);
    expect(build({ usage: usage({ providers: [account("claude-1", "Account 1", [T], 62, "high"), account("claude-2", "Account 2", [T], 10, "low")] }) }).strip).toEqual([]);
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
