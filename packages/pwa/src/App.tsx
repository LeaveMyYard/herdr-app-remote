import { useEffect, useState, type ReactNode } from "react";
import { AppFrame } from "./components/AppFrame";
import { Banner } from "./components/Banner";
import { HomePrompt, HomePromptBell } from "./pair/HomePrompt";
import { TabBar } from "./components/TabBar";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { chats, typingDemo } from "./chat-fixtures";
import { HostNameProvider } from "./bridge/host-name";
import { agents, badges, host, plugins, spaces, usageInstallCommand } from "./fixtures";
import { TABS, type Connection, type PluginRow, type Space, type TabBadges, type TabId } from "./model";
import { age } from "./panorama/format";
import { nodeUid, selectAgents, selectBasic, selectSpaces, swarmScope, type SwarmUi } from "./panorama/select";
import { AgentsBasic } from "./screens/AgentsBasic";
import { AgentsRich } from "./screens/AgentsRich";
import { Chat, ChatPicker } from "./screens/Chat";
import type { ChatInput } from "./screens/ChatComposer";
import { Inbox } from "./screens/Inbox";
import { Peek, type TranscriptPage } from "./screens/Peek";
import { Soon } from "./screens/Soon";
import { Swarm } from "./screens/Swarm";
import { SwarmUnavailable } from "./screens/SwarmUnavailable";
import { UsageTab } from "./screens/UsageTab";
import { Question } from "./screens/Question";
import { PushRow } from "./push/PushRow";
import type { PushEnv } from "./push/push";
import { DEMO_NOW, demoClosed, demoHost, inboxScenario } from "./inbox-fixtures";
import { ClosedRows, offlineAct, type ActFn } from "./inbox/act";
import { inboxBadge } from "./inbox/model";
import { ANSWER } from "./inbox/words";
import { demoUsageNow, usageScenario } from "./usage-fixtures";

/** `#/usage/<scenario>`: the demo data the Usage tab shows until the bridge client lands. */
function scenarioFromHash(hash: string): string | undefined {
  return hash.replace(/^#\/?/, "").split("/")[1];
}

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

/** What only the bridge provides. Without it (tests, the visual harness) the screens show fake demo data. */
export interface LiveSources {
  /** The desktop's name (the serve host's first label). */
  hostName: string;
  /** The `plugins` topic; undefined until its first snap. */
  plugins: bridgeApi.PluginsTopic | undefined;
  /** The `inbox` topic; undefined until its first snap. */
  inbox: bridgeApi.InboxTopic | undefined;
  /** The `usage` topic; undefined until its first snap. */
  usage: bridgeApi.UsageTopic | undefined;
  onUsageFilter: (filter: bridgeApi.UsageTopic["filter"]) => void;
  onUsageRefresh: () => Promise<unknown>;
  /** The open chat's `chat:<t>` topic (LiveApp subscribes it from the route). */
  chat?: { topic: bridgeApi.ChatTopic | undefined; stale: string | null; terminal?: string; input?: ChatInput | undefined } | undefined;
  /** Sends an inbox `act` (draft, answer, dismiss, retry, stop showing, ack); resolves with the bridge's `res`. */
  inboxAct?: ActFn | undefined;
  /** Web Push on this phone (S17): the Inbox shows the notifications row with it. */
  push?: PushEnv | undefined;
}

/** The "Add to Home Screen" prompt (S5b): in Safari only; null or undefined means no bell and no prompt. */
export interface HomePromptState {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export interface AppProps {
  connection?: Connection | undefined;
  /** The banner's "Retry now" (unavailable). */
  onRetry?: (() => void) | undefined;
  homePrompt?: HomePromptState | null | undefined;
  tabBadges?: TabBadges;
  data?: AppData | undefined;
  live?: LiveSources | undefined;
  /** Sends an inbox `act` without a live client (tests); `live.inboxAct` wins. Without either nothing is sent. */
  act?: ActFn | undefined;
}

/** The plugin card rows from the `plugins` topic (it carries no versions). */
export function pluginRows(p: bridgeApi.PluginsTopic | undefined): PluginRow[] {
  if (!p) return [];
  return [
    { name: "herdr-panorama", state: p.panorama.state },
    { name: "herdr-inbox", state: p.inbox.state },
    { name: "agent-usage", state: p.usage.state },
  ];
}

function parts(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/");
}

/** A hash from the address bar can be malformed; never let it throw during render. */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
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

export function App({ connection, onRetry, homePrompt, tabBadges, data, live, act }: AppProps) {
  const inboxAct = live?.inboxAct ?? act ?? offlineAct;
  const hostInfo = live ? { name: live.hostName } : host;
  const rows = live ? pluginRows(live.plugins) : plugins;
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
    !connection && base.status === "online" && rich && topic.stale && (tab === "agents" || tab === "swarm")
      ? { status: "stale", age: topic.collected_at !== null ? age(topic.collected_at, now) : undefined, reason: topic.error ?? "feed" }
      : base;
  const [scenarioName, setScenarioName] = useState(() => scenarioFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setScenarioName(scenarioFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const scenario = usageScenario(scenarioName);
  // `#/inbox/q/...` is a question; its demo data is named by `?inbox=<scenario>` instead of the hash.
  const inQuestion = parts(hash)[0] === "inbox" && parts(hash)[1] === "q";
  const inbox = inboxScenario(inQuestion ? (new URLSearchParams(window.location.search).get("inbox") ?? undefined) : scenarioName);
  const [closedRows] = useState(() => new ClosedRows(!live && inbox.name === "typical" && !inQuestion ? demoClosed : []));
  const inboxTopic = live ? live.inbox : inbox.topic;
  const inboxBadgeNow = inboxBadge(inboxTopic);
  const tabBadgesNow: TabBadges = { ...(tabBadges ?? badges) };
  if (!tabBadges) {
    // The inbox badge comes from the topic, not from the fixture.
    delete tabBadgesNow.inbox;
    if (inboxBadgeNow) tabBadgesNow.inbox = inboxBadgeNow;
  }
  const [usageFilter, setUsageFilter] = useState<Record<string, bridgeApi.UsageTopic["filter"]>>({});
  const usageTopic = scenario.topic && { ...scenario.topic, filter: usageFilter[scenario.name] ?? scenario.topic.filter };
  const select = (t: TabId) => {
    window.location.hash = `/${t}`;
    setTab(t);
  };

  const route = parts(hash);
  const peekUid = tab === "swarm" && rich && route[1] === "peek" && route[2] ? decode(route[2]) : null;
  const peeked = peekUid && topic ? findNode(topic, peekUid) : null;
  if (peeked && data && topic) {
    const space = peeked.root.space_id !== null ? data.host.spaces.find((s) => s.id === peeked.root.space_id)?.name : undefined;
    return (
      <AppFrame>
        <Peek
          root={peeked.root}
          node={peeked.node}
          spaceName={space ?? null}
          now={now}
          transcript={data.transcript}
          closeHref={`#/swarm/${peeked.root.space_id !== null ? encodeURIComponent(peeked.root.space_id) : "all"}`}
          openRootHref={peeked.root.live ? `#/chat/${peeked.root.agent_id ?? ""}` : undefined}
        />
      </AppFrame>
    );
  }

  // A question (and its review) is a full screen with no tab bar, as on the boards.
  if (tab === "inbox" && inQuestion) {
    const key = decode(route[2] ?? "");
    const row = inboxTopic?.entries.find((r) => r.key === key);
    const sub = route[3] ?? "";
    // Demo data only (the visual harness): never pre-picks an answer on a live question.
    const pick = live ? null : new URLSearchParams(window.location.search).get("pick");
    return (
      <AppFrame className="qn">
        {row && row.kind === "group" ? (
          <Question
            key={row.key}
            row={row as Extract<typeof row, { kind: "group" }>}
            tab={sub === "submit" ? "submit" : Number(sub)}
            host={live ? data?.host : demoHost}
            now={live ? now : DEMO_NOW}
            act={inboxAct}
            closed={closedRows}
            initialPick={pick !== null && /^[0-9]$/.test(pick) ? Number(pick) : undefined}
          />
        ) : (
          <div className="col f1 ib-empty">
            <p className="ib-empty-head">{ANSWER.gone}</p>
            <a href="#/inbox" className="qn-later row">
              {ANSWER.backToInbox}
            </a>
          </div>
        )}
      </AppFrame>
    );
  }

  // An open chat is a full screen with no tab bar, as on the board.
  const chatList = data ? selectBasic(data.host) : agents;
  const chatAgent = tab === "chat" && route[1] ? chatList.find((a) => a.id === decode(route[1] ?? "")) : undefined;
  if (chatAgent) {
    const demo = data ? undefined : chats[chatAgent.id];
    // The PhoneKeys board's states, on demo data only (`?fixture=chat&typing=menu`).
    const typed = demo && !live ? typingDemo(new URLSearchParams(window.location.search).get("typing")) : null;
    const chat = (
      <Chat
          agent={demo?.agent ?? { name: chatAgent.name, folder: chatAgent.tab, harness: chatAgent.harness === "codex" ? "codex" : "claude", status: chatAgent.status }}
          topic={live ? live.chat?.topic : demo?.topic}
          stale={live?.chat?.stale ?? undefined}
          question={typed ? undefined : demo?.question}
          input={typed ? typed.input : live?.chat?.input}
          terminal={typed ? demo?.topic.terminal : live?.chat?.terminal}
          boardSlot={demo !== undefined}
          {...(typed ? { now: typed.now, demoSheet: { open: typed.sheet, pressed: typed.pressed } } : {})}
        />
    );
    // The board's computer is "desk-1"; live data gets its name from LiveApp's provider.
    return <AppFrame>{typed ? <HostNameProvider name="desk-1">{chat}</HostNameProvider> : chat}</AppFrame>;
  }

  let screen: ReactNode;
  if (tab === "chat") {
    screen = <ChatPicker agents={chatList} />;
  } else if (tab === "agents") {
    screen =
      data && rich ? (
        <AgentsRich view={selectAgents(data.host, topic, data.spaceExtra)} />
      ) : data ? (
        <AgentsBasic host={hostInfo} spaces={selectSpaces(data.host)} agents={selectBasic(data.host)} />
      ) : live ? (
        <AgentsBasic host={hostInfo} spaces={[]} agents={[]} />
      ) : (
        <AgentsBasic host={host} spaces={spaces} agents={agents} />
      );
  } else if (tab === "swarm" && data && rich) {
    const seg = route[1] ? decode(route[1]) : null;
    const wanted = seg === "all" ? null : seg && seg !== "peek" ? seg : (data.host.focused.space_id ?? null);
    const scope = swarmScope(data.host, topic, wanted);
    const ui = swarmUi ?? { open: Object.fromEntries(scope.roots.map((r) => [r.key, true])), sel: null };
    const notice = topic.aged
      ? "The feed is more than 15 s old, so agents aren't matched to spaces. Showing the last collection."
      : topic.error
        ? `The feed can't be read (${topic.error}). Showing the last good collection.`
        : undefined;
    screen = <Swarm scope={scope} ui={ui} onUi={setSwarmUi} now={now} transcript={data.transcript !== undefined} notice={notice} />;
  } else if (tab === "swarm") {
    screen = <SwarmUnavailable host={hostInfo} error={topic?.error ?? null} plugins={rows} />;
  } else if (tab === "usage" && live) {
    screen = (
      <UsageTab
        host={hostInfo}
        // Until the first plugins snap, show the panel (loading) rather than a Missing screen that may be wrong.
        state={live.plugins?.usage.state ?? "ready"}
        topic={live.usage}
        plugins={rows}
        installCommand={usageInstallCommand}
        onFilter={live.onUsageFilter}
        onRefresh={live.onUsageRefresh}
      />
    );
  } else if (tab === "inbox" && live) {
    screen = live.inbox ? (
      <Inbox topic={live.inbox} host={data?.host} now={now} act={inboxAct} closed={closedRows} extra={live.push ? <PushRow env={live.push} /> : null} />
    ) : (
      <Soon title="Inbox" />
    );
  } else if (tab === "inbox") {
    screen = <Inbox topic={inbox.topic} host={demoHost} now={DEMO_NOW} act={inboxAct} closed={closedRows} />;
  } else if (tab === "usage") {
    screen = (
      <UsageTab
        host={host}
        state={scenario.state}
        topic={usageTopic}
        plugins={plugins.map((p) => (p.name === "agent-usage" ? { ...p, state: scenario.state } : p))}
        installCommand={usageInstallCommand}
        now={scenario.fixedNow ? demoUsageNow : undefined}
        onFilter={(f) => setUsageFilter((m) => ({ ...m, [scenario.name]: f }))}
        onRefresh={() => undefined}
      />
    );
  } else {
    screen = <Soon title={TABS.find((t) => t.id === tab)?.label ?? ""} />;
  }

  return (
    // The prompt and its bell only while nothing else is wrong: a banner takes the same place, and the prompt's mint needs the socket.
    <HomePromptBell.Provider value={homePrompt && conn.status === "online" ? homePrompt.onOpen : null}>
      <AppFrame>
        <Banner connection={conn} onRetry={onRetry} />
        {screen}
        {homePrompt?.open && conn.status === "online" ? <HomePrompt onClose={homePrompt.onClose} /> : null}
        <TabBar active={tab} badges={tabBadgesNow} onSelect={select} />
      </AppFrame>
    </HomePromptBell.Provider>
  );
}

function findNode(topic: bridgeApi.PanoramaTopic, uid: string) {
  for (const root of topic.roots) {
    for (const node of root.agents) if (nodeUid(root, node.id) === uid) return { root, node };
  }
  return null;
}
