import { bridgeApi, type HostState } from "@herdr-remote/protocol";
import type { Contract, Feed, FeedAgent, FeedRoot, FeedView } from "./feed.js";

const CODES: ReadonlySet<string> = new Set(bridgeApi.AGENT_CODES);
/** Display strings from the feed are capped so one runaway message can't bloat every patch. */
const MAX_TEXT = 1000;

const cap = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

export function agentCode(status: string): bridgeApi.AgentCode {
  return CODES.has(status) && status !== "unknown" ? (status as bridgeApi.AgentCode) : "unknown";
}

/** Root runtime status vocabulary: working, blocked, idle, done, unknown (future strings fall back to idle/unknown). */
export function rootCode(status: string): bridgeApi.AgentCode {
  switch (status) {
    case "working":
      return "run";
    case "blocked":
      return "blk";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/**
 * Parent links as the feed's tree rules read them: dangling and self parents are root children, and entries made
 * unreachable by a cycle become root children too, so every agent appears exactly once.
 */
export function normalizeParents(agents: readonly FeedAgent[]): Map<string, string | null> {
  const ids = new Set(agents.map((a) => a.id));
  const parent = new Map<string, string | null>();
  const kids = new Map<string, string[]>();
  for (const a of agents) {
    const p = a.parent !== null && a.parent !== a.id && ids.has(a.parent) ? a.parent : null;
    parent.set(a.id, p);
    if (p !== null) kids.set(p, [...(kids.get(p) ?? []), a.id]);
  }
  const reached = new Set<string>();
  const stack = agents.filter((a) => parent.get(a.id) === null).map((a) => a.id);
  while (stack.length) {
    const id = stack.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  for (const a of agents) if (!reached.has(a.id)) parent.set(a.id, null);
  return parent;
}

function node(a: FeedAgent, parent: string | null): bridgeApi.PanoramaNode {
  return {
    id: a.id,
    parent,
    harness: a.harness,
    title: cap(a.title || a.role || a.id),
    role: cap(a.role),
    model: a.model,
    status: agentCode(a.status),
    activity: cap(a.activity),
    last_message: cap(a.last_message),
    pending: a.pending.map(cap),
    question_ids: a.question_ids,
    error: a.error === null ? null : cap(a.error),
    tool_calls: a.tool_calls,
    started: a.started,
    ended: a.ended,
    last_at: a.last_at,
    seq: a.seq,
  };
}

function root(
  contract: Contract,
  r: FeedRoot,
  match: HostState["agents"][number] | undefined,
  shadowed: boolean,
): bridgeApi.PanoramaRoot {
  const parents = normalizeParents(r.agents);
  return {
    key: contract.rootKey(r),
    agent_id: match?.id ?? null,
    space_id: match?.space_id ?? null,
    terminal: r.terminal,
    live: match !== undefined,
    shadowed,
    harness: r.harness,
    title: cap(match?.name || r.title || r.tab_label || r.pane_id),
    tab_no: r.tab_no,
    status: rootCode(r.herdr_status),
    inbox: r.inbox,
    hidden_finished: r.hidden_finished,
    last_activity: r.last_activity,
    agents: r.agents.map((a) => node(a, parents.get(a.id) ?? null)),
  };
}

/**
 * Joins the feed with the host's `agents()` rows (the lease owner is `host.shared["panorama.feed.owner"]`).
 *
 * - `basic` when there is no lease owner or no feed at all: the phone shows the stock agents.
 * - A root joins a host agent only by exact address: `host === "herdr-core"`, a terminal, and the agent's
 *   `terminal_id` (the link mod mirrors `agents().address` there). Never by cwd, title, pane id or session.
 * - While the feed is aged no join is applied: the retained roots keep their data, carry no space or live
 *   terminal, and a root whose address has a live row is marked `shadowed` so the Agents list doesn't repeat it.
 */
export function buildPanoramaTopic(host: HostState, view: FeedView, contract: Contract | undefined): bridgeApi.PanoramaTopic {
  const owner = host.shared["panorama.feed.owner"];
  const feed: Feed | null = view.feed;
  const basic = (): bridgeApi.PanoramaTopic => ({ mode: "basic", stale: view.stale, aged: view.aged, error: view.error, collected_at: feed?.generated_at ?? null, roots: [] });
  if (owner === null || feed === null || contract === undefined) return basic();
  const byAddress = new Map<string, HostState["agents"][number]>();
  for (const a of host.agents) if (a.terminal_id !== undefined && !byAddress.has(a.terminal_id)) byAddress.set(a.terminal_id, a);
  const roots = feed.roots.map((r) => {
    const hit = r.host === "herdr-core" && r.terminal !== null ? byAddress.get(r.terminal) : undefined;
    return view.aged ? root(contract, r, undefined, hit !== undefined) : root(contract, r, hit, false);
  });
  return { mode: "rich", stale: view.stale, aged: view.aged, error: view.error, collected_at: feed.generated_at, roots };
}
