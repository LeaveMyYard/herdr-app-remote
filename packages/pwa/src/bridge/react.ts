import { useEffect, useSyncExternalStore } from "react";
import type { BridgeClient, ClientSnapshot } from "./client";

/** The client's state; re-renders on every snap, patch, stale and status change. */
export function useBridge(client: BridgeClient): ClientSnapshot {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

/** Wants `topics` while mounted (and while `enabled`). */
export function useTopics(client: BridgeClient, topics: readonly string[], enabled = true): void {
  const key = topics.join("\n");
  useEffect(() => {
    if (!enabled || key === "") return;
    const release = key.split("\n").map((t) => client.want(t));
    return () => release.forEach((r) => r());
  }, [client, key, enabled]);
}
