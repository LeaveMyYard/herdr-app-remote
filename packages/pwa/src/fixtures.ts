// Fake data only (design boards). Replaced by bridge data from S4/S5 onwards.
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import type { BasicAgent, HostInfo, PluginRow, Space, TabBadges } from "./model";
import { nodeUid, type SwarmUi } from "./panorama/select";
import type { AppData } from "./App";
import type { TranscriptPage } from "./screens/Peek";

export const host: HostInfo = { name: "desk-1" };

export const spaces: Space[] = [
  { id: "sp-1", name: "Project Alpha", letter: "P", color: "#22a99a", branch: "alpha-core", behind: 12, selected: true },
  { id: "sp-2", name: "Project Beta", letter: "P", color: "#e3814f", detached: true },
  { id: "sp-3", name: "Sandbox", letter: "S", color: "#5b8def" },
];

export const agents: BasicAgent[] = [
  { id: "a-1", name: "Agent 1", harness: "claude", tab: "tab 2", age: "26m", status: "needs-you", spaceId: "sp-1" },
  { id: "a-2", name: "Agent 2", harness: "claude", tab: "tab 3", age: "9m", status: "working", spaceId: "sp-1" },
  { id: "a-3", name: "Agent 3", harness: "codex", tab: "tab 1", age: "4m", status: "working", spaceId: "sp-2" },
  { id: "a-4", name: "Agent 4", harness: "claude", tab: "tab 3", age: "1h", status: "done", spaceId: "sp-2" },
];

export const plugins: PluginRow[] = [
  { name: "herdr-panorama", state: "ready", version: "0.4" },
  { name: "herdr-inbox", state: "ready", version: "0.10" },
  { name: "agent-usage", state: "missing" },
];

export const badges: TabBadges = { inbox: "?2" };

/** Placeholder from the board; the real command comes from the plugin probe (S7). */
export const usageInstallCommand = "[AGENT-USAGE INSTALL COMMAND]";

// ---- herdr-panorama boards (PhoneAgents, PhoneSwarm, PhonePeek). Fake data only. ----

type Node = bridgeApi.PanoramaNode;
type Root = bridgeApi.PanoramaRoot;

/** POSIX seconds the board ages are relative to. */
export const BOARD_NOW = 1_800_000_000;

const node = (id: string, over: Partial<Node> = {}): Node => ({
  id,
  parent: null,
  harness: "claude",
  title: `Agent ${id}`,
  role: "",
  model: "opus",
  status: "run",
  activity: "",
  last_message: "",
  pending: [],
  question_ids: [],
  error: null,
  tool_calls: 1,
  started: BOARD_NOW - 600,
  ended: null,
  last_at: BOARD_NOW - 30,
  seq: 0,
  ...over,
});

const root = (key: string, agent: string, space: string, over: Partial<Root> = {}): Root => ({
  key,
  agent_id: agent,
  space_id: space,
  terminal: key,
  live: true,
  shadowed: false,
  harness: "claude",
  title: agent,
  tab_no: null,
  status: "run",
  inbox: [],
  hidden_finished: 0,
  last_activity: BOARD_NOW - 30,
  agents: [],
  ...over,
});

const hostAgent = (id: string, name: string, harness: string, state: HostState["agents"][number]["state"], space: string, term: string) => ({
  id,
  name,
  harness,
  state,
  space_id: space,
  terminal_id: term,
});

export const boardHost: HostState = {
  spaces: [
    { id: "sp-1", name: "Project Alpha", focused: true },
    { id: "sp-2", name: "Project Beta", focused: false },
    { id: "sp-3", name: "Sandbox", focused: false },
  ],
  agents: [
    hostAgent("a-1", "Agent 1 · Parser rewrite", "claude", "working", "sp-1", "t2"),
    hostAgent("a-2", "Agent 2 · Test cleanup", "claude", "working", "sp-1", "t3"),
    hostAgent("a-3", "Agent 3 · Docs pass", "claude", "idle", "sp-1", "t4"),
    hostAgent("a-4", "Agent 4 · Release notes", "claude", "working", "sp-2", "t5"),
    hostAgent("a-5", "Agent 5 · API client", "codex", "working", "sp-2", "t6"),
    hostAgent("a-6", "Agent 6 · Changelog", "claude", "idle", "sp-2", "t7"),
    hostAgent("a-7", "Agent 7 · Spike", "claude", "working", "sp-3", "t8"),
  ],
  terminals: [],
  panes: [],
  focused: { space_id: "sp-1", pane_id: null, agent_id: null },
  theme: { name: "Theme 1", mode: "dark" },
  layout_name: "herdr-remote",
  shared: { "panorama.feed.owner": "owner-1" },
};

/** Branch and behind counts are not in the host topic, so only the board carries them. */
export const boardSpaceExtra = {
  "sp-1": { branch: "alpha-core", behind: 12 },
  "sp-2": { detached: true },
} as const;

const topic = (roots: Root[]): bridgeApi.PanoramaTopic => ({ mode: "rich", stale: false, aged: false, error: null, collected_at: BOARD_NOW - 2, roots });

const subs = (...codes: bridgeApi.AgentCode[]): Node[] => codes.map((status, i) => node(`s${i}`, { status, seq: i }));

/** PhoneAgents. */
export const agentsTopic = topic([
  root("t2", "a-1", "sp-1", { title: "Agent 1 · Parser rewrite", tab_no: 2, inbox: [1], agents: subs("run", "run", "done") }),
  root("t3", "a-2", "sp-1", { title: "Agent 2 · Test cleanup", tab_no: 3 }),
  root("t4", "a-3", "sp-1", { title: "Agent 3 · Docs pass", tab_no: 4, status: "idle", hidden_finished: 2 }),
  root("t5", "a-4", "sp-2", { title: "Agent 4 · Release notes", tab_no: 3, hidden_finished: 5, agents: subs("run", "run") }),
  root("t6", "a-5", "sp-2", { title: "Agent 5 · API client", harness: "codex", tab_no: 2, hidden_finished: 1, agents: subs("run", "run", "rev", "done") }),
  root("t7", "a-6", "sp-2", { title: "Agent 6 · Changelog", tab_no: 4, status: "idle" }),
  root("t8", "a-7", "sp-3", { title: "Agent 7 · Spike", tab_no: 6, hidden_finished: 2, agents: subs("rev", "done") }),
]);

const R1 = "t2";
const swarmRoot1 = root(R1, "a-1", "sp-1", {
  title: "Agent 1 · Parser rewrite",
  tab_no: 2,
  inbox: [1],
  agents: [
    node("a1b2c3d4e5f6", { title: "Explore · token passes", role: "Explore", activity: "Read src/parse/tokens.rs", tool_calls: 42, seq: 0 }),
    node("k2", { title: "Plan · split strategy", model: "sonnet", status: "done", ended: BOARD_NOW - 300, last_at: BOARD_NOW - 300, seq: 1 }),
    node("k2a", { parent: "k2", title: "Explore · lexer edge cases", activity: "Bash(cargo test lexer::edge…)", seq: 2 }),
    node("k2a1", { parent: "k2a", title: "Shell · cargo fmt", status: "done", ended: BOARD_NOW - 400, seq: 3 }),
    node("k2b", { parent: "k2", title: "Explore · old fixtures", activity: "Grep(fixture_*)", seq: 4 }),
    node("k3", { title: "Docs · README pass", status: "done", ended: BOARD_NOW - 500, seq: 5 }),
    node("a9f8e7d6", {
      title: "Review · parse/mod.rs",
      role: "Review",
      status: "blk",
      activity: "needs permission · cargo fmt",
      pending: ["needs permission to run cargo fmt"],
      last_message: "I want to run cargo fmt before suggesting edits.",
      tool_calls: 3,
      last_at: BOARD_NOW - 60,
      seq: 6,
    }),
  ],
});

/** PhoneSwarm and PhonePeek: Project Alpha, 3 roots, 7 agents. */
export const swarmTopic = topic([
  swarmRoot1,
  root("t3", "a-2", "sp-1", { title: "Agent 2 · Test cleanup", tab_no: 3, last_activity: BOARD_NOW - 840 }),
  root("t4", "a-3", "sp-1", { title: "Agent 3 · Docs pass", tab_no: 4, status: "idle", last_activity: BOARD_NOW - 840 }),
]);

export const swarmUi: SwarmUi = {
  open: { [R1]: true, [nodeUid(swarmRoot1, "k2")]: true },
  sel: nodeUid(swarmRoot1, "a1b2c3d4e5f6"),
};

export const peekUid = nodeUid(swarmRoot1, "a9f8e7d6");

export const peekTranscript: TranscriptPage = {
  range: "41–80 / 80",
  prev: true,
  next: false,
  entries: [
    { role: "user", text: "Review src/parse/mod.rs for the three-pass split." },
    { role: "assistant", text: "Reading the file. The second pass keeps a copy of the token list it never reads." },
    { role: "tool · Read", text: "src/parse/mod.rs (lines 1-120)" },
    { role: "assistant", text: "I want to run cargo fmt before suggesting edits." },
  ],
};

/** The fake data behind `?fixture=`: the three panorama boards. */
export function boardData(name: string | null): AppData | undefined {
  const common = { host: boardHost, spaceExtra: boardSpaceExtra, now: BOARD_NOW };
  switch (name) {
    case "agents":
      return { ...common, panorama: agentsTopic };
    case "swarm":
      return { ...common, panorama: swarmTopic, swarmUi };
    case "peek":
      return { ...common, panorama: swarmTopic, swarmUi, transcript: peekTranscript };
    default:
      return undefined;
  }
}
