import { useEffect, useRef, useState } from "react";
import { bridgeApi } from "@herdr-remote/protocol";
import { Icon } from "../components/Icon";
import { Tile } from "../components/StateMarks";
import type { SendOutcome } from "./ChatComposer";

/** The special-keys menu (S16b) as the phone sees it: whether it may press, and the desktop's menu. */
export interface KeysInput {
  /** `terminal.keys` is in effect for this device (from `/api/v1/me`; the bridge checks again on every press). */
  enabled: boolean;
  /** The `keys` topic; undefined until it arrives. */
  menu: bridgeApi.KeysTopic | undefined;
  /** Sends `terminal.keys {terminal, key, rev}`: the entry, as shown at `rev`. */
  press: (key: string, rev: string) => Promise<SendOutcome>;
}

/** What a refused or uncertain press means here. Nothing is ever pressed again by itself. */
export function pressWords(r: SendOutcome, host: string, fallback: (r: SendOutcome) => string): string {
  if (r.unknown_effect) return fallback(r);
  switch (r.code) {
    case "keys_changed":
    case "unknown_key":
      return `The key list changed on ${host}. Look again.`;
    case "terminal_blocked":
      return "The agent is waiting on a dialog at the desktop. Nothing was pressed.";
    case "forbidden":
      return `Special keys are off for this phone. Turn them on in Remote on ${host}.`;
    default:
      return fallback(r);
  }
}

/** Ctrl-C stops what the agent is doing: drawn in the blocked colour so it is not tapped for something else. */
const warns = (e: bridgeApi.KeyEntry) => e.keys.includes("ctrl+c");

function KeyCell({ entry, disabled, pressed, onPress }: { entry: bridgeApi.KeyEntry; disabled: boolean; pressed: boolean; onPress: () => void }) {
  const cls = `col keys-cell${warns(entry) ? " keys-warn" : ""}${pressed ? " keys-pressed" : ""}`;
  return (
    <button type="button" className={cls} disabled={disabled} data-pressed={pressed ? "" : undefined} onClick={onPress}>
      <span className="keys-label">{entry.label}</span>
      <span className="mono keys-token">{entry.keys.join(" ")}</span>
    </button>
  );
}

/**
 * The Keys sheet (design/PhoneKeys): opened from the key bar so a key can't be tapped by accident. Each key is
 * pressed at once in the terminal. The desktop's default keys come first; any other entry of keys.json is under
 * "Your keys". With `terminal.keys` off the keys are drawn but can't be pressed, and a note says where to turn
 * them on.
 */
export function KeysSheet({ agentName, host, keys, onClose, fallbackWords, demoPressed }: {
  agentName: string;
  host: string;
  keys: KeysInput | undefined;
  onClose: () => void;
  /** The composer's words for outcomes the sheet has no own words for. */
  fallbackWords: (r: SendOutcome) => string;
  /** Demo data only: the id of the key shown as just pressed. */
  demoPressed?: string;
}) {
  const on = !!keys?.enabled;
  const menu = keys?.menu;
  const [busy, setBusy] = useState(false);
  const [pressed, setPressed] = useState<{ id: string; label: string } | null>(() => {
    const e = demoPressed !== undefined ? menu?.keys.find((k) => k.id === demoPressed) : undefined;
    return e ? { id: e.id, label: e.label } : null;
  });
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    // Focus moves into the sheet (the dialog itself, so no key looks chosen), stays in it, and goes back to where it
    // was (the Keys button) when the sheet closes.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (items.length === 0) return e.preventDefault();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === box.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !box.current.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus();
    };
  }, [onClose]);

  // A changed menu is a new menu: what was pressed about the old one goes.
  const rev = useRef(menu?.rev);
  useEffect(() => {
    if (rev.current !== menu?.rev) setPressed(null);
    rev.current = menu?.rev;
  }, [menu?.rev]);

  const press = async (e: bridgeApi.KeyEntry) => {
    if (!keys || !menu || busy) return;
    setBusy(true);
    setNote(null);
    setPressed(null);
    let r: SendOutcome;
    try {
      r = await keys.press(e.id, menu.rev);
    } catch {
      r = { ok: false, code: "failed", unknown_effect: true };
    }
    setBusy(false);
    if (r.ok) setPressed({ id: e.id, label: e.label });
    else setNote(pressWords(r, host, fallbackWords));
  };

  const entries = menu?.keys ?? [];
  const base = entries.filter((e) => bridgeApi.isDefaultKey(e));
  const own = entries.filter((e) => !bridgeApi.isDefaultKey(e));
  const grid = (list: bridgeApi.KeyEntry[]) => (
    <div className="keys-grid">
      {list.map((e) => (
        <KeyCell key={e.id} entry={e} disabled={!on || busy} pressed={on && pressed?.id === e.id} onPress={() => void press(e)} />
      ))}
    </div>
  );
  return (
    <>
      <div className="keys-scrim" aria-hidden="true" onClick={onClose} />
      <section ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Special keys" className="col keys-sheet">
        <span className="nf keys-grip" aria-hidden="true" />
        <div className="row keys-head">
          <div className="col f1 keys-titles">
            <span className="keys-title">Keys</span>
            <span className="keys-sub">{on ? `Pressed at once in ${agentName}'s terminal.` : `${agentName}'s terminal`}</span>
          </div>
          <button type="button" aria-label="Close" className="row nf keys-close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        {base.length > 0 ? grid(base) : null}
        {own.length > 0 ? (
          <>
            <div className="row keys-rule">
              <span>Your keys</span>
              <span className="f1 keys-line" />
            </div>
            {grid(own)}
          </>
        ) : null}
        {!on ? (
          <div role="status" className="row keys-off">
            <span className="nf keys-off-dot" aria-hidden="true" />
            <span className="f1">{`Special keys are off for this phone. Turn them on in Remote on ${host}.`}</span>
          </div>
        ) : (
          <>
            {note ? (
              <p role="status" className="keys-note">
                {note}
              </p>
            ) : pressed ? (
              <div role="status" className="row keys-done">
                <Tile code="done" size={14} still />
                {`Pressed ${pressed.label}.`}
              </div>
            ) : null}
            <div className="keys-foot">{`Change this list in keys.json on ${host}.`}</div>
          </>
        )}
      </section>
    </>
  );
}
