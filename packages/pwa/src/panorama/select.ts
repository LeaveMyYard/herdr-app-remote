import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import type { Code } from "../components/StateMarks";
import type { BasicAgent, Space, TileSpec } from "../model";
import { age, statusWord } from "./format";

type Root = bridgeApi.PanoramaRoot;
type Node = bridgeApi.PanoramaNode;

const FINISHED: ReadonlySet<Code> = new Set(["done", "cxl", "inf"]);
const MAX_TILES = 6;

/** Space avatar colours (design desktop.py MARK), assigned by position: the host topic carries none. */
const SPACE_COLORS = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a"] as const;

export const isFinished = (c: Code): boolean => FINISHED.has(c);

export function hostStatus(state: HostState["agents"][number]["state"]): Code {
  switch (state) {
    case "working":
      return "run";
    case "waiting":
      return "wait";
    case "error":
      return "fail";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/** One tile per live agent (feed order, at most six), then one finished tile counting every finished agent and `hidden_finished`. */
export function rootTiles(root: Root): TileSpec[] {
  const live = root.agents.filter((a) => !isFinished(a.status));
  const done = root.agents.length - live.length + root.hidden_finished;
  const tiles: TileSpec[] = live.slice(0, MAX_TILES).map((a) => ({ code: a.status }));
  if (done > 0) tiles.push({ code: "done", count: done });
  return tiles;
}

export const activeCount = (root: Root): number => root.agents.filter((a) => a.status === "run" || a.status === "rev").length;

export interface CardView {
  key: string;
  href: string;
  /** Tab number, when the feed knows it. */
  n: number | null;
  harness: string;
  title: string;
  st: Code;
  questions: number;
  tiles: TileSpec[];
  meta: string;
  sweep: boolean;
}

export interface GroupView {
  id: string;
  label: string;
  cards: CardView[];
}

export interface AgentsView {
  spaces: Space[];
  groups: GroupView[];
  /** Open questions across roots joined to a space (the ?N in the Agents header). */
  questions: number;
}

const joined = (r: Root): boolean => r.agent_id !== null && r.space_id !== null;

function spaceTiles(roots: Root[]): TileSpec[] {
  let fail = 0;
  let blk = 0;
  let q = 0;
  let running = false;
  for (const r of roots) {
    q += r.inbox.length;
    if (r.status === "blk") blk += 1;
    if (r.status === "run") running = true;
    for (const a of r.agents) {
      if (a.status === "fail") fail += 1;
      else if (a.status === "blk") blk += 1;
      else if (a.status === "run" || a.status === "rev") running = true;
    }
  }
  const tiles: TileSpec[] = [];
  if (fail) tiles.push({ code: "fail", count: fail });
  if (blk) tiles.push({ code: "blk", count: blk });
  if (q) tiles.push({ code: "wait", count: q });
  if (running) tiles.push({ code: "run" });
  return tiles;
}

/** Space rows from the host topic; with a panorama topic, each carries its needs and working tiles (joined roots only). */
export function selectSpaces(host: HostState, topic?: bridgeApi.PanoramaTopic, extra: Record<string, Partial<Space>> = {}): Space[] {
  return host.spaces.map((s, i) => ({
    id: s.id,
    name: s.name,
    letter: (s.name.trim()[0] ?? "?").toUpperCase(),
    color: SPACE_COLORS[i % SPACE_COLORS.length] as string,
    selected: s.focused,
    ...(topic?.mode === "rich" ? { tiles: spaceTiles(topic.roots.filter((r) => joined(r) && r.space_id === s.id)) } : {}),
    ...extra[s.id],
  }));
}

/** Basic Agents (no herdr-panorama data): the host's own agent rows. */
export function selectBasic(host: HostState): BasicAgent[] {
  return host.agents.map((a) => ({
    id: a.id,
    name: a.name,
    harness: a.harness,
    tab: a.terminal_id ?? "",
    age: "",
    status: a.state === "waiting" || a.state === "error" ? "needs-you" : a.state === "working" ? "working" : a.state === "done" ? "done" : "idle",
    spaceId: a.space_id,
  }));
}

/**
 * The Agents list with herdr-panorama: every host agent row stays (enriched when its root is joined), grouped by space,
 * then the feed roots that matched no live row. A root that is only a stale duplicate of a live row is not listed twice.
 */
export function selectAgents(host: HostState, topic: bridgeApi.PanoramaTopic, extra: Record<string, Partial<Space>> = {}): AgentsView {
  const spaces = selectSpaces(host, topic, extra);
  const byAgent = new Map(topic.roots.filter((r) => r.agent_id !== null).map((r) => [r.agent_id as string, r]));
  const name = (id: string | null): string => spaces.find((s) => s.id === id)?.name ?? "";
  const stock = (a: HostState["agents"][number]): CardView => ({
    key: `agent:${a.id}`,
    href: `#/chat/${a.id}`,
    n: null,
    harness: a.harness,
    title: a.name,
    st: hostStatus(a.state),
    questions: 0,
    tiles: [],
    meta: name(a.space_id),
    sweep: false,
  });
  const enriched = (r: Root, spaceName: string): CardView => {
    const active = activeCount(r);
    const meta = [spaceName, r.tab_no !== null ? `tab ${r.tab_no}` : "", `${active} active`, `${r.agents.length} agents`].filter(Boolean).join(" · ");
    return {
      key: r.key,
      // A root with a live host agent opens that agent's Chat; a feed-only root has nothing to chat with, so it opens the Swarm.
      href: r.agent_id !== null ? `#/chat/${r.agent_id}` : `#/swarm/${r.space_id !== null ? encodeURIComponent(r.space_id) : "all"}`,
      n: r.tab_no,
      harness: r.harness,
      title: r.title,
      st: r.status,
      questions: r.inbox.length,
      tiles: rootTiles(r),
      meta,
      sweep: active > 0 && r.status === "run",
    };
  };
  const groups: GroupView[] = [];
  const known = new Set(spaces.map((s) => s.id));
  for (const s of spaces) {
    const cards = host.agents
      .filter((a) => a.space_id === s.id)
      .map((a) => {
        const r = byAgent.get(a.id);
        return r ? enriched(r, s.name) : stock(a);
      });
    if (cards.length) groups.push({ id: s.id, label: s.name, cards });
  }
  const strays = host.agents.filter((a) => !known.has(a.space_id)).map(stock);
  if (strays.length) groups.push({ id: "other", label: "Other", cards: strays });
  const loose = topic.roots.filter((r) => r.agent_id === null && !r.shadowed).map((r) => enriched(r, "Not in a space"));
  if (loose.length) groups.push({ id: "roots", label: "Other roots", cards: loose });
  const questions = topic.roots.filter(joined).reduce((n, r) => n + r.inbox.length, 0);
  return { spaces, groups, questions };
}

// ---- Swarm ----

export interface SwarmScope {
  label: string;
  roots: Root[];
}

/**
 * The roots a Swarm shows. A space shows the roots joined to it. While the feed is aged nothing is joined, so
 * every retained root is shown instead of an empty swarm (the stale banner says why).
 */
export function swarmScope(host: HostState | undefined, topic: bridgeApi.PanoramaTopic, spaceId: string | null): SwarmScope {
  if (topic.aged || spaceId === null) return { label: topic.aged ? "All roots" : "All spaces", roots: topic.roots };
  const label = host?.spaces.find((s) => s.id === spaceId)?.name ?? "Unknown space";
  return { label, roots: topic.roots.filter((r) => r.space_id === spaceId) };
}

export const nodeUid = (root: Pick<Root, "key">, id: string): string => `${root.key}\u0000${id}`;

export interface SwarmStats {
  roots: number;
  agents: number;
  questions: number;
  needs: boolean;
  working: boolean;
  done: boolean;
}

export function swarmStats(roots: Root[]): SwarmStats {
  const all = roots.flatMap((r) => r.agents.map((a) => a.status));
  const needs = roots.some((r) => r.status === "blk" || r.inbox.length > 0) || all.some((c) => c === "fail" || c === "blk" || c === "wait");
  const working = roots.some((r) => r.status === "run") || all.some((c) => c === "run" || c === "rev");
  return {
    roots: roots.length,
    agents: all.length,
    questions: roots.reduce((n, r) => n + r.inbox.length, 0),
    needs,
    working,
    done: !needs && !working && (roots.some((r) => r.status === "done") || all.some((c) => c === "done")),
  };
}

export type Guide = "pass" | "blank" | "tee" | "end";

export interface SwarmRow {
  uid: string;
  kind: "root" | "node" | "fold";
  guides: Guide[];
  root: Root;
  node: Node | null;
  title: string;
  st: Code;
  harness: string;
  /** Open questions in this node's subtree (a root: its inbox). */
  questions: number;
  act: string;
  right: string;
  hasKids: boolean;
  open: boolean;
  selected: boolean;
  /** An ancestor of the selected row. */
  onPath: boolean;
  /** The `agent` line of the selected detail. */
  agentLine: string;
  /** Selected only: the details, Peek and the other buttons. */
  needs: boolean;
}

export interface SwarmUi {
  open: Record<string, boolean>;
  sel: string | null;
}

const NEEDS: ReadonlySet<Code> = new Set(["wait", "blk", "fail"]);

/** Questions in a subtree: the union of every node's attributed question ids. */
function subtreeQuestions(root: Root, kids: Map<string | null, Node[]>, n: Node): number {
  const ids = new Set<number>();
  const walk = (x: Node): void => {
    for (const q of x.question_ids) ids.add(q);
    for (const k of kids.get(x.id) ?? []) walk(k);
  };
  walk(n);
  return ids.size;
}

/**
 * The Swarm as rows, in the board's order: each root, then its tree with the finished leaves of every parent folded
 * into one row (at the first one's place). Only open nodes show their children.
 */
export function buildSwarmRows(roots: Root[], ui: SwarmUi, now: number): SwarmRow[] {
  const rows: SwarmRow[] = [];
  const selAncestors = new Set<string>();
  const parentUid = new Map<string, string>();
  for (const r of roots) {
    for (const a of r.agents) parentUid.set(nodeUid(r, a.id), a.parent === null ? r.key : nodeUid(r, a.parent));
  }
  for (let u = ui.sel === null ? undefined : parentUid.get(ui.sel); u !== undefined; u = parentUid.get(u)) selAncestors.add(u);
  const rootUid = (r: Root): string => r.key;

  roots.forEach((root) => {
    const kids = new Map<string | null, Node[]>();
    for (const a of root.agents) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    const isLeafFinished = (a: Node): boolean => isFinished(a.status) && !(kids.get(a.id)?.length ?? 0);

    const common = (uid: string) => ({ uid, selected: ui.sel === uid, onPath: ui.sel !== uid && selAncestors.has(uid) });

    const walk = (parent: string | null, trail: boolean[], hidden: number): void => {
      const list = kids.get(parent) ?? [];
      const folded = list.filter(isLeafFinished);
      const items: (Node | "fold")[] = [];
      let placed = false;
      for (const a of list) {
        if (isLeafFinished(a)) {
          if (!placed) items.push("fold");
          placed = true;
        } else items.push(a);
      }
      if (!placed && hidden > 0) items.push("fold");
      items.forEach((item, i) => {
        const last = i === items.length - 1;
        const guides: Guide[] = [...trail.map((more): Guide => (more ? "pass" : "blank")), last ? "end" : "tee"];
        if (item === "fold") {
          const names = folded.map((f) => f.title).join(" · ");
          const older = hidden > 0 ? `+${hidden} older` : "";
          const head = folded.length ? `${folded.length} finished` : "";
          rows.push({
            uid: `${root.key}\u0000fold:${parent ?? ""}`,
            kind: "fold",
            guides,
            root,
            node: null,
            title: [head, names, older].filter(Boolean).join(" · "),
            st: "done",
            harness: root.harness,
            questions: 0,
            act: "",
            right: "",
            hasKids: false,
            open: false,
            selected: false,
            onPath: false,
            agentLine: "",
            needs: false,
          });
          return;
        }
        const uid = nodeUid(root, item.id);
        const own = kids.get(item.id) ?? [];
        const c = common(uid);
        const open = own.length > 0 && ui.open[uid] === true;
        rows.push({
          ...c,
          kind: "node",
          guides,
          root,
          node: item,
          title: item.title,
          st: item.status,
          harness: item.harness,
          questions: subtreeQuestions(root, kids, item),
          act: item.activity || statusWord(item.status),
          right: [item.model, age(isFinished(item.status) ? (item.ended ?? item.last_at) : (item.last_at ?? item.started), now)].filter(Boolean).join(" · "),
          hasKids: own.length > 0,
          open,
          agentLine: [`${item.role || item.title} ${item.id}`, item.model, age(item.last_at ?? item.started, now), `${item.tool_calls} calls`].filter(Boolean).join(" · "),
          needs: NEEDS.has(item.status),
        });
        if (open) walk(item.id, [...trail, !last], 0);
      });
    };

    const uid = rootUid(root);
    const topKids = kids.get(null) ?? [];
    const open = (topKids.length > 0 || root.hidden_finished > 0) && ui.open[uid] === true;
    const c = common(uid);
    rows.push({
      ...c,
      kind: "root",
      guides: [],
      root,
      node: null,
      title: root.title,
      st: root.status,
      harness: root.harness,
      questions: root.inbox.length,
      act: statusWord(root.status),
      right: [root.tab_no !== null ? `tab ${root.tab_no}` : "", age(root.last_activity, now)].filter(Boolean).join(" · "),
      hasKids: topKids.length > 0 || root.hidden_finished > 0,
      open,
      agentLine: [root.title, root.harness].join(" · "),
      needs: NEEDS.has(root.status) || root.inbox.length > 0,
    });
    if (open) walk(null, [], root.hidden_finished);
  });
  return rows;
}
