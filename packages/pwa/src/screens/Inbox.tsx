import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { CUT, EMPTY, GONE_SUB, goneTitle, noFeed, outboxTitle, answerNotDelivered, PLUGIN_WHY, READ_ONLY, staleWords, UNAVAILABLE } from "../inbox/words";
import { ClosedRows, closedReason, offlineAct, resultWords, type ActFn, type ActResult, type ClosedRow } from "../inbox/act";
import { useArmed, useArrivals, VIEW_ARM_MS } from "../inbox/arm";
import { age, alertSub, failedSub, goneBatch, groupSub, groupTitle, headerSub, incompleteWords, isKind, whereOf, type Of, type Row } from "../inbox/model";

export interface InboxProps {
  topic: bridgeApi.InboxTopic;
  host?: HostState | undefined;
  /** POSIX seconds. */
  now: number;
  /** Sends an inbox `act` through the bridge; without one nothing is sent. */
  act?: ActFn | undefined;
  /** Rows the phone saw close (the overlay's inert placeholders), shared with the Question screen. */
  closed?: ClosedRows | undefined;
}

/** Why a row that left the list on its own left, as far as the list can tell (the overlay's own fallbacks). */
function leftReason(row: Row): string | null {
  if (isKind(row, "failed")) return "no longer pending";
  if (isKind(row, "group") || isKind(row, "alert")) return "closed";
  return null;
}

function placeholderOf(row: Row, host: HostState | undefined): ClosedRow | null {
  const reason = leftReason(row);
  if (reason === null) return null;
  if (isKind(row, "group")) return { key: row.key, title: groupTitle(row), sub: whereOf(row.asker, host).agent ?? "", reason, at: row.created_at };
  if (isKind(row, "alert")) return { key: row.key, title: row.title, sub: alertSub(row, host), reason, at: row.created_at };
  if (isKind(row, "failed")) return { key: row.key, title: row.question, sub: [row.answer, whereOf(row.asker, host).agent].filter((x) => x).join(" · "), reason, at: row.answered_at };
  return null;
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

function Placeholder({ row, now, selected, onSelect }: { row: ClosedRow; now: number; selected: boolean; onSelect: () => void }) {
  return <RowShell rowKey={row.key} selected={selected} onSelect={onSelect} mark="" title={`✓ ${row.title} · ${row.reason}`} meta={age(row.at, now)} sub={row.sub} tone="dim" />;
}

/** The footer's row: the selected alert or undelivered answer, else the first alert that can be marked seen. */
function footerRow(rows: readonly Row[], selected: string | null): Of<"alert"> | Of<"failed"> | undefined {
  const sel = rows.find((r) => r.key === selected);
  if (sel && isKind(sel, "alert") && sel.actions.includes("ack")) return sel;
  if (sel && isKind(sel, "failed") && sel.actions.length > 0) return sel;
  return rows.find((r): r is Of<"alert"> => isKind(r, "alert") && r.actions.includes("ack"));
}

/** PhoneInbox (design/PhoneInbox): the herdr-inbox feed, its rows' own verbs, and the rows the phone saw close. */
export function Inbox({ topic, host, now, act = offlineAct, closed: given }: InboxProps) {
  const [own] = useState(() => new ClosedRows());
  const closed = given ?? own;
  useSyncExternalStore(
    (fn) => closed.subscribe(fn),
    () => closed.all().length + (closed.notice() ?? ""),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const armedView = useArmed(VIEW_ARM_MS);
  const arrived = useArrivals(topic.entries.map((r) => r.key));
  // A row that leaves while the list is shown stays as a placeholder (the overlay's rule), until the operator moves.
  const shown = useRef<Map<string, Row> | null>(null);
  useEffect(() => {
    if (topic.state !== "ok") return;
    const now = new Map(topic.entries.map((r) => [r.key, r]));
    if (shown.current) {
      for (const [k, r] of shown.current) {
        if (now.has(k) || closed.get(k)) continue;
        const p = placeholderOf(r, host);
        if (p) closed.add(p);
      }
    }
    shown.current = now;
  }, [topic, host, closed]);
  // The gone-agents summary is decided when the list first shows rows, and its set stays fixed (app-feed-v1).
  const gone = useRef<string[] | undefined>(undefined);
  if (gone.current === undefined && topic.state === "ok") gone.current = goneBatch(topic.entries);
  const folded = new Set(gone.current ?? []);
  const live = (gone.current ?? []).filter((k) => topic.entries.some((r) => r.key === k && isKind(r, "failed") && r.delivery.state === "agent_gone"));
  const rows = topic.entries.filter((r) => !folded.has(r.key));
  const selectedKey = picked !== null && (rows.some((r) => r.key === picked) || closed.get(picked)) ? picked : (rows[0]?.key ?? null);
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

  const select = (r: Row | ClosedRow) => {
    // A row that has just arrived takes no tap yet: the list may have moved under the finger.
    if ("kind" in r && !arrived(r.key)) return;
    setPicked(r.key);
    closed.purge(r.key);
    if (closed.notice() !== null) closed.say(null);
    if ("kind" in r && isKind(r, "group") && !closed.get(r.key)) {
      const first = r.questions.find((q) => q.draft === null) ?? r.questions[0];
      window.location.hash = `#/inbox/q/${encodeURIComponent(r.key)}/${first?.id ?? ""}`;
    }
  };
  const renderOne = (r: Row) => {
    const gone = closed.get(r.key);
    if (gone) return <Placeholder key={r.key} row={gone} now={now} selected={r.key === selectedKey} onSelect={() => select(gone)} />;
    return renderRow(r, groupNo.get(r.key) ?? null, { host, now, selected: r.key === selectedKey, onSelect: () => select(r) });
  };
  const inTopic = new Set(topic.entries.map((r) => r.key));
  const extraClosed = topic.state === "ok" ? closed.all().filter((c) => !inTopic.has(c.key)) : [];
  const foot = topic.state === "ok" ? footerRow(rows, selectedKey) : undefined;
  const run = (kind: "inbox.ack" | "inbox.retry" | "inbox.stop_showing", row: Of<"alert"> | Of<"failed">) => {
    if (busy || !armedView() || !arrived(row.key)) return;
    setBusy(true);
    void act(kind, { key: row.key, rev: row.rev })
      .catch((): ActResult => ({ ok: false, code: "failed", unknown_effect: true }))
      .then((r) => {
        setBusy(false);
        if (r.closed) {
          const p = placeholderOf(row, host);
          if (p) closed.add({ ...p, reason: closedReasonWord(r.closed) });
        }
        closed.say(r.ok && !r.message ? null : resultWords(r));
      });
  };
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
        {closed.notice() !== null ? <Notice tone="info">{closed.notice()}</Notice> : null}
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
              {extraClosed.map((c) => (
                <Placeholder key={c.key} row={c} now={now} selected={c.key === selectedKey} onSelect={() => select(c)} />
              ))}
            </ul>
            {foot ? <Footer row={foot} busy={busy} run={run} /> : null}
          </>
        )}
      </main>
    </>
  );
}


function closedReasonWord(word: NonNullable<ActResult["closed"]>): string {
  return closedReason(word);
}

/** The footer of the board: "Alert Title 456 needs no answer. [Seen]", or an undelivered answer's two verbs. */
function Footer({ row, busy, run }: { row: Of<"alert"> | Of<"failed">; busy: boolean; run: (kind: "inbox.ack" | "inbox.retry" | "inbox.stop_showing", row: Of<"alert"> | Of<"failed">) => void }) {
  if (isKind(row, "alert")) {
    return (
      <div className="row ib-foot">
        <span className="f1 ib-foottext">{row.title} needs no answer.</span>
        <button type="button" className="nf ib-footbtn" disabled={busy} onClick={() => run("inbox.ack", row)}>
          Seen
        </button>
      </div>
    );
  }
  const failed = row as Of<"failed">;
  return (
    <div className="row ib-foot">
      <span className="f1 ib-foottext">{failed.delivery.line}</span>
      {failed.actions.includes("retry") ? (
        <button type="button" className="nf ib-footbtn" disabled={busy} onClick={() => run("inbox.retry", failed)}>
          {failed.retry_label}
        </button>
      ) : null}
      {failed.actions.includes("stop-showing") ? (
        <button type="button" className="nf ib-footbtn" disabled={busy} onClick={() => run("inbox.stop_showing", failed)}>
          Stop showing
        </button>
      ) : null}
    </div>
  );
}
