// What to render (docs/chatview.md §3): checked Claude messages (claude/messages.ts) to chat items. Pure: no I/O.
//
// - a user's text is a "you" bubble; text that only wraps a slash command is a chip ("/compact"); other wrappers
//   Claude Code writes into the user turn (command output, bash mode, reminders) show nothing;
// - a user message with only tool results shows nothing of its own: it closes the tool calls it answers;
// - an assistant's text is an "agent" item (markdown, rendered safely by the phone); thinking is hidden;
// - consecutive tool calls are one collapsed row, counted by kind, with the tool name and a file tool's base name
//   per call (never the command, input or output); a call with an error result counts as failed;
// - an AskUserQuestion call is an "ask" item per question; a herdr-inbox `ask_operator` call is an "ask" item
//   with no text ("Asked you a question");
// - the compaction summary (`isCompactSummary`, sent as `is_meta`) is a divider: SDK 0.3.312 gives system messages
//   no subtype, so `compact_boundary` can't be told from other system messages, which are all hidden;
// - subagent messages (`parent_tool_use_id` set) are left out; unknown blocks were already dropped;
// - a day divider goes before the first item of each day, from the messages' timestamps.
//
// Every string that leaves goes through `redact`, then the 16 KB per block and 32 KB per message limits.
import { basename } from "node:path";
import { bridgeApi } from "@herdr-remote/protocol";
import type { ClaudeMessage } from "../claude/messages.js";
import { redact } from "./redact.js";

type ChatItem = bridgeApi.ChatItem;
type ToolKind = bridgeApi.ToolKind;

/** Tags Claude Code wraps around what is not the user's own prompt. Only `command-name` is shown (as a chip). */
const WRAPPERS: ReadonlySet<string> = new Set([
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "system-reminder",
]);
/**
 * Whether a tag is one the harness injects into the user's turn (fail closed: every `ide_*`/`ide-*` tag, every
 * `system-*`, `local-command-*`, `bash-*`, `command-*` tag, and any `*hook*` tag, besides the list above).
 */
export function isWrapperTag(name: string): boolean {
  const tag = name.toLowerCase();
  return WRAPPERS.has(tag) || /^(?:ide|system|local-command|bash|command)[-_]/.test(tag) || tag.includes("hook");
}
/**
 * One tag token, open or close, of any name (case-insensitive, `_` allowed), with optional attributes. Linear:
 * the name is bounded, and `[^<>]*` can't run past the next `<`, so scans from different starts never overlap.
 * There is no body pattern and no backreference: sections are paired by the scanner below, never by a regex.
 */
const TAG_TOKEN = /<(\/?)([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s[^<>]*)?>/g;
/** A user block longer than this is cut before any tag scan (the text is cut at 16 KB later anyway). */
export const USER_BLOCK_SCAN_MAX = 256 * 1024;

/** Sorted, merged [start, end) intervals. */
function merge(iv: [number, number][]): [number, number][] {
  iv.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `s` without the merged intervals `cut`, from 0 to `end`. */
function without(s: string, cut: readonly [number, number][], end: number): string {
  let out = "";
  let at = 0;
  for (const [a, b] of cut) {
    if (a >= end) break;
    out += s.slice(at, a);
    at = Math.max(at, b);
  }
  if (at < end) out += s.slice(at, end);
  return out;
}

/**
 * One user block with the harness's sections taken out, in linear time. Tag tokens are paired per name with a
 * stack (a nested same-name section is covered by its outer one). Returns the text left, whether that is nothing
 * but tagged sections of any name (then the block is dropped: fail closed), and a `<command-name>`'s text. An open
 * wrapper with no close, or a wrapper close with no open, hides the rest of the block from there.
 */
export function stripBlock(block: string): { text: string; onlyTags: boolean; command?: string } {
  const b = block.length > USER_BLOCK_SCAN_MAX ? block.slice(0, USER_BLOCK_SCAN_MAX) : block;
  const open = new Map<string, number[][]>();
  const wrap: [number, number][] = [];
  const any: [number, number][] = [];
  let end = b.length;
  let command: string | undefined;
  let commandAt = Infinity;
  for (const m of b.matchAll(TAG_TOKEN)) {
    const at = m.index;
    if (at >= end) break;
    const name = m[2]!.toLowerCase();
    if (m[1] === "") {
      let st = open.get(name);
      if (!st) open.set(name, (st = []));
      st.push([at, at + m[0].length]);
      continue;
    }
    const o = open.get(name)?.pop();
    if (!o) {
      // A stray wrapper close: what came before it is not trustworthy either.
      if (isWrapperTag(name)) end = 0;
      continue;
    }
    const sec: [number, number] = [o[0]!, at + m[0].length];
    any.push(sec);
    if (isWrapperTag(name)) {
      wrap.push(sec);
      if (name === "command-name" && o[0]! < commandAt) {
        commandAt = o[0]!;
        command = b.slice(o[1]!, at).trim();
      }
    }
  }
  for (const [name, st] of open) if (isWrapperTag(name)) for (const [a] of st) end = Math.min(end, a!);
  const text = without(b, merge(wrap), end);
  const rest = without(b, merge(any), end);
  return { text, onlyTags: rest.trim() === "", ...(command !== undefined && commandAt < end ? { command } : {}) };
}

/** What a command chip may show: a slash command's name, nothing typed after it. */
const COMMAND = /^\/[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;

const KINDS: ReadonlyMap<string, ToolKind> = new Map([
  ["Bash", "shell"],
  ["Read", "read"],
  ["NotebookRead", "read"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["Write", "edit"],
  ["NotebookEdit", "edit"],
  ["Grep", "search"],
  ["Glob", "search"],
  ["WebSearch", "search"],
  ["Task", "subagent"],
  ["Agent", "subagent"],
]);
/**
 * herdr-inbox's question tool, under any MCP server or plugin prefix it is installed with. Plain string tests, no
 * regex with two open-ended runs around a literal (that one was quadratic on a long name).
 */
const isInboxAsk = (name: string): boolean =>
  name.length <= 256 &&
  name.startsWith("mcp__") &&
  name.endsWith("__ask_operator") &&
  (name.includes("herdr-inbox") || name.includes("herdr_inbox")) &&
  /^[A-Za-z0-9_-]+$/.test(name);
const ASK_USER = "AskUserQuestion";
const NAME_MAX = 64;
const BASE_MAX = 120;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * A short label: no control or bidi characters, one line, at most `max` UTF-16 units (what the schema counts),
 * cut between code points.
 */
export function label(s: string, max: number): string {
  const t = redact(s).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const c of t) {
    if (out.length + c.length > max - 1) break;
    out += c;
  }
  return `${out}…`;
}

/** At most `max` UTF-8 bytes of `s`, cut between code points. */
export function cutBytes(s: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(s, "utf8") <= max) return { text: s, cut: false };
  let bytes = 0;
  let end = 0;
  for (const c of s) {
    const n = Buffer.byteLength(c, "utf8");
    if (bytes + n > max) break;
    bytes += n;
    end += c.length;
  }
  return { text: s.slice(0, end), cut: true };
}

/** Redacts each block, cuts it at 16 KB, joins them, and cuts the message at 32 KB. */
export function messageText(blocks: readonly string[]): { text: string; cut: boolean } {
  let cut = false;
  const parts = blocks.map((b) => {
    const r = cutBytes(redact(b), bridgeApi.CHATVIEW_TEXT_MAX_BYTES);
    cut ||= r.cut;
    return r.text;
  });
  const all = cutBytes(parts.join("\n\n"), bridgeApi.CHATVIEW_MESSAGE_MAX_BYTES);
  return { text: all.text, cut: cut || all.cut };
}

/**
 * The parts of a user turn that are the user's own words, block by block. Every harness wrapper section is removed
 * wherever it sits in a block (hook context, reminders, IDE context, command output); a block that is then empty,
 * or nothing but tagged sections of any name, is left out (fail closed); an unclosed wrapper tag hides the rest of
 * its block. With nothing left, a `<command-name>` makes a chip ("/compact"), else the turn shows nothing.
 */
export function userText(blocks: readonly string[]): { kept: string[] } | { command: string } | "hidden" {
  let command: string | undefined;
  const kept: string[] = [];
  for (const b of blocks) {
    const r = stripBlock(b);
    if (r.command !== undefined) command ??= r.command;
    if (r.text.trim() === "" || r.onlyTags) continue;
    kept.push(r.text.trim());
  }
  if (kept.length > 0) return { kept };
  if (command === undefined) return "hidden";
  const cmd = command.startsWith("/") ? command : `/${command}`;
  return { command: COMMAND.test(cmd) ? cmd : "/command" };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The questions of an AskUserQuestion call, or null when its input isn't the documented shape. */
function askQuestions(input: unknown): bridgeApi.ChatAsk[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > 4) return null;
  const out: bridgeApi.ChatAsk[] = [];
  for (const q of input.questions) {
    if (!isRecord(q) || typeof q.question !== "string" || !Array.isArray(q.options)) return null;
    const options: bridgeApi.ChatAsk["options"] = [];
    for (const o of q.options.slice(0, 20)) {
      if (!isRecord(o) || typeof o.label !== "string") return null;
      const d = str(o.description);
      options.push({ label: label(o.label, 400), description: d === null ? null : label(d, 2000) });
    }
    const h = str(q.header);
    out.push({
      via: "claude",
      question: cutBytes(redact(q.question), 4000).text,
      header: h === null ? null : label(h, 200),
      multi: q.multiSelect === true,
      options,
    });
  }
  return out;
}

/** The text bytes of ask items: what counts toward the 32 KB per message. */
const askBytes = (asks: readonly bridgeApi.ChatAsk[]): number =>
  asks.reduce((n, q) => n + Buffer.byteLength((q.question ?? "") + (q.header ?? "") + q.options.map((o) => o.label + (o.description ?? "")).join(""), "utf8"), 0);

/**
 * Ask items within what is left of the message's 32 KB: when they don't fit, every field is cut to a smaller size
 * (the question four times the others), step by step, and the items are marked cut.
 */
export function fitAsks(asks: bridgeApi.ChatAsk[], budget: number): { asks: bridgeApi.ChatAsk[]; cut: boolean } {
  if (askBytes(asks) <= budget) return { asks, cut: false };
  const at = (s: string, n: number) => cutBytes(s, n).text;
  let out = asks;
  for (const lim of [1000, 400, 200, 100, 50, 20]) {
    out = asks.map((q) => ({
      ...q,
      question: q.question === null ? null : at(q.question, lim * 4),
      header: q.header === null ? null : at(q.header, lim),
      options: q.options.map((o) => ({ label: at(o.label, lim), description: o.description === null ? null : at(o.description, lim) })),
    }));
    if (askBytes(out) <= budget) break;
  }
  // Still over (the text took nearly all of it): options go from the end, then the questions are cut to share
  // what is left, so the message never goes over its 32 KB.
  while (askBytes(out) > budget && out.some((q) => q.options.length > 0)) {
    out = out.map((q) => ({ ...q, options: q.options.slice(0, -1) }));
  }
  if (askBytes(out) > budget) {
    const each = Math.floor(Math.max(0, budget) / out.length);
    out = out.map((q) => ({ ...q, header: null, question: q.question === null ? null : at(q.question, each) }));
  }
  return { asks: out, cut: true };
}

/** The name line of one call: the tool's name, and a file tool's file base name. */
function callName(name: string, kind: ToolKind, input: unknown): string {
  const n = label(name, NAME_MAX) || "tool";
  if ((kind !== "read" && kind !== "edit") || !isRecord(input)) return n;
  const path = str(input.file_path) ?? str(input.notebook_path);
  if (path === null || path === "") return n;
  const base = label(basename(path), BASE_MAX);
  return base ? `${n} · ${base}` : n;
}

/** The local calendar day of an ISO time, as `YYYY-M-D`: where the bridge runs is where the operator is. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export interface MapOptions {
  /** The day an ISO time falls on, for day dividers. Default {@link localDay}. */
  dayOf?: (iso: string) => string;
  /**
   * Filled with the item ids of each AskUserQuestion call (by tool_use id), so a prompt card for that call (CV7) can
   * take their place.
   */
  askIds?: Map<string, string[]>;
}

interface Run {
  item: Extract<ChatItem, { role: "tools" }>;
  kinds: Set<ToolKind>;
}

/** Maps a session's checked messages, oldest first, to chat items, oldest first. */
export function mapMessages(messages: readonly ClaudeMessage[], o: MapOptions = {}): ChatItem[] {
  const dayOf = o.dayOf ?? localDay;
  const items: ChatItem[] = [];
  const ids = new Set<string>();
  /** Tool calls by id, to close them when their result arrives. */
  const calls = new Map<string, { run: Run; done: boolean }>();
  let run: Run | null = null;
  let lastDay: string | null = null;

  const push = (item: ChatItem) => {
    if (ids.has(item.id)) return;
    if (item.at !== null) {
      const day = dayOf(item.at);
      if (day !== lastDay) {
        lastDay = day;
        const id = `day:${item.id}`;
        if (!ids.has(id)) {
          ids.add(id);
          items.push({ id, role: "divider", at: item.at, divider: "day" });
        }
      }
    }
    ids.add(item.id);
    items.push(item);
  };

  for (const m of messages) {
    // A subagent's turn is not inline: the panorama strip (CV5) links to it.
    if (m.parentToolUseId !== null) continue;
    if (m.type === "system") continue;
    // One message can give several items (text, then tools): the first takes the uuid, the rest a suffix.
    let n = 0;
    const nextId = () => (n++ === 0 ? m.uuid : `${m.uuid}:${n - 1}`);
    if (m.type === "user") {
      if (m.compactSummary) {
        run = null;
        push({ id: nextId(), role: "divider", at: m.at, divider: "compact" });
        continue;
      }
      if (m.meta) continue;
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const c = calls.get(b.toolUseId);
          if (c && !c.done) {
            c.done = true;
            c.run.item.tools.running -= 1;
            if (b.isError) c.run.item.tools.failed += 1;
          }
        } else if (b.type === "text") texts.push(b.text);
      }
      if (texts.length === 0) continue;
      const w = userText(texts);
      if (w === "hidden") continue;
      run = null;
      if ("command" in w) {
        push({ id: nextId(), role: "you", at: m.at, text: w.command, command: true });
        continue;
      }
      const t = messageText(w.kept);
      push({ id: nextId(), role: "you", at: m.at, text: t.text, ...(t.cut ? { cut: true as const } : {}) });
      continue;
    }
    // assistant
    let texts: string[] = [];
    /** Text bytes this message has sent so far: its asks share the 32 KB with its text. */
    let used = 0;
    const flush = () => {
      if (texts.length === 0) return;
      const t = messageText(texts);
      texts = [];
      if (t.text.trim() === "") return;
      used += Buffer.byteLength(t.text, "utf8");
      run = null;
      push({ id: nextId(), role: "agent", at: m.at, text: t.text, ...(t.cut ? { cut: true as const } : {}) });
    };
    for (const b of m.content) {
      if (b.type === "text") {
        texts.push(b.text);
        continue;
      }
      if (b.type !== "tool_use") continue; // thinking is hidden, and does not break a run of tools
      flush();
      if (b.name === ASK_USER) {
        const qs = askQuestions(b.input);
        if (qs) {
          run = null;
          const fit = fitAsks(qs, Math.max(0, bridgeApi.CHATVIEW_MESSAGE_MAX_BYTES - used));
          used += askBytes(fit.asks);
          const ids: string[] = [];
          for (const ask of fit.asks) {
            const id = nextId();
            ids.push(id);
            push({ id, role: "ask", at: m.at, ask, ...(fit.cut ? { cut: true as const } : {}) });
          }
          o.askIds?.set(b.id, ids);
          continue;
        }
      }
      if (isInboxAsk(b.name)) {
        run = null;
        push({ id: nextId(), role: "ask", at: m.at, ask: { via: "inbox", question: null, header: null, multi: false, options: [] } });
        continue;
      }
      if (calls.has(b.id)) continue;
      const kind = KINDS.get(b.name) ?? "other";
      if (!run) {
        run = { item: { id: nextId(), role: "tools", at: m.at, tools: { kind, count: 0, running: 0, failed: 0, names: [] } }, kinds: new Set() };
        push(run.item);
      }
      const r: Run = run;
      r.kinds.add(kind);
      r.item.tools.kind = r.kinds.size === 1 ? kind : "other";
      r.item.tools.count += 1;
      r.item.tools.running += 1;
      if (r.item.tools.names.length < bridgeApi.CHAT_TOOL_NAMES_MAX) r.item.tools.names.push(callName(b.name, kind, b.input));
      calls.set(b.id, { run: r, done: false });
    }
    flush();
  }
  return items;
}

/** JSON size in UTF-8 bytes. */
export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/**
 * The newest items of `items` that fit: at most `maxItems`, and with `base` (the rest of the value they go in,
 * with `items: []`) at most `maxBytes` of JSON. `older` is true when anything was left out.
 */
export function newest(items: readonly ChatItem[], base: unknown, maxItems: number, maxBytes: number): { items: ChatItem[]; older: boolean } {
  let budget = maxBytes - jsonBytes(base);
  let start = items.length;
  while (start > 0 && items.length - start < maxItems) {
    // A comma between items.
    const size = jsonBytes(items[start - 1]) + (start < items.length ? 1 : 0);
    if (size > budget) break;
    budget -= size;
    start -= 1;
  }
  return { items: items.slice(start), older: start > 0 };
}
