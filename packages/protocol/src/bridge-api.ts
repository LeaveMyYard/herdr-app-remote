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
  resume: z.object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() }).optional(),
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

export const Welcome = z.object({
  type: z.literal("welcome"),
  api: z.literal(API_VERSION),
  bridge: z.string().min(1),
  /** Random per bridge start; an unknown epoch gets a fresh `snap`. */
  epoch: z.string().min(1),
});

export const Snap = z.object({
  type: z.literal("snap"),
  topic: Topic,
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  data: z.unknown(),
});

/** RFC 6902 JSON Patch operation. */
export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string() }),
  z.object({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("move"), from: z.string(), path: z.string() }),
  z.object({ op: z.literal("copy"), from: z.string(), path: z.string() }),
  z.object({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
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

export const Res = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.boolean(),
  code: z.string().min(1).optional(),
  /** Non-zero exit outside the contract, or bad stdout: the PWA says so, refreshes and never retries. */
  unknown_effect: z.boolean().optional(),
});

export const Event = z.object({
  type: z.literal("event"),
  topic: Topic,
  name: z.string().min(1),
  data: z.unknown(),
});

export const Pong = z.object({ type: z.literal("pong") });

export const ServerMessage = z.discriminatedUnion("type", [Welcome, Snap, Patch, Stale, Res, Event, Pong]);
export type ServerMessage = z.infer<typeof ServerMessage>;

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

export type Welcome = z.infer<typeof Welcome>;
export type Snap = z.infer<typeof Snap>;
export type Patch = z.infer<typeof Patch>;
export type Stale = z.infer<typeof Stale>;
export type Res = z.infer<typeof Res>;
export type Event = z.infer<typeof Event>;
