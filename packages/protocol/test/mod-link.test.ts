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
