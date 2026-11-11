import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import type { Runner, RunResult } from "../src/plugins/exec.js";
import { run } from "../src/plugins/exec.js";
import { normalizeReport, panesArg, tilde, UsageTopicDriver, USAGE_INTERVAL_MS } from "../src/usage.js";
import { fixture, join, newHub } from "./helpers.js";
import { bins, fakeCli, tmp } from "./plugins/helpers.js";

const RAW = readFileSync(new URL("./fixtures/collect-v1.json", import.meta.url), "utf8");
const HOME = "/home/user-1";
const okRun = (stdout = RAW): RunResult => ({ code: 0, stdout, stderr: "" });

interface Call {
  cmd: string;
  args: string[];
}

function stub(reply: (call: Call, n: number) => RunResult | Promise<RunResult>) {
  const calls: Call[] = [];
  const runner: Runner = async (cmd, args) => {
    const call = { cmd, args };
    calls.push(call);
    return reply(call, calls.length);
  };
  return { calls, runner };
}

let driver: UsageTopicDriver | undefined;
afterEach(() => {
  driver?.stop();
  driver = undefined;
  vi.useRealTimers();
});

function setup(runner: Runner, over: Partial<ConstructorParameters<typeof UsageTopicDriver>[0]> = {}) {
  const hub = newHub();
  driver = new UsageTopicDriver({ hub, run: runner, home: HOME, now: () => 1_793_722_500_000, ...over });
  driver.start();
  return { hub, driver };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const topic = (hub: ReturnType<typeof newHub>) => bridgeApi.UsageTopic.parse(hub.get("usage"));

describe("panesArg", () => {
  it("maps the host's agents to --panes entries, with usagebar's agent ids", () => {
    const host = fixture("typical") as { agents: { id: string; terminal_id?: string; name: string; harness: string }[] };
    const parsed = JSON.parse(panesArg(host)) as { paneId: string; agent: string; label: string }[];
    expect(parsed.length).toBe(host.agents.length);
    expect(parsed[0]).toEqual({ paneId: host.agents[0]?.terminal_id ?? host.agents[0]?.id, agent: host.agents[0]?.harness, label: host.agents[0]?.name });
    const aliased = { ...host, agents: [{ ...host.agents[0]!, harness: "antigravity" }, { ...host.agents[0]!, id: "x2", harness: "cursor-agent" }] };
    expect((JSON.parse(panesArg(aliased)) as { agent: string }[]).map((p) => p.agent)).toEqual(["agy", "cursor"]);
  });
  it("is an empty array before there is a host state", () => {
    expect(panesArg(undefined)).toBe("[]");
    expect(panesArg({ nope: 1 })).toBe("[]");
  });
});

describe("tilde", () => {
  it("abbreviates only paths inside the home directory", () => {
    expect(tilde("/home/user-1/.codex", HOME)).toBe("~/.codex");
    expect(tilde("/home/user-10/.codex", HOME)).toBe("/home/user-10/.codex");
    expect(tilde("claude statusLine cache", HOME)).toBe("claude statusLine cache");
  });
});

describe("normalizeReport", () => {
  const raw = JSON.parse(RAW) as unknown;
  it("keeps what the screen draws and drops the rest", () => {
    const n = normalizeReport(raw, HOME);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.report).not.toHaveProperty("watchDirs");
    expect(n.report).not.toHaveProperty("apiUsage");
    expect(n.report.providers[0]).not.toHaveProperty("paneActivity");
    expect(n.report.providers[0]).not.toHaveProperty("home");
    expect(n.report.providers[0]?.windows[0]).not.toHaveProperty("resetsAt");
    expect(n.report.providers[0]?.windows[0]?.runOut).toEqual({ text: "empty in ~18h 56m" } satisfies { text: string });
  });
  it("abbreviates home paths in identity (emails are left alone) and source", () => {
    const n = normalizeReport(raw, HOME);
    if (!n.ok) throw new Error("expected ok");
    const claudeDir = normalizeReport({ ...(raw as object), providers: [{ ...(raw as { providers: object[] }).providers[0], identity: "/home/user-1/.claude-1" }] }, HOME);
    expect(claudeDir.ok && claudeDir.report.providers[0]?.identity).toBe("~/.claude-1");
    expect(n.report.providers.map((p) => p.identity)).toEqual(["user-1@example.com", "~/.codex"]);
    expect(n.report.providers[0]?.source).toBe("~/.claude-1/herdr-usagebar/cache.json");
  });
  it("rejects another version as unsupported and bad documents as bad_output", () => {
    expect(normalizeReport({ version: 2 }, HOME)).toEqual({ ok: false, error: "unsupported" });
    expect(normalizeReport({ version: 1, providers: "x" }, HOME)).toEqual({ ok: false, error: "bad_output" });
    expect(normalizeReport(null, HOME)).toEqual({ ok: false, error: "bad_output" });
  });
});

describe("usage topic polling", () => {
  it("runs nothing until a client subscribes, then collects at once with the panes of the host topic", async () => {
    const { calls, runner } = stub(() => okRun());
    const { hub } = setup(runner);
    hub.publish("host", fixture("typical"));
    await settle();
    expect(calls).toHaveLength(0);
    expect(driver?.isPolling).toBe(false);
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["usage"] });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 3)).toEqual(["collect", "--format", "v1"]);
    expect(calls[0]?.args).not.toContain("--all");
    expect(JSON.parse(calls[0]!.args[calls[0]!.args.indexOf("--panes") + 1]!)).toHaveLength((fixture("typical") as { agents: unknown[] }).agents.length);
    const snaps = c.client.ofType("snap").filter((s) => s.topic === "usage");
    expect(snaps).toHaveLength(1);
    expect(topic(hub).report?.providers).toHaveLength(2);
    expect(topic(hub).updatedAtMs).toBe(1_793_722_500_000);
  });

  it("collects every 15 s while subscribed and stops when the last client leaves", async () => {
    vi.useFakeTimers();
    const { calls, runner } = stub(() => okRun());
    const { hub } = setup(runner);
    const a = await join(hub);
    const b = await join(hub);
    await a.send({ type: "sub", topics: ["usage"] });
    await b.send({ type: "sub", topics: ["usage"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    hub.disconnect(a.conn);
    await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS);
    expect(calls).toHaveLength(3);
    hub.disconnect(b.conn);
    expect(driver?.isPolling).toBe(false);
    await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS * 4);
    expect(calls).toHaveLength(3);
  });

  it("does not stack collects: a slow one is shared by the next tick", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const { calls, runner } = stub(() => new Promise<RunResult>((r) => (release = () => r(okRun()))));
    const { hub } = setup(runner);
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["usage"] });
    await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS * 3);
    expect(calls).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.get("usage")).toBeDefined();
  });

  it("never runs usagebar notify, and gives collect a 10 s timeout", async () => {
    const timeouts: number[] = [];
    const { calls, runner } = stub(() => okRun());
    const { hub } = setup(async (cmd, args, o) => {
      timeouts.push(o.timeoutMs);
      return runner(cmd, args, o);
    });
    await driver?.act("usage.refresh", {});
    await driver?.act("usage.set_filter", { filter: "all" });
    expect(hub.get("usage")).toBeDefined();
    expect(calls.every((c) => c.args[0] === "collect")).toBe(true);
    expect(calls.flatMap((c) => c.args)).not.toContain("notify");
    expect(new Set(timeouts)).toEqual(new Set([10_000]));
  });

  it("sends a patch, not a snap, when only the numbers change", async () => {
    let n = 0;
    const { runner } = stub(() => {
      n += 1;
      const doc = JSON.parse(RAW) as { providers: { windows: { displayPercent: number }[] }[] };
      doc.providers[0]!.windows[0]!.displayPercent = 15 - n;
      return okRun(JSON.stringify(doc));
    });
    const { hub } = setup(runner);
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["usage"] });
    await settle();
    await driver?.refresh();
    expect(c.client.ofType("snap").filter((s) => s.topic === "usage")).toHaveLength(1);
    const patches = c.client.ofType("patch").filter((p) => p.topic === "usage");
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.some((p) => p.ops.some((o) => o.path.includes("displayPercent")))).toBe(true);
  });
});

describe("usage topic failures", () => {
  const cases: [string, RunResult, bridgeApi.UsageError][] = [
    ["not installed", { code: null, stdout: "", stderr: "", error: "ENOENT" }, "unavailable"],
    ["spawn failure", { code: null, stdout: "", stderr: "", error: "other" }, "unavailable"],
    ["timeout", { code: null, stdout: "", stderr: "", error: "timeout" }, "timeout"],
    ["non-zero exit", { code: 2, stdout: "", stderr: "boom /home/user-1/secret" }, "failed"],
    ["invalid JSON", { code: 0, stdout: "{nope", stderr: "" }, "bad_output"],
    ["wrong shape", { code: 0, stdout: '{"version":1,"providers":3}', stderr: "" }, "bad_output"],
    ["another version", { code: 0, stdout: '{"version":2}', stderr: "" }, "unsupported"],
  ];
  it.each(cases)("maps %s to an error code and publishes it with no report", async (_n, result, code) => {
    const { runner } = stub(() => result);
    const { hub } = setup(runner);
    await driver?.refresh();
    expect(topic(hub)).toEqual({ filter: "open-panes", report: null, updatedAtMs: null, error: code });
  });

  it.each(cases)("keeps the last good report when a later collect fails: %s", async (_n, result, code) => {
    let fail = false;
    const { runner } = stub(() => (fail ? result : okRun()));
    const { hub } = setup(runner);
    await driver?.refresh();
    const good = topic(hub);
    expect(good.report).not.toBeNull();
    fail = true;
    await driver?.refresh();
    expect(topic(hub)).toEqual({ ...good, error: code });
    fail = false;
    await driver?.refresh();
    expect(topic(hub).error).toBeUndefined();
  });

  it("times out a hung CLI after timeoutMs (real runner, fake CLI)", async () => {
    const d = tmp();
    const { hub } = setup(run, { binaries: bins(d, { usagebar: fakeCli(d, "usagebar", "exec sleep 5") }), timeoutMs: 150 });
    await driver?.refresh();
    expect(topic(hub).error).toBe("timeout");
  });

  it("collects through the real runner from a fake CLI that logs its arguments", async () => {
    const d = tmp();
    const log = `${d}/args.log`;
    const cli = fakeCli(d, "usagebar", `echo "$@" >> ${log}\ncat <<'JSON'\n${RAW}\nJSON`);
    const { hub } = setup(run, { binaries: bins(d, { usagebar: cli }) });
    await driver?.refresh();
    expect(topic(hub).report?.providers.map((p) => p.providerId)).toEqual(["claude-1", "codex"]);
    expect(readFileSync(log, "utf8").trim()).toBe("collect --format v1 --panes []");
  });
});

describe("usage acts", () => {
  it("usage.refresh collects now and reports a failure as a code", async () => {
    let n = 0;
    const { calls, runner } = stub(() => (++n === 1 ? okRun() : { code: 1, stdout: "", stderr: "" }));
    setup(runner);
    expect(await driver?.act("usage.refresh", {})).toEqual({ ok: true });
    expect(await driver?.act("usage.refresh", {})).toEqual({ ok: false, code: "failed" });
    expect(calls).toHaveLength(2);
  });

  it("usage.set_filter switches to --all, clears the old report at once, and collects", async () => {
    const { calls, runner } = stub(() => okRun());
    const { hub } = setup(runner);
    await driver?.refresh();
    const c = await join(hub);
    await c.send({ type: "sub", topics: ["usage"] });
    c.client.got.length = 0;
    expect(await driver?.act("usage.set_filter", { filter: "all" })).toEqual({ ok: true });
    expect(calls.at(-1)?.args).toContain("--all");
    const patches = c.client.ofType("patch").filter((p) => p.topic === "usage");
    // First the cleared state under the new filter, then the new report.
    expect(patches[0]?.ops).toEqual(expect.arrayContaining([{ op: "replace", path: "/filter", value: "all" }, { op: "replace", path: "/report", value: null }]));
    expect(topic(hub).report).not.toBeNull();
  });

  it("drops a collect that started under the old filter", async () => {
    let release: () => void = () => undefined;
    const docs = { old: JSON.stringify({ ...(JSON.parse(RAW) as object), filter: "open-panes" }), all: RAW };
    const { runner } = stub((call) =>
      call.args.includes("--all") ? okRun(docs.all) : new Promise<RunResult>((r) => (release = () => r(okRun(docs.old)))),
    );
    const { hub } = setup(runner);
    const published: (string | undefined)[] = [];
    const orig = hub.publish.bind(hub);
    hub.publish = (name, data) => {
      published.push((data as bridgeApi.UsageTopic).report?.filter);
      orig(name, data);
    };
    const slow = driver!.refresh();
    const switching = driver!.act("usage.set_filter", { filter: "all" });
    await settle();
    release();
    await slow;
    await switching;
    expect(topic(hub).filter).toBe("all");
    expect(topic(hub).report?.filter).toBe("all");
    // The old collect's report never reaches the topic.
    expect(published).not.toContain("open-panes");
  });

  it("refuses a bad filter and ignores kinds that are not its own", async () => {
    const { calls, runner } = stub(() => okRun());
    setup(runner);
    expect(await driver?.act("usage.set_filter", { filter: "nope" })).toEqual({ ok: false, code: "bad_args" });
    expect(await driver?.act("chat.send", {})).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
