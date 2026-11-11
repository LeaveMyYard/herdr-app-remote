import { useEffect, useState } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import { Banner } from "./components/Banner";
import { TabBar } from "./components/TabBar";
import { agents, badges, host, plugins, spaces, usageInstallCommand } from "./fixtures";
import { DEMO_NOW, demoHost, inboxInstallCommand, inboxScenario } from "./inbox-fixtures";
import { inboxBadge } from "./inbox/model";
import { TABS, type Connection, type TabBadges, type TabId } from "./model";
import { AgentsBasic } from "./screens/AgentsBasic";
import { InboxTab } from "./screens/InboxTab";
import { Soon } from "./screens/Soon";
import { UsageTab } from "./screens/UsageTab";
import { demoUsageNow, usageScenario } from "./usage-fixtures";

/** `#/usage/<scenario>` and `#/inbox/<scenario>`: the demo data those tabs show until the bridge client lands. */
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

export interface AppProps {
  connection?: Connection;
  tabBadges?: TabBadges;
}

export function App({ connection, tabBadges }: AppProps) {
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
  const scenario = usageScenario(scenarioName);
  const [usageFilter, setUsageFilter] = useState<Record<string, bridgeApi.UsageTopic["filter"]>>({});
  const usageTopic = scenario.topic && { ...scenario.topic, filter: usageFilter[scenario.name] ?? scenario.topic.filter };
  const inbox = inboxScenario(scenarioName);
  const inboxBadgeNow = inboxBadge(inbox.topic);
  const tabBadgesNow: TabBadges = { ...(tabBadges ?? badges) };
  if (!tabBadges) {
    // The inbox badge comes from the topic, not from the fixture.
    delete tabBadgesNow.inbox;
    if (inboxBadgeNow) tabBadgesNow.inbox = inboxBadgeNow;
  }
  const select = (t: TabId) => {
    window.location.hash = `/${t}`;
    setTab(t);
  };

  return (
    <div className="hd ph">
      <Banner connection={conn} />
      {tab === "agents" ? (
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
      ) : tab === "inbox" ? (
        <InboxTab host={host} topic={inbox.topic} hostState={demoHost} plugins={plugins} installCommand={inboxInstallCommand} now={DEMO_NOW} />
      ) : (
        <Soon title={TABS.find((t) => t.id === tab)?.label ?? ""} />
      )}
      <TabBar active={tab} badges={tabBadgesNow} onSelect={select} />
    </div>
  );
}
