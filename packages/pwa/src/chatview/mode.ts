import { useEffect, useState } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import type { NoticeKind } from "./words";

/** Which view an agent's screen is in (§6). */
export type ViewMode = { kind: "pending" } | { kind: "chat" } | { kind: "text"; notice: NoticeKind | null };

/** Waiting this long for the first `chatview` value, with no reason, is the reader not answering. */
export const VIEW_WAIT_MS = 10_000;

export function isClaude(agent: { program?: string | undefined; harness: string }): boolean {
  return (agent.program ?? agent.harness) === "claude";
}

export function chatMode(a: { claude: boolean; harnessId: string; topic: bridgeApi.ChatviewTopic | undefined; stale: string | null; waitedOut?: boolean }): ViewMode {
  if (!a.claude) return { kind: "text", notice: a.harnessId === "codex" ? "codex" : null };
  // Capability off: the held history goes with it (the topic keeps its last value under `stale`).
  if (a.stale === "forbidden") return { kind: "text", notice: "forbidden" };
  if (a.topic?.state === "unavailable") {
    const r = a.topic.reason;
    if (r === "harness") return { kind: "text", notice: a.topic.harness === "codex" ? "codex" : null };
    return { kind: "text", notice: r ?? "reader_failed" };
  }
  if (a.topic) return { kind: "chat" };
  // A reason with no value yet (audit_unavailable, source trouble): the reader can't serve this now.
  if (a.stale !== null || a.waitedOut) return { kind: "text", notice: "reader_failed" };
  return { kind: "pending" };
}

/** True once `ms` has passed with the same `key`. */
export function useWaited(key: string, ms: number, active: boolean): boolean {
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setDone(key), ms);
    return () => clearTimeout(t);
  }, [key, ms, active]);
  return active && done === key;
}
