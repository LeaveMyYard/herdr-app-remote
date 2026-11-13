import { join } from "node:path";
import { PANORAMA_CONTRACT, PANORAMA_FEED, PANORAMA_RECEIPT } from "../plugins/constants.js";
import { readFeed } from "../plugins/detect.js";
import { loadPinned } from "../plugins/loader.js";

/** The parts of panorama's feed v2 the bridge reads. Validation is `contract.js`'s job, not ours. */
export interface FeedAgent {
  id: string;
  harness: string;
  title: string;
  role: string;
  model: string | null;
  status: string;
  activity: string;
  last_message: string;
  questions: string[];
  pending: string[];
  question_ids: number[];
  error: string | null;
  parent: string | null;
  tool_calls: number;
  started: number | null;
  ended: number | null;
  last_at: number | null;
  seq: number;
}

export interface FeedRoot {
  pane_id: string;
  host: string;
  terminal: string | null;
  harness: string;
  tab_label: string;
  title: string;
  herdr_status: string;
  tab_no: number | null;
  inbox: number[];
  hidden_finished: number;
  last_activity: number | null;
  /** The verified harness session id (after `continued-in`), never a join heuristic. The chat view (CV3) reads it. */
  session_id: string | null;
  /** Source folder metadata: the chat view's getSessionInfo fallback only, never identity. */
  cwd: string | null;
  /** The absolute path of the main transcript. The chat view stats it and picks a reader root by it; never opened. */
  transcript: string | null;
  agents: FeedAgent[];
}

export interface Feed {
  v: number;
  generated_at: number;
  roots: FeedRoot[];
}

/** panorama's own `contract.js`, loaded hash-pinned. */
export interface Contract {
  parseFeed(text: string): Feed;
  aged(packet: unknown, now?: number): boolean;
  readResult(previous: unknown, text: string | null, error?: unknown): { feed: Feed | null; stale: boolean; errors: string[]; generated_at: number | null };
  rootKey(root: FeedRoot): string;
}

export type ContractLoad = { ok: true; contract: Contract } | { ok: false; reason: string };

export async function loadContract(appHome: string): Promise<ContractLoad> {
  const loaded = await loadPinned(appHome, PANORAMA_RECEIPT, [PANORAMA_CONTRACT]);
  if (!loaded.ok) return { ok: false, reason: loaded.detail };
  const m = loaded.modules[PANORAMA_CONTRACT] as Partial<Contract> | undefined;
  if (!m || typeof m.parseFeed !== "function" || typeof m.aged !== "function" || typeof m.readResult !== "function" || typeof m.rootKey !== "function") {
    return { ok: false, reason: "contract.js has an unexpected shape" };
  }
  return { ok: true, contract: m as Contract };
}

/** What the reader knows right now. `feed` is the last valid one and survives every later failure. */
export interface FeedView {
  feed: Feed | null;
  /** The newest read failed (or there was never a good one), or the feed is aged. */
  stale: boolean;
  /** Older than the 15 s limit (or unstamped, or from the future): joins are off. */
  aged: boolean;
  /** Short fixed sentence for the newest failure; null when the newest read was good. */
  error: string | null;
}

const RELOAD_MS = 60_000;
const RETRY_MS = 10_000;

/**
 * Reads `data/panorama/feed.json` and validates it with panorama's `contract.js` (`readResult`: on any failure the
 * last good feed is kept and marked stale, and a read or parse error never becomes an empty feed).
 */
export class FeedReader {
  private contract: Contract | undefined;
  private contractAt = 0;
  private lastText: string | undefined;
  private previous: { feed: Feed | null; generated_at: number | null } | undefined;
  private error: string | null = null;

  constructor(
    private readonly appHome: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Re-reads the contract and the feed; cheap when nothing changed. */
  async read(): Promise<FeedView> {
    await this.ensureContract();
    const c = this.contract;
    if (!c) {
      // Without a verified contract nothing can be trusted (not even the retained feed): the topic goes basic.
      this.error = "contract unavailable";
      return this.view();
    }
    const f = await readFeed(join(this.appHome, PANORAMA_FEED));
    if ("missing" in f) {
      this.apply(c, null, new Error("feed missing"), "feed missing");
    } else if ("error" in f) {
      this.apply(c, null, new Error(f.error), f.error === "feed larger than 1 MiB" ? "feed too large" : "feed unreadable");
    } else if (f.text !== this.lastText || this.error !== null) {
      this.lastText = f.text;
      this.apply(c, f.text, null, "feed invalid");
    }
    return this.view();
  }

  private apply(c: Contract, text: string | null, err: Error | null, label: string): void {
    const r = c.readResult(this.previous, text, err);
    this.previous = { feed: r.feed, generated_at: r.generated_at };
    this.error = r.stale ? label : null;
    if (text === null) this.lastText = undefined;
  }

  private view(): FeedView {
    const feed = this.previous?.feed ?? null;
    const c = this.contract;
    const aged = feed !== null && c !== undefined ? c.aged(feed, this.now()) : false;
    return { feed, stale: this.error !== null || aged || feed === null, aged, error: this.error };
  }

  contractFor(): Contract | undefined {
    return this.contract;
  }

  private async ensureContract(): Promise<void> {
    const t = this.now();
    const wait = this.contract ? RELOAD_MS : RETRY_MS;
    if (this.contractAt !== 0 && t - this.contractAt < wait) return;
    this.contractAt = t;
    const r = await loadContract(this.appHome);
    if (r.ok) {
      this.contract = r.contract;
    } else {
      // A contract that stopped verifying is not used any more.
      this.contract = undefined;
    }
  }
}
