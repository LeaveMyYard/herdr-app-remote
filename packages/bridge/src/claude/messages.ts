// Defensive checks on what the SDK's getSessionMessages returns (docs/chatview.md §3, §9). The SDK types
// `message` as `unknown` and has no `timestamp` in its type, so every message and block is checked here.
// A block of a type this version doesn't know is dropped. A message whose envelope or known blocks don't
// match the shapes the rig test pins counts as failed and is left out. A message of an unknown `type` is
// dropped and counts toward the same share, so a Claude Code change that moves turns to a new type can't
// silently hide half a conversation: when more than FAIL_SHARE of the messages fail or are dropped, the whole
// read is `shape` (the chat view goes unavailable and the phone shows the terminal).
//
// What is kept is only what the chat view can use. Thinking text, tool_result content and `toolUseResult`
// are not copied (§5.2). Tool inputs are kept, because the topic (CV3) derives file base names and
// AskUserQuestion text from them; they never leave the bridge as they are.

export const FAIL_SHARE = 0.1;

export type ClaudeBlock =
  | { type: "text"; text: string }
  /** `thinking` and `redacted_thinking`, with their content dropped. */
  | { type: "thinking" }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean };

interface Envelope {
  uuid: string;
  sessionId: string;
  /** Set for a subagent's messages. */
  parentToolUseId: string | null;
  /** ISO time from the SDK's untyped `timestamp`, or null when it is missing or not a date. */
  at: string | null;
  /** The SDK's `is_meta` (meta, compact-summary or transcript-only entries): not a "you" bubble. */
  meta: boolean;
  /** The SDK's `isCompactSummary`: the summary written after a compaction. */
  compactSummary: boolean;
}

export type ClaudeMessage =
  | (Envelope & { type: "user" | "assistant"; content: ClaudeBlock[] })
  /** `subtype` is set when the SDK reports one (0.3.312 does not). */
  | (Envelope & { type: "system"; subtype?: string });

export interface ReadStats {
  total: number;
  failed: number;
  /** Blocks of unknown types, dropped. */
  droppedBlocks: number;
  /** Messages of an unknown `type`, dropped. They count toward the failure share like failed ones. */
  droppedMessages: number;
}

export type CheckResult = { ok: true; messages: ClaudeMessage[]; stats: ReadStats } | { ok: false; stats: ReadStats };

const KNOWN_TYPES = new Set(["user", "assistant", "system"]);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A known block with the wrong fields is `null` (the message fails); an unknown type is `undefined` (dropped). */
function checkBlock(b: unknown): ClaudeBlock | null | undefined {
  if (!isRecord(b) || typeof b.type !== "string") return null;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? { type: "text", text: b.text } : null;
    case "thinking":
    case "redacted_thinking":
      return { type: "thinking" };
    case "tool_use":
      return typeof b.id === "string" && typeof b.name === "string" && "input" in b ? { type: "tool_use", id: b.id, name: b.name, input: b.input } : null;
    case "tool_result":
      if (typeof b.tool_use_id !== "string" || (b.is_error !== undefined && typeof b.is_error !== "boolean")) return null;
      return { type: "tool_result", toolUseId: b.tool_use_id, isError: b.is_error === true };
    default:
      return undefined;
  }
}

function checkAt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One message: the checked message, `null` when it fails, `undefined` when its type is unknown (dropped). */
function checkMessage(m: unknown, stats: ReadStats): ClaudeMessage | null | undefined {
  if (!isRecord(m) || typeof m.type !== "string") return null;
  if (!KNOWN_TYPES.has(m.type)) return undefined;
  if (typeof m.uuid !== "string" || m.uuid === "" || typeof m.session_id !== "string") return null;
  if (m.parent_tool_use_id !== null && m.parent_tool_use_id !== undefined && typeof m.parent_tool_use_id !== "string") return null;
  const env: Envelope = {
    uuid: m.uuid,
    sessionId: m.session_id,
    parentToolUseId: typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : null,
    at: checkAt(m.timestamp),
    meta: m.is_meta === true,
    compactSummary: m.isCompactSummary === true,
  };
  if (m.type === "system") return { ...env, type: "system", ...(typeof m.subtype === "string" ? { subtype: m.subtype } : {}) };
  const msg = m.message;
  if (!isRecord(msg) || msg.role !== m.type) return null;
  const raw = msg.content;
  let content: ClaudeBlock[];
  if (typeof raw === "string") content = [{ type: "text", text: raw }];
  else if (Array.isArray(raw)) {
    content = [];
    for (const b of raw) {
      const c = checkBlock(b);
      if (c === null) return null;
      if (c === undefined) stats.droppedBlocks++;
      else content.push(c);
    }
  } else return null;
  return { ...env, type: m.type as "user" | "assistant", content };
}

/** Checks a getSessionMessages result. Not an array, or more than `failShare` failed or dropped: `ok: false`. */
export function checkMessages(raw: unknown, failShare = FAIL_SHARE): CheckResult {
  const stats: ReadStats = { total: 0, failed: 0, droppedBlocks: 0, droppedMessages: 0 };
  if (!Array.isArray(raw)) return { ok: false, stats };
  stats.total = raw.length;
  const messages: ClaudeMessage[] = [];
  for (const m of raw) {
    const c = checkMessage(m, stats);
    if (c === null) stats.failed++;
    else if (c === undefined) stats.droppedMessages++;
    else messages.push(c);
  }
  if (stats.total > 0 && (stats.failed + stats.droppedMessages) / stats.total > failShare) return { ok: false, stats };
  return { ok: true, messages, stats };
}
