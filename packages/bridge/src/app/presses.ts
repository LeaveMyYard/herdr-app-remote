// The four actors that press into a terminal, wired together (S16, S16b, CV7, CV8): typing (`terminal.send`), the
// key menu (`terminal.keys`), prompt answers (`prompt.answer`) and Stop (`agent.stop`). One place, so the two rules
// that bind them can be tested without the whole app:
//
// - one per-terminal lock: while an answer or a Stop runs in a terminal, the others into it are refused (`busy`);
// - losing a capability kills only the work in flight that it covers, for that device (`cut`).
import type { Binaries } from "../plugins/detect.js";
import type { Runner } from "../plugins/exec.js";
import { promptAnswerActor, type PromptAnswerActor, type PromptSource } from "../prompt/answer.js";
import { TerminalLocks } from "../prompt/lock.js";
import { agentStopActor, type AgentStopActor, type StopSource } from "../prompt/stop.js";
import { terminalKeysActor, type TerminalKeysActor } from "../terminal/keys.js";
import type { KeysMenu } from "../terminal/keys-config.js";
import { terminalSendActor, type TerminalSendActor } from "../terminal/send.js";

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
  const terminal = terminalSendActor({ run, binaries, busy });
  const keys = terminalKeysActor({ run, binaries, menu: o.menu as KeysMenu, busy });
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
