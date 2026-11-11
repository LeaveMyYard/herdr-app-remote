import herdrIcon from "../assets/herdr.png";
import type { Space } from "../model";
import { Icon } from "./Icon";
import { Tile } from "./StateMarks";

export function AppHeader() {
  return (
    <header className="row nf app-header">
      <img src={herdrIcon} alt="" className="app-logo" />
      <span className="f1 app-title">Herdr</span>
      <button type="button" aria-label="Search" className="row icon-btn">
        <Icon name="search" size={19} />
      </button>
    </header>
  );
}

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
        {space.tiles?.length ? (
          <span className="row nf space-tiles">
            {space.tiles.map((t, i) => (
              <Tile key={i} code={t.code} size={18} count={t.count} />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function SpacesBlock({ spaces }: { spaces: Space[] }) {
  return (
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
  );
}
