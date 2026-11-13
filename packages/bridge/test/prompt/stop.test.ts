// `agent.stop` (CV8): Esc once, only while working with no prompt, under the shared per-terminal lock, with a cooldown,
// held-press timing and a post-check. Screens are the rig's recordings of the pinned Claude Code (stop-*).
import { describe, expect, it } from "vitest";
import { agentStopActor, interruptible, STOP_COOLDOWN_MS, type StopSource } from "../../src/prompt/stop.js";
import { promptAnswerActor } from "../../src/prompt/answer.js";
import { TerminalLocks } from "../../src/prompt/lock.js";
import type { Runner, RunResult } from "../../src/plugins/exec.js";
import { ASK1, CLIENT, FakeTerm, screen, source } from "./helpers.js";

const OK: RunResult = { code: 0, stdout: '{"ok":true}', stderr: "" };
const ESC = ["keys", "--json", "--", "t3", "esc"];
const READ = ["read", "t3", "--lines", "100"];

/** A terminal running Claude Code as Stop sees it: `hc read` gives the screen, Esc while working interrupts it. */
class StopTerm {
  calls: string[][] = [];
  /** Replaces what `hc keys` does (a refusal, a hold, nothing). */
  keysReply: ((args: string[]) => Promise<RunResult> | RunResult | undefined) | null = null;
  readFails = false;
  constructor(public screen: string) {}
  runner: Runner = async (_cmd, args, o) => {
    this.calls.push(args);
    if (args[0] === "read") return this.readFails ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: this.screen, stderr: "" };
    if (args[0] === "keys") {
      const special = await this.keysReply?.(args);
      if (special) return special;
      if (o?.signal?.aborted) return { code: null, stdout: "", stderr: "", error: "aborted" };
      if (interruptible(this.screen)) this.screen = screen("stop-stream-after-esc");
      return OK;
    }
    return { code: 2, stdout: "", stderr: '{"error":{"kind":"usage"}}' };
  };
  get pressed(): string[][] {
    return this.calls.filter((a) => a[0] !== "read");
  }
}

function setup(o: { screen?: string; state?: ReturnType<StopSource["state"]>; card?: boolean; locks?: TerminalLocks } = {}) {
  const term = new StopTerm(o.screen ?? screen("stop-working-stream"));
  const clock = { now: 1_000_000 };
  const src = { state: o.state === undefined ? { working: true, blocked: false } : o.state, card: o.card ?? false };
  const states: (ReturnType<StopSource["state"]> | undefined)[] = [];
  const source: StopSource = {
    state: () => (states.length > 0 ? states.shift()! : src.state),
    hasCard: () => src.card,
  };
  const locks = o.locks ?? new TerminalLocks();
  const stop = agentStopActor({ run: term.runner, source, locks, binaries: { hc: "hc" } as never, now: () => clock.now, sleep: async (ms) => void (clock.now += ms), postCheckMs: 1000 });
  const act = (args: Record<string, unknown> = { terminal: "t3" }, client = CLIENT()) => stop(client as never, "agent.stop", args);
  return { term, clock, src, states, locks, stop, act };
}

describe("interruptible: Claude Code's own footer, and no prompt block", () => {
  it("is true only on the recorded working screens", () => {
    expect(interruptible(screen("stop-working-stream"))).toBe(true);
    expect(interruptible(screen("stop-working-tool"))).toBe(true);
    for (const n of ["stop-idle", "stop-idle-after-esc", "stop-stream-after-esc", "stop-tool-after-esc", "stop-permission-after-esc", "stop-after-stop-double-esc", "permission", "ask-single", "plan"] as const) {
      expect(interruptible(screen(n)), n).toBe(false);
    }
  });

  it("needs the hint as a footer segment on the last line, not anywhere on screen", () => {
    expect(interruptible("")).toBe(false);
    // In the conversation, not the footer.
    const quoted = screen("stop-idle").replace("❯ H0", "❯ esc to interrupt H0");
    expect(interruptible(quoted)).toBe(false);
    const inText = screen("stop-idle").replace("? for shortcuts", "press esc to interrupt it");
    expect(interruptible(inText)).toBe(false);
    // A working footer under a prompt block: the prompt wins.
    expect(interruptible(screen("permission").replace(/Esc to cancel · Tab to amend\s*$/, "Esc to cancel · esc to interrupt\n"))).toBe(false);
  });
});

describe("agent.stop", () => {
  it("presses Esc alone, once, after a read, and is ok once the footer is gone", async () => {
    const { term, act } = setup();
    expect(await act()).toEqual({ ok: true });
    expect(term.calls[0]).toEqual(READ);
    expect(term.pressed).toEqual([ESC]);
    expect(term.calls.some((a) => a.includes("--force") || a[0] === "send")).toBe(false);
  });

  it("also stops a running tool", async () => {
    const { term, act } = setup({ screen: screen("stop-working-tool") });
    expect(await act()).toEqual({ ok: true });
    expect(term.pressed).toEqual([ESC]);
  });

  it("bad args: nothing runs", async () => {
    const { term, act } = setup();
    expect(await act({ terminal: "t3", key: "enter" })).toEqual({ ok: false, code: "bad_args" });
    expect(await act({ terminal: "-x" })).toEqual({ ok: false, code: "bad_args" });
    expect(await act({})).toEqual({ ok: false, code: "bad_args" });
    expect(term.calls).toEqual([]);
  });

  it("S: no open chat view is not_open; blocked or a card is prompt_open; idle is not_working; nothing runs", async () => {
    for (const [o, code] of [
      [{ state: null }, "not_open"],
      [{ state: { working: false, blocked: true } }, "prompt_open"],
      [{ card: true }, "prompt_open"],
      [{ state: { working: false, blocked: false } }, "not_working"],
    ] as const) {
      const { term, act } = setup(o);
      expect(await act(), code).toEqual({ ok: false, code });
      expect(term.calls).toEqual([]);
    }
  });

  it("V: a prompt on screen is prompt_open and an idle screen is not_working, after the read only", async () => {
    for (const [n, code] of [
      ["permission", "prompt_open"],
      ["ask-single", "prompt_open"],
      ["stop-idle", "not_working"],
      ["stop-stream-after-esc", "not_working"],
      ["stop-after-stop-double-esc", "not_working"],
    ] as const) {
      const { term, act } = setup({ screen: screen(n) });
      expect(await act(), n).toEqual({ ok: false, code });
      expect(term.calls).toEqual([READ]);
    }
  });

  it("an unreadable screen presses nothing", async () => {
    const { term, act } = setup();
    term.readFails = true;
    expect(await act()).toEqual({ ok: false, code: "screen_unreadable" });
    expect(term.pressed).toEqual([]);
  });

  it("S is checked again after the read: a prompt that came meanwhile, or the agent finishing, presses nothing", async () => {
    for (const [s1, code] of [
      [{ working: false, blocked: true }, "prompt_open"],
      [{ working: false, blocked: false }, "not_working"],
      [null, "not_open"],
    ] as const) {
      const { term, states, act } = setup();
      states.push({ working: true, blocked: false }, s1);
      expect(await act()).toEqual({ ok: false, code });
      expect(term.pressed).toEqual([]);
    }
  });

  it("a 3 s cooldown per terminal, from the end of the press: refused with nothing run, then allowed", async () => {
    const { term, clock, act } = setup();
    expect(STOP_COOLDOWN_MS).toBe(3_000);
    const ends: number[] = [];
    term.keysReply = () => {
      clock.now += 500; // hc took half a second
      ends.push(clock.now);
      term.screen = screen("stop-stream-after-esc");
      return OK;
    };
    expect(await act()).toEqual({ ok: true });
    term.screen = screen("stop-working-stream");
    const n = term.calls.length;
    clock.now = ends[0]! + STOP_COOLDOWN_MS - 1;
    expect(await act()).toEqual({ ok: false, code: "cooldown" });
    expect(term.calls.length).toBe(n);
    // Another terminal is not cooled.
    expect((await act({ terminal: "t4" }))!.code).not.toBe("cooldown");
    clock.now = ends[0]! + STOP_COOLDOWN_MS;
    term.screen = screen("stop-working-stream");
    expect(await act()).toEqual({ ok: true });
  });

  it("an unknown effect still cools down; a refusal hc made before acting does not", async () => {
    const a = setup();
    a.term.keysReply = () => ({ code: null, stdout: "", stderr: "", error: "timeout" });
    expect(await a.act()).toEqual({ ok: false, code: "timeout", unknown_effect: true });
    expect(await a.act()).toEqual({ ok: false, code: "cooldown" });
    const b = setup();
    b.term.keysReply = () => ({ code: 1, stdout: "", stderr: '{"error":{"kind":"not_found"}}' });
    expect(await b.act()).toEqual({ ok: false, code: "not_working" });
    b.term.keysReply = null;
    expect(await b.act()).toEqual({ ok: true });
  });

  it("hc's refusals keep nothing-pressed codes; anything else is an unknown effect", async () => {
    for (const [stderr, code, unknown] of [
      ['{"error":{"kind":"finished"}}', "not_working", false],
      ['{"error":{"kind":"blocked"}}', "prompt_open", false],
      ['{"error":{"kind":"usage"}}', "failed", false],
      ['{"error":{"kind":"something_new"}}', "unknown_effect", true],
    ] as const) {
      const { term, act } = setup();
      term.keysReply = () => ({ code: 1, stdout: "", stderr });
      expect(await act(), stderr).toEqual({ ok: false, code, ...(unknown ? { unknown_effect: true } : {}) });
    }
  });

  it("a press hc held over 1 s for the desk is unknown_effect, never ok (R6)", async () => {
    const { term, clock, act } = setup();
    term.keysReply = () => {
      clock.now += 1_001;
      term.screen = screen("stop-stream-after-esc");
      return OK;
    };
    expect(await act()).toEqual({ ok: false, code: "unknown_effect", unknown_effect: true, audit_label: "held 1 s while the desk was typing" });
    // Exactly 1 s is not held.
    const b = setup();
    b.term.keysReply = () => {
      b.clock.now += 1_000;
      b.term.screen = screen("stop-stream-after-esc");
      return OK;
    };
    expect(await b.act()).toEqual({ ok: true });
  });

  it("the footer still there after the post-check window is unknown_effect", async () => {
    const { term, act } = setup();
    term.keysReply = () => OK; // Esc went, but the screen still says working
    expect(await act()).toEqual({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(term.pressed).toEqual([ESC]);
  });

  it("losing prompt.answer kills the device's own Stop in flight, not another device's", async () => {
    const { term, stop, act } = setup();
    let release!: () => void;
    term.keysReply = (args) => (args ? new Promise<RunResult>((r) => (release = () => r({ code: null, stdout: "", stderr: "", error: "aborted" }))) : undefined);
    const p = act();
    await new Promise((r) => setTimeout(r, 0));
    stop.cancel("d-0000000000000002");
    stop.cancel("d-0000000000000001");
    release();
    expect(await p).toEqual({ ok: false, code: "cancelled", unknown_effect: true });
  });
});

describe("the per-terminal lock shared with prompt.answer", () => {
  it("Stop is busy while an answer holds the terminal, and an answer is busy while a Stop runs", async () => {
    const locks = new TerminalLocks();
    // An answer in flight: its phase B Enter is held.
    const ft = new FakeTerm(screen("ask-single"));
    const s = source(ft, [ASK1]);
    let releaseEnter!: () => void;
    const held: Runner = async (cmd, args, o) => {
      if (args[0] === "keys" && args.includes("enter")) await new Promise<void>((r) => (releaseEnter = r));
      return ft.runner(cmd, args, o);
    };
    const answer = promptAnswerActor({ run: held, source: s.src, binaries: { hc: "hc" } as never, sleep: async () => {}, postCheckMs: 30, locks });
    const pa = answer(CLIENT() as never, "prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { option: 0 } });
    while (!locks.has("t3")) await new Promise((r) => setTimeout(r, 0));
    const st = setup({ locks });
    expect(await st.act()).toEqual({ ok: false, code: "busy" });
    expect(st.term.calls).toEqual([]);
    // Another terminal is free.
    expect((await st.act({ terminal: "t4" }))!.code).not.toBe("busy");
    while (releaseEnter === undefined) await new Promise((r) => setTimeout(r, 0));
    releaseEnter();
    expect((await pa)!.ok).toBe(true);
    expect(locks.has("t3")).toBe(false);

    // A Stop in flight: the answer is busy.
    const st2 = setup({ locks });
    let releaseEsc!: () => void;
    st2.term.keysReply = () =>
      new Promise<RunResult>((r) => {
        releaseEsc = () => {
          st2.term.screen = screen("stop-stream-after-esc");
          r(OK);
        };
      });
    const ps = st2.act();
    while (releaseEsc === undefined) await new Promise((r) => setTimeout(r, 0));
    expect(locks.has("t3")).toBe(true);
    const ft2 = new FakeTerm(screen("ask-single"));
    const s2 = source(ft2, [ASK1]);
    const answer2 = promptAnswerActor({ run: ft2.runner, source: s2.src, binaries: { hc: "hc" } as never, sleep: async () => {}, postCheckMs: 30, locks });
    expect(await answer2(CLIENT() as never, "prompt.answer", { terminal: "t3", prompt_id: s2.card.promptId, rev: "rev-1", choice: { option: 0 } })).toEqual({ ok: false, code: "busy" });
    expect(ft2.calls).toEqual([]);
    releaseEsc();
    expect(await ps).toEqual({ ok: true });
    expect(locks.has("t3")).toBe(false);
  });
});
