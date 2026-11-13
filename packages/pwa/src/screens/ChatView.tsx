import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import type { OlderResult } from "../bridge/chatview";
import { useHostName } from "../bridge/host-name";
import { applyTopic, initHeld, prepend, type Held } from "../chatview/merge";
import { renderDefaultItem, Spinner, type ItemCtx } from "../chatview/Items";
import * as W from "../chatview/words";
import { ChatHead, useInputOn, type ChatAgent } from "./Chat";
import { ChatComposer, clockOf, type ChatInput } from "./ChatComposer";
import * as K from "./keys-words";

type Item = bridgeApi.ChatItem;

export interface ChatViewProps {
  agent: ChatAgent;
  topic: bridgeApi.ChatviewTopic;
  /** `GET /api/v1/chatview/<t>?before=`; without it older items are not offered. */
  loadOlder?: ((before: string, rev: string) => Promise<OlderResult>) | undefined;
  /** The capability went away under an older page (403): the screen drops to the text view. */
  onForbidden?: (() => void) | undefined;
  input?: ChatInput | undefined;
  terminal?: string | undefined;
  backHref?: string;
  now?: () => number;
  /**
   * Extension points (CV5 timeline, CV7 cards). `strip` is a row under the header. `renderItem` is tried first for
   * every item: `undefined` means "draw the default", which it gets as `draw()`. `tail` comes after the last item,
   * before the status line.
   */
  strip?: ReactNode;
  tail?: ReactNode;
  /** A native prompt is open (CV7): the composer waits. */
  locked?: boolean;
  renderItem?: ((item: Item, prev: Item | undefined, draw: () => ReactNode) => ReactNode | undefined) | undefined;
}

/** Scrolled this close to the end counts as following it. */
const FOLLOW_PX = 24;
/** The jump button shows once the end is this far off. */
const JUMP_PX = 160;
/** Older items are asked for when the top is this close. */
const TOP_PX = 160;

function statusLine(status: bridgeApi.ChatviewStatus, now: number): ReactNode {
  if (status.state === "working") {
    const since = status.since ? Date.parse(status.since) : NaN;
    return (
      <div role="status" className="row cv-status">
        <Spinner size={13} />
        <span>{Number.isFinite(since) ? `${W.WORKING} · ${W.elapsed(now - since)}` : W.WORKING}</span>
      </div>
    );
  }
  if (status.state === "blocked") {
    return (
      <div role="status" className="row cv-status cv-status-wait">
        <span>{W.WAITING}</span>
      </div>
    );
  }
  return null;
}

/** Counts a new item for the jump button; dividers aren't news. */
const isNews = (i: Item) => i.role !== "divider";

/**
 * The chat view of a Claude agent (docs/chatview.md §3): bubbles, markdown, tool rows, the status line and a text
 * composer. The scroll follows the end unless the reader has scrolled up; then a button jumps back, counting what
 * arrived. Older pages load as the top is reached.
 */
export function ChatView({ agent, topic, loadOlder, onForbidden, input, terminal, backHref = "#/agents", now = Date.now, strip, tail, locked, renderItem }: ChatViewProps) {
  const host = useHostName();
  const { on, ranOut } = useInputOn(input, now);
  const [held, setHeld] = useState<Held>(() => initHeld(topic));
  // Derived state: a new topic value is merged during the render that sees it.
  let cur = held;
  if (held.src !== topic) {
    cur = applyTopic(held, topic);
    setHeld(cur);
  }
  const items = cur.items;

  // A clock for the status line and the day labels, ticking each second only while working.
  const working = topic.status.state === "working";
  const [, tick] = useState(0);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [working]);
  const t0 = now();

  // Older pages.
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const inflight = useRef(false);
  const heldRef = useRef(cur);
  heldRef.current = cur;
  const view = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const more = useCallback(() => {
    const h = heldRef.current;
    const first = h.items[0];
    if (!loadOlder || !h.older || !first || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    setFailed(false);
    const el = view.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void loadOlder(first.id, h.rev).then((r) => {
      inflight.current = false;
      if (!alive.current) return;
      setLoading(false);
      if (r.ok) setHeld((c) => prepend(c, r.page, first.id));
      else {
        anchor.current = null;
        // Another history: the topic is bringing it. Capability off: the text view takes over. Else offer a retry.
        if (r.code === "forbidden") onForbidden?.();
        else if (r.code === "failed") setFailed(true);
      }
    });
  }, [loadOlder, onForbidden]);

  // Follow the end, unless the reader has scrolled up.
  const pinned = useRef(true);
  const lastSeen = useRef<string | null>(null);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(0);
  const countFresh = useCallback((list: Item[]) => {
    if (lastSeen.current === null) return 0;
    const at = list.findIndex((i) => i.id === lastSeen.current);
    return at < 0 ? 0 : list.slice(at + 1).filter(isNews).length;
  }, []);
  const onScroll = () => {
    const el = view.current;
    if (!el) return;
    const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = fromEnd < FOLLOW_PX;
    if (pinned.current) {
      lastSeen.current = heldRef.current.items.at(-1)?.id ?? null;
      setFresh(0);
    }
    setAway(fromEnd > JUMP_PX);
    if (el.scrollTop < TOP_PX) more();
  };
  const shownTerminal = useRef(topic.terminal);
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    if (shownTerminal.current !== topic.terminal) {
      shownTerminal.current = topic.terminal;
      pinned.current = true;
    }
    if (anchor.current) {
      // An older page went in above: keep what the reader was looking at where it was.
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      lastSeen.current = items.at(-1)?.id ?? null;
      setFresh(0);
      setAway(false);
    } else setFresh(countFresh(items));
  }, [items, topic.status, topic.terminal, countFresh]);

  // A short history that doesn't fill the screen has nothing to scroll: ask for more.
  useEffect(() => {
    const el = view.current;
    if (el && cur.older && !failed && el.scrollHeight <= el.clientHeight + TOP_PX) more();
  }, [cur.older, cur.items, failed, more]);

  const jump = () => {
    const el = view.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
    lastSeen.current = items.at(-1)?.id ?? null;
    setFresh(0);
    setAway(false);
  };

  const ctx: ItemCtx = { agent: agent.short ?? agent.name, working, now: t0 };
  const typing = on && input && terminal !== undefined ? { input, terminal } : null;
  const empty = items.length === 0;
  return (
    <>
      <ChatHead roomy agent={agent} backHref={backHref} />
      {strip}
      <main className="rel col f1 cv-main">
        <div ref={view} role="log" aria-label="Conversation" className="col f1 cv-scroll" tabIndex={0} onScroll={onScroll}>
          {empty ? (
            <div className="col f1 cv-empty">
              <svg width="31" height="31" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 5h16v11H9l-5 4z" />
              </svg>
              <span className="cv-empty-t">{W.EMPTY_TITLE}</span>
              <span className="cv-empty-b">{W.emptyBody(agent.folder)}</span>
            </div>
          ) : (
            <div className="col cv-list">
              {cur.older ? (
                <div className="row cv-older">
                  {loading ? (
                    <span className="row cv-older-pill">
                      <Spinner />
                      {W.LOADING_OLDER}
                    </span>
                  ) : failed ? (
                    <button type="button" className="row cv-older-pill" onClick={more}>
                      {W.SHOW_OLDER}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {items.map((item, i) => {
                const prev = items[i - 1];
                const draw = () => renderDefaultItem(item, prev, ctx);
                const node = renderItem?.(item, prev, draw) ?? draw();
                return node === null || node === undefined ? null : (
                  <div key={item.id} className="cv-item">
                    {node}
                  </div>
                );
              })}
              {tail}
              {statusLine(topic.status, t0)}
            </div>
          )}
          {empty ? (
            <>
              {tail}
              {statusLine(topic.status, t0)}
            </>
          ) : null}
        </div>
        {away || fresh > 0 ? (
          <button type="button" className="row cv-jump" onClick={jump}>
            {fresh > 0 ? <span className="nf cv-jump-dot" aria-hidden="true" /> : null}
            {W.jumpLabel(fresh)}
            <span className="cv-jump-arrow" aria-hidden="true">
              ↓
            </span>
          </button>
        ) : null}
      </main>
      {typing ? (
        <footer className="col nf chat-foot chat-foot-on cv-foot" data-vis-mask="">
          <ChatComposer variant="chat" locked={locked === true} terminal={typing.terminal} agentName={agent.short ?? agent.name} input={typing.input} now={now} />
        </footer>
      ) : (
        <footer className={`col nf chat-foot cv-foot${ranOut !== null ? " chat-foot-out" : ""}`}>
          {ranOut !== null ? (
            <>
              <p className="chat-out">{K.typingRanOut(clockOf(ranOut))}</p>
              <p className="chat-out-how">{K.typingRanOutHow(host)}</p>
            </>
          ) : (
            <p className="chat-ro cv-ro">{W.TYPING_OFF}</p>
          )}
        </footer>
      )}
    </>
  );
}
