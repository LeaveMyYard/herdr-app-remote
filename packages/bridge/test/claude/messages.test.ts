// Defensive checks on getSessionMessages output (docs/chatview.md §3, §9). Fake data only.
import { describe, expect, it } from "vitest";
import { claude } from "../../src/index.js";

const { checkMessages, FAIL_SHARE } = claude;

const S = "11111111-1111-4111-8111-111111111111";
let n = 0;
const env = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  uuid: `u-${++n}`,
  session_id: S,
  parent_tool_use_id: null,
  parent_agent_id: null,
  timestamp: "2026-01-02T10:00:00.000Z",
  ...extra,
});
const user = (content: unknown, extra: Record<string, unknown> = {}) => env("user", { message: { role: "user", content }, ...extra });
const agent = (content: unknown) => env("assistant", { message: { role: "assistant", content } });

describe("checkMessages", () => {
  it("keeps prompts and replies, and turns string content into a text block", () => {
    const r = checkMessages([user("Hello Agent 1"), agent([{ type: "text", text: "Hi." }])]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.messages.map((m) => (m.type === "system" ? m.type : [m.type, m.content]))).toEqual([
      ["user", [{ type: "text", text: "Hello Agent 1" }]],
      ["assistant", [{ type: "text", text: "Hi." }]],
    ]);
    expect(r.messages[0]).toMatchObject({ sessionId: S, parentToolUseId: null, at: "2026-01-02T10:00:00.000Z", meta: false, compactSummary: false });
  });

  it("drops thinking text, tool_result content and anything not in the shape", () => {
    const r = checkMessages([
      agent([
        { type: "thinking", thinking: "secret plan", signature: "sig" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/project-alpha/README.md" }, caller: "x" },
      ]),
      user([{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents", is_error: true }], { toolUseResult: { stdout: "out" } }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = JSON.stringify(r.messages);
    expect(text).not.toContain("secret plan");
    expect(text).not.toContain("opaque");
    expect(text).not.toContain("file contents");
    expect(text).not.toContain("stdout");
    expect(r.messages[0]).toMatchObject({
      content: [{ type: "thinking" }, { type: "thinking" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/project-alpha/README.md" } }],
    });
    expect(r.messages[1]).toMatchObject({ content: [{ type: "tool_result", toolUseId: "toolu_1", isError: true }] });
  });

  it("drops a block of an unknown type and keeps the rest of the message", () => {
    const r = checkMessages([agent([{ type: "hologram", beam: 1 }, { type: "text", text: "Done." }]), agent([{ type: "hologram" }])]);
    expect(r).toMatchObject({ ok: true, stats: { total: 2, failed: 0, droppedBlocks: 2 } });
    if (!r.ok) return;
    expect(r.messages[0]).toMatchObject({ content: [{ type: "text", text: "Done." }] });
    expect(r.messages[1]).toMatchObject({ content: [] });
  });

  it("fails a message whose known block has the wrong fields", () => {
    const good = Array.from({ length: 20 }, () => agent([{ type: "text", text: "ok" }]));
    const r = checkMessages([...good, agent([{ type: "text", text: 42 }])]);
    expect(r).toMatchObject({ ok: true, stats: { total: 21, failed: 1 } });
    if (r.ok) expect(r.messages).toHaveLength(20);
  });

  it("fails on envelope changes: missing uuid, role mismatch, content not string or array", () => {
    for (const bad of [
      { ...agent([]), uuid: undefined },
      { ...agent([]), message: { role: "user", content: [] } },
      agent({ text: "object" }),
      { ...agent([]), session_id: 5 },
      { ...agent([]), parent_tool_use_id: 5 },
      { ...agent([]), message: "flat" },
      "not an object",
    ]) {
      expect(checkMessages([bad]), JSON.stringify(bad)).toMatchObject({ ok: false, stats: { failed: 1 } });
    }
  });

  it("is unavailable when more than the fail share fails, and not at the share", () => {
    expect(FAIL_SHARE).toBe(0.1);
    const ok = (k: number) => Array.from({ length: k }, () => user("Prompt"));
    const bad = (k: number) => Array.from({ length: k }, () => ({ type: "user", uuid: "x" }));
    expect(checkMessages([...ok(9), ...bad(1)]).ok).toBe(true);
    expect(checkMessages([...ok(8), ...bad(2)]).ok).toBe(false);
    expect(checkMessages([...ok(1), ...bad(1)], 0.6).ok).toBe(true);
  });

  it("is unavailable when the result is not an array, and fine when it is empty", () => {
    expect(checkMessages({ messages: [] }).ok).toBe(false);
    expect(checkMessages(null).ok).toBe(false);
    expect(checkMessages([])).toEqual({ ok: true, messages: [], stats: { total: 0, failed: 0, droppedBlocks: 0, droppedMessages: 0 } });
  });

  it("drops a message of an unknown type without failing", () => {
    const r = checkMessages([env("attachment", { message: {} }), user("Prompt")]);
    expect(r).toMatchObject({ ok: true, stats: { total: 2, failed: 0, droppedMessages: 1 } });
  });

  it("keeps system messages with their subtype when the SDK gives one", () => {
    const r = checkMessages([env("system"), env("system", { subtype: "compact_boundary" })]);
    expect(r.ok && r.messages).toMatchObject([{ type: "system" }, { type: "system", subtype: "compact_boundary" }]);
    expect(r.ok && "subtype" in r.messages[0]!).toBe(false);
  });

  it("passes on the SDK's meta, compact-summary and subagent markers", () => {
    const r = checkMessages([user("<command-name>/compact</command-name>", { is_meta: true, isCompactSummary: true }), env("assistant", { message: { role: "assistant", content: [] }, parent_tool_use_id: "toolu_9" })]);
    expect(r.ok && r.messages).toMatchObject([
      { meta: true, compactSummary: true },
      { parentToolUseId: "toolu_9", meta: false },
    ]);
  });

  it("normalizes a timestamp to ISO and makes a bad one null", () => {
    const r = checkMessages([user("a", { timestamp: "2026-01-02T12:00:00+02:00" }), user("b", { timestamp: "yesterday" }), user("c", { timestamp: 5 })]);
    expect(r.ok && r.messages.map((m) => m.at)).toEqual(["2026-01-02T10:00:00.000Z", null, null]);
  });
});
