import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { readSend, sendArgs, SEND_TIMEOUT_MS, terminalSendActor, TIMEOUT_HOLD_MS } from "../../src/terminal/send.js";
import { run, type Runner, type RunResult } from "../../src/plugins/exec.js";
import { fakeCli, tmp } from "../plugins/helpers.js";

/**
 * Outputs of `hc send --json` recorded in the rig (hc 0.1.19). `send-blocked.json` is not a recording: the rig has no
 * program blocked on a dialog, so it is shaped like the others with the `blocked` kind that `hc schema` lists for send.
 */
const fx = (n: string) => readFileSync(new URL(`../fixtures/hc/${n}`, import.meta.url), "utf8");
const res = (code: number | null, stdout: string, error?: RunResult["error"]): RunResult => ({ code, stdout, stderr: "", ...(error ? { error } : {}) });
/** A refusal: hc prints its `{"error":…}` on stderr and nothing on stdout. */
const err = (code: number, stderr: string): RunResult => ({ code, stdout: "", stderr });

const client = (deviceId = "d-0000000000000001") => ({ principal: { deviceId }, send: () => undefined, close: () => undefined });

function stub(reply: () => RunResult | Promise<RunResult>) {
  const calls: { cmd: string; args: string[]; timeoutMs: number }[] = [];
  const runner: Runner = async (cmd, args, { timeoutMs }) => {
    calls.push({ cmd, args, timeoutMs });
    return reply();
  };
  return { calls, runner };
}

describe("sendArgs", () => {
  it("ends hc's options before the terminal, so text like --force is typed, never read as a flag", () => {
    expect(sendArgs("t3", "--force")).toEqual(["send", "--json", "--", "t3", "--force"]);
    expect(sendArgs("vps/t7", "")).toEqual(["send", "--json", "--", "vps/t7", ""]);
  });
});

describe("readSend (recorded hc outputs)", () => {
  it("exit 0 with a JSON object is sent", () => {
    expect(readSend(res(0, fx("send-ok.json")))).toEqual({ ok: true });
  });

  it("refusals before typing are plain failures", () => {
    expect(readSend(err(3, fx("send-not-found.json")))).toEqual({ ok: false, code: "terminal_not_found" });
    expect(readSend(err(11, fx("send-finished.json")))).toEqual({ ok: false, code: "terminal_finished" });
    expect(readSend(err(2, fx("send-usage.json")))).toEqual({ ok: false, code: "send_refused" });
    expect(readSend(err(1, fx("send-blocked.json")))).toEqual({ ok: false, code: "terminal_blocked" });
    expect(readSend(err(1, '{"error":{"kind":"machine_unknown"}}'))).toEqual({ ok: false, code: "terminal_not_found" });
    expect(readSend(res(null, "", "ENOENT"))).toEqual({ ok: false, code: "hc_missing" });
  });

  it("anything else may have typed: an unknown effect", () => {
    for (const r of [
      res(0, "not json"),
      res(0, "[1]"),
      res(0, '{"error":{"kind":"not_found"}}'),
      err(9, '{"error":{"kind":"something_new"}}'),
      err(1, "garbage"),
      err(3, '{"error":{"kind":"constructor"}}'),
      // A refusal is only believed on stderr, where hc prints it.
      res(3, fx("send-not-found.json")),
      res(null, "", "timeout"),
      res(null, "", "other"),
      res(null, "", "aborted"),
      // The schema lists these for send without saying whether anything was typed first.
      err(1, '{"error":{"kind":"unavailable"}}'),
      err(1, '{"error":{"kind":"config"}}'),
    ]) {
      expect(readSend(r), JSON.stringify(r)).toMatchObject({ ok: false, unknown_effect: true });
    }
  });
});

describe("terminalSendActor", () => {
  it("leaves other kinds alone", async () => {
    const { calls, runner } = stub(() => res(0, fx("send-ok.json")));
    const actor = terminalSendActor({ run: runner });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", keys: ["esc"] })).toBeUndefined();
    expect(await actor(client(), "inbox.ack", {})).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("runs hc send with the text as one argument, under a timeout", async () => {
    const { calls, runner } = stub(() => res(0, fx("send-ok.json")));
    const actor = terminalSendActor({ run: runner, binaries: { hc: "/opt/fake/hc", inbox: "x", usagebar: "x" } });
    expect(await actor(client(), "terminal.send", { terminal: "t3", text: "line one\nline two\twith tab ✓" })).toEqual({ ok: true });
    expect(calls).toEqual([{ cmd: "/opt/fake/hc", args: ["send", "--json", "--", "t3", "line one\nline two\twith tab ✓"], timeoutMs: SEND_TIMEOUT_MS }]);
  });

  it("refuses bad arguments before hc runs", async () => {
    const { calls, runner } = stub(() => res(0, fx("send-ok.json")));
    const actor = terminalSendActor({ run: runner });
    const bad: Record<string, unknown>[] = [
      {},
      { terminal: "t3" },
      { terminal: "t3", text: 12 },
      { terminal: "-x", text: "a" },
      { terminal: "--force", text: "a" },
      { terminal: "t 3", text: "a" },
      { terminal: "a/b/c", text: "a" },
      { terminal: "t3", text: "\u001b[201~rm -rf x\r" },
      { terminal: "t3", text: "ok\r" },
      { terminal: "t3", text: "ctrl-c \u0003" },
      { terminal: "t3", text: "del \u007f" },
      { terminal: "t3", text: "c1 \u009b" },
      { terminal: "t3", text: "x".repeat(bridgeApi.TERMINAL_SEND_MAX_CHARS + 1) },
      { terminal: "t3", text: "a", force: true },
    ];
    for (const args of bad) expect(await actor(client(), "terminal.send", args), JSON.stringify(args).slice(0, 80)).toEqual({ ok: false, code: "bad_args" });
    expect(calls).toHaveLength(0);
    // The limit counts characters, not UTF-16 units.
    expect(await actor(client(), "terminal.send", { terminal: "t3", text: "✓".repeat(bridgeApi.TERMINAL_SEND_MAX_CHARS) })).toEqual({ ok: true });
    expect(await actor(client(), "terminal.send", { terminal: "t3", text: "😀".repeat(bridgeApi.TERMINAL_SEND_MAX_CHARS) })).toEqual({ ok: true });
  });

  it("keeps one send in flight per device: a second is busy, another device is not", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, runner } = stub(async () => {
      await gate;
      return res(0, fx("send-ok.json"));
    });
    const actor = terminalSendActor({ run: runner });
    const first = actor(client("d-a"), "terminal.send", { terminal: "t3", text: "one" });
    expect(await actor(client("d-a"), "terminal.send", { terminal: "t3", text: "two" })).toEqual({ ok: false, code: "busy" });
    const other = actor(client("d-b"), "terminal.send", { terminal: "t3", text: "three" });
    release();
    expect(await first).toEqual({ ok: true });
    expect(await other).toEqual({ ok: true });
    expect(await actor(client("d-a"), "terminal.send", { terminal: "t3", text: "four" })).toEqual({ ok: true });
    expect(calls.map((c) => c.args[4])).toEqual(["one", "three", "four"]);
  });

  it("cancel kills that device's send in flight (an unknown effect), and leaves other devices' alone", async () => {
    const signals: AbortSignal[] = [];
    const runner: Runner = (_cmd, _args, { signal }) =>
      new Promise((resolve) => {
        signals.push(signal!);
        signal!.addEventListener("abort", () => resolve(res(null, "", "aborted")));
        setTimeout(() => resolve(res(0, fx("send-ok.json"))), 50);
      });
    const actor = terminalSendActor({ run: runner });
    const a = actor(client("d-a"), "terminal.send", { terminal: "t3", text: "one" });
    const b = actor(client("d-b"), "terminal.send", { terminal: "t3", text: "two" });
    actor.cancel("d-a");
    expect(await a).toEqual({ ok: false, code: "cancelled", unknown_effect: true });
    expect(await b).toEqual({ ok: true });
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    // With no id, every device's send is killed.
    const c = actor(client("d-c"), "terminal.send", { terminal: "t3", text: "three" });
    actor.cancel();
    expect(await c).toMatchObject({ code: "cancelled" });
  });

  it("after a timeout the device stays busy while hc is being killed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { runner } = stub(() => res(null, "", "timeout"));
      const actor = terminalSendActor({ run: runner });
      expect(await actor(client(), "terminal.send", { terminal: "t3", text: "slow" })).toEqual({ ok: false, code: "timeout", unknown_effect: true });
      expect(await actor(client(), "terminal.send", { terminal: "t3", text: "next" })).toEqual({ ok: false, code: "busy" });
      vi.advanceTimersByTime(TIMEOUT_HOLD_MS);
      expect(await actor(client(), "terminal.send", { terminal: "t3", text: "next" })).toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminalSendActor with a fake hc CLI", () => {
  const dir = tmp("s16-hc-");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Records its argv (NUL between arguments, SOH after each call) and answers like hc 0.1.19 does.
  const hc = fakeCli(
    dir,
    "hc",
    `log="${join(dir, "argv")}"
for a in "$@"; do printf '%s\\0' "$a" >> "$log"; done
printf '\\001' >> "$log"
[ "$4" = t99 ] && { printf '%s\\n' '{"error":{"hint":"see hc ls --all","kind":"not_found","message":"no terminal"}}' >&2; exit 3; }
printf '%s\\n' '{"started":null,"status":null,"turn":0}'`,
  );
  const actor = terminalSendActor({ run, binaries: { hc, inbox: "x", usagebar: "x" } });
  const argv = () =>
    readFileSync(join(dir, "argv"), "utf8")
      .split("\u0001")
      .filter(Boolean)
      .map((l) => l.split("\0").slice(0, -1));

  it("an abort kills the running hc at once; an already aborted one never starts", async () => {
    const slow = fakeCli(dir, "slow-hc", `echo started >> "${join(dir, "slow")}"; sleep 5; echo '{}'`);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = run(slow, ["send"], { timeoutMs: 10_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    expect(await p).toMatchObject({ error: "aborted", code: null });
    expect(Date.now() - t0).toBeLessThan(2000);
    const before = readFileSync(join(dir, "slow"), "utf8");
    expect(await run(slow, ["send"], { timeoutMs: 10_000, signal: ac.signal })).toMatchObject({ error: "aborted" });
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(join(dir, "slow"), "utf8")).toBe(before);
  });

  it("passes the text through no shell, verbatim", async () => {
    const text = '--force; $(touch pwned) `id` "quoted" \'single\'\nsecond line';
    expect(await actor(client(), "terminal.send", { terminal: "t3", text })).toEqual({ ok: true });
    expect(await actor(client(), "terminal.send", { terminal: "t99", text: "x" })).toEqual({ ok: false, code: "terminal_not_found" });
    const got = argv();
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(["send", "--json", "--", "t3", text]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(existsSync("pwned")).toBe(false);
  });
});
