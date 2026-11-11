import type { Code } from "../components/StateMarks";

/** "<1m", "5m", "3h", "2d"; empty when the time is unknown. `now` and `t` are POSIX seconds. */
export function age(t: number | null | undefined, now: number): string {
  if (t === null || t === undefined) return "";
  const s = Math.max(0, now - t);
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The lowercase status word the design shows when a node has no activity text. */
export function statusWord(code: Code): string {
  switch (code) {
    case "run":
      return "running";
    case "rev":
      return "reviewing";
    case "wait":
      return "waiting";
    case "blk":
      return "blocked";
    case "fail":
      return "failed";
    case "done":
    case "inf":
      return "finished";
    case "cxl":
      return "cancelled";
    case "lost":
      return "lost";
    case "bg":
      return "background";
    case "q":
      return "queued";
    case "stale":
      return "stale";
    case "idle":
      return "idle";
    case "unknown":
      return "unknown";
  }
}
