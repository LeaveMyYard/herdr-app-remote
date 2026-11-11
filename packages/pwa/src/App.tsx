import { useEffect, useState } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import { Banner } from "./components/Banner";
import { TabBar } from "./components/TabBar";
import { chats } from "./chat-fixtures";
import { agents, badges, host, plugins, spaces, usageInstallCommand } from "./fixtures";
import { TABS, type Connection, type TabBadges, type TabId } from "./model";
import { AgentsBasic } from "./screens/AgentsBasic";
import { Chat, ChatPicker } from "./screens/Chat";
import { Soon } from "./screens/Soon";
import { UsageTab } from "./screens/UsageTab";
import { demoUsageNow, usageScenario } from "./usage-fixtures";

/** `#/usage/<scenario>`: the demo data the Usage tab shows until the bridge client lands. */
function scenarioFromHash(hash: string): string | undefined {
  return hash.replace(/^#\/?/, "").split("/")[1];
}

/** `#/chat/<agent>`: the agent whose chat is open. */
function chatFromHash(hash: string): string | undefined {
  const parts = hash.replace(/^#\/?/, "").split("/");
  return parts[0] === "chat" ? parts[1] : undefined;
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

export interface AppProps {
  connection?: Connection;
  tabBadges?: TabBadges;
}

export function App({ connection, tabBadges = badges }: AppProps) {
  const [tab, setTab] = useState<TabId>(() => tabFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const conn = useConnection(connection);
  const [scenarioName, setScenarioName] = useState(() => scenarioFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setScenarioName(scenarioFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [chatId, setChatId] = useState(() => chatFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setChatId(chatFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const scenario = usageScenario(scenarioName);
  const [usageFilter, setUsageFilter] = useState<Record<string, bridgeApi.UsageTopic["filter"]>>({});
  const usageTopic = scenario.topic && { ...scenario.topic, filter: usageFilter[scenario.name] ?? scenario.topic.filter };
  const select = (t: TabId) => {
    window.location.hash = `/${t}`;
    setTab(t);
  };

  // An open chat is a full screen with no tab bar, as on the board.
  const chat = tab === "chat" && chatId ? agents.find((a) => a.id === chatId) : undefined;
  if (chat) {
    const demo = chats[chat.id];
    return (
      <div className="hd ph">
        <Chat
          agent={demo?.agent ?? { name: chat.name, folder: chat.tab, harness: chat.harness, status: chat.status }}
          topic={demo?.topic}
          question={demo?.question}
        />
      </div>
    );
  }

  return (
    <div className="hd ph">
      <Banner connection={conn} />
      {tab === "chat" ? (
        <ChatPicker agents={agents} />
      ) : tab === "agents" ? (
        <AgentsBasic host={host} spaces={spaces} agents={agents} />
      ) : tab === "usage" ? (
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
      ) : (
        <Soon title={TABS.find((t) => t.id === tab)?.label ?? ""} />
      )}
      <TabBar active={tab} badges={tabBadges} onSelect={select} />
    </div>
  );
}
