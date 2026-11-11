import { useCallback, useEffect, useMemo, useState } from "react";
import { bridgeApi, HostState } from "@herdr-remote/protocol";
import { App, type AppData, type HomePromptState, type LiveSources } from "./App";
import type { BridgeClient, ClientSnapshot } from "./bridge/client";
import { fetchHostName, HostNameProvider } from "./bridge/host-name";
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
  const [view, setView] = useState<TerminalInputView>({ enabled: false, until: null });
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
  useEffect(() => {
    if (!open || !online || standalone) return;
    let gone = false;
    void client.act("pair.transfer").then((r) => {
      if (!gone && r.ok) refresh();
    });
    return () => {
      gone = true;
    };
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
  const terminal = chatAgentId !== null ? host?.agents.find((a) => a.id === chatAgentId)?.terminal_id : undefined;
  const chatName = terminal !== undefined ? `chat:${terminal}` : null;
  useTopics(client, chatName ? [chatName] : [], chatName !== null);
  const chatView = chatName ? t[chatName] : undefined;
  const chatTopic = useMemo(() => parsed(bridgeApi.ChatTopic, chatView?.data), [chatView?.data]);
  const typing = useTerminalInput(chatName !== null, snap.status === "online", readTerminalInput);
  const input: ChatInput | undefined =
    terminal !== undefined
      ? {
          ...typing.view,
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
    chat: chatName && terminal !== undefined ? { topic: chatTopic, stale: chatView?.stale ?? null, terminal, input } : undefined,
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
