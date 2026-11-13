import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import type { OlderResult } from "../bridge/chatview";
import { BusyProvider } from "../chatview/busy";
import type { ViewMode } from "../chatview/mode";
import { Chat, ChatHead, type ChatProps } from "./Chat";
import { ChatView, type ChatViewProps } from "./ChatView";
import type { PromptAct } from "../chatview/prompt/PromptCard";

export interface ChatRouteProps {
  mode: ViewMode;
  /** The text view (and the header's agent). */
  text: ChatProps;
  view?: {
    topic: bridgeApi.ChatviewTopic | undefined;
    loadOlder?: ((before: string, rev: string) => Promise<OlderResult>) | undefined;
    onForbidden?: (() => void) | undefined;
    /** Sends `prompt.answer` (CV7). */
    promptAct?: PromptAct | undefined;
  } | undefined;
  /** Extension points of the chat view (CV5, CV7). */
  /** What is on screen now (null while pending), so the text topics stay subscribed while a held text view shows. */
  onShown?: ((view: "chat" | "text" | null) => void) | undefined;
  slots?: Pick<ChatViewProps, "strip" | "tail" | "renderItem" | "locked" | "timeline"> | undefined;
}

/**
 * Chooses between the chat view and the text view (§6). Once the chat source is there the screen moves to the chat
 * view, but waits while the person is in the middle of something in the text view (a draft, the Keys sheet), so
 * nothing they are doing is lost. There is no manual switch.
 */
export function ChatRoute({ mode, text, view, slots, onShown }: ChatRouteProps) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((id: string, b: boolean) => {
    setBusy((s) => {
      if (s.has(id) === b) return s;
      const n = new Set(s);
      if (b) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);
  const last = useRef<"chat" | "text" | null>(null);
  const want = mode.kind === "chat" && view?.topic ? "chat" : mode.kind === "text" ? "text" : null;
  const shown = want === "chat" && last.current === "text" && busy.size > 0 ? "text" : want;
  last.current = shown;
  useEffect(() => {
    onShown?.(shown);
    return () => onShown?.(null);
  }, [shown, onShown]);

  if (shown === "chat" && view?.topic) {
    return (
      <ChatView
        agent={text.agent}
        topic={view.topic}
        loadOlder={view.loadOlder}
        onForbidden={view.onForbidden}
        promptAct={view.promptAct}
        input={text.input}
        terminal={text.terminal}
        backHref={text.backHref ?? "#/agents"}
        {...(text.now ? { now: text.now } : {})}
        {...slots}
      />
    );
  }
  if (shown === "text") {
    const notice = mode.kind === "text" ? mode.notice : null;
    return (
      <BusyProvider report={report}>
        <Chat {...text} viewNotice={notice} strip={slots?.strip} roomy />
      </BusyProvider>
    );
  }
  // Waiting for the first answer: the header and nothing else, so no text view flashes before the chat view.
  const blank: ReactNode = <main className="col f1 cv-main" aria-busy="true" />;
  return (
    <>
      <ChatHead roomy agent={text.agent} backHref={text.backHref ?? "#/agents"} />
      {blank}
    </>
  );
}
