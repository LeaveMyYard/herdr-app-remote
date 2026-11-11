import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import { AnsiText } from "../components/AnsiText";
import type { AgentStatus } from "../model";

const HARNESS_ICON = { claude: claudeIcon, codex: codexIcon } as const;

export interface ChatAgent {
  name: string;
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
}

/** What each `stale` reason means for this screen. An unknown reason still says the text may be old. */
const STALE_TEXT: Record<string, string> = {
  source_unavailable: "Can't reach the terminal. Showing the last text.",
  terminal_not_found: "This terminal has closed.",
  too_many_chats: "Too many chats are open. Close one to read this.",
  bad_terminal: "This isn't a terminal herdr knows.",
  reconnecting: "Reconnecting. Showing the last text.",
  layout_without_remote: "Switch to a layout with Remote",
};

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

/**
 * Read-only chat: the terminal's text, an inbox banner when a question waits, and a footer that says input is off.
 * Sending is S16 (`terminal.input`); this screen has no composer and no keys.
 */
export function Chat({ agent, topic, stale, question, backHref = "#/agents" }: ChatProps) {
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
  useLayoutEffect(() => {
    const el = view.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [topic]);
  useEffect(() => {
    pinned.current = true;
  }, [topic?.terminal]);

  const notice = stale === undefined ? undefined : (STALE_TEXT[stale] ?? "Showing older text.");
  return (
    <>
      <header className="row nf chat-head">
        <a href={backHref} aria-label="Back" className="row nf chat-back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </a>
        <div className="z row f1 chat-title">
          <img className="hn" src={HARNESS_ICON[agent.harness]} alt="" width={14} height={14} />
          <span className="nf tr chat-name">{agent.name}</span>
          <span className="f1 tr chat-folder">{agent.folder}</span>
          <Status status={agent.status} />
        </div>
        <button type="button" aria-label="Fit width" aria-pressed={fit} className="mono row nf chat-fit" onClick={toggleFit}>
          Aa
        </button>
      </header>
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
      <footer className="col nf chat-foot" data-vis-mask="">
        <p className="chat-ro">Read-only here. Typing to the terminal is off for this device.</p>
      </footer>
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
