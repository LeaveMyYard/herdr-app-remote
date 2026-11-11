import { useEffect, useState } from "react";
import { Banner } from "./components/Banner";
import { TabBar } from "./components/TabBar";
import { agents, badges, host, plugins, spaces } from "./fixtures";
import { TABS, type Connection, type TabBadges, type TabId } from "./model";
import { AgentsBasic } from "./screens/AgentsBasic";
import { Missing } from "./screens/Missing";
import { Soon } from "./screens/Soon";

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
        <Missing
          host={host}
          title="Agent Usage"
          plugin="agent-usage"
          blurb="This tab shows how much of each Claude and Codex account is left."
          command="[AGENT-USAGE INSTALL COMMAND]"
          plugins={plugins}
        />
      ) : (
        <Soon title={TABS.find((t) => t.id === tab)?.label ?? ""} />
      )}
      <TabBar active={tab} badges={tabBadges} onSelect={select} />
    </div>
  );
}
