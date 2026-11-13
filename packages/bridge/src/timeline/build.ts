// The `timeline:<t>` value (docs/chatview.md §4; CV5): plugin rows for one terminal's chat view. Pure: no I/O.
//
// The bridge never reimplements plugin logic here. It filters rows it already holds (the `inbox` and `panorama`
// topics) by the terminal address and passes them on, each with a generic fallback (`title`, `line`, `href`):
// - `inbox.question`: an open `group` row asked from terminal t; `data` is the row itself (key, rev, actions), so the
//   phone acts on it with the inbox's own acts, bound by the same `rev`;
// - `inbox.alert`: an `alert` row from t; `inbox.failed`: a `failed` row (an answer not delivered) to t;
// - strip `panorama.swarm`: the subagents of the panorama root joined to t, counted per status.
//
// Anchors. A question replaces the transcript's `tool_use` block only when the inbox recorded the `ask_operator`
// call's id (app-feed-v1 minor 1) AND that id is on an `ask_operator` call in t's own transcript (the open chat
// view's items, which come only from the session panorama proved for t). Any other id, or one two rows share, is no
// anchor: the row is placed by time. An inbox row never hides another tool's call.
import { bridgeApi, type HostState } from "@herdr-remote/protocol";
import { label } from "../chatview/map.js";

type Row = bridgeApi.InboxRow;
type Item = bridgeApi.TimelineItem;
type Strip = bridgeApi.StripItem;
type Of<K extends string> = Extract<Row, { kind: K }>;

export const INBOX_PLUGIN = "herdr-inbox";
export const PANORAMA_PLUGIN = "herdr-panorama";

export interface TimelineInput {
  terminal: string;
  /** The `inbox`, `panorama` and `host` topic values as published (unchecked: parsed here). */
  inbox: unknown;
  panorama: unknown;
  host: unknown;
  /** `ask_operator` call ids in t's own transcript (the open chat view), or null when it holds none. */
  asks: ReadonlySet<string> | null;
  /** The inbox's recorded call id of a group row (bridge-side only). */
  toolUseIdOf: (key: string) => string | undefined;
}

/** An inbox time as an ISO instant, or null when it can't be read. */
export function isoAt(t: string | null | undefined): string | null {
  if (typeof t !== "string" || t === "") return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** One line of at most `max` UTF-16 units: the chat view's own `label` (redacted, no control or bidi characters). */
export const oneLine = (s: string, max = 400): string => label(s, max);

/** A phone hash route, or null when it would not pass the schema. */
function href(path: string): string | null {
  const h = `#/${path}`;
  return bridgeApi.TimelineHref.safeParse(h).success ? h : null;
}
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Whether an inbox asker is terminal t: a core asker by its address, a herdr-tui one by its pane's terminal. */
export function askerIs(asker: bridgeApi.InboxAsker, t: string, host: HostState | null): boolean {
  if (asker.host === "herdr-core") return asker.terminal === t;
  if (asker.host === "herdr-tui" && asker.pane !== null && host !== null) {
    const panes = host.panes.filter((p) => p.id === asker.pane);
    return panes.length === 1 && panes[0]!.terminal_id === t;
  }
  return false;
}

const isKind = <K extends (typeof bridgeApi.INBOX_KINDS)[number]>(r: Row, k: K): r is Of<K> => r.kind === k;

function inboxItems(inp: TimelineInput, host: HostState | null): Item[] {
  const parsed = bridgeApi.InboxTopic.safeParse(inp.inbox);
  if (!parsed.success || parsed.data.state !== "ok") return [];
  const rows = parsed.data.entries;
  const t = inp.terminal;
  const groups = rows.filter((r): r is Of<"group"> => isKind(r, "group") && askerIs(r.asker, t, host));
  // An id two rows claim anchors neither (app-feed-v1: ids are only shape-checked, any client can send one).
  const claims = new Map<string, number>();
  for (const g of groups) {
    const id = inp.toolUseIdOf(g.key);
    if (id !== undefined) claims.set(id, (claims.get(id) ?? 0) + 1);
  }
  const out: Item[] = [];
  for (const g of groups) {
    const id = inp.toolUseIdOf(g.key);
    const anchored = id !== undefined && bridgeApi.TOOL_USE_ID.test(id) && claims.get(id) === 1 && inp.asks !== null && inp.asks.has(id);
    const first = g.questions[0]!;
    out.push({
      key: g.key,
      plugin: INBOX_PLUGIN,
      kind: "inbox.question",
      at: isoAt(g.created_at),
      anchor: anchored ? { tool_use_id: id } : null,
      title: oneLine(g.title ?? first.question),
      line: oneLine(first.question),
      href: href(`inbox/q/${enc(g.key)}/${first.id}`),
      data: g,
    });
  }
  for (const r of rows) {
    if (isKind(r, "alert") && askerIs(r.asker, t, host)) {
      out.push({ key: r.key, plugin: INBOX_PLUGIN, kind: "inbox.alert", at: isoAt(r.created_at), anchor: null, title: oneLine(r.title), line: oneLine(r.message ?? ""), href: href("inbox"), data: r });
    } else if (isKind(r, "failed") && askerIs(r.asker, t, host)) {
      // The inbox's own words for the row (pwa inbox/words.ts `answerNotDelivered`, view-text.js).
      out.push({ key: r.key, plugin: INBOX_PLUGIN, kind: "inbox.failed", at: isoAt(r.answered_at), anchor: null, title: `Answer to Q${r.question_id} not delivered`, line: oneLine(r.delivery.line), href: href("inbox"), data: r });
    }
  }
  return out;
}

const FINISHED: ReadonlySet<bridgeApi.AgentCode> = new Set(["done", "cxl", "inf"]);
/** The strip's tile order (the board's: running, then finished, then the ones that need you). */
const ORDER: readonly bridgeApi.AgentCode[] = ["run", "rev", "q", "bg", "idle", "stale", "lost", "unknown", "done", "wait", "blk", "fail"];
const NEEDS: ReadonlySet<bridgeApi.AgentCode> = new Set(["wait", "blk", "fail"]);

/** The panorama strip: only for the one live root joined to the one host agent at t, from a fresh feed. */
function swarmStrip(inp: TimelineInput, host: HostState | null): Strip[] {
  const parsed = bridgeApi.PanoramaTopic.safeParse(inp.panorama);
  if (!parsed.success || host === null) return [];
  const p = parsed.data;
  if (p.mode !== "rich" || p.aged || p.stale) return [];
  const agents = host.agents.filter((a) => a.terminal_id === inp.terminal);
  if (agents.length !== 1) return [];
  const roots = p.roots.filter((r) => r.terminal === inp.terminal && r.live && r.agent_id !== null);
  if (roots.length !== 1) return [];
  const root = roots[0]!;
  if (root.agent_id !== agents[0]!.id) return [];
  const total = root.agents.length + root.hidden_finished;
  if (total === 0) return [];
  const counts = new Map<bridgeApi.AgentCode, number>();
  for (const a of root.agents) {
    const code = FINISHED.has(a.status) ? "done" : a.status;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  if (root.hidden_finished > 0) counts.set("done", (counts.get("done") ?? 0) + root.hidden_finished);
  const has = (...c: bridgeApi.AgentCode[]) => c.some((x) => counts.has(x));
  const tone = has("blk", "fail") ? "bad" : has("wait", "q") ? "warn" : has("run", "rev") ? "ok" : "muted";
  const needs = root.agents.find((a) => NEEDS.has(a.status))?.id ?? null;
  const data: bridgeApi.SwarmStripData = { root_key: root.key, space_id: root.space_id, counts: ORDER.filter((c) => counts.has(c)).map((code) => ({ code, n: counts.get(code)! })), total, needs };
  return [
    {
      key: `panorama.swarm:${root.key}`.slice(0, 200),
      plugin: PANORAMA_PLUGIN,
      kind: "panorama.swarm",
      label: `${total} ${total === 1 ? "subagent" : "subagents"}`,
      tone,
      href: href(`swarm/${root.space_id !== null ? enc(root.space_id) : "all"}`),
      data,
    },
  ];
}

const KIND_ORDER: Record<string, number> = { "inbox.question": 0, "inbox.failed": 1, "inbox.alert": 2 };

/** The topic value for terminal t. Items oldest first by `at`, those with none last; capped, open questions kept first. */
export function buildTimeline(inp: TimelineInput): bridgeApi.TimelineTopic {
  const hostParsed = bridgeApi.HostTopic.safeParse(inp.host);
  const host = hostParsed.success ? hostParsed.data : null;
  // A row that would not pass the topic's schema (a time past year 9999, a key over 200 characters) is dropped on its
  // own: one bad row never takes the whole topic down.
  let items = inboxItems(inp, host).filter((i) => bridgeApi.TimelineItem.safeParse(i).success);
  if (items.length > bridgeApi.TIMELINE_ITEMS_MAX) {
    items = [...items].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)).slice(0, bridgeApi.TIMELINE_ITEMS_MAX);
  }
  const ms = (i: Item): number => (i.at === null ? Infinity : Date.parse(i.at));
  items = items.map((i, n) => ({ i, n })).sort((a, b) => ms(a.i) - ms(b.i) || a.n - b.n).map((x) => x.i);
  return { terminal: inp.terminal, items, strip: swarmStrip(inp, host).filter((s) => bridgeApi.StripItem.safeParse(s).success) };
}
