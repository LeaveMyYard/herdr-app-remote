import { AppHeader, SpacesBlock } from "../components/AgentsChrome";
import { HarnessIcon } from "../components/StateMarks";
import type { BasicAgent, HostInfo, Space } from "../model";

function AgentMark({ agent }: { agent: BasicAgent }) {
  switch (agent.status) {
    case "needs-you":
      return <span className="needs-pill">Needs you</span>;
    case "working":
      // Animated, so the visual harness masks it.
      return <i className="spin work-spinner" data-vis-mask="" role="img" aria-label="Working" />;
    case "done":
      return <span className="dot dot-done" role="img" aria-label="Done" />;
    case "idle":
      return <span className="dot dot-ring" role="img" aria-label="Idle" />;
  }
}

function AgentRow({ agent }: { agent: BasicAgent }) {
  return (
    <a href={`#/chat/${agent.id}`} className="arow" data-status={agent.status}>
      <span className="arow-icon">
        <HarnessIcon name={agent.harness} size={14} />
      </span>
      <span className="row f1 arow-name">
        <span className="tr arow-title">{agent.name}</span>
        {agent.tab ? <span className="tr f1 arow-tab">· {agent.tab}</span> : <span className="f1" />}
      </span>
      {agent.age ? <span className="arow-age">{agent.age}</span> : null}
      <AgentMark agent={agent} />
    </a>
  );
}

export function AgentsBasic({ host, spaces, agents }: { host: HostInfo; spaces: Space[]; agents: BasicAgent[] }) {
  const groups = spaces
    .map((space) => ({ space, agents: agents.filter((a) => a.spaceId === space.id) }))
    .filter((g) => g.agents.length > 0);
  return (
    <>
      <AppHeader />
      <main className="col f1 screen">
        <div className="z col">
          <SpacesBlock spaces={spaces} />
          <div className="col agents-block">
            <div className="row nf agents-head">
              <span className="agents-label">Agents</span>
              <span className="agents-scope">All spaces</span>
            </div>
            <div className="col agents-list">
              {groups.map((g) => (
                <div className="col" key={g.space.id} role="group" aria-label={g.space.name}>
                  <div className="row group-head">
                    <span>{g.space.name}</span>
                    <span>{g.agents.length}</span>
                  </div>
                  {g.agents.map((a) => (
                    <AgentRow key={a.id} agent={a} />
                  ))}
                </div>
              ))}
            </div>
            <div className="col hint-card">
              <span className="hint-title">Subagent trees and the Swarm view need herdr-panorama</span>
              <span className="hint-body">
                Install it in herdr-app on {host.name}. This list keeps working without it.
              </span>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
