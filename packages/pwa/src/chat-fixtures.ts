// Fake data only (design board PhoneChat). Replaced by the `chat:<t>` and `inbox` topics once the bridge client lands.
import type { bridgeApi } from "@herdr-remote/protocol";
import type { ChatAgent, ChatQuestion } from "./screens/Chat";

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

export const chatAgent: ChatAgent = { name: "Agent 1 · Parser rewrite", folder: "~/code/alpha", harness: "claude", status: "working" };

export const chatQuestion: ChatQuestion = { id: "Q123", href: "#/inbox" };

/** Chats the demo can open, by agent id. */
export const chats: Record<string, { agent: ChatAgent; topic: bridgeApi.ChatTopic; question?: ChatQuestion }> = {
  "a-1": { agent: chatAgent, topic: chatTopic, question: chatQuestion },
};
