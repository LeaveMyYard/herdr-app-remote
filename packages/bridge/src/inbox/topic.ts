import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { FEED_MAX_BYTES, INBOX_FEED } from "../plugins/constants.js";
import { detectInbox, type Binaries } from "../plugins/detect.js";
import type { Runner } from "../plugins/exec.js";
import { buildTopic, type BuildEnv } from "./build.js";
import { loadInboxModules, resolveLauncher, type InboxModules, type Launch, type RawFeed } from "./plugin.js";

export const INBOX_TOPIC = "inbox";

type Obj = Record<string, unknown>;

export interface InboxTopicOptions {
  hub: Hub;
  appHome: string;
  /** Runs `sh <root>/scripts/launch cli ...`; injected so tests use a fake launcher. */
  run: Runner;
  binaries?: Binaries;
  /** Epoch milliseconds. */
  now?: () => number;
  /** How often the feed file is read. Default 1 s. */
  intervalMs?: number;
  /** The writer `--ensure` runs at most this often while the feed is stale (app-feed-v1: 5 s). */
  ensureEveryMs?: number;
  /** How often the `app --help` probe and the pinned plugin files are re-checked. Default 30 s. */
  probeEveryMs?: number;
  /** How long a row stays `new`. Default 60 s. */
  newMs?: number;
  onInvalid?: (error: string) => void;
}

const ENSURE_TIMEOUT_MS = 15_000;
/** `app show` has its own 5 s budget; the bridge allows a little more. */
const SHOW_TIMEOUT_MS = 8_000;
/** Left-out ids the bridge opens, and how many per pass: the rest are counted ("not listed"), never lost. */
const MAX_SHOWN = 20;
const SHOWS_PER_PASS = 4;
const SHOW_REFRESH_MS = 30_000;
const SHOW_RETRY_MS = 30_000;

interface ShowEntry {
  row: Obj | null;
  at: number;
  retryAt: number;
}

type Read = { text: string } | { problem: "missing" | "unreadable" };

async function readFeedText(path: string): Promise<Read> {
  try {
    const h = await open(path, "r");
    try {
      const buf = Buffer.alloc(FEED_MAX_BYTES + 1);
      const { bytesRead } = await h.read(buf, 0, buf.length, 0);
      // `readTextFile` reads at most 1 MiB, so a bigger file is no feed this version can trust.
      return bytesRead > FEED_MAX_BYTES ? { problem: "unreadable" } : { text: buf.toString("utf8", 0, bytesRead) };
    } finally {
      await h.close();
    }
  } catch (e) {
    return { problem: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/**
 * Publishes the `inbox` topic from herdr-inbox's feed (app-feed-v1), following its reader rules:
 * - the plugin's own `feed.js`, `commands.js` and `words.js` do the reading (hash-pinned; `model/*` is not needed here);
 * - a bad read keeps the last good feed, marked stale, and never becomes an empty inbox;
 * - the writer is started with `app-feed --ensure`, only after the `app --help` probe says ready, at most once per 5 s while stale;
 * - left-out questions and cut ones are opened with `app show`; row tokens stay on the bridge (`tokenFor`).
 * Nothing is written to the inbox here: answering is S11.
 */
export class InboxTopicDriver {
  private modules: InboxModules | undefined;
  private launch: Launch | undefined;
  private loadFailure: { reason: "missing" | "broken"; at: number } | undefined;
  private loadedAt = -Infinity;
  private plugin: bridgeApi.InboxTopic["plugin"] = "missing";
  private probedAt = -Infinity;
  private text: string | undefined;
  private lastGood: RawFeed | null = null;
  private problem: bridgeApi.InboxTopic["problem"] = "missing";
  private lastEnsure = -Infinity;
  private ensuring: Promise<void> | undefined;
  private showing: Promise<void> | undefined;
  private readonly shows = new Map<string, ShowEntry>();
  private readonly tokens = new Map<string, string>();
  private marks: { question_id: number; alert_id: number; seen: Set<number> } | undefined;
  private readonly newUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private running = false;
  /** Every spawn of the launcher, for tests and the audit of "at most once per 5 s". */
  ensureCount = 0;

  constructor(private readonly opts: InboxTopicOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async start(): Promise<void> {
    this.running = true;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 1_000);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The row token the feed (or `app show`) gave for a key. For the answer slice; it never leaves the bridge. */
  tokenFor(key: string): string | undefined {
    return this.tokens.get(key);
  }

  /** Overlapping calls share one run. */
  refresh(): Promise<void> {
    this.inflight ??= this.tick().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Resolves when the background `--ensure` and `app show` work started so far is done (for tests). */
  async settled(): Promise<void> {
    await Promise.all([this.ensuring, this.showing]);
  }

  private async load(now: number): Promise<void> {
    if (this.modules && now - this.loadedAt < (this.opts.probeEveryMs ?? 30_000)) return;
    if (!this.modules && this.loadFailure && now - this.loadFailure.at < 5_000) return;
    const loaded = await loadInboxModules(this.opts.appHome);
    if (!loaded.ok) {
      this.modules = undefined;
      this.launch = undefined;
      this.loadFailure = { reason: loaded.reason, at: now };
      this.plugin = loaded.reason;
      return;
    }
    this.loadFailure = undefined;
    this.modules = loaded.modules;
    this.loadedAt = now;
    this.launch = await resolveLauncher(this.opts.appHome, this.opts.run);
    if (!this.launch) {
      this.plugin = "missing";
      return;
    }
    // Availability first (app-feed-v1): the `app --help` probe, through the launcher like every command.
    const launch = this.launch;
    const status = await detectInbox({
      appHome: this.opts.appHome,
      run: (_cmd, args, o) => launch(args, o.timeoutMs),
      ...(this.opts.binaries ? { binaries: this.opts.binaries } : {}),
    });
    this.probedAt = now;
    this.plugin = status.state === "ready" || status.state === "missing" || status.state === "too_old" ? status.state : "broken";
  }

  private async tick(): Promise<void> {
    const now = this.now();
    await this.load(now);
    if (this.modules && this.plugin === "ready") {
      await this.readFeed(now);
    }
    const stale = this.isStale(now);
    if (stale) this.ensureWriter(now);
    if (this.modules && this.plugin === "ready") this.openRows(now);
    this.publish();
  }

  private async readFeed(now: number): Promise<void> {
    const modules = this.modules as InboxModules;
    const read = await readFeedText(join(this.opts.appHome, INBOX_FEED));
    if ("problem" in read) {
      this.text = undefined;
      this.problem = read.problem;
      return;
    }
    if (read.text === this.text && this.problem === null) return;
    this.text = read.text;
    const parsed = modules.parseFeed(read.text);
    if (parsed.feed) {
      this.problem = null;
      this.takeMarks(parsed.feed, now);
      this.lastGood = parsed.feed;
    } else {
      // Anything the reader does not accept leaves the last good feed in place.
      this.problem = parsed.problem;
    }
  }

  private isStale(now: number): boolean {
    if (this.plugin !== "ready") return true;
    if (this.problem !== null || this.lastGood === null) return true;
    return (this.modules as InboxModules).isStale(this.lastGood.generated_at, now / 1000);
  }

  /** `app-feed --ensure`: only once the probe said ready, and at most once per 5 s while stale. */
  private ensureWriter(now: number): void {
    if (this.plugin !== "ready" || !this.launch || this.ensuring) return;
    if (now - this.lastEnsure < (this.opts.ensureEveryMs ?? 5_000)) return;
    this.lastEnsure = now;
    this.ensureCount++;
    const args = ["app-feed", "--ensure", ...(isAbsolute(this.opts.appHome) ? ["--app-home", this.opts.appHome] : [])];
    // Exit 1 (deferred, disabled, not proven) is not an error here: the feed's own age is what the phone shows.
    this.ensuring = this.launch(args, ENSURE_TIMEOUT_MS)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.ensuring = undefined;
      });
  }

  /** The toast marks of app-feed-v1: the first good feed sets them and announces nothing. */
  private takeMarks(feed: RawFeed, now: number): void {
    const ids = feed.omitted.question_ids;
    const qMark = feed.new_since?.question_id ?? 0;
    const aMark = feed.new_since?.alert_id ?? 0;
    if (!this.marks) {
      this.marks = { question_id: qMark, alert_id: aMark, seen: new Set(ids) };
      return;
    }
    const until = now + (this.opts.newMs ?? 60_000);
    const mark = (key: string): void => {
      if (!this.newUntil.has(key)) this.newUntil.set(key, until);
    };
    for (const e of feed.entries) {
      if (e.kind === "group" && typeof e.group === "number" && e.group > this.marks.question_id) mark(String(e.key));
      if (e.kind === "alert" && typeof e.id === "number" && e.id > this.marks.alert_id) mark(String(e.key));
    }
    for (const id of ids) if (!this.marks.seen.has(id)) mark(`q:${id}`);
    this.marks = { question_id: Math.max(this.marks.question_id, qMark), alert_id: Math.max(this.marks.alert_id, aMark), seen: new Set([...this.marks.seen, ...ids]) };
  }

  /** Decides which rows to open with `app show`, and starts one background pass. */
  private openRows(now: number): void {
    const feed = this.lastGood;
    if (!feed || !this.launch) return;
    const wanted = new Map<string, number>();
    for (const id of feed.omitted.question_ids.slice(0, MAX_SHOWN)) wanted.set(`omit:${id}`, id);
    for (const e of feed.entries) {
      if (e.kind !== "group" || !Array.isArray(e.questions)) continue;
      const cut = (e.questions as Obj[]).find((q) => q.cut === true);
      if (cut && typeof cut.id === "number" && typeof e.token === "string") wanted.set(`cut:${String(e.key)}|${e.token}`, cut.id);
    }
    for (const k of [...this.shows.keys()]) if (!wanted.has(k)) this.shows.delete(k);
    if (this.showing) return;
    const due = [...wanted].filter(([k]) => {
      const s = this.shows.get(k);
      if (!s) return true;
      if (now < s.retryAt) return false;
      // A left-out row can change under the same id (nothing in the feed says so): look again now and then.
      return k.startsWith("omit:") && now - s.at >= SHOW_REFRESH_MS;
    });
    if (due.length === 0) return;
    this.showing = (async () => {
      for (const [k, qid] of due.slice(0, SHOWS_PER_PASS)) {
        const launch = this.launch;
        const modules = this.modules;
        if (!launch || !modules) return;
        const r = await launch(modules.showArgs(qid), SHOW_TIMEOUT_MS).catch(() => null);
        const at = this.now();
        const res = modules.readResult(r === null ? null : { code: r.error ? null : r.code, stdout: r.stdout }, "show", null);
        const prev = this.shows.get(k);
        if (res.kind === "shown") {
          this.shows.set(k, { row: (res as { row: Obj }).row, at, retryAt: 0 });
        } else {
          // `stale` (closed meanwhile), busy, unknown: keep what is shown and look again later, never in a loop.
          this.shows.set(k, { row: prev?.row ?? null, at, retryAt: at + SHOW_RETRY_MS });
        }
        if (this.running) this.publish();
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.showing = undefined;
      });
  }

  private publish(): void {
    if (!this.running) return;
    const { hub } = this.opts;
    const now = this.now();
    const modules = this.modules;
    const feed = this.plugin === "ready" ? this.lastGood : null;
    const shown = new Map<string, Obj>();
    const extra: Obj[] = [];
    this.tokens.clear();
    if (feed) {
      for (const e of feed.entries) if (typeof e.token === "string") this.tokens.set(String(e.key), e.token);
      for (const [k, s] of this.shows) {
        if (!s.row) continue;
        if (k.startsWith("cut:")) shown.set(String(s.row.key), s.row);
        else extra.push(s.row);
        if (typeof s.row.token === "string") this.tokens.set(String(s.row.key), s.row.token);
      }
    }
    // One row per key, in question order: several left-out ids can be in one group.
    const byKey = new Map(extra.map((r) => [String(r.key), r]));
    const rows = [...byKey.values()].sort((a, b) => Number(a.group) - Number(b.group));
    const covered = new Set<number>();
    for (const r of rows) for (const q of (Array.isArray(r.questions) ? r.questions : []) as Obj[]) if (typeof q.id === "number") covered.add(q.id);
    const listed = feed ? feed.omitted.question_ids.filter((id) => covered.has(id)).length : 0;
    const unlisted = feed ? Math.max(feed.omitted.questions - listed, 0) : 0;
    for (const [k, t] of this.newUntil) if (t <= now) this.newUntil.delete(k);
    const env: BuildEnv = {
      modules: modules as InboxModules,
      shown,
      isNew: (key) => (this.newUntil.get(key) ?? 0) > now || rows.some((r) => r.key === key && this.isNewShown(r, now)),
    };
    const topic = buildTopic(
      {
        plugin: this.plugin,
        feed,
        problem: this.problem,
        stale: this.isStale(now),
        extra: rows,
        unlisted,
      },
      env,
    );
    const r = bridgeApi.InboxTopic.safeParse(topic);
    if (!r.success) {
      this.opts.onInvalid?.(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    hub.publish(INBOX_TOPIC, r.data as unknown as Json);
  }

  /** A left-out group is new when one of its questions' ids is. */
  private isNewShown(row: Obj, now: number): boolean {
    for (const q of (Array.isArray(row.questions) ? row.questions : []) as Obj[]) {
      if ((this.newUntil.get(`q:${String(q.id)}`) ?? 0) > now) return true;
    }
    return false;
  }
}
