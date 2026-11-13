import { createHmac, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActResult, Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { FEED_MAX_BYTES, INBOX_FEED } from "../plugins/constants.js";
import { detectInbox, type Binaries } from "../plugins/detect.js";
import type { Runner } from "../plugins/exec.js";
import { effectOf, planAct } from "./act.js";
import { buildTopic, type BuildEnv } from "./build.js";
import { loadInboxModules, resolveLauncher, type InboxModules, type Launch, type RawFeed, type VerbResult } from "./plugin.js";

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
  /** How long a write verb may run before its effect counts as unknown. Default `VERB_TIMEOUT_MS`. */
  verbTimeoutMs?: number;
}

const ENSURE_TIMEOUT_MS = 15_000;
/** `app show` has its own 5 s budget; the bridge allows a little more. */
const SHOW_TIMEOUT_MS = 8_000;
/** Left-out ids the bridge opens, and how many per pass: the rest are counted ("not listed"), never lost. */
const MAX_SHOWN = 20;
const SHOWS_PER_PASS = 4;
const SHOW_REFRESH_MS = 30_000;
const SHOW_RETRY_MS = 30_000;
/** A verb has its own 5 s budget (app-commands-v1); past this the bridge stops it and the effect is unknown. */
export const VERB_TIMEOUT_MS = 8_000;

/** What an `act` is checked against: the row as the phone was shown it, and the token the bridge holds for it. */
interface Binding {
  rev: string;
  token: string | undefined;
  row: bridgeApi.InboxRow;
}

interface ShowEntry {
  row: Obj | null;
  at: number;
  retryAt: number;
  /** The inbox said the question is no longer open (`stale`): app-commands-v1 allows no silent second call. */
  closed?: boolean;
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
 * - `act` runs the write verbs (`herdr-inbox app <verb> --json`, app-commands-v1) for the row a phone was shown,
 *   bound by the row's `rev`; the token never leaves the bridge.
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
  private wanted: ReadonlyMap<string, number> = new Map();
  private readonly tokens = new Map<string, string>();
  /**
   * The `ask_operator` call's `tool_use_id` per group row key (app-feed-v1 minor 1), shape-checked only. Kept on
   * the bridge: the `inbox` topic doesn't carry it; the timeline uses it only after checking the asker's transcript.
   */
  private toolUseIds = new Map<string, string>();
  private marks: { question_id: number; alert_id: number; seen: Set<number> } | undefined;
  private readonly newUntil = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private running = false;
  /** Keys every `rev`: a rev says nothing about the token it covers. Random per bridge start. */
  private readonly revKey = randomBytes(32);
  private bound = new Map<string, Binding>();
  /** The token of the bridge's last verb result per row (null: the row is gone), until a newer feed or `show`. */
  private readonly overrides = new Map<string, { token: string | null; at: number; effect?: ((entry: Record<string, unknown>) => Record<string, unknown>) | undefined }>();
  /** Revs the inbox answered `stale` for: refused here until the row's content or token moves (no silent repeat). */
  private readonly refusedRevs = new Set<string>();
  private acting: Promise<unknown> = Promise.resolve();
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

  /** The `tool_use_id` the feed (or `app show`) gave for a group row, if any; as of the last publish. */
  toolUseIdOf(key: string): string | undefined {
    return this.toolUseIds.get(key);
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
      // "The mod uses the token of its last result until a newer feed arrives" (app-commands-v1).
      const g = parsed.feed.generated_at;
      // A left-out row never arrives in a feed: its token comes from `show` and later results only, so a newer
      // feed ends the override only of a row it lists.
      const listed = new Set(parsed.feed.entries.map((e) => String(e.key)));
      for (const [k, o] of this.overrides) if (typeof g === "number" && g * 1000 > o.at && listed.has(k)) this.overrides.delete(k);
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
    this.wanted = wanted;
    for (const k of [...this.shows.keys()]) if (!wanted.has(k)) this.shows.delete(k);
    if (this.showing) return;
    const due = [...wanted].filter(([k]) => {
      const s = this.shows.get(k);
      if (!s) return true;
      // A `stale` refusal is final for this key: the next call would be a silent refresh the protocol forbids.
      if (s.closed || now < s.retryAt) return false;
      // A left-out row can change under the same id (nothing in the feed says so): look again now and then.
      if (s.row === null) return true;
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
        // The group may have changed or left while the call ran: a late answer must not bring its key back.
        if (!this.wanted.has(k)) continue;
        const prev = this.shows.get(k);
        if (res.kind === "shown") {
          this.shows.set(k, { row: (res as { row: Obj }).row, at, retryAt: 0 });
        } else if (res.kind === "refused" && (res as { code?: unknown }).code === "stale") {
          this.shows.set(k, { row: null, at, retryAt: Infinity, closed: true });
        } else {
          // busy, not_migrated, unknown: keep what is shown and look again later (a cut or left-out row stays openable).
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
    const toolUseIds = new Map<string, string>();
    const takeId = (e: Obj): void => {
      const id = e.tool_use_id;
      if (e.kind === "group" && typeof id === "string" && bridgeApi.TOOL_USE_ID.test(id)) toolUseIds.set(String(e.key), id);
      // A row that names no id (an `app show` row may leave the field out) keeps the feed's; a bad one has none.
      else if ("tool_use_id" in e) toolUseIds.delete(String(e.key));
    };
    if (feed) {
      for (const e of feed.entries) takeId(e);
      for (const e of feed.entries) if (typeof e.token === "string") this.tokens.set(String(e.key), e.token);
      const shownAt = new Map<string, number>();
      for (const [k, s] of this.shows) {
        if (!s.row) continue;
        if (k.startsWith("cut:")) shown.set(String(s.row.key), s.row);
        else extra.push(s.row);
        takeId(s.row);
        if (typeof s.row.token === "string") this.tokens.set(String(s.row.key), s.row.token);
        shownAt.set(String(s.row.key), s.at);
      }
      // A verb's own result outranks what was read before it; a later `show` of the row outranks the result.
      for (const [k, o] of this.overrides) {
        if ((shownAt.get(k) ?? -Infinity) > o.at) {
          this.overrides.delete(k);
          continue;
        }
        if (o.token === null) this.tokens.delete(k);
        else this.tokens.set(k, o.token);
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
      rev: (key, content) => this.revOf(this.tokens.get(key), content),
      effect: (entry) => this.overrides.get(String(entry.key))?.effect?.(entry) ?? entry,
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
      // Never leave an old value standing as fresh, and nothing on it can be acted on.
      this.bound = new Map();
      if (hub.get(INBOX_TOPIC) !== undefined) hub.setStale(INBOX_TOPIC, "source_unavailable");
      return;
    }
    // Bound before it is sent: a phone can act only on a rev it was published.
    this.bound = new Map(r.data.entries.map((row) => [row.key, { rev: row.rev, token: this.tokens.get(row.key), row }]));
    this.toolUseIds = toolUseIds;
    for (const rev of this.refusedRevs) if (![...this.bound.values()].some((b) => b.rev === rev)) this.refusedRevs.delete(rev);
    hub.publish(INBOX_TOPIC, r.data as unknown as Json);
  }

  /** HMAC over the token and the row's content as published: any change to either is a new rev. */
  private revOf(token: string | undefined, content: Record<string, unknown>): string {
    return createHmac("sha256", this.revKey)
      .update(token === undefined ? "\u0000none" : `t${token}`)
      .update("\u0000")
      .update(JSON.stringify(content))
      .digest("base64url")
      .slice(0, 32);
  }

  // ---- acts (S11) ----

  /**
   * The inbox `act` kinds; undefined for any other. Capabilities and the audit log are `Security.act`'s: this
   * returns the bridge-resolved option label as `audit_label`. One verb runs at a time.
   */
  act(kind: string, args: Record<string, unknown>): Promise<ActResult> | undefined {
    if (!Object.prototype.hasOwnProperty.call(bridgeApi.INBOX_ACTS, kind)) return undefined;
    const k = kind as bridgeApi.InboxActKind;
    const parsed = bridgeApi.INBOX_ACTS[k].args.safeParse(args);
    if (!parsed.success) return Promise.resolve({ ok: false, code: "bad_args" });
    const run = this.acting.then(() => this.runVerb(k, parsed.data as Record<string, unknown> & { key: string; rev: string }));
    this.acting = run.catch(() => undefined);
    return run;
  }

  private async runVerb(kind: bridgeApi.InboxActKind, args: Record<string, unknown> & { key: string; rev: string }): Promise<ActResult> {
    const { verb } = bridgeApi.INBOX_ACTS[kind];
    const modules = this.modules;
    const launch = this.launch;
    if (!this.running || this.plugin !== "ready" || !modules || !launch) {
      return { ok: false, code: "unavailable", message: "The inbox is not available here. Nothing was sent." };
    }
    const b = this.bound.get(args.key);
    // Not the content the phone drew, or no token for it: say so without asking the inbox.
    if (!b || b.rev !== args.rev || b.token === undefined || this.refusedRevs.has(b.rev)) {
      return { ok: false, code: "stale", message: modules.refusalWords(verb, { code: "stale", message: "", closed: null }) };
    }
    const plan = planAct(kind, args, b.row);
    if ("code" in plan) return { ok: false, code: plan.code, message: plan.message };
    const argv = modules.verbArgs({ verb, entry: args.key, qids: plan.qids, detail: plan.detail, clear: plan.clear === true }, b.token);
    const label = plan.label !== undefined ? { audit_label: plan.label } : {};
    if (argv === null) return { ok: false, code: "invalid", message: "That answer is too long for the inbox. Nothing was sent.", ...label };
    const r = await launch(argv, this.opts.verbTimeoutMs ?? VERB_TIMEOUT_MS).catch(() => null);
    const res = modules.readResult(r === null ? null : { code: r.error ? null : r.code, stdout: r.stdout }, verb, args.key) as VerbResult;
    let out: ActResult;
    if (res.kind === "done") {
      // Effects compose: an earlier verb's effect still stands until a newer feed or `show` carries it.
      const prev = this.overrides.get(args.key)?.effect;
      const next = effectOf(plan, res.done);
      const effect = prev && next ? (e: Record<string, unknown>) => next(prev(e)) : (next ?? prev);
      this.overrides.set(args.key, { token: res.token, at: this.now(), effect });
      const said = [
        res.delivery === "held" ? modules.heldWords(verb, res.done) : res.delivery === "queued" ? modules.queuedWords(res.done) : "",
        res.skipped.length > 0 ? modules.skippedWords(res.skipped) : "",
      ].filter((x) => x !== "");
      out = { ok: true, ...(said.length > 0 ? { message: said.join(" ") } : {}), ...(res.token === null && plan.closes ? { closed: plan.closes } : {}) };
    } else if (res.kind === "refused") {
      if (res.code === "stale") this.refusedRevs.add(b.rev);
      const closed = res.code === "stale" && (bridgeApi.INBOX_CLOSED as readonly string[]).includes(res.closed ?? "") ? { closed: res.closed as bridgeApi.Res["closed"] } : {};
      out = { ok: false, code: res.code, message: modules.refusalWords(verb, res), ...closed };
    } else {
      // Any other exit or stdout: it may or may not have been done. Say so, reload, never repeat it.
      out = { ok: false, code: "unknown_effect", unknown_effect: true, message: modules.unknownWords(String((res as { why?: unknown }).why ?? "no result")) };
    }
    // The new token (and so a new rev) goes out before the result, so the phone's next act can use it.
    this.publish();
    void this.refresh();
    return { ...out, ...label };
  }

  /** A left-out group is new when one of its questions' ids is. */
  private isNewShown(row: Obj, now: number): boolean {
    for (const q of (Array.isArray(row.questions) ? row.questions : []) as Obj[]) {
      if ((this.newUntil.get(`q:${String(q.id)}`) ?? 0) > now) return true;
    }
    return false;
  }
}
