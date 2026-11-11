import { useState } from "react";
import type { bridgeApi, HostState } from "@herdr-remote/protocol";
import { closedReason, resultWords, type ActFn, type ActResult, type ClosedRows } from "../inbox/act";
import { GRACE_MS, useArmed, VIEW_ARM_MS } from "../inbox/arm";
import { age, groupTitle, whereOf, type Of } from "../inbox/model";
import { ANSWER, CUT, dismissWhat } from "../inbox/words";

type Group = Of<"group">;
type Q = bridgeApi.InboxQuestion;

/** What the phone has picked for one question, before it is stored. Options are indices into `q.options`. */
export interface Pick {
  picked: number[];
  notes: Record<number, string>;
  /** The free-text answer ("Something else…"); null when not chosen. */
  text: string | null;
}

/** A stored draft as picks: a label means the first option with that label (app-commands-v1). */
export function pickOf(q: Q): Pick {
  const d = q.draft;
  if (!d) return { picked: [], notes: {}, text: null };
  const labels = q.options.map((o) => o.label);
  const picked = [...new Set(d.choices.map((l) => labels.indexOf(l)).filter((i) => i >= 0))].sort((a, b) => a - b);
  const notes: Record<number, string> = {};
  for (const [l, n] of Object.entries(d.notes)) {
    const i = labels.indexOf(l);
    if (i >= 0) notes[i] = n;
  }
  return { picked, notes, text: d.text };
}

/** The act's `detail`: indices only, so the bridge takes every label from its own copy of the question. */
export function detailOf(p: Pick): bridgeApi.InboxDetailArg {
  const notes: Record<string, string> = {};
  for (const i of p.picked) {
    const n = p.notes[i]?.trim();
    if (n) notes[String(i)] = n;
  }
  return { choices: [...p.picked], notes, text: p.text !== null && p.text.trim() !== "" ? p.text : null };
}

const isEmpty = (p: Pick): boolean => p.picked.length === 0 && (p.text ?? "").trim() === "";
const same = (a: Pick, b: Pick): boolean => JSON.stringify(detailOf(a)) === JSON.stringify(detailOf(b));

/** What a stored draft says, for the review list. */
export function draftWords(q: Q): string | null {
  const d = q.draft;
  if (!d) return null;
  const parts = [...d.choices];
  if (d.text) parts.push(d.text);
  return parts.length > 0 ? parts.join(", ") : null;
}

const tabName = (q: Q): string => q.header ?? `Q${q.id}`;

function Back({ href }: { href: string }) {
  return (
    <a href={href} aria-label="Back" className="row nf qn-back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </a>
  );
}

const hrefOf = (key: string, tab: number | "submit"): string => `#/inbox/q/${encodeURIComponent(key)}/${tab}`;

function Tabs({ row, current }: { row: Group; current: number | "submit" }) {
  const drafted = row.questions.filter((q) => q.draft !== null).length;
  return (
    <div role="tablist" aria-label="Questions" className="row nf qn-tabs">
      {row.questions.map((q) => (
        <a
          key={q.id}
          href={hrefOf(row.key, q.id)}
          role="tab"
          aria-selected={current === q.id}
          className="row nf qn-tab"
          data-state={current === q.id ? "current" : q.draft !== null ? "drafted" : undefined}
        >
          {tabName(q)}
        </a>
      ))}
      <span className="f1" />
      <a href={hrefOf(row.key, "submit")} role="tab" aria-selected={current === "submit"} className="row nf qn-submit" data-current={current === "submit" ? "true" : undefined}>
        <span className="qn-submit-label">{ANSWER.submitTab}</span>
        <span className="mono qn-submit-n">
          {drafted}/{row.questions.length}
        </span>
      </a>
    </div>
  );
}

export interface QuestionProps {
  row: Group;
  /** The question on screen, or the Submit tab. */
  tab: number | "submit";
  host?: HostState | undefined;
  now: number;
  act: ActFn;
  closed: ClosedRows;
  /** Demo only: an option picked when the screen opens. */
  initialPick?: number | undefined;
}

/** PhoneQuestion and PhoneReview (design/): one group of the herdr-inbox, answered through the bridge. */
export function Question(props: QuestionProps) {
  const { row, tab } = props;
  // Decided when the group opens, as the overlay decides it on the operator's move: a group that drops to one
  // question while open stays a group (Next and Submit), so Next never turns into Send under the finger.
  const [lone] = useState(() => row.questions.length === 1);
  if (tab === "submit" && !lone) return <Review {...props} />;
  const q = row.questions.find((x) => x.id === tab);
  // The question on screen closed elsewhere: say so, and never slide another question (and its draft) under the finger.
  if (!q) return <ClosedQuestion {...props} lone={lone} qid={typeof tab === "number" ? tab : null} />;
  return <OneQuestion key={`${row.key}/${q.id}`} {...props} q={q} lone={lone} />;
}

function ClosedQuestion(props: QuestionProps & { lone: boolean; qid: number | null }) {
  const { row, host, now, lone, qid } = props;
  const first = row.questions[0];
  return (
    <>
      <Head row={row} host={host} now={now} q={null} />
      {lone ? null : <Tabs row={row} current={qid ?? 0} />}
      <main className="col f1 qn-main">
        <p className="qn-said" role="alert">
          {qid !== null ? ANSWER.questionClosed(qid) : ANSWER.gone}
        </p>
      </main>
      <div className="row nf qn-foot">
        <a href="#/inbox" className="row f1 qn-later">
          {ANSWER.later}
        </a>
        {first ? (
          <a href={hrefOf(row.key, first.id)} className="row qn-next">
            {ANSWER.lookAgain}
          </a>
        ) : null}
      </div>
    </>
  );
}

function useSend(props: QuestionProps) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /** Bumped on every result that is not a success: the view re-arms, as the overlay's does after a refusal. */
  const [misses, setMisses] = useState(0);
  const send = async (kind: bridgeApi.InboxActKind, args: Record<string, unknown>, after: (r: ActResult) => void) => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    let r: ActResult;
    try {
      r = await props.act(kind, { key: props.row.key, rev: props.row.rev, ...args });
    } catch {
      r = { ok: false, code: "failed", unknown_effect: true };
    }
    setBusy(false);
    if (!r.ok) setMisses((n) => n + 1);
    after(r);
  };
  return { busy, said, setSaid, send, misses };
}

/** Back to the list, saying what happened there; a closed row leaves its placeholder. */
function toList(props: QuestionProps, r: ActResult, sub: string): void {
  const { row, closed } = props;
  if (r.closed) closed.add({ key: row.key, title: groupTitle(row), sub, reason: closedReason(r.closed), at: row.created_at });
  closed.say(r.ok && !r.message ? null : resultWords(r));
  window.location.hash = "#/inbox";
}

function Head({ row, host, now, q, extra }: { row: Group; host: HostState | undefined; now: number; q: Q | null; extra?: React.ReactNode }) {
  const w = whereOf(row.asker, host);
  const ago = age(row.created_at, now);
  return (
    <header className="col nf qn-head">
      <div className="row qn-titlerow">
        <Back href={q ? "#/inbox" : hrefOf(row.key, row.questions[0]?.id ?? 0)} />
        <h1 className="f1 tr qn-title">{groupTitle(row)}</h1>
        {extra}
      </div>
      {q ? (
        <div className="row mono qn-meta">
          <span className="qn-qid">Q{q.id}</span>
          <span className="tr">{[w.agent, w.space].filter((x) => x).join(" · ")}</span>
          {ago ? <span className="nf">{ago === "now" ? "now" : `${ago} ago`}</span> : null}
        </div>
      ) : null}
    </header>
  );
}

function OneQuestion(props: QuestionProps & { q: Q; lone: boolean }) {
  const { row, q, lone, host, now } = props;
  const stored = pickOf(q);
  const [pick, setPick] = useState<Pick>(() => (props.initialPick !== undefined && q.options[props.initialPick] && stored.picked.length === 0 ? { ...stored, picked: [props.initialPick] } : stored));
  const [typing, setTyping] = useState(stored.text !== null);
  const [dismissing, setDismissing] = useState(false);
  const { busy, said, setSaid, send, misses } = useSend(props);
  const armed = useArmed(VIEW_ARM_MS, `${row.rev}|${misses}`, GRACE_MS);
  // The confirming tap is armed on its own, so a double tap can't dismiss the whole group.
  const confirmArmed = useArmed(VIEW_ARM_MS, dismissing);
  const guard = (fn: () => void) => () => {
    if (busy || !armed()) return;
    if (fn !== dismiss && fn !== confirmDismiss) setDismissing(false);
    fn();
  };
  const idx = row.questions.findIndex((x) => x.id === q.id);
  const nextTab: number | "submit" = idx + 1 < row.questions.length ? (row.questions[idx + 1]?.id ?? "submit") : "submit";
  const choose = (i: number) => {
    setTyping(false);
    setPick((p) => {
      if (!q.multi_select) return { picked: [i], notes: p.notes, text: null };
      const on = p.picked.includes(i);
      return { ...p, picked: on ? p.picked.filter((x) => x !== i) : [...p.picked, i].sort((a, b) => a - b) };
    });
  };
  const other = () => {
    setTyping(true);
    setPick((p) => (q.multi_select ? { ...p, text: p.text ?? "" } : { picked: [], notes: {}, text: p.text ?? "" }));
  };
  const summary = [...pick.picked.map((i) => q.options[i]?.label ?? ""), pick.text ?? ""].filter((x) => x.trim() !== "").join(", ");
  const asker = whereOf(row.asker, host).agent;
  const primary = () => {
    if (lone) {
      if (isEmpty(pick)) return setSaid(ANSWER.pickFirst);
      void send("inbox.answer", { question: q.id, detail: detailOf(pick) }, (r) => {
        if (r.ok || r.unknown_effect) toList(props, r, [summary, asker].filter((x) => x).join(" · "));
        else setSaid(resultWords(r));
      });
      return;
    }
    const go = () => {
      window.location.hash = hrefOf(row.key, nextTab);
    };
    if (same(pick, stored)) return go();
    const args = isEmpty(pick) ? { question: q.id, clear: true } : { question: q.id, detail: detailOf(pick) };
    void send("inbox.draft", args, (r) => {
      if (r.ok) go();
      else if (r.unknown_effect) toList(props, r, "");
      else setSaid(resultWords(r));
    });
  };
  function dismiss() {
    setDismissing(true);
  }
  function confirmDismiss() {
    if (!confirmArmed()) return;
    setDismissing(false);
    void send("inbox.dismiss", {}, (r) => {
      if (r.ok || r.unknown_effect) toList(props, r, [asker].filter((x) => x).join(" · "));
      else setSaid(resultWords(r));
    });
  }
  const chatHref = (() => {
    const a = row.asker.terminal ? host?.agents.find((x) => x.terminal_id === row.asker.terminal) : undefined;
    return a ? `#/chat/${encodeURIComponent(a.id)}` : undefined;
  })();
  const pickedOne = pick.picked.length === 1 ? pick.picked[0] : undefined;
  const dismissButton = (
    <button type="button" className="nf qn-dismiss" onClick={guard(dismiss)} disabled={busy}>
      {ANSWER.DISMISS}
    </button>
  );
  return (
    <>
      <Head row={row} host={host} now={now} q={q} extra={dismissButton} />
      {lone ? null : <Tabs row={row} current={q.id} />}
      <main className="col f1 qn-main">
        <div className="row qn-kind">
          <span className="mono qn-chip">{q.multi_select ? "MULTI" : "SINGLE"}</span>
          <span className="mono qn-hint">{q.multi_select ? "pick any" : "pick one"}</span>
        </div>
        <p className="qn-text">{q.question}</p>
        {q.cut ? (
          <p className="qn-said" role="note">
            {CUT}
          </p>
        ) : null}
        {q.context ? <p className="qn-context">{q.context}</p> : null}
        <div className="col qn-opts" role="group" aria-label="Options">
          {q.options.map((o, i) => (
            <Option key={i} n={i + 1} on={pick.picked.includes(i)} label={o.label} desc={o.description} onClick={guard(() => choose(i))} />
          ))}
          <Option n={q.options.length + 1} on={typing} label={ANSWER.other} desc={ANSWER.otherSub} onClick={guard(other)} />
          {!q.multi_select ? <Option n={q.options.length + 2} on={false} label={ANSWER.chat} desc={ANSWER.chatSub} href={chatHref} /> : null}
        </div>
        {typing ? (
          <>
            <label htmlFor="qn-text" className="qn-label">
              {ANSWER.yourAnswer}
            </label>
            <textarea id="qn-text" className="qn-input qn-area" rows={3} placeholder={ANSWER.yourAnswerPlaceholder} value={pick.text ?? ""} onChange={(e) => setPick((p) => ({ ...p, text: e.target.value }))} />
          </>
        ) : (
          <>
            <label htmlFor="qn-note" className="qn-label">
              {ANSWER.note}
            </label>
            <input
              id="qn-note"
              className="qn-input"
              placeholder={ANSWER.notePlaceholder}
              disabled={pickedOne === undefined}
              value={pickedOne !== undefined ? (pick.notes[pickedOne] ?? "") : ""}
              onChange={(e) => pickedOne !== undefined && setPick((p) => ({ ...p, notes: { ...p.notes, [pickedOne]: e.target.value } }))}
            />
          </>
        )}
        {said ? (
          <p className="qn-said" role="alert">
            {said}
          </p>
        ) : null}
      </main>
      {dismissing ? (
        <div role="alertdialog" aria-labelledby="qn-dismiss-q" className="col nf qn-dismissbar">
          <p id="qn-dismiss-q" className="qn-dismissq">
            {ANSWER.dismissConfirm(dismissWhat(row.questions.map((x) => x.id)))}
          </p>
          <div className="row qn-dismissacts">
            <button type="button" className="f1 qn-keep" onClick={() => setDismissing(false)} disabled={busy}>
              {ANSWER.keep}
            </button>
            <button type="button" className="f1 qn-dismissgo" onClick={guard(confirmDismiss)} disabled={busy}>
              {ANSWER.DISMISS}
            </button>
          </div>
        </div>
      ) : (
        <div className="row nf qn-foot">
          <a href="#/inbox" className="row f1 qn-later">
            {ANSWER.later}
          </a>
          <button type="button" className="row qn-next" onClick={guard(primary)} disabled={busy}>
            {busy ? ANSWER.sending : lone ? ANSWER.send : ANSWER.next}
          </button>
        </div>
      )}
    </>
  );
}

function Option({ n, on, label, desc, onClick, href }: { n: number; on: boolean; label: string; desc: string | null; onClick?: () => void; href?: string | undefined }) {
  const inner = (
    <>
      <span className="mono nf qn-optn">{n}</span>
      <span className="col qn-optbody">
        <span className="qn-optlabel">{label}</span>
        {desc ? <span className="qn-optdesc">{desc}</span> : null}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="row qn-opt" aria-pressed={on} data-on={on ? "true" : undefined} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return href ? (
    <a href={href} className="row qn-opt">
      {inner}
    </a>
  ) : (
    <span className="row qn-opt" aria-disabled="true">
      {inner}
    </span>
  );
}

function Review(props: QuestionProps) {
  const { row, host, now } = props;
  const { busy, said, setSaid, send, misses } = useSend(props);
  const armed = useArmed(VIEW_ARM_MS, `${row.rev}|${misses}`, GRACE_MS);
  const ready = row.questions.filter((q) => draftWords(q) !== null);
  const open = row.questions.filter((q) => draftWords(q) === null);
  const line = ready.length === 0 ? ANSWER.nothingYet : ANSWER.sends(ready.length, row.questions.length, open.map(tabName));
  const submit = () => {
    if (busy || !armed()) return;
    if (ready.length === 0) return setSaid(ANSWER.answerOneFirst);
    const asker = whereOf(row.asker, host).agent;
    void send("inbox.answer", { questions: ready.map((q) => q.id) }, (r) => {
      if (r.ok || r.unknown_effect) toList(props, r, [ready.map((q) => draftWords(q)).join("; "), asker].filter((x) => x).join(" · "));
      else setSaid(resultWords(r));
    });
  };
  return (
    <>
      <Head row={row} host={host} now={now} q={null} />
      <Tabs row={row} current="submit" />
      <main className="col f1 qn-main qn-review">
        <h2 className="qn-reviewhead">{ANSWER.review}</h2>
        {row.questions.map((q) => {
          const w = draftWords(q);
          return (
            <a key={q.id} href={hrefOf(row.key, q.id)} className="row qn-item">
              <span className="col f1 qn-itembody">
                <span className="qn-itemq">
                  Q{q.id} · {tabName(q)}
                </span>
                <span className="qn-itema" data-none={w === null ? "true" : undefined}>
                  {w ?? ANSWER.noAnswer}
                </span>
              </span>
              <span className="nf qn-chev" aria-hidden="true">
                ›
              </span>
            </a>
          );
        })}
        {said ? (
          <p className="qn-said" role="alert">
            {said}
          </p>
        ) : null}
      </main>
      <div className="col nf qn-rfoot">
        <button type="button" className="row qn-send" onClick={submit} disabled={busy}>
          <span className="mono nf qn-sendn">1</span>
          <span className="col f1 qn-sendbody">
            <span className="qn-sendlabel">{busy ? ANSWER.sending : ANSWER.submit}</span>
            <span className="qn-sendsub">{line}</span>
          </span>
        </button>
        <a href="#/inbox" className="row qn-cancel">
          <span className="mono nf qn-sendn">2</span>
          <span className="qn-cancellabel">{ANSWER.cancel}</span>
          <span className="qn-cancelsub">{ANSWER.cancelSub}</span>
        </a>
      </div>
    </>
  );
}
