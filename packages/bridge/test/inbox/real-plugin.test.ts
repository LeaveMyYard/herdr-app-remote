import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { InboxTopicDriver } from "../../src/inbox/topic.js";
import { run } from "../../src/plugins/exec.js";
import { newHub } from "../helpers.js";
import { put, sha } from "../plugins/helpers.js";
import { alertEntry, feedDoc, group, inboxHome, NOW } from "./helpers.js";

/**
 * Drift check against the inbox plugin's real, import-free files, when a sibling checkout is present
 * (CI has none, so it is skipped there). The files are copied into a temporary app home at test time only.
 */
const SRC = join(process.env.HERDR_INBOX_MODS ?? join(homedir(), "Code/herdr-inbox/app/mods/herdr-inbox"));
const NAMES = ["feed.js", "commands.js", "words.js"];
const present = NAMES.every((n) => existsSync(join(SRC, n)));

function realHome() {
  const h = inboxHome({ feed: feedDoc({ entries: [alertEntry(456), group(123)] }) });
  const receipt: Record<string, string> = {};
  for (const n of NAMES) {
    const text = readFileSync(join(SRC, n), "utf8");
    put(h.home, `mods/herdr-inbox/${n}`, text);
    receipt[`mods/herdr-inbox/${n}`] = sha(text);
  }
  put(h.home, "data/herdr-inbox/install.json", JSON.stringify({ v: 1, plugin_root: h.root, plugin_moves: false, claude_config: null, dirs: [], files: receipt }));
  return h;
}

describe.skipIf(!present)("against the real herdr-inbox plugin files", () => {
  it("answers, and reads refusals and unknown effects, with the plugin's own commands.js and words.js", async () => {
    const h = realHome();
    const hub = newHub();
    const d = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    try {
      await d.start();
      await d.settled();
      const rev = () => bridgeApi.InboxTopic.parse(hub.get("inbox")).entries.find((e) => e.key === "group:123")?.rev ?? "";
      h.reply("answer", { v: 1, ok: true, verb: "answer", entry: "@ENTRY@", token: "tok-2", done: [123], skipped: [], delivery: "held" });
      const ok = await d.act("inbox.answer", { key: "group:123", rev: rev(), question: 123, detail: { choices: [1], notes: {}, text: null } });
      expect(ok).toMatchObject({ ok: true, audit_label: "Option B" });
      expect(ok?.message).toContain("Q123");
      expect(h.verbCalls()[0]).toBe('app answer --entry group:123 --token tok-group-123 --question 123 --detail {"choices":["Option B"],"notes":{},"text":null} --json');
      await d.refresh();
      h.reply("answer", { v: 1, ok: false, verb: "answer", entry: "@ENTRY@", code: "stale", message: "x", closed: "dismissed" }, 1);
      const stale = await d.act("inbox.answer", { key: "group:123", rev: rev(), question: 123, detail: { choices: [0], notes: {}, text: null } });
      expect(stale).toMatchObject({ ok: false, code: "stale", closed: "dismissed" });
      expect(stale?.message).toContain("dismissed");
      await d.refresh();
      h.reply("ack", "garbage", 0);
      const unknown = await d.act("inbox.ack", { key: "alert:456", rev: bridgeApi.InboxTopic.parse(hub.get("inbox")).entries[0]?.rev ?? "" });
      expect(unknown).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
      expect(h.verbCalls()).toHaveLength(3);
    } finally {
      d.stop();
    }
  });

  it("loads them hash-pinned and publishes a valid topic", async () => {
    const h = inboxHome({ feed: feedDoc({ entries: [alertEntry(456), group(123)] }) });
    const receipt: Record<string, string> = {};
    for (const n of NAMES) {
      const text = readFileSync(join(SRC, n), "utf8");
      put(h.home, `mods/herdr-inbox/${n}`, text);
      receipt[`mods/herdr-inbox/${n}`] = sha(text);
    }
    put(h.home, "data/herdr-inbox/install.json", JSON.stringify({ v: 1, plugin_root: h.root, plugin_moves: false, claude_config: null, dirs: [], files: receipt }));
    const hub = newHub();
    const d = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 });
    try {
      await d.start();
      await d.settled();
      const t = bridgeApi.InboxTopic.parse(hub.get("inbox"));
      expect(t).toMatchObject({ plugin: "ready", state: "ok", stale: false, waiting: 1, alerts: 1 });
      expect(d.tokenFor("group:123")).toBe("tok-group-123");
    } finally {
      d.stop();
    }
  });
});
