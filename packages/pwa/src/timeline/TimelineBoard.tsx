// The visual harness's stand-in for the timeline parts of design/PhoneChatView (`?fixture=timeline&state=...`).
// Fake data only. Each part sits where the board draws it, so the harness compares that part of the render; the
// chat around it is CV4's screen and is not drawn here.
import type { ReactNode } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import { TimelineRow, TimelineStrip } from "./Timeline";

const AT = "2026-01-02T21:02:00+00:00";
/** POSIX seconds two minutes after the question was asked ("Q123 · 2m"). */
const NOW = Date.parse(AT) / 1000 + 120;
const asker = { host: "herdr-core" as const, pane: null, terminal: "t1", tab_label: null, cwd: null };

export const boardQuestion: bridgeApi.TimelineItem = {
  key: "group:123",
  plugin: "herdr-inbox",
  kind: "inbox.question",
  at: "2026-01-02T21:02:00.000Z",
  anchor: { tool_use_id: "toolu_01FakeAskOperator123" },
  title: "Question Title 123",
  line: "Question Text 345: pick one option.",
  href: "#/inbox/q/group%3A123/123",
  data: {
    key: "group:123",
    rev: "rev-fake-123",
    actions: ["answer", "draft", "dismiss"],
    new: false,
    kind: "group",
    group: 123,
    title: "Question Title 123",
    created_at: AT,
    asker,
    questions: [
      {
        id: 123,
        header: null,
        question: "Question Text 345: pick one option.",
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
  },
};

export const boardAlert: bridgeApi.TimelineItem = {
  key: "alert:456",
  plugin: "herdr-inbox",
  kind: "inbox.alert",
  at: "2026-01-01T18:41:00.000Z",
  anchor: null,
  title: "Alert Title 456",
  line: "",
  href: "#/inbox",
  data: { key: "alert:456", rev: "rev-fake-456", actions: ["ack"], new: false, kind: "alert", id: 456, alert_kind: "agent", severity: "urgent", title: "Alert Title 456", message: null, asked_by: "agent-1", created_at: AT, asker },
};

export const boardFailed: bridgeApi.TimelineItem = {
  key: "failed:119",
  plugin: "herdr-inbox",
  kind: "inbox.failed",
  at: "2026-01-01T18:42:00.000Z",
  anchor: null,
  title: "Answer to Q119 not delivered",
  line: "Delivery failed.",
  href: "#/inbox",
  data: {
    key: "failed:119",
    rev: "rev-fake-119",
    actions: ["retry", "stop-showing"],
    new: false,
    kind: "failed",
    question_id: 119,
    group: 119,
    header: null,
    question: "Question Title 119",
    asked_by: "agent-1",
    answer: "Option B",
    answered_at: AT,
    retries: 0,
    cut: false,
    asker,
    delivery: { state: "failed", known: true, line: "Delivery failed.", warn: true, attempts: 2, pending_since: null, auto_retry: false },
    retry_label: "Retry delivery",
  },
};

export const boardStrip: bridgeApi.StripItem = {
  key: 'panorama.swarm:["root","herdr-core","t1"]',
  plugin: "herdr-panorama",
  kind: "panorama.swarm",
  label: "6 subagents",
  tone: "warn",
  href: "#/swarm/space-1",
  data: {
    root_key: '["root","herdr-core","t1"]',
    space_id: "space-1",
    counts: [
      { code: "run", n: 2 },
      { code: "done", n: 3 },
      { code: "wait", n: 1 },
    ],
    total: 6,
    needs: "n6",
  },
};

export const boardAccount: bridgeApi.StripItem = {
  key: "usage.account:claude-2",
  plugin: "herdr-agent-usage",
  kind: "usage.account",
  label: "Account 2 · 38% used",
  tone: "ok",
  href: "#/usage",
  data: { provider_id: "claude-2", account: "Account 2", used_percent: 38, window: "5h" },
};

/**
 * Where the board draws each part (design/refs/PhoneChatView-*.png, found from its fills and borders). The question
 * card sits at y 488.4 there: the chat above it ends between pixels, and the options round from that.
 */
export const BOARD_PLACES = {
  strip: { top: 114 },
  question: { top: 488.4 },
  alert: { top: 565 },
  failed: { top: 640 },
} as const;

export function TimelineBoard({ state }: { state: string | null }) {
  const at = (top: number, child: ReactNode, key: string) => (
    <div key={key} style={{ position: "absolute", top, left: 16, right: 16 }}>
      {child}
    </div>
  );
  return (
    <div className="hd ph">
      <div style={{ position: "absolute", top: BOARD_PLACES.strip.top, left: 0, right: 0 }}>
        <TimelineStrip strip={[boardStrip, boardAccount]} />
      </div>
      {state === "history"
        ? [at(BOARD_PLACES.alert.top, <TimelineRow item={boardAlert} now={NOW} />, "a"), at(BOARD_PLACES.failed.top, <TimelineRow item={boardFailed} now={NOW} />, "f")]
        : at(BOARD_PLACES.question.top, <TimelineRow item={boardQuestion} now={NOW} />, "q")}
    </div>
  );
}
