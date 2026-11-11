// Fake data only (design board PhoneChat). Replaced by the `chat:<t>` and `inbox` topics once the bridge client lands.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ChatAgent, ChatQuestion } from "./screens/Chat";
import type { ChatInput } from "./screens/ChatComposer";

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
      keys: { enabled: state !== "off", menu: demoKeysMenu, press: ok },
    },
    now: () => clock,
    sheet: state === "menu" || state === "off",
    pressed: state === "menu" ? "ctrl-c" : null,
  };
}
