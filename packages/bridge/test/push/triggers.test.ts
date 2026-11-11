import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { BLOCKED_COOLDOWN_MS, PushTriggers } from "../../src/push/triggers.js";
import { summarize } from "../../src/push/service.js";

const load = (p: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../../../fixtures/${p}`, import.meta.url), "utf8")) as Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);

type Inbox = bridgeApi.InboxTopic;
type Pano = bridgeApi.PanoramaTopic;

/** The typical inbox with every row not new. */
function inbox(): Inbox {
  const t = bridgeApi.InboxTopic.parse(load("bridge-api/inbox/typical.json"));
  for (const r of t.entries) r.new = false;
  return t;
}
const panorama = (): Pano => bridgeApi.PanoramaTopic.parse(load("bridge-api/panorama/rich.json"));
/** A host where terminal t1 is "Agent 1". */
function host() {
  const h = load("host/typical.json") as { agents: { terminal_id?: string }[] };
  h.agents[0]!.terminal_id = "t1";
  return h;
}

function withRow(t: Inbox, row: Inbox["entries"][number]): Inbox {
  return { ...t, entries: [...t.entries, row] };
}

function newGroup(id: number, over: Record<string, unknown> = {}): Inbox["entries"][number] {
  const base = clone(inbox().entries.find((r) => r.key === "group:123")!) as Record<string, unknown>;
  const q = (base.questions as Record<string, unknown>[])[0]!;
  return bridgeApi.InboxRow.parse({
    ...base,
    key: `group:${id}`,
    group: id,
    title: `Question Title ${id}`,
    new: true,
    questions: [{ ...q, id, question: `SECRET question body ${id}` }],
    ...over,
  });
}

describe("push triggers: inbox", () => {
  it("announces a new question group once, as 'Agent 1: Question Title N', never with the question text", () => {
    const tr = new PushTriggers();
    expect(tr.observe({ inbox: inbox(), panorama: undefined, host: host() }, 0)).toEqual([]);
    const t = withRow(inbox(), newGroup(130));
    const ev = tr.observe({ inbox: t, panorama: undefined, host: host() }, 1000);
    expect(ev).toEqual([{ kind: "question", title: "Agent 1: Question Title 130", body: "New question", tag: "q-130", url: "#/inbox/q/group%3A130/130", audit: "group 130" }]);
    expect(JSON.stringify(ev)).not.toContain("SECRET");
    // Still `new` on the next readings: not announced again.
    expect(tr.observe({ inbox: t, panorama: undefined, host: host() }, 2000)).toEqual([]);
  });

  it("announces only rows the inbox marks new: rows that were already open are never announced", () => {
    // The inbox topic marks rows `new` only after its own first good feed (app-feed-v1 toast marks), so after a
    // bridge restart every open row reads `new: false`.
    const tr = new PushTriggers();
    for (let i = 0; i < 3; i++) expect(tr.observe({ inbox: withRow(inbox(), { ...newGroup(130), new: false }), panorama: undefined, host: host() }, i)).toEqual([]);
  });

  it("opens the group's first question without a draft", () => {
    const tr = new PushTriggers();
    const g = newGroup(160) as { questions: Record<string, unknown>[] };
    const q = g.questions[0]!;
    g.questions = [
      { ...q, id: 160, draft: { choices: ["Option A"], notes: {}, text: null } },
      { ...q, id: 161 },
    ];
    const ev = tr.observe({ inbox: withRow(inbox(), bridgeApi.InboxRow.parse(g)), panorama: undefined, host: host() }, 0);
    expect(ev[0]!.url).toBe("#/inbox/q/group%3A160/161");
    expect(ev[0]!.body).toBe("2 new questions");
  });

  it("falls back to the tab label, then asked_by, then a neutral word; and to the header, never the question", () => {
    const tr = new PushTriggers();
    const noHost = tr.observe({ inbox: withRow(inbox(), newGroup(131, { title: null })), panorama: undefined, host: undefined }, 0);
    expect(noHost[0]!.title).toBe("agent-1: Choice");
    const g = newGroup(132, { title: null, asker: { host: "herdr-core", pane: null, terminal: "t9", tab_label: "Project Alpha", cwd: "/home/user-1/secret-dir" } });
    (g as { questions: { header: string | null; asked_by: string | null }[] }).questions[0]!.header = null;
    (g as { questions: { header: string | null; asked_by: string | null }[] }).questions[0]!.asked_by = null;
    const ev = tr.observe({ inbox: withRow(inbox(), g), panorama: undefined, host: host() }, 1);
    expect(ev[0]!.title).toBe("Project Alpha: a question");
    expect(JSON.stringify(ev)).not.toContain("secret-dir");
  });

  it("cleans control characters and caps the title length", () => {
    const tr = new PushTriggers();
    const ev = tr.observe({ inbox: withRow(inbox(), newGroup(133, { title: `Line\u0000one\u202enext ${"x".repeat(200)}` })), panorama: undefined, host: host() }, 0);
    // eslint-disable-next-line no-control-regex
    expect(ev[0]!.title).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect([...ev[0]!.title].length).toBeLessThanOrEqual(80);
  });

  it("announces a new alert with its title only, never its message", () => {
    const tr = new PushTriggers();
    tr.observe({ inbox: inbox(), panorama: undefined, host: host() }, 0);
    const alert = clone(inbox().entries.find((r) => r.key === "alert:456")!) as Record<string, unknown>;
    const row = bridgeApi.InboxRow.parse({ ...alert, key: "alert:457", id: 457, new: true, title: "Alert Title 457", message: "SECRET message", severity: "urgent" });
    const ev = tr.observe({ inbox: withRow(inbox(), row), panorama: undefined, host: host() }, 1);
    expect(ev).toEqual([{ kind: "alert", title: "Agent 1: Alert Title 457", body: "Urgent alert", tag: "a-457", url: "#/inbox", audit: "A457" }]);
  });

  it("says nothing while the inbox is unavailable or its plugin is not ready", () => {
    const tr = new PushTriggers();
    const t = withRow(inbox(), newGroup(134));
    expect(tr.observe({ inbox: { ...t, state: "unavailable" }, panorama: undefined, host: host() }, 0)).toEqual([]);
    expect(tr.observe({ inbox: { ...t, plugin: "broken" }, panorama: undefined, host: host() }, 0)).toEqual([]);
    expect(tr.observe({ inbox: { nonsense: true }, panorama: undefined, host: host() }, 0)).toEqual([]);
  });
});

describe("push triggers: blocked agents", () => {
  const at = (status: bridgeApi.AgentCode, over: Partial<Pano> = {}): Pano => {
    const p = panorama();
    p.roots[0]!.status = status;
    return { ...p, ...over };
  };

  it("announces a root turning blocked, not one already blocked at the first reading", () => {
    const tr = new PushTriggers();
    expect(tr.observe({ inbox: undefined, panorama: at("blk"), host: host() }, 0)).toEqual([]);
    expect(tr.observe({ inbox: undefined, panorama: at("blk"), host: host() }, 1000)).toEqual([]);
    expect(tr.observe({ inbox: undefined, panorama: at("run"), host: host() }, 2000)).toEqual([]);
    const ev = tr.observe({ inbox: undefined, panorama: at("blk"), host: host() }, BLOCKED_COOLDOWN_MS + 3000);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "blocked", title: "Agent 1 is blocked", url: "#/agents", audit: "an agent" });
    expect(ev[0]!.tag).toMatch(/^b-[0-9a-f]{12}$/);
  });

  it("re-seeds after an aged, stale or basic feed: a block seen first after a gap is not announced", () => {
    for (const gap of [at("run", { aged: true }), at("run", { stale: true }), at("run", { mode: "basic" }), undefined]) {
      const tr = new PushTriggers();
      tr.observe({ inbox: undefined, panorama: at("run"), host: undefined }, 0);
      tr.observe({ inbox: undefined, panorama: gap, host: undefined }, 1);
      expect(tr.observe({ inbox: undefined, panorama: at("blk"), host: undefined }, 2)).toEqual([]);
    }
  });

  it("flapping is announced at most once per cooldown", () => {
    const tr = new PushTriggers();
    tr.observe({ inbox: undefined, panorama: at("run"), host: undefined }, 0);
    expect(tr.observe({ inbox: undefined, panorama: at("blk"), host: undefined }, 1)).toHaveLength(1);
    tr.observe({ inbox: undefined, panorama: at("run"), host: undefined }, 2);
    expect(tr.observe({ inbox: undefined, panorama: at("blk"), host: undefined }, 3)).toEqual([]);
  });

  it("names a blocked root only through its host agent, never its own title (it can be an AI summary)", () => {
    const tr = new PushTriggers();
    const p0 = at("run");
    p0.roots[0]!.title = "Secret Title 999";
    p0.roots[0]!.agent_id = null;
    tr.observe({ inbox: undefined, panorama: p0, host: host() }, 0);
    const p1 = structuredClone(p0);
    p1.roots[0]!.status = "blk";
    const ev = tr.observe({ inbox: undefined, panorama: p1, host: host() }, 1);
    expect(ev[0]!.title).toBe("An agent is blocked");
    expect(JSON.stringify(ev)).not.toContain("Secret");
    // Matched: the host agent's name, whatever the root's title says.
    const tr2 = new PushTriggers();
    const m0 = structuredClone(p0);
    m0.roots[0]!.agent_id = "agent-2";
    tr2.observe({ inbox: undefined, panorama: m0, host: host() }, 0);
    const m1 = structuredClone(m0);
    m1.roots[0]!.status = "blk";
    expect(tr2.observe({ inbox: undefined, panorama: m1, host: host() }, 1)[0]!.title).toBe("Agent 2 is blocked");
  });

  it("ignores shadowed roots", () => {
    const tr = new PushTriggers();
    tr.observe({ inbox: undefined, panorama: at("run"), host: undefined }, 0);
    const p = at("blk");
    p.roots[0]!.shadowed = true;
    expect(tr.observe({ inbox: undefined, panorama: p, host: undefined }, 1)).toEqual([]);
  });
});

describe("summarize", () => {
  it("one event is its own payload; several become one notification with a count", () => {
    const tr = new PushTriggers();
    tr.observe({ inbox: inbox(), panorama: undefined, host: host() }, 0);
    const evs = tr.observe({ inbox: withRow(withRow(inbox(), newGroup(140)), newGroup(141)), panorama: undefined, host: host() }, 1);
    const one = summarize(evs.slice(0, 1));
    expect(bridgeApi.PushPayload.parse(one.payload)).toEqual({ v: 1, kind: "question", title: "Agent 1: Question Title 140", body: "New question", tag: "q-140", url: "#/inbox/q/group%3A140/140" });
    const both = summarize(evs);
    expect(bridgeApi.PushPayload.parse(both.payload)).toMatchObject({ title: "Agent 1: Question Title 140", body: "and 1 more", tag: "batch", url: "#/inbox" });
    expect(both.audit).toBe("2 updates");
  });
});
