import { bridgeApi } from "@herdr-remote/protocol";
import type { InboxModules, RawFeed } from "./plugin.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nstr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const HOSTS = new Set(["herdr-tui", "herdr-core"]);

function asker(v: unknown): bridgeApi.InboxAsker {
  const a = isObj(v) ? v : {};
  // Any word the reader does not know reads as `unknown` (app-feed-v1).
  return {
    host: typeof a.host === "string" && HOSTS.has(a.host) ? (a.host as "herdr-tui" | "herdr-core") : "unknown",
    pane: nstr(a.pane),
    terminal: nstr(a.terminal),
    tab_label: nstr(a.tab_label),
    cwd: nstr(a.cwd),
  };
}

function detail(v: unknown): bridgeApi.InboxDetail | null {
  if (!isObj(v)) return null;
  const notes: Record<string, string> = {};
  if (isObj(v.notes)) for (const [k, n] of Object.entries(v.notes)) if (typeof n === "string") notes[k] = n;
  return { choices: arr(v.choices).filter((c): c is string => typeof c === "string"), notes, text: nstr(v.text) };
}

function question(v: unknown): bridgeApi.InboxQuestion {
  const q = isObj(v) ? v : {};
  return {
    id: int(q.id),
    header: nstr(q.header),
    question: str(q.question),
    options: arr(q.options).map((o) => {
      const x = isObj(o) ? o : {};
      return { label: str(x.label), description: nstr(x.description), preview: nstr(x.preview) };
    }),
    multi_select: bool(q.multi_select),
    context: nstr(q.context),
    asked_by: nstr(q.asked_by),
    draft: detail(q.draft),
    cut: bool(q.cut),
  };
}

function machine(v: unknown): { id: string; label: string | null; offline: string | null } {
  const m = isObj(v) ? v : {};
  return { id: str(m.id), label: nstr(m.label), offline: nstr(m.offline) };
}

export interface BuildEnv {
  modules: InboxModules;
  /** Rows the bridge opened with `app show` (left out of, or cut in, the feed), by row key. They replace the feed's. */
  shown: ReadonlyMap<string, Obj>;
  isNew: (key: string) => boolean;
  /**
   * The row's `rev`: binds an `act` to this content and the token the bridge holds for it (S11). Called with the
   * row as published, minus `new` and `rev`.
   */
  rev: (key: string, row: Record<string, unknown>) => string;
}

/** The row with its `rev`, validated; undefined if it fails the schema. */
function finish(row: Record<string, unknown>, env: BuildEnv): bridgeApi.InboxRow | undefined {
  const content = { ...row };
  delete content.new;
  const r = bridgeApi.InboxRow.safeParse({ ...row, rev: env.rev(String(row.key), content) });
  return r.success ? r.data : undefined;
}

/** One feed entry as a topic row. A row that cannot be built reads as an unknown row: its key, and no actions. */
export function buildRow(entry: Obj, env: BuildEnv): bridgeApi.InboxRow | undefined {
  const base = { key: str(entry.key), actions: arr(entry.actions).filter((a): a is string => typeof a === "string"), new: env.isNew(str(entry.key)) };
  // A row that cannot be built reads as an unknown row; one with no usable key or a known kind that fails the schema is dropped.
  const unknown = (): bridgeApi.InboxRow | undefined => finish({ key: base.key, kind: str(entry.kind), actions: [], new: base.new }, env);
  const { modules } = env;
  let row: unknown;
  try {
    switch (entry.kind) {
      case "group":
        row = {
          ...base,
          kind: "group",
          group: int(entry.group),
          title: nstr(entry.title),
          created_at: str(entry.created_at),
          asker: asker(entry.asker),
          questions: arr(entry.questions).map(question),
        };
        break;
      case "failed": {
        const words = modules.deliveryWords(entry);
        const d = isObj(entry.delivery) ? entry.delivery : {};
        const known = modules.knownDelivery(entry);
        row = {
          ...base,
          // A state word this version does not know offers no action.
          actions: known ? base.actions : [],
          kind: "failed",
          question_id: int(entry.question_id),
          group: int(entry.group),
          header: nstr(entry.header),
          question: str(entry.question),
          asked_by: nstr(entry.asked_by),
          answer: nstr(entry.answer),
          answered_at: str(entry.answered_at),
          retries: int(entry.retries),
          cut: bool(entry.cut),
          asker: asker(entry.asker),
          delivery: {
            state: str(d.state),
            known,
            line: words.line,
            warn: words.warn,
            attempts: int(d.attempts),
            pending_since: nstr(d.pending_since),
            auto_retry: bool(d.auto_retry),
          },
          retry_label: modules.retryLabel(entry),
        };
        break;
      }
      case "alert":
        row = {
          ...base,
          kind: "alert",
          id: int(entry.id),
          alert_kind: modules.alertKind(str(entry.alert_kind)),
          severity: modules.severity(str(entry.severity)),
          title: str(entry.title),
          message: nstr(entry.message),
          asked_by: nstr(entry.asked_by),
          created_at: str(entry.created_at),
          asker: asker(entry.asker),
        };
        break;
      case "remote_group":
        row = {
          ...base,
          actions: [],
          kind: "remote_group",
          machine: machine(entry.machine),
          title: nstr(entry.title),
          created_at: nstr(entry.created_at),
          tab_label: nstr(entry.tab_label),
          questions: arr(entry.questions).map(question),
        };
        break;
      case "remote_outbox":
        row = {
          ...base,
          actions: [],
          kind: "remote_outbox",
          machine: machine(entry.machine),
          action: str(entry.action),
          remote_id: int(entry.remote_id),
          state: str(entry.state),
          result: nstr(entry.result),
          sending: bool(entry.sending),
          expired: bool(entry.expired),
          expires_at: nstr(entry.expires_at),
        };
        break;
      case "remote_problem":
        row = {
          ...base,
          actions: [],
          kind: "remote_problem",
          machine: machine(entry.machine),
          remote_id: int(entry.remote_id),
          why: str(entry.why),
          question: str(entry.question),
          answer: nstr(entry.answer),
          cut: bool(entry.cut),
        };
        break;
      case "remote_alert":
        row = {
          ...base,
          actions: [],
          kind: "remote_alert",
          machine: machine(entry.machine),
          id: int(entry.id),
          alert_kind: modules.alertKind(str(entry.alert_kind)),
          severity: modules.severity(str(entry.severity)),
          title: str(entry.title),
          message: nstr(entry.message),
          tab_label: nstr(entry.tab_label),
          asked_by: nstr(entry.asked_by),
          created_at: nstr(entry.created_at),
        };
        break;
      default:
        return unknown();
    }
  } catch {
    return unknown();
  }
  return finish(row as Record<string, unknown>, env) ?? unknown();
}

export interface TopicInput {
  plugin: bridgeApi.InboxTopic["plugin"];
  feed: RawFeed | null;
  problem: bridgeApi.InboxTopic["problem"];
  stale: boolean;
  /** Left-out groups the bridge opened with `app show`, in id order, and the ids still unopened. */
  extra: Obj[];
  unlisted: number;
}

const COUNTS = (feed: RawFeed, modules: InboxModules, unlisted: number): bridgeApi.InboxTopic["incomplete"] => {
  const inc = modules.incompleteness(feed);
  return inc === null ? null : { counts: inc.counts, errors: inc.errors, unlisted };
};

/** The `inbox` topic value. No token is ever copied out of an entry: `buildRow` never reads `token`. */
export function buildTopic(input: TopicInput, env: BuildEnv): bridgeApi.InboxTopic {
  const { feed } = input;
  if (input.plugin !== "ready" || feed === null) {
    return {
      plugin: input.plugin,
      state: "unavailable",
      stale: true,
      problem: input.problem,
      generated_at: null,
      errors: [],
      incomplete: null,
      empty: false,
      waiting: 0,
      alerts: 0,
      entries: [],
    };
  }
  const entries = feed.entries.map((e) => env.shown.get(String(e.key)) ?? e);
  const keys = new Set(entries.map((e) => String(e.key)));
  // Left-out groups sit with the other groups (after the last one), where the feed's order would have put them.
  const extra = input.extra.filter((e) => !keys.has(String(e.key)));
  let at = entries.map((e) => e.kind).lastIndexOf("group") + 1;
  if (at === 0) at = entries.findIndex((e) => e.kind !== "alert" && e.kind !== "remote_alert");
  if (at < 0) at = entries.length;
  const rows = [...entries.slice(0, at), ...extra, ...entries.slice(at)].map((e) => buildRow(e, env)).filter((r): r is bridgeApi.InboxRow => r !== undefined);
  const hidden = env.modules.leftOut(feed);
  return {
    plugin: "ready",
    state: "ok",
    stale: input.stale,
    problem: input.problem,
    generated_at: feed.generated_at,
    errors: feed.errors,
    incomplete: COUNTS(feed, env.modules, input.unlisted),
    // `entries: []` is an empty inbox only when the feed is ok and nothing was left out. It is the feed's entries that count: a row dropped as unbuildable is still something the feed holds.
    empty: entries.length === 0 && extra.length === 0 && hidden === 0,
    // Left-out groups the bridge has not opened still wait: they count (so the header and badge never say "nothing").
    waiting: rows.filter((r) => r.kind === "group").length + Math.max(feed.omitted.groups - extra.length, 0),
    alerts: rows.filter((r) => r.kind === "alert").length,
    entries: rows,
  };
}
