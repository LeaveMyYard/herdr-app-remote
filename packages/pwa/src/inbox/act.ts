import type { bridgeApi } from "@herdr-remote/protocol";
import { RESULT } from "./words";

/** The bridge's answer to an `act`, as the PWA gets it (`res` without its id). */
export interface ActResult {
  ok: boolean;
  code?: string;
  unknown_effect?: boolean;
  /** The inbox plugin's own words; never answer text. */
  message?: string;
  closed?: bridgeApi.Res["closed"];
}

/** Sends one `act` and resolves with the bridge's `res`. Never retried. */
export type ActFn = (kind: bridgeApi.InboxActKind, args: Record<string, unknown>) => Promise<ActResult>;

/** Without a bridge client (the demo screens), nothing is sent. */
export const offlineAct: ActFn = () => Promise.resolve({ ok: false, code: "offline", message: RESULT.offline });

/** What the phone says for a result, preferring the inbox's own words. */
export function resultWords(r: ActResult): string {
  if (r.message) return r.message;
  if (r.unknown_effect) return RESULT.unknown;
  if (r.ok) return RESULT.done;
  switch (r.code) {
    case "stale":
      return RESULT.stale;
    case "forbidden":
      return RESULT.forbidden;
    case "paused":
      return RESULT.paused;
    default:
      return RESULT.failed(r.code ?? "failed");
  }
}

/** A row the phone saw close: the inert placeholder the inbox overlay leaves in its place. */
export interface ClosedRow {
  key: string;
  title: string;
  sub: string;
  /** The `closed` word, in words. */
  reason: string;
  /** The time its age counts from (as the feed writes times), or null. */
  at: string | null;
}

const REASON: Record<NonNullable<bridgeApi.Res["closed"]>, string> = {
  answered: "answered",
  dismissed: "dismissed",
  withdrawn: "withdrawn by the agent",
  delivered: "delivered",
  fetched: "fetched by the agent",
  hidden: "hidden",
  acked: "acknowledged",
  cleared: "no longer waiting",
  removed: "removed",
};
export const closedReason = (word: NonNullable<bridgeApi.Res["closed"]>): string => REASON[word];

/**
 * The placeholders, kept above the screens so a row answered on the Question screen still shows as closed back on
 * the list. As in the overlay, they drop out when the operator moves to another row (except the one selected).
 */
export class ClosedRows {
  private rows = new Map<string, ClosedRow>();
  private listeners = new Set<() => void>();
  private said: string | null = null;
  constructor(seed: readonly ClosedRow[] = []) {
    for (const r of seed) this.rows.set(r.key, r);
  }
  get(key: string): ClosedRow | undefined {
    return this.rows.get(key);
  }
  all(): ClosedRow[] {
    return [...this.rows.values()];
  }
  add(row: ClosedRow): void {
    this.rows.set(row.key, row);
    this.emit();
  }
  /** Drops every placeholder but `keep`. */
  purge(keep: string | null): void {
    const before = this.rows.size;
    for (const k of [...this.rows.keys()]) if (k !== keep) this.rows.delete(k);
    if (this.rows.size !== before) this.emit();
  }
  /** The words of the last result, shown once on the list. */
  say(text: string | null): void {
    this.said = text;
    this.emit();
  }
  notice(): string | null {
    return this.said;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
