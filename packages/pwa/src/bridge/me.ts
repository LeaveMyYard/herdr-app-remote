// What this phone may do, from `GET /api/v1/me`. Only a hint for the screens: the bridge checks the capability on
// every `act` (an expired `terminal.input` included), so a stale answer here can only show a composer that gets
// `forbidden`, never send anything the desktop has not allowed.

export interface TerminalInputView {
  /** `terminal.input` is in effect for this device now. */
  enabled: boolean;
  /** When it turns off by itself (epoch ms), or null for no limit. */
  until: number | null;
}

/** Reads the device's `terminal.input` from a `/api/v1/me` body; anything unexpected reads as off. */
export function terminalInputOf(body: unknown): TerminalInputView {
  const device = body !== null && typeof body === "object" ? (body as { device?: unknown }).device : undefined;
  if (device === null || typeof device !== "object") return { enabled: false, until: null };
  const d = device as { caps?: unknown; terminal_input_until?: unknown };
  const caps = d.caps !== null && typeof d.caps === "object" ? (d.caps as Record<string, unknown>) : {};
  const until = typeof d.terminal_input_until === "number" && Number.isFinite(d.terminal_input_until) ? d.terminal_input_until : null;
  return { enabled: caps["terminal.input"] === true, until };
}

/** `GET /api/v1/me`; null when it failed (network, or not 200), so the caller keeps what it had. */
export async function fetchTerminalInput(): Promise<TerminalInputView | null> {
  try {
    const r = await fetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
    if (r.status !== 200) return r.status === 401 || r.status === 403 ? { enabled: false, until: null } : null;
    return terminalInputOf(await r.json());
  } catch {
    return null;
  }
}
