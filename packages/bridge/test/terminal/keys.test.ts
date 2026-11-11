import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYS_TIMEOUT_MS, keysArgs, keysAuditLabel, readKeys, terminalKeysActor } from "../../src/terminal/keys.js";
import { DEFAULT_KEYS, KEYS_FILE, KeysMenu, menuTopic } from "../../src/terminal/keys-config.js";
import { TIMEOUT_HOLD_MS } from "../../src/terminal/send.js";
import { run, type Runner, type RunResult } from "../../src/plugins/exec.js";
import { fakeCli, tmp } from "../plugins/helpers.js";

/** Outputs of `hc keys --json` recorded in the rig (hc 0.1.19). */
const fx = (n: string) => readFileSync(new URL(`../fixtures/hc/${n}`, import.meta.url), "utf8");
const res = (code: number | null, stdout: string, error?: RunResult["error"]): RunResult => ({ code, stdout, stderr: "", ...(error ? { error } : {}) });
const err = (code: number, stderr: string): RunResult => ({ code, stdout: "", stderr });
const client = (deviceId = "d-0000000000000001") => ({ principal: { deviceId }, send: () => undefined, close: () => undefined });
const REV = menuTopic(DEFAULT_KEYS).rev;

function stub(reply: () => RunResult | Promise<RunResult>) {
  const calls: { cmd: string; args: string[]; timeoutMs: number }[] = [];
  const runner: Runner = async (cmd, args, { timeoutMs }) => {
    calls.push({ cmd, args, timeoutMs });
    return reply();
  };
  return { calls, runner };
}

let dir: string;
let menu: KeysMenu;
beforeEach(() => {
  dir = tmp("s16b-actor-");
  // A clock past the settle time, so an edit in the test is read at once.
  menu = new KeysMenu(dir, undefined, () => Date.now() + 60_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("keysArgs", () => {
  it("ends hc's options before the terminal, then the entry's tokens", () => {
    expect(keysArgs("t3", ["ctrl+c"])).toEqual(["keys", "--json", "--", "t3", "ctrl+c"]);
    expect(keysArgs("vps/t7", ["esc", "up", "up"])).toEqual(["keys", "--json", "--", "vps/t7", "esc", "up", "up"]);
  });
});

describe("readKeys (recorded hc outputs)", () => {
  it("exit 0 with a JSON object is pressed", () => {
    expect(readKeys(res(0, fx("keys-ok.json")))).toEqual({ ok: true });
  });

  it("refusals before any key are plain failures", () => {
    expect(readKeys(err(3, fx("keys-not-found.json")))).toEqual({ ok: false, code: "terminal_not_found" });
    expect(readKeys(err(11, fx("keys-finished.json")))).toEqual({ ok: false, code: "terminal_finished" });
    // The rig showed `left bogus` pressed nothing: hc checks every name first.
    expect(readKeys(err(6, fx("keys-invalid.json")))).toEqual({ ok: false, code: "keys_refused" });
    expect(readKeys(err(2, fx("keys-usage.json")))).toEqual({ ok: false, code: "keys_refused" });
    expect(readKeys(err(1, '{"error":{"kind":"machine_unknown"}}'))).toEqual({ ok: false, code: "terminal_not_found" });
    expect(readKeys(res(null, "", "ENOENT"))).toEqual({ ok: false, code: "hc_missing" });
  });

  it("anything else may have pressed keys: an unknown effect", () => {
    for (const r of [
      res(0, "not json"),
      res(0, "[1]"),
      res(0, '{"error":{"kind":"not_found"}}'),
      err(9, '{"error":{"kind":"something_new"}}'),
      err(1, '{"error":{"kind":"unavailable"}}'),
      err(1, '{"error":{"kind":"__proto__"}}'),
      err(1, "garbage"),
      res(3, fx("keys-not-found.json")),
      res(null, "", "timeout"),
      res(null, "", "other"),
      res(null, "", "aborted"),
    ]) {
      expect(readKeys(r), JSON.stringify(r)).toMatchObject({ ok: false, unknown_effect: true });
    }
  });
});

describe("terminalKeysActor", () => {
  it("leaves other kinds alone", async () => {
    const { calls, runner } = stub(() => res(0, fx("keys-ok.json")));
    const actor = terminalKeysActor({ run: runner, menu });
    expect(await actor(client(), "terminal.send", { terminal: "t3", text: "x" })).toBeUndefined();
    expect(await actor(client(), "inbox.ack", {})).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("presses the entry's own tokens, under a timeout, and names the entry for Activity", async () => {
    const { calls, runner } = stub(() => res(0, fx("keys-ok.json")));
    const actor = terminalKeysActor({ run: runner, menu, binaries: { hc: "/opt/fake/hc", inbox: "x", usagebar: "x" } });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "shift-tab", rev: REV })).toEqual({ ok: true, audit_label: "shift-tab (1 key)" });
    expect(calls).toEqual([{ cmd: "/opt/fake/hc", args: ["keys", "--json", "--", "t3", "shift+tab"], timeoutMs: KEYS_TIMEOUT_MS }]);
  });

  it("refuses bad arguments, a stale menu and an unknown entry before hc runs", async () => {
    const { calls, runner } = stub(() => res(0, fx("keys-ok.json")));
    const actor = terminalKeysActor({ run: runner, menu });
    const bad: Record<string, unknown>[] = [
      {},
      { terminal: "t3", key: "esc" },
      { terminal: "t3", rev: REV },
      { terminal: "-x", key: "esc", rev: REV },
      { terminal: "t3", key: "esc", rev: "nope" },
      // The phone names an entry; it can't send key names, or add any.
      { terminal: "t3", key: "ctrl+c", rev: REV },
      { terminal: "t3", key: "esc", rev: REV, keys: ["a"] },
      { terminal: "t3", key: ["esc"], rev: REV },
    ];
    for (const args of bad) expect(await actor(client(), "terminal.keys", args), JSON.stringify(args)).toEqual({ ok: false, code: "bad_args" });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "esc", rev: "0123456789abcdef" })).toEqual({ ok: false, code: "keys_changed" });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "ctrl-z", rev: REV })).toEqual({ ok: false, code: "unknown_key" });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "constructor", rev: REV })).toEqual({ ok: false, code: "unknown_key" });
    expect(calls).toHaveLength(0);
  });

  it("an edited keys.json refuses a press from the old menu, and the new menu's press runs its keys", async () => {
    const { calls, runner } = stub(() => res(0, fx("keys-ok.json")));
    const actor = terminalKeysActor({ run: runner, menu });
    writeFileSync(join(dir, KEYS_FILE), JSON.stringify({ v: 1, keys: [{ id: "esc", label: "Esc twice", keys: ["esc", "esc"] }] }));
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "esc", rev: REV })).toEqual({ ok: false, code: "keys_changed" });
    expect(calls).toHaveLength(0);
    const rev = menu.current().rev;
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "esc", rev })).toEqual({ ok: true, audit_label: "esc (2 keys)" });
    expect(calls[0]?.args).toEqual(["keys", "--json", "--", "t3", "esc", "esc"]);
  });

  it("re-checks the entry's tokens right before running hc", async () => {
    const { calls, runner } = stub(() => res(0, fx("keys-ok.json")));
    const forged = { rev: "0123456789abcdef", keys: [{ id: "x", label: "x", keys: ["a"] }] };
    const actor = terminalKeysActor({ run: runner, menu: { current: () => forged } as unknown as KeysMenu });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "x", rev: forged.rev })).toEqual({ ok: false, code: "keys_refused", audit_label: "x (1 key)" });
    expect(calls).toHaveLength(0);
  });

  it("keeps one press in flight per device", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, runner } = stub(async () => {
      await gate;
      return res(0, fx("keys-ok.json"));
    });
    const actor = terminalKeysActor({ run: runner, menu });
    const first = actor(client("d-a"), "terminal.keys", { terminal: "t3", key: "esc", rev: REV });
    expect(await actor(client("d-a"), "terminal.keys", { terminal: "t3", key: "tab", rev: REV })).toMatchObject({ ok: false, code: "busy" });
    const other = actor(client("d-b"), "terminal.keys", { terminal: "t3", key: "up", rev: REV });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await other).toMatchObject({ ok: true });
    expect(calls.map((c) => c.args[4])).toEqual(["esc", "up"]);
  });

  it("cancel kills that device's press in flight (an unknown effect), and leaves others alone", async () => {
    const signals: AbortSignal[] = [];
    const runner: Runner = (_cmd, _args, { signal }) =>
      new Promise((resolve) => {
        signals.push(signal!);
        signal!.addEventListener("abort", () => resolve(res(null, "", "aborted")));
        setTimeout(() => resolve(res(0, fx("keys-ok.json"))), 50);
      });
    const actor = terminalKeysActor({ run: runner, menu });
    const a = actor(client("d-a"), "terminal.keys", { terminal: "t3", key: "ctrl-c", rev: REV });
    const b = actor(client("d-b"), "terminal.keys", { terminal: "t3", key: "esc", rev: REV });
    actor.cancel("d-a");
    expect(await a).toEqual({ ok: false, code: "cancelled", unknown_effect: true, audit_label: "ctrl-c (1 key)" });
    expect(await b).toMatchObject({ ok: true });
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    const c = actor(client("d-c"), "terminal.keys", { terminal: "t3", key: "esc", rev: REV });
    actor.cancel();
    expect(await c).toMatchObject({ code: "cancelled" });
  });

  it("after a timeout the device stays busy while hc is being killed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { runner } = stub(() => res(null, "", "timeout"));
      const actor = terminalKeysActor({ run: runner, menu });
      expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "esc", rev: REV })).toMatchObject({ ok: false, code: "timeout", unknown_effect: true });
      expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "esc", rev: REV })).toMatchObject({ code: "busy" });
      vi.advanceTimersByTime(TIMEOUT_HOLD_MS);
      expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "esc", rev: REV })).toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keysAuditLabel names the entry and counts its keys", () => {
    expect(keysAuditLabel("ctrl-c", 1)).toBe("ctrl-c (1 key)");
    expect(keysAuditLabel("up_up", 2)).toBe("up_up (2 keys)");
  });
});

describe("terminalKeysActor with a fake hc CLI", () => {
  const bin = tmp("s16b-hc-");
  afterAll(() => rmSync(bin, { recursive: true, force: true }));
  const hc = fakeCli(
    bin,
    "hc",
    `log="${join(bin, "argv")}"
for a in "$@"; do printf '%s\\0' "$a" >> "$log"; done
printf '\\001' >> "$log"
[ "$4" = t99 ] && { printf '%s\\n' '{"error":{"hint":"see hc ls --all","kind":"not_found","message":"no terminal"}}' >&2; exit 3; }
printf '%s\\n' '{"status":null,"turn":0}'`,
  );

  it("passes the terminal and tokens through no shell, verbatim", async () => {
    const actor = terminalKeysActor({ run, menu, binaries: { hc, inbox: "x", usagebar: "x" } });
    expect(await actor(client(), "terminal.keys", { terminal: "t3", key: "ctrl-c", rev: REV })).toMatchObject({ ok: true });
    expect(await actor(client(), "terminal.keys", { terminal: "t99", key: "esc", rev: REV })).toMatchObject({ ok: false, code: "terminal_not_found" });
    const got = readFileSync(join(bin, "argv"), "utf8")
      .split("\u0001")
      .filter(Boolean)
      .map((l) => l.split("\0").slice(0, -1));
    expect(got).toEqual([
      ["keys", "--json", "--", "t3", "ctrl+c"],
      ["keys", "--json", "--", "t99", "esc"],
    ]);
    expect(existsSync(join(bin, "pwned"))).toBe(false);
  });
});
