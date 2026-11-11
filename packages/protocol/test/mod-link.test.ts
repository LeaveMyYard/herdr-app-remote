import { describe, expect, it } from "vitest";
import { modLink } from "../src/index.js";

describe("mod-link", () => {
  it("parseLine accepts a valid NDJSON line", () => {
    const r = modLink.parseLine(modLink.BridgeToMod, '{"type":"ping"}');
    expect(r.success).toBe(true);
  });

  it("parseLine reports invalid JSON instead of throwing", () => {
    const r = modLink.parseLine(modLink.BridgeToMod, "{nope");
    expect(r.success).toBe(false);
  });

  it("parseLine rejects a message in the wrong direction", () => {
    expect(modLink.parseLine(modLink.BridgeToMod, '{"type":"result","id":"x","ok":true}').success).toBe(false);
    expect(modLink.parseLine(modLink.ModToBridge, '{"type":"ping"}').success).toBe(false);
  });

  it("exposes the documented timing constants", () => {
    expect(modLink.RECONNECT_BACKOFF_MS).toEqual({ min: 500, max: 10_000 });
    expect(modLink.STATE_MIN_INTERVAL_MS).toBe(100);
  });
});

describe("panel acts", () => {
  const ID = "d-0000000000000001";
  it("accepts exactly the documented kinds and shapes", () => {
    expect(modLink.checkPanelAct("device.approve", { id: ID })).toEqual({ ok: true, kind: "device.approve", args: { id: ID } });
    expect(modLink.checkPanelAct("device.cap", { id: ID, cap: "terminal.input", on: true, minutes: 60 }).ok).toBe(true);
    expect(modLink.checkPanelAct("remote.pause", {}).ok).toBe(true);
  });
  it("refuses everything else: no run, no exec, no tab.new, no extra keys", () => {
    for (const k of ["run", "exec", "tab.new", "do", "__proto__", "constructor", "space.close"]) {
      expect(modLink.checkPanelAct(k, {})).toEqual({ ok: false, error: "unsupported_action" });
    }
    expect(modLink.checkPanelAct("device.approve", { id: ID, x: 1 })).toEqual({ ok: false, error: "bad_args" });
    expect(modLink.checkPanelAct("device.approve", { id: "x" })).toEqual({ ok: false, error: "bad_args" });
    expect(modLink.checkPanelAct("device.cap", { id: ID, cap: "navigate", on: true, minutes: 5 }).ok).toBe(false);
    expect(modLink.checkPanelAct("device.cap", { id: ID, cap: "terminal.input", on: true, minutes: 0 }).ok).toBe(false);
    expect(modLink.checkPanelAct("remote.pause", { force: true }).ok).toBe(false);
  });
  it("the run allowlist is unchanged: navigate only", () => {
    expect(modLink.RUN_ALLOWLIST).toEqual(["agent.focus", "pane.focus", "space.select", "tab.select"]);
  });
});
