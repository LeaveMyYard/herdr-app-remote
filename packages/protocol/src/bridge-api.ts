import { z } from "zod";
import { HostState } from "./host.js";

export const API_VERSION = 1 as const;

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
    const payload = TOPIC_PAYLOADS[m.topic];
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
export const STALE_REASONS = ["reconnecting", "layout_without_remote", "source_unavailable"] as const;
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
