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
});
