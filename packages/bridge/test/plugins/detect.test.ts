import { describe, expect, it } from "vitest";
import { detectHc, detectHost, detectInbox, detectPanorama, detectUsage, parseVersion } from "../../src/plugins/detect.js";
import { run } from "../../src/plugins/exec.js";
import { bins, fakeCli, feed, NOW, panoramaHome, sha, tmp } from "./helpers.js";

const env = (appHome: string, binaries = bins(tmp())) => ({ appHome, run, binaries, now: () => NOW });

describe("hc (fake CLI)", () => {
  it.each([
    ["ready", 'echo "hc 0.4.2"', "ready"],
    ["exactly the minimum", 'echo "hc 0.1.0"', "ready"],
    ["too_old", 'echo "hc 0.0.9"', "too_old"],
    ["broken: no version", 'echo "hc dev"', "broken"],
    ["broken: nonzero", "exit 3", "broken"],
  ])("%s", async (_n, body, state) => {
    const d = tmp();
    expect((await detectHc(env("/none", bins(d, { hc: fakeCli(d, "hc", body) })))).state).toBe(state);
  });
  it("missing when not installed", async () => {
    expect((await detectHc(env("/none"))).state).toBe("missing");
  });
  it("broken when it hangs past the timeout", async () => {
    const d = tmp();
    const slow = { ...env("/none", bins(d, { hc: fakeCli(d, "hc", "sleep 5") })), run: (c: string, a: string[]) => run(c, a, { timeoutMs: 100 }) };
    expect((await detectHc(slow)).state).toBe("broken");
  });
  it("parses versions", () => {
    expect(parseVersion("hc v1.22.3-rc1")).toEqual([1, 22, 3]);
    expect(parseVersion("nope")).toBeUndefined();
  });
});

describe("inbox (fake CLI)", () => {
  const case_ = async (body: string) => {
    const d = tmp();
    return detectInbox(env("/none", bins(d, { inbox: fakeCli(d, "herdr-inbox", body) })));
  };
  it("ready on the v1 probe line", async () => {
    expect((await case_('printf "herdr-inbox app v1\\nusage: ...\\n"')).state).toBe("ready");
  });
  it("too_old when an older inbox prints its own version and exits 0", async () => {
    expect((await case_('echo "herdr-inbox 0.9.0"')).state).toBe("too_old");
  });
  it("too_old when `app` is unknown", async () => {
    expect((await case_('echo "unknown command" >&2; exit 2')).state).toBe("too_old");
  });
  it("broken for a newer protocol", async () => {
    expect((await case_('echo "herdr-inbox app v2"')).state).toBe("broken");
  });
  it("missing when not installed", async () => {
    expect((await detectInbox(env("/none"))).state).toBe("missing");
  });
  it("only the first line counts", async () => {
    expect((await case_('printf "herdr-inbox app v1 extra\\n"')).state).toBe("too_old");
  });
});

describe("usage (fake CLI)", () => {
  const case_ = async (body: string) => {
    const d = tmp();
    return detectUsage(env("/none", bins(d, { usagebar: fakeCli(d, "usagebar", body) })));
  };
  it("ready on version 1", async () => {
    expect((await case_(`echo '{"version":1,"providers":[]}'`)).state).toBe("ready");
  });
  it("too_old when --format is rejected", async () => {
    expect((await case_('echo "flag provided but not defined: -format" >&2; exit 2')).state).toBe("too_old");
  });
  it("too_old when the unversioned shape comes back", async () => {
    expect((await case_(`echo '{"providers":[]}'`)).state).toBe("too_old");
  });
  it("broken for a newer format, bad JSON, or a failure", async () => {
    expect((await case_(`echo '{"version":2}'`)).state).toBe("broken");
    expect((await case_("echo not-json")).state).toBe("broken");
    expect((await case_("echo boom >&2; exit 1")).state).toBe("broken");
  });
  it("passes the documented arguments", async () => {
    const d = tmp();
    const bin = fakeCli(d, "usagebar", `[ "$*" = 'collect --format v1 --quotas-only --panes []' ] && echo '{"version":1}' || exit 9`);
    expect((await detectUsage(env("/none", bins(d, { usagebar: bin })))).state).toBe("ready");
  });
  it("missing when not installed", async () => {
    expect((await detectUsage(env("/none"))).state).toBe("missing");
  });
});

describe("panorama (receipt, hash, feed)", () => {
  it("ready with a fresh v2 feed", async () => {
    expect(await detectPanorama(env(panoramaHome()))).toEqual({ state: "ready" });
  });
  it("missing without a receipt", async () => {
    expect((await detectPanorama(env(panoramaHome({ receipt: "none" })))).state).toBe("missing");
  });
  it("broken for an unreadable receipt", async () => {
    expect((await detectPanorama(env(panoramaHome({ receipt: "bad" })))).state).toBe("broken");
  });
  it("broken when contract.js does not match the receipt hash", async () => {
    const r = await detectPanorama(env(panoramaHome({ pinned: sha("something else") })));
    expect(r.state).toBe("broken");
    expect(r.detail).toMatch(/does not match/);
  });
  it("broken when contract.js lacks the exports", async () => {
    expect((await detectPanorama(env(panoramaHome({ contract: "export const x = 1;\n" })))).state).toBe("broken");
  });
  it("not_running without a feed", async () => {
    expect((await detectPanorama(env(panoramaHome({ feed: null })))).state).toBe("not_running");
  });
  it("stale when the feed is older than 15 s", async () => {
    expect((await detectPanorama(env(panoramaHome({ feed: feed({ generated_at: NOW / 1000 - 16 }) })))).state).toBe("stale");
    expect((await detectPanorama(env(panoramaHome({ feed: feed({ generated_at: NOW / 1000 - 14 }) })))).state).toBe("ready");
  });
  it("too_old for a v1 feed, broken for v3, non-JSON or contract failure", async () => {
    expect((await detectPanorama(env(panoramaHome({ feed: feed({ v: 1 }) })))).state).toBe("too_old");
    expect((await detectPanorama(env(panoramaHome({ feed: feed({ v: 3 }) })))).state).toBe("broken");
    expect((await detectPanorama(env(panoramaHome({ feed: "{nope" })))).state).toBe("broken");
    expect((await detectPanorama(env(panoramaHome({ feed: feed({ roots: "x" }) })))).state).toBe("broken");
  });
});

describe("host", () => {
  it.each([
    [{ hasState: true, stale: null }, "ready"],
    [{ hasState: false, stale: null }, "not_running"],
    [{ hasState: true, stale: "reconnecting" }, "stale"],
    [{ hasState: false, stale: "reconnecting" }, "not_running"],
    [{ hasState: true, stale: "layout_without_remote" }, "not_running"],
    [{ hasState: true, stale: "source_unavailable" }, "broken"],
  ])("%j -> %s", (v, state) => {
    expect(detectHost(v).state).toBe(state);
  });
});
