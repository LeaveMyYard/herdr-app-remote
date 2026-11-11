import { z } from "zod";
import { HostState } from "./host.js";

export const MOD_LINK_VERSION = 1 as const;

/** `link` is the 1px block in the always-shown column; `panel` is the Remote panel copy. */
export const ModCopy = z.enum(["link", "panel"]);
export type ModCopy = z.infer<typeof ModCopy>;

// ---- mod -> bridge ----

export const Hello = z.object({
  type: z.literal("hello"),
  v: z.literal(MOD_LINK_VERSION),
  token: z.string().min(1),
  copy: ModCopy,
  layout: z.string().min(1),
  app: z.object({ version: z.string().min(1) }),
});
export type Hello = z.infer<typeof Hello>;

export const State = z.object({
  type: z.literal("state"),
  seq: z.number().int().nonnegative(),
  host: HostState,
});
export type State = z.infer<typeof State>;

export const Result = z
  .object({
    type: z.literal("result"),
    id: z.string().min(1),
    ok: z.boolean(),
    error: z.string().optional(),
  })
  .refine((r) => !r.ok || r.error === undefined, { message: "error is only valid when ok is false", path: ["error"] });
export type Result = z.infer<typeof Result>;

/** Reply to `ping`. */
export const Pong = z.object({ type: z.literal("pong") });
export type Pong = z.infer<typeof Pong>;

export const ModToBridge = z.union([Hello, State, Result, Pong]);
export type ModToBridge = z.infer<typeof ModToBridge>;

// ---- bridge -> mod ----

/** `name` must be in the allowlist, which the mod checks again itself (defined in S2). */
export const Run = z.object({
  type: z.literal("run"),
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});
export type Run = z.infer<typeof Run>;

export const Notify = z.object({
  type: z.literal("notify"),
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
});
export type Notify = z.infer<typeof Notify>;

export const Ping = z.object({ type: z.literal("ping") });
export type Ping = z.infer<typeof Ping>;

export const BridgeToMod = z.discriminatedUnion("type", [Run, Notify, Ping]);
export type BridgeToMod = z.infer<typeof BridgeToMod>;

/** Reconnect backoff bounds for the mod, in milliseconds. */
export const RECONNECT_BACKOFF_MS = { min: 500, max: 10_000 } as const;
/** `state` is deduplicated by content hash and sent at most once per this many ms. */
export const STATE_MIN_INTERVAL_MS = 100;

/**
 * Parse one NDJSON line. Returns the zod result so callers can decide what to do on bad input.
 */
export function parseLine<T extends z.ZodTypeAny>(schema: T, line: string): z.SafeParseReturnType<unknown, z.infer<T>> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (e) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: `invalid JSON: ${(e as Error).message}` }]),
    };
  }
  return schema.safeParse(json);
}
