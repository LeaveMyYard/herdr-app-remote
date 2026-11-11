import { useEffect, useState, type ReactNode } from "react";
import { Banner } from "./components/Banner";
import { TabBar } from "./components/TabBar";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { agents, badges, host, plugins, spaces, usageInstallCommand } from "./fixtures";
import { TABS, type Connection, type Space, type TabBadges, type TabId } from "./model";
import { age } from "./panorama/format";
import { nodeUid, selectAgents, selectBasic, selectSpaces, swarmScope, type SwarmUi } from "./panorama/select";
import { AgentsBasic } from "./screens/AgentsBasic";
import { AgentsRich } from "./screens/AgentsRich";
import { Missing, UsageGlyph } from "./screens/Missing";
import { Peek, type TranscriptPage } from "./screens/Peek";
import { Soon } from "./screens/Soon";
import { Swarm } from "./screens/Swarm";
import { SwarmUnavailable } from "./screens/SwarmUnavailable";

function tabFromHash(hash: string): TabId {
  const id = hash.replace(/^#\/?/, "").split("/")[0];
  return TABS.find((t) => t.id === id)?.id ?? "agents";
}

/** Browser connectivity until the bridge client (S5) reports real link state. */
function useConnection(override?: Connection): Connection {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return override ?? { status: online ? "online" : "offline" };
}

/** What the bridge's `host` and `panorama` topics hold, once a client feeds them in (until then, fixtures). */
export interface AppData {
  host: HostState;
  panorama?: bridgeApi.PanoramaTopic;
  /** Space facts the host topic doesn't carry (branch, behind, detached). */
  spaceExtra?: Record<string, Partial<Space>>;
  /** POSIX seconds; defaults to the clock. */
  now?: number;
  /** Swarm open/selected state to start from. */
  swarmUi?: SwarmUi;
  /** A transcript page for Peek; no source exists yet. */
  transcript?: TranscriptPage | undefined;
}

export interface AppProps {
  connection?: Connection;
  tabBadges?: TabBadges;
  data?: AppData | undefined;
}

function parts(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/");
}

function useNowSeconds(fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now() / 1000);
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? now;
}

export function App({ connection, tabBadges = badges, data }: AppProps) {
  const [tab, setTab] = useState<TabId>(() => tabFromHash(window.location.hash));
  const [hash, setHash] = useState(() => window.location.hash);
  const [swarmUi, setSwarmUi] = useState<SwarmUi | null>(data?.swarmUi ?? null);
  const now = useNowSeconds(data?.now);
  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash(window.location.hash));
      setHash(window.location.hash);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const topic = data?.panorama;
  const rich = topic?.mode === "rich";
  const base = useConnection(connection);
  // A retained feed that is old or failed to read shows the stale banner; a connection problem outranks it.
  const conn: Connection =
    !connection && base.status === "online" && rich && topic.stale
      ? { status: "stale", age: topic.collected_at !== null ? age(topic.collected_at, now) : undefined, reason: topic.error ?? "feed" }
      : base;
  const select = (t: TabId) => {
    window.location.hash = `/${t}`;
    setTab(t);
  };

  const route = parts(hash);
  const peekUid = tab === "swarm" && rich && route[1] === "peek" && route[2] ? decodeURIComponent(route[2]) : null;
  const peeked = peekUid && topic ? findNode(topic, peekUid) : null;
  if (peeked && data && topic) {
    const space = peeked.root.space_id !== null ? data.host.spaces.find((s) => s.id === peeked.root.space_id)?.name : undefined;
    return (
      <div className="hd ph">
        <Peek
          root={peeked.root}
          node={peeked.node}
          spaceName={space ?? null}
          now={now}
          transcript={data.transcript}
          closeHref={peeked.root.space_id !== null ? `#/swarm/${encodeURIComponent(peeked.root.space_id)}` : "#/swarm"}
          openRootHref={peeked.root.live ? `#/chat/${peeked.root.agent_id ?? ""}` : undefined}
        />
      </div>
    );
  }

  let screen: ReactNode;
  if (tab === "agents") {
    screen =
      data && rich ? (
        <AgentsRich view={selectAgents(data.host, topic, data.spaceExtra)} />
      ) : data ? (
        <AgentsBasic host={host} spaces={selectSpaces(data.host)} agents={selectBasic(data.host)} />
      ) : (
        <AgentsBasic host={host} spaces={spaces} agents={agents} />
      );
  } else if (tab === "swarm" && data && rich) {
    const wanted = route[1] && route[1] !== "peek" ? decodeURIComponent(route[1]) : (data.host.focused.space_id ?? null);
    const scope = swarmScope(data.host, topic, wanted);
    const ui = swarmUi ?? { open: Object.fromEntries(scope.roots.map((r) => [r.key, true])), sel: null };
    const notice = topic.aged
      ? "The feed is more than 15 s old, so agents aren't matched to spaces. Showing the last collection."
      : topic.error
        ? `The feed can't be read (${topic.error}). Showing the last good collection.`
        : undefined;
    screen = <Swarm scope={scope} ui={ui} onUi={setSwarmUi} now={now} transcript={data.transcript !== undefined} notice={notice} />;
  } else if (tab === "swarm") {
    screen = <SwarmUnavailable host={host} error={topic?.error ?? null} plugins={plugins} />;
  } else if (tab === "usage") {
    screen = (
      <Missing
        host={host}
        title="Agent Usage"
        plugin="agent-usage"
        blurb="This tab shows how much of each Claude and Codex account is left."
        command={usageInstallCommand}
        icon={<UsageGlyph />}
        plugins={plugins}
      />
    );
  } else {
    screen = <Soon title={TABS.find((t) => t.id === tab)?.label ?? ""} />;
  }

  return (
    <div className="hd ph">
      <Banner connection={conn} />
      {screen}
      <TabBar active={tab} badges={tabBadges} onSelect={select} />
    </div>
  );
}

function findNode(topic: bridgeApi.PanoramaTopic, uid: string) {
  for (const root of topic.roots) {
    for (const node of root.agents) if (nodeUid(root, node.id) === uid) return { root, node };
  }
  return null;
}
