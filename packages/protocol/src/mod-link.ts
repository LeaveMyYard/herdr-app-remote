import { z } from "zod";
import { SetupTopic } from "./bridge-api.js";
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

// ---- panel (the desktop Remote panel, copy "panel" only) ----

/** The capabilities the panel can switch (all seven; `view` and the rest are desktop-only decisions). */
export const PanelCap = z.enum(["view", "inbox.answer", "navigate", "terminal.input", "terminal.keys", "push", "transcript.read"]);
/** The capabilities a grant can give a time limit to (`minutes`). */
export const EXPIRING_CAPS: readonly PanelCap[] = ["terminal.input", "terminal.keys"];
export type PanelCap = z.infer<typeof PanelCap>;

const DeviceId = z.string().regex(/^d-[0-9a-f]{16}$/);

/**
 * What the panel may ask the bridge to do: the desktop-only operations of the security layer, nothing else
 * (no `run`, no exec). Exactly these kinds with exactly these argument shapes; extra keys are refused. A
 * `panel_act` from the `link` copy is dropped. `minutes` (1 to 10080) is how long `terminal.input` or `terminal.keys` stays on;
 * the bridge turns it into an expiry on its own clock, so none means no expiry.
 */
export const PANEL_ACT_ARGS = {
  "device.approve": z.object({ id: DeviceId }).strict(),
  /** Refuses a pending request or revokes an approved device. */
  "device.revoke": z.object({ id: DeviceId }).strict(),
  "device.cap": z
    .object({ id: DeviceId, cap: PanelCap, on: z.boolean(), minutes: z.number().int().min(1).max(10_080).optional() })
    .strict()
    .refine((a) => a.minutes === undefined || (EXPIRING_CAPS.includes(a.cap) && a.on), { message: "minutes only applies when turning terminal.input or terminal.keys on" }),
  "remote.pause": z.object({}).strict(),
  "remote.resume": z.object({}).strict(),
  /** Shows a fresh pairing code (QR) for adding a phone. */
  "pair.code": z.object({}).strict(),
  /** Hides the pairing code from the panel (the code itself stays valid until it expires or is used). */
  "pair.hide": z.object({}).strict(),
  /**
   * Tailscale setup (S14b): "Check now", "Start serving" and "Stop serving". No arguments at all: the port,
   * the target and every command line are the bridge's own, and the operator-permission fix is only ever
   * shown (`problem.fix`), never run.
   */
  "setup.check": z.object({}).strict(),
  "setup.start": z.object({}).strict(),
  "setup.stop": z.object({}).strict(),
} as const;
export type PanelActName = keyof typeof PANEL_ACT_ARGS;

export const PanelAct = z
  .object({
    type: z.literal("panel_act"),
    id: z.string().min(1).max(128),
    kind: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PanelAct = z.infer<typeof PanelAct>;

/** Why the bridge refused a panel act before doing anything. */
export type PanelActRefusal = "unsupported_action" | "bad_args";

export function checkPanelAct(
  kind: unknown,
  args: unknown,
): { ok: true; kind: PanelActName; args: Record<string, unknown> } | { ok: false; error: PanelActRefusal } {
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(PANEL_ACT_ARGS, kind)) {
    return { ok: false, error: "unsupported_action" };
  }
  const parsed = PANEL_ACT_ARGS[kind as PanelActName].safeParse(args);
  return parsed.success ? { ok: true, kind: kind as PanelActName, args: parsed.data as Record<string, unknown> } : { ok: false, error: "bad_args" };
}

export const ModToBridge = z.union([Hello, State, Result, Pong, PanelAct]);
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
  /** `open_panel`: clicking the toast shows the Remote panel (the mod's own local `open` command). */
  action: z.literal("open_panel").optional(),
});
export type Notify = z.infer<typeof Notify>;

export const Ping = z.object({ type: z.literal("ping") });
export type Ping = z.infer<typeof Ping>;

// ---- panel view (bridge -> the panel copy) ----

const Short = (max: number) => z.string().max(max);
const Epoch = z.number().int().nonnegative();

export const PanelCheck = z
  .object({
    id: z.string().min(1).max(32),
    label: Short(80),
    detail: Short(160),
    /** `ok` a green check, `warn` amber, `bad` red, `off` neutral (not done yet). */
    state: z.enum(["ok", "warn", "bad", "off"]),
  })
  .strict();
export type PanelCheck = z.infer<typeof PanelCheck>;

export const PanelDevice = z
  .object({
    id: DeviceId,
    name: Short(32),
    login: Short(120),
    state: z.enum(["pending", "approved"]),
    /** Effective capabilities right now (an expired `terminal.input` or `terminal.keys` reads false). */
    caps: z
      .object({
        view: z.boolean(),
        "inbox.answer": z.boolean(),
        navigate: z.boolean(),
        "terminal.input": z.boolean(),
        /** S16b; optional so a panel view from an older bridge still reads (as off). */
        "terminal.keys": z.boolean().optional(),
        push: z.boolean(),
        /** CV1 (chat history); optional so a panel view from an older bridge still reads (as off). */
        "transcript.read": z.boolean().optional(),
      })
      .strict(),
    terminal_input_until: Epoch.nullable(),
    terminal_keys_until: Epoch.nullable().optional(),
    created_at: Epoch,
    last_seen: Epoch.nullable(),
    /** Open connections right now. */
    live: z.number().int().nonnegative(),
  })
  .strict();
export type PanelDevice = z.infer<typeof PanelDevice>;

export const PanelPlugin = z
  .object({
    id: z.string().min(1).max(32),
    name: Short(40),
    state: z.enum(["ready", "missing", "too_old", "broken", "stale", "not_running"]),
    /** The phone tabs it powers, e.g. "Agents (rich), Swarm, Peek". */
    powers: Short(120),
    detail: Short(160).optional(),
  })
  .strict();
export type PanelPlugin = z.infer<typeof PanelPlugin>;

export const PanelActivity = z.object({ ts: Epoch, text: Short(200) }).strict();
export type PanelActivity = z.infer<typeof PanelActivity>;

/** A pairing code on screen: the URL to copy and the QR as rows of "0"/"1" modules (dark = 1, quiet zone included). */
export const PanelPairing = z
  .object({ url: Short(300), expires_at: Epoch, qr: z.array(z.string().regex(/^[01]{1,200}$/)).min(1).max(200) })
  .strict();
export type PanelPairing = z.infer<typeof PanelPairing>;

/**
 * Everything the Remote panel shows (a full snapshot each time). Text fields are bounded and the mod draws
 * them as text only. No tokens, cookies or token hashes are ever in it.
 */
export const PanelView = z
  .object({
    /** The header badge: `serving`, `paused`, `setup` (not serving yet) or `blocked` (Funnel on). */
    status: z.enum(["serving", "paused", "setup", "blocked"]),
    /** `https://<serve host>`: what the phone opens; null until serve is set up. */
    url: Short(300).nullable(),
    checks: z.array(PanelCheck).max(16),
    devices: z.array(PanelDevice).max(64),
    plugins: z.array(PanelPlugin).max(16),
    /** Newest first. */
    activity: z.array(PanelActivity).max(100),
    pairing: PanelPairing.nullable(),
    /**
     * The Tailscale setup state (the `setup` topic's payload), drawn as the Setup view (design/DesktopSetup)
     * while `status` is `setup`; null when this bridge runs no setup (a fixed serve identity).
     */
    setup: SetupTopic.nullable(),
  })
  .strict();
export type PanelView = z.infer<typeof PanelView>;

export const Panel = z.object({ type: z.literal("panel"), seq: z.number().int().nonnegative(), view: PanelView }).strict();
export type Panel = z.infer<typeof Panel>;

/** Answer to a `panel_act` with the same `id`; `code` is set when `ok` is false. */
export const PanelRes = z
  .object({ type: z.literal("panel_res"), id: z.string().min(1).max(128), ok: z.boolean(), code: Short(40).optional() })
  .strict();
export type PanelRes = z.infer<typeof PanelRes>;

export const BridgeToMod = z.discriminatedUnion("type", [Run, Notify, Ping, Panel, PanelRes]);
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
export function checkRun(
  name: unknown,
  args: unknown,
): { ok: true; name: RunName; args: Record<string, unknown> } | { ok: false; error: RunRefusal } {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(RUN_ARGS, name)) {
    return { ok: false, error: "not_allowed" };
  }
  const parsed = RUN_ARGS[name as RunName].safeParse(args);
  // `args` is the parsed copy: send that, never the caller's object (a getter or toJSON could differ).
  return parsed.success ? { ok: true, name: name as RunName, args: parsed.data } : { ok: false, error: "bad_args" };
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
