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

describe("terminal keys (S16b)", () => {
  const { isKeyToken, allKeyTokens } = bridgeApi;

  it("accepts named keys with any modifiers, in canonical order", () => {
    for (const t of ["esc", "enter", "tab", "shift+tab", "ctrl+left", "alt+enter", "ctrl+alt+shift+f12", "pagedown", "f1", "ctrl+backspace"]) {
      expect(isKeyToken(t), t).toBe(true);
    }
  });

  it("accepts letters only with ctrl or alt, digits only with alt, space only with ctrl or alt", () => {
    for (const t of ["ctrl+c", "alt+b", "ctrl+alt+x", "ctrl+alt+i", "alt+m", "alt+1", "ctrl+space", "alt+space", "ctrl+alt+space"]) expect(isKeyToken(t), t).toBe(true);
  });

  it("refuses every token that would type plain text", () => {
    // A bare or shifted letter, digit or space is text; the rig showed ctrl+0 types "0" and super+x / cmd+x type "x".
    for (const t of ["a", "x", "shift+a", "ctrl+shift+a", "1", "ctrl+0", "ctrl+alt+1", "shift+1", "space", "shift+space", "super+x", "cmd+x", "meta+x", ";", "+"]) {
      expect(isKeyToken(t), t).toBe(false);
    }
  });

  it("refuses hc's other spellings, odd orders, repeats and anything not a token", () => {
    // hc itself refuses ctrl+i and ctrl+m (the rig pressed every token): they are tab and enter.
    for (const t of ["ctrl+i", "ctrl+m", "Escape", "ESC", "escape", "Ctrl+C", "ctrl+C", "C-c", "ctrl-c", "pgup", "del", "return", "shift+ctrl+tab", "alt+ctrl+x", "ctrl+ctrl+c", "f13", "f0", "", "ctrl+", "--force", "-x", "up up", "$(id)", "ctrl+é", "esc\n", " esc"]) {
      expect(isKeyToken(t), JSON.stringify(t)).toBe(false);
    }
    for (const v of [undefined, null, 1, ["esc"], { k: "esc" }]) expect(isKeyToken(v)).toBe(false);
  });

  it("allKeyTokens lists exactly the accepted tokens, each once", () => {
    const all = allKeyTokens();
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((t) => isKeyToken(t))).toBe(true);
    expect(all).toContain("shift+tab");
    expect(all).toContain("alt+9");
    expect(all.length).toBe(8 * bridgeApi.KEY_NAMES.length + 3 * 27 - 2 + 10);
  });

  it("labels are plain text of 1 to 24 characters", () => {
    const ok = (s: unknown) => bridgeApi.KeyLabel.safeParse(s).success;
    expect(ok("Ctrl-C")).toBe(true);
    expect(ok("↑ Up")).toBe(true);
    expect(ok("x".repeat(24))).toBe(true);
    expect(ok("😀".repeat(24))).toBe(true);
    for (const bad of ["", " Esc", "Esc ", "x".repeat(25), "a\nb", "a\u0007b", "a\u202eb", "a\u200bb", "a\u2028b", "\ufeffEsc", "a\u061cb", "a\ufff9b", "a\u{e0041}b", "a\u034fb", "a\u180eb", 3]) expect(ok(bad), JSON.stringify(bad)).toBe(false);
  });

  it("KeysTopic: unique ids, bounded entries and keys, valid rev", () => {
    const entry = (id: string, keys = ["esc"]) => ({ id, label: "Esc", keys });
    const rev = "0123456789abcdef";
    const ok = (v: unknown) => bridgeApi.KeysTopic.safeParse(v).success;
    expect(ok({ rev, keys: [entry("esc"), entry("tab", ["tab"])] })).toBe(true);
    expect(ok({ rev, keys: [] })).toBe(true);
    expect(ok({ rev, keys: [entry("esc"), entry("esc")] })).toBe(false);
    expect(ok({ rev, keys: [entry("esc", [])] })).toBe(false);
    expect(ok({ rev, keys: [entry("esc", Array(9).fill("up"))] })).toBe(false);
    expect(ok({ rev, keys: [entry("esc", ["a"])] })).toBe(false);
    expect(ok({ rev, keys: Array.from({ length: 33 }, (_, i) => entry(`k${i}`)) })).toBe(false);
    expect(ok({ rev: "XYZ", keys: [] })).toBe(false);
    expect(ok({ rev, keys: [{ ...entry("esc"), extra: 1 }] })).toBe(false);
  });

  it("TerminalKeysArgs names an entry and a rev, never keys", () => {
    const ok = (a: unknown) => bridgeApi.TerminalKeysArgs.safeParse(a).success;
    expect(ok({ terminal: "t3", key: "ctrl-c", rev: "0123456789abcdef" })).toBe(true);
    expect(ok({ terminal: "vps/t7", key: "up_up", rev: "0123456789abcdef" })).toBe(true);
    expect(ok({ terminal: "t3", key: "ctrl-c" })).toBe(false);
    expect(ok({ terminal: "t3", key: "ctrl+c", rev: "0123456789abcdef" })).toBe(false);
    expect(ok({ terminal: "t3", key: "Ctrl-C", rev: "0123456789abcdef" })).toBe(false);
    expect(ok({ terminal: "-t3", key: "esc", rev: "0123456789abcdef" })).toBe(false);
    expect(ok({ terminal: "t3", key: "esc", rev: "0123456789abcdef", keys: ["a"] })).toBe(false);
  });

  it("keys is a topic, and its snap payload is checked", () => {
    expect(bridgeApi.Topic.safeParse("keys").success).toBe(true);
    const snap = (data: unknown) => bridgeApi.ServerMessage.safeParse({ type: "snap", topic: "keys", epoch: "e1", seq: 1, data }).success;
    expect(snap({ rev: "0123456789abcdef", keys: [{ id: "esc", label: "Esc", keys: ["esc"] }] })).toBe(true);
    expect(snap({ rev: "0123456789abcdef", keys: [{ id: "esc", label: "Esc", keys: ["a"] }] })).toBe(false);
  });
});
