/**
 * Device capabilities (PLAN §2). The bridge checks them for every action; the PWA's own
 * view of them is only a hint.
 */
export const CAPABILITIES = ["view", "inbox.answer", "navigate", "terminal.input", "terminal.keys", "push"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The capabilities a desktop grant can give a time limit to; each has its own `<cap>.until` in {@link Caps}. */
export const EXPIRING = ["terminal.input", "terminal.keys"] as const;
export type ExpiringCapability = (typeof EXPIRING)[number];

export function isExpiring(cap: Capability): cap is ExpiringCapability {
  return (EXPIRING as readonly string[]).includes(cap);
}

export interface Caps {
  view: boolean;
  "inbox.answer": boolean;
  navigate: boolean;
  "terminal.input": boolean;
  /** Epoch ms after which `terminal.input` is off again; null means no expiry. */
  "terminal.input.until": number | null;
  /** The special-keys menu (S16b): separate from `terminal.input`, so typing text never implies pressing Ctrl-C. */
  "terminal.keys": boolean;
  /** Epoch ms after which `terminal.keys` is off again; null means no expiry. */
  "terminal.keys.until": number | null;
  push: boolean;
}

/** What a device gets on approval: `view` and `inbox.answer` on, the rest off. */
export function defaultCaps(): Caps {
  return {
    view: true,
    "inbox.answer": true,
    navigate: false,
    "terminal.input": false,
    "terminal.input.until": null,
    "terminal.keys": false,
    "terminal.keys.until": null,
    push: false,
  };
}

/** The `until` field of an expiring capability. */
export function untilKey(cap: ExpiringCapability): "terminal.input.until" | "terminal.keys.until" {
  return cap === "terminal.input" ? "terminal.input.until" : "terminal.keys.until";
}

export function hasCap(caps: Caps, cap: Capability, now: number): boolean {
  if (isExpiring(cap)) {
    if (!caps[cap]) return false;
    const until = caps[untilKey(cap)];
    return until === null || now < until;
  }
  return caps[cap];
}

/**
 * The complete action allowlist: each `act` kind and the one capability it needs.
 * Anything not listed is refused and logged. There is no generic `run`, `exec` or
 * `herdr-app do`. A Map, so names like `__proto__` or `constructor` can't match.
 */
export const ACTION_CAPS: ReadonlyMap<string, Capability> = new Map<string, Capability>([
  // Read-side requests of the usage topic: they run the same collect the subscription polls, nothing else.
  ["usage.refresh", "view"],
  ["usage.set_filter", "view"],
  ["inbox.draft", "inbox.answer"],
  ["inbox.answer", "inbox.answer"],
  ["inbox.dismiss", "inbox.answer"],
  ["inbox.ack", "inbox.answer"],
  // A `failed` row's two verbs (S11): they act on an answer the operator already gave, like the four above.
  ["inbox.retry", "inbox.answer"],
  ["inbox.stop_showing", "inbox.answer"],
  ["agent.focus", "navigate"],
  ["tab.select", "navigate"],
  ["space.select", "navigate"],
  ["pane.focus", "navigate"],
  ["terminal.send", "terminal.input"],
  ["terminal.keys", "terminal.keys"],
  ["push.subscribe", "push"],
  ["push.unsubscribe", "push"],
  // S5b: a one-time code that moves this (approved) device into its Home Screen app. Answered by Security itself.
  ["pair.transfer", "view"],
]);
