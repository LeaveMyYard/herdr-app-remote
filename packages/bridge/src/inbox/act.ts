import { bridgeApi } from "@herdr-remote/protocol";
import type { VerbDetail } from "./plugin.js";

type Row = bridgeApi.InboxRow;
type Question = bridgeApi.InboxQuestion;
type Kind = bridgeApi.InboxActKind;

/** What a checked `act` runs: one `herdr-inbox app <verb>`, built from the bridge's own copy of the row. */
export interface Plan {
  verb: string;
  qids: number[];
  detail?: VerbDetail;
  clear?: boolean;
  /** The option labels, from the bridge's row, for the audit log. Never from the client. */
  label?: string;
  /** The `closed` word when the verb's result says the row is gone (`token: null`). */
  closes?: bridgeApi.Res["closed"];
}

export interface PlanError {
  code: "invalid" | "read_only";
  message: string;
}

const CLOSES: Partial<Record<Kind, bridgeApi.Res["closed"]>> = {
  "inbox.answer": "answered",
  "inbox.dismiss": "dismissed",
  "inbox.ack": "acked",
  "inbox.stop_showing": "hidden",
};

const isGroup = (r: Row): r is Extract<Row, { kind: "group" }> => r.kind === "group";

/**
 * Turns the phone's picks (option indices) into a Detail with the labels of the question the bridge published.
 * The verb normalises it again (`Detail::make`) and is the authority; this only refuses what can't be meant.
 */
export function detailFor(q: Question, d: bridgeApi.InboxDetailArg): { detail: VerbDetail; labels: string[] } | PlanError {
  const labels: string[] = [];
  for (const i of d.choices) {
    const opt = q.options[i];
    if (!opt) return { code: "invalid", message: "That option is not one of this question's." };
    // Two options can share a label; a label then means the first such option (app-commands-v1), so it counts once.
    if (labels.includes(opt.label)) return { code: "invalid", message: "That option was picked twice." };
    labels.push(opt.label);
  }
  if (!q.multi_select && labels.length > 1) return { code: "invalid", message: "This question takes one option." };
  const notes: Record<string, string> = {};
  for (const [k, note] of Object.entries(d.notes)) {
    const i = Number(k);
    // Notes only for picked options, as the popup keeps them; an empty one is dropped.
    if (!d.choices.includes(i) || note.trim() === "") continue;
    const label = q.options[i]?.label;
    if (label !== undefined) notes[label] = note;
  }
  return { detail: { choices: labels, notes, text: d.text }, labels };
}

const questionOf = (row: Extract<Row, { kind: "group" }>, id: number): Question | undefined => row.questions.find((q) => q.id === id);

/** Checks an act against the row the phone was shown, and says which verb to run. */
export function planAct(kind: Kind, args: Record<string, unknown>, row: Row): Plan | PlanError {
  const spec = bridgeApi.INBOX_ACTS[kind];
  if (row.kind !== spec.row) return { code: "invalid", message: "That action does not fit this row." };
  if (!row.actions.includes(spec.verb)) return { code: "read_only", message: "This row can only be read here." };
  const closes = CLOSES[kind];
  const base = { verb: spec.verb, ...(closes ? { closes } : {}) };
  if (!isGroup(row)) return { ...base, qids: [] };

  if (kind === "inbox.dismiss") {
    const q = args.question;
    if (q === undefined) return { ...base, qids: [] };
    if (typeof q !== "number" || !questionOf(row, q)) return { code: "invalid", message: "That question is not open in this group." };
    return { ...base, qids: [q] };
  }
  if (Array.isArray(args.questions)) {
    // Submit: the stored drafts of these questions, as the popup's Submit tab sends them.
    const ids = [...new Set(args.questions as number[])];
    const qs = ids.map((id) => questionOf(row, id));
    if (qs.some((q) => q === undefined)) return { code: "invalid", message: "That question is not open in this group." };
    const parts = (qs as Question[]).filter((q) => q.draft !== null && q.draft.choices.length > 0).map((q) => ({ id: q.id, labels: q.draft?.choices ?? [] }));
    const label = parts.length === 0 ? undefined : ids.length === 1 ? parts[0]?.labels.join(", ") : parts.map((p) => `Q${p.id}: ${p.labels.join(", ")}`).join("; ");
    return { ...base, qids: ids, ...(label ? { label } : {}) };
  }
  const id = args.question as number;
  const q = questionOf(row, id);
  if (!q) return { code: "invalid", message: "That question is not open in this group." };
  if (args.clear === true) return { ...base, qids: [id], clear: true };
  if (kind === "inbox.answer" && row.questions.length !== 1) {
    return { code: "invalid", message: "This group has more than one question: answer each, then submit." };
  }
  const made = detailFor(q, args.detail as bridgeApi.InboxDetailArg);
  if ("code" in made) return made;
  if (kind === "inbox.answer" && made.labels.length === 0 && (made.detail.text ?? "").trim() === "") {
    return { code: "invalid", message: "Pick an option or type an answer." };
  }
  const label = made.labels.length > 0 ? made.labels.join(", ") : undefined;
  return { ...base, qids: [id], detail: made.detail, ...(label ? { label } : {}) };
}
