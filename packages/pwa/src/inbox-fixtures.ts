// Fake data only: demo scenarios for the Inbox tab until the bridge client lands (`#/inbox/<scenario>`).
import type { bridgeApi, HostState } from "@herdr-remote/protocol";

/** POSIX seconds the demo scenarios are drawn at, so ages are stable. */
export const DEMO_NOW = Date.UTC(2026, 5, 1, 12, 0, 0) / 1000;

const ago = (minutes: number): string => new Date((DEMO_NOW - minutes * 60) * 1000).toISOString().replace(/\.\d+Z$/, "+00:00");

export const demoHost: HostState = {
  spaces: [
    { id: "space-1", name: "Project Alpha", focused: true },
    { id: "space-2", name: "Project Beta", focused: false },
  ],
  agents: [
    { id: "agent-1", name: "Agent 1", harness: "claude", state: "waiting", space_id: "space-1", terminal_id: "t1" },
    { id: "agent-2", name: "Agent 2", harness: "claude", state: "idle", space_id: "space-1", terminal_id: "t2" },
    { id: "agent-3", name: "Agent 3", harness: "codex", state: "working", space_id: "space-2", terminal_id: "t3" },
  ],
  terminals: [
    { id: "t1", title: "Agent 1", space_id: "space-1", cols: 120, rows: 40 },
    { id: "t2", title: "Agent 2", space_id: "space-1", cols: 120, rows: 40 },
    { id: "t3", title: "Agent 3", space_id: "space-2", cols: 120, rows: 40 },
  ],
  panes: [{ id: "pane-4", space_id: "space-2", terminal_id: "t3", kind: "terminal" }],
  focused: { space_id: "space-1", pane_id: null, agent_id: "agent-1" },
  theme: { name: "Theme 1", mode: "dark" },
  layout_name: "herdr-remote",
  shared: { "panorama.feed.owner": null },
};

const asker = (terminal: string, over: Partial<bridgeApi.InboxAsker> = {}): bridgeApi.InboxAsker => ({
  host: "herdr-core",
  pane: null,
  terminal,
  tab_label: null,
  cwd: null,
  ...over,
});

const question = (id: number, over: Partial<bridgeApi.InboxQuestion> = {}): bridgeApi.InboxQuestion => ({
  id,
  header: "Choice",
  question: `Question Title ${id}`,
  options: [
    { label: "Option A", description: "The first", preview: null },
    { label: "Option B", description: null, preview: null },
  ],
  multi_select: false,
  context: null,
  asked_by: "claude-1",
  draft: null,
  cut: false,
  ...over,
});

const group = (id: number, minutes: number, a: bridgeApi.InboxAsker, over: Record<string, unknown> = {}): bridgeApi.InboxRow =>
  ({
    key: `group:${id}`,
    kind: "group",
    actions: ["answer", "draft", "dismiss"],
    new: false,
    group: id,
    title: `Question Title ${id}`,
    created_at: ago(minutes),
    asker: a,
    questions: [question(id)],
    ...over,
  }) as bridgeApi.InboxRow;

const alert456: bridgeApi.InboxRow = {
  key: "alert:456",
  kind: "alert",
  actions: ["ack"],
  new: false,
  id: 456,
  alert_kind: "agent",
  severity: "warning",
  title: "Alert Title 456",
  message: null,
  asked_by: "claude-3",
  created_at: ago(9),
  asker: asker("t3"),
};

const failed = (qid: number, state: string, over: Record<string, unknown> = {}): bridgeApi.InboxRow =>
  ({
    key: `failed:${qid}`,
    kind: "failed",
    actions: ["retry", "stop-showing"],
    new: false,
    question_id: qid,
    group: qid,
    header: null,
    question: `Question Title ${qid}`,
    asked_by: "claude-2",
    answer: "Option B",
    answered_at: ago(60),
    retries: 0,
    cut: false,
    asker: asker("t2"),
    delivery: {
      state,
      known: true,
      line: state === "agent_gone" ? "The agent is gone." : "The agent is busy; it sends when the grace ends.",
      warn: state === "agent_gone",
      attempts: 0,
      pending_since: null,
      auto_retry: state !== "agent_gone",
    },
    retry_label: "Retry delivery",
    ...over,
  }) as bridgeApi.InboxRow;

const OK: Omit<bridgeApi.InboxTopic, "entries" | "waiting" | "alerts" | "empty"> = {
  plugin: "ready",
  state: "ok",
  stale: false,
  problem: null,
  generated_at: DEMO_NOW - 2,
  errors: [],
  incomplete: null,
};

function ok(entries: bridgeApi.InboxRow[], over: Partial<bridgeApi.InboxTopic> = {}): bridgeApi.InboxTopic {
  return {
    ...OK,
    empty: false,
    waiting: entries.filter((e) => e.kind === "group").length,
    alerts: entries.filter((e) => e.kind === "alert").length,
    entries,
    ...over,
  };
}

const unavailable = (over: Partial<bridgeApi.InboxTopic> = {}): bridgeApi.InboxTopic => ({
  plugin: "ready",
  state: "unavailable",
  stale: true,
  problem: "missing",
  generated_at: null,
  errors: [],
  incomplete: null,
  empty: false,
  waiting: 0,
  alerts: 0,
  entries: [],
  ...over,
});

const g123 = group(123, 2, asker("t1"), { new: true, questions: [question(123), question(124, { draft: { choices: ["Option A"], notes: {}, text: null } }), question(125)] });

export interface InboxScenario {
  name: string;
  topic: bridgeApi.InboxTopic;
}

const SCENARIOS: Record<string, bridgeApi.InboxTopic> = {
  // The board: two groups and an alert (the feed puts alerts first; the board's order is only for the picture).
  typical: ok([g123, group(127, 14, asker("t3")), alert456]),
  empty: ok([], { empty: true }),
  failed: ok([group(127, 14, asker("t3")), failed(119, "pending"), failed(120, "agent_gone"), failed(121, "agent_gone")]),
  stale: ok([alert456, g123], { stale: true, problem: "unreadable", generated_at: DEMO_NOW - 300 }),
  incomplete: ok([alert456, g123], {
    errors: ["a remote machine was not read"],
    incomplete: { counts: ["2 questions", "1 group"], errors: ["a remote machine was not read"], unlisted: 1 },
  }),
  "left-out-only": ok([], {
    waiting: 1,
    incomplete: { counts: ["1 question", "1 group"], errors: [], unlisted: 1 },
  }),
  unknown: ok([
    alert456,
    { key: "wat:1", kind: "wat", actions: [], new: false },
    {
      key: "remote:m1|db|3",
      kind: "remote_group",
      actions: [],
      new: false,
      machine: { id: "m1", label: "Machine 1", offline: null },
      title: "Question Title 3",
      created_at: ago(30),
      tab_label: null,
      questions: [question(3)],
    },
  ]),
  unavailable: unavailable(),
  missing: unavailable({ plugin: "missing", problem: null }),
  "too-old": unavailable({ plugin: "too_old", problem: null }),
};

export function inboxScenario(name: string | undefined): InboxScenario {
  const key = name && name in SCENARIOS ? name : "typical";
  return { name: key, topic: SCENARIOS[key] as bridgeApi.InboxTopic };
}

export const inboxInstallCommand = "[HERDR-INBOX INSTALL COMMAND]";
