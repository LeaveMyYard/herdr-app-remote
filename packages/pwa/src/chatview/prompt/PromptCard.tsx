// Native prompt cards (CV7, docs/chatview.md §3a, board design/PhoneChatView: states perm, ask1, askm, plan, changed;
// CV9: a question card with several questions, one block each, then Submit).
//
// The card shows what the bridge published (`ChatItem` role `prompt`): option labels are the screen's, in its order,
// and every one is pressable. A press sends `prompt.answer {terminal, prompt_id, rev, choice}` once; the phone never
// retries and never names keys. A question answers only on its Answer (or, with several, Submit) button. After a refusal that means the prompt
// moved on (changed, gone) or an unknown effect, the card dims and offers no second press; the chat keeps that dimmed
// card and its refusal below it (PromptTail) even once the bridge stops publishing it.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { bridgeApi } from "@herdr-remote/protocol";
import * as W from "./words";
import "../../styles/prompt-card.css";

export type PromptItem = Extract<bridgeApi.ChatItem, { role: "prompt" }>;
type PromptQuestion = NonNullable<PromptItem["questions"]>[number];

export interface PromptActResult {
  ok: boolean;
  code?: string;
  unknown_effect?: boolean;
  /** The bridge's own words (CV9 `prompt_partial`: how far a walk got). */
  message?: string;
}
/** Sends one `prompt.answer` and resolves with the bridge's `res`. Never retried. */
export type PromptAct = (kind: "prompt.answer", args: Record<string, unknown>) => Promise<PromptActResult>;

export interface PromptCardProps {
  item: PromptItem;
  terminal: string;
  /** The agent's name ("Agent 1"). */
  agent: string;
  /** The desktop's name ("desk-1"). */
  desk: string;
  act: PromptAct;
}

/** Whether the chat shows an open prompt card: the composer is locked ("Answer the prompt above first"). */
export function hasOpenPrompt(items: readonly bridgeApi.ChatItem[]): boolean {
  return items.some((i) => i.role === "prompt" && i.state === "open");
}

// ---- refusals kept per terminal, so a card that left the topic still shows dimmed with its refusal ----

interface Kept {
  item: PromptItem;
  code: string | undefined;
  unknown: boolean;
  message?: string | undefined;
}
const kept = new Map<string, Kept>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
function keep(terminal: string, k: Kept | null): void {
  if (k) kept.set(terminal, k);
  else kept.delete(terminal);
  notify();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * The last refused card of a terminal once the bridge no longer publishes it (the prompt moved on): drawn dimmed with
 * its refusal at the end of the chat (ChatView's `tail`). Nothing while the topic still has that card, or once a
 * newer card shows.
 */
export function PromptTail({ terminal, items, agent, desk }: { terminal: string; items: readonly bridgeApi.ChatItem[]; agent: string; desk: string }) {
  const k = useSyncExternalStore(subscribe, () => kept.get(terminal));
  const cards = items.filter((i): i is PromptItem => i.role === "prompt");
  useEffect(() => {
    if (k && cards.some((c) => c.prompt_id !== k.item.prompt_id)) keep(terminal, null);
  }, [k, cards, terminal]);
  if (!k || cards.length > 0) return null;
  return (
    <>
      <Card item={k.item} agent={agent} desk={desk} dim pending={false} onAnswer={() => {}} />
      <Refusal code={k.code} unknown={k.unknown} message={k.message} agent={agent} desk={desk} />
    </>
  );
}

/** Keeps a refused card for a terminal as a press would (the demo board's `changed` state). */
export function seedPromptTail(terminal: string, item: PromptItem, code: string): void {
  keep(terminal, { item, code, unknown: false });
}

/** Forgets the refusals kept (tests). */
export function resetPromptTails(): void {
  kept.clear();
  notify();
}

// ---- the card ----

export function PromptCard({ item, terminal, agent, desk, act }: PromptCardProps) {
  const [pending, setPending] = useState(false);
  // A second tap before React re-renders must not send a second act: the ref is set synchronously.
  const sent = useRef<string | null>(null);
  const [res, setRes] = useState<{ id: string; r: PromptActResult } | null>(null);
  // A new prompt is a new card: what was refused for the old one doesn't carry over.
  const mine = res?.id === item.prompt_id ? res.r : null;
  const dim = mine !== null && !mine.ok && (mine.unknown_effect === true || DIMS(mine.code));
  const done = mine?.ok === true;

  const answer = async (choice: bridgeApi.PromptChoice) => {
    if (pending || dim || done || sent.current === item.prompt_id) return;
    sent.current = item.prompt_id;
    setPending(true);
    let r: PromptActResult;
    try {
      r = await act("prompt.answer", { terminal, prompt_id: item.prompt_id, rev: item.rev, choice });
    } catch {
      r = { ok: false, code: "offline" };
    }
    setPending(false);
    // A refusal that leaves the card live (busy, rate limited, forbidden…) lets the person try again by hand.
    if (!r.ok && !r.unknown_effect && !DIMS(r.code)) sent.current = null;
    setRes({ id: item.prompt_id, r });
    if (!r.ok && (r.unknown_effect === true || DIMS(r.code))) keep(terminal, { item, code: r.code, unknown: r.unknown_effect === true, message: r.message });
  };

  return (
    <>
      <Card item={item} agent={agent} desk={desk} dim={dim} pending={pending || done} onAnswer={(c) => void answer(c)} />
      {mine && !mine.ok ? <Refusal code={mine.code} unknown={mine.unknown_effect === true} message={mine.message} agent={agent} desk={desk} /> : null}
    </>
  );
}

const DIMS = (code: string | undefined) => code !== undefined && W.DIMS.has(code);

function Refusal({ code, unknown, message, agent, desk }: { code: string | undefined; unknown: boolean; message?: string | undefined; agent: string; desk: string }) {
  const [a, b] = W.refusal(code, unknown, { agent, desk, message });
  return (
    <div role="alert" className="row pc-refusal">
      <span className="nf pc-refusal-dot" aria-hidden="true" />
      <span className="col f1 pc-refusal-text">
        <span>{a}</span>
        {b ? <span className="pc-muted">{b}</span> : null}
      </span>
    </div>
  );
}

interface CardProps {
  item: PromptItem;
  agent: string;
  desk: string;
  dim: boolean;
  /** An answer is on its way (or was taken): nothing more can be pressed. */
  pending: boolean;
  onAnswer: (c: bridgeApi.PromptChoice) => void;
}

function Card(p: CardProps) {
  switch (p.item.kind) {
    case "permission":
      return <Permission {...p} />;
    case "question":
      return <Question {...p} />;
    case "plan":
      return <Plan {...p} />;
    case "other":
      return <Generic {...p} />;
    default:
      return <Unparsed {...p} />;
  }
}

function Shell({ tone, dim, label, chip, title, children }: { tone: "amber" | "accent"; dim: boolean; label: string; chip: string | null; title: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="col rel pc-card" data-tone={tone} data-dim={dim ? "" : undefined}>
      <span className="pc-edge" aria-hidden="true" />
      {chip !== null ? (
        <div className="row">
          <span className="mono pc-chip">{chip}</span>
        </div>
      ) : null}
      <div className="pc-title">{title}</div>
      {children}
    </section>
  );
}

/** A screen label "main · more" shows "more" as the sub line (the permission's auto-mode option). */
function split(label: string): [string, string | null] {
  const i = label.indexOf(" · ");
  return i > 0 ? [label.slice(0, i), label.slice(i + 3)] : [label, null];
}

function Choice({ label, sub, primary, selected, mark, disabled, onClick }: { label: string; sub?: string | null; primary?: boolean; selected?: boolean; mark?: ReactNode; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="row pc-choice"
      data-primary={primary ? "" : undefined}
      data-selected={selected ? "" : undefined}
      aria-pressed={selected === undefined ? undefined : selected}
      disabled={disabled}
      onClick={onClick}
    >
      {mark !== undefined ? <span className="nf row pc-mark">{mark}</span> : null}
      <span className="col f1 pc-choice-text">
        <span className="pc-choice-label">{label}</span>
        {sub ? <span className="pc-choice-sub">{sub}</span> : null}
      </span>
    </button>
  );
}

function Options({ item, pending, dim, onAnswer, subFor }: CardProps & { subFor: (label: string) => string | null }) {
  return (
    <div className="col pc-options">
      {item.options.map((o, i) => {
        const [label, more] = split(o.label);
        return <Choice key={i} label={label} sub={more ?? subFor(label)} primary={i === 0} disabled={pending || dim} onClick={() => onAnswer({ option: i })} />;
      })}
    </div>
  );
}

function Permission(p: CardProps) {
  const it = p.item;
  return (
    <Shell tone="amber" dim={p.dim} label="Permission request" chip={W.KIND.permission} title={W.PERMISSION_TITLE}>
      <div className="col pc-perm-body">
        <div className="row pc-perm-kind">
          <span className="mono pc-dot" aria-hidden="true">
            ⏺
          </span>
          {W.SHELL_COMMAND}
        </div>
        {it.summary ? <div className="mono pc-cmd">{it.summary}</div> : null}
      </div>
      <Options {...p} subFor={(l) => (l === "No" ? W.insteadOf(p.agent) : null)} />
    </Shell>
  );
}

/** `inline code` spans as code elements, the rest as text. */
function inline(s: string): ReactNode[] {
  return s.split("`").map((part, i) => (i % 2 === 1 ? <code key={i} className="mono pc-code">{part}</code> : part));
}

/** A plan's markdown as text: headings bold, numbered and bulleted lines as lists, the rest as lines. No HTML. */
function PlanText({ md }: { md: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>);
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ol || ul) {
      const ordered = ol !== null;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((ol ?? ul)![1]!);
      continue;
    }
    flush();
    if (line.trim() === "") continue;
    out.push(h ? <div key={out.length} className="pc-plan-h">{inline(h[1]!)}</div> : <p key={out.length}>{inline(line)}</p>);
  }
  flush();
  return <>{out}</>;
}

function Plan(p: CardProps) {
  const [open, setOpen] = useState(false);
  const md = p.item.plan_md;
  return (
    <Shell tone="amber" dim={p.dim} label="Plan approval" chip={W.KIND.plan} title={W.PLAN_TITLE}>
      {md !== undefined ? (
        <>
          <div className="rel pc-plan" data-open={open ? "" : undefined}>
            <PlanText md={md} />
            {open ? null : <div className="pc-plan-fade" aria-hidden="true" />}
          </div>
          {open ? null : (
            <button type="button" className="row pc-show" onClick={() => setOpen(true)}>
              {W.SHOW_PLAN}
            </button>
          )}
        </>
      ) : null}
      <Options {...p} subFor={(l) => (l.startsWith("No, keep planning") ? W.planChange(p.agent) : null)} />
    </Shell>
  );
}

function Radio({ on }: { on: boolean }) {
  return <span className="pc-radio" data-on={on ? "" : undefined} aria-hidden="true" />;
}
function Check({ on }: { on: boolean }) {
  return (
    <span className="pc-check" data-on={on ? "" : undefined} aria-hidden="true">
      {on ? "✓" : ""}
    </span>
  );
}

function Question(p: CardProps) {
  const qs = p.item.questions ?? [];
  if (qs.length > 1) return <Several {...p} />;
  return <One {...p} />;
}

/** A question's options and its Other field (when the card offers it): the block both card layouts share. */
function QuestionBody({ q, picks, other, off, onPick, onOther }: { q: PromptQuestion; picks: number[]; other: string; off: boolean; onPick: (i: number) => void; onOther: (text: string) => void }) {
  return (
    <div className="col pc-options" role={q.multi ? "group" : "radiogroup"} aria-label={q.header || q.text}>
      {q.options.map((o, i) => {
        const on = picks.includes(i);
        return <Choice key={i} label={o.label} sub={o.description} selected={on} mark={q.multi ? <Check on={on} /> : <Radio on={on} />} disabled={off} onClick={() => onPick(i)} />;
      })}
      {/* Other on a multi-select is never offered (the bridge refuses it: H0 manifest, multiSelectPlusOther). */}
      {q.other && !q.multi ? (
        <input
          className="pc-other"
          type="text"
          placeholder={W.OTHER_PLACEHOLDER}
          value={other}
          maxLength={2000}
          disabled={off}
          aria-label={W.OTHER_PLACEHOLDER}
          onChange={(e) => onOther(e.target.value.replace(/[\r\n\t]/g, " "))}
        />
      ) : null}
    </div>
  );
}

/** Other text the bridge would take: not blank, and not read by the composer as a command (!, /, #). */
const otherOk = (s: string) => s.trim() !== "" && !bridgeApi.PROMPT_OTHER_COMMAND.test(s);

/** The picks after a tap on option `i`: a multi-select toggles it, a single-select picks it alone. */
const tapped = (q: PromptQuestion, ps: number[], i: number) => (q.multi ? (ps.includes(i) ? ps.filter((x) => x !== i) : [...ps, i].sort((a, b) => a - b)) : [i]);

/** One question (CV7): answers on its Answer button. */
function One(p: CardProps) {
  const q = p.item.questions![0]!;
  const [picks, setPicks] = useState<number[]>([]);
  const [other, setOther] = useState("");
  const off = p.pending || p.dim;
  const canSend = q.multi ? picks.length > 0 : picks.length === 1 || (q.other && otherOk(other));
  const submit = () => {
    if (!canSend) return;
    if (q.multi) p.onAnswer({ picks });
    else if (picks.length === 1) p.onAnswer({ option: picks[0]! });
    else p.onAnswer({ other: other.trim() });
  };
  return (
    <Shell tone="accent" dim={p.dim} label={`Question from ${p.agent}`} chip={W.KIND.question} title={q.text}>
      <QuestionBody
        q={q}
        picks={picks}
        other={other}
        off={off}
        onPick={(i) => {
          setOther("");
          setPicks((ps) => tapped(q, ps, i));
        }}
        onOther={(t) => {
          setOther(t);
          if (t !== "") setPicks([]);
        }}
      />
      <div className="row pc-foot">
        <button type="button" className="row f1 pc-answer" disabled={off || !canSend} onClick={submit}>
          {W.ANSWER}
        </button>
      </div>
    </Shell>
  );
}

/**
 * Several questions (CV9): one block per question, then Submit, which sends every answer at once (`{answers}`); the
 * bridge walks Claude Code's tabs. A deviation from the board's askm stepper (named in the PR): the first block is the
 * board's, with only its own step chip.
 */
function Several(p: CardProps) {
  const qs = p.item.questions!;
  const [picks, setPicks] = useState<number[][]>(() => qs.map(() => []));
  const [others, setOthers] = useState<string[]>(() => qs.map(() => ""));
  const off = p.pending || p.dim;
  const answer = (i: number): bridgeApi.PromptQuestionAnswer | null => {
    const q = qs[i]!;
    const ps = picks[i] ?? [];
    if (q.multi) return ps.length > 0 ? { picks: ps } : null;
    if (ps.length === 1) return { option: ps[0]! };
    const o = others[i] ?? "";
    return q.other && otherOk(o) ? { other: o.trim() } : null;
  };
  const answers = qs.map((_, i) => answer(i));
  const done = answers.filter((a) => a !== null).length;
  const ready = done === qs.length;
  const set = <T,>(all: T[], i: number, v: T) => all.map((x, j) => (j === i ? v : x));
  return (
    <Shell tone="accent" dim={p.dim} label={`Question from ${p.agent}`} chip={W.KIND.question} title={qs[0]!.text}>
      {qs.map((q, i) => (
        <div key={i} className="col pc-q" data-next={i > 0 ? "" : undefined}>
          {i > 0 ? <div className="pc-title">{q.text}</div> : null}
          <div className="row pc-steps">
            <span className="pc-step" data-on="">
              {`${i + 1} · ${q.header}`}
            </span>
            <span className="f1" />
            <span className="pc-step-n">{W.step(i + 1, qs.length)}</span>
          </div>
          <QuestionBody
            q={q}
            picks={picks[i] ?? []}
            other={others[i] ?? ""}
            off={off}
            onPick={(j) => {
              setOthers((all) => set(all, i, ""));
              setPicks((all) => set(all, i, tapped(q, all[i] ?? [], j)));
            }}
            onOther={(t) => {
              setOthers((all) => set(all, i, t));
              if (t !== "") setPicks((all) => set(all, i, []));
            }}
          />
        </div>
      ))}
      <div className="row pc-foot">
        <button type="button" className="row f1 pc-answer" disabled={off || !ready} onClick={() => ready && p.onAnswer({ answers: answers as bridgeApi.PromptQuestionAnswer[] })}>
          {ready ? W.SUBMIT : W.answeredOf(done, qs.length)}
        </button>
      </div>
    </Shell>
  );
}

function Generic(p: CardProps) {
  return (
    <Shell tone="amber" dim={p.dim} label={W.asks(p.agent)} chip={null} title={W.asks(p.agent)}>
      {p.item.title ? <div className="pc-generic-title">{p.item.title}</div> : null}
      <Options {...p} subFor={() => null} />
    </Shell>
  );
}

function Unparsed(p: CardProps) {
  const lines = p.item.screen_lines ?? [];
  return (
    <Shell tone="amber" dim={p.dim} label={W.asks(p.agent)} chip={null} title={W.asks(p.agent)}>
      {lines.length > 0 ? <pre className="mono pc-screen">{lines.join("\n")}</pre> : null}
      <div className="pc-desk">{W.answerOnDesk(p.desk)}</div>
    </Shell>
  );
}
