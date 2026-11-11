import { useRef, useState } from "react";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { CUT, EMPTY, GONE_SUB, goneTitle, noFeed, outboxTitle, answerNotDelivered, PLUGIN_WHY, READ_ONLY, staleWords, UNAVAILABLE } from "../inbox/words";
import { age, alertSub, failedSub, goneBatch, groupSub, groupTitle, headerSub, incompleteWords, isKind, type Row } from "../inbox/model";

export interface InboxProps {
  topic: bridgeApi.InboxTopic;
  host?: HostState | undefined;
  /** POSIX seconds. */
  now: number;
}

function Notice({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <div className="ib-notice" data-tone={tone} role="status">
      {children}
    </div>
  );
}

function RowShell({
  selected,
  onSelect,
  mark,
  title,
  meta,
  sub,
  tone,
  chip,
  rowKey,
}: {
  selected: boolean;
  onSelect: () => void;
  mark: string;
  title: string;
  meta: string;
  sub: string;
  tone?: "alert" | "urgent" | "info" | "dim" | undefined;
  chip?: string | undefined;
  rowKey: string;
}) {
  return (
    <li>
      <button type="button" className="ib-row" data-selected={selected ? "true" : undefined} data-tone={tone} data-key={rowKey} aria-current={selected ? "true" : undefined} onClick={onSelect}>
        <span className="row ib-line">
          <span className="mono nf ib-cursor" aria-hidden="true">
            {selected ? "❯" : ""}
          </span>
          <span className="mono nf ib-num">{mark}</span>
          <span className="f1 tr ib-title">{title}</span>
          {chip ? <span className="nf ib-chip">{chip}</span> : null}
          <span className="mono nf ib-meta">{meta}</span>
        </span>
        {sub ? <span className="tr ib-sub">{sub}</span> : null}
      </button>
    </li>
  );
}

function machineName(m: { id: string; label: string | null }): string {
  return m.label ?? m.id;
}

function renderRow(row: Row, n: number | null, ctx: { host: HostState | undefined; now: number; selected: boolean; onSelect: () => void }) {
  const common = { rowKey: row.key, selected: ctx.selected, onSelect: ctx.onSelect };
  if (isKind(row, "group")) {
    return <RowShell key={row.key} {...common} mark={`${n ?? ""}.`} title={groupTitle(row)} meta={age(row.created_at, ctx.now)} sub={groupSub(row, ctx.host)} chip={row.new ? "new" : undefined} />;
  }
  if (isKind(row, "alert")) {
    return (
      <RowShell
        key={row.key}
        {...common}
        mark="⚠"
        title={row.title}
        meta={age(row.created_at, ctx.now)}
        sub={[alertSub(row, ctx.host), row.message].filter((x): x is string => !!x).join(" · ")}
        tone={row.severity === "info" ? "info" : "alert"}
        chip={row.new ? "new" : undefined}
      />
    );
  }
  if (isKind(row, "failed")) {
    return (
      <RowShell
        key={row.key}
        {...common}
        mark={row.delivery.warn ? "⚠" : "⏳"}
        title={answerNotDelivered(row.question_id)}
        meta={[row.delivery.state === "agent_gone" ? "agent gone" : null, age(row.answered_at, ctx.now)].filter((x) => !!x).join(" · ")}
        sub={failedSub(row, ctx.host)}
        tone={row.delivery.warn ? "alert" : "dim"}
      />
    );
  }
  if (isKind(row, "remote_group")) {
    return <RowShell key={row.key} {...common} mark="" title={row.title ?? row.questions[0]?.question ?? row.key} meta={READ_ONLY} sub={[machineName(row.machine), row.questions.some((q) => q.cut) ? CUT : null].filter((x) => x !== null).join(" · ")} />;
  }
  if (isKind(row, "remote_alert")) {
    return <RowShell key={row.key} {...common} mark="⚠" title={row.title} meta={READ_ONLY} sub={machineName(row.machine)} tone="alert" />;
  }
  if (isKind(row, "remote_outbox")) {
    return <RowShell key={row.key} {...common} mark="" title={outboxTitle(row.action, row.remote_id)} meta={row.state} sub={[machineName(row.machine), row.result].filter((x): x is string => !!x).join(" · ")} tone="dim" />;
  }
  if (isKind(row, "remote_problem")) {
    return <RowShell key={row.key} {...common} mark="⚠" title={answerNotDelivered(row.remote_id)} meta={READ_ONLY} sub={[machineName(row.machine), row.why, row.cut ? CUT : null].filter((x) => x !== null).join(" · ")} tone="alert" />;
  }
  // A kind this version does not know: its key, and nothing offered.
  return <RowShell key={row.key} {...common} mark="" title={row.key} meta="" sub="" tone="dim" />;
}

/** PhoneInbox (design/PhoneInbox): the herdr-inbox feed, read-only. Answering is S11. */
export function Inbox({ topic, host, now }: InboxProps) {
  const [picked, setPicked] = useState<string | null>(null);
  // The gone-agents summary is decided when the list first shows rows, and its set stays fixed (app-feed-v1).
  const gone = useRef<string[] | undefined>(undefined);
  if (gone.current === undefined && topic.state === "ok") gone.current = goneBatch(topic.entries);
  const folded = new Set(gone.current ?? []);
  const live = (gone.current ?? []).filter((k) => topic.entries.some((r) => r.key === k && isKind(r, "failed") && r.delivery.state === "agent_gone"));
  const rows = topic.entries.filter((r) => !folded.has(r.key));
  const selectedKey = picked !== null && rows.some((r) => r.key === picked) ? picked : (rows[0]?.key ?? null);
  // The summary sits right after the failed rows, before the remote ones (the popup's order), and stays while any of its members does.
  let goneAt = rows.length;
  const lastFailed = rows.map((r) => r.kind).lastIndexOf("failed");
  if (lastFailed >= 0) goneAt = lastFailed + 1;
  else {
    const firstRemote = rows.findIndex((r) => r.kind.startsWith("remote_") && r.kind !== "remote_alert");
    if (firstRemote >= 0) goneAt = firstRemote;
  }
  const groupNo = new Map<string, number>();
  for (const r of rows) if (isKind(r, "group")) groupNo.set(r.key, groupNo.size + 1);

  const renderOne = (r: Row) => renderRow(r, groupNo.get(r.key) ?? null, { host, now, selected: r.key === selectedKey, onSelect: () => setPicked(r.key) });
  const goneRow =
    live.length >= 1 ? (
      <li key="gone">
        <div className="ib-row" data-tone="alert" data-key="gone">
          <span className="row ib-line">
            <span className="mono nf ib-cursor" aria-hidden="true" />
            <span className="mono nf ib-num">⚠</span>
            <span className="f1 tr ib-title">{goneTitle(live.length)}</span>
          </span>
          <span className="tr ib-sub">{GONE_SUB}</span>
        </div>
      </li>
    ) : null;

  return (
    <>
      <header className="col nf ib-head">
        <h1 className="ib-h1">Inbox</h1>
        <span className="ib-headsub">{topic.state === "ok" ? headerSub(topic) : UNAVAILABLE}</span>
      </header>
      <main className="col f1 ib-main">
        {topic.stale && topic.state === "ok" ? (
          <Notice tone="warn">
            {staleWords(topic.problem)}
          </Notice>
        ) : null}
        {topic.incomplete ? (
          <Notice tone="warn">
            {[incompleteWords(topic.incomplete), ...topic.incomplete.errors].filter((x) => x !== "").join(" ")}
          </Notice>
        ) : null}
        {topic.state === "unavailable" ? (
          <div className="col f1 ib-empty">
            <p className="ib-empty-head">{UNAVAILABLE}</p>
            <p className="ib-empty-body">{topic.plugin === "ready" ? noFeed(topic.problem) : PLUGIN_WHY[topic.plugin]}</p>
          </div>
        ) : topic.empty ? (
          <div className="col f1 ib-empty">
            <p className="ib-empty-head">{EMPTY}</p>
          </div>
        ) : (
          <>
            <div className="row nf ib-listhead">
              <h2 className="f1 ib-listtitle">Open questions</h2>
              <span className="mono ib-count">{topic.waiting === 1 ? "1 group" : `${topic.waiting} groups`}</span>
            </div>
            <ul className="col ib-list" aria-label="Inbox">
              {rows.slice(0, goneAt).map(renderOne)}
              {goneRow}
              {rows.slice(goneAt).map(renderOne)}
            </ul>
          </>
        )}
      </main>
    </>
  );
}

