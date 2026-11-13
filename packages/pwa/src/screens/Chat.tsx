import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import { AnsiText } from "../components/AnsiText";
import type { AgentStatus } from "../model";
import { useHostName } from "../bridge/host-name";
import { ChatComposer, clockOf, type ChatInput } from "./ChatComposer";
import { KeysButton } from "./KeysSheet";
import type { StripSlot } from "./ChatView";
import * as W from "./keys-words";
import { noticeWords, type NoticeKind } from "../chatview/words";

const HARNESS_ICON = { claude: claudeIcon, codex: codexIcon } as const;

export interface ChatAgent {
  name: string;
  /** The name in sentences ("Agent 1's terminal") when `name` carries more (the demo's "Agent 1 · Parser rewrite"). */
  short?: string;
  /** Folder, already shortened with `~`. */
  folder: string;
  harness: "claude" | "codex";
  status: AgentStatus;
}

/** The inbox question waiting on this agent, from the `inbox` topic. */
export interface ChatQuestion {
  id: string;
  /** Where Answer goes. */
  href: string;
}

export interface ChatProps {
  agent: ChatAgent;
  /** The `chat:<t>` topic; undefined until the first snap. */
  topic: bridgeApi.ChatTopic | undefined;
  /** The topic's `stale` reason, if any. */
  stale?: string | undefined;
  question?: ChatQuestion | undefined;
  backHref?: string;
  /** Typing to the terminal (S16). Without it, or while `terminal.input` is off or has run out, the chat is read-only. */
  input?: ChatInput | undefined;
  /** The terminal the composer sends to; required for the composer to show. */
  terminal?: string | undefined;
  /** Why this is the text view and not the chat view (§6); closable. */
  viewNotice?: NoticeKind | null | undefined;
  /** A row under the header (CV5's swarm and account strip); as a function it draws Aa on that row instead. */
  strip?: StripSlot;
  /** The chat view boards' taller header (14 px more under the status bar); set by `ChatRoute`. */
  roomy?: boolean;
  now?: () => number;
  /** Demo data only (the PhoneKeys board's states): the Keys sheet open at first, and the key shown as pressed. */
  demoSheet?: { open: boolean; pressed: string | null };
  /** Demo data only (the visual boards): the read-only footer keeps the board's 139 px slot. A real phone gets a footer as tall as its text. */
  boardSlot?: boolean;
}

/**
 * Whether the composer shows: on, and not past its expiry. Re-renders when the expiry passes. `ranOut` is when a
 * grant this screen saw running out did (the board's "Typing turned off at 21:40"), or null.
 */
export function useInputOn(input: ChatInput | undefined, now: () => number): { on: boolean; ranOut: number | null } {
  const until = input?.enabled ? input.until : null;
  // The last limit seen while typing was on: after it passes, /api/v1/me reads off with no limit at all.
  const seen = useRef<number | null>(null);
  if (input?.enabled) seen.current = until;
  // Turned off from the desktop before its time: that is not running out.
  else if (seen.current !== null && now() < seen.current) seen.current = null;
  const [, bump] = useState(0);
  useEffect(() => {
    if (until === null) return;
    const left = until - now();
    if (left <= 0) return;
    const t = setTimeout(() => bump((n) => n + 1), Math.min(left, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [until, now]);
  const on = !!input?.enabled && (until === null || now() < until);
  const last = seen.current;
  return { on, ranOut: !on && last !== null && now() >= last ? last : null };
}

/** What each `stale` reason means for this screen. An unknown reason still says the text may be old. */
const STALE_TEXT: Record<string, string> = {
  source_unavailable: "Can't reach the terminal. Showing the last text.",
  terminal_not_found: "This terminal has closed.",
  too_many_chats: "Too many chats are open. Close one to read this.",
  bad_terminal: "This isn't a terminal herdr knows.",
  hc_missing: "The computer can't find herdr's hc command. Showing the last text.",
  no_terminal: "This agent has no terminal to read.",
};

/**
 * The same reasons when there is no text at all yet: the screen says what went wrong instead of waiting. Every
 * reason the bridge can give before a first read lands here, so no failure leaves the screen waiting.
 */
const STALE_ERROR: Record<string, { title: string; body: (host: string) => string }> = {
  source_unavailable: { title: "Can't read this terminal", body: (h) => `herdr on ${h} didn't answer. It tries again by itself.` },
  terminal_not_found: { title: "This terminal has closed", body: () => "herdr doesn't list it any more." },
  too_many_chats: { title: "Too many chats are open", body: () => "Close another chat to read this one." },
  bad_terminal: { title: "This isn't a terminal herdr knows", body: () => "Go back and pick the agent again." },
  hc_missing: { title: "hc isn't found", body: (h) => `Remote on ${h} can't find herdr's hc command (looked on PATH and in ~/.local/bin). Remote's Setup on ${h} shows it too.` },
  no_terminal: { title: "No terminal to read", body: () => "This agent has no terminal herdr can read." },
  // Set by the app, not the bridge: a value arrived that this version can't read.
  bad_data: { title: "Can't show this terminal", body: (h) => `${h} sent text this version of the app can't read. Updating Remote may help.` },
};

/**
 * With no text and no reason from the bridge, the screen stops saying "Waiting" after this long. Above the bridge's
 * worst first answer (`hc ls` then `hc read`, 4 s timeout each), so a hung hc shows its own reason first.
 */
export const CHAT_WAIT_MS = 10_000;

/** True once `ms` has passed since `key` last changed. */
function useElapsed(key: string | undefined, ms: number): boolean {
  const [done, setDone] = useState<string | undefined | null>(null);
  useEffect(() => {
    setDone(null);
    const t = setTimeout(() => setDone(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return done === key;
}

const FIT_KEY = "chat.fit";

function loadFit(): boolean {
  try {
    return window.localStorage.getItem(FIT_KEY) !== "scroll";
  } catch {
    return true;
  }
}

function Status({ status }: { status: AgentStatus }) {
  switch (status) {
    case "needs-you":
      return <span className="needs-pill">Needs you</span>;
    case "working":
      return <i className="spin work-spinner" data-vis-mask="" role="img" aria-label="Working" />;
    case "done":
      return <span className="dot dot-done" role="img" aria-label="Done" />;
    case "idle":
      return <span className="dot dot-ring" role="img" aria-label="Idle" />;
  }
}

/** The header both views share: back, the agent, its status mark, and `right` (the text view's Aa). */
export function ChatHead({ agent, backHref, right, roomy }: { agent: ChatAgent; backHref: string; right?: ReactNode; roomy?: boolean | undefined }) {
  return (
    <header className={`row nf chat-head${roomy ? " chat-head-roomy" : ""}`}>
      <a href={backHref} aria-label="Back" className="row nf chat-back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </a>
      <div className="z row f1 chat-title">
        <img className="hn" src={HARNESS_ICON[agent.harness]} alt="" width={14} height={14} />
        <span className="nf tr chat-name">{agent.name}</span>
        <span className="f1 tr chat-folder">{agent.folder}</span>
        {/* The chat view boards draw no mark for an idle agent (a new session). */}
        {roomy && agent.status === "idle" ? null : <Status status={agent.status} />}
      </div>
      {right}
    </header>
  );
}

/** Why the chat view isn't here, with a close for the session (§6). */
const closedNotices = new Set<string>();
function ViewNotice({ id, kind }: { id: string; kind: NoticeKind }) {
  const host = useHostName();
  const key = `${id}:${kind}`;
  const [closed, setClosed] = useState(() => closedNotices.has(key));
  if (closed) return null;
  const w = noticeWords(kind, host);
  return (
    <div className="row nf chat-vnotice">
      <span className="nf chat-vnotice-ic" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
      </span>
      <span className="col f1 chat-vnotice-t">
        <span>{w.title}</span>
        <span className="chat-vnotice-b">{w.body}</span>
      </span>
      <button type="button" aria-label="Close" className="row nf chat-vnotice-x" onClick={() => { closedNotices.add(key); setClosed(true); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * The chat: the terminal's text, an inbox banner when a question waits, and a footer. With `terminal.input` on, the
 * footer is the key bar and composer (S16); otherwise it says typing is off.
 */
export function Chat({ agent, topic, stale, question, backHref = "#/agents", input, terminal, viewNotice, strip, roomy, now = Date.now, demoSheet, boardSlot }: ChatProps) {
  const host = useHostName();
  const { on, ranOut } = useInputOn(input, now);
  const typing = on && input && terminal !== undefined ? { input, terminal } : null;
  // `terminal.keys` on while typing is off: the Keys button still has a bar of its own.
  const keysBar = !typing && input?.keys?.enabled && terminal !== undefined ? { keys: input.keys, terminal } : null;
  const [fit, setFit] = useState(loadFit);
  const toggleFit = () => {
    setFit((f) => {
      try {
        window.localStorage.setItem(FIT_KEY, f ? "scroll" : "fit");
      } catch {
        // Private mode: the choice just doesn't persist.
      }
      return !f;
    });
  };

  // Follow the end of the output, unless the reader has scrolled up.
  const view = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = () => {
    const el = view.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const shown = useRef(topic?.terminal);
  useLayoutEffect(() => {
    if (shown.current !== topic?.terminal) {
      shown.current = topic?.terminal;
      pinned.current = true;
    }
    const el = view.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [topic]);

  // With text on screen a reason is a notice above it; with none yet it is the screen's whole message.
  const notice = stale === undefined || !topic ? undefined : (STALE_TEXT[stale] ?? "Showing older text.");
  const error = topic ? undefined : stale !== undefined ? (STALE_ERROR[stale] ?? { title: "Can't read this terminal", body: () => STALE_TEXT[stale] ?? `The computer said: ${stale}.` }) : undefined;
  const waitedOut = useElapsed(terminal ?? agent.name, CHAT_WAIT_MS);
  const fitButton = (
    <button type="button" aria-label="Fit width" aria-pressed={fit} className="mono row nf chat-fit" onClick={toggleFit}>
      Aa
    </button>
  );
  return (
    <>
      <ChatHead roomy={roomy} agent={agent} backHref={backHref} right={typeof strip === "function" ? undefined : fitButton} />
      {typeof strip === "function" ? strip(fitButton) : strip}
      {viewNotice ? <ViewNotice id={terminal ?? agent.name} kind={viewNotice} /> : null}
      <main className="col f1 chat-main">
        {notice ? (
          <div role="status" className="nf chat-notice">
            {notice}
          </div>
        ) : null}
        {/* The visual check masks the text: its symbols (bullets, box drawing) come from whatever monospace font the host has, so only the layout around it is compared. */}
        <div ref={view} data-vis-mask="" className="mono f1 chat-term" data-fit={fit ? "true" : "false"} role="log" aria-label="Terminal output" tabIndex={0} onScroll={onScroll}>
          {topic ? (
            topic.lines.length > 0 ? (
              <AnsiText lines={topic.lines} />
            ) : (
              <div className="chat-empty">Nothing on screen yet.</div>
            )
          ) : error ? (
            <div role="alert" className="chat-error">
              <p className="chat-error-title">{error.title}</p>
              <p className="chat-error-body">{error.body(host)}</p>
            </div>
          ) : waitedOut ? (
            <div role="alert" className="chat-error">
              <p className="chat-error-title">No answer yet</p>
              <p className="chat-error-body">{`${host} hasn't sent this terminal. Check that Remote is running there, or go back and try again.`}</p>
            </div>
          ) : (
            <div className="chat-empty">Waiting for the terminal…</div>
          )}
        </div>
      </main>
      {question ? (
        <a href={question.href} className="rel row nf s-wait chat-banner">
          <span className="abs chat-banner-edge" aria-hidden="true" />
          <span className="tile s-wait t18 wide" data-vis-mask="" aria-hidden="true">
            ?1
          </span>
          <span className="f1">{question.id} waits for you</span>
          <span className="chat-banner-go">Answer ›</span>
        </a>
      ) : null}
      {typing ? (
        <footer className="col nf chat-foot chat-foot-on" data-vis-mask="">
          <ChatComposer terminal={typing.terminal} agentName={agent.short ?? agent.name} input={typing.input} now={now} {...(demoSheet ? { demoSheet } : {})} />
        </footer>
      ) : (
        <footer className={`col nf chat-foot${ranOut !== null ? " chat-foot-out" : ""}${keysBar ? " chat-foot-keys" : ""}${boardSlot && ranOut === null && !keysBar ? " chat-foot-slot" : ""}`} {...(ranOut === null && !keysBar ? { "data-vis-mask": "" } : {})}>
          {ranOut !== null ? (
            <>
              <p className="chat-out">{W.typingRanOut(clockOf(ranOut))}</p>
              <p className="chat-out-how">{W.typingRanOutHow(host)}</p>
            </>
          ) : (
            <p className="chat-ro">Read-only here. Typing to the terminal is off for this device.</p>
          )}
          {keysBar ? (
            // Special keys without typing (operator, 2026-11-11): the key bar with only the Keys button.
            <div role="toolbar" aria-label="Keys" className="mono row nf chat-keys chat-keys-only">
              <span className="f1" />
              <KeysButton key={keysBar.terminal} agentName={agent.short ?? agent.name} host={host} keys={keysBar.keys} />
            </div>
          ) : null}
        </footer>
      )}
    </>
  );
}

/** The Chat tab with no agent picked. */
export function ChatPicker({ agents }: { agents: { id: string; name: string; tab: string }[] }) {
  return (
    <>
      <div className="nf status-spacer" />
      <div className="row nf screen-title">
        <span>Chat</span>
      </div>
      <main className="col f1 screen chat-pick">
        {agents.length === 0 ? (
          <p className="missing-body">No agents are running.</p>
        ) : (
          agents.map((a) => (
            <a key={a.id} href={`#/chat/${a.id}`} className="arow">
              <span className="tr arow-title">{a.name}</span>
              <span className="tr f1 arow-tab">· {a.tab}</span>
            </a>
          ))
        )}
      </main>
    </>
  );
}
