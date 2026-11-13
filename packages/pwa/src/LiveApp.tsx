import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridgeApi, HostState } from "@herdr-remote/protocol";
import { App, type AppData, type HomePromptState, type LiveSources } from "./App";
import type { BridgeClient, ClientSnapshot } from "./bridge/client";
import { fetchHostName, HostNameProvider } from "./bridge/host-name";
import { fetchOlder, type OlderResult } from "./bridge/chatview";
import { chatMode, isClaude, useWaited, VIEW_WAIT_MS, type ViewMode } from "./chatview/mode";
import { fetchTerminalInput, type TerminalInputView } from "./bridge/me";
import { useBridge, useTopics } from "./bridge/react";
import { isStandalone, promptWanted, refreshManifest, setPromptWanted } from "./pair/flow";
import { browserEnv } from "./push/push";
import type { ChatInput } from "./screens/ChatComposer";
import type { Connection } from "./model";

/** Always wanted: the Agents and Swarm tabs, the plugin cards and the Inbox badge need them. */
const BASE_TOPICS = ["host", "plugins", "panorama", "inbox"] as const;

function parsed<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | undefined {
  if (v === undefined) return undefined;
  const r = schema.safeParse(v);
  return r.success ? r.data : undefined;
}

/** The banner: the socket's state first, then the host topic's staleness. Online with fresh host data is undefined (App decides). */
export function liveConnection(snap: ClientSnapshot): Connection | undefined {
  if (snap.status !== "online") return { status: snap.status };
  const host = snap.topics.host;
  if (!host || host.data === undefined) return { status: "connecting" };
  if (host.stale) return { status: "stale", reason: host.stale };
  return undefined;
}

/** The desktop's name from the serve name (`desk-1.example-tailnet.ts.net` → `desk-1`). */
export function hostNameFrom(hostname: string): string {
  return hostname.split(".")[0] || hostname;
}

const route = (hash: string) => hash.replace(/^#\/?/, "").split("/");
const tabOf = (hash: string) => route(hash)[0];

function decode(s: string | undefined): string | null {
  if (!s) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** While a chat is open, `/api/v1/me` is read this often, so a desktop toggle shows without reopening it. */
export const ME_POLL_MS = 20_000;

/**
 * This device's `terminal.input`, read from `/api/v1/me` while `active` (a chat is open) and the socket is online:
 * at once, every {@link ME_POLL_MS}, and on `refresh()`. Off until the first answer.
 */
function useTerminalInput(active: boolean, online: boolean, read: () => Promise<TerminalInputView | null>) {
  const [view, setView] = useState<TerminalInputView>({ enabled: false, until: null, keys: { enabled: false, until: null } });
  const refresh = useCallback(() => {
    void read().then((v) => {
      if (v) setView(v);
    });
  }, [read]);
  useEffect(() => {
    if (!active || !online) return;
    refresh();
    const t = setInterval(refresh, ME_POLL_MS);
    return () => clearInterval(t);
  }, [active, online, refresh]);
  return { view, refresh };
}

/**
 * The "Add to Home Screen" prompt (S5b), in the browser only. While it is open and the socket is online, the bridge
 * mints a one-time transfer code for this device (`act pair.transfer`) and the browser reads the manifest again, so
 * a Home Screen app added now opens at `/pair#t=<code>` and sets itself up as this device. The page never sees the
 * code: it is in the manifest only.
 */
function useHomePrompt(client: BridgeClient, online: boolean, standalone: boolean, refresh: () => void): HomePromptState | null {
  const [open, setOpen] = useState(() => !standalone && promptWanted());
  // One code per opening: a reconnect while it stays open doesn't mint (and log) another.
  const minted = useRef(false);
  useEffect(() => {
    if (!open) {
      minted.current = false;
      return;
    }
    if (!online || standalone || minted.current) return;
    minted.current = true;
    void client.act("pair.transfer").then((r) => {
      if (r.ok) refresh();
      // Not minted (offline, refused): the next time it is open and online tries again.
      else minted.current = false;
    });
  }, [open, online, standalone, client, refresh]);
  const onOpen = useCallback(() => {
    setPromptWanted(true);
    setOpen(true);
  }, []);
  const onClose = useCallback(() => {
    setPromptWanted(false);
    setOpen(false);
  }, []);
  if (standalone) return null;
  return { open: open && online, onOpen, onClose };
}

const refreshManifestNow = () => refreshManifest();

/** The app over the bridge: topics in, `act`s out. Nothing changes on screen until the bridge says so. */
export function LiveApp({
  client,
  hostName = hostNameFrom(window.location.hostname),
  readTerminalInput = fetchTerminalInput,
  readHostName = fetchHostName,
  standalone = isStandalone(),
  onManifest = refreshManifestNow,
}: {
  client: BridgeClient;
  hostName?: string;
  /** Test seam for `GET /api/v1/me`. */
  readTerminalInput?: () => Promise<TerminalInputView | null>;
  /** Test seam for `GET /api/v1/meta`'s `host_name`. */
  readHostName?: () => Promise<string | null>;
  /** Installed to the Home Screen: no bell, no prompt. */
  standalone?: boolean;
  /** Test seam: makes the browser read the manifest again. */
  onManifest?: () => void;
}) {
  const snap = useBridge(client);
  // The bridge's own name for the computer (serve identity, else its hostname); the page's host name until it answers.
  const [bridgeHostName, setBridgeHostName] = useState<string | null>(null);
  const online = snap.status === "online";
  useEffect(() => {
    if (!online) return;
    let live = true;
    void readHostName().then((n) => {
      if (live && n) setBridgeHostName(n);
    });
    return () => {
      live = false;
    };
  }, [online, readHostName]);
  const name = bridgeHostName ?? hostName;
  const homePrompt = useHomePrompt(client, online, standalone, onManifest);
  useTopics(client, BASE_TOPICS);
  // Usage polls the desktop's CLI while subscribed, so it is asked for only once the tab has been opened.
  const hash = useHash();
  const [usageSeen, setUsageSeen] = useState(() => tabOf(hash) === "usage");
  useEffect(() => {
    if (tabOf(hash) === "usage") setUsageSeen(true);
  }, [hash]);
  useTopics(client, ["usage"], usageSeen);

  // Parsed once per new value: a topic's data keeps its identity until a snap or patch replaces it.
  const t = snap.topics;
  const host = useMemo(() => parsed(HostState, t.host?.data), [t.host?.data]);
  const panorama = useMemo(() => parsed(bridgeApi.PanoramaTopic, t.panorama?.data), [t.panorama?.data]);
  const plugins = useMemo(() => parsed(bridgeApi.PluginsTopic, t.plugins?.data), [t.plugins?.data]);
  const inbox = useMemo(() => parsed(bridgeApi.InboxTopic, t.inbox?.data), [t.inbox?.data]);
  const usage = useMemo(() => parsed(bridgeApi.UsageTopic, t.usage?.data), [t.usage?.data]);

  // `#/chat/<agent id>`: the agent's terminal is read through `chat:<terminal>` only while the chat is open.
  const parts = route(hash);
  const chatAgentId = parts[0] === "chat" ? decode(parts[1]) : null;
  const chatAgent = chatAgentId !== null ? host?.agents.find((a) => a.id === chatAgentId) : undefined;
  const terminal = chatAgent?.terminal_id;
  const chatName = terminal !== undefined ? `chat:${terminal}` : null;
  // A Claude agent's screen is the chat view (`chatview:<t>`); the terminal text (`chat:<t>`) and the key menu are
  // read only while the screen is the text view (Codex, or the chat source unavailable: §6).
  const claude = chatAgent !== undefined && isClaude(chatAgent);
  const viewName = terminal !== undefined && claude ? `chatview:${terminal}` : null;
  useTopics(client, viewName ? [viewName] : [], viewName !== null);
  const viewTopicView = viewName ? t[viewName] : undefined;
  const viewTopic = useMemo(() => parsed(bridgeApi.ChatviewTopic, viewTopicView?.data), [viewTopicView?.data]);
  const viewStale = viewTopicView?.stale ?? (viewTopicView?.data !== undefined && viewTopic === undefined ? "bad_data" : null);
  // An older page refused with 403: the capability went away; the text view takes over until the agent is reopened.
  // It lasts until the topic brings a newer value (the capability may be back) or the agent is closed.
  const [deniedFor, setDeniedFor] = useState<{ terminal: string; seq: number } | null>(null);
  const viewSeq = viewTopicView?.seq ?? -1;
  const denied = terminal !== undefined && deniedFor?.terminal === terminal && deniedFor.seq === viewSeq;
  useEffect(() => {
    if (terminal === undefined) setDeniedFor(null);
  }, [terminal]);
  const [shown, setShown] = useState<"chat" | "text" | null>(null);
  const onForbidden = useCallback(() => {
    if (terminal !== undefined) setDeniedFor({ terminal, seq: viewSeq });
  }, [terminal, viewSeq]);
  // CV7: a prompt card's answer. Never retried; an unknown effect re-reads the chat view, so the card shows as it is now.
  const promptAct = useCallback(
    async (kind: "prompt.answer", args: Record<string, unknown>) => {
      const r = await client.act(kind, args);
      if (r.unknown_effect && viewName) client.refresh(viewName);
      return r;
    },
    [client, viewName],
  );
  const loadOlder = useCallback((before: string, rev: string) => (terminal !== undefined ? fetchOlder(terminal, before, rev) : Promise.resolve<OlderResult>({ ok: false, code: "failed" })), [terminal]);
  const waited = useWaited(terminal ?? "", VIEW_WAIT_MS, viewName !== null && viewTopic === undefined && viewStale === null);
  const mode: ViewMode | undefined =
    terminal === undefined || !chatAgent
      ? undefined
      : chatMode({ claude, harnessId: chatAgent.program ?? chatAgent.harness, topic: denied ? undefined : viewTopic, stale: denied ? "forbidden" : viewStale, waitedOut: waited });
  // The text view's topics follow what is on screen too: a draft or an open Keys sheet holds it after the chat source is up.
  const textView = chatName !== null && (mode?.kind === "text" || shown === "text");
  useTopics(client, chatName ? [chatName] : [], textView);
  // The desktop's key menu (S16b), read only while the text view is open (the Keys sheet is there).
  useTopics(client, ["keys"], textView);
  const keysMenu = useMemo(() => parsed(bridgeApi.KeysTopic, t.keys?.data), [t.keys?.data]);
  const chatView = chatName ? t[chatName] : undefined;
  const chatTopic = useMemo(() => parsed(bridgeApi.ChatTopic, chatView?.data), [chatView?.data]);
  const typing = useTerminalInput(chatName !== null, snap.status === "online", readTerminalInput);
  const input: ChatInput | undefined =
    terminal !== undefined
      ? {
          enabled: typing.view.enabled,
          until: typing.view.until,
          keys: {
            enabled: typing.view.keys.enabled,
            menu: keysMenu,
            press: async (key, rev) => {
              const r = await client.act("terminal.keys", { terminal, key, rev });
              if (!r.ok && r.code === "forbidden") typing.refresh();
              // The menu changed under the phone: read it again (the topic also brings the new one).
              if (!r.ok && (r.code === "keys_changed" || r.code === "unknown_key")) client.refresh("keys");
              // It may have pressed: show the terminal as it is now. Never pressed again by itself.
              if (r.unknown_effect && chatName) client.refresh(chatName);
              return r;
            },
          },
          send: async (text) => {
            const r = await client.act("terminal.send", { terminal, text });
            // The desktop turned it off (or it ran out): read the device again, so the composer goes.
            if (!r.ok && r.code === "forbidden") typing.refresh();
            // It may have typed: show the terminal as it is now. Never sent again by itself.
            if (r.unknown_effect && chatName) client.refresh(chatName);
            return r;
          },
        }
      : undefined;

  const push = useMemo(() => browserEnv((kind, args) => client.act(kind, args)), [client]);
  const data: AppData | undefined = useMemo(() => (host ? { host, ...(panorama ? { panorama } : {}) } : undefined), [host, panorama]);
  const live: LiveSources = {
    hostName: name,
    push,
    plugins,
    inbox,
    usage,
    // An agent with no terminal has nothing to subscribe: say so rather than wait for a topic that never comes.
    chat:
      chatName && terminal !== undefined
        ? {
            topic: chatTopic,
            stale: chatView?.stale ?? (chatView?.data !== undefined && chatTopic === undefined ? "bad_data" : null),
            terminal,
            input,
            ...(mode ? { mode, onShown: setShown, view: { topic: viewTopic, loadOlder, onForbidden, promptAct } } : {}),
          }
        : chatAgent
          ? { topic: undefined, stale: "no_terminal" }
          : undefined,
    onUsageFilter: (filter) => {
      void client.act("usage.set_filter", { filter }).then((r) => {
        if (r.unknown_effect) client.refresh("usage");
      });
    },
    inboxAct: async (kind, args) => {
      const r = await client.act(kind, args);
      // An unknown effect is said, the inbox is read again, and nothing is repeated.
      if (r.unknown_effect) client.refresh("inbox");
      return r;
    },
    onUsageRefresh: async () => {
      const r = await client.act("usage.refresh", {});
      if (r.unknown_effect) client.refresh("usage");
      return r;
    },
  };
  return (
    <HostNameProvider name={name}>
      <App connection={liveConnection(snap)} onRetry={client.wake} data={data} live={live} homePrompt={homePrompt} />
    </HostNameProvider>
  );
}
