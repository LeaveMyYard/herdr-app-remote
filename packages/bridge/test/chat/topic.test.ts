import { readFileSync } from "node:fs";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { CHAT_INTERVAL_MS, ChatTopicDriver, MAX_ACTIVE_CHATS, terminalIds } from "../../src/chat/topic.js";
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
  it("reads a list or a wrapped list, and gives null for anything else", () => {
    expect([...(terminalIds(fx("ls.json")) ?? [])]).toEqual(["t3", "t4", "vps/t7"]);
    expect([...(terminalIds(fx("ls-without-t3.json")) ?? [])]).toEqual(["t4"]);
    expect(terminalIds("not json")).toBeNull();
    expect(terminalIds('{"x":1}')).toBeNull();
    expect(terminalIds('["t1"]')).toEqual(new Set(["t1"]));
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

  it("polls once a second, patches only on change, and checks hc ls every tenth read", async () => {
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
    expect(calls.filter((x) => x.args[0] === "ls")).toHaveLength(2);
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

  it("treats a timeout and a missing hc as unavailable", async () => {
    vi.useFakeTimers();
    for (const error of ["timeout", "ENOENT"] as const) {
      const { runner } = stub(() => ({ code: null, stdout: "", stderr: "", error }));
      const hub = newHub();
      const d = new ChatTopicDriver({ hub, run: runner });
      d.start();
      await sub(hub, "chat:t3");
      expect(hub.isStale("chat:t3")).toBe("source_unavailable");
      d.stop();
    }
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
