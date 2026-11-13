import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { checkMessages } from "../../src/claude/messages.js";
import { cutBytes, jsonBytes, mapMessages, messageText, newest } from "../../src/chatview/map.js";
import { AT, U, agent, oneDay, result, system, text, thinking, tool, user } from "./helpers.js";

const REPO = new URL("../../../../", import.meta.url);
const strip = (items: bridgeApi.ChatItem[]) => items.filter((i) => !(i.role === "divider" && i.divider === "day"));
const map = (ms: Parameters<typeof mapMessages>[0]) => strip(mapMessages(ms, oneDay));

describe("chat items (§3)", () => {
  it("a user's text is a you bubble, an assistant's text an agent item; thinking is hidden", () => {
    const items = map([user(1, "Hello Agent 1"), agent(2, [thinking]), agent(3, [thinking, text("Hi, **user-1**.")])]);
    expect(items).toEqual([
      { id: U(1), role: "you", at: AT(1), text: "Hello Agent 1" },
      { id: U(3), role: "agent", at: AT(3), text: "Hi, **user-1**." },
    ]);
  });

  it("meta user messages and system messages show nothing", () => {
    expect(map([user(1, "caveat", { meta: true }), system(2), user(3, "   ")])).toEqual([]);
  });

  it("Claude Code's interrupt marker (Esc while working, CV8) is a stopped status row, not a bubble", () => {
    const items = map([
      user(1, "Split the parser"),
      agent(2, "Agent 1 is working on Project Alpha."),
      user(3, [text("[Request interrupted by user]")]),
      agent(4, [tool("b1", "Bash", { command: "x" })]),
      user(5, [result("b1", true)]),
      user(6, [text("[Request interrupted by user for tool use]")]),
    ]);
    expect(items.filter((i) => i.role === "status")).toEqual([
      { id: U(3), role: "status", at: AT(3), status: "stopped" },
      { id: U(6), role: "status", at: AT(6), status: "stopped" },
    ]);
    expect(items.some((i) => i.role === "you" && i.text.includes("interrupted"))).toBe(false);
    for (const i of items) expect(bridgeApi.ChatItem.safeParse(i).success).toBe(true);
    // Exactly the marker: anything else the person wrote stays their bubble.
    expect(map([user(1, "[Request interrupted by user] and then go on")])).toEqual([{ id: U(1), role: "you", at: AT(1), text: "[Request interrupted by user] and then go on" }]);
    expect(map([user(1, [text("[Request interrupted by user]"), text("more")])])[0]!.role).toBe("you");
    expect(map([user(1, "[request interrupted by user]")])[0]!.role).toBe("you");
  });

  it("a slash command is a one-line chip, never its arguments; command output and reminders show nothing", () => {
    const items = map([
      user(1, "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep Project Alpha secret notes</command-args>"),
      user(2, "<local-command-stdout>Total cost: $1.23</local-command-stdout>"),
      user(3, "<command-name>review</command-name>"),
      user(4, "<command-name>/bad name; rm</command-name>"),
      user(5, "<system-reminder>internal</system-reminder>"),
      user(6, "<b>bold</b> is what I typed"),
    ]);
    expect(items).toEqual([
      { id: U(1), role: "you", at: AT(1), text: "/compact", command: true },
      { id: U(3), role: "you", at: AT(3), text: "/review", command: true },
      { id: U(4), role: "you", at: AT(4), text: "/command", command: true },
      { id: U(6), role: "you", at: AT(6), text: "<b>bold</b> is what I typed" },
    ]);
    expect(JSON.stringify(items)).not.toContain("secret notes");
    expect(JSON.stringify(items)).not.toContain("1.23");
  });

  it("harness wrappers never reach the phone, in one block or many (H1 probes)", () => {
    const leak = (items: bridgeApi.ChatItem[]) => JSON.stringify(items);
    // P1: two blocks, both reminders.
    expect(map([user(1, [text("<system-reminder>HOOKCTX one</system-reminder>"), text("<system-reminder>HOOKCTX two</system-reminder>")])])).toEqual([]);
    // P2: a reminder block and a prompt block: the prompt only.
    expect(map([user(1, [text("<system-reminder>HOOKCTX</system-reminder>"), text("real prompt")])])).toEqual([{ id: U(1), role: "you", at: AT(1), text: "real prompt" }]);
    // P3: tool results and reminders: nothing, and the tool row is still closed.
    const p3 = map([agent(1, [tool("t1", "Bash", {})]), user(2, [result("t1"), text("<system-reminder>A</system-reminder>"), text("<system-reminder>B</system-reminder>")])]);
    expect(p3).toEqual([{ id: U(1), role: "tools", at: AT(1), tools: { kind: "shell", count: 1, running: 0, failed: 0, names: ["Bash"] } }]);
    // P4: IDE context (underscore tags) with a prompt.
    const p4 = map([user(1, [text("<ide_opened_file>The user opened /work/user-1/secret.ts</ide_opened_file>"), text("fix it")])]);
    expect(p4).toEqual([{ id: U(1), role: "you", at: AT(1), text: "fix it" }]);
    // In one block, around the prompt; with attributes; an unclosed wrapper hides the rest of its block.
    const one = map([
      user(1, "<ide_selection>const key = 1;</ide_selection>\nexplain this\n<system-reminder>HOOKCTX</system-reminder>"),
      user(2, '<user-prompt-submit-hook kind="x">HOOKCTX</user-prompt-submit-hook>please'),
      user(3, "look here <system-reminder>HOOKCTX never closed"),
      user(4, "<ide-diagnostics>HOOKCTX</ide-diagnostics>"),
    ]);
    expect(one.map((i) => (i as { text: string }).text)).toEqual(["explain this", "please", "look here"]);
    // Fail closed: a block that is only tags of any name is not shown.
    expect(map([user(1, [text("<unknown_ctx>HOOKCTX</unknown_ctx>"), text("hi")])])).toEqual([{ id: U(1), role: "you", at: AT(1), text: "hi" }]);
    // A command chip still comes through when it is all there is, across blocks.
    expect(map([user(1, [text("<command-name>/compact</command-name>"), text("<command-args>secret args</command-args>")])])).toEqual([{ id: U(1), role: "you", at: AT(1), text: "/compact", command: true }]);
    expect(leak([...p3, ...p4, ...one])).not.toMatch(/HOOKCTX|secret|const key/);
  });

  it("labels are cut by UTF-16 units (what the schema counts), so emoji never break the topic", () => {
    const emoji = "😀".repeat(399);
    const [ask] = map([agent(1, [tool("q", "AskUserQuestion", { questions: [{ question: "Q?", header: emoji, options: [{ label: emoji, description: emoji.repeat(6) }] }] })])]);
    expect(bridgeApi.ChatItem.safeParse(ask).success).toBe(true);
    const a = (ask as { ask: bridgeApi.ChatAsk }).ask;
    expect(a.options[0]!.label.length).toBeLessThanOrEqual(400);
    expect(a.options[0]!.label.endsWith("😀…")).toBe(true);
    const [row] = map([agent(1, [tool("t", "𝒜".repeat(100), {}), tool("u", "Read", { file_path: `/w/${"😀".repeat(200)}` })])]);
    expect(bridgeApi.ChatItem.safeParse(row).success).toBe(true);
  });

  it("control and bidi characters never reach a label", () => {
    const [row] = map([agent(1, [tool("t", "Bad\nTool\u202e", {}), tool("u", "Read", { file_path: "/w/evil\u202egnp.ts\nx" })])]);
    expect((row as { tools: bridgeApi.ChatTools }).tools.names).toEqual(["Bad Tool", "Read · evil gnp.ts x"]);
  });

  it("an AskUserQuestion call counts toward the message's 32 KB and is cut to fit", () => {
    const big = "問".repeat(4000);
    const options = Array.from({ length: 20 }, (_, i) => ({ label: `${i}${"選".repeat(130)}`, description: "説".repeat(660) }));
    const questions = Array.from({ length: 4 }, () => ({ question: big, header: "H", options }));
    const items = map([agent(1, [text("t".repeat(20_000)), tool("q", "AskUserQuestion", { questions })])]);
    const asks = items.filter((i) => i.role === "ask") as Extract<bridgeApi.ChatItem, { role: "ask" }>[];
    expect(asks).toHaveLength(4);
    expect(asks.every((a) => a.cut === true)).toBe(true);
    const bytes = 20_000 + asks.reduce((n, a) => n + Buffer.byteLength((a.ask.question ?? "") + (a.ask.header ?? "") + a.ask.options.map((o) => o.label + (o.description ?? "")).join("")), 0);
    expect(bytes).toBeLessThanOrEqual(bridgeApi.CHATVIEW_MESSAGE_MAX_BYTES);
    for (const a of asks) expect(bridgeApi.ChatItem.safeParse(a).success).toBe(true);
    // Text that already took (nearly) all of it: the asks still fit, with options dropped and questions cut (L10).
    const full = map([agent(1, [text("t".repeat(16_000)), text("u".repeat(16_000)), tool("q", "AskUserQuestion", { questions })])]);
    const fasks = full.filter((i) => i.role === "ask") as Extract<bridgeApi.ChatItem, { role: "ask" }>[];
    const ftext = Buffer.byteLength((full[0] as { text: string }).text);
    expect(ftext).toBeGreaterThan(32_000);
    const fbytes = ftext + fasks.reduce((n, a) => n + Buffer.byteLength((a.ask.question ?? "") + (a.ask.header ?? "") + a.ask.options.map((o) => o.label + (o.description ?? "")).join("")), 0);
    expect(fbytes).toBeLessThanOrEqual(bridgeApi.CHATVIEW_MESSAGE_MAX_BYTES);
    expect(fasks.every((a) => a.cut === true && bridgeApi.ChatItem.safeParse(a).success)).toBe(true);
    // A small one is untouched.
    expect(map([agent(1, [tool("q", "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "A" }] }] })])])[0]).not.toHaveProperty("cut");
  });

  it("consecutive tool calls are one row counted by kind, named by tool and file base name only", () => {
    const items = map([
      agent(1, [tool("t1", "Read", { file_path: "/work/user-1/work/project-alpha/src/main.ts" })]),
      agent(2, [thinking, tool("t2", "Read", { file_path: "/work/user-1/work/project-alpha/README.md" })]),
      user(3, [result("t1"), result("t2")]),
      agent(4, [tool("t3", "Bash", { command: "cargo test --secret-flag" })]),
    ]);
    expect(items).toEqual([
      {
        id: U(1),
        role: "tools",
        at: AT(1),
        tools: { kind: "other", count: 3, running: 1, failed: 0, names: ["Read · main.ts", "Read · README.md", "Bash"] },
      },
    ]);
    const s = JSON.stringify(items);
    expect(s).not.toContain("/work/user-1");
    expect(s).not.toContain("cargo");
  });

  it("a run of one kind is that kind; an error result counts as failed; text breaks the run", () => {
    const items = map([
      agent(1, [tool("t1", "Bash", { command: "x" }), tool("t2", "Bash", { command: "y" })]),
      user(2, [result("t1"), result("t2", true)]),
      agent(3, "Done."),
      agent(4, [tool("t3", "Edit", { file_path: "/w/a.ts" }), tool("t4", "Write", { file_path: "/w/b.ts" })]),
      agent(5, [tool("t5", "Grep", { pattern: "p" }), tool("t6", "Glob", { pattern: "*" })]),
    ]);
    expect(items.map((i) => (i.role === "tools" ? i.tools : i.role))).toEqual([
      { kind: "shell", count: 2, running: 0, failed: 1, names: ["Bash", "Bash"] },
      "agent",
      { kind: "other", count: 4, running: 4, failed: 0, names: ["Edit · a.ts", "Write · b.ts", "Grep", "Glob"] },
    ]);
    expect(strip(mapMessages([agent(1, [tool("a", "Task", {}), tool("b", "Agent", {})])], oneDay))[0]).toMatchObject({ tools: { kind: "subagent", count: 2 } });
    expect(strip(mapMessages([agent(1, [tool("a", "Edit", { file_path: "/w/x" })])], oneDay))[0]).toMatchObject({ tools: { kind: "edit" } });
    expect(strip(mapMessages([agent(1, [tool("a", "Grep", {})])], oneDay))[0]).toMatchObject({ tools: { kind: "search" } });
  });

  it("an AskUserQuestion call is an ask item per question, with its text and options", () => {
    const items = map([
      agent(1, [
        text("One question first."),
        tool("q1", "AskUserQuestion", {
          questions: [
            { question: "Which option, Agent 1?", header: "Question Title 123", multiSelect: false, options: [{ label: "Option A", description: "The first" }, { label: "Option B" }] },
            { question: "And which files?", header: "Files", multiSelect: true, options: [{ label: "All" }] },
          ],
        }),
      ]),
      user(2, [result("q1")]),
    ]);
    expect(items).toEqual([
      { id: U(1), role: "agent", at: AT(1), text: "One question first." },
      {
        id: `${U(1)}:1`,
        role: "ask",
        at: AT(1),
        ask: { via: "claude", question: "Which option, Agent 1?", header: "Question Title 123", multi: false, options: [{ label: "Option A", description: "The first" }, { label: "Option B", description: null }] },
      },
      { id: `${U(1)}:2`, role: "ask", at: AT(1), ask: { via: "claude", question: "And which files?", header: "Files", multi: true, options: [{ label: "All", description: null }] } },
    ]);
    // A malformed one is just a tool call.
    expect(map([agent(1, [tool("q", "AskUserQuestion", { questions: "nope" })])])[0]).toMatchObject({ role: "tools", tools: { names: ["AskUserQuestion"] } });
  });

  it("a herdr-inbox ask_operator call is an ask item with no text", () => {
    const items = map([agent(1, [tool("i1", "mcp__plugin_herdr-inbox_herdr-inbox__ask_operator", { question: "Question Title 123 body" })])]);
    expect(items).toEqual([{ id: U(1), role: "ask", at: AT(1), ask: { via: "inbox", question: null, header: null, multi: false, options: [] }, tool_use_id: "i1" }]);
    expect(map([agent(1, [tool("i1", "mcp__herdr-inbox__ask_operator", {})])])[0]).toMatchObject({ role: "ask" });
    // Only its exact names: a look-alike server whose name merely contains herdr-inbox is a plain tool call.
    for (const name of ["mcp__evil-herdr-inbox__ask_operator", "mcp__herdr-inbox-x__ask_operator", "mcp__plugin_evil_herdr-inbox__ask_operator", "mcp__herdr_inbox__ask_operator"]) {
      expect(map([agent(1, [tool("i1", name, {})])])[0], name).toMatchObject({ role: "tools" });
    }
    // CV5: an id of another shape is left off (the item stays, with nothing to anchor on).
    const odd = map([agent(1, [tool("bad id!", "mcp__herdr-inbox__ask_operator", {})])])[0]!;
    expect(odd).toMatchObject({ role: "ask" });
    expect("tool_use_id" in odd).toBe(false);
    // Only inbox asks carry it: an AskUserQuestion or a tool row never does.
    const ask = map([agent(1, [tool("q1", "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "A" }] }] })])])[0]!;
    expect("tool_use_id" in ask).toBe(false);
    expect(map([agent(1, [tool("i1", "mcp__other__ask_operator", {})])])[0]).toMatchObject({ role: "tools" });
  });

  it("the compaction summary is a divider and its text never shows", () => {
    const items = map([user(1, "Before"), system(2), user(3, "This session is being continued: SUMMARY", { meta: true, compactSummary: true }), user(4, "After")]);
    expect(items).toEqual([
      { id: U(1), role: "you", at: AT(1), text: "Before" },
      { id: U(3), role: "divider", at: AT(3), divider: "compact" },
      { id: U(4), role: "you", at: AT(4), text: "After" },
    ]);
  });

  it("subagent messages are left out", () => {
    const items = map([agent(1, [tool("task1", "Task", { prompt: "go" })]), agent(2, "Subagent words", { parentToolUseId: "task1" }), user(3, [result("task1")])]);
    expect(items).toEqual([{ id: U(1), role: "tools", at: AT(1), tools: { kind: "subagent", count: 1, running: 0, failed: 0, names: ["Task"] } }]);
  });

  it("a day divider goes before the first item of each day", () => {
    const day = (iso: string) => iso.slice(0, 10);
    const items = mapMessages([user(1, "a", { at: "2026-01-01T10:00:00.000Z" }), agent(2, "b", { at: "2026-01-01T11:00:00.000Z" }), user(3, "c", { at: "2026-01-02T09:00:00.000Z" }), user(4, "d", { at: null })], { dayOf: day });
    expect(items.map((i) => [i.id, i.role])).toEqual([
      [`day:${U(1)}`, "divider"],
      [U(1), "you"],
      [U(2), "agent"],
      [`day:${U(3)}`, "divider"],
      [U(3), "you"],
      [U(4), "you"],
    ]);
    expect(items[0]).toEqual({ id: `day:${U(1)}`, role: "divider", at: "2026-01-01T10:00:00.000Z", divider: "day" });
  });

  it("secrets are hidden in text, names and questions", () => {
    const key = `sk-ant-api03-${"A".repeat(40)}`;
    const items = map([
      user(1, `my key is ${key}`),
      agent(2, [text("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"), tool("t", "Read", { file_path: `/w/${key}.txt` })]),
      agent(3, [tool("q", "AskUserQuestion", { questions: [{ question: `Use ${key}?`, header: "H", options: [{ label: key }] }] })]),
    ]);
    const s = JSON.stringify(items);
    expect(s).not.toContain("sk-ant-");
    expect(s).not.toContain("ghp_");
    expect(s).toContain("my key is [hidden]");
    expect(s).toContain("Read · [hidden].txt");
  });

  it("each text block is cut at 16 KB and each message at 32 KB", () => {
    const big = "x".repeat(20_000);
    const [one] = map([user(1, big)]);
    expect(one).toMatchObject({ role: "you", cut: true });
    expect(Buffer.byteLength((one as { text: string }).text)).toBe(bridgeApi.CHATVIEW_TEXT_MAX_BYTES);
    const [three] = map([agent(1, [text(big), text(big), text(big)])]);
    expect(Buffer.byteLength((three as { text: string }).text)).toBe(bridgeApi.CHATVIEW_MESSAGE_MAX_BYTES);
    expect(three).toMatchObject({ cut: true });
    const [small] = map([user(1, "short")]);
    expect(small).not.toHaveProperty("cut");
  });

  it("cuts between code points and redacts before cutting", () => {
    expect(cutBytes("aé😀", 4)).toEqual({ text: "aé", cut: true });
    expect(cutBytes("aé😀", 7)).toEqual({ text: "aé😀", cut: false });
    // A key straddling the cut would leave a prefix the pattern no longer matches: redaction runs first.
    const key = `sk-ant-${"B".repeat(30)}`;
    const t = messageText(["y".repeat(bridgeApi.CHATVIEW_TEXT_MAX_BYTES - 10) + key]);
    expect(t.text).not.toContain("sk-ant");
    expect(t.text.endsWith("[hidden]")).toBe(true);
  });

  it("maps the CV2 reader fixture (the SDK's raw output) to the chat view fixture's items", () => {
    const raw = JSON.parse(readFileSync(new URL("fixtures/claude/expected/11111111-1111-4111-8111-111111111111.raw.json", REPO), "utf8")) as unknown[];
    const checked = checkMessages(raw);
    expect(checked.ok).toBe(true);
    const topic = JSON.parse(readFileSync(new URL("fixtures/bridge-api/chatview/typical.json", REPO), "utf8")) as bridgeApi.ChatviewTopic;
    const items = mapMessages(checked.ok ? checked.messages : [], { dayOf: (iso) => iso.slice(0, 10) });
    expect(items).toEqual(topic.items);
    const s = JSON.stringify(items);
    for (const never of ["Fake thinking", "Run the tests", "ZmFrZS1yZWRhY3RlZA", "iVBORw0KGgo", "/work/project-alpha", "Fake test output", "Fake summary", "11111111-1111-4111-8111-111111111111"]) expect(s).not.toContain(never);
  });
});

describe("the window (§5.3)", () => {
  const items = (n: number, size = 10): bridgeApi.ChatItem[] => Array.from({ length: n }, (_, i) => ({ id: U(i), role: "you", at: null, text: "z".repeat(size) }));
  const base = { terminal: "t3", items: [], older: false };

  it("keeps the newest 100", () => {
    const w = newest(items(150), base, 100, 512 * 1024);
    expect(w.items).toHaveLength(100);
    expect(w.items[0]!.id).toBe(U(50));
    expect(w.older).toBe(true);
    expect(newest(items(3), base, 100, 512 * 1024)).toMatchObject({ older: false });
  });

  it("stays at or under the byte cap, leaving out the oldest", () => {
    const all = items(100, 30_000);
    const w = newest(all, base, 100, 512 * 1024);
    expect(w.items.length).toBeLessThan(100);
    expect(w.items.at(-1)!.id).toBe(U(99));
    expect(jsonBytes({ ...base, items: w.items })).toBeLessThanOrEqual(512 * 1024);
    // One more would not fit.
    expect(jsonBytes({ ...base, items: all.slice(99 - w.items.length) })).toBeGreaterThan(512 * 1024);
  });
});
