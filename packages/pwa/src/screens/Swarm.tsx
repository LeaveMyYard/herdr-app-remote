import type { KeyboardEvent } from "react";
import { Icon } from "../components/Icon";
import { Badge, HarnessIcon, styleCode, Tile } from "../components/StateMarks";
import { buildSwarmRows, swarmStats, type SwarmRow, type SwarmScope, type SwarmUi } from "../panorama/select";

export interface SwarmProps {
  scope: SwarmScope;
  ui: SwarmUi;
  onUi: (next: SwarmUi) => void;
  /** POSIX seconds; ages are relative to it. */
  now: number;
  /** The Transcript button needs a transcript source; none exists yet (the feed carries only a local path). */
  transcript?: boolean;
  /** Feed age or read problem, shown above the tree. */
  notice?: string | undefined;
}

function Header({ scope }: { scope: SwarmScope }) {
  const s = swarmStats(scope.roots);
  return (
    <header className="row nf sw-head">
      <a href="#/agents" aria-label="Back" className="row nf sw-back">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </a>
      <div className="z row f1 sw-title">
        <span className="col nf sw-glyph" aria-hidden="true">
          <span className="row">
            <span className={`sw-sq${s.needs ? " needs" : ""}`} />
            <span className={`sw-sq${s.working ? " working" : ""}`} />
          </span>
          <span className="row">
            <span className="sw-sq" />
            <span className={`sw-sq${s.done ? " done" : ""}`} />
          </span>
        </span>
        <span className="sw-name">Swarm</span>
        <span className="f1 tr sw-sub">
          {scope.label} · {s.roots} roots · {s.agents} agents
        </span>
        {s.questions > 0 ? (
          <span className="row nf sw-chip" aria-label={`${s.questions} open questions`}>
            ?{s.questions}
          </span>
        ) : null}
        {s.working ? <i className="spin work-spinner sw-spin" data-vis-mask="" role="img" aria-label="Working" /> : null}
      </div>
    </header>
  );
}

function Card({ row, ui, onUi, transcript }: { row: SwarmRow; ui: SwarmUi; onUi: (u: SwarmUi) => void; transcript: boolean }) {
  const cls = styleCode(row.st);
  const fold = row.kind === "fold";
  const toggle = () => {
    if (fold) return;
    onUi({ sel: row.uid, open: row.hasKids ? { ...ui.open, [row.uid]: !row.open } : ui.open });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
  const detail = row.selected && !fold;
  const root = row.kind === "root";
  const peek = `#/swarm/peek/${encodeURIComponent(row.uid)}`;
  const showLine = !(detail && !root);
  return (
    <div className="row sw-row" role="none">
      {row.guides.map((g, i) => (
        <span key={i} aria-hidden="true" className={`tg ${g}`} />
      ))}
      <div
        role="treeitem"
        aria-selected={row.selected}
        aria-expanded={row.hasKids ? row.open : undefined}
        tabIndex={fold ? -1 : 0}
        className={`gcard flow f1 s-${cls}${row.selected ? " sel" : ""}${row.onPath ? " path" : ""}`}
        style={{ cursor: fold ? "default" : "pointer", minHeight: fold ? 40 : 54 }}
        onClick={toggle}
        onKeyDown={onKey}
      >
        {detail ? <span className="ring" /> : null}
        <span className="edge" />
        {fold ? (
          <div className="gfold" style={{ height: 40 }}>
            <Tile code="done" size={16} still />
            <span className="l">{row.title}</span>
          </div>
        ) : (
          <div className="gbody" style={{ paddingBottom: detail && !root ? 0 : 9 }}>
            <div className="gtop">
              <HarnessIcon name={row.harness} size={16} />
              <span className="gtitle">{row.title}</span>
              <span className="row nf gmarks">
                {row.questions > 0 ? <Tile code="wait" size={18} count={row.questions} /> : null}
                <Badge code={row.st} h={18} />
              </span>
              <span className="nf gcaret" aria-hidden="true">
                {row.hasKids ? (row.open ? "▾" : "▸") : ""}
              </span>
            </div>
            {showLine ? (
              <div className="gline">
                <span className="gact">{row.act}</span>
                <span className="gright">{row.right}</span>
              </div>
            ) : null}
            {detail ? (
              <>
                <div className="gdet">
                  <div className="gd">
                    <span className="k">agent</span>
                    <span className="v">{row.agentLine}</span>
                  </div>
                  <div className="gd">
                    <span className="k">now</span>
                    <span className="v">{row.act}</span>
                  </div>
                </div>
                <div className="gacts">
                  {root ? null : (
                    <a href={peek} className="gbtn pri" onClick={(e) => e.stopPropagation()}>
                      Peek ⏎
                    </a>
                  )}
                  {transcript && !root ? (
                    <a href={`${peek}/transcript`} className="gbtn" onClick={(e) => e.stopPropagation()}>
                      Transcript t
                    </a>
                  ) : null}
                  <span className={`gbtn${row.needs ? "" : " off"}`} aria-disabled="true">
                    Answer a
                  </span>
                </div>
              </>
            ) : null}
          </div>
        )}
        {row.needs && !fold ? <span className="gpulse" data-vis-mask="" /> : null}
        {row.st === "run" && !fold ? (
          <span className="gsweep" data-vis-mask="">
            <i />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** PhoneSwarm: the subagent trees of the roots in scope. A feed error never empties it: the retained roots stay. */
export function Swarm({ scope, ui, onUi, now, transcript = false, notice }: SwarmProps) {
  const rows = buildSwarmRows(scope.roots, ui, now);
  return (
    <>
      <Header scope={scope} />
      <main className="col f1 screen sw-main">
        {notice ? (
          <p className="gnote" role="note">
            {notice}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <div className="col f1 sw-empty">
            <Icon name="layers" size={28} />
            <span>No agent trees in {scope.label} yet.</span>
          </div>
        ) : (
          <div className="z col sw-list" role="tree" aria-label="Swarm">
            {rows.map((r) => (
              <Card key={r.uid} row={r} ui={ui} onUi={onUi} transcript={transcript} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
