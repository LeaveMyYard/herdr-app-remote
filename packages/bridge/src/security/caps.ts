/**
 * Device capabilities (PLAN §2). The bridge checks them for every action; the PWA's own
 * view of them is only a hint.
 */
export const CAPABILITIES = ["view", "inbox.answer", "navigate", "terminal.input", "push"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Caps {
  view: boolean;
  "inbox.answer": boolean;
  navigate: boolean;
  "terminal.input": boolean;
  /** Epoch ms after which `terminal.input` is off again; null means no expiry. */
  "terminal.input.until": number | null;
  push: boolean;
}

/** What a device gets on approval: `view` and `inbox.answer` on, the rest off. */
export function defaultCaps(): Caps {
  return { view: true, "inbox.answer": true, navigate: false, "terminal.input": false, "terminal.input.until": null, push: false };
}

export function hasCap(caps: Caps, cap: Capability, now: number): boolean {
  if (cap === "terminal.input") {
    if (!caps["terminal.input"]) return false;
    const until = caps["terminal.input.until"];
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
  ["inbox.draft", "inbox.answer"],
  ["inbox.answer", "inbox.answer"],
  ["inbox.dismiss", "inbox.answer"],
  ["inbox.ack", "inbox.answer"],
  ["agent.focus", "navigate"],
  ["tab.select", "navigate"],
  ["space.select", "navigate"],
  ["pane.focus", "navigate"],
  ["terminal.send", "terminal.input"],
  ["push.subscribe", "push"],
  ["push.unsubscribe", "push"],
]);
