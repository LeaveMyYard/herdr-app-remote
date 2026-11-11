// What deserves a push, from the topics the bridge already publishes:
// - a new inbox question group or alert: a row the inbox topic marks `new` (app-feed-v1's toast marks: the first good
//   feed after a bridge start sets them and announces nothing);
// - an agent turning blocked: a panorama root whose status becomes `blk` after the bridge has seen it otherwise.
// Every source is seeded on its first good reading, so nothing that was already there when the bridge started is
// announced.
import { createHash } from "node:crypto";
import { bridgeApi, HostState } from "@herdr-remote/protocol";
import { cleanLabel } from "../security/audit.js";

export type PushKind = "question" | "alert" | "blocked";

/** One thing to announce. `title` and `body` are what the phone shows; `audit` is the identifier-only log form. */
export interface PushEvent {
  kind: PushKind;
  /** "Agent 1: Question Title 123" (PLAN §7.3: question titles are shown). */
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag on the phone. */
  tag: string;
  /** Where a tap opens the app: a `#/` route. */
  url: string;
  /** For the audit log: identifiers only ("group 123", "A456", "an agent"), never titles or names. */
  audit: string;
}

/** Shown lengths: a lock-screen line, not the question. */
const TITLE_MAX = 80;
const NAME_MAX = 32;
/** How long an announced row key is remembered after it left the inbox. */
const FORGET_MS = 60 * 60 * 1000;
/** The same root announced as blocked at most this often. */
export const BLOCKED_COOLDOWN_MS = 5 * 60 * 1000;

type Row = bridgeApi.InboxRow;
type Group = Extract<Row, { kind: "group" }>;
type Alert = Extract<Row, { kind: "alert" }>;

const KEY_ID = /^(group|alert):([1-9][0-9]{0,15})$/;
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** The asker's agent name, the same join the Inbox screen draws: host agent by terminal, then the tab label, then `asked_by`. */
function agentName(asker: bridgeApi.InboxAsker, askedBy: string | null, host: HostState | undefined): string {
  let terminal: string | undefined;
  if (asker.host === "herdr-core" && asker.terminal) terminal = asker.terminal;
  if (asker.host === "herdr-tui" && asker.pane) terminal = host?.panes.find((p) => p.id === asker.pane)?.terminal_id;
  const agent = terminal ? host?.agents.find((a) => a.terminal_id === terminal) : undefined;
  const name = cleanLabel(agent?.name ?? asker.tab_label ?? askedBy ?? "", NAME_MAX);
  return name || "An agent";
}

/**
 * A blocked root is named only through the host join (its verified host agent's name). The root's own `title` can
 * be the session's AI summary or the terminal title, which is free text beyond a question title (PLAN §7.3).
 */
function blockedName(agentId: string | null, host: HostState | undefined): string {
  const name = agentId !== null ? host?.agents.find((a) => a.id === agentId)?.name : undefined;
  return cleanLabel(name ?? "", NAME_MAX) || "An agent";
}

function groupEvent(row: Group, host: HostState | undefined): PushEvent {
  const id = KEY_ID.exec(row.key);
  // The group's title, else its first question's header: never the question text itself.
  const what = cleanLabel(row.title ?? row.questions[0]?.header ?? "", TITLE_MAX) || "a question";
  const n = row.questions.length;
  // The question to open, as the Inbox list picks it: the first one without a draft (the route needs its id).
  const first = row.questions.find((q) => q.draft === null) ?? row.questions[0];
  return {
    kind: "question",
    title: cleanLabel(`${agentName(row.asker, row.questions[0]?.asked_by ?? null, host)}: ${what}`, TITLE_MAX),
    body: n === 1 ? "New question" : `${n} new questions`,
    tag: `q-${id ? id[2] : short(row.key)}`,
    url: `#/inbox/q/${encodeURIComponent(row.key)}/${first?.id ?? ""}`,
    audit: id ? `group ${id[2]}` : "a question",
  };
}

function alertEvent(row: Alert, host: HostState | undefined): PushEvent {
  const id = KEY_ID.exec(row.key);
  return {
    kind: "alert",
    title: cleanLabel(`${agentName(row.asker, row.asked_by, host)}: ${cleanLabel(row.title, TITLE_MAX) || "an alert"}`, TITLE_MAX),
    body: row.alert_kind === "blocked" ? "Blocked" : row.severity === "urgent" ? "Urgent alert" : "Alert",
    tag: `a-${id ? id[2] : short(row.key)}`,
    url: "#/inbox",
    audit: id ? `A${id[2]}` : "an alert",
  };
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | undefined {
  if (v === undefined) return undefined;
  const r = schema.safeParse(v);
  return r.success ? r.data : undefined;
}

export interface TopicValues {
  inbox: unknown;
  panorama: unknown;
  host: unknown;
}

/** Turns successive topic values into events. Pure apart from its memory; `now` is epoch ms. */
export class PushTriggers {
  /** Inbox row keys already announced (or present as `new` before anyone could be told), with when last seen. */
  private readonly announced = new Map<string, number>();
  /** Root key to last status, from the current rich-feed session; null until seeded. */
  private roots: Map<string, bridgeApi.AgentCode> | null = null;
  private readonly lastBlocked = new Map<string, number>();

  observe(t: TopicValues, now: number): PushEvent[] {
    const host = parse(HostState, t.host);
    return [...this.inbox(parse(bridgeApi.InboxTopic, t.inbox), host, now), ...this.panorama(parse(bridgeApi.PanoramaTopic, t.panorama), host, now)];
  }

  private inbox(topic: bridgeApi.InboxTopic | undefined, host: HostState | undefined, now: number): PushEvent[] {
    if (!topic || topic.plugin !== "ready" || topic.state !== "ok") return [];
    const out: PushEvent[] = [];
    for (const row of topic.entries) {
      if (row.kind !== "group" && row.kind !== "alert") continue;
      const seen = this.announced.has(row.key);
      if (row.new || seen) this.announced.set(row.key, now);
      if (!row.new || seen) continue;
      out.push(row.kind === "group" ? groupEvent(row as Group, host) : alertEvent(row as Alert, host));
    }
    for (const [k, at] of this.announced) if (now - at > FORGET_MS) this.announced.delete(k);
    return out;
  }

  private panorama(topic: bridgeApi.PanoramaTopic | undefined, host: HostState | undefined, now: number): PushEvent[] {
    // Only a fresh rich feed says what a root's status is now. Anything else ends the session: the next good feed
    // seeds again, so agents that were blocked during a gap (or before the bridge started) are not announced.
    if (!topic || topic.mode !== "rich" || topic.aged || topic.stale) {
      this.roots = null;
      return [];
    }
    const current = new Map<string, bridgeApi.AgentCode>();
    const agents = new Map<string, string | null>();
    for (const r of topic.roots) {
      if (r.shadowed) continue;
      current.set(r.key, r.status);
      agents.set(r.key, r.agent_id);
    }
    const before = this.roots;
    this.roots = current;
    if (before === null) return [];
    const out: PushEvent[] = [];
    for (const [key, status] of current) {
      if (status !== "blk" || before.get(key) === "blk") continue;
      const last = this.lastBlocked.get(key);
      if (last !== undefined && now - last < BLOCKED_COOLDOWN_MS) continue;
      this.lastBlocked.set(key, now);
      out.push({
        kind: "blocked",
        title: cleanLabel(`${blockedName(agents.get(key) ?? null, host)} is blocked`, TITLE_MAX),
        body: "Needs you",
        tag: `b-${short(key)}`,
        url: "#/agents",
        audit: "an agent",
      });
    }
    for (const [k, at] of this.lastBlocked) if (now - at >= BLOCKED_COOLDOWN_MS && !current.has(k)) this.lastBlocked.delete(k);
    return out;
  }
}
