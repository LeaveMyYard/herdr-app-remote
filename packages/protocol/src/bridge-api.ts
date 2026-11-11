import { z } from "zod";
import { HostState } from "./host.js";

export const API_VERSION = 1 as const;

/**
 * The WebSocket subprotocol the client must offer (`new WebSocket(url, [WS_PROTOCOL])`).
 * Browsers can't add headers to a WS upgrade, so this is the upgrade's CSRF marker in
 * place of `X-Remote-Api: 1`.
 */
export const WS_PROTOCOL = "herdr-remote.v1";

export const PLUGIN_STATES = ["ready", "missing", "too_old", "broken", "stale", "not_running"] as const;
export const PluginState = z.enum(PLUGIN_STATES);
export type PluginState = z.infer<typeof PluginState>;

export const PLUGIN_NAMES = ["panorama", "inbox", "usage", "hc", "host"] as const;
export const PluginName = z.enum(PLUGIN_NAMES);
export type PluginName = z.infer<typeof PluginName>;

/** `host`, `plugins`, `panorama`, `inbox`, `usage`, `setup` or `chat:<t>`. */
export const Topic = z.union([
  z.enum(["host", "plugins", "panorama", "inbox", "usage", "setup"]),
  z.string().regex(/^chat:.+$/),
]);
export type Topic = z.infer<typeof Topic>;

// ---- GET /api/v1/meta ----

export const Meta = z.object({
  api: z.literal(API_VERSION),
  bridge: z.string().min(1),
});
export type Meta = z.infer<typeof Meta>;

// ---- client -> server ----

export const ClientHello = z.object({
  type: z.literal("hello"),
  api: z.literal(API_VERSION),
  /** `seqs` maps each topic to the last `seq` the client applied for it. */
  resume: z
    .object({ epoch: z.string().min(1), seqs: z.record(Topic, z.number().int().nonnegative()) })
    .optional(),
});
export const ClientSub = z.object({ type: z.literal("sub"), topics: z.array(Topic).min(1) });
export const ClientAct = z.object({
  type: z.literal("act"),
  id: z.string().min(1),
  kind: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});
export const ClientPing = z.object({ type: z.literal("ping") });

export const ClientMessage = z.discriminatedUnion("type", [ClientHello, ClientSub, ClientAct, ClientPing]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- server -> client ----

// ---- topic payloads ----

export const HostTopic = HostState;

export const PluginStatus = z.object({
  state: PluginState,
  detail: z.string().optional(),
});
export type PluginStatus = z.infer<typeof PluginStatus>;

export const PluginsTopic = z.object({
  panorama: PluginStatus,
  inbox: PluginStatus,
  usage: PluginStatus,
  hc: PluginStatus,
  host: PluginStatus,
});
export type PluginsTopic = z.infer<typeof PluginsTopic>;

// ---- panorama topic (S8) ----

/**
 * Agent status codes (feed v2 `status`, plus `unknown` for a code this version does not know).
 * Roots use the same vocabulary: `working` is `run`, `blocked` is `blk`, `idle` and `done` map to themselves.
 */
export const AGENT_CODES = ["q", "run", "rev", "wait", "blk", "fail", "done", "cxl", "inf", "lost", "bg", "stale", "idle", "unknown"] as const;
export const AgentCode = z.enum(AGENT_CODES);
export type AgentCode = z.infer<typeof AgentCode>;

/** A subagent of a root. `parent` is already normalised: dangling, self and cyclic parents are `null`. */
export const PanoramaNode = z.object({
  id: z.string().min(1),
  parent: z.string().min(1).nullable(),
  harness: z.string().min(1),
  /** Never empty: the feed title, else the role, else the id. */
  title: z.string().min(1),
  role: z.string(),
  model: z.string().nullable(),
  status: AgentCode,
  activity: z.string(),
  last_message: z.string(),
  pending: z.array(z.string()),
  question_ids: z.array(z.number().int()),
  error: z.string().nullable(),
  tool_calls: z.number().int().nonnegative(),
  started: z.number().nullable(),
  ended: z.number().nullable(),
  last_at: z.number().nullable(),
  seq: z.number().int(),
});
export type PanoramaNode = z.infer<typeof PanoramaNode>;

export const PanoramaRoot = z.object({
  /** The feed's root key (`host` plus terminal or pane id). Opaque. */
  key: z.string().min(1),
  /** The host agent this root is verified to be, by exact terminal address; null when unmatched or while aged. */
  agent_id: z.string().min(1).nullable(),
  /** The host space of the matched agent. Never guessed. */
  space_id: z.string().min(1).nullable(),
  terminal: z.string().min(1).nullable(),
  /** True when the terminal is verified live (Open root pane is possible). */
  live: z.boolean(),
  /** True while aged and a live host row has the same address: the Agents list must not list it twice. */
  shadowed: z.boolean(),
  harness: z.string().min(1),
  /** The host agent's name when matched, else the feed title, else the tab label, else the pane id. */
  title: z.string().min(1),
  tab_no: z.number().int().nullable(),
  status: AgentCode,
  /** Open inbox question ids for this root (the complete inventory). */
  inbox: z.array(z.number().int()),
  hidden_finished: z.number().int().nonnegative(),
  last_activity: z.number().nullable(),
  agents: z.array(PanoramaNode),
});
export type PanoramaRoot = z.infer<typeof PanoramaRoot>;

export const PanoramaTopic = z.object({
  /** `rich` needs a lease owner and a feed (possibly retained); otherwise `basic` and the phone shows the stock agents. */
  mode: z.enum(["rich", "basic"]),
  /** The last read failed or the feed is aged; the retained feed is shown, marked. */
  stale: z.boolean(),
  /** Older than the 15 s limit: terminal joins are suppressed (terminal numbers prove nothing). */
  aged: z.boolean(),
  /** A short fixed sentence when the feed is missing, unreadable or invalid; never CLI output or a path. */
  error: z.string().nullable(),
  /** The feed's `generated_at` (POSIX seconds). */
  collected_at: z.number().nullable(),
  roots: z.array(PanoramaRoot),
});
export type PanoramaTopic = z.infer<typeof PanoramaTopic>;
/**
 * `usage` topic: a trimmed `usagebar collect --format v1` report (agent-usage docs/collect-json-v1.md).
 * The bridge keeps only what PhoneUsage draws (no `watchDirs`, no per-pane shares, no `apiUsage`) and
 * ignores fields it does not know, since the format adds fields compatibly. `status` and `band` stay open
 * strings for the same reason; the known values are listed below.
 */
export const USAGE_STATUSES = ["ok", "stale", "needs-login", "no-data", "unavailable"] as const;
export const USAGE_BANDS = ["high", "mid", "low"] as const;

export const UsageWindow = z.object({
  slot: z.string(),
  /** `5h`, `24h`, `7d`, `30d` or `<n>m`. */
  tag: z.string().min(1),
  windowMinutes: z.number(),
  /** The number to print under `limitPercent`. */
  displayPercent: z.number(),
  /** 0 to 1. */
  barFill: z.number(),
  /** One of {@link USAGE_BANDS}. */
  band: z.string(),
  /** Pre-formatted, "" when unknown. */
  resetIn: z.string(),
  runOut: z.object({ text: z.string() }).nullish(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageProvider = z.object({
  providerId: z.string().min(1),
  family: z.string().min(1),
  label: z.string(),
  groupLabel: z.string().nullish(),
  accountLabel: z.string().nullish(),
  profileLabel: z.string().nullish(),
  /** Login email, or the account's config dir (abbreviated with `~` by the bridge). */
  identity: z.string().nullish(),
  /** `providerId` of an earlier entry for the same account; the screen shows the account once. */
  sameAccountAs: z.string().nullish(),
  planType: z.string().nullish(),
  /** The account's config/home dir, where its agent writes readings (abbreviated with `~` by the bridge). */
  home: z.string().nullish(),
  /** Where the reading came from (a path is abbreviated with `~` by the bridge). */
  source: z.string().nullish(),
  fetchedAtMs: z.number().nullish(),
  note: z.string().nullish(),
  /** One of {@link USAGE_STATUSES}. */
  status: z.string(),
  staleMinutes: z.number().nullish(),
  /** For example `grok login` with status `needs-login`. */
  action: z.string().nullish(),
  /** False: nothing on this machine; hosts hide these. */
  inUse: z.boolean().nullish(),
  windows: z.array(UsageWindow),
});
export type UsageProvider = z.infer<typeof UsageProvider>;

export const UsageReport = z.object({
  version: z.literal(1),
  generatedAtMs: z.number(),
  filter: z.enum(["open-panes", "all"]),
  /** Whether `displayPercent` counts what is left or what is used. */
  limitPercent: z.enum(["remaining", "used"]),
  emptyMessage: z.string().nullish(),
  providers: z.array(UsageProvider),
  lowCachePanes: z.array(z.object({ label: z.string(), hitPercent: z.number() })).nullish(),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** Why the last collect produced no new report. Short codes, never CLI output. */
export const USAGE_ERRORS = ["unavailable", "timeout", "failed", "bad_output", "unsupported"] as const;
export const UsageError = z.enum(USAGE_ERRORS);
export type UsageError = z.infer<typeof UsageError>;

export const USAGE_FILTERS = ["open-panes", "all"] as const;

export const UsageTopic = z.object({
  /** The filter the bridge is collecting with (shared by every client). */
  filter: z.enum(USAGE_FILTERS),
  /** The last good report; kept while `error` is set. Null before the first one, and after the filter changes. */
  report: UsageReport.nullable(),
  /** When `report` was collected. */
  updatedAtMs: z.number().nullable(),
  error: UsageError.optional(),
});
export type UsageTopic = z.infer<typeof UsageTopic>;

/** `act` kinds the usage topic handles. `usage.refresh` takes no args; `usage.set_filter` takes `{filter}`. */
export const USAGE_ACTS = ["usage.refresh", "usage.set_filter"] as const;

// ---- inbox topic (S10) ----

const Str = z.string();
const NStr = z.string().nullable();

/** `host` as the feed says it; any word the reader does not know is already `unknown`. */
export const InboxAsker = z.object({
  host: z.enum(["herdr-tui", "herdr-core", "unknown"]),
  pane: NStr,
  terminal: NStr,
  tab_label: NStr,
  cwd: NStr,
});
export type InboxAsker = z.infer<typeof InboxAsker>;

export const InboxOption = z.object({ label: Str, description: NStr, preview: NStr });
export const InboxDetail = z.object({ choices: z.array(Str), notes: z.record(Str, Str), text: NStr });
export type InboxDetail = z.infer<typeof InboxDetail>;

export const InboxQuestion = z.object({
  id: z.number().int(),
  header: NStr,
  question: Str,
  options: z.array(InboxOption),
  multi_select: z.boolean(),
  context: NStr,
  asked_by: NStr,
  draft: InboxDetail.nullable(),
  /** Some text was cut by the writer and the bridge could not get the whole question. */
  cut: z.boolean(),
});
export type InboxQuestion = z.infer<typeof InboxQuestion>;

export const InboxMachine = z.object({ id: Str, label: NStr, offline: NStr });
export const INBOX_SEVERITIES = ["urgent", "warning", "info"] as const;
export const INBOX_ALERT_KINDS = ["agent", "blocked"] as const;

/**
 * Fields every row has. Tokens never appear in this topic: the bridge holds them (PLAN section 2). `actions`
 * names the verbs the row takes now; it is empty for a row the phone can only read.
 */
const RowBase = {
  key: z.string().min(1),
  actions: z.array(Str),
  /** First seen after the bridge's first good feed, within the last minute. */
  new: z.boolean(),
};

export const InboxGroupRow = z.object({
  ...RowBase,
  kind: z.literal("group"),
  group: z.number().int(),
  title: NStr,
  created_at: Str,
  asker: InboxAsker,
  questions: z.array(InboxQuestion).min(1),
});
export const InboxFailedRow = z.object({
  ...RowBase,
  kind: z.literal("failed"),
  question_id: z.number().int(),
  group: z.number().int(),
  header: NStr,
  question: Str,
  asked_by: NStr,
  answer: NStr,
  answered_at: Str,
  retries: z.number().int(),
  cut: z.boolean(),
  asker: InboxAsker,
  delivery: z.object({
    state: Str,
    /** False for a state word this version does not know: the row shows `line` and offers nothing. */
    known: z.boolean(),
    /** The inbox's own wording for where delivery stands (from the plugin's words.js). */
    line: Str,
    /** True for a real problem; `pending` that retries by itself is delivery at work. */
    warn: z.boolean(),
    attempts: z.number().int(),
    pending_since: NStr,
    auto_retry: z.boolean(),
  }),
  /** "Send now" only on a herdr-tui row that waits for a busy agent, else "Retry delivery". */
  retry_label: z.enum(["Send now", "Retry delivery"]),
});
export const InboxAlertRow = z.object({
  ...RowBase,
  kind: z.literal("alert"),
  id: z.number().int(),
  alert_kind: z.enum(INBOX_ALERT_KINDS),
  severity: z.enum(INBOX_SEVERITIES),
  title: Str,
  message: NStr,
  asked_by: NStr,
  created_at: Str,
  asker: InboxAsker,
});
export const InboxRemoteGroupRow = z.object({
  ...RowBase,
  kind: z.literal("remote_group"),
  machine: InboxMachine,
  title: NStr,
  created_at: NStr,
  tab_label: NStr,
  questions: z.array(InboxQuestion).min(1),
});
export const InboxRemoteOutboxRow = z.object({
  ...RowBase,
  kind: z.literal("remote_outbox"),
  machine: InboxMachine,
  action: Str,
  remote_id: z.number().int(),
  state: Str,
  result: NStr,
  sending: z.boolean(),
  expired: z.boolean(),
  expires_at: NStr,
});
export const InboxRemoteProblemRow = z.object({
  ...RowBase,
  kind: z.literal("remote_problem"),
  machine: InboxMachine,
  remote_id: z.number().int(),
  why: Str,
  question: Str,
  answer: NStr,
  cut: z.boolean(),
});
export const InboxRemoteAlertRow = z.object({
  ...RowBase,
  kind: z.literal("remote_alert"),
  machine: InboxMachine,
  id: z.number().int(),
  alert_kind: z.enum(INBOX_ALERT_KINDS),
  severity: z.enum(INBOX_SEVERITIES),
  title: Str,
  message: NStr,
  tab_label: NStr,
  asked_by: NStr,
  created_at: NStr,
});

export const INBOX_KINDS = ["group", "failed", "alert", "remote_group", "remote_outbox", "remote_problem", "remote_alert"] as const;

/** A kind this version does not know: its key is shown and nothing is offered on it. */
export const InboxUnknownRow = z
  .object({ ...RowBase, kind: Str })
  .refine((r) => !(INBOX_KINDS as readonly string[]).includes(r.kind), { message: "known kind", path: ["kind"] });

export const InboxRow = z.union([
  z.discriminatedUnion("kind", [
    InboxGroupRow,
    InboxFailedRow,
    InboxAlertRow,
    InboxRemoteGroupRow,
    InboxRemoteOutboxRow,
    InboxRemoteProblemRow,
    InboxRemoteAlertRow,
  ]),
  InboxUnknownRow,
]);
export type InboxRow = z.infer<typeof InboxRow>;

export const InboxTopic = z.object({
  /** The `herdr-inbox app --help` probe: only `ready` shows rows. */
  plugin: z.enum(["ready", "missing", "too_old", "broken"]),
  /** `ok`: a good feed is held (perhaps old). `unavailable`: none is, and the phone says so. It is never an empty inbox. */
  state: z.enum(["ok", "unavailable"]),
  /** The newest read failed, or the feed is older than 15 s (or unstamped, or from the future). */
  stale: z.boolean(),
  /** Why the newest read failed, in the reader's words; null when it was good. */
  problem: z.enum(["missing", "unreadable", "unsupported", "not-ok"]).nullable(),
  /** The held feed's `generated_at` (POSIX seconds): its age is the phone's `now` minus this. */
  generated_at: z.number().nullable(),
  /** The feed's own `errors` lines. */
  errors: z.array(Str),
  /**
   * Required by the feed rules: whenever errors exist or anything was left out, the phone says so with these
   * counts ("2 questions"), and never shows an empty inbox while something is left out.
   */
  incomplete: z
    .object({
      counts: z.array(Str),
      errors: z.array(Str),
      /** Left-out questions the bridge could not open with `app show` (past the ids, or not fetched yet). */
      unlisted: z.number().int().nonnegative(),
    })
    .nullable(),
  /** True only when the feed is ok, has no rows, and nothing was left out. */
  empty: z.boolean(),
  /** Open question groups on this machine, and alerts. */
  waiting: z.number().int().nonnegative(),
  alerts: z.number().int().nonnegative(),
  entries: z.array(InboxRow),
});
export type InboxTopic = z.infer<typeof InboxTopic>;
/**
 * `chat:<t>` topic: the text of terminal `<t>` (an `hc read`), ANSI already turned into spans.
 * Spans carry text only: the PWA renders them as text nodes, never as HTML. Colours are a palette index
 * 0 to 15 (the theme's ANSI colours) or `#rrggbb`; nothing else is accepted.
 */
export const ChatColor = z.union([z.number().int().min(0).max(15), z.string().regex(/^#[0-9a-f]{6}$/)]);
export type ChatColor = z.infer<typeof ChatColor>;

export const ChatSpan = z.object({
  /** Printable text; the bridge strips every control character and escape sequence. */
  t: z.string(),
  fg: ChatColor.optional(),
  bg: ChatColor.optional(),
  b: z.literal(true).optional(),
  d: z.literal(true).optional(),
  i: z.literal(true).optional(),
  u: z.literal(true).optional(),
  /** Reverse video: the PWA swaps foreground and background. */
  r: z.literal(true).optional(),
});
export type ChatSpan = z.infer<typeof ChatSpan>;

export const ChatLine = z.array(ChatSpan);
export type ChatLine = z.infer<typeof ChatLine>;

export const ChatTopic = z.object({
  /** The terminal id from the topic name. */
  terminal: z.string().min(1),
  lines: z.array(ChatLine),
  /** True when older lines were dropped to fit the bridge's cap. */
  truncated: z.boolean().optional(),
});
export type ChatTopic = z.infer<typeof ChatTopic>;

/** Terminal ids the bridge will pass to `hc` (`t3`, `vps/t7`): no leading dash, no spaces, no control characters. */
export const TERMINAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$/;

/** The terminal id of a `chat:<t>` topic, or null for any other topic or an id that fails {@link TERMINAL_ID}. */
export function chatTerminal(topic: string): string | null {
  if (!topic.startsWith("chat:")) return null;
  const id = topic.slice(5);
  return TERMINAL_ID.test(id) ? id : null;
}

export const Welcome = z.object({
  type: z.literal("welcome"),
  api: z.literal(API_VERSION),
  bridge: z.string().min(1),
  /** Random per bridge start; an unknown epoch gets a fresh `snap`. */
  epoch: z.string().min(1),
});

/** Payload schemas defined so far; other topics stay open until their slices define them. */
const TOPIC_PAYLOADS: Partial<Record<string, z.ZodTypeAny>> = {
  host: HostState,
  plugins: PluginsTopic,
  panorama: PanoramaTopic,
  usage: UsageTopic,

  inbox: InboxTopic,
};

export const Snap = z
  .object({
    type: z.literal("snap"),
    topic: Topic,
    epoch: z.string().min(1),
    /** Per-topic counter within an epoch; a `snap` sets it, each `patch` is previous + 1. */
    seq: z.number().int().nonnegative(),
    data: z.unknown(),
  })
  .superRefine((m, ctx) => {
    const payload = m.topic.startsWith("chat:") ? ChatTopic : TOPIC_PAYLOADS[m.topic];
    if (!payload) return;
    const r = payload.safeParse(m.data);
    if (!r.success) {
      for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
    }
  });

/** RFC 6901 JSON Pointer: empty string or starting with "/". */
const Pointer = z.string().regex(/^(\/.*)?$/);

/** RFC 6902 JSON Patch operation. */
export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: Pointer, value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: Pointer }),
  z.object({ op: z.literal("replace"), path: Pointer, value: z.unknown() }),
  z.object({ op: z.literal("move"), from: Pointer, path: Pointer }),
  z.object({ op: z.literal("copy"), from: Pointer, path: Pointer }),
  z.object({ op: z.literal("test"), path: Pointer, value: z.unknown() }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

export const Patch = z.object({
  type: z.literal("patch"),
  topic: Topic,
  seq: z.number().int().nonnegative(),
  ops: z.array(PatchOp),
});

/** Known reasons; the field stays open so the bridge can add more without a version bump. */
export const STALE_REASONS = ["reconnecting", "layout_without_remote", "source_unavailable", "terminal_not_found", "bad_terminal", "too_many_chats"] as const;
export const Stale = z.object({
  type: z.literal("stale"),
  topic: Topic,
  reason: z.string().min(1),
});

export const Res = z
  .object({
    type: z.literal("res"),
    id: z.string().min(1),
    ok: z.boolean(),
    /** Required when `ok` is false. */
    code: z.string().min(1).optional(),
    /** Non-zero exit outside the contract, or bad stdout: the PWA says so, refreshes and never retries. Only with `ok: false`. */
    unknown_effect: z.boolean().optional(),
  })
  .refine((r) => r.ok || r.code !== undefined, { message: "code is required when ok is false", path: ["code"] })
  .refine((r) => !r.ok || r.unknown_effect === undefined, {
    message: "unknown_effect is only valid when ok is false",
    path: ["unknown_effect"],
  });

export const Event = z.object({
  type: z.literal("event"),
  topic: Topic,
  name: z.string().min(1),
  data: z.unknown(),
});

export const Pong = z.object({ type: z.literal("pong") });

export const ServerMessage = z.union([Welcome, Snap, Patch, Stale, Res, Event, Pong]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type Welcome = z.infer<typeof Welcome>;
export type Snap = z.infer<typeof Snap>;
export type Patch = z.infer<typeof Patch>;
export type Stale = z.infer<typeof Stale>;
export type Res = z.infer<typeof Res>;
export type Event = z.infer<typeof Event>;
