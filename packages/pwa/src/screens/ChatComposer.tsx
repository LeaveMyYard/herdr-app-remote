import { useEffect, useRef, useState, type FormEvent } from "react";
import { bridgeApi } from "@herdr-remote/protocol";
import { useHostName } from "../bridge/host-name";
import { KeysButton, type KeysInput } from "./KeysSheet";
import * as W from "./keys-words";

/** The bridge's answer to `terminal.send`. */
export interface SendOutcome {
  ok: boolean;
  code?: string;
  unknown_effect?: boolean;
}

export interface ChatInput {
  /** `terminal.input` is in effect for this device (from `/api/v1/me`; the bridge checks again on every send). */
  enabled: boolean;
  /** When it turns off by itself (epoch ms), or null. */
  until: number | null;
  /** Sends `terminal.send {terminal, text}`; `hc send` pastes the text and presses Enter. */
  send: (text: string) => Promise<SendOutcome>;
  /** The special-keys menu (S16b), opened from the key bar. */
  keys?: KeysInput | undefined;
}

/**
 * Terminals the person has confirmed a first send to, for as long as the app is open. Kept outside React so that
 * leaving a chat and coming back does not ask again, and a reload (or a new launch) does.
 */
const confirmed = new Set<string>();
/** Tests only. */
export function forgetConfirmations(): void {
  confirmed.clear();
}

/** The second line of the first-send question about text (PhoneCopy, design/COPY.md). */
export const CONFIRM_NOTE = "Asked once for each terminal while the app is open.";

/** What a refused or uncertain send means here. Nothing is ever retried by itself. */
export function sendWords(r: SendOutcome, host: string): string {
  if (r.unknown_effect) return "It may have been sent. Check the terminal before you send it again.";
  switch (r.code) {
    case "forbidden":
      return `Typing to the terminal is off for this phone. Turn it on in Remote on ${host}.`;
    case "rate_limited":
      return "Sending too fast. Wait a few seconds, then send again.";
    case "busy":
      return "Still sending the last one.";
    case "terminal_blocked":
      return "The agent is waiting on a dialog at the desktop. Nothing was sent.";
    case "terminal_not_found":
    case "terminal_finished":
      return "This terminal has closed. Nothing was sent.";
    case "cancelled":
      return "Typing was turned off while this was sending. It may have been sent: check the terminal.";
    case "audit_unavailable":
      return "The desktop can't record sends right now, so nothing was sent.";
    case "bad_args":
      return "This text can't be sent.";
    case "offline":
      return "Not connected. Nothing was sent.";
    case "paused":
      return "Remote access is paused on the desktop. Nothing was sent.";
    default:
      return "Not sent.";
  }
}

/** Why the text can't go as it is, or null. The bridge checks the same rules (protocol `TerminalSendArgs`). */
export function textProblem(text: string): string | null {
  if (bridgeApi.TERMINAL_SEND_UNSAFE.test(text)) return "This text has control characters, which aren't sent.";
  const n = [...text].length;
  if (n > bridgeApi.TERMINAL_SEND_MAX_CHARS) return `Too long: ${n} of at most ${bridgeApi.TERMINAL_SEND_MAX_CHARS} characters.`;
  return null;
}

/** `21:40`, in the phone's local time. */
export function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Under this much time left, the typing line turns amber and counts down. */
export const SOON_MS = 10 * 60_000;

/** The typing-time line (design/PhoneKeys), or null with no limit. Whole minutes, rounded up. */
export function typingLine(until: number | null, now: number): { text: string; soon: boolean } | null {
  if (until === null) return null;
  const left = until - now;
  if (left >= SOON_MS) return { text: W.typingUntil(clockOf(until)), soon: false };
  return { text: W.typingSoon(Math.max(1, Math.ceil(left / 60_000)), clockOf(until)), soon: true };
}

/** Re-renders at each minute boundary while `on`, so the countdown moves. */
function useMinuteTick(on: boolean, now: () => number): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!on) return;
    let t: ReturnType<typeof setTimeout>;
    const arm = () => {
      t = setTimeout(() => {
        bump((n) => n + 1);
        arm();
      }, 60_000 - (now() % 60_000) + 5);
    };
    arm();
    return () => clearTimeout(t);
  }, [on, now]);
}

const CLOCK = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ flex: "none" }}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

/**
 * The key bar and composer of PhoneChat (design/PhoneKeys). `hc send` can only paste text and press Enter, so the
 * bar's own keys are ⏎ (Enter alone) and `/`, which only types a slash into the composer. Esc, Tab, Shift-Tab,
 * Ctrl-C and the arrows are in the Keys sheet (S16b), opened from the bar so none is tapped by accident.
 */
export function ChatComposer({ terminal, agentName, input, now = Date.now, demoSheet }: {
  terminal: string;
  agentName: string;
  input: ChatInput;
  now?: () => number;
  /** Demo data only: see Chat's `demoSheet`. */
  demoSheet?: { open: boolean; pressed: string | null };
}) {
  const host = useHostName();
  useMinuteTick(input.until !== null, now);
  const line = typingLine(input.until, now());
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  /** The text waiting on the first-send confirmation (`""` is Enter alone). */
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // A new terminal starts clean (not on mount: a demo may open the sheet at first).
  const shownTerminal = useRef(terminal);
  useEffect(() => {
    if (shownTerminal.current === terminal) return;
    shownTerminal.current = terminal;
    setText("");
    setAsking(null);
    setNote(null);
  }, [terminal]);

  const go = async (value: string) => {
    setSending(true);
    setNote(null);
    let r: SendOutcome;
    try {
      r = await input.send(value);
    } catch {
      r = { ok: false, code: "failed", unknown_effect: true };
    }
    setSending(false);
    if (r.ok) {
      // Only the text that went is cleared: an Enter alone leaves a draft where it is.
      if (value !== "") setText((t) => (t === value ? "" : t));
      return;
    }
    setNote(sendWords(r, host));
  };

  const submit = (value: string) => {
    if (sending) return;
    const problem = textProblem(value);
    if (problem) return setNote(problem);
    if (!confirmed.has(terminal)) {
      setNote(null);
      return setAsking(value);
    }
    void go(value);
  };

  const onConfirm = () => {
    const value = asking;
    setAsking(null);
    if (value === null) return;
    confirmed.add(terminal);
    void go(value);
  };

  const insertSlash = () => {
    const el = box.current;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? at;
    setText(`${text.slice(0, at)}/${text.slice(end)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + 1, at + 1);
    });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (text !== "") submit(text.replace(/\r\n?/g, "\n"));
  };

  const busy = sending || asking !== null;
  return (
    <>
      {asking !== null ? (
        <div role="alertdialog" aria-labelledby="chat-confirm-q" className="col nf chat-confirm">
          <p id="chat-confirm-q" className="chat-confirm-q">
            {asking === "" ? `Press Enter in ${agentName}'s terminal?` : `Type this into ${agentName}'s terminal?`}
          </p>
          {asking === "" ? null : <p className="chat-confirm-d">{CONFIRM_NOTE}</p>}
          <div className="row nf chat-confirm-acts">
            <button type="button" className="chat-btn" onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button type="button" className="chat-btn chat-btn-go" onClick={onConfirm}>
              Send
            </button>
          </div>
        </div>
      ) : null}
      {note ? (
        <p role="status" className="nf chat-note">
          {note}
        </p>
      ) : null}
      {line ? (
        <div role="status" className={`row nf chat-expiry${line.soon ? " chat-expiry-soon" : ""}`}>
          {CLOCK}
          <span>{line.text}</span>
        </div>
      ) : null}
      <div role="toolbar" aria-label="Keys" className="mono row nf chat-keys">
        <button type="button" className="nf chat-key" aria-label="Enter" disabled={busy} onClick={() => submit("")}>
          ⏎
        </button>
        <button type="button" className="nf chat-key" aria-label="Type a slash" disabled={busy} onClick={insertSlash}>
          /
        </button>
        <span className="f1" />
        <KeysButton key={terminal} agentName={agentName} host={host} keys={input.keys} demoSheet={demoSheet} />
      </div>
      <form className="row nf chat-form" onSubmit={onSubmit}>
        <label htmlFor="chat-msg" className="chat-sr">
          Message to the agent
        </label>
        <textarea
          id="chat-msg"
          ref={box}
          rows={1}
          className="f1 chat-text"
          placeholder="Type to the terminal…"
          value={text}
          // Frozen while a send is asked about or running: the confirmation is for exactly the text on screen.
          readOnly={busy}
          onChange={(e) => {
            if (!busy) setText(e.target.value);
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" aria-label="Send" className="row nf chat-send" disabled={busy}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
    </>
  );
}
