// The four actors that press into a terminal, wired together (S16, S16b, CV7, CV8): typing (`terminal.send`), the
// key menu (`terminal.keys`), prompt answers (`prompt.answer`) and Stop (`agent.stop`). One place, so the two rules
// that bind them can be tested without the whole app:
//
// - one per-terminal lock: while an answer or a Stop runs in a terminal, the others into it are refused (`busy`);
// - while typing or a key-menu press runs into a terminal (hc may hold it for the desk), Stop into it is `busy` too,
//   so `hc send`/`hc keys` and Stop's Esc never race in an order hc decides;
// - losing a capability kills only the work in flight that it covers, for that device (`cut`).
import type { Binaries } from "../plugins/detect.js";
import type { Runner } from "../plugins/exec.js";
import { promptAnswerActor, type PromptAnswerActor, type PromptSource } from "../prompt/answer.js";
import { TerminalLocks } from "../prompt/lock.js";
import { agentStopActor, type AgentStopActor, type StopSource } from "../prompt/stop.js";
import { terminalKeysActor, type TerminalKeysActor } from "../terminal/keys.js";
import type { KeysMenu } from "../terminal/keys-config.js";
import { terminalSendActor, type TerminalSendActor } from "../terminal/send.js";
import { TIMEOUT_HOLD_MS } from "../terminal/hc-act.js";
import type { Actor } from "./act.js";

export interface PressActorsOptions {
  run: Runner;
  binaries: Binaries;
  menu: Pick<KeysMenu, "current">;
  /** The chat view's sources, once it exists (they are read at each act). */
  promptSource: () => PromptSource | undefined;
  stopSource: () => StopSource | undefined;
}

export interface PressActors {
  terminal: TerminalSendActor;
  keys: TerminalKeysActor;
  prompts: PromptAnswerActor;
  stopper: AgentStopActor;
  /** A device lost `cap` (undefined: everything): its work in flight under that capability is killed. */
  cut(id: string | undefined, cap?: string): void;
}

export function pressActors(o: PressActorsOptions): PressActors {
  const { run, binaries } = o;
  const locks = new TerminalLocks();
  const busy = (t: string) => locks.has(t);
  // Terminals with a send or key press in flight (a count: two devices may type into one terminal).
  const typing = new Map<string, number>();
  const track = <A extends Actor>(kind: string, inner: A): A => {
    const wrapped = async (...a: Parameters<Actor>) => {
      const t = a[1] === kind && typeof a[2].terminal === "string" ? a[2].terminal : null;
      if (t !== null) typing.set(t, (typing.get(t) ?? 0) + 1);
      let res: Awaited<ReturnType<Actor>> | undefined;
      try {
        res = await inner(...a);
        return res;
      } finally {
        if (t !== null) {
          const done = () => {
            const n = (typing.get(t) ?? 1) - 1;
            if (n <= 0) typing.delete(t);
            else typing.set(t, n);
          };
          // A timed-out or killed hc is still being killed and may yet type: as `InFlight` does.
          if (res?.code === "timeout" || res?.code === "cancelled") setTimeout(done, TIMEOUT_HOLD_MS).unref();
          else done();
        }
      }
    };
    return Object.assign(wrapped, inner) as A;
  };
  const terminal = track("terminal.send", terminalSendActor({ run, binaries, busy }));
  const keys = track("terminal.keys", terminalKeysActor({ run, binaries, menu: o.menu as KeysMenu, busy }));
  const prompts = promptAnswerActor({
    run,
    binaries,
    locks,
    source: {
      current: (t) => o.promptSource()?.current(t),
      fresh: (t) => o.promptSource()?.fresh(t) ?? Promise.resolve(null),
      answered: (t, id) => o.promptSource()?.answered(t, id),
      isAnswered: (t, id) => o.promptSource()?.isAnswered(t, id) ?? false,
    },
  });
  const stopper = agentStopActor({
    run,
    binaries,
    locks,
    busy: (t) => typing.has(t),
    source: {
      state: (t) => o.stopSource()?.state(t) ?? null,
      hasCard: (t) => o.stopSource()?.hasCard(t) ?? false,
    },
  });
  return {
    terminal,
    keys,
    prompts,
    stopper,
    cut: (id, cap) => {
      if (cap === undefined || cap === "terminal.input") terminal.cancel(id);
      if (cap === undefined || cap === "terminal.keys") keys.cancel(id);
      // Losing `prompt.answer` stops only that device's own answer or Stop in flight (§5.1).
      if (cap === undefined || cap === "prompt.answer") {
        prompts.cancel(id);
        stopper.cancel(id);
      }
    },
  };
}
