// Plugin items inline in the chat view, and the panorama strip under its header (CV5; design/PhoneChatView,
// states "Typing off" and "History"; docs/chatview.md §4). Every act is the inbox's own (`inbox.answer`,
// `inbox.dismiss`, `inbox.ack`, `inbox.retry`), sent for the row as the bridge published it (`key` + `rev`), with
// the inbox's arm delays: a row takes no tap for a second after it arrives or changes, and a refusal re-arms it.
import { useEffect, useRef, useState } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import { offlineAct, resultWords, type ActFn, type ActResult } from "../inbox/act";
import { GRACE_MS, ROW_ARM_MS, useArmed, VIEW_ARM_MS } from "../inbox/arm";
import { age, groupTitle, type Of } from "../inbox/model";
import { ANSWER, answerNotDelivered, dismissWhat } from "../inbox/words";
import { Tile } from "../components/StateMarks";
import { alertRow, failedRow, peekHref, questionRow, safeHref, swarmData } from "./model";
import { MORE_OPTIONS, NEEDS_NO_ANSWER, STRIP_CHEVRON } from "./words";
import "./timeline.css";

type TimelineItem = bridgeApi.TimelineItem;

export interface TimelineRowProps {
  item: TimelineItem;
  /** Sends an inbox `act`; without one nothing is sent. */
  act?: ActFn | undefined;
  /** POSIX seconds, for the question's age. */
  now: number;
}

/** One timeline item: its kind's component, or a plain row from its fallback fields. */
export function TimelineRow({ item, act = offlineAct, now }: TimelineRowProps) {
  const q = questionRow(item);
  if (q) return <InlineQuestion key={q.key} row={q} act={act} now={now} />;
  const a = alertRow(item);
  if (a) return <InlineAlert key={a.key} row={a} act={act} />;
  const f = failedRow(item);
  if (f) return <InlineFailed key={f.key} row={f} act={act} />;
  return <FallbackRow item={item} />;
}

/** Sends one act at a time and keeps the inbox's words for anything but a plain success. */
function useAct(act: ActFn, row: { key: string; rev: string }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [misses, setMisses] = useState(0);
  const inFlight = useRef(false);
  const send = (kind: bridgeApi.InboxActKind, args: Record<string, unknown> = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSaid(null);
    void act(kind, { key: row.key, rev: row.rev, ...args })
      .catch((): ActResult => ({ ok: false, code: "failed", unknown_effect: true }))
      .then((r) => {
        inFlight.current = false;
        setBusy(false);
        if (!r.ok) setMisses((n) => n + 1);
        setSaid(r.ok && !r.message ? null : resultWords(r));
      });
  };
  return { busy, said, send, misses };
}

/** Arms after the row arrives and again after its content (`rev`) or a refusal changes what is under the finger. */
function useRowArmed(rev: string, misses: number): () => boolean {
  return useArmed(ROW_ARM_MS, `${rev}|${misses}`, GRACE_MS);
}

function InlineQuestion({ row, act, now }: { row: Of<"group">; act: ActFn; now: number }) {
  const { busy, said, send, misses } = useAct(act, row);
  const armed = useRowArmed(row.rev, misses);
  const [dismissing, setDismissing] = useState(false);
  // The confirming tap is armed on its own, so a double tap can't dismiss the group.
  const confirmArmed = useArmed(VIEW_ARM_MS, dismissing);
  const q = row.questions.find((x) => x.draft === null) ?? row.questions[0]!;
  // One tap answers only a lone, single-select question with options; anything else opens the Question screen.
  const lone = row.questions.length === 1 && !q.multi_select && !q.cut && q.options.length > 0 && row.actions.includes("answer");
  const ago = age(row.created_at, now);
  const guard = (fn: () => void) => () => {
    if (busy || !armed()) return;
    fn();
  };
  const pick = (i: number) => {
    setDismissing(false);
    send("inbox.answer", { question: q.id, detail: { choices: [i], notes: {}, text: null } });
  };
  return (
    <section aria-label={`Question Q${q.id}`} className="rel col tl-q" data-key={row.key}>
      <span className="abs tl-q-edge" aria-hidden="true" />
      <div className="row tl-q-head">
        <Tile code="wait" size={18} count={row.questions.length} />
        <span className="f1 tr tl-q-title">{groupTitle(row)}</span>
        <span className="mono tl-q-meta">{[`Q${q.id}`, ago].filter((x) => x !== "").join(" · ")}</span>
      </div>
      <div className="tl-q-text">{q.question}</div>
      {lone ? (
        <div className="col tl-q-opts">
          {q.options.map((o, i) => (
            <button key={`${i}:${o.label}`} type="button" className="row tl-q-opt" disabled={busy} onClick={guard(() => pick(i))}>
              <span className="mono tl-q-n">{i + 1}</span>
              <span className="col f1 tl-q-optbody">
                <span className="tl-q-label">{o.label}</span>
                {o.description ? <span className="tl-q-desc">{o.description}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {said !== null ? (
        <p role="status" className="tl-said">
          {said}
        </p>
      ) : null}
      {dismissing ? (
        <div role="alertdialog" aria-labelledby={`tl-dq-${row.key}`} className="col tl-q-confirm">
          <p id={`tl-dq-${row.key}`} className="tl-q-confirmq">
            {ANSWER.dismissConfirm(dismissWhat(row.questions.map((x) => x.id)))}
          </p>
          <div className="row tl-q-acts">
            <button type="button" className="f1 tl-q-keep" onClick={() => setDismissing(false)} disabled={busy}>
              {ANSWER.keep}
            </button>
            <button
              type="button"
              className="f1 tl-q-dismissgo"
              disabled={busy}
              onClick={guard(() => {
                if (!confirmArmed()) return;
                setDismissing(false);
                send("inbox.dismiss");
              })}
            >
              {ANSWER.DISMISS}
            </button>
          </div>
        </div>
      ) : (
        <div className="row tl-q-acts">
          <a href={`#/inbox/q/${encodeURIComponent(row.key)}/${q.id}`} className="row f1 tl-q-more">
            {MORE_OPTIONS}
          </a>
          {row.actions.includes("dismiss") ? (
            <button type="button" className="row nf tl-q-dismiss" disabled={busy} onClick={guard(() => setDismissing(true))}>
              {ANSWER.DISMISS}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** The alert and failed rows share the board's alert layout: a dot, two lines, one button. */
function NoteRow(props: { label: string; tone: "bad" | "warn" | "muted"; title: string; sub: string; button: string | null; busy: boolean; said: string | null; onPress: () => void; rowKey: string }) {
  return (
    <section aria-label={props.label} className="col tl-note" data-tone={props.tone} data-key={props.rowKey}>
      <div className="row tl-note-row">
        <span className="nf tl-note-dot" aria-hidden="true" />
        <span className="col f1 tl-note-text">
          <span className="tl-note-title">{props.title}</span>
          {props.sub ? <span className="tl-note-sub">{props.sub}</span> : null}
        </span>
        {props.button !== null ? (
          <button type="button" className="nf tl-note-btn" disabled={props.busy} onClick={props.onPress}>
            {props.button}
          </button>
        ) : null}
      </div>
      {props.said !== null ? (
        <p role="status" className="tl-said">
          {props.said}
        </p>
      ) : null}
    </section>
  );
}

function InlineAlert({ row, act }: { row: Of<"alert">; act: ActFn }) {
  const { busy, said, send, misses } = useAct(act, row);
  const armed = useRowArmed(row.rev, misses);
  return (
    <NoteRow
      label="Alert"
      rowKey={row.key}
      tone={row.severity === "info" ? "muted" : "bad"}
      title={row.title}
      sub={row.message ?? NEEDS_NO_ANSWER}
      button={row.actions.includes("ack") ? ANSWER.seen : null}
      busy={busy}
      said={said}
      onPress={() => {
        if (!busy && armed()) send("inbox.ack");
      }}
    />
  );
}

function InlineFailed({ row, act }: { row: Of<"failed">; act: ActFn }) {
  const { busy, said, send, misses } = useAct(act, row);
  const armed = useRowArmed(row.rev, misses);
  return (
    <NoteRow
      label={answerNotDelivered(row.question_id)}
      rowKey={row.key}
      tone={row.delivery.warn ? "warn" : "muted"}
      title={answerNotDelivered(row.question_id)}
      sub={row.delivery.line}
      button={row.actions.includes("retry") ? row.retry_label : null}
      busy={busy}
      said={said}
      onPress={() => {
        if (!busy && armed()) send("inbox.retry");
      }}
    />
  );
}

/** A kind this phone doesn't know: its title and line, linked where the bridge gave a phone route. */
function FallbackRow({ item }: { item: TimelineItem }) {
  const body = (
    <>
      <span className="tr f1">
        <span className="tl-plain-title">{item.title}</span>
        {item.line ? ` · ${item.line}` : null}
      </span>
    </>
  );
  const href = safeHref(item.href);
  return href ? (
    <a href={href} className="row tl-plain" data-key={item.key}>
      {body}
    </a>
  ) : (
    <div className="row tl-plain" data-key={item.key}>
      {body}
    </div>
  );
}

const LONG_PRESS_MS = 500;

/** The strip under the chat header: the panorama root's subagents ("6 subagents ›"), linked to Swarm. */
export function TimelineStrip({ strip }: { strip: readonly bridgeApi.StripItem[] }) {
  if (strip.length === 0) return null;
  return (
    <div className="row nf tl-strip">
      {strip.map((s) => (
        <StripEntry key={s.key} item={s} />
      ))}
    </div>
  );
}

function StripEntry({ item }: { item: bridgeApi.StripItem }) {
  const data = swarmData(item);
  const href = safeHref(item.href);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const long = useRef(false);
  // A long-press still pending when the strip goes away must not open Peek afterwards.
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!data) {
    return href ? (
      <a href={href} className="row f1 tl-strip-link">
        <span className="tr">{item.label}</span>
      </a>
    ) : (
      <span className="row f1 tl-strip-link">
        <span className="tr">{item.label}</span>
      </span>
    );
  }
  // Long-press opens Peek of the subagent that needs you (when one does); a tap opens Swarm.
  const needs = data.needs;
  const start = () => {
    long.current = false;
    if (needs === null) return;
    timer.current = setTimeout(() => {
      long.current = true;
      window.location.hash = peekHref(data.root_key, needs);
    }, LONG_PRESS_MS);
  };
  const cancel = () => clearTimeout(timer.current);
  return (
    <a
      href={href}
      className="row f1 tl-strip-link"
      data-tone={item.tone}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        if (needs !== null) e.preventDefault();
      }}
      onClick={(e) => {
        if (long.current) {
          e.preventDefault();
          long.current = false;
        }
      }}
    >
      {data.counts.map((c) => (
        <Tile key={c.code} code={c.code} count={c.n} />
      ))}
      <span className="tr tl-strip-label">{item.label}</span>
      <span className="tl-strip-chev" aria-hidden="true">
        {STRIP_CHEVRON}
      </span>
    </a>
  );
}
