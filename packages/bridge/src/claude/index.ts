// The Claude history reader for the chat view (docs/chatview.md §2.2): the typed API the `chatview:<t>`
// topic (CV3) uses. It lists roots from agent-usage only, chooses the root holding a panorama-proved session,
// and reads that session through the root's reader child. It never opens a transcript itself: the only file
// operation on `transcript` is a realpath of its grandparent (the `projects` dir) to pick the root.
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { checkMessages, type ClaudeMessage, type ReadStats } from "./messages.js";
import { ReaderPool, type ReaderError, type ReaderPoolOptions } from "./pool.js";
import { discoverRoots, type ClaudeRoot, type DiscoverOptions, type NoProfilesDetail } from "./profiles.js";
import { SESSION_ID } from "./wire.js";

export * from "./messages.js";
export * from "./pool.js";
export * from "./profiles.js";
export { SESSION_ID, checkRequest, type ReaderRequest, type WireReply, type WireRequest } from "./wire.js";

/** What panorama proved about a pane's session (feed v2 root, §2.1). */
export interface ProvedSession {
  sessionId: string;
  /** `root.transcript`: the absolute path of the main JSONL. Used only to pick a root. */
  transcript: string | null;
  /** `root.cwd`, for the `getSessionInfo(id, {dir: cwd})` fallback. */
  cwd: string | null;
}

/** A session bound to the root whose reader can read it. */
export interface Binding {
  sessionId: string;
  root: ClaudeRoot;
  /** `transcript`: the projects dir matched. `info`: a reader's getSessionInfo found it. */
  via: "transcript" | "info";
}

/** The §6/§7 reasons this module can give. CV3 maps them onto `chatview:<t>` `reason`. */
export type BindResult =
  | { ok: true; binding: Binding }
  | { ok: false; reason: "no_profiles"; detail: NoProfilesDetail }
  | { ok: false; reason: "no_binding" }
  | { ok: false; reason: "reader_failed"; detail: ReaderError };

export type ReadResult =
  | { ok: true; messages: ClaudeMessage[]; stats: ReadStats }
  | { ok: false; reason: "reader_failed"; detail: ReaderError | "shape"; stats?: ReadStats };

export interface ReadOptions {
  limit?: number;
  offset?: number;
}

export interface ClaudeHistoryOptions extends DiscoverOptions {
  /** The pool, or its options (then the history owns it and `close` stops it). */
  pool: ReaderPool | ReaderPoolOptions;
}

/** Picks the root for a session: the transcript's projects dir first, then each root's getSessionInfo. */
export async function chooseRoot(roots: ClaudeRoot[], pool: Pick<ReaderPool, "call">, s: ProvedSession): Promise<BindResult> {
  if (!SESSION_ID.test(s.sessionId)) return { ok: false, reason: "no_binding" };
  if (s.transcript && isAbsolute(s.transcript)) {
    let projects: string | undefined;
    try {
      projects = await realpath(dirname(dirname(s.transcript)));
    } catch {
      projects = undefined;
    }
    const hit = projects !== undefined ? roots.find((r) => r.projects === projects) : undefined;
    if (hit) return { ok: true, binding: { sessionId: s.sessionId, root: hit, via: "transcript" } };
  }
  if (!s.cwd || !isAbsolute(s.cwd)) return { ok: false, reason: "no_binding" };
  let failure: ReaderError | undefined;
  for (const root of roots) {
    const r = await pool.call(root, { op: "info", session: s.sessionId, dir: s.cwd });
    if (!r.ok) {
      failure ??= r.error;
      continue;
    }
    const v = r.value;
    if (v !== null && typeof v === "object" && (v as { sessionId?: unknown }).sessionId === s.sessionId) {
      return { ok: true, binding: { sessionId: s.sessionId, root, via: "info" } };
    }
  }
  // Every reader answered and none has it: no binding. A reader that could not answer may have had it.
  return failure ? { ok: false, reason: "reader_failed", detail: failure } : { ok: false, reason: "no_binding" };
}

export class ClaudeHistory {
  readonly pool: ReaderPool;
  private readonly owned: boolean;
  private readonly d: DiscoverOptions;

  constructor(o: ClaudeHistoryOptions) {
    this.owned = !(o.pool instanceof ReaderPool);
    this.pool = o.pool instanceof ReaderPool ? o.pool : new ReaderPool(o.pool);
    this.d = { appHome: o.appHome, ...(o.home !== undefined ? { home: o.home } : {}) };
  }

  /** Reads agent-usage's profile list now (it is not cached). */
  discover() {
    return discoverRoots(this.d);
  }

  /** Binds a proved session to a reader root. */
  async bind(s: ProvedSession): Promise<BindResult> {
    const roots = await this.discover();
    if (!roots.ok) return roots;
    return chooseRoot(roots.roots, this.pool, s);
  }

  /** Reads a bound session's messages (system messages included) and checks every one. */
  async read(b: Binding, o: ReadOptions = {}): Promise<ReadResult> {
    const r = await this.pool.call(b.root, {
      op: "messages",
      session: b.sessionId,
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
      ...(o.offset !== undefined ? { offset: o.offset } : {}),
    });
    if (!r.ok) return { ok: false, reason: "reader_failed", detail: r.error };
    const c = checkMessages(r.value);
    if (!c.ok) return { ok: false, reason: "reader_failed", detail: "shape", stats: c.stats };
    return c;
  }

  close(): void {
    if (this.owned) this.pool.close();
  }
}
