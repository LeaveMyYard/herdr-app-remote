import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(FIX, p), "utf8")) as T;

/** The fake host: agent-1 at term-1 (pane-1), agent-2 at term-2. */
export const host = (): HostState => json<HostState>("host/typical.json");

type Asker = bridgeApi.InboxAsker;
export const core = (terminal: string): Asker => ({ host: "herdr-core", pane: null, terminal, tab_label: null, cwd: null });
export const tui = (pane: string): Asker => ({ host: "herdr-tui", pane, terminal: null, tab_label: null, cwd: null });

export const group = (n: number, asker: Asker, over: Record<string, unknown> = {}) => ({
  key: `group:${n}`,
  rev: `rev-g${n}`,
  actions: ["answer", "draft", "dismiss"],
  new: false,
  kind: "group",
  group: n,
  title: `Question Title ${n}`,
  created_at: `2026-01-02T12:00:${String(n % 60).padStart(2, "0")}+00:00`,
  asker,
  questions: [
    {
      id: n,
      header: null,
      question: `Question Text ${n}: pick one option.`,
      options: [
        { label: "Option A", description: "First test choice", preview: null },
        { label: "Option B", description: "Second test choice", preview: null },
      ],
      multi_select: false,
      context: null,
      asked_by: "agent-1",
      draft: null,
      cut: false,
    },
  ],
  ...over,
});

export const alert = (n: number, asker: Asker) => ({
  key: `alert:${n}`,
  rev: `rev-a${n}`,
  actions: ["ack"],
  new: false,
  kind: "alert",
  id: n,
  alert_kind: "agent",
  severity: "urgent",
  title: `Alert Title ${n}`,
  message: null,
  asked_by: "agent-1",
  created_at: "2026-01-02T11:00:00+00:00",
  asker,
});

export const failed = (n: number, asker: Asker) => ({
  key: `failed:${n}`,
  rev: `rev-f${n}`,
  actions: ["retry", "stop-showing"],
  new: false,
  kind: "failed",
  question_id: n,
  group: n,
  header: null,
  question: `Question Title ${n}`,
  asked_by: "agent-1",
  answer: "Option B",
  answered_at: "2026-01-02T10:00:00+00:00",
  retries: 0,
  cut: false,
  asker,
  delivery: { state: "failed", known: true, line: "Delivery failed.", warn: true, attempts: 2, pending_since: null, auto_retry: false },
  retry_label: "Retry delivery",
});

export const inbox = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  plugin: "ready",
  state: "ok",
  stale: false,
  problem: null,
  generated_at: 1800000000,
  errors: [],
  incomplete: null,
  empty: entries.length === 0,
  waiting: entries.filter((e) => (e as { kind: string }).kind === "group").length,
  alerts: entries.filter((e) => (e as { kind: string }).kind === "alert").length,
  entries,
  ...over,
});

const node = (id: string, status: string) => ({
  id,
  parent: null,
  harness: "claude",
  title: `Title ${id}`,
  role: "Explore",
  model: null,
  status,
  activity: "",
  last_message: "",
  pending: [],
  question_ids: [],
  error: null,
  tool_calls: 0,
  started: null,
  ended: null,
  last_at: null,
  seq: 0,
});

/** A panorama root at `terminal`, joined to `agent`, with subagents of these statuses. */
export const panorama = (terminal: string, agent: string | null, statuses: string[], over: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) => ({
  mode: "rich",
  stale: false,
  aged: false,
  error: null,
  collected_at: 1800000000,
  roots: [
    {
      key: `["root","herdr-core","${terminal}"]`,
      agent_id: agent,
      space_id: "space-1",
      terminal,
      live: true,
      shadowed: false,
      harness: "claude",
      title: "Agent 1",
      tab_no: null,
      status: "run",
      inbox: [],
      hidden_finished: 0,
      last_activity: null,
      agents: statuses.map((s, i) => node(`n${i + 1}`, s)),
      ...rootOver,
    },
  ],
  ...over,
});
