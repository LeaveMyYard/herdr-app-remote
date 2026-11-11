import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { CUT, EMPTY, leftOut, noId } from "./words";

export type Row = bridgeApi.InboxRow;
type KnownKind = (typeof bridgeApi.INBOX_KINDS)[number];
export type Of<K extends KnownKind> = Extract<Row, { kind: K }>;

/** Narrows a row to a known kind (the unknown-kind row has `kind: string`, which `===` can't narrow on). */
export const isKind = <K extends KnownKind>(row: Row, kind: K): row is Of<K> => row.kind === kind;

/** A time as "4m"; `now` in POSIX seconds. A time that can't be read says nothing. Same rule as the inbox's own `age`. */
export function age(time: string | null, now: number): string {
  if (time === null) return "";
  const at = Date.parse(time) / 1000;
  if (!Number.isFinite(at)) return "";
  const s = Math.max(Math.floor(now - at), 0);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const base = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? "";

/**
 * Where an asker is, in words: the agent's name and its space, joined from the `host` topic. A core asker is
 * found by its terminal address, a herdr-tui one by its pane. Nothing is guessed: with no match the tab label,
 * then the working directory's name, stand in.
 */
export function whereOf(asker: bridgeApi.InboxAsker, host: HostState | undefined): { agent: string | null; space: string | null } {
  const spaceName = (id: string | undefined): string | null => (id ? (host?.spaces.find((s) => s.id === id)?.name ?? null) : null);
  let terminal: string | undefined;
  let spaceId: string | undefined;
  if (asker.host === "herdr-core" && asker.terminal) terminal = asker.terminal;
  if (asker.host === "herdr-tui" && asker.pane) {
    const pane = host?.panes.find((p) => p.id === asker.pane);
    terminal = pane?.terminal_id;
    spaceId = pane?.space_id;
  }
  const agent = terminal ? host?.agents.find((a) => a.terminal_id === terminal) : undefined;
  const t = terminal ? host?.terminals.find((x) => x.id === terminal) : undefined;
  const space = spaceName(agent?.space_id ?? t?.space_id ?? spaceId);
  const fallback = asker.tab_label ?? (asker.cwd ? base(asker.cwd) : null);
  return { agent: agent?.name ?? null, space: space ?? (agent ? null : fallback) };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function groupTitle(row: Of<"group">): string {
  return row.title ?? row.questions[0]?.question ?? row.key;
}

/** "Agent 1 · Project Alpha · 3 questions · 1 answered": `answered` counts stored drafts. */
export function groupSub(row: Of<"group">, host: HostState | undefined): string {
  const w = whereOf(row.asker, host);
  const drafts = row.questions.filter((q) => q.draft !== null).length;
  return [
    w.agent,
    w.space,
    plural(row.questions.length, "question", "questions"),
    drafts > 0 ? `${drafts} answered` : null,
    row.questions.some((q) => q.cut) ? CUT : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
}

export function alertSub(row: Of<"alert">, host: HostState | undefined): string {
  const w = whereOf(row.asker, host);
  return [w.agent ?? row.asked_by, w.space].filter((x): x is string => x !== null && x !== "").join(" · ");
}

export function failedSub(row: Of<"failed">, host: HostState | undefined): string {
  const w = whereOf(row.asker, host);
  return [row.delivery.line, w.agent, row.cut ? CUT : null].filter((x): x is string => !!x).join(" · ");
}

/**
 * The summary row of app-feed-v1 ("gone"): two or more `failed` rows whose agent is gone, when the list opens,
 * become one row, and that set stays fixed while it is open. Returns the keys to fold, or none.
 */
export function goneBatch(rows: readonly Row[]): string[] {
  const gone = rows.filter((r): r is Of<"failed"> => isKind(r, "failed") && r.delivery.state === "agent_gone").map((r) => r.key);
  return gone.length >= 2 ? gone : [];
}

/** The tab-bar badge: open question groups, as in the design ("?2"). */
export function inboxBadge(topic: bridgeApi.InboxTopic | undefined): string | undefined {
  return topic && topic.state === "ok" && topic.waiting > 0 ? `?${topic.waiting}` : undefined;
}

export const headerSub = (topic: bridgeApi.InboxTopic): string => {
  const parts = [topic.waiting > 0 ? `${topic.waiting} waiting` : null, topic.alerts > 0 ? plural(topic.alerts, "alert", "alerts") : null].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : EMPTY;
};

/** What the feed left out, in the overlay's own words (the required "incomplete feed" notice). */
export function incompleteWords(inc: NonNullable<bridgeApi.InboxTopic["incomplete"]>): string {
  return [inc.counts.length > 0 ? leftOut(inc.counts) : "", inc.unlisted > 0 ? noId(inc.unlisted) : ""].filter((x) => x !== "").join(" ");
}
