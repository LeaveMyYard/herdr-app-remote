/**
 * Sliding-window rate limits, one window per key (a device id, or a device id and an act kind).
 *
 * `take` counts an attempt only when it is allowed, so a device that keeps hammering a full window gets refused
 * until its oldest allowed attempt ages out, and no sooner. `firstRefusal` is true once per filled window, so a
 * looping client produces one audit line per window, not one per attempt.
 */
export interface Limit {
  /** Attempts allowed within `windowMs`. */
  max: number;
  windowMs: number;
}

export type Verdict = { ok: true } | { ok: false; firstRefusal: boolean };

/** Keys idle for this many windows are forgotten, so the map can't grow without bound. */
const FORGET_AFTER_WINDOWS = 2;

export class RateLimiter {
  private readonly hits = new Map<string, { at: number[]; refused: boolean }>();

  constructor(
    private readonly limit: Limit,
    private readonly now: () => number,
  ) {}

  take(key: string): Verdict {
    const now = this.now();
    this.prune(now);
    const cur = this.hits.get(key) ?? { at: [], refused: false };
    cur.at = cur.at.filter((t) => now - t < this.limit.windowMs);
    if (cur.at.length >= this.limit.max) {
      const firstRefusal = !cur.refused;
      cur.refused = true;
      this.hits.set(key, cur);
      return { ok: false, firstRefusal };
    }
    cur.at.push(now);
    cur.refused = false;
    this.hits.set(key, cur);
    return { ok: true };
  }

  private prune(now: number): void {
    const horizon = this.limit.windowMs * FORGET_AFTER_WINDOWS;
    for (const [k, v] of this.hits) if (v.at.length === 0 || now - v.at[v.at.length - 1]! >= horizon) this.hits.delete(k);
  }
}
