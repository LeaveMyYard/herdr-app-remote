// Where timeline items go among chat items (docs/chatview.md §4; CV5). Pure.
//
// - An item with an `anchor` replaces the chat view's `ask` item (`via: "inbox"`) whose `tool_use_id` is the same,
//   and nothing else: never a tool row or any other item. The bridge set the anchor only after finding that id on
//   an `ask_operator` call in this terminal's own transcript.
// - Otherwise (or when that ask item is not loaded) it goes by `at`: before the first chat item that is later.
//   An open question older than every loaded item shows at the top; one with no `at`, or newer than every item,
//   goes at the end. An item is never dropped.
import { bridgeApi } from "@herdr-remote/protocol";
import { nodeUid } from "../panorama/select";

type ChatItem = bridgeApi.ChatItem;
type TimelineItem = bridgeApi.TimelineItem;

export interface Placement {
  /** Timeline items to draw just before the chat item with this id. */
  before: Map<string, TimelineItem[]>;
  /** The timeline item drawn instead of the chat item with this id (an inbox ask). */
  replace: Map<string, TimelineItem>;
  /** Timeline items after the last chat item. */
  tail: TimelineItem[];
}

const ms = (iso: string | null): number => {
  if (iso === null) return NaN;
  return Date.parse(iso);
};

export function placeTimeline(items: readonly ChatItem[], timeline: readonly TimelineItem[]): Placement {
  const out: Placement = { before: new Map(), replace: new Map(), tail: [] };
  const asks = new Map<string, string[]>();
  for (const i of items) {
    if (i.role === "ask" && i.ask.via === "inbox" && i.tool_use_id !== undefined) {
      const ids = asks.get(i.tool_use_id) ?? [];
      ids.push(i.id);
      asks.set(i.tool_use_id, ids);
    }
  }
  const byTime: TimelineItem[] = [];
  for (const t of timeline) {
    const ids = t.anchor ? asks.get(t.anchor.tool_use_id) : undefined;
    // One ask item per anchor: if the same id is on several (or another item already took it), go by time.
    if (ids && ids.length === 1 && !out.replace.has(ids[0]!)) out.replace.set(ids[0]!, t);
    else byTime.push(t);
  }
  for (const t of byTime) {
    const at = ms(t.at);
    const next = Number.isFinite(at) ? items.find((i) => Number.isFinite(ms(i.at)) && ms(i.at) > at) : undefined;
    if (!next) {
      out.tail.push(t);
      continue;
    }
    const list = out.before.get(next.id) ?? [];
    list.push(t);
    out.before.set(next.id, list);
  }
  return out;
}

/** The kind-specific data, checked, or null: the phone then draws the item's fallback fields. */
export function questionRow(t: TimelineItem): Extract<bridgeApi.InboxRow, { kind: "group" }> | null {
  if (t.kind !== "inbox.question") return null;
  const r = bridgeApi.InboxGroupRow.safeParse(t.data);
  return r.success ? (r.data as Extract<bridgeApi.InboxRow, { kind: "group" }>) : null;
}
export function alertRow(t: TimelineItem): Extract<bridgeApi.InboxRow, { kind: "alert" }> | null {
  if (t.kind !== "inbox.alert") return null;
  const r = bridgeApi.InboxAlertRow.safeParse(t.data);
  return r.success ? (r.data as Extract<bridgeApi.InboxRow, { kind: "alert" }>) : null;
}
export function failedRow(t: TimelineItem): Extract<bridgeApi.InboxRow, { kind: "failed" }> | null {
  if (t.kind !== "inbox.failed") return null;
  const r = bridgeApi.InboxFailedRow.safeParse(t.data);
  return r.success ? (r.data as Extract<bridgeApi.InboxRow, { kind: "failed" }>) : null;
}
export function swarmData(s: bridgeApi.StripItem): bridgeApi.SwarmStripData | null {
  if (s.kind !== "panorama.swarm") return null;
  const r = bridgeApi.SwarmStripData.safeParse(s.data);
  return r.success ? r.data : null;
}

/** The Peek route of a root's subagent (App.tsx: `#/swarm/peek/<nodeUid>`). */
export const peekHref = (rootKey: string, nodeId: string): string => `#/swarm/peek/${encodeURIComponent(nodeUid({ key: rootKey }, nodeId))}`;

/** A route the bridge gave, used only when it is one of the phone's own (`#/…`). */
export const safeHref = (h: string | null): string | undefined => (h !== null && bridgeApi.TimelineHref.safeParse(h).success ? h : undefined);
