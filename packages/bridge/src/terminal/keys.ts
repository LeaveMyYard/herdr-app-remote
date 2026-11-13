// `terminal.keys` (S16b): presses one entry of the desktop's key menu in a terminal. It runs `hc keys` with the
// tokens the desktop's `keys.json` (or the default menu) gives that entry, and nothing else: the phone sends an
// entry id and the menu revision it was shown, never key names. No `exec`, no `run`, no `hc send`.
//
// Capability (`terminal.keys`, with its expiry), the rate limits and the audit line are `Security.act`'s; this actor
// only checks the arguments, resolves the entry, keeps one press in flight per device, and reads hc's answer.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActResult } from "../hub.js";
import type { Actor } from "../app/act.js";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import type { Runner, RunResult } from "../plugins/exec.js";
import { InFlight, readHc } from "./hc-act.js";
import type { KeysMenu } from "./keys-config.js";

export const TERMINAL_KEYS = "terminal.keys";
/** `hc keys` follows the same quiet rule as `hc send` (it waits for typing at the desktop to pause). */
export const KEYS_TIMEOUT_MS = 15_000;

export interface TerminalKeysOptions {
  run: Runner;
  menu: KeysMenu;
  binaries?: Binaries;
  timeoutMs?: number;
  /** A prompt answer runs in this terminal (CV7): no key is pressed into it meanwhile (`busy`). */
  busy?: (terminal: string) => boolean;
}

/** The argv for one press. `--` ends hc's options; every token already passed {@link bridgeApi.isKeyToken}. */
export function keysArgs(terminal: string, keys: readonly string[]): string[] {
  return ["keys", "--json", "--", terminal, ...keys];
}

/**
 * hc's error kinds that are refusals before any key was pressed. `terminal.keys` errors per `hc schema` (hc 0.1.19)
 * are `not_found`, `machine_unknown`, `finished`, `unavailable` and `invalid_params`; the CLI adds `usage` and
 * `needs_target`. The rig showed `invalid_params` (an unknown key name) checks every key before pressing any:
 * `left bogus` pressed nothing. `unavailable` stays an unknown effect: the schema doesn't say when it happens.
 */
const REFUSED: Readonly<Record<string, string>> = {
  not_found: "terminal_not_found",
  machine_unknown: "terminal_not_found",
  needs_target: "terminal_not_found",
  finished: "terminal_finished",
  // Not listed for keys by `hc schema` 0.1.19, but `hc send` refuses with it while the program is on a dialog; if
  // keys ever does too, it is a refusal (nothing pressed), not an unknown effect.
  blocked: "terminal_blocked",
  invalid_params: "keys_refused",
  usage: "keys_refused",
};

/** What one `hc keys` came to (see {@link readHc}). */
export function readKeys(r: RunResult): ActResult {
  return readHc(r, REFUSED, "keys_failed");
}

/** The Activity name of an entry: its id and how many keys it presses (never a label, never the key names). */
export function keysAuditLabel(id: string, count: number): string {
  return `${id} (${count} ${count === 1 ? "key" : "keys"})`;
}

export interface TerminalKeysActor extends Actor {
  /** Kills the `hc keys` in flight for a device (every device with no id): it lost `terminal.keys`. */
  cancel(deviceId?: string): void;
}

/**
 * The actor for `terminal.keys`. The entry is looked up in the menu in force now; a press from a menu whose `rev`
 * has changed is refused (`keys_changed`), so an edited `keys.json` can never make an old button press new keys.
 * A second press from the same device while one runs is `busy`.
 */
export function terminalKeysActor(o: TerminalKeysOptions): TerminalKeysActor {
  const inFlight = new InFlight();
  const actor = async (client: Parameters<Actor>[0], kind: string, args: Record<string, unknown>): Promise<ActResult | undefined> => {
    if (kind !== TERMINAL_KEYS) return undefined;
    const parsed = bridgeApi.TerminalKeysArgs.safeParse(args);
    if (!parsed.success) return { ok: false, code: "bad_args" };
    const { terminal, key, rev } = parsed.data;
    if (o.busy?.(terminal)) return { ok: false, code: "busy" };
    const menu = o.menu.current();
    if (menu.rev !== rev) return { ok: false, code: "keys_changed" };
    const entry = menu.keys.find((e) => e.id === key);
    if (!entry) return { ok: false, code: "unknown_key" };
    const audit_label = keysAuditLabel(entry.id, entry.keys.length);
    // The menu was validated when it was loaded; checked again here, right before the argv is built.
    if (entry.keys.length < 1 || entry.keys.length > bridgeApi.KEYS_MAX_PER_ENTRY || !entry.keys.every(bridgeApi.isKeyToken)) {
      return { ok: false, code: "keys_refused", audit_label };
    }
    const bin = (o.binaries ?? DEFAULT_BINARIES).hc;
    const r = await inFlight.run(client.principal?.deviceId ?? "", (signal) => o.run(bin, keysArgs(terminal, entry.keys), { timeoutMs: o.timeoutMs ?? KEYS_TIMEOUT_MS, signal }));
    return r === undefined ? { ok: false, code: "busy", audit_label } : { ...readKeys(r), audit_label };
  };
  return Object.assign(actor, { cancel: (deviceId?: string) => inFlight.cancel(deviceId) });
}
