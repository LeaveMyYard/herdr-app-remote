import { appendFileSync, chmodSync, existsSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ACTIVITY_FILE = "activity.jsonl";

/** One Activity entry. `text` is built only by the describers below, never from free text. */
export interface AuditEntry {
  /** Epoch ms. */
  ts: number;
  /** Machine-readable event, e.g. `act`, `pair.request`, `device.revoke`. */
  event: string;
  /** Device name, when one is involved. */
  device?: string;
  /** Human line for the Activity tab, e.g. "Phone 1 sent 12 chars to t3". */
  text: string;
  ok?: boolean;
  code?: string;
}

export interface AuditOptions {
  dir: string;
  /** Rotate when the file would grow past this. Default 1 MiB. */
  maxBytes?: number;
  /** Rotated files kept (`activity.jsonl.1` … `.N`). Default 3. */
  keep?: number;
}

/** Control characters and line/paragraph separators: nothing in a log line may break layout. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Makes a short label safe to log: no control characters, collapsed spaces, capped length. */
export function cleanLabel(s: string, max = 40): string {
  const t = s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  const chars = [...t];
  // Cut by code point, so an emoji is never split into a lone surrogate.
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : t;
}

/** An identifier (question id, terminal id, tab id) only if it looks like one; never free text. */
const ID = /^[A-Za-z0-9_.:-]{1,40}$/;
export function safeId(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return typeof v === "string" && ID.test(v) ? v : undefined;
}

function charCount(v: unknown): number {
  return typeof v === "string" ? [...v].length : 0;
}

const isQid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const ROW_KEY = /^(group|failed|alert):([1-9][0-9]{0,15})$/;

/** The inbox thing an act names, from canonical ids only: `Q123`, `Q123, Q124`, `group 123` or `A456`. */
function inboxTarget(args: Record<string, unknown>, fallback: string): string {
  if (isQid(args.question)) return `Q${args.question}`;
  const qs = args.questions;
  if (Array.isArray(qs) && qs.length > 0 && qs.every(isQid)) return qs.slice(0, 6).map((q) => `Q${q}`).join(", ") + (qs.length > 6 ? ", …" : "");
  const m = typeof args.key === "string" ? ROW_KEY.exec(args.key) : null;
  if (!m) return fallback;
  return m[1] === "alert" ? `A${m[2]}` : m[1] === "group" ? `group ${m[2]}` : `Q${m[2]}`;
}

/** " (Option B)" from the label the bridge resolved, else " (12 chars)" for free text, else nothing. */
function labelOrLength(label: string | undefined, args: Record<string, unknown>): string {
  const shown = label !== undefined ? cleanLabel(label) : "";
  if (shown) return ` (${shown})`;
  const d = args.detail;
  const text = d !== null && typeof d === "object" ? charCount((d as { text?: unknown }).text) : 0;
  return text ? ` (${text} chars)` : "";
}

/**
 * The redacted description of an action, for the audit log. Only identifiers, lengths and
 * the option label the bridge resolved itself (`label`, from the handler's result) get
 * through: free text, terminal input and anything label-like in the client's args never do.
 */
export function describeAct(kind: string, args: Record<string, unknown>, label?: string): string {
  const target = (key: string, fallback: string) => safeId(args[key]) ?? fallback;
  switch (kind) {
    case "terminal.send":
      return `sent ${charCount(args.text)} chars to ${target("terminal", "a terminal")}`;
    case "terminal.keys":
      // The entry is named only once the bridge found it in its own key menu (`label`: "<id>, <n> keys"); the id
      // the client sent is never logged, so a refused press reads "pressed a key".
      return `pressed ${label !== undefined && cleanLabel(label) ? cleanLabel(label) : "a key"} in ${target("terminal", "a terminal")}`;
    case "inbox.answer": {
      const what = labelOrLength(label, args);
      return `answered ${inboxTarget(args, "a question")}${what}`;
    }
    case "inbox.draft":
      return args.clear === true ? `cleared the draft of ${inboxTarget(args, "a question")}` : `saved a draft for ${inboxTarget(args, "a question")}${labelOrLength(label, args)}`;
    case "inbox.dismiss":
      return `dismissed ${inboxTarget(args, "a question")}`;
    case "inbox.ack":
      return `acknowledged ${inboxTarget(args, "an alert")}`;
    case "inbox.retry":
      return `asked to resend the answer to ${inboxTarget(args, "a question")}`;
    case "inbox.stop_showing":
      return `stopped showing the answer to ${inboxTarget(args, "a question")}`;
    case "agent.focus":
    case "tab.select":
    case "space.select":
    case "pane.focus":
      return `${kind} ${target("id", "")}`.trimEnd();
    case "push.subscribe":
      return "turned push on";
    case "push.unsubscribe":
      return "turned push off";
    case "pair.transfer":
      return "asked for a Home Screen setup code";
    default:
      // Unknown kinds come straight from the client: log the name only if it looks like one.
      return /^[a-z][a-z0-9_.-]{0,31}$/.test(kind) ? `tried ${kind}` : "tried an unknown action";
  }
}

/** Append-only JSONL audit log, mode 0600, rotated by size. */
export class AuditLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(opts: AuditOptions) {
    this.file = join(opts.dir, ACTIVITY_FILE);
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.keep = opts.keep ?? 3;
    if (existsSync(this.file)) chmodSync(this.file, 0o600);
  }

  get path(): string {
    return this.file;
  }

  record(entry: AuditEntry): void {
    const clean: AuditEntry = { ...entry, event: cleanLabel(entry.event, 40), text: cleanLabel(entry.text, 200) };
    if (entry.device !== undefined) clean.device = cleanLabel(entry.device, 40);
    if (entry.code !== undefined) clean.code = cleanLabel(entry.code, 40);
    const line = `${JSON.stringify(clean)}\n`;
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    appendFileSync(this.file, line, { mode: 0o600 });
  }

  private rotate(): void {
    const oldest = `${this.file}.${this.keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
    }
    if (this.keep >= 1) renameSync(this.file, `${this.file}.1`);
    else unlinkSync(this.file);
  }

  /** The newest `n` entries, oldest first (reads the current file and, if needed, `.1`). */
  tail(n: number): AuditEntry[] {
    const read = (f: string): AuditEntry[] => {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        // Missing, or unreadable (the panel flags a failing log; its view must still build).
        return [];
      }
      const out: AuditEntry[] = [];
      for (const l of text.split("\n")) {
        if (!l) continue;
        try {
          out.push(JSON.parse(l) as AuditEntry);
        } catch {
          // A torn last line after a crash: skip it.
        }
      }
      return out;
    };
    let entries = read(this.file);
    if (entries.length < n) entries = [...read(`${this.file}.1`), ...entries];
    return entries.slice(-n);
  }
}
