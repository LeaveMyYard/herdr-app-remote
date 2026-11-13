// The app's terminal actors wired together (app/presses.ts, review M2 of #52): one per-terminal lock across typing,
// the key menu, answers and Stop, and losing a capability kills only that capability's work for that device.
import { describe, expect, it } from "vitest";
import { pressActors } from "../src/app/presses.js";
import type { Runner, RunResult } from "../src/plugins/exec.js";
import { ASK1, FakeTerm, screen, source } from "./prompt/helpers.js";

const OK: RunResult = { code: 0, stdout: '{"ok":true}', stderr: "" };
const D1 = "d-0000000000000001";
const D2 = "d-0000000000000002";
const client = (deviceId: string) => ({ principal: { deviceId }, send: () => undefined, close: () => undefined }) as never;
const MENU = { current: () => ({ rev: "0123456789abcdef", keys: [{ id: "esc", label: "Esc", keys: ["esc"] }] }) } as never;

/** A working Claude Code in t3 whose `hc keys esc` from Stop is held until `release()` (or killed by its signal). */
function rig() {
  const calls: string[][] = [];
  let release: (() => void) | null = null;
  let screenNow = screen("stop-working-stream");
  const run: Runner = async (_cmd, args, o) => {
    calls.push(args);
    if (args[0] === "read") return { code: 0, stdout: screenNow, stderr: "" };
    if (args[0] === "keys" && args.at(-1) === "esc" && args.includes("t3") && release === null) {
      return new Promise<RunResult>((resolve) => {
        const done = (r: RunResult) => {
          release = () => {};
          resolve(r);
        };
        release = () => {
          screenNow = screen("stop-stream-after-esc");
          done(OK);
        };
        o?.signal?.addEventListener("abort", () => done({ code: null, stdout: "", stderr: "", error: "aborted" }));
      });
    }
    return OK;
  };
  const p = pressActors({ run, binaries: { hc: "hc" } as never, menu: MENU, promptSource: () => undefined, stopSource: () => ({ state: () => ({ working: true, blocked: false }), hasCard: () => false }) });
  const held = async () => {
    while (!calls.some((a) => a[0] === "keys")) await new Promise((r) => setTimeout(r, 0));
  };
  return { p, calls, held, release: () => release!() };
}

describe("app press actors (CV8 wiring)", () => {
  it("while a Stop's Esc is in flight, typing and key presses into that terminal are busy, and run nothing", async () => {
    const { p, calls, held, release } = rig();
    const stop = p.stopper(client(D1), "agent.stop", { terminal: "t3" });
    await held();
    const n = calls.length;
    expect(await p.terminal(client(D2), "terminal.send", { terminal: "t3", text: "hello" })).toEqual({ ok: false, code: "busy" });
    expect(await p.keys(client(D2), "terminal.keys", { terminal: "t3", key: "esc", rev: "0123456789abcdef" })).toMatchObject({ ok: false, code: "busy" });
    expect(calls.length).toBe(n);
    // Another terminal is not held.
    expect(await p.terminal(client(D2), "terminal.send", { terminal: "t4", text: "hello" })).toMatchObject({ ok: true });
    release();
    expect(await stop).toEqual({ ok: true });
    expect(await p.terminal(client(D2), "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: true });
  });

  it("losing prompt.answer kills that device's Stop in flight; another device's cut or another capability does not", async () => {
    const { p, held } = rig();
    const stop = p.stopper(client(D1), "agent.stop", { terminal: "t3" });
    await held();
    let settled = false;
    void Promise.resolve(stop).then(() => (settled = true));
    p.cut(D2, "prompt.answer");
    p.cut(D1, "terminal.input");
    p.cut(D1, "terminal.keys");
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    p.cut(D1, "prompt.answer");
    expect(await stop).toEqual({ ok: false, code: "cancelled", unknown_effect: true });
  });

  it("losing prompt.answer kills that device's answer in flight too (review L5)", async () => {
    const term = new FakeTerm(screen("ask-single"));
    let started = false;
    const run: Runner = async (cmd, args, o) => {
      if (args[0] === "keys") {
        started = true;
        // Phase A held until killed.
        return new Promise<RunResult>((resolve) => o?.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "", error: "aborted" })));
      }
      return term.runner(cmd, args, o);
    };
    const s = source(term, [ASK1]);
    const p = pressActors({ run, binaries: { hc: "hc" } as never, menu: MENU, promptSource: () => s.src, stopSource: () => undefined });
    const answer = p.prompts(client(D1), "prompt.answer", { terminal: "t3", prompt_id: s.card.promptId, rev: "rev-1", choice: { option: 2 } });
    while (!started) await new Promise((r) => setTimeout(r, 0));
    p.cut(D1, "prompt.answer");
    expect(await answer).toMatchObject({ ok: false, code: "cancelled", unknown_effect: true });
  });

  it("a cut of everything (revoked) kills it too", async () => {
    const { p, held } = rig();
    const stop = p.stopper(client(D1), "agent.stop", { terminal: "t3" });
    await held();
    p.cut(D1);
    expect(await stop).toMatchObject({ ok: false, code: "cancelled" });
  });
});
