import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import herdrIcon from "../assets/herdr.png";
import { Icon } from "../components/Icon";
import type { BasicAgent, HostInfo, Space } from "../model";

const HARNESS_ICON = { claude: claudeIcon, codex: codexIcon } as const;

function SpaceRow({ space }: { space: Space }) {
  return (
    <div className="srow" data-selected={space.selected ? "true" : undefined}>
      <div className="row space-line">
        <span className="space-avatar" style={{ background: space.color }}>
          {space.letter}
        </span>
        <span className="tr space-name">{space.name}</span>
        <span className="row f1 space-meta">
          {space.detached ? (
            <span className="tr">(detached)</span>
          ) : space.branch ? (
            <>
              <span className="tr">{space.branch}</span>
              {space.behind ? <span className="nf behind">↓{space.behind}</span> : null}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

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
        <img className="hn" src={HARNESS_ICON[agent.harness]} alt="" width={14} height={14} />
      </span>
      <span className="row f1 arow-name">
        <span className="tr arow-title">{agent.name}</span>
        <span className="tr f1 arow-tab">· {agent.tab}</span>
      </span>
      <span className="arow-age">{agent.age}</span>
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
      <header className="row nf app-header">
        <img src={herdrIcon} alt="" className="app-logo" />
        <span className="f1 app-title">Herdr</span>
        <button type="button" aria-label="Search" className="row icon-btn">
          <Icon name="search" size={19} />
        </button>
      </header>
      <main className="col f1 screen">
        <div className="z col">
          <div className="col nf sblock">
            <div className="row nf section-head">
              Spaces
              <span className="row nf plus-btn">
                <Icon name="plus" size={14} />
              </span>
            </div>
            <div className="col space-list">
              {spaces.map((s) => (
                <SpaceRow key={s.id} space={s} />
              ))}
            </div>
          </div>
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
