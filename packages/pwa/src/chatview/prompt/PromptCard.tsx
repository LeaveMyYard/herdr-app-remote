// Native prompt cards (CV7, docs/chatview.md §3a, board design/PhoneChatView: states perm, ask1, askm, plan, changed).
//
// The card shows what the bridge published (`ChatItem` role `prompt`): option labels are the screen's, in its order,
// and every one is pressable. A press sends `prompt.answer {terminal, prompt_id, rev, choice}` once; the phone never
// retries and never names keys. A question answers only on its Answer button. After a refusal that means the prompt
// moved on (changed, gone) or an unknown effect, the card dims and offers no second press; the chat keeps that dimmed
// card and its refusal below it (PromptTail) even once the bridge stops publishing it.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import * as W from "./words";
import "../../styles/prompt-card.css";

export type PromptItem = Extract<bridgeApi.ChatItem, { role: "prompt" }>;

export interface PromptActResult {
  ok: boolean;
  code?: string;
  unknown_effect?: boolean;
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
      <Refusal code={k.code} unknown={k.unknown} agent={agent} desk={desk} />
    </>
  );
}

/** Forgets the refusals kept (tests). */
export function resetPromptTails(): void {
  kept.clear();
  notify();
}

// ---- the card ----

export function PromptCard({ item, terminal, agent, desk, act }: PromptCardProps) {
  const [pending, setPending] = useState(false);
  const [res, setRes] = useState<{ id: string; r: PromptActResult } | null>(null);
  // A new prompt is a new card: what was refused for the old one doesn't carry over.
  const mine = res?.id === item.prompt_id ? res.r : null;
  const dim = mine !== null && !mine.ok && (mine.unknown_effect === true || DIMS(mine.code));
  const done = mine?.ok === true;

  const answer = async (choice: bridgeApi.PromptChoice) => {
    if (pending || dim || done) return;
    setPending(true);
    let r: PromptActResult;
    try {
      r = await act("prompt.answer", { terminal, prompt_id: item.prompt_id, rev: item.rev, choice });
    } catch {
      r = { ok: false, code: "offline" };
    }
    setPending(false);
    setRes({ id: item.prompt_id, r });
    if (!r.ok && (r.unknown_effect === true || DIMS(r.code))) keep(terminal, { item, code: r.code, unknown: r.unknown_effect === true });
  };

  return (
    <>
      <Card item={item} agent={agent} desk={desk} dim={dim} pending={pending || done} onAnswer={(c) => void answer(c)} />
      {mine && !mine.ok ? <Refusal code={mine.code} unknown={mine.unknown_effect === true} agent={agent} desk={desk} /> : null}
    </>
  );
}

const DIMS = (code: string | undefined) => code !== undefined && W.DIMS.has(code);

function Refusal({ code, unknown, agent, desk }: { code: string | undefined; unknown: boolean; agent: string; desk: string }) {
  const [a, b] = W.refusal(code, unknown, { agent, desk });
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
  const [at, setAt] = useState(0);
  const [picks, setPicks] = useState<number[][]>(() => qs.map(() => []));
  const [other, setOther] = useState("");
  const q = qs[at];
  if (!q) return <Unparsed {...p} />;
  const mine = picks[at] ?? [];
  const last = at === qs.length - 1;
  const off = p.pending || p.dim;
  const toggle = (i: number) =>
    setPicks((all) => all.map((ps, j) => (j !== at ? ps : q.multi ? (ps.includes(i) ? ps.filter((x) => x !== i) : [...ps, i].sort((a, b) => a - b)) : [i])));
  const pickOne = (i: number) => {
    setOther("");
    toggle(i);
  };
  // The act carries one question's choice: a card with several (never published by the bridge yet, H0 did not
  // record them) steps through them here but can't send.
  const canSend = qs.length === 1 && (q.multi ? mine.length > 0 : mine.length === 1 || (q.other && other.trim() !== ""));
  const submit = () => {
    if (!last) return setAt(at + 1);
    if (!canSend) return;
    if (q.multi) p.onAnswer({ picks: mine });
    else if (mine.length === 1) p.onAnswer({ option: mine[0]! });
    else p.onAnswer({ other: other.trim() });
  };
  return (
    <Shell tone="accent" dim={p.dim} label={`Question from ${p.agent}`} chip={W.KIND.question} title={q.text}>
      {qs.length > 1 ? (
        <div className="row pc-steps">
          {qs.map((x, i) => (
            <span key={i} className="pc-step" data-on={i === at ? "" : undefined}>
              {`${i + 1} · ${x.header}`}
            </span>
          ))}
          <span className="f1" />
          <span className="pc-step-n">{W.step(at + 1, qs.length)}</span>
        </div>
      ) : null}
      <div className="col pc-options" role={q.multi ? "group" : "radiogroup"} aria-label={q.header || q.text}>
        {q.options.map((o, i) => {
          const on = mine.includes(i);
          return <Choice key={i} label={o.label} sub={o.description} selected={on} mark={q.multi ? <Check on={on} /> : <Radio on={on} />} disabled={off} onClick={() => (q.multi ? toggle(i) : pickOne(i))} />;
        })}
        {q.other ? (
          <input
            className="pc-other"
            type="text"
            placeholder={W.OTHER_PLACEHOLDER}
            value={other}
            maxLength={2000}
            disabled={off}
            aria-label={W.OTHER_PLACEHOLDER}
            onChange={(e) => {
              setOther(e.target.value.replace(/[\r\n\t]/g, " "));
              if (e.target.value !== "" && !q.multi) setPicks((all) => all.map((ps, j) => (j === at ? [] : ps)));
            }}
          />
        ) : null}
      </div>
      <div className="row pc-foot">
        <button type="button" className="row f1 pc-answer" disabled={off || (last ? !canSend : false)} onClick={submit}>
          {last ? W.ANSWER : W.nextPicked(mine.length)}
        </button>
        {last ? null : (
          <button type="button" className="row nf pc-skip" disabled={off} onClick={() => setAt(at + 1)}>
            {W.SKIP}
          </button>
        )}
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
