import type { ClaudeBlock, ClaudeMessage } from "../../src/claude/messages.js";

/** A message uuid from a number (fake, stable). */
export const U = (i: number): string => `a2000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
export const SID = "11111111-1111-4111-8111-111111111111";
/** Noon UTC on 2026-01-02, plus `s` seconds: well inside one local day in any time zone a test runs in. */
export const AT = (s: number): string => new Date(Date.UTC(2026, 0, 2, 12, 0, 0) + s * 1000).toISOString();

type Over = Partial<Pick<ClaudeMessage, "parentToolUseId" | "at" | "meta" | "compactSummary">>;

const env = (i: number, over: Over) => ({
  uuid: U(i),
  sessionId: SID,
  parentToolUseId: null,
  at: AT(i),
  meta: false,
  compactSummary: false,
  ...over,
});

export const text = (t: string): ClaudeBlock => ({ type: "text", text: t });
export const tool = (id: string, name: string, input: unknown = {}): ClaudeBlock => ({ type: "tool_use", id, name, input });
export const result = (id: string, isError = false): ClaudeBlock => ({ type: "tool_result", toolUseId: id, isError });
export const thinking: ClaudeBlock = { type: "thinking" };

export const user = (i: number, content: ClaudeBlock[] | string, over: Over = {}): ClaudeMessage => ({
  ...env(i, over),
  type: "user",
  content: typeof content === "string" ? [text(content)] : content,
});
export const agent = (i: number, content: ClaudeBlock[] | string, over: Over = {}): ClaudeMessage => ({
  ...env(i, over),
  type: "assistant",
  content: typeof content === "string" ? [text(content)] : content,
});
export const system = (i: number, over: Over = {}): ClaudeMessage => ({ ...env(i, over), type: "system" });

/** Every local day is one day: no day dividers but the first, so a test can look at the rest. */
export const oneDay = { dayOf: () => "d" };
