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

/** `name` must be in {@link RUN_ALLOWLIST} with args matching {@link RUN_ARGS}; the mod checks both again itself. */
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

// ---- run allowlist ----

/**
 * Ids as herdr-app reports them (`t3`, `space-1`, remote ones `machine/t3`). Bounded and free of
 * whitespace and control characters, so nothing odd reaches `run()`.
 */
export const RunId = z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/);
/** A 1-based position in a list. */
export const RunIndex = z.number().int().min(1).max(10_000);

/**
 * The only commands the bridge may ask the link mod to run (the `navigate` capability), with
 * the exact argument shapes each accepts. Extra keys are refused. The mod carries its own copy
 * (`mod/herdr-app-remote/allowlist.js`); a parity test keeps the two equal.
 */
export const RUN_ARGS = {
  "agent.focus": z.object({ terminal: RunId }).strict(),
  "pane.focus": z.union([z.object({ pane: RunId }).strict(), z.object({ terminal: RunId }).strict()]),
  "space.select": z.union([z.object({ id: RunId }).strict(), z.object({ index: RunIndex }).strict()]),
  "tab.select": z.union([z.object({ id: RunId }).strict(), z.object({ index: RunIndex }).strict()]),
} as const;
export type RunName = keyof typeof RUN_ARGS;
export const RUN_ALLOWLIST = Object.keys(RUN_ARGS).sort() as RunName[];

/** Why a run was refused before anything ran. The mod answers with the same codes. */
export type RunRefusal = "not_allowed" | "bad_args";

/** Checks a run request against the allowlist. Nothing is run when this fails. */
export function checkRun(name: unknown, args: unknown): { ok: true; name: RunName } | { ok: false; error: RunRefusal } {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(RUN_ARGS, name)) {
    return { ok: false, error: "not_allowed" };
  }
  const schema = RUN_ARGS[name as RunName];
  return schema.safeParse(args).success ? { ok: true, name: name as RunName } : { ok: false, error: "bad_args" };
}

// ---- runtime file ----

/** Where the bridge advertises the link port and token, relative to the app home. */
export const RUNTIME_RELATIVE_PATH = "data/herdr-app-remote/runtime.json";

/** `runtime.json` (0600): written by the bridge, read by the mod before each connect. */
export const Runtime = z.object({
  v: z.literal(1),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32).max(256),
  pid: z.number().int().positive(),
  bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type Runtime = z.infer<typeof Runtime>;

/** Message limits on the link, in bytes of one NDJSON line. */
export const LINE_LIMITS = {
  /** Before a valid `hello` (the bridge drops a peer that sends more without one). */
  preHello: 16 * 1024,
  /** Mod to bridge after `hello` (a full `state`). */
  modToBridge: 8 * 1024 * 1024,
  /** Bridge to mod. */
  bridgeToMod: 1024 * 1024,
} as const;

/**
 * Serialises one message as an NDJSON line that is pure ASCII (non-ASCII is `\uXXXX`-escaped),
 * so the mod can split and decode lines byte-wise without a streaming UTF-8 decoder.
 */
export function encodeLine(message: unknown): string {
  return JSON.stringify(message).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
}

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
