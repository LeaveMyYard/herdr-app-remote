import type { HostState } from "@herdr-remote/protocol";
import type { Feed, FeedAgent, FeedRoot } from "../../src/panorama/feed.js";
import { NOW, panoramaHome, put, sha } from "../plugins/helpers.js";

export { NOW, put, sha };

/**
 * A stand-in for panorama's contract.js with the same export names (written here, not copied). It only checks
 * what these tests need; the real one is exercised by real-contract.test.ts when a checkout is available.
 */
export const CONTRACT = `export function parseFeed(text) {
  const f = JSON.parse(text);
  if (f.v !== 2 || !Array.isArray(f.roots) || typeof f.generated_at !== 'number') throw Error('feed');
  return f;
}
export const aged = (p, now = Date.now()) => !Number.isFinite(p?.generated_at) || p.generated_at * 1000 > now || now - p.generated_at * 1000 > 15000;
export const rootKey = root => JSON.stringify(['root', root.host, root.host === 'herdr-core' && root.terminal !== null ? root.terminal : root.pane_id]);
export function readResult(previous, text, error = null) {
  try {
    if (error || text === null) throw error || Error('feed.json');
    const feed = parseFeed(text);
    return { feed, stale: false, errors: feed.errors ?? [], generated_at: feed.generated_at };
  } catch (failure) {
    return { feed: previous?.feed ?? null, stale: true, errors: [String(failure.message ?? failure)], generated_at: previous?.generated_at ?? null };
  }
}
`;

export const agent = (id: string, over: Partial<FeedAgent> = {}): FeedAgent => ({
  id,
  harness: "claude",
  title: `Title ${id}`,
  role: "Explore",
  model: "opus",
  status: "run",
  activity: "working",
  last_message: "",
  questions: [],
  pending: [],
  question_ids: [],
  error: null,
  parent: null,
  tool_calls: 1,
  started: null,
  ended: null,
  last_at: null,
  seq: 0,
  ...over,
});

export const root = (over: Partial<FeedRoot> = {}): FeedRoot => ({
  pane_id: "core:t1",
  host: "herdr-core",
  terminal: "t1",
  harness: "claude",
  tab_label: "Tab label",
  title: "Root title",
  herdr_status: "working",
  tab_no: null,
  inbox: [],
  hidden_finished: 0,
  last_activity: null,
  agents: [],
  ...over,
});

export const mkFeed = (roots: FeedRoot[] = [root()], over: Partial<Feed> = {}): Feed & Record<string, unknown> => ({
  v: 2,
  generated_at: NOW / 1000 - 3,
  herdr_ok: true,
  inbox_ok: true,
  errors: [],
  counts: {},
  roots,
  ...over,
});

export function hostState(over: Partial<HostState> = {}): HostState {
  return {
    spaces: [
      { id: "space-1", name: "Project Alpha", focused: true },
      { id: "space-2", name: "Project Beta", focused: false },
    ],
    agents: [
      { id: "agent-1", name: "Agent 1", harness: "claude", state: "working", space_id: "space-1", terminal_id: "t1" },
      { id: "agent-2", name: "Agent 2", harness: "codex", state: "idle", space_id: "space-2", terminal_id: "t2" },
    ],
    terminals: [],
    panes: [],
    focused: { space_id: "space-1", pane_id: null, agent_id: null },
    theme: { name: "Theme 1", mode: "dark" },
    layout_name: "herdr-remote",
    shared: { "panorama.feed.owner": "owner-1" },
    ...over,
  };
}

/** An app home with a hash-pinned contract and, unless `feed` is null, a feed file. */
export const home = (feed: unknown | null = mkFeed(), contract = CONTRACT): string => panoramaHome({ contract, feed });
