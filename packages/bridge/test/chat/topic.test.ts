import { readFileSync } from "node:fs";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { CHAT_INTERVAL_MS, CHAT_READ_TIMEOUT_MS, ChatTopicDriver, MAX_ACTIVE_CHATS, failureReason, terminalIds } from "../../src/chat/topic.js";
import { run, type Runner, type RunResult } from "../../src/plugins/exec.js";
import { join as joinHub, newHub } from "../helpers.js";
import { bins, tmp } from "../plugins/helpers.js";

const fx = (n: string) => readFileSync(new URL(`../fixtures/hc/${n}`, import.meta.url), "utf8");
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

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

/** A fake hc that replays the recorded-shape fixtures. */
const replay = (over: Partial<Record<"ls" | "read", RunResult>> = {}) =>
  stub((c) => (c.args[0] === "ls" ? over.ls ?? ok(fx("ls.json")) : over.read ?? ok(fx("read-agent.ansi"))));

let driver: ChatTopicDriver | undefined;
afterEach(() => {
  driver?.stop();
  driver = undefined;
  vi.useRealTimers();
});

function setup(runner: Runner, over: Partial<ConstructorParameters<typeof ChatTopicDriver>[0]> = {}) {
  const hub = newHub();
  driver = new ChatTopicDriver({ hub, run: runner, ...over });
  driver.start();
  return hub;
}

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};
const sub = async (hub: ReturnType<typeof newHub>, ...topics: string[]) => {
  const c = await joinHub(hub);
  await c.send({ type: "sub", topics });
  await settle();
  return c;
};

describe("terminalIds", () => {
  it("reads the addresses hc 0.1.20 prints (recorded in the rig)", () => {
    // The regression: these were read as no ids at all, so every chat was "terminal_not_found" and never read.
    expect(terminalIds(fx("ls-0.1.20.json"))).toEqual(new Set(["t1", "t2", "t3", "agent-one", "agent-two", "agent-three"]));
  });

  it("reads a list or a wrapped list, and gives null for anything else", () => {
    expect([...(terminalIds(fx("ls.json")) ?? [])]).toEqual(["t3", "agent-one", "t4", "vps/t7"]);
    expect([...(terminalIds(fx("ls-without-t3.json")) ?? [])]).toEqual(["t4"]);
    expect(terminalIds("not json")).toBeNull();
    expect(terminalIds('{"x":1}')).toBeNull();
    expect(terminalIds('["t1"]')).toEqual(new Set(["t1"]));
    expect(terminalIds('[{"id":"t1"}]')).toEqual(new Set(["t1"]));
  });
});

describe("failureReason", () => {
  it("names hc missing, a terminal hc does not know, and the rest", () => {
    expect(failureReason({ code: null, stdout: "", stderr: "", error: "ENOENT" })).toBe("hc_missing");
    expect(failureReason({ code: null, stdout: "", stderr: "", error: "timeout" })).toBe("source_unavailable");
    expect(failureReason({ code: 3, stdout: "", stderr: fx("read-not-found-0.1.20.json") })).toBe("terminal_not_found");
    expect(failureReason({ code: 1, stdout: "", stderr: '{"error":{"kind":"unavailable"}}' })).toBe("source_unavailable");
    expect(failureReason({ code: 1, stdout: "", stderr: "not json" })).toBe("source_unavailable");
  });
});

describe("ChatTopicDriver", () => {
  it("does nothing until a client subscribes", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    setup(runner);
    await settle(5000);
    expect(calls).toEqual([]);
  });

  it("reads the terminal with exactly `hc read <t> --lines N` and snaps the spans", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    const hub = setup(runner);
    const c = await sub(hub, "chat:t3");
    expect(calls.map((x) => x.args)).toEqual([["ls", "--json"], ["read", "t3", "--lines", "200"]]);
    const snap = c.client.ofType("snap").find((m) => m.topic === "chat:t3");
    const data = bridgeApi.ChatTopic.parse(snap?.data);
    expect(data.terminal).toBe("t3");
    expect(data.lines[0]?.[0]).toEqual({ t: "●", b: true });
    expect(bridgeApi.ServerMessage.safeParse(snap).success).toBe(true);
  });

  it("reads the recorded hc 0.1.20 output end to end: ls by address, then read", async () => {
    vi.useFakeTimers();
    const { calls, runner } = stub((c) => ok(c.args[0] === "ls" ? fx("ls-0.1.20.json") : fx("read-0.1.20.txt")));
    const hub = setup(runner);
    const c = await sub(hub, "chat:t1");
    expect(calls.map((x) => x.args)).toEqual([["ls", "--json"], ["read", "t1", "--lines", "200"]]);
    expect(hub.isStale("chat:t1")).toBeNull();
    const data = bridgeApi.ChatTopic.parse(c.client.ofType("snap").find((m) => m.topic === "chat:t1")?.data);
    expect(data.lines.map((l) => l.map((s) => s.t).join(""))).toEqual([
      "* agent-one: I split the parser into three passes.",
      "  +84 -212 src/parse/mod.rs",
      "agent-one says: tests pass, 212 passed",
    ]);
  });

  it("polls once a second, patches only on change, and checks hc ls every third tick", async () => {
    vi.useFakeTimers();
    let text = fx("read-agent.ansi");
    const { calls, runner } = stub((c) => (c.args[0] === "ls" ? ok(fx("ls.json")) : ok(text)));
    const hub = setup(runner);
    const c = await sub(hub, "chat:t3");
    await settle(CHAT_INTERVAL_MS);
    expect(c.client.ofType("patch")).toHaveLength(0);
    text += "more output\n";
    await settle(CHAT_INTERVAL_MS);
    expect(c.client.ofType("patch")).toHaveLength(1);
    await settle(CHAT_INTERVAL_MS * 8);
    expect(calls.filter((x) => x.args[0] === "ls")).toHaveLength(4);
    expect(calls.filter((x) => x.args[0] === "read")).toHaveLength(11);
  });

  it("stops polling and forgets the topic when the last subscriber goes", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    const hub = setup(runner);
    const a = await sub(hub, "chat:t3");
    const b = await sub(hub, "chat:t3");
    hub.disconnect(a.conn);
    await settle(CHAT_INTERVAL_MS);
    expect(driver?.activeTopics).toEqual(["chat:t3"]);
    hub.disconnect(b.conn);
    const n = calls.length;
    await settle(CHAT_INTERVAL_MS * 5);
    expect(calls.length).toBe(n);
    expect(driver?.activeTopics).toEqual([]);
    expect(hub.get("chat:t3")).toBeUndefined();
    expect(hub.topicCount).toBe(0);
  });

  it("goes stale on a failing read, backs off, and recovers with a fresh snap", async () => {
    vi.useFakeTimers();
    let bad = false;
    const { calls, runner } = stub((c) => (c.args[0] === "ls" ? ok(fx("ls.json")) : bad ? { code: 1, stdout: "", stderr: "boom" } : ok(fx("read-agent.ansi"))));
    const hub = setup(runner);
    const c = await sub(hub, "chat:t3");
    bad = true;
    await settle(CHAT_INTERVAL_MS);
    expect(hub.isStale("chat:t3")).toBe("source_unavailable");
    expect(c.client.ofType("stale").map((s) => s.reason)).toEqual(["source_unavailable"]);
    // The last text stays, and the second failure waits twice as long.
    expect(hub.get("chat:t3")).toBeDefined();
    const n = calls.length;
    await settle(CHAT_INTERVAL_MS);
    expect(calls.length).toBe(n);
    await settle(CHAT_INTERVAL_MS);
    expect(calls.length).toBeGreaterThan(n);
    bad = false;
    await settle(CHAT_INTERVAL_MS * 8);
    expect(hub.isStale("chat:t3")).toBeNull();
    expect(c.client.ofType("snap").length).toBeGreaterThanOrEqual(2);
  });

  // Every way the first read can fail sends `stale` with no value yet: the phone shows it instead of waiting.
  it.each([
    ["hc missing (ls)", { ls: { code: null, stdout: "", stderr: "", error: "ENOENT" } }, "hc_missing", false],
    ["ls times out", { ls: { code: null, stdout: "", stderr: "", error: "timeout" } }, "source_unavailable", false],
    ["ls fails", { ls: { code: 1, stdout: "", stderr: '{"error":{"kind":"unavailable","message":"no core"}}' } }, "source_unavailable", false],
    ["id not in ls", { ls: ok(fx("ls-without-t3.json")) }, "terminal_not_found", false],
    ["read: no such terminal", { read: { code: 3, stdout: "", stderr: fx("read-not-found-0.1.20.json") } }, "terminal_not_found", true],
    ["read fails", { read: { code: 1, stdout: "", stderr: "boom" } }, "source_unavailable", true],
    ["read times out", { read: { code: null, stdout: "", stderr: "", error: "timeout" } }, "source_unavailable", true],
    ["hc missing (read)", { read: { code: null, stdout: "", stderr: "", error: "ENOENT" } }, "hc_missing", true],
    ["ls is not JSON and read fails", { ls: ok("garbage"), read: { code: 1, stdout: "", stderr: "" } }, "source_unavailable", true],
  ] as const)("%s: stale %s before any value, at the first tick", async (_name, over, reason, reads) => {
    vi.useFakeTimers();
    const { calls, runner } = replay(over as Partial<Record<"ls" | "read", RunResult>>);
    const hub = setup(runner);
    const c = await sub(hub, "chat:t3");
    expect(hub.get("chat:t3")).toBeUndefined();
    expect(hub.isStale("chat:t3")).toBe(reason);
    expect(c.client.ofType("stale")).toEqual([{ type: "stale", topic: "chat:t3", reason }]);
    expect(calls.some((x) => x.args[0] === "read")).toBe(reads);
    // A late subscriber hears it at once too.
    const late = await sub(hub, "chat:t3");
    expect(late.client.ofType("stale").map((m) => m.reason)).toEqual([reason]);
  });

  it("a hung hc shows as stale within one command timeout", async () => {
    vi.useFakeTimers();
    // The real runner resolves `timeout` at its deadline; this stand-in does the same on fake time.
    const runner: Runner = (_cmd, _args, { timeoutMs }) => new Promise((r) => setTimeout(() => r({ code: null, stdout: "", stderr: "", error: "timeout" }), timeoutMs));
    const hub = setup(runner);
    await sub(hub, "chat:t3");
    expect(hub.isStale("chat:t3")).toBeNull();
    await settle(CHAT_READ_TIMEOUT_MS);
    expect(hub.isStale("chat:t3")).toBe("source_unavailable");
    expect(CHAT_READ_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("notices a terminal that closed under an open chat within three ticks", async () => {
    vi.useFakeTimers();
    let listed = true;
    const { runner } = stub((c) => ok(c.args[0] === "ls" ? fx(listed ? "ls.json" : "ls-without-t3.json") : fx("read-agent.ansi")));
    const hub = setup(runner);
    await sub(hub, "chat:t3");
    listed = false;
    await settle(CHAT_INTERVAL_MS * 3);
    expect(hub.isStale("chat:t3")).toBe("terminal_not_found");
    // The last text stays for the phone to show under the notice.
    expect(hub.get("chat:t3")).toBeDefined();
  });

  it("runs the hc it was given (the resolved absolute path)", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    const hub = setup(runner, { binaries: { hc: "/abs/bin/hc", inbox: "herdr-inbox", usagebar: "usagebar" } });
    await sub(hub, "chat:t3");
    expect(new Set(calls.map((x) => x.cmd))).toEqual(new Set(["/abs/bin/hc"]));
  });

  it("says terminal_not_found when hc ls lacks the terminal, and does not read it", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay({ ls: ok(fx("ls-without-t3.json")) });
    const hub = setup(runner);
    await sub(hub, "chat:t3");
    expect(hub.isStale("chat:t3")).toBe("terminal_not_found");
    expect(calls.some((x) => x.args[0] === "read")).toBe(false);
  });

  it("still reads when hc ls output is not understood (its shape is unverified)", async () => {
    vi.useFakeTimers();
    const { runner } = replay({ ls: ok("t3  Agent 1\n") });
    const hub = setup(runner);
    await sub(hub, "chat:t3");
    expect(hub.get("chat:t3")).toBeDefined();
  });

  it.each(["chat:--help", "chat:-x", "chat:a b", "chat:t3;rm", "chat:../x", "chat:" + "a".repeat(80)])("never runs hc for %j", async (topic) => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    const hub = setup(runner);
    await sub(hub, topic);
    await settle(3000);
    expect(calls).toEqual([]);
    expect(hub.isStale(topic)).toBe("bad_terminal");
  });

  it("accepts a remote machine terminal id", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    const hub = setup(runner);
    await sub(hub, "chat:vps/t7");
    expect(calls[1]?.args).toEqual(["read", "vps/t7", "--lines", "200"]);
  });

  it("caps the chats read at once", async () => {
    vi.useFakeTimers();
    const { runner } = replay({ ls: ok("[]") });
    const hub = setup(runner);
    const topics = Array.from({ length: MAX_ACTIVE_CHATS + 1 }, (_, i) => `chat:t${i}`);
    await sub(hub, ...topics);
    expect(driver?.activeTopics).toHaveLength(MAX_ACTIVE_CHATS);
    expect(hub.isStale(topics[MAX_ACTIVE_CHATS]!)).toBe("too_many_chats");
  });

  it("reads a chat that was over the cap once a slot frees", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay({ ls: ok('["t0","t1","t2","t3","t4","t5","t9"]') });
    const hub = setup(runner);
    const subs = [];
    for (let i = 0; i < MAX_ACTIVE_CHATS; i++) subs.push(await sub(hub, `chat:t${i}`));
    await sub(hub, "chat:t9");
    expect(hub.isStale("chat:t9")).toBe("too_many_chats");
    expect(calls.some((c) => c.args[1] === "t9")).toBe(false);
    hub.disconnect(subs[0]!.conn);
    await settle();
    expect(driver?.activeTopics).toContain("chat:t9");
    expect(hub.isStale("chat:t9")).toBeNull();
    expect(hub.get("chat:t9")).toBeDefined();
  });

  it("stop() leaves nothing polling, even with chats waiting for a slot", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay({ ls: ok("[]") });
    const hub = setup(runner);
    for (let i = 0; i <= MAX_ACTIVE_CHATS; i++) await sub(hub, `chat:t${i}`);
    driver?.stop();
    expect(driver?.activeTopics).toEqual([]);
    const n = calls.length;
    await settle(CHAT_INTERVAL_MS * 10);
    expect(calls.length).toBe(n);
  });

  it("never sends input: only ls and read reach hc", async () => {
    vi.useFakeTimers();
    const { calls, runner } = replay();
    const hub = setup(runner);
    const c = await sub(hub, "chat:t3");
    await c.send({ type: "act", id: "1", kind: "terminal.send", args: { terminal: "t3", text: "x" } });
    await settle(CHAT_INTERVAL_MS * 3);
    expect(new Set(calls.map((x) => x.args[0]))).toEqual(new Set(["ls", "read"]));
    expect(c.client.ofType("res")[0]).toMatchObject({ ok: false, code: "unsupported_action" });
  });

  it("works through the real runner against a fake hc script", async () => {
    const dir = tmp("s15-hc-");
    const script = join(dir, "hc");
    writeFileSync(
      script,
      `#!/bin/sh\ncase "$1" in\n  ls) cat '${new URL("../fixtures/hc/ls.json", import.meta.url).pathname}';;\n  read) [ "$2" = t3 ] && [ "$3" = --lines ] && cat '${new URL("../fixtures/hc/read-agent.ansi", import.meta.url).pathname}';;\n  *) exit 9;;\nesac\n`,
    );
    chmodSync(script, 0o755);
    const hub = newHub();
    driver = new ChatTopicDriver({ hub, run, binaries: bins(dir, { hc: script }), intervalMs: 20 });
    driver.start();
    const c = await joinHub(hub);
    await c.send({ type: "sub", topics: ["chat:t3"] });
    await vi.waitFor(() => expect(hub.get("chat:t3")).toBeDefined(), { timeout: 3000 });
    const data = bridgeApi.ChatTopic.parse(hub.get("chat:t3"));
    expect(data.lines.flat().some((s) => s.t.includes("Tests pass"))).toBe(true);
  });
});
