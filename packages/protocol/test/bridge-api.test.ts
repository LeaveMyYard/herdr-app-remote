import { describe, expect, it } from "vitest";
import { bridgeApi } from "../src/index.js";

describe("bridge-api", () => {
  it("accepts chat:<t> topics only with a non-empty suffix", () => {
    expect(bridgeApi.Topic.safeParse("chat:term-1").success).toBe(true);
    expect(bridgeApi.Topic.safeParse("chat:").success).toBe(false);
  });

  it("lists exactly the six documented plugin states", () => {
    expect([...bridgeApi.PLUGIN_STATES]).toEqual(["ready", "missing", "too_old", "broken", "stale", "not_running"]);
  });

  it("lists the documented plugins", () => {
    expect([...bridgeApi.PLUGIN_NAMES]).toEqual(["panorama", "inbox", "usage", "hc", "host"]);
  });

  it("validates a usage snap against the topic schema", () => {
    const snap = (data: unknown) => ({ type: "snap", topic: "usage", epoch: "e", seq: 1, data });
    expect(bridgeApi.ServerMessage.safeParse(snap({ filter: "all", report: null, updatedAtMs: null })).success).toBe(true);
    expect(bridgeApi.ServerMessage.safeParse(snap({ filter: "all" })).success).toBe(false);
  });

  it("keeps status and band open for future usagebar values, and ignores unknown fields", () => {
    const r = bridgeApi.UsageReport.parse({
      version: 1,
      generatedAtMs: 1,
      filter: "all",
      limitPercent: "remaining",
      watchDirs: ["x"],
      providers: [{ providerId: "a", family: "claude", label: "a", status: "paused", windows: [{ slot: "primary", tag: "5h", windowMinutes: 300, displayPercent: 1, barFill: 0.01, band: "critical", resetIn: "" }] }],
    });
    expect(r).not.toHaveProperty("watchDirs");
    expect(r.providers[0]?.status).toBe("paused");
  });

  it("drops a row token from the inbox topic: tokens stay on the bridge", () => {
    const row = {
      key: "alert:1",
      rev: "rev-1",
      kind: "alert",
      actions: ["ack"],
      new: false,
      token: "secret-token",
      id: 1,
      alert_kind: "agent",
      severity: "info",
      title: "Alert Title 1",
      message: null,
      asked_by: null,
      created_at: "2026-01-01T00:00:00+00:00",
      asker: { host: "unknown", pane: null, terminal: null, tab_label: null, cwd: null },
    };
    const r = bridgeApi.InboxRow.safeParse(row);
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.success ? r.data : null)).not.toContain("secret-token");
  });

  it("reads a kind it does not know as an unknown row, and rejects a known kind with bad fields", () => {
    const base = { key: "k:1", rev: "rev-1", actions: [], new: false };
    expect(bridgeApi.InboxRow.safeParse({ ...base, kind: "wat" }).success).toBe(true);
    expect(bridgeApi.InboxRow.safeParse({ ...base, kind: "alert" }).success).toBe(false);
  });

  it("requires a rev on every inbox row: an act is bound to the content shown", () => {
    expect(bridgeApi.InboxRow.safeParse({ key: "k:1", actions: [], new: false, kind: "wat" }).success).toBe(false);
  });

  it("takes inbox answers as option indices only, never a label or a token", () => {
    const act = (args: unknown) => bridgeApi.InboxAct.safeParse({ type: "act", id: "a", kind: "inbox.answer", args });
    const detail = { choices: [0], notes: {}, text: null };
    expect(act({ key: "group:1", rev: "r", question: 1, detail }).success).toBe(true);
    expect(act({ key: "group:1", rev: "r", question: 1, detail: { ...detail, choices: ["Option A"] } }).success).toBe(false);
    expect(act({ key: "group:1", rev: "r", question: 1, detail, label: "Option A" }).success).toBe(false);
    expect(act({ key: "group:1", rev: "r", question: 1, detail, token: "t" }).success).toBe(false);
    expect(act({ key: "group:1", rev: "r", question: 1, detail: { ...detail, label: "x" } }).success).toBe(false);
    expect(act({ key: "group:1", rev: "r", question: 2 ** 53, detail }).success).toBe(false);
  });

  it("extracts a safe terminal id from chat topics only", () => {
    expect(bridgeApi.chatTerminal("chat:t3")).toBe("t3");
    expect(bridgeApi.chatTerminal("chat:vps/t7")).toBe("vps/t7");
    for (const bad of ["host", "chat:", "chat:-h", "chat:--lines", "chat:a b", "chat:a;b", "chat:../x", "chat:a/b/c", "chat:/t1", "chat:" + "x".repeat(65)]) {
      expect(bridgeApi.chatTerminal(bad), bad).toBeNull();
    }
  });

  it("validates a chat snap against the chat payload and rejects a topic name with a newline", () => {
    const snap = (data: unknown) => ({ type: "snap", topic: "chat:t3", epoch: "e", seq: 1, data });
    expect(bridgeApi.ServerMessage.safeParse(snap({ terminal: "t3", lines: [[{ t: "x" }]] })).success).toBe(true);
    expect(bridgeApi.ServerMessage.safeParse(snap({ terminal: "t3", lines: [[{ t: "x", fg: "#GGGGGG" }]] })).success).toBe(false);
    expect(bridgeApi.Topic.safeParse("chat:t3\n").success).toBe(false);
  });
});

describe("TerminalSendArgs (S16)", () => {
  const ok = (a: unknown) => bridgeApi.TerminalSendArgs.safeParse(a).success;
  it("takes a terminal id and printable text with newlines and tabs, empty included (Enter alone)", () => {
    expect(ok({ terminal: "t3", text: "hello\n\tworld ✓" })).toBe(true);
    expect(ok({ terminal: "vps/t7", text: "" })).toBe(true);
    expect(ok({ terminal: "t3", text: "x".repeat(bridgeApi.TERMINAL_SEND_MAX_CHARS) })).toBe(true);
  });
  it("refuses control characters, \\r, overlong text, option-like ids and extra keys", () => {
    for (const text of ["\u001b", "a\rb", "\u0000", "\u0003", "\u007f", "\u0085", "\u009b", "x".repeat(bridgeApi.TERMINAL_SEND_MAX_CHARS + 1)]) {
      expect(ok({ terminal: "t3", text }), JSON.stringify(text).slice(0, 20)).toBe(false);
    }
    for (const terminal of ["-x", "--force", "", "t 3", "a/b/c"]) expect(ok({ terminal, text: "a" }), terminal).toBe(false);
    expect(ok({ terminal: "t3", text: "a", keys: ["esc"] })).toBe(false);
    expect(ok({ terminal: "t3" })).toBe(false);
  });
});
