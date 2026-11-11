import type { bridgeApi } from "@herdr-remote/protocol";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import {
  accountName,
  bandColor,
  clock,
  ERROR_TEXT,
  familyName,
  fillPercent,
  groupName,
  groupProviders,
  hint,
  metaLine,
  type UsageGroup,
  type UsageRow,
} from "../usage-model";

export type UsageView = "full" | "compact";

export interface UsageProps {
  /** The `usage` topic; undefined until the first snap. */
  topic: bridgeApi.UsageTopic | undefined;
  /** Epoch ms, for "updated 1m ago". */
  now: number;
  view: UsageView;
  /** A refresh is running. */
  busy?: boolean;
  onView: (view: UsageView) => void;
  onFilter: (filter: bridgeApi.UsageTopic["filter"]) => void;
  onRefresh: () => void;
}

const FAMILY_ICON: Record<string, string> = { claude: claudeIcon, codex: codexIcon };

function Mark({ family }: { family: string }) {
  const src = FAMILY_ICON[family];
  return src ? <img className="hn" src={src} alt="" width={16} height={16} /> : <span className="hn" aria-hidden="true" />;
}

function Seg({ label, on, onClick, cls }: { label: string; on: boolean; onClick: () => void; cls: string }) {
  return (
    <button type="button" className={`row ${cls}`} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function Account({ p, grouped, word, now }: { p: UsageRow; grouped: boolean; word: string; now: number }) {
  const stale = p.status === "stale";
  return (
    <div className="col uacct" data-grouped={grouped ? "true" : undefined} data-status={p.status} aria-label={accountName(p)} role="group">
      {grouped ? (
        <div className="row uname">
          <span className="uname-text">{accountName(p)}</span>
          {p.planType ? <span className="uplan">· {p.planType}</span> : null}
          <span className="f1" />
          <span className="tr uhint">{hint(p)}</span>
        </div>
      ) : null}
      {p.windows.map((w) => (
        <div key={w.slot + w.tag}>
          <div className="row uwin" data-stale={stale ? "true" : undefined}>
            <span className="mono nf uwin-tag">{w.tag}</span>
            <span className="ubar" style={{ background: `color-mix(in srgb, ${bandColor(w.band)} 15%, transparent)` }}>
              <i style={{ width: `${fillPercent(w.barFill)}%`, background: bandColor(w.band) }} />
            </span>
            <span className="nf uwin-pct" style={{ color: bandColor(w.band) }}>
              {w.displayPercent}% {word}
            </span>
            <span className="nf uwin-reset">{w.resetIn}</span>
          </div>
          {w.runOut?.text ? <div className="row urun">⚠️ {w.runOut.text}</div> : null}
        </div>
      ))}
      {p.status === "no-data" ? (
        <div className="unote">{p.home ? `No usage yet · updates when ${familyName(p.family, p.label)} runs in ${p.home}` : "No usage yet"}</div>
      ) : (
        <>
          {p.status === "needs-login" && p.note ? <Callout note={p.note} /> : p.note && !stale ? <div className="unote">{p.note}</div> : null}
          <div className="umeta" data-stale={stale ? "true" : undefined}>
            {metaLine(p, now)}
          </div>
        </>
      )}
    </div>
  );
}

/** A note with the command to run drawn as code (`grok login`). */
function Callout({ note }: { note: string }) {
  const parts = note.split("`");
  return (
    <div className="ucallout">
      {parts.map((part, i) =>
        i % 2 ? (
          <code className="mono" key={i}>
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
}

function Group({ g, index, word, now }: { g: UsageGroup; index: number; word: string; now: number }) {
  const first = g.members[0] as UsageRow;
  const grouped = g.members.length > 1;
  return (
    <section className="col ugroup" data-first={index === 0 ? "true" : undefined} aria-label={groupName(g)}>
      <div className="row ugroup-head">
        <Mark family={g.family} />
        <span className="ugroup-name">{groupName(g)}</span>
        {!grouped && first.planType ? <span className="uplan">· {first.planType}</span> : null}
        <span className="f1" />
        <span className="tr ugroup-hint" data-grouped={grouped ? "true" : undefined}>
          {grouped ? `${g.members.length} accounts` : hint(first)}
        </span>
      </div>
      {g.members.map((p) => (
        <Account key={p.providerId} p={p} grouped={grouped} word={word} now={now} />
      ))}
    </section>
  );
}

function CompactRow({ p, g, word }: { p: UsageRow; g: UsageGroup; word: string }) {
  const family = familyName(g.family, p.label);
  const name = g.members.length > 1 ? `${family} ${accountName(p)}` : p.planType ? `${p.label} ${p.planType}` : p.label;
  return (
    <div className="row ucompact" data-stale={p.status === "stale" ? "true" : undefined}>
      <Mark family={g.family} />
      <span className="tr f1 ucompact-name">{name}</span>
      {p.windows.map((w) => (
        <span className="row nf ucompact-win" key={w.slot + w.tag} aria-label={`${w.tag} ${w.displayPercent}% ${word}`}>
          <span className="mono ucompact-tag">{w.tag}</span>
          <span className="ucompact-bar" style={{ background: `color-mix(in srgb, ${bandColor(w.band)} 15%, transparent)` }}>
            <i style={{ width: `${fillPercent(w.barFill)}%`, background: bandColor(w.band) }} />
          </span>
          <span className="ucompact-pct" style={{ color: bandColor(w.band) }}>
            {w.displayPercent}%
          </span>
        </span>
      ))}
      {p.windows.some((w) => w.runOut?.text) ? <span className="ucompact-warn" role="img" aria-label="Will run out before reset">⚠</span> : null}
      {p.windows.length === 0 ? (
        <span className="ucompact-none">{p.status === "needs-login" ? p.action ? `run ${p.action}` : "no data" : p.status === "no-data" ? "no usage yet" : "no data"}</span>
      ) : null}
    </div>
  );
}

function Empty({ topic }: { topic: bridgeApi.UsageTopic | undefined }) {
  const loading = !topic?.report;
  const open = topic?.filter !== "all";
  const title = loading ? (topic?.error ? "No data" : "Loading…") : open ? "No agent panes open" : "No usage data yet";
  return (
    <div className="col f1 uempty">
      <div className="uempty-title">{title}</div>
      {!loading && open ? <div className="uempty-body">Limits show for providers with an open agent pane. Choose All to see every configured account.</div> : null}
    </div>
  );
}

/** PhoneUsage: the Agent Usage panel from the design, drawn from the bridge's `usage` topic. */
export function Usage({ topic, now, view, busy, onView, onFilter, onRefresh }: UsageProps) {
  const report = topic?.report ?? null;
  const groups = report ? groupProviders(report.providers) : [];
  const count = groups.reduce((n, g) => n + g.members.length, 0);
  const word = report?.limitPercent === "used" ? "used" : "left";
  const all = topic?.filter === "all";
  return (
    <>
      <div className="nf status-spacer" />
      <main className="col f1 usage-main">
        <div className="z col usage-z">
          <section className="col upanel" aria-label="Agent Usage">
            <div className="row nf uhead">
              <h1 className="uhead-title">Agent Usage</h1>
              {count > 0 ? <span className="ucount">{`${count} ${count === 1 ? "account" : "accounts"}`}</span> : null}
              <span className="f1" />
              <span className="row uhead-segs" role="group" aria-label="Which accounts">
                <Seg label="Open panes" on={!all} onClick={() => onFilter("open-panes")} cls="useg" />
                <Seg label="All" on={all} onClick={() => onFilter("all")} cls="useg" />
              </span>
            </div>
            {topic?.error ? (
              <div className="uerror" role="alert">
                {ERROR_TEXT[topic.error]}
              </div>
            ) : null}
            {count === 0 ? (
              <Empty topic={topic} />
            ) : (
              <div className="col f1 ulist" data-view={view}>
                {view === "compact"
                  ? groups.flatMap((g) => g.members.map((p) => <CompactRow key={p.providerId} p={p} g={g} word={word} />))
                  : groups.map((g, i) => <Group key={g.family + i} g={g} index={i} word={word} now={now} />)}
                {(report?.lowCachePanes ?? []).length > 0 ? (
                  <div className="ulowcache">⚠ low cache performance: {report?.lowCachePanes?.map((p) => `${p.label} ${p.hitPercent.toFixed(1)}%`).join(", ")}</div>
                ) : null}
              </div>
            )}
            <div className="row nf ufoot">
              <span className="f1 tr">{topic?.updatedAtMs != null ? `Updated ${clock(topic.updatedAtMs)} · every 15s` : busy ? "Loading…" : ""}</span>
              <span className="row ufsegs" role="group" aria-label="View">
                <Seg label="Full" on={view === "full"} onClick={() => onView("full")} cls="ufseg" />
                <Seg label="Compact" on={view === "compact"} onClick={() => onView("compact")} cls="ufseg" />
              </span>
              <button type="button" className="row ubtn" onClick={onRefresh} aria-busy={busy ? "true" : undefined}>
                Refresh
                <span className="mono ukey" aria-hidden="true">
                  r
                </span>
              </button>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
