// The line-delimited JSON spoken between the bridge and a Claude reader child (`reader-child.ts`) over stdio.
// One request per line on the child's stdin, one reply per line on its stdout, matched by `id`.

/** Claude Code session ids are UUIDs; nothing else is ever sent to the SDK. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ReaderRequest =
  | { op: "messages"; session: string; dir?: string; limit?: number; offset?: number }
  | { op: "info"; session: string; dir?: string };

export type WireRequest = ReaderRequest & { id: number };

/** `bad_request`: the child refused the line. `failed`: the SDK threw. The message never crosses the pipe. */
export type WireReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: "bad_request" | "failed" };

const MAX_PAGE = 100_000;

const isCount = (v: unknown, max: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Validates a request on either side of the pipe. Returns the request without unknown keys, or null. */
export function checkRequest(v: unknown): WireRequest | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isCount(r.id, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof r.session !== "string" || !SESSION_ID.test(r.session)) return null;
  if (r.dir !== undefined && (typeof r.dir !== "string" || !r.dir.startsWith("/") || r.dir.includes("\0"))) return null;
  const base = { id: r.id as number, session: r.session, ...(r.dir !== undefined ? { dir: r.dir as string } : {}) };
  if (r.op === "info") return { ...base, op: "info" };
  if (r.op !== "messages") return null;
  if (r.limit !== undefined && !isCount(r.limit, MAX_PAGE)) return null;
  if (r.offset !== undefined && !isCount(r.offset, Number.MAX_SAFE_INTEGER)) return null;
  return {
    ...base,
    op: "messages",
    ...(r.limit !== undefined ? { limit: r.limit as number } : {}),
    ...(r.offset !== undefined ? { offset: r.offset as number } : {}),
  };
}
