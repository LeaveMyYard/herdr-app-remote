import { useEffect, useMemo, useState } from "react";
import { bridgeApi, HostState } from "@herdr-remote/protocol";
import { App, type AppData, type LiveSources } from "./App";
import type { BridgeClient, ClientSnapshot } from "./bridge/client";
import { useBridge, useTopics } from "./bridge/react";
import { browserEnv } from "./push/push";
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

/** The app over the bridge: topics in, `act`s out. Nothing changes on screen until the bridge says so. */
export function LiveApp({ client, hostName = hostNameFrom(window.location.hostname) }: { client: BridgeClient; hostName?: string }) {
  const snap = useBridge(client);
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

  const push = useMemo(() => browserEnv((kind, args) => client.act(kind, args)), [client]);
  const data: AppData | undefined = useMemo(() => (host ? { host, ...(panorama ? { panorama } : {}) } : undefined), [host, panorama]);
  const live: LiveSources = {
    hostName,
    push,
    plugins,
    inbox,
    usage,
    chat: chatName ? { topic: chatTopic, stale: chatView?.stale ?? null } : undefined,
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
  return <App connection={liveConnection(snap)} data={data} live={live} />;
}
