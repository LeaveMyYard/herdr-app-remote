// What this phone may do, from `GET /api/v1/me`. Only a hint for the screens: the bridge checks the capability on
// every `act` (an expired `terminal.input` or `terminal.keys` included), so a stale answer here can only show a
// composer or a key that gets `forbidden`, never send anything the desktop has not allowed.

export interface CapView {
  /** The capability is in effect for this device now. */
  enabled: boolean;
  /** When it turns off by itself (epoch ms), or null for no limit. */
  until: number | null;
}

export interface TerminalInputView extends CapView {
  /** `terminal.keys` (S16b): the special-keys menu. */
  keys: CapView;
  /** `prompt.answer` (CV7), which also covers Stop (CV8): the chat view's Stop button. Absent reads as off. */
  prompts?: CapView;
}

const OFF: TerminalInputView = { enabled: false, until: null, keys: { enabled: false, until: null }, prompts: { enabled: false, until: null } };

/** Reads the device's `terminal.input`, `terminal.keys` and `prompt.answer` from a `/api/v1/me` body; anything unexpected reads as off. */
export function terminalInputOf(body: unknown): TerminalInputView {
  const device = body !== null && typeof body === "object" ? (body as { device?: unknown }).device : undefined;
  if (device === null || typeof device !== "object") return OFF;
  const d = device as { caps?: unknown; terminal_input_until?: unknown; terminal_keys_until?: unknown; prompt_answer_until?: unknown };
  const caps = d.caps !== null && typeof d.caps === "object" ? (d.caps as Record<string, unknown>) : {};
  const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    enabled: caps["terminal.input"] === true,
    until: time(d.terminal_input_until),
    keys: { enabled: caps["terminal.keys"] === true, until: time(d.terminal_keys_until) },
    prompts: { enabled: caps["prompt.answer"] === true, until: time(d.prompt_answer_until) },
  };
}

/** `GET /api/v1/me`; null when it failed (network, or not 200), so the caller keeps what it had. */
export async function fetchTerminalInput(): Promise<TerminalInputView | null> {
  try {
    const r = await fetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
    if (r.status !== 200) return r.status === 401 || r.status === 403 ? OFF : null;
    return terminalInputOf(await r.json());
  } catch {
    return null;
  }
}
