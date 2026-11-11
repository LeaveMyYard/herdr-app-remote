import { AppHeader, SpacesBlock } from "../components/AgentsChrome";
import { Icon } from "../components/Icon";
import { Badge, HarnessIcon, Tile } from "../components/StateMarks";
import type { AgentsView, CardView } from "../panorama/select";

function Card({ card }: { card: CardView }) {
  return (
    <a href={card.href} className={`pwrap s-${card.st === "unknown" ? "idle" : card.st}`}>
      <div className={`pcard s-${card.st === "unknown" ? "idle" : card.st}`}>
        <div className="pfill">
          <div className="phead">
            <span className="pnum">{card.n ?? ""}</span>
            <span className="nf pharn">
              <HarnessIcon name={card.harness} size={16} />
            </span>
            <span className="ptitle">{card.title}</span>
            <span className="pmarks">
              {card.questions > 0 && card.st !== "wait" ? <Tile code="wait" count={card.questions} /> : null}
              <Badge code={card.st} h={17} questions={card.questions} />
            </span>
          </div>
          <div className={`ptail${card.tiles.length ? "" : " bare"}`}>
            {card.tiles.length ? (
              <span className="ptiles">
                {card.tiles.map((t, i) => (
                  <Tile key={i} code={t.code} count={t.count} />
                ))}
              </span>
            ) : null}
            <span className="pmeta">{card.meta}</span>
          </div>
        </div>
      </div>
      {card.sweep ? (
        <div className="psweep" data-vis-mask="">
          <div className="w">
            <div className="o" />
          </div>
        </div>
      ) : null}
    </a>
  );
}

/** PhoneAgents: the Agents list with herdr-panorama's tiles, subagent counts and questions. Every host agent stays listed. */
export function AgentsRich({ view }: { view: AgentsView }) {
  return (
    <>
      <AppHeader />
      <main className="col f1 screen">
        <div className="z col">
          <SpacesBlock spaces={view.spaces} />
          <div className="col agents-block">
            <div className="row nf ag-head">
              <span className="row ag-head-l">
                <span className="agents-label">Agents</span>
                <span className="row ag-scope">All spaces</span>
              </span>
              <span className="row ag-head-r">
                {view.questions > 0 ? (
                  <span className="row ag-need" aria-label={`${view.questions} open questions`}>
                    <span>?{view.questions}</span>
                  </span>
                ) : null}
                <span className="row">
                  <Icon name="layers" size={14} />
                </span>
              </span>
            </div>
            <div className="col agents-list">
              {view.groups.map((g, i) => (
                <div className="col" key={g.id} role="group" aria-label={g.label}>
                  <div className={`row nf ag-group${i === 0 ? " first" : ""}`}>
                    <span className="tr ag-group-name">{g.label}</span>
                    <span className="ag-group-n">{g.cards.length}</span>
                  </div>
                  {g.cards.map((c) => (
                    <Card key={c.key} card={c} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
