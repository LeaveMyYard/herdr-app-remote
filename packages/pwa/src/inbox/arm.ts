import { useEffect, useRef, useState } from "react";

/**
 * herdr-inbox's own arm delays (app/mods/herdr-inbox/model/data.js), applied to taps:
 * - a view ignores its action buttons this long after it appears (`VIEW_ARM`);
 * - a row that arrived takes no tap this long (`ROW_ARM`), so a list that moves under a finger can't take it.
 * - after a change the operator did not cause (the row moved, a refusal came back), taps are dropped `GRACE` long.
 * The values are the plugin's; `test/question.test.tsx` compares them with a sibling checkout when there is one.
 */
export const VIEW_ARM_MS = 400;
export const ROW_ARM_MS = 1000;
export const GRACE_MS = 500;

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Armed `ms` after mount, and again `changeMs` (default `ms`) after `key` changes (the content under the finger
 * changed). Returns a check made at tap time, so a tap that lands early is dropped even before a re-render.
 */
export function useArmed(ms: number, key?: unknown, changeMs = ms): () => boolean {
  const at = useRef(clock() + ms);
  const [, bump] = useState(0);
  const last = useRef(key);
  if (last.current !== key) {
    last.current = key;
    at.current = clock() + changeMs;
  }
  useEffect(() => {
    const t = setTimeout(() => bump((n) => n + 1), Math.max(at.current - clock(), 0));
    return () => clearTimeout(t);
  }, [key]);
  return () => clock() >= at.current;
}

/** When each row key was first seen while this list was shown; rows of the first render count as old. */
export function useArrivals(keys: readonly string[]): (key: string) => boolean {
  const seen = useRef<Map<string, number> | null>(null);
  if (seen.current === null) seen.current = new Map(keys.map((k) => [k, -Infinity]));
  for (const k of keys) if (!seen.current.has(k)) seen.current.set(k, clock());
  return (key) => clock() >= (seen.current?.get(key) ?? -Infinity) + ROW_ARM_MS;
}
