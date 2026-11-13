// Fake data only (design board PhoneChat). Replaced by the `chat:<t>` and `inbox` topics once the bridge client lands.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ChatAgent, ChatQuestion } from "./screens/Chat";
import type { ChatInput } from "./screens/ChatComposer";
import type { OlderResult } from "./bridge/chatview";
import type { ViewMode } from "./chatview/mode";
import { boardAccount, boardAlert, boardQuestion, boardStrip } from "./timeline/TimelineBoard";

const rule: bridgeApi.ChatLine = [{ t: "─".repeat(32), fg: "#383a3d" }];

export const chatTopic: bridgeApi.ChatTopic = {
  terminal: "t3",
  lines: [
    [{ t: "● I split the parser into three passes and kept the old entry point as a thin wrapper." }],
    [],
    [{ t: "  ⎿ src/parse/mod.rs      +84 −212" }],
    [{ t: "  ⎿ src/parse/tokens.rs   +131" }],
    [{ t: "  ⎿ tests/parse.rs        +46" }],
    [],
    [{ t: "● Tests pass: 212 passed, 0 failed." }],
    [],
    [{ t: "● I need one decision before the next step, so I asked it in the inbox: " }, { t: "Q123 · Question Title 123", fg: "#e5c07b" }],
    [],
    [{ t: "✻ Waiting for your answer · 3 shells running", fg: 8 }],
    [],
    rule,
    [{ t: "❯ ▌" }],
    rule,
    [{ t: "⏵⏵ auto mode on", fg: "#e5c07b" }, { t: " · 3 shells", fg: 8 }],
  ],
};

export const chatAgent: ChatAgent = { name: "Agent 1 · Parser rewrite", short: "Agent 1", folder: "~/code/alpha", harness: "claude", status: "working" };

export const chatQuestion: ChatQuestion = { id: "Q123", href: "#/inbox" };

/** Chats the demo can open, by agent id. */
export const chats: Record<string, { agent: ChatAgent; topic: bridgeApi.ChatTopic; question?: ChatQuestion }> = {
  "a-1": { agent: chatAgent, topic: chatTopic, question: chatQuestion },
};

/** The PhoneKeys board's states (`?fixture=chat&typing=<state>`): fake data, no bridge. */
export type TypingDemo = "bar" | "menu" | "off" | "soon" | "gone";

/** Today at 21:40 on this device's clock, the board's expiry. */
function at2140(): number {
  const d = new Date();
  d.setHours(21, 40, 0, 0);
  return d.getTime();
}

/** The board's key menu: the default keys, then two of the desktop's own. */
export const demoKeysMenu: bridgeApi.KeysTopic = {
  rev: "0123456789abcdef",
  keys: [
    ...bridgeApi.DEFAULT_KEYS,
    { id: "accept", label: "Accept ✓", keys: ["alt+1"] },
    { id: "clear-line", label: "Clear line", keys: ["ctrl+u"] },
  ],
};

/** Input, clock and sheet for one PhoneKeys state. */
export function typingDemo(state: string | null): { input: ChatInput; now: () => number; sheet: boolean; pressed: string | null } | null {
  if (state !== "bar" && state !== "menu" && state !== "off" && state !== "soon" && state !== "gone") return null;
  const until = at2140();
  const clock = state === "soon" ? until - 4 * 60_000 + 1 : state === "gone" ? until + 60_000 : until - 3 * 3_600_000;
  const ok = async () => ({ ok: true });
  return {
    input: {
      enabled: true,
      until,
      send: ok,
      // The ran-out board draws no Keys bar: special keys are off there too.
      keys: { enabled: state !== "off" && state !== "gone", menu: demoKeysMenu, press: ok },
    },
    now: () => clock,
    sheet: state === "menu" || state === "off",
    pressed: state === "menu" ? "ctrl-c" : null,
  };
}

// ---- chat view boards (design/PhoneChatView; `?fixture=chatview&view=<chat|history|new|off|codex>`) ----

/** Today at hh:mm:ss on this device's clock. */
function today(h: number, m: number, s = 0, days = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, s, 0);
  return d;
}
const iso = (d: Date) => d.toISOString();

type Item = bridgeApi.ChatItem;
const you = (id: string, text: string, at: Date): Item => ({ id, role: "you", at: iso(at), text });
const agentText = (id: string, text: string, at: Date): Item => ({ id, role: "agent", at: iso(at), text });
const tools = (id: string, kind: bridgeApi.ToolKind, count: number, names: string[], at: Date, running = 0): Item => ({ id, role: "tools", at: iso(at), tools: { kind, count, running, failed: 0, names } });
const day = (id: string, at: Date): Item => ({ id, role: "divider", at: iso(at), divider: "day" });

const todayItems: Item[] = [
  day("day-1", today(21, 2)),
  you("m-1", "Split the parser into smaller passes and keep the old API working.", today(21, 2)),
  agentText("m-2", "I split the parser into three passes and kept the old entry point as a thin wrapper:\n\n- `tokens.rs` turns text into tokens\n- `tree.rs` builds the tree\n- the old API calls both, so nothing else changes", today(21, 5)),
  tools("m-3", "edit", 3, ["Edit · mod.rs", "Edit · tokens.rs", "Write · tree.rs"], today(21, 6)),
  tools("m-4", "shell", 1, ["Bash"], today(21, 8)),
  agentText("m-5", "Tests pass: 212 passed, 0 failed. Now updating the docs.", today(21, 9)),
  tools("m-6", "read", 2, ["Read · README.md", "Read · parse.md"], today(21, 10), 2),
];

const olderItems: Item[] = [
  day("day-0", today(18, 40, 0, -1)),
  you("o-1", "Add a test for the empty input case.", today(18, 40, 0, -1)),
  agentText("o-2", "Added it. It failed at first because the tokenizer returned `None` for an empty string; fixed that too.", today(18, 42, 0, -1)),
  tools("o-3", "edit", 2, ["Edit · tokens.rs", "Edit · parse.rs"], today(18, 43, 0, -1)),
  tools("o-4", "shell", 2, ["Bash", "Bash"], today(18, 44, 0, -1)),
  agentText("o-5", "Both pass now.", today(18, 45, 0, -1)),
  day("day-1", today(21, 2)),
  you("m-1", "Split the parser into smaller passes and keep the old API working.", today(21, 2)),
];

export interface ChatviewDemo {
  mode: ViewMode;
  topic?: bridgeApi.ChatviewTopic;
  input?: ChatInput;
  now: () => number;
  /** The text view's lines (Codex). */
  text?: bridgeApi.ChatTopic;
  agent?: ChatAgent;
  loadOlder?: (before: string, rev: string) => Promise<OlderResult>;
  /** The `timeline:<t>` value: the strip and the inline items (CV5). */
  timeline?: bridgeApi.TimelineTopic;
}

/**
 * The board's timeline (PhoneChatView, every state: the strip; "Typing off": the question after the last reply;
 * "History": the alert after yesterday's last reply). Placed by `at` among the demo items, as the live ones are.
 */
function demoTimeline(state: "chat" | "off" | "history"): bridgeApi.TimelineTopic {
  const strip = [boardStrip, boardAccount];
  if (state === "off") {
    const asked = iso(today(21, 12, 12));
    const data = { ...(boardQuestion.data as Record<string, unknown>), created_at: asked };
    return { terminal: "t2", strip, items: [{ ...boardQuestion, at: asked, anchor: null, data }] };
  }
  if (state === "history") return { terminal: "t2", strip, items: [{ ...boardAlert, at: iso(today(18, 46, 0, -1)) }] };
  return { terminal: "t2", strip, items: [] };
}

export function chatviewDemo(state: string | null): ChatviewDemo | null {
  const clock = today(21, 14, 12).getTime();
  const until = today(21, 40).getTime();
  const ok = async () => ({ ok: true });
  const input = (enabled: boolean): ChatInput => ({ enabled, until: enabled ? until : null, send: ok });
  const agent: ChatAgent = { name: "Agent 1", folder: "~/code/alpha", harness: "claude", status: "working" };
  const base = { terminal: "t2", harness: "claude", state: "ok" as const, older: false, rev: "demo-rev-1" };
  const working = { state: "working" as const, since: iso(today(21, 13, 0)) };
  switch (state) {
    case "chat":
      return { mode: { kind: "chat" }, topic: { ...base, items: todayItems, status: working }, input: input(true), now: () => clock, agent, timeline: demoTimeline("chat") };
    case "history":
      return {
        mode: { kind: "chat" },
        topic: { ...base, older: true, items: olderItems, status: { state: "idle", since: null } },
        input: input(true),
        now: () => clock,
        agent,
        loadOlder: () => new Promise(() => undefined),
        timeline: demoTimeline("history"),
      };
    case "new":
      return { mode: { kind: "chat" }, topic: { ...base, items: [], status: { state: "idle", since: null } }, input: input(true), now: () => clock, agent: { name: "Agent 5", folder: "~/code/alpha", harness: "claude", status: "idle" } };
    case "off":
      return { mode: { kind: "chat" }, topic: { ...base, items: todayItems.slice(2, 5), status: working }, input: input(false), now: () => clock, agent, timeline: demoTimeline("off") };
    case "codex":
      return { mode: { kind: "text", notice: "codex" }, text: chatTopic, input: { ...input(true), keys: { enabled: true, menu: demoKeysMenu, press: ok } }, now: () => clock, agent: { name: "Agent 3", folder: "~/code/alpha", harness: "codex", status: "working" } };
    default:
      return null;
  }
}
