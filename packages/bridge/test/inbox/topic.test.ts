import { afterEach, describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { InboxTopicDriver } from "../../src/inbox/topic.js";
import { run } from "../../src/plugins/exec.js";
import { join as joinc, newHub } from "../helpers.js";
import { alertEntry, failedEntry, feedDoc, group, inboxHome, NOW, question, type Home } from "./helpers.js";

let driver: InboxTopicDriver | undefined;
afterEach(() => driver?.stop());

function setup(opts: Parameters<typeof inboxHome>[0] = {}) {
  const h = inboxHome(opts);
  const hub = newHub();
  const clock = { now: NOW };
  const invalid: string[] = [];
  driver = new InboxTopicDriver({
    hub,
    appHome: h.home,
    run,
    now: () => clock.now,
    intervalMs: 3_600_000,
    onInvalid: (e) => invalid.push(e),
  });
  const topic = () => bridgeApi.InboxTopic.parse(hub.get("inbox"));
  const step = async (ms = 0) => {
    clock.now += ms;
    await driver!.refresh();
    await driver!.settled();
    await driver!.refresh();
  };
  return { h, hub, clock, d: driver, topic, step, invalid };
}

async function started(opts: Parameters<typeof inboxHome>[0] = {}) {
  const s = setup(opts);
  await s.d.start();
  await s.d.settled();
  await s.d.refresh();
  return s;
}

const ensures = (h: Home) => h.calls().filter((c) => c.startsWith("app-feed --ensure"));

describe("inbox topic: reading the feed", () => {
  it("publishes a schema-valid topic in the feed's order, with counts", async () => {
    const { topic, invalid } = await started();
    const t = topic();
    expect(invalid).toEqual([]);
    expect(t).toMatchObject({ plugin: "ready", state: "ok", stale: false, problem: null, empty: false, waiting: 2, alerts: 1 });
    expect(t.entries.map((e) => e.key)).toEqual(["alert:456", "group:123", "group:127"]);
    expect(t.generated_at).toBe(NOW / 1000 - 2);
  });

  it("never publishes a row token, and keeps it on the bridge for the answer slice", async () => {
    const { d, hub } = await started({ feed: feedDoc({ entries: [alertEntry(456), group(123), failedEntry(119)] }) });
    expect(JSON.stringify(hub.get("inbox"))).not.toContain("tok-");
    expect(d.tokenFor("group:123")).toBe("tok-group-123");
    expect(d.tokenFor("alert:456")).toBe("tok-alert-456");
    expect(d.tokenFor("failed:119")).toBe("tok-failed-119");
    expect(d.tokenFor("group:999")).toBeUndefined();
  });

  it("is stale when the feed is older than 15 s, unstamped or from the future, and still shows it", async () => {
    for (const generated_at of [NOW / 1000 - 20, NOW / 1000 + 30, null]) {
      const { topic } = await started({ feed: feedDoc({ generated_at }) });
      expect(topic().stale).toBe(true);
      expect(topic().state).toBe("ok");
      expect(topic().entries).toHaveLength(3);
    }
  });

  it("keeps the last good feed, marked stale, when a read fails, and never shows an empty inbox", async () => {
    const bad: [string, unknown | string | null, string][] = [
      ["gone", null, "missing"],
      ["not json", "{nope", "unreadable"],
      ["another version", { v: 2, entries: [] }, "unsupported"],
      ["not ok", { v: 1, ok: false, errors: ["db busy"], entries: [] }, "not-ok"],
      ["wrong shape", { v: 1, ok: true }, "unreadable"],
    ];
    for (const [name, feed, problem] of bad) {
      const { h, topic, step } = await started();
      h.writeFeed(feed);
      await step(1000);
      const t = topic();
      expect(t.stale, name).toBe(true);
      expect(t.problem, name).toBe(problem);
      expect(t.state, name).toBe("ok");
      expect(t.entries.map((e) => e.key), name).toEqual(["alert:456", "group:123", "group:127"]);
      expect(t.empty, name).toBe(false);
      expect(t.generated_at, name).toBe(NOW / 1000 - 2);
      h.writeFeed(feedDoc({ generated_at: NOW / 1000 }));
      await step(1000);
      expect(topic().problem, name).toBeNull();
      expect(topic().stale, name).toBe(false);
    }
  });

  it("says the inbox is unavailable, not empty, when there never was a good feed", async () => {
    for (const feed of [null, "{nope", { v: 1, ok: false, errors: [], entries: [] }]) {
      const { topic } = await started({ feed });
      expect(topic()).toMatchObject({ state: "unavailable", empty: false, entries: [], stale: true });
    }
  });

  it("is empty only when ok, with no rows and nothing left out", async () => {
    expect((await started({ feed: feedDoc({ entries: [] }) })).topic()).toMatchObject({ empty: true, incomplete: null });
    const left = (await started({ feed: feedDoc({ entries: [], omitted: { groups: 1, questions: 2, failed: 0, alerts: 0, remote: 0, question_ids: [] } }) })).topic();
    expect(left.empty).toBe(false);
    expect(left.incomplete).toMatchObject({ counts: ["2 questions", "1 group"], unlisted: 2 });
  });

  it("reports an incomplete feed whenever errors exist, even with nothing left out", async () => {
    const { topic } = await started({ feed: feedDoc({ errors: ["a remote machine was not read"] }) });
    expect(topic().incomplete).toEqual({ counts: [], errors: ["a remote machine was not read"], unlisted: 0 });
    expect(topic().errors).toEqual(["a remote machine was not read"]);
  });

  it("shows words it does not know without offering anything on them", async () => {
    const unknownKind = { key: "wat:1", kind: "wat", token: "t", actions: ["answer"] };
    const odd = failedEntry(7, { delivery: { state: "teleported", reason: "somewhere", wait: null, attempts: 1, pending_since: null, auto_retry: false } });
    const entries = [
      unknownKind,
      alertEntry(5, { severity: "catastrophic", alert_kind: "weird", asker: { host: "elsewhere" } }),
      odd,
    ];
    const t = (await started({ feed: feedDoc({ entries }) })).topic();
    expect(t.entries[0]).toEqual({ key: "wat:1", rev: expect.any(String), kind: "wat", actions: [], new: false });
    expect(t.entries[1]).toMatchObject({ severity: "warning", alert_kind: "agent", asker: { host: "unknown" } });
    expect(t.entries[2]).toMatchObject({ actions: [], delivery: { known: false, line: "somewhere" } });
  });

  it("uses the inbox's own delivery wording and Send now rule", async () => {
    const t = (await started({ feed: feedDoc({ entries: [failedEntry(7), failedEntry(8, { asker: { host: "herdr-core", terminal: "t1", pane: null, tab_label: null, cwd: null } })] }) })).topic();
    const [a, b] = t.entries;
    expect(a).toMatchObject({ retry_label: "Send now", delivery: { known: true, warn: false, line: "It waits for the agent." }, actions: ["retry", "stop-showing"] });
    expect(b).toMatchObject({ retry_label: "Retry delivery" });
  });

  it("carries remote rows read-only, with no actions", async () => {
    const remote = {
      key: "remote:m1|db|3",
      kind: "remote_group",
      token: null,
      actions: ["answer"],
      machine: { id: "m1", label: "Machine 1", offline: null },
      title: "Question Title 3",
      created_at: null,
      tab_label: null,
      questions: [question(3)],
    };
    const t = (await started({ feed: feedDoc({ entries: [remote] }) })).topic();
    expect(t.entries[0]).toMatchObject({ kind: "remote_group", actions: [], machine: { label: "Machine 1" } });
  });
});

describe("inbox topic: opening rows with app show", () => {
  const omitted = (ids: number[], questions = ids.length) => ({ groups: ids.length, questions, failed: 0, alerts: 0, remote: 0, question_ids: ids });

  it("opens left-out questions with app show and lists them with the groups", async () => {
    const h = inboxHome({ feed: feedDoc({ omitted: omitted([201, 202]), entries: [alertEntry(456), group(123)] }) });
    h.show(201, group(201, { token: "tok-shown-201" }));
    h.show(202, group(202, { token: "tok-shown-202" }));
    const hub = newHub();
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    await driver.refresh();
    const t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
    expect(t.entries.map((e) => e.key)).toEqual(["alert:456", "group:123", "group:201", "group:202"]);
    expect(t.incomplete).toMatchObject({ counts: ["2 questions", "2 groups"], unlisted: 0 });
    expect(h.calls()).toEqual(expect.arrayContaining(["app show --question 201 --json", "app show --question 202 --json"]));
    expect(driver.tokenFor("group:201")).toBe("tok-shown-201");
    expect(JSON.stringify(hub.get("inbox"))).not.toContain("tok-");
  });

  it("counts a left-out question it could not open, and never asks again after a stale refusal", async () => {
    const h = inboxHome({ feed: feedDoc({ omitted: omitted([201, 202]), entries: [] }) });
    h.show(201, group(201));
    const hub = newHub();
    const clock = { now: NOW };
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    await driver.refresh();
    let t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
    expect(t.entries.map((e) => e.key)).toEqual(["group:201"]);
    expect(t.empty).toBe(false);
    expect(t.incomplete?.unlisted).toBe(1);
    const asked = () => h.calls().filter((c) => c.includes("--question 202")).length;
    expect(asked()).toBe(1);
    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      await driver.refresh();
      await driver.settled();
    }
    expect(asked()).toBe(1);
    clock.now += 31_000;
    await driver.refresh();
    await driver.settled();
    // app-commands-v1: after `stale` the next call is the operator's, never a silent refresh
    expect(asked()).toBe(1);
    t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
    expect(t.incomplete?.unlisted).toBe(1);
  });

  it("replaces a cut question with the whole one from app show, keeping the feed's token", async () => {
    const cut = group(123, { questions: [question(123, { question: "Question Ti", cut: true })] });
    const h = inboxHome({ feed: feedDoc({ entries: [cut] }) });
    h.show(123, group(123, { token: "tok-group-123", questions: [question(123, { question: "Question Title 123 in full", cut: false })] }));
    const hub = newHub();
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    await driver.refresh();
    const t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]).toMatchObject({ kind: "group", questions: [{ question: "Question Title 123 in full", cut: false }] });
    expect(driver.tokenFor("group:123")).toBe("tok-group-123");
  });

  it("shows a cut question as cut when app show cannot open it", async () => {
    const cut = group(123, { questions: [question(123, { question: "Question Ti", cut: true })] });
    const t = (await started({ feed: feedDoc({ entries: [cut] }) })).topic();
    expect(t.entries[0]).toMatchObject({ questions: [{ cut: true }] });
  });
});

describe("inbox topic: show retries and bad rows", () => {
  const cutGroup = group(123, { questions: [question(123, { question: "Question Ti", cut: true })] });

  it("opens a cut group again after a busy first call", async () => {
    const h = inboxHome({ feed: feedDoc({ entries: [cutGroup] }) });
    h.busy(123, true);
    const hub = newHub();
    const clock = { now: NOW };
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    expect(h.calls().filter((c) => c.includes("--question 123"))).toHaveLength(1);
    h.busy(123, false);
    h.show(123, group(123, { questions: [question(123, { question: "Question Title 123 in full" })] }));
    for (let i = 0; i < 3; i++) {
      clock.now += 31_000;
      h.writeFeed(feedDoc({ generated_at: clock.now / 1000, entries: [cutGroup] }));
      await driver.refresh();
      await driver.settled();
    }
    await driver.refresh();
    const t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
    expect(t.entries[0]).toMatchObject({ questions: [{ question: "Question Title 123 in full", cut: false }] });
  });

  it("does not call app show again inside the retry wait after a busy answer", async () => {
    const h = inboxHome({ feed: feedDoc({ omitted: { groups: 1, questions: 1, failed: 0, alerts: 0, remote: 0, question_ids: [201] }, entries: [] }) });
    h.busy(201, true);
    const hub = newHub();
    const clock = { now: NOW };
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      await driver.refresh();
      await driver.settled();
    }
    expect(h.calls().filter((c) => c.includes("--question 201"))).toHaveLength(1);
    clock.now += 30_000;
    await driver.refresh();
    await driver.settled();
    expect(h.calls().filter((c) => c.includes("--question 201"))).toHaveLength(2);
  });

  it("drops a row it cannot build, and still publishes the others fresh", async () => {
    const bad = [{ key: "", kind: "wat", token: null, actions: [] }, group(9, { questions: [] })];
    const { topic, invalid } = await started({ feed: feedDoc({ entries: [alertEntry(456), ...bad] }) });
    expect(invalid).toEqual([]);
    expect(topic().entries.map((e) => e.key)).toEqual(["alert:456"]);
  });

  it("is not empty when the feed's only entry is one it could not build", async () => {
    const { topic } = await started({ feed: feedDoc({ entries: [{ key: "", kind: "wat", token: null, actions: [] }] }) });
    expect(topic()).toMatchObject({ entries: [], empty: false });
  });

  it("marks the topic stale when a value cannot be published", async () => {
    const s = await started();
    // a topic that fails its own schema must not stay up as fresh
    expect(s.hub.isStale("inbox")).toBeNull();
    const orig = bridgeApi.InboxTopic.safeParse;
    (bridgeApi.InboxTopic as { safeParse: unknown }).safeParse = () => ({ success: false, error: { issues: [{ path: ["x"], message: "boom" }] } });
    try {
      s.h.writeFeed(feedDoc({ generated_at: NOW / 1000 + 1 }));
      await s.step(1000);
    } finally {
      (bridgeApi.InboxTopic as { safeParse: unknown }).safeParse = orig;
    }
    expect(s.invalid.length).toBeGreaterThan(0);
    expect(s.hub.isStale("inbox")).toBe("source_unavailable");
  });

  it("counts left-out groups as waiting before they are opened", async () => {
    const { topic } = await started({ feed: feedDoc({ entries: [], omitted: { groups: 2, questions: 2, failed: 0, alerts: 0, remote: 0, question_ids: [] } }) });
    expect(topic()).toMatchObject({ waiting: 2, empty: false });
  });

  it("reads a feed over 1 MiB as unreadable", async () => {
    const { topic, h, step } = await started();
    h.writeFeed(JSON.stringify(feedDoc({ errors: ["x".repeat(1_100_000)] })));
    await step(1000);
    expect(topic().problem).toBe("unreadable");
    expect(topic().stale).toBe(true);
  });

  it("opens at most 20 left-out ids", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 300 + i);
    const h = inboxHome({ feed: feedDoc({ entries: [], omitted: { groups: 30, questions: 30, failed: 0, alerts: 0, remote: 0, question_ids: ids } }) });
    for (const id of ids) h.show(id, group(id));
    const hub = newHub();
    const clock = { now: NOW };
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000 });
    await driver.start();
    for (let i = 0; i < 10; i++) {
      clock.now += 1000;
      await driver.refresh();
      await driver.settled();
    }
    const t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
    expect(t.entries).toHaveLength(20);
    expect(t.incomplete?.unlisted).toBe(10);
  });

  it("puts opened left-out groups after the local groups and before failed rows", async () => {
    const h = inboxHome({ feed: feedDoc({ omitted: { groups: 1, questions: 1, failed: 0, alerts: 0, remote: 0, question_ids: [201] }, entries: [alertEntry(456), group(123), failedEntry(119)] }) });
    h.show(201, group(201));
    const hub = newHub();
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    await driver.refresh();
    expect(bridgeApi.InboxTopic.parse(hub.get("inbox")).entries.map((e) => e.key)).toEqual(["alert:456", "group:123", "group:201", "failed:119"]);
  });

  it("picks up an inbox that was updated or removed while running", async () => {
    const h = inboxHome();
    const hub = newHub();
    const clock = { now: NOW };
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000 });
    await driver.start();
    expect(bridgeApi.InboxTopic.parse(hub.get("inbox")).plugin).toBe("ready");
    h.setHelp("herdr-inbox 0.1.0\n");
    clock.now += 31_000;
    h.writeFeed(feedDoc({ generated_at: clock.now / 1000 }));
    await driver.refresh();
    expect(bridgeApi.InboxTopic.parse(hub.get("inbox"))).toMatchObject({ plugin: "too_old", state: "unavailable" });
  });
});

describe("inbox topic: the writer", () => {
  it("runs --ensure only after the app --help probe, through the launcher", async () => {
    const { h } = await started({ feed: null });
    const calls = h.calls();
    expect(calls[0]).toBe("app --help");
    expect(calls[1]).toMatch(/^app-feed --ensure --app-home \//);
  });

  it("runs --ensure at most once per 5 s while stale, and not at all while fresh", async () => {
    const { h, step, clock } = await started({ feed: feedDoc({ generated_at: NOW / 1000 - 60 }) });
    expect(ensures(h)).toHaveLength(1);
    for (let i = 0; i < 4; i++) await step(1000);
    expect(ensures(h)).toHaveLength(1);
    await step(1500);
    expect(ensures(h)).toHaveLength(2);
    await step(1000);
    expect(ensures(h)).toHaveLength(2);
    // a feed that is fresh again stops the calls
    h.writeFeed(feedDoc({ generated_at: clock.now / 1000 }));
    await step(6000);
    await step(6000);
    expect(ensures(h)).toHaveLength(2);
  });

  it("does not ensure while the feed is fresh", async () => {
    const { h, step } = await started();
    await step(2000);
    expect(ensures(h)).toEqual([]);
  });

  it("keeps going when --ensure exits 1", async () => {
    const h = inboxHome({ feed: null });
    h.setEnsureCode(1);
    const hub = newHub();
    const clock = { now: NOW };
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => clock.now, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    clock.now += 6000;
    await driver.refresh();
    await driver.settled();
    expect(ensures(h)).toHaveLength(2);
    expect(bridgeApi.InboxTopic.parse(hub.get("inbox")).state).toBe("unavailable");
  });

  it("never runs --ensure when the probe says the inbox is too old, and shows nothing", async () => {
    const h = inboxHome();
    h.setHelp("herdr-inbox 0.1.0\n");
    const hub = newHub();
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    await driver.start();
    await driver.settled();
    expect(ensures(h)).toEqual([]);
    expect(bridgeApi.InboxTopic.parse(hub.get("inbox"))).toMatchObject({ plugin: "too_old", state: "unavailable", entries: [], empty: false });
  });
});

describe("inbox topic: availability", () => {
  const state = async (opts: Parameters<typeof inboxHome>[0]) => (await started(opts)).topic();

  it("treats a moving install as missing: the recorded root may be an old copy", async () => {
    expect(await state({ moves: true })).toMatchObject({ plugin: "missing", state: "unavailable" });
  });

  it("is missing without an install receipt, or when the recorded root is gone", async () => {
    expect(await state({ receipt: false })).toMatchObject({ plugin: "missing", state: "unavailable" });
    expect(await state({ root: false })).toMatchObject({ plugin: "missing", state: "unavailable" });
  });

  it("is broken when a plugin file does not match its receipt, or has imports", async () => {
    expect(await state({ pinned: { feed: "0".repeat(64) } })).toMatchObject({ plugin: "broken", state: "unavailable" });
    expect(await state({ files: { words: `import x from './x.js';\n${"export const severity = w => w;"}` } })).toMatchObject({ plugin: "broken" });
  });

  it("is broken for a newer protocol", async () => {
    const h = inboxHome();
    h.setHelp("herdr-inbox app v2\n");
    const hub = newHub();
    driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    await driver.start();
    expect(bridgeApi.InboxTopic.parse(hub.get("inbox")).plugin).toBe("broken");
  });
});

describe("inbox topic: new rows", () => {
  it("marks nothing new on the first good feed, then a row above the marks for a minute", async () => {
    const { h, step, topic } = await started();
    expect(topic().entries.every((e) => !e.new)).toBe(true);
    h.writeFeed(feedDoc({ generated_at: NOW / 1000, new_since: { question_id: 140, alert_id: 40 }, entries: [alertEntry(456), group(140), group(123), group(127)] }));
    await step(1000);
    expect(Object.fromEntries(topic().entries.map((e) => [e.key, e.new]))).toEqual({ "alert:456": true, "group:140": true, "group:123": false, "group:127": false });
    h.writeFeed(feedDoc({ generated_at: NOW / 1000 + 70, new_since: { question_id: 140, alert_id: 40 }, entries: [group(140)] }));
    await step(70_000);
    expect(topic().entries[0]).toMatchObject({ key: "group:140", new: false });
  });
});

describe("inbox topic: on the hub", () => {
  it("sends a snap, then a patch holding only what changed", async () => {
    const { hub, h, step } = await started();
    const c = await joinc(hub);
    await c.send({ type: "sub", topics: ["inbox"] });
    expect(c.client.ofType("snap")).toHaveLength(1);
    h.writeFeed(feedDoc({ generated_at: NOW / 1000 + 1, entries: [alertEntry(456), group(123)] }));
    await step(1000);
    const patches = c.client.ofType("patch");
    expect(patches.length).toBeGreaterThan(0);
    expect(JSON.stringify(patches)).not.toContain("tok-");
  });
});
