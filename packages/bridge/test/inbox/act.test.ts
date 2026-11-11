import { afterEach, describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { InboxTopicDriver } from "../../src/inbox/topic.js";
import { run } from "../../src/plugins/exec.js";
import { newHub } from "../helpers.js";
import { alertEntry, failedEntry, feedDoc, group, inboxHome, NOW, question } from "./helpers.js";

let driver: InboxTopicDriver | undefined;
afterEach(() => driver?.stop());

/** Group 127: one question with three options; group 123: three questions, Q124 multi-select with a draft. */
const lone = () =>
  group(127, {
    questions: [
      question(127, {
        options: [
          { label: "Option A", description: null, preview: null },
          { label: "Option B", description: null, preview: null },
          { label: "Option C", description: null, preview: null },
        ],
      }),
    ],
  });
const multi = () =>
  group(123, {
    questions: [
      question(123),
      question(124, {
        multi_select: true,
        options: [
          { label: "Option X", description: null, preview: null },
          { label: "Option Y", description: null, preview: null },
          { label: "Option Z", description: null, preview: null },
        ],
        draft: { choices: ["Option X", "Option Z"], notes: {}, text: null },
      }),
      question(125),
    ],
  });
const entries = () => [alertEntry(456), multi(), lone(), failedEntry(119)];

async function started(opts: Parameters<typeof inboxHome>[0] = {}, verbTimeoutMs?: number, before?: (h: ReturnType<typeof inboxHome>) => void) {
  const h = inboxHome({ feed: feedDoc({ entries: entries() }), ...opts });
  before?.(h);
  const hub = newHub();
  const clock = { now: NOW };
  driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000, ...(verbTimeoutMs ? { verbTimeoutMs } : {}) });
  await driver.start();
  await driver.settled();
  await driver.refresh();
  const d = driver;
  const topic = () => bridgeApi.InboxTopic.parse(hub.get("inbox"));
  const row = (key: string) => {
    const r = topic().entries.find((e) => e.key === key);
    if (!r) throw new Error(`no row ${key}`);
    return r;
  };
  const rev = (key: string) => row(key).rev;
  const act = async (kind: string, args: Record<string, unknown>) => {
    const r = await (d.act(kind, args) ?? Promise.reject(new Error("not an inbox act")));
    await d.refresh();
    await d.settled();
    return r;
  };
  return { h, hub, clock, d, topic, row, rev, act };
}

const done = (verb: string, over: Record<string, unknown> = {}) => ({ v: 1, ok: true, verb, entry: "@ENTRY@", token: "tok-next", done: [127], skipped: [], delivery: "queued", ...over });
const refusal = (verb: string, code: string, closed: string | null = null) => ({ v: 1, ok: false, verb, entry: "@ENTRY@", code, message: `refused: ${code}`, closed });

describe("inbox acts: what reaches the inbox", () => {
  it("answers a lone question with labels taken from the bridge's own row, and returns that label for the audit", async () => {
    const s = await started();
    s.h.reply("answer", done("answer"));
    const r = await s.act("inbox.answer", { key: "group:127", rev: s.rev("group:127"), question: 127, detail: { choices: [1], notes: { "1": "Note 1", "0": "dropped" }, text: null } });
    expect(r).toEqual({ ok: true, message: "Sending Q127 in the background.", audit_label: "Option B" });
    const calls = s.h.verbCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('app answer --entry group:127 --token tok-group-127 --question 127 --detail {"choices":["Option B"],"notes":{"Option B":"Note 1"},"text":null} --json');
  });

  it("never runs anything for an option the question does not have, two picks on a single-select, or a label instead of an index", async () => {
    const s = await started();
    const rev = s.rev("group:127");
    const bad = [
      { choices: [3], notes: {}, text: null },
      { choices: [0, 1], notes: {}, text: null },
      { choices: [], notes: {}, text: "  " },
    ];
    for (const detail of bad) expect(await s.act("inbox.answer", { key: "group:127", rev, question: 127, detail })).toMatchObject({ ok: false, code: "invalid" });
    expect(await s.act("inbox.answer", { key: "group:127", rev, question: 127, detail: { choices: ["Option A"], notes: {}, text: null } })).toEqual({ ok: false, code: "bad_args" });
    expect(await s.act("inbox.answer", { key: "group:127", rev, question: 127, label: "Option A", detail: { choices: [0], notes: {}, text: null } })).toEqual({ ok: false, code: "bad_args" });
    // A question of another group, and a one-shot answer on a group with three questions.
    expect(await s.act("inbox.answer", { key: "group:127", rev, question: 123, detail: { choices: [0], notes: {}, text: null } })).toMatchObject({ code: "invalid" });
    expect(await s.act("inbox.answer", { key: "group:123", rev: s.rev("group:123"), question: 123, detail: { choices: [0], notes: {}, text: null } })).toMatchObject({ code: "invalid" });
    expect(s.h.verbCalls()).toEqual([]);
  });

  it("refuses a detail over the inbox's 64 KiB without running it", async () => {
    const s = await started();
    const r = await s.act("inbox.answer", { key: "group:127", rev: s.rev("group:127"), question: 127, detail: { choices: [], notes: {}, text: "x".repeat(70_000) } });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(s.h.verbCalls()).toEqual([]);
  });

  it("builds every verb's arguments from the row: submit, draft, clear, dismiss, retry, stop-showing, ack", async () => {
    const s = await started();
    const cases: [string, Record<string, unknown>, string][] = [
      ["inbox.answer", { key: "group:123", questions: [123, 124, 124] }, "app answer --entry group:123 --token tok-group-123 --question 123 --question 124 --json"],
      ["inbox.draft", { key: "group:123", question: 124, detail: { choices: [2, 0], notes: {}, text: "Text 1" } }, 'app draft --entry group:123 --token tok-group-123 --question 124 --detail {"choices":["Option Z","Option X"],"notes":{},"text":"Text 1"} --json'],
      ["inbox.draft", { key: "group:123", question: 125, clear: true }, "app draft --entry group:123 --token tok-group-123 --question 125 --clear --json"],
      ["inbox.dismiss", { key: "group:123" }, "app dismiss --entry group:123 --token tok-group-123 --json"],
      ["inbox.dismiss", { key: "group:123", question: 125 }, "app dismiss --entry group:123 --token tok-group-123 --question 125 --json"],
      ["inbox.retry", { key: "failed:119" }, "app retry --entry failed:119 --token tok-failed-119 --json"],
      ["inbox.stop_showing", { key: "failed:119" }, "app stop-showing --entry failed:119 --token tok-failed-119 --json"],
      ["inbox.ack", { key: "alert:456" }, "app ack --entry alert:456 --token tok-alert-456 --json"],
    ];
    for (const [kind, args, want] of cases) {
      // The default fake reply keeps every row, with a new token: rewrite the feed so the next one starts fresh.
      s.h.writeFeed(feedDoc({ entries: entries(), generated_at: s.clock.now / 1000 + 1 }));
      s.clock.now += 2_000;
      await s.d.refresh();
      const key = args.key as string;
      const r = await s.act(kind, { ...args, rev: s.rev(key) });
      expect(r.ok, `${kind} ${JSON.stringify(args)}`).toBe(true);
      expect(s.h.verbCalls().at(-1)).toBe(want);
    }
  });

  it("logs the stored drafts' labels for a Submit, from the bridge's row", async () => {
    const s = await started();
    const r = await s.act("inbox.answer", { key: "group:123", rev: s.rev("group:123"), questions: [123, 124] });
    expect(r).toMatchObject({ ok: true, audit_label: "Q124: Option X, Option Z" });
  });

  it("is read-only where the row does not list the verb, or the act does not fit the row's kind", async () => {
    const s = await started({ feed: feedDoc({ entries: [alertEntry(456, { actions: [] }), lone()] }) });
    expect(await s.act("inbox.ack", { key: "alert:456", rev: s.rev("alert:456") })).toMatchObject({ ok: false, code: "read_only" });
    expect(await s.act("inbox.retry", { key: "group:127", rev: s.rev("group:127") })).toMatchObject({ ok: false, code: "invalid" });
    expect(s.h.verbCalls()).toEqual([]);
  });

  it("is unavailable when the plugin is not ready, and leaves other kinds alone", async () => {
    const s = await started();
    const rev = s.rev("alert:456");
    s.h.setHelp("herdr-inbox app v0\n");
    s.clock.now += 60_000;
    await s.d.refresh();
    expect(await s.act("inbox.ack", { key: "alert:456", rev })).toMatchObject({ ok: false, code: "unavailable" });
    expect(s.d.act("tab.select", {})).toBeUndefined();
    expect(s.d.act("__proto__", {})).toBeUndefined();
    expect(s.h.verbCalls()).toEqual([]);
  });
});

describe("inbox acts: the token is bound to the content shown", () => {
  it("refuses a rev it did not publish, without asking the inbox", async () => {
    const s = await started();
    for (const rev of ["nope", s.rev("group:123")]) {
      expect(await s.act("inbox.ack", { key: "alert:456", rev })).toMatchObject({ ok: false, code: "stale", message: "This group changed, look again. Nothing was sent." });
    }
    expect(await s.act("inbox.ack", { key: "alert:999", rev: s.rev("alert:456") })).toMatchObject({ code: "stale" });
    expect(s.h.verbCalls()).toEqual([]);
  });

  it("a row whose content changed gets a new rev, and the old one is refused", async () => {
    const s = await started();
    const before = s.rev("group:127");
    const changed = lone();
    (changed.questions[0] as { question: string }).question = "Question Title 999";
    s.h.writeFeed(feedDoc({ entries: [alertEntry(456), multi(), changed, failedEntry(119)] }));
    await s.d.refresh();
    expect(s.rev("group:127")).not.toBe(before);
    expect(await s.act("inbox.answer", { key: "group:127", rev: before, question: 127, detail: { choices: [0], notes: {}, text: null } })).toMatchObject({ code: "stale" });
    expect(s.h.verbCalls()).toEqual([]);
  });

  it("a token that moves under unchanged content (a re-opened left-out row) changes the rev too", async () => {
    const shownRow = (token: string) => ({ ...group(140, { token }), questions: [question(140)] });
    const s = await started(
      { feed: feedDoc({ entries: [alertEntry(456)], omitted: { groups: 1, questions: 1, failed: 0, alerts: 0, remote: 0, question_ids: [140] } }) },
      undefined,
      (h) => h.show(140, shownRow("tok-show-1")),
    );
    const first = s.rev("group:140");
    expect(s.d.tokenFor("group:140")).toBe("tok-show-1");
    s.h.show(140, shownRow("tok-show-2"));
    s.clock.now += 31_000;
    await s.d.refresh();
    await s.d.settled();
    await s.d.refresh();
    expect(s.d.tokenFor("group:140")).toBe("tok-show-2");
    // Same content, new token: the phone's rev from before is not this row any more.
    expect(s.rev("group:140")).not.toBe(first);
    expect(await s.act("inbox.dismiss", { key: "group:140", rev: first })).toMatchObject({ code: "stale" });
    expect(s.h.verbCalls()).toEqual([]);
    expect(await s.act("inbox.dismiss", { key: "group:140", rev: s.rev("group:140") })).toMatchObject({ ok: true });
    expect(s.h.verbCalls()).toEqual(["app dismiss --entry group:140 --token tok-show-2 --json"]);
  });

  it("uses its last result's token until a newer feed, and publishes the new rev before answering", async () => {
    const s = await started();
    s.h.reply("draft", done("draft", { token: "tok-mine-1", done: [], delivery: null }));
    const before = s.rev("group:123");
    let revAtResult: string | undefined;
    const p = s.d.act("inbox.draft", { key: "group:123", rev: before, question: 123, detail: { choices: [0], notes: {}, text: null } });
    const r = await p!.then((x) => {
      revAtResult = s.rev("group:123");
      return x;
    });
    expect(r).toEqual({ ok: true, audit_label: "Option A" });
    expect(revAtResult).not.toBe(before);
    expect(s.d.tokenFor("group:123")).toBe("tok-mine-1");
    // The same (unchanged) feed is read again: the result's token stays.
    await s.d.refresh();
    s.h.reply("draft", done("draft", { token: "tok-mine-2", done: [], delivery: null }));
    expect(await s.act("inbox.draft", { key: "group:123", rev: s.rev("group:123"), question: 124, clear: true })).toMatchObject({ ok: true });
    expect(s.h.verbCalls()[1]).toContain("--token tok-mine-1 ");
    // A feed written after the result: its token is the row's now.
    s.clock.now += 1_000;
    s.h.writeFeed(feedDoc({ entries: [alertEntry(456), multi(), lone()].map((e) => (e.key === "group:123" ? { ...e, token: "tok-feed-3" } : e)), generated_at: s.clock.now / 1000 }));
    await s.d.refresh();
    expect(s.d.tokenFor("group:123")).toBe("tok-feed-3");
  });

  it("a result with no token closes the row: the phone is told, and nothing more runs on it", async () => {
    const s = await started();
    s.h.reply("answer", done("answer", { token: null }));
    const rev = s.rev("group:127");
    expect(await s.act("inbox.answer", { key: "group:127", rev, question: 127, detail: { choices: [0], notes: {}, text: null } })).toMatchObject({ ok: true, closed: "answered" });
    expect(s.d.tokenFor("group:127")).toBeUndefined();
    expect(await s.act("inbox.dismiss", { key: "group:127", rev: s.rev("group:127") })).toMatchObject({ ok: false, code: "stale" });
    expect(s.h.verbCalls()).toHaveLength(1);
  });
});

describe("inbox acts: refusals and unknown effects (app-commands-v1)", () => {
  it("passes a refusal on in the plugin's words, with the closed word, and never repeats it", async () => {
    const s = await started();
    s.h.reply("answer", refusal("answer", "stale", "answered"), 1);
    const rev = s.rev("group:127");
    const args = { key: "group:127", rev, question: 127, detail: { choices: [0], notes: {}, text: null } };
    expect(await s.act("inbox.answer", args)).toEqual({ ok: false, code: "stale", closed: "answered", message: "This changed: it was answered elsewhere. Nothing was sent. Look again.", audit_label: "Option A" });
    // The same rev again (a second tap on the same content): refused here; no silent retry with any token.
    expect(await s.act("inbox.answer", args)).toMatchObject({ ok: false, code: "stale" });
    expect(s.h.verbCalls()).toHaveLength(1);
  });

  it("busy, not_migrated, invalid, read_only and unknown codes are refusals; exit 2 is a refusal too", async () => {
    const s = await started();
    for (const code of ["busy", "not_migrated", "invalid", "read_only", "already_sending", "weird"]) {
      s.h.reply("ack", refusal("ack", code), 1);
      const r = await s.act("inbox.ack", { key: "alert:456", rev: s.rev("alert:456") });
      expect(r.ok).toBe(false);
      expect(r.unknown_effect).toBeUndefined();
      expect(r.code).toBe(code === "weird" ? "error" : code);
    }
    s.h.reply("ack", "", 2);
    expect(await s.act("inbox.ack", { key: "alert:456", rev: s.rev("alert:456") })).toMatchObject({ ok: false, code: "error" });
    expect(s.h.verbCalls()).toHaveLength(7);
  });

  it("any other exit, bad stdout, another row's result or a timeout is an unknown effect: said once, never repeated", async () => {
    const s = await started({}, 1_000);
    const cases: [unknown, number, number | undefined][] = [
      [done("ack"), 3, undefined],
      ["not json", 0, undefined],
      [{ ...done("ack"), entry: "alert:999" }, 0, undefined],
      [refusal("ack", "busy"), 0, undefined],
      [{ ...done("ack"), delivery: "maybe" }, 0, undefined],
      [done("ack"), 0, 3],
    ];
    for (const [stdout, code, sleep] of cases) {
      s.h.reply("ack", stdout, code, sleep);
      const before = s.h.verbCalls().length;
      const r = await s.act("inbox.ack", { key: "alert:456", rev: s.rev("alert:456") });
      expect(r, JSON.stringify(stdout)).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
      expect(r.message).toMatch(/^The result is unknown/);
      expect(s.h.verbCalls().length - before).toBe(1);
    }
  }, 20_000);

  it("runs one verb at a time, so the second uses the first one's token", async () => {
    const s = await started();
    s.h.reply("draft", done("draft", { token: "tok-first", done: [], delivery: null }), 0);
    const rev = s.rev("group:123");
    const a = s.d.act("inbox.draft", { key: "group:123", rev, question: 123, detail: { choices: [0], notes: {}, text: null } });
    const b = s.d.act("inbox.draft", { key: "group:123", rev, question: 125, detail: { choices: [1], notes: {}, text: null } });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra?.ok).toBe(true);
    // The second was drawn from the old rev: once the first moved the token, it is refused, not sent with either token.
    expect(rb).toMatchObject({ ok: false, code: "stale" });
    expect(s.h.verbCalls()).toHaveLength(1);
  });

  it("never puts a token in a result", async () => {
    const s = await started();
    s.h.reply("answer", done("answer", { token: "tok-secret-next" }));
    const r = await s.act("inbox.answer", { key: "group:127", rev: s.rev("group:127"), question: 127, detail: { choices: [0], notes: {}, text: null } });
    expect(JSON.stringify(r)).not.toContain("tok-");
    expect(JSON.stringify(s.topic())).not.toContain("tok-");
  });
});
