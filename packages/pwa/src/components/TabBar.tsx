import type { ReactNode } from "react";
import { TABS, type TabBadges, type TabId } from "../model";
import { TabIcon } from "./Icon";

const GLYPH: Record<TabId, ReactNode> = {
  agents: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
    </>
  ),
  swarm: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M7.5 8l3.5 8M16.5 8L13 16" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13l3-8h12l3 8v6H3z" />
      <path d="M3 13h5l1 2h6l1-2h5" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  usage: <path d="M5 20V10M12 20V4M19 20v-7" />,
};

export function TabBar({ active, badges, onSelect }: { active: TabId; badges: TabBadges; onSelect: (t: TabId) => void }) {
  return (
    <nav aria-label="Sections" className="tabbar">
      {TABS.map((t) => {
        const badge = badges[t.id];
        return (
          <a
            key={t.id}
            href={`#/${t.id}`}
            className="tab"
            data-active={t.id === active}
            aria-current={t.id === active ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onSelect(t.id);
            }}
          >
            <TabIcon>{GLYPH[t.id]}</TabIcon>
            {t.label}
            {badge ? (
              <span className="tab-badge s-wait" aria-label={`${t.label}: ${badge}`}>
                {badge}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}
