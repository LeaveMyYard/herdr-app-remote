import { useEffect, useRef, useState } from "react";
import { useHostName } from "../bridge/host-name";
import { readState, turnOff, turnOn, type PushEnv, type PushState } from "./push";

/** The row's words. Provisional: no board draws this row yet (S17). */
export const PUSH_WORDS = {
  off: "Get a notification when an agent asks a question or is blocked.",
  turnOn: "Turn on",
  on: "Notifications are on for this phone.",
  turnOff: "Turn off",
  busy: "One moment…",
  notAllowed: (host: string): string => `Notifications are off for this phone. Turn them on in Remote on ${host}.`,
  denied: "Notifications are blocked for this app. Allow them in Settings, then come back.",
  failed: "Notifications couldn't be turned on. Try again.",
} as const;

/** Notifications on or off for this phone, shown at the top of the Inbox. Hidden outside the Home Screen app. */
export function PushRow({ env }: { env: PushEnv }) {
  const host = useHostName();
  const [state, setState] = useState<PushState>({ s: "loading" });
  const key = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    void readState(env).then((r) => {
      if (!live) return;
      key.current = r.key;
      setState(r.state);
    });
    return () => {
      live = false;
    };
  }, [env]);

  if (state.s === "unsupported" || state.s === "loading") return null;
  const run = (fn: () => Promise<PushState>) => {
    setState({ s: "busy" });
    void fn().then(setState, () => setState({ s: "failed" }));
  };
  // The tap handler calls `turnOn` synchronously, so the permission request stays inside the user gesture.
  const on = () => key.current !== null && run(() => turnOn(env, key.current!));
  const text =
    state.s === "on" ? PUSH_WORDS.on : state.s === "busy" ? PUSH_WORDS.busy : state.s === "not_allowed" ? PUSH_WORDS.notAllowed(host) : state.s === "denied" ? PUSH_WORDS.denied : state.s === "failed" ? PUSH_WORDS.failed : PUSH_WORDS.off;
  return (
    <div className="ib-notice row push-row" data-tone={state.s === "failed" ? "warn" : "info"} role="status">
      <span className="f1">{text}</span>
      {state.s === "off" || state.s === "failed" ? (
        <button type="button" className="push-btn" onClick={on} disabled={key.current === null}>
          {PUSH_WORDS.turnOn}
        </button>
      ) : state.s === "on" ? (
        <button type="button" className="push-btn" onClick={() => run(() => turnOff(env))}>
          {PUSH_WORDS.turnOff}
        </button>
      ) : null}
    </div>
  );
}
