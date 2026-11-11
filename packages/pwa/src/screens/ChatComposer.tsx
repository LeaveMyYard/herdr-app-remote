import { useEffect, useRef, useState, type FormEvent } from "react";
import { bridgeApi } from "@herdr-remote/protocol";

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

/** What a refused or uncertain send means here. Nothing is ever retried by itself. */
export function sendWords(r: SendOutcome): string {
  if (r.unknown_effect) return "It may have been sent. Check the terminal before you send it again.";
  switch (r.code) {
    case "forbidden":
      return "Typing to the terminal is off for this device. Turn it on in the desktop's Remote panel.";
    case "rate_limited":
      return "Sending too fast. Wait a few seconds, then send again.";
    case "busy":
      return "Still sending the last one.";
    case "terminal_not_found":
    case "terminal_finished":
      return "This terminal has closed. Nothing was sent.";
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

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The key bar and composer of PhoneChat. `hc send` can only paste text and press Enter (verified in the rig), so the
 * key bar has just the keys that means: ⏎ (Enter alone) and `/`, which only types a slash into the composer. Esc,
 * Tab, ⇧Tab, Ctrl-C and the arrows on the board need special keys and are left out.
 */
export function ChatComposer({ terminal, agentName, input }: { terminal: string; agentName: string; input: ChatInput }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  /** The text waiting on the first-send confirmation (`""` is Enter alone). */
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // A new terminal starts clean.
  useEffect(() => {
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
    setNote(sendWords(r));
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
          <p className="chat-confirm-d">It is pasted and sent with Enter, as if you typed it at the desktop. You are asked once per terminal.</p>
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
      <div role="toolbar" aria-label="Keys" className="mono row nf chat-keys">
        <button type="button" className="nf chat-key" aria-label="Enter" disabled={busy} onClick={() => submit("")}>
          ⏎
        </button>
        <button type="button" className="nf chat-key" aria-label="Type a slash" disabled={busy} onClick={insertSlash}>
          /
        </button>
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
          placeholder={input.until !== null ? `Type to the terminal… (on until ${clock(input.until)})` : "Type to the terminal…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" aria-label="Send" className="row nf chat-send" disabled={busy || text === ""}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      </form>
    </>
  );
}
