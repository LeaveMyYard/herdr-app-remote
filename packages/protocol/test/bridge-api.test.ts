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
