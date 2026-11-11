import { useRef, useState } from "react";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { age, alertSub, failedSub, feedAge, goneBatch, groupSub, groupTitle, headerSub, incompleteWords, isKind, type Row } from "../inbox/model";

export interface InboxProps {
  topic: bridgeApi.InboxTopic;
  host?: HostState | undefined;
  /** POSIX seconds. */
  now: number;
}

const PROBLEM: Record<NonNullable<bridgeApi.InboxTopic["problem"]>, string> = {
  missing: "missing",
  unreadable: "unreadable",
  unsupported: "unsupported version",
  "not-ok": "the inbox could not be read",
};

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
        title={row.question}
        meta={age(row.answered_at, ctx.now)}
        sub={failedSub(row, ctx.host)}
        tone={row.delivery.warn ? "alert" : "dim"}
      />
    );
  }
  if (isKind(row, "remote_group")) {
    return <RowShell key={row.key} {...common} mark="" title={row.title ?? row.questions[0]?.question ?? row.key} meta={age(row.created_at, ctx.now)} sub={[machineName(row.machine), row.questions.some((q) => q.cut) ? "text cut" : null].filter((x) => x !== null).join(" · ")} />;
  }
  if (isKind(row, "remote_alert")) {
    return <RowShell key={row.key} {...common} mark="⚠" title={row.title} meta={age(row.created_at, ctx.now)} sub={machineName(row.machine)} tone="alert" />;
  }
  if (isKind(row, "remote_outbox")) {
    return <RowShell key={row.key} {...common} mark="" title={`${row.action} to ${machineName(row.machine)}`} meta="" sub={[row.state, row.result].filter((x): x is string => !!x).join(" · ")} tone="dim" />;
  }
  if (isKind(row, "remote_problem")) {
    return <RowShell key={row.key} {...common} mark="⚠" title={row.question} meta="" sub={[machineName(row.machine), row.why, row.cut ? "text cut" : null].filter((x) => x !== null).join(" · ")} tone="alert" />;
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
            <span className="f1 tr ib-title">{live.length === 1 ? "1 answer whose agent is gone" : `${live.length} answers whose agents are gone`}</span>
          </span>
          <span className="tr ib-sub">check_answers still has {live.length === 1 ? "it" : "them"}</span>
        </div>
      </li>
    ) : null;

  return (
    <>
      <header className="col nf ib-head">
        <h1 className="ib-h1">Inbox</h1>
        <span className="ib-headsub">{topic.state === "ok" ? headerSub(topic) : "Inbox unavailable"}</span>
      </header>
      <main className="col f1 ib-main">
        {topic.stale && topic.state === "ok" ? (
          <Notice tone="warn">
            {topic.problem
              ? `The inbox feed can't be read (${PROBLEM[topic.problem]}): this is the last good copy${topic.generated_at !== null ? `, ${feedAge(topic.generated_at, now)} old` : ""}. It may be out of date.`
              : "The inbox feed is out of date: this may not be the inbox as it is now."}
          </Notice>
        ) : null}
        {topic.incomplete ? (
          <Notice tone="warn">
            {[incompleteWords(topic.incomplete), ...topic.incomplete.errors].filter((x) => x !== "").join(" ")}
          </Notice>
        ) : null}
        {topic.state === "unavailable" ? (
          <div className="col f1 ib-empty">
            <p className="ib-empty-head">Inbox unavailable</p>
            <p className="ib-empty-body">
              {topic.plugin === "ready"
                ? `There is no inbox feed to read (${topic.problem ? PROBLEM[topic.problem] : "waiting for it"}).`
                : topic.plugin === "too_old"
                  ? "herdr-inbox is too old for the app."
                  : "herdr-inbox is not responding."}
            </p>
          </div>
        ) : topic.empty ? (
          <div className="col f1 ib-empty">
            <p className="ib-empty-head">No open questions</p>
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

