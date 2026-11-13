/**
 * Device capabilities (PLAN §2). The bridge checks them for every action; the PWA's own
 * view of them is only a hint.
 */
import { bridgeApi } from "@herdr-remote/protocol";

export const CAPABILITIES = ["view", "inbox.answer", "navigate", "terminal.input", "terminal.keys", "push", "transcript.read", "prompt.answer"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The capabilities a desktop grant can give a time limit to; each has its own `<cap>.until` in {@link Caps}. */
export const EXPIRING = ["terminal.input", "terminal.keys", "prompt.answer"] as const;
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
  /**
   * Chat history (CV1, docs/chatview.md §5.1): reading agents' conversations (`chatview:<t>`, `timeline:<t>`, the
   * chat history pages). Separate from `view`, which shows only the screen; off by default, no expiry.
   */
  "transcript.read": boolean;
  /**
   * Answer prompts (CV7, docs/chatview.md §5.1): `prompt.answer` and CV8's `agent.stop`. Off by default, desktop
   * only, with an expiry like `terminal.keys`. Separate from `terminal.input` and `terminal.keys`: approving a
   * command is a stronger act than typing, and the phone never chooses keys (the bridge derives them from a
   * verified screen).
   */
  "prompt.answer": boolean;
  /** Epoch ms after which `prompt.answer` is off again; null means no expiry. */
  "prompt.answer.until": number | null;
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
    "transcript.read": false,
    "prompt.answer": false,
    "prompt.answer.until": null,
  };
}

/** The `until` field of an expiring capability. */
export function untilKey(cap: ExpiringCapability): `${ExpiringCapability}.until` {
  return `${cap}.until`;
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
  // CV7: a native prompt's answer, pressed by the bridge from a verified screen (docs/chatview.md §3a).
  ["prompt.answer", "prompt.answer"],
  // CV8: Stop presses Esc once in a working agent; the same switch as answering (docs/chatview.md §5.1).
  ["agent.stop", "prompt.answer"],
  ["push.subscribe", "push"],
  ["push.unsubscribe", "push"],
  // S5b: a one-time code that moves this (approved) device into its Home Screen app. Answered by Security itself.
  ["pair.transfer", "view"],
]);

/**
 * The topic guard (CV1): the capabilities a topic needs on top of `view` (which holding the socket already needs).
 * `chatview:<t>` and `timeline:<t>` carry agents' conversations, so they also need `transcript.read`; every other
 * topic needs nothing more. The prefixes come from the protocol, so a topic the PWA names and the one checked here
 * can't drift apart.
 */
export function topicCaps(topic: string): readonly Capability[] {
  return bridgeApi.isTranscriptTopic(topic) ? TRANSCRIPT_CAPS : NO_CAPS;
}
const TRANSCRIPT_CAPS: readonly Capability[] = Object.freeze(["transcript.read"]);
const NO_CAPS: readonly Capability[] = Object.freeze([]);
