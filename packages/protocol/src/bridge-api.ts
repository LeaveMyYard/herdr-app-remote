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

/**
 * `host`, `plugins`, `panorama`, `inbox`, `usage`, `setup`, `keys`, `chat:<t>`, or a chat view topic
 * (`chatview:<t>`, `timeline:<t>`; docs/chatview.md §4, §7), whose payloads their slices (CV3, CV5) define.
 */
export const Topic = z.union([
  z.enum(["host", "plugins", "panorama", "inbox", "usage", "setup", "keys"]),
  z.string().regex(/^chat:.+$/),
  z.string().regex(/^(chatview|timeline):.+$/),
]);
export type Topic = z.infer<typeof Topic>;

/**
 * Topics that carry agents' conversations (CV1, docs/chatview.md §5.1). Besides `view` they need the
 * `transcript.read` capability: a `sub` without it is answered `stale {reason: "forbidden"}` and nothing is
 * sent, and losing the capability ends the subscription the same way. `GET /api/v1/chatview/<t>` needs it too.
 */
export const TRANSCRIPT_TOPIC_PREFIXES = ["chatview:", "timeline:"] as const;
/** Whether `topic` is a {@link TRANSCRIPT_TOPIC_PREFIXES} topic. */
export function isTranscriptTopic(topic: string): boolean {
  return TRANSCRIPT_TOPIC_PREFIXES.some((p) => topic.startsWith(p));
}

// ---- GET /api/v1/meta ----

export const Meta = z.object({
  api: z.literal(API_VERSION),
  bridge: z.string().min(1),
  /** The computer's name in the phone's copy ("desk-1"): the serve name's first label, else the hostname's. */
  host_name: z.string().min(1).max(63).optional(),
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
  /**
   * The panes that used this account in the last window (collect-v1 `paneActivity.panes`), kept as pane ids only: the
   * chat view's strip (`usage.account`, CV6) finds a terminal's account by them. `paneId` is what the bridge passed in
   * `--panes` (the terminal id).
   */
  paneActivity: z.object({ panes: z.array(z.object({ paneId: z.string() })) }).nullish(),
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
  /**
   * Binds an `act` to the content shown (S11): the bridge's own keyed hash of this row as published plus the
   * row token it holds. An `act` names the `rev` it was drawn from; any other is refused as `stale` before the
   * inbox is asked, so a token that moved under a rendered row is never used for it. Reveals nothing of the token.
   */
  rev: z.string().min(1).max(64),
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

// ---- inbox acts (S11) ----

/** A question or alert id as the inbox writes it: canonical decimal in [1, 2^53 - 1]. */
const InboxId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * An answer as the phone picked it. `choices` are option INDICES into the question as the bridge published it,
 * and `notes` are keyed by those indices: the bridge turns them into labels from its own data, so no label the
 * client sends is ever passed on or logged. `text` is the free-text answer.
 */
export const InboxDetailArg = z
  .object({
    choices: z.array(z.number().int().nonnegative()).max(256),
    notes: z.record(z.string().regex(/^(0|[1-9][0-9]{0,2})$/), z.string()),
    text: z.string().nullable(),
  })
  .strict();
export type InboxDetailArg = z.infer<typeof InboxDetailArg>;

const Bound = { key: z.string().min(1).max(200), rev: z.string().min(1).max(64) };

/** `inbox.answer`: a lone question's answer (`question` + `detail`), or a Submit of stored drafts (`questions`). */
export const InboxAnswerArgs = z.union([
  z.object({ ...Bound, question: InboxId, detail: InboxDetailArg }).strict(),
  z.object({ ...Bound, questions: z.array(InboxId).min(1).max(64) }).strict(),
]);
/** `inbox.draft`: store an unsent answer, or clear it. */
export const InboxDraftArgs = z.union([
  z.object({ ...Bound, question: InboxId, detail: InboxDetailArg }).strict(),
  z.object({ ...Bound, question: InboxId, clear: z.literal(true) }).strict(),
]);
/** `inbox.dismiss`: one question, or without `question` every open question of the group. */
export const InboxDismissArgs = z.object({ ...Bound, question: InboxId.optional() }).strict();
/** `inbox.retry`, `inbox.stop_showing` (a `failed` row) and `inbox.ack` (an alert). */
export const InboxRowArgs = z.object(Bound).strict();

/** Each inbox `act` kind, the `herdr-inbox app` verb it runs, the row kind it takes and its argument schema. */
export const INBOX_ACTS = {
  "inbox.answer": { verb: "answer", row: "group", args: InboxAnswerArgs },
  "inbox.draft": { verb: "draft", row: "group", args: InboxDraftArgs },
  "inbox.dismiss": { verb: "dismiss", row: "group", args: InboxDismissArgs },
  "inbox.retry": { verb: "retry", row: "failed", args: InboxRowArgs },
  "inbox.stop_showing": { verb: "stop-showing", row: "failed", args: InboxRowArgs },
  "inbox.ack": { verb: "ack", row: "alert", args: InboxRowArgs },
} as const;
export type InboxActKind = keyof typeof INBOX_ACTS;

const actOf = <K extends InboxActKind>(kind: K) =>
  z.object({ type: z.literal("act"), id: z.string().min(1), kind: z.literal(kind), args: INBOX_ACTS[kind].args }).strict();
/** A client `act` for the inbox, checked against its kind's arguments (the bridge parses `args` with the same schemas). */
export const InboxAct = z.union([
  actOf("inbox.answer"),
  actOf("inbox.draft"),
  actOf("inbox.dismiss"),
  actOf("inbox.retry"),
  actOf("inbox.stop_showing"),
  actOf("inbox.ack"),
]);
export type InboxAct = z.infer<typeof InboxAct>;

/** The `closed` words of app-commands-v1 (a `stale` refusal), plus `answered`/`dismissed`/`acked`/`hidden` for the bridge's own verbs. */
export const INBOX_CLOSED = ["answered", "dismissed", "withdrawn", "delivered", "fetched", "hidden", "acked", "cleared", "removed"] as const;
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

// ---- chat view topic (CV3): `chatview:<t>` and its older pages (docs/chatview.md §2, §3, §5, §7) ----
//
// An agent's conversation as chat items, read from its own history through the bridge's Claude reader. Only what
// §5.2 lets leave the bridge is here: prompt and reply text, AskUserQuestion text and options, tool names, file
// base names and counts. Never tool inputs or outputs, thinking, transcript paths, config dirs or session ids.

/** Prefix of the chat view topic. */
export const CHATVIEW_PREFIX = "chatview:";

/** The terminal id of a `chatview:<t>` topic, or null for any other topic or an id that fails {@link TERMINAL_ID}. */
export function chatviewTerminal(topic: string): string | null {
  if (!topic.startsWith(CHATVIEW_PREFIX)) return null;
  const id = topic.slice(CHATVIEW_PREFIX.length);
  return TERMINAL_ID.test(id) ? id : null;
}

/** The newest items the topic carries. Older ones come from {@link ChatviewPage}. */
export const CHATVIEW_WINDOW = 100;
/** A snap (and a page) stays at or under this many bytes of JSON; the oldest items are left out to fit. */
export const CHATVIEW_SNAP_MAX_BYTES = 512 * 1024;
/** Each text block is cut at this many UTF-8 bytes. */
export const CHATVIEW_TEXT_MAX_BYTES = 16 * 1024;
/** Each message's text, all blocks together, is cut at this many UTF-8 bytes. */
export const CHATVIEW_MESSAGE_MAX_BYTES = 32 * 1024;
/** The most items one `GET /api/v1/chatview/<t>` returns (`n`, default this). */
export const CHATVIEW_PAGE_MAX = 50;

/**
 * Why a chat view is unavailable (§6). The phone shows the text view with the notice for the reason:
 * - `harness`: the agent is not Claude Code (Codex and others keep the text view in v1);
 * - `no_panorama`: herdr-panorama is missing or runs in basic mode (no lease owner, no feed, no verified contract);
 * - `no_profiles`: herdr-agent-usage is missing, or its profile list is unreadable or empty;
 * - `no_binding`: panorama proves no session for this exact terminal (feed aged or stale, no root, no session id,
 *   a conflicting or ambiguous join), or no agent-usage root holds it;
 * - `reader_failed`: the reader could not read the session, or the SDK's shape is unexpected;
 * - `forbidden`: `transcript.read` is off. The bridge sends it as `stale {reason: "forbidden"}` (CV1) and the
 *   page route as 403, never inside a topic value; it is listed so the phone has one vocabulary.
 */
export const CHATVIEW_REASONS = ["harness", "no_panorama", "no_profiles", "no_binding", "reader_failed", "forbidden"] as const;
export const ChatviewReason = z.enum(CHATVIEW_REASONS);
export type ChatviewReason = z.infer<typeof ChatviewReason>;

/** Item ids: a message uuid, or one with a suffix (`<uuid>:q1`, `day:<uuid>`). Opaque to the phone. */
export const ChatItemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/);

/**
 * Tool row kinds (§3): `shell` "Ran 2 shell commands", `read` "Read 3 files", `edit` "Edited 2 files", `search`
 * "Searched 4 times", `subagent` "Ran 3 subagents", `other` "Used 2 tools" (also a run that mixes kinds).
 */
export const TOOL_KINDS = ["shell", "read", "edit", "search", "subagent", "other"] as const;
export const ToolKind = z.enum(TOOL_KINDS);
export type ToolKind = z.infer<typeof ToolKind>;

/** At most this many calls are named in one row; `count` still counts them all. */
export const CHAT_TOOL_NAMES_MAX = 50;

export const ChatTools = z
  .object({
    kind: ToolKind,
    /** Calls in the run. */
    count: z.number().int().positive(),
    /** Calls with no result yet. The phone shows a spinner only while the host says the agent is working. */
    running: z.number().int().nonnegative(),
    /** Calls whose result is an error ("1 command failed"). */
    failed: z.number().int().nonnegative(),
    /** One line per call: the tool name, and for a file tool the file's base name ("Read · main.ts"). Never input or output. */
    names: z.array(z.string().min(1).max(200)).max(CHAT_TOOL_NAMES_MAX),
  })
  .strict();
export type ChatTools = z.infer<typeof ChatTools>;

export const ChatAskOption = z.object({ label: z.string().max(400), description: z.string().max(2000).nullable() }).strict();

/**
 * The agent asked a question. `via: "claude"`: an AskUserQuestion call (its text and options, one item per
 * question). `via: "inbox"`: a herdr-inbox `ask_operator` call, shown as "Asked you a question" with no text (CV5
 * puts the inbox's own item in its place).
 */
export const ChatAsk = z
  .object({
    via: z.enum(["claude", "inbox"]),
    question: z.string().max(4000).nullable(),
    header: z.string().max(200).nullable(),
    multi: z.boolean(),
    options: z.array(ChatAskOption).max(20),
  })
  .strict();
export type ChatAsk = z.infer<typeof ChatAsk>;

const itemBase = { id: ChatItemId, at: z.string().datetime().nullable() };

/** A Claude `tool_use` id as herdr-inbox keeps it (app-feed-v1 minor 1): 1 to 128 of `[A-Za-z0-9_-]`. */
export const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A prompt's option list from the screen (§3a.3). Defined for CV7; CV3 never produces `prompt` items. */
export const ChatPromptQuestion = z
  .object({
    text: z.string().max(4000),
    header: z.string().max(200),
    multi: z.boolean(),
    options: z.array(ChatAskOption).max(20),
    other: z.boolean(),
  })
  .strict();

export const ChatItem = z.discriminatedUnion("role", [
  z
    .object({
      ...itemBase,
      role: z.literal("you"),
      /** Markdown-free prompt text, redacted and cut. For a command chip, just the command ("/compact"). */
      text: z.string(),
      /** The message only wrapped a slash command: a one-line chip. */
      command: z.literal(true).optional(),
      /** The text was cut at the 16 KB block or 32 KB message limit: the phone shows "Cut here". */
      cut: z.literal(true).optional(),
    })
    .strict(),
  z.object({ ...itemBase, role: z.literal("agent"), text: z.string(), cut: z.literal(true).optional() }).strict(),
  z.object({ ...itemBase, role: z.literal("tools"), tools: ChatTools }).strict(),
  /**
   * `cut`: the message's questions and options were cut to fit its 32 KB. `tool_use_id` (CV5): only on a `via:
   * "inbox"` item, the `ask_operator` call's id in this agent's own transcript, so a `timeline:<t>` item anchored on
   * it takes its place. An opaque id; never on any other item.
   */
  z.object({ ...itemBase, role: z.literal("ask"), ask: ChatAsk, cut: z.literal(true).optional(), tool_use_id: z.string().regex(TOOL_USE_ID).optional() }).strict(),
  /** `compact`: "Earlier messages were summarised". `day`: a day divider ("Today 21:02"), formatted by the phone from `at`. */
  z.object({ ...itemBase, role: z.literal("divider"), divider: z.enum(["compact", "day"]) }).strict(),
  /** A native prompt card (§3a, §7). Defined here for CV7; CV3 never produces one. */
  z
    .object({
      ...itemBase,
      role: z.literal("prompt"),
      prompt_id: z.string().regex(/^[0-9a-f]{64}$/),
      rev: z.string().min(1).max(128),
      kind: z.enum(["permission", "question", "plan", "other", "unparsed"]),
      title: z.string().max(400),
      summary: z.string().max(2000).optional(),
      questions: z.array(ChatPromptQuestion).max(4).optional(),
      plan_md: z.string().max(CHATVIEW_MESSAGE_MAX_BYTES).optional(),
      options: z.array(z.object({ label: z.string().max(400) }).strict()).max(20),
      screen_lines: z.array(z.string().max(400)).max(60).optional(),
      state: z.enum(["open", "answered", "gone"]),
    })
    .strict(),
  /** A status row such as "Stopped by you · 21:14" (CV8). Defined here; CV3 never produces one. */
  z.object({ ...itemBase, role: z.literal("status"), status: z.enum(["stopped"]) }).strict(),
]).superRefine((i, ctx) => {
  // A `tool_use_id` names an `ask_operator` call: never on a Claude ask, which no timeline item may replace.
  if (i.role === "ask" && i.tool_use_id !== undefined && i.ask.via !== "inbox") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tool_use_id"], message: "tool_use_id is only on a via inbox ask" });
});
export type ChatItem = z.infer<typeof ChatItem>;

/**
 * The status line (§3): the host topic's agent status, not the transcript. `working` shows "Working · 1m 12s"
 * timed from `since` (the last prompt's time), `blocked` shows "Waiting for you", `idle` shows nothing.
 */
export const ChatviewStatus = z
  .object({
    state: z.enum(["working", "blocked", "idle"]),
    since: z.string().datetime().nullable(),
  })
  .strict();
export type ChatviewStatus = z.infer<typeof ChatviewStatus>;

export const ChatviewTopic = z
  .object({
    terminal: z.string().regex(TERMINAL_ID),
    /** The harness id as panorama or the host names it (`claude`, `codex`), or `unknown`. */
    harness: z.string().min(1).max(64),
    state: z.enum(["ok", "unavailable"]),
    /** Set exactly when `state` is `unavailable`. */
    reason: ChatviewReason.optional(),
    /** The newest items, oldest first: at most {@link CHATVIEW_WINDOW}, and the whole value at most {@link CHATVIEW_SNAP_MAX_BYTES}. */
    items: z.array(ChatItem).max(CHATVIEW_WINDOW),
    /** Older items exist: `GET /api/v1/chatview/<t>?before=<items[0].id>` returns them. */
    older: z.boolean(),
    /**
     * The history's revision: a new random value whenever the bridge starts over (another session, a rewritten
     * chain after a compaction or rewind). The phone drops older pages it holds from another `rev`.
     */
    rev: z.string().max(64),
    status: ChatviewStatus,
  })
  .strict()
  .refine((t) => (t.state === "unavailable") === (t.reason !== undefined), { message: "reason is set exactly when unavailable", path: ["reason"] })
  .refine((t) => t.reason !== "forbidden", { message: "forbidden is sent as stale, never in the topic", path: ["reason"] });
export type ChatviewTopic = z.infer<typeof ChatviewTopic>;

/** `GET /api/v1/chatview/<t>?before=<id>&n=<1..50>[&rev=<rev>]`: the items just before `before`, oldest first. */
export const ChatviewPage = z
  .object({
    items: z.array(ChatItem).max(CHATVIEW_PAGE_MAX),
    /** Items older than these exist. */
    older: z.boolean(),
    rev: z.string().max(64),
  })
  .strict();
export type ChatviewPage = z.infer<typeof ChatviewPage>;

// ---- timeline topic (CV5): `timeline:<t>` (docs/chatview.md §4, §7) ----
//
// Plugin items for one terminal's chat view: the bridge filters rows it already holds from plugin topics by the
// terminal address and passes on the plugin-built fields. Every item has a generic fallback (`title`, `line`,
// `href`), so a kind the phone doesn't know is still drawn as a plain row. Acts are the plugin's own (inbox acts).

/** Prefix of the timeline topic. */
export const TIMELINE_PREFIX = "timeline:";

/** The terminal id of a `timeline:<t>` topic, or null for any other topic or an id that fails {@link TERMINAL_ID}. */
export function timelineTerminal(topic: string): string | null {
  if (!topic.startsWith(TIMELINE_PREFIX)) return null;
  const id = topic.slice(TIMELINE_PREFIX.length);
  return TERMINAL_ID.test(id) ? id : null;
}

/** Items and strip entries one topic carries at most. */
export const TIMELINE_ITEMS_MAX = 200;
export const TIMELINE_STRIP_MAX = 8;

/** A link the phone may follow: one of its own hash routes, never a URL to elsewhere. */
export const TimelineHref = z.string().max(400).regex(/^#\/[A-Za-z0-9%._~/-]*$/);

/** Strip data of `panorama.swarm`: the joined root's subagents counted per status, as Swarm draws them. */
export const SwarmStripData = z
  .object({
    /** The panorama root key (opaque), and its space for the Swarm link. */
    root_key: z.string().min(1),
    space_id: z.string().min(1).nullable(),
    /** Subagents per status (every finished one as `done`): running first, then finished, then those that need you. */
    counts: z.array(z.object({ code: AgentCode, n: z.number().int().positive() }).strict()).max(AGENT_CODES.length),
    /** Every subagent the root lists, plus the finished ones it hides. */
    total: z.number().int().nonnegative(),
    /** The subagent that needs you (waiting, blocked or failed), for a long-press Peek; null when none does. */
    needs: z.string().min(1).nullable(),
  })
  .strict();
export type SwarmStripData = z.infer<typeof SwarmStripData>;

/** What a known kind's `data` must be. Any other kind's `data` is not checked here (the phone draws the fallback). */
const TIMELINE_DATA: Record<string, z.ZodTypeAny> = {
  "inbox.question": InboxGroupRow,
  "inbox.alert": InboxAlertRow,
  "inbox.failed": InboxFailedRow,
};
/** Strip data of `usage.account`: the pane's account as the Usage screen names it, and its first window's use. */
export const UsageStripData = z
  .object({
    /** The `providerId` of the account's entry in the `usage` report (the Usage screen's row). */
    provider_id: z.string().min(1),
    /** The account's label: its profile name, else its account label, else the provider's own label. */
    account: z.string().min(1).max(200),
    /** The primary window's use, 0 to 100 and rounded, whichever way the report counts; null when it has no window. */
    used_percent: z.number().int().min(0).max(100).nullable(),
    /** The primary window's tag (`5h`, `7d`...), null with no window. */
    window: z.string().min(1).max(40).nullable(),
  })
  .strict();
export type UsageStripData = z.infer<typeof UsageStripData>;

const STRIP_DATA: Record<string, z.ZodTypeAny> = { "panorama.swarm": SwarmStripData, "usage.account": UsageStripData };

const checkData =
  (table: Record<string, z.ZodTypeAny>) =>
  (v: { kind: string; data?: unknown }, ctx: z.RefinementCtx): void => {
    const schema = Object.prototype.hasOwnProperty.call(table, v.kind) ? table[v.kind] : undefined;
    if (!schema) return;
    const r = schema.safeParse(v.data);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ ...i, path: ["data", ...i.path] } as z.IssueData);
  };

const PluginId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const KindId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

export const TimelineItem = z
  .object({
    key: z.string().min(1).max(200),
    plugin: PluginId,
    kind: KindId,
    /** Where it goes among messages when it has no anchor; null puts it at the end. */
    at: z.string().datetime({ offset: true }).nullable(),
    /**
     * The `tool_use` it replaces: set only when the bridge found that id on an `ask_operator` call in this terminal's
     * own transcript (an `ask` item with the same `tool_use_id`). Null: placed by `at`.
     */
    anchor: z.object({ tool_use_id: z.string().regex(TOOL_USE_ID) }).strict().nullable(),
    title: z.string().max(400),
    line: z.string().max(400),
    href: TimelineHref.nullable(),
    data: z.unknown(),
  })
  .strict()
  .superRefine(checkData(TIMELINE_DATA));
export type TimelineItem = z.infer<typeof TimelineItem>;

export const StripItem = z
  .object({
    key: z.string().min(1).max(200),
    plugin: PluginId,
    kind: KindId,
    label: z.string().max(200),
    tone: z.enum(["ok", "warn", "bad", "muted"]),
    href: TimelineHref.nullable(),
    data: z.unknown(),
  })
  .strict()
  .superRefine(checkData(STRIP_DATA));
export type StripItem = z.infer<typeof StripItem>;

export const TimelineTopic = z
  .object({
    terminal: z.string().regex(TERMINAL_ID),
    /** Oldest first by `at` (null last). */
    items: z.array(TimelineItem).max(TIMELINE_ITEMS_MAX),
    strip: z.array(StripItem).max(TIMELINE_STRIP_MAX),
  })
  .strict();
export type TimelineTopic = z.infer<typeof TimelineTopic>;

/**
 * `terminal.send` (S16, capability `terminal.input`): `hc send` pastes `text` into the terminal and presses Enter.
 * That is all it can do (checked in the rig against hc 0.1.19): it has no special keys. Those are `terminal.keys`
 * (S16b, below), a separate capability that presses only entries of the desktop's key menu.
 * An empty `text` presses Enter alone.
 */
export const TERMINAL_SEND_MAX_CHARS = 4000;
/**
 * What `text` may not hold: C0 controls other than tab and newline (ESC above all, which could end a bracketed
 * paste and type keys), DEL and the C1 controls. `\r` is refused too: a client sends newlines as `\n`.
 */
// eslint-disable-next-line no-control-regex
export const TERMINAL_SEND_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
export const TerminalSendArgs = z
  .object({
    terminal: z.string().regex(TERMINAL_ID),
    text: z
      .string()
      .refine((s) => [...s].length <= TERMINAL_SEND_MAX_CHARS, { message: `at most ${TERMINAL_SEND_MAX_CHARS} characters` })
      .refine((s) => !TERMINAL_SEND_UNSAFE.test(s), { message: "control characters other than newline and tab are not sent" }),
  })
  .strict();
export type TerminalSendArgs = z.infer<typeof TerminalSendArgs>;

// ---- terminal keys (S16b): the special-keys menu ----
//
// `terminal.keys` (capability `terminal.keys`, separate from `terminal.input`) presses one entry of the desktop's
// key menu: the phone names the entry by id, and the bridge runs `hc keys` with the key tokens the desktop's config
// gave that entry. The phone never sends key names. The grammar below is a strict subset of what `hc keys` accepts
// (hc 0.1.19, checked in the rig), chosen so that no token types plain text on its own: every one sends a control
// byte or an ESC-prefixed sequence. An `alt` letter or digit is ESC followed by that printable character, so a program
// that does not read ESC+x as Alt sees the character; the menu is the desktop's own file, so that is its choice.

/** Named keys, in hc's lowercase spelling. `space` is not here: alone it types a space (see {@link isKeyToken}). */
export const KEY_NAMES = [
  "esc", "enter", "tab", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown",
  "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
] as const;
/** Modifiers, in the one order a token may list them. */
export const KEY_MODIFIERS = ["ctrl", "alt", "shift"] as const;
/** Keys per menu entry. */
export const KEYS_MAX_PER_ENTRY = 8;
/** Entries in the menu. */
export const KEYS_MAX_ENTRIES = 32;
/** A label's length in code points. */
export const KEY_LABEL_MAX = 24;
/** A menu entry's id: what the phone sends and what Activity records. */
export const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** A key menu revision: 16 hex digits. */
export const KEYS_REV = /^[0-9a-f]{16}$/;

const NAMED: ReadonlySet<string> = new Set(KEY_NAMES);

/**
 * One key token in canonical form: optional modifiers in the order `ctrl`, `alt`, `shift` (each at most once),
 * joined by `+`, then the base key:
 * - a named key ({@link KEY_NAMES}), with any modifiers (`esc`, `shift+tab`, `ctrl+left`, `alt+enter`);
 * - a letter `a`-`z` with `ctrl` and/or `alt` and never `shift` (`ctrl+c`, `alt+b`): a bare or shifted letter is text.
 *   `ctrl+i` and `ctrl+m` alone are refused, as hc refuses them (they are `tab` and `enter`; `ctrl+alt+i` is fine);
 * - a digit `0`-`9` with `alt` only (`alt+1`): the rig showed `ctrl+0` types a plain `0`;
 * - `space` with `ctrl` and/or `alt` and never `shift`: a bare or shifted space is text.
 * Anything else, including hc's other spellings (`Escape`, `Ctrl+C`, `pgup`), is refused.
 */
export function isKeyToken(token: unknown): boolean {
  if (typeof token !== "string" || token.length > 24) return false;
  const parts = token.split("+");
  const base = parts.pop()!;
  let last = -1;
  const mods = new Set<string>();
  for (const m of parts) {
    const i = (KEY_MODIFIERS as readonly string[]).indexOf(m);
    if (i <= last) return false;
    last = i;
    mods.add(m);
  }
  if (NAMED.has(base)) return true;
  const ctrl = mods.has("ctrl");
  const alt = mods.has("alt");
  const shift = mods.has("shift");
  if (/^[a-z]$/.test(base) || base === "space") return (ctrl || alt) && !shift && !(ctrl && !alt && (base === "i" || base === "m"));
  if (/^[0-9]$/.test(base)) return alt && !ctrl && !shift;
  return false;
}

/** Every token {@link isKeyToken} accepts (the rig presses each one through the real `hc keys`). */
export function allKeyTokens(): string[] {
  const mods = ["", "ctrl+", "alt+", "shift+", "ctrl+alt+", "ctrl+shift+", "alt+shift+", "ctrl+alt+shift+"];
  const out: string[] = [];
  for (const m of mods) for (const k of KEY_NAMES) out.push(`${m}${k}`);
  for (const m of ["ctrl+", "alt+", "ctrl+alt+"]) for (const k of [..."abcdefghijklmnopqrstuvwxyz", "space"]) if (isKeyToken(`${m}${k}`)) out.push(`${m}${k}`);
  for (const d of "0123456789") out.push(`alt+${d}`);
  return out;
}

/**
 * Characters a key label may not hold: controls (Cc), format characters (Cf: zero-width, bidi marks and overrides,
 * U+061C, U+FEFF, interlinear annotation, tag characters), line and paragraph separators, and the invisible U+034F.
 */
export const KEY_LABEL_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f]/u;

/** A menu label: shown on the phone as text, never as HTML. 1 to 24 code points, no surrounding spaces. */
export const KeyLabel = z
  .string()
  .refine((s) => s.length > 0 && s === s.trim(), { message: "a label is not empty and has no surrounding spaces" })
  .refine((s) => [...s].length <= KEY_LABEL_MAX, { message: `a label has at most ${KEY_LABEL_MAX} characters` })
  .refine((s) => !KEY_LABEL_UNSAFE.test(s), { message: "a label holds no control, separator, zero-width or bidi characters" });

export const KeyToken = z.string().refine(isKeyToken, { message: "not an allowed key token" });

export const KeyEntry = z
  .object({
    id: z.string().regex(KEY_ID),
    label: KeyLabel,
    /** The tokens `hc keys` presses, in order. */
    keys: z.array(KeyToken).min(1).max(KEYS_MAX_PER_ENTRY),
  })
  .strict();
export type KeyEntry = z.infer<typeof KeyEntry>;

/**
 * The menu when the desktop has no `keys.json` (labels from the PhoneKeys board). The phone draws these first and
 * any other entry under "Your keys".
 */
export const DEFAULT_KEYS: readonly KeyEntry[] = [
  { id: "esc", label: "Esc", keys: ["esc"] },
  { id: "tab", label: "Tab", keys: ["tab"] },
  { id: "shift-tab", label: "Shift-Tab", keys: ["shift+tab"] },
  { id: "ctrl-c", label: "Ctrl-C", keys: ["ctrl+c"] },
  { id: "up", label: "\u2191", keys: ["up"] },
  { id: "down", label: "\u2193", keys: ["down"] },
  { id: "left", label: "\u2190", keys: ["left"] },
  { id: "right", label: "\u2192", keys: ["right"] },
];

/** Whether an entry is one of {@link DEFAULT_KEYS} as it is (same id and keys). */
export function isDefaultKey(e: { id: string; keys: readonly string[] }): boolean {
  const d = DEFAULT_KEYS.find((x) => x.id === e.id);
  return d !== undefined && d.keys.length === e.keys.length && d.keys.every((k, i) => k === e.keys[i]);
}

/**
 * `keys` topic: the desktop's key menu. `rev` changes whenever the menu does; a `terminal.keys` act names the `rev`
 * it was shown, so a press from a menu that has since changed is refused instead of pressing something else.
 */
export const KeysTopic = z
  .object({
    rev: z.string().regex(KEYS_REV),
    keys: z
      .array(KeyEntry)
      .max(KEYS_MAX_ENTRIES)
      .refine((a) => new Set(a.map((e) => e.id)).size === a.length, { message: "entry ids are unique" }),
  })
  .strict();
export type KeysTopic = z.infer<typeof KeysTopic>;

/** `act terminal.keys` (capability `terminal.keys`): press menu entry `key`, as shown at `rev`, in `terminal`. */
export const TerminalKeysArgs = z
  .object({
    terminal: z.string().regex(TERMINAL_ID),
    key: z.string().regex(KEY_ID),
    rev: z.string().regex(KEYS_REV),
  })
  .strict();
export type TerminalKeysArgs = z.infer<typeof TerminalKeysArgs>;

export const Welcome = z.object({
  type: z.literal("welcome"),
  api: z.literal(API_VERSION),
  bridge: z.string().min(1),
  /** Random per bridge start; an unknown epoch gets a fresh `snap`. */
  epoch: z.string().min(1),
});

// ---- setup topic (S14): the desktop's Tailscale setup checks and serve state ----

/** The five setup steps, in order (DesktopSetup board). */
export const SETUP_STEPS = ["installed", "signed_in", "https", "serving", "phone"] as const;
export const SetupStepId = z.enum(SETUP_STEPS);
export type SetupStepId = z.infer<typeof SetupStepId>;

/** `done`, the first step not done is `current`, the ones after it are `todo`. */
export const SetupStepState = z.enum(["done", "current", "todo"]);

/**
 * Why a step is not done. `message` is a fixed sentence (never CLI output). `fix` is a command the
 * person runs themselves (the bridge never runs it); `url` is a Tailscale admin page.
 */
export const SETUP_PROBLEMS = [
  "not_installed",
  "too_old",
  "daemon_down",
  "needs_login",
  "stopped",
  "tagged",
  "magicdns_off",
  "https_off",
  "port_taken",
  "funnel_on",
  "operator",
  "serve_disabled",
  "not_ours",
  "failed",
  "unknown",
  "no_device",
] as const;
export const SetupProblemCode = z.enum(SETUP_PROBLEMS);
export type SetupProblemCode = z.infer<typeof SetupProblemCode>;

export const SetupProblem = z
  .object({
    code: SetupProblemCode,
    message: z.string().min(1).max(300),
    fix: z.string().min(1).max(200).optional(),
    url: z.string().startsWith("https://login.tailscale.com/").max(300).optional(),
  })
  .strict();
export type SetupProblem = z.infer<typeof SetupProblem>;

export const SetupStep = z
  .object({
    id: SetupStepId,
    state: SetupStepState,
    title: z.string().min(1),
    detail: z.string(),
    problem: SetupProblem.optional(),
  })
  .strict();
export type SetupStep = z.infer<typeof SetupStep>;

/**
 * How the serve port is configured:
 * - `ours`: our handler, created by this bridge (it may remove it);
 * - `identical`: exactly our handler, but not created by us (used, never removed);
 * - `off`: nothing on the port;
 * - `foreign`: something else is on the port (never changed);
 * - `funnel`: Funnel is on for the port (never served);
 * - `unknown`: tailscale could not tell.
 */
export const SetupServing = z.enum(["ours", "identical", "off", "foreign", "funnel", "unknown"]);
export type SetupServing = z.infer<typeof SetupServing>;

export const SetupTopic = z
  .object({
    /** 1-based index of the current step; 6 when every step is done. */
    step: z.number().int().min(1).max(6),
    steps: z.array(SetupStep).length(5),
    serving: SetupServing,
    /** The HTTPS port `tailscale serve` uses for the bridge (PLAN §7.8). */
    port: z.number().int().min(1).max(65535),
    /** The tailnet URL of the PWA, once served. */
    url: z.string().startsWith("https://").nullable(),
    /** The owner login the bridge requires (`Tailscale-User-Login`), once served. */
    login: z.string().nullable(),
    can_start: z.boolean(),
    can_stop: z.boolean(),
    /**
     * A problem from the last Start or Stop that the steps can't show because step 4 reads done (S14b): Stop
     * failing while the handler is still ours (e.g. `operator`), or Start serving without being able to record
     * the handler as ours (`failed`, with the command that stops it). Cleared by the next Start or Stop, or once
     * the port no longer holds the handler. In memory only: lost on a bridge restart (an unrecorded handler then
     * reads `identical`: used, never removed by herdr).
     */
    notice: SetupProblem.nullable(),
    /** A start, stop or check is running. */
    busy: z.boolean(),
    checked_at: z.number().int().nullable(),
  })
  .strict();
export type SetupTopic = z.infer<typeof SetupTopic>;

/** Payload schemas defined so far; other topics stay open until their slices define them. */
const TOPIC_PAYLOADS: Partial<Record<string, z.ZodTypeAny>> = {
  host: HostState,
  plugins: PluginsTopic,
  panorama: PanoramaTopic,
  usage: UsageTopic,

  inbox: InboxTopic,
  setup: SetupTopic,
  keys: KeysTopic,
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
    const payload = m.topic.startsWith("chat:") ? ChatTopic : m.topic.startsWith(CHATVIEW_PREFIX) ? ChatviewTopic : TOPIC_PAYLOADS[m.topic];
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
export const STALE_REASONS = ["reconnecting", "layout_without_remote", "source_unavailable", "terminal_not_found", "bad_terminal", "too_many_chats", "hc_missing", "forbidden", "audit_unavailable"] as const;
/**
 * `hc_missing`: a chat could not run `hc` (not on the bridge's PATH nor in `~/.local/bin`). `forbidden` (CV1): the
 * device lacks a capability the topic needs (`transcript.read` for {@link TRANSCRIPT_TOPIC_PREFIXES}); the bridge
 * did not subscribe it, or ended its subscription, and sends nothing more on the topic until a new `sub`.
 * `audit_unavailable` (CV3): a `chatview:<t>` open was refused because Activity could not record it; like
 * `forbidden`, nothing was subscribed. A later `sub` tries again.
 */
export type StaleReason = (typeof STALE_REASONS)[number];
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
    /**
     * Plain text the PWA may show, in the plugin's own words (for the inbox: herdr-inbox's words.js). It never
     * holds answer text: the inbox never echoes `--detail`, and the bridge adds none.
     */
    message: z.string().max(2000).optional(),
    /** For an inbox `act`: the row is closed now, and why (one of `INBOX_CLOSED`). The PWA shows a placeholder. */
    closed: z.enum(INBOX_CLOSED).optional(),
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

// ---- push (S17) ----

const B64U = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** `act` kinds of Web Push; both need the `push` capability. */
export const PUSH_ACTS = ["push.subscribe", "push.unsubscribe"] as const;

/**
 * `push.subscribe`: the browser's `PushSubscription` (`endpoint` and `keys` of its `toJSON()`). It replaces the
 * device's earlier subscription. The bridge accepts only HTTPS endpoints of the known push services.
 */
export const PushSubscribeArgs = z
  .object({
    endpoint: z.string().min(1).max(1024),
    /** `p256dh`: the 65-byte P-256 point, `auth`: the 16-byte secret, both base64url without padding. */
    keys: z.object({ p256dh: B64U.length(87), auth: B64U.length(22) }).strict(),
  })
  .strict();
export type PushSubscribeArgs = z.infer<typeof PushSubscribeArgs>;
/** `push.unsubscribe`: forgets the device's subscription. */
export const PushUnsubscribeArgs = z.object({}).strict();

/** `GET /api/v1/push` for the cookie's device. */
export const PushInfo = z
  .object({
    /** The bridge's VAPID public key (base64url, uncompressed point): `applicationServerKey`. */
    key: B64U.length(87),
    /** The device has the `push` capability now (and remote access is not paused). */
    allowed: z.boolean(),
    /** The bridge holds a subscription for the device. */
    subscribed: z.boolean(),
  })
  .strict();
export type PushInfo = z.infer<typeof PushInfo>;

/**
 * The decrypted body of a push. `title` is the line the phone shows ("Agent 1: Question Title 123"); nothing else
 * from the question, alert or terminal is sent. `url` is a `#/` route of the PWA.
 */
export const PushPayload = z
  .object({
    v: z.literal(1),
    kind: z.enum(["question", "alert", "blocked"]),
    title: z.string().min(1).max(200),
    body: z.string().max(40),
    tag: z.string().regex(/^[a-z0-9-]{1,40}$/),
    url: z.string().regex(/^#\/[A-Za-z0-9_.~%:/-]*$/).max(300),
  })
  .strict();
export type PushPayload = z.infer<typeof PushPayload>;
