import type { bridgeApi } from "@herdr-remote/protocol";

type Item = bridgeApi.ChatItem;

/** What the screen holds: the topic's newest window plus older pages fetched before it. */
export interface Held {
  rev: string;
  items: Item[];
  /** Items older than `items[0]` exist. */
  older: boolean;
  /** The topic the state last followed (identity), so a re-render does not merge twice. */
  src: bridgeApi.ChatviewTopic;
}

export function initHeld(topic: bridgeApi.ChatviewTopic): Held {
  return { rev: topic.rev, items: topic.items, older: topic.older, src: topic };
}

/**
 * A new topic value. The window slides (its first id may have left it), so what is held before the window's first
 * item is kept, and the topic's own items win from there on. A new `rev` or a window that joins nothing held
 * starts over: older pages from another history are dropped.
 */
export function applyTopic(held: Held, topic: bridgeApi.ChatviewTopic): Held {
  if (held.src === topic) return held;
  const first = topic.items[0];
  if (topic.rev !== held.rev || first === undefined) return initHeld(topic);
  const at = held.items.findIndex((i) => i.id === first.id);
  if (at < 0) return initHeld(topic);
  const kept = held.items.slice(0, at);
  return { rev: topic.rev, items: kept.concat(topic.items), older: at > 0 ? held.older : topic.older, src: topic };
}

/** An older page arrived for `before` at `rev`; ignored when the screen has moved on. */
export function prepend(held: Held, page: { items: Item[]; older: boolean; rev: string }, before: string): Held {
  if (page.rev !== held.rev || held.items[0]?.id !== before) return held;
  const have = new Set(held.items.map((i) => i.id));
  return { ...held, items: page.items.filter((i) => !have.has(i.id)).concat(held.items), older: page.older };
}
