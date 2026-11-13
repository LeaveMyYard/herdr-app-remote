// The prompt cards as the PhoneChatView board draws them (states perm, ask1, askm, plan, changed), for the visual
// harness only (`?fixture=prompt-cards&state=<state>`). Fake data only. Each card sits where the board puts it, so
// the card's own region of the board render can be compared; the rest of the chat screen is CV4's.
import type { bridgeApi } from "@herdr-remote/protocol";
import { PromptCard, type PromptAct, type PromptItem } from "./PromptCard";

const base = { id: "prompt-0", at: null, rev: "rev-1", state: "open" as const };
const ID = (n: number) => String(n).repeat(64).slice(0, 64);

export const PROMPT_FIXTURES: Record<string, { top: number; item: PromptItem; result?: Awaited<ReturnType<PromptAct>> }> = {
  perm: {
    top: 409.55,
    item: { ...base, role: "prompt", prompt_id: ID(1), kind: "permission", title: "Do you want to proceed?", summary: "cargo test -p parser", options: [{ label: "Yes" }, { label: "Yes, and don’t ask again for: cargo test *" }, { label: "No" }] },
  },
  ask1: {
    top: 358.4,
    item: {
      ...base,
      role: "prompt",
      prompt_id: ID(2),
      kind: "question",
      title: "Question Text 345: pick one option.",
      questions: [
        {
          text: "Question Text 345: pick one option.",
          header: "Area",
          multi: false,
          other: true,
          options: [
            { label: "Option A", description: "First test choice" },
            { label: "Option B", description: "Second test choice" },
            { label: "Option C", description: "Third test choice" },
          ],
        },
      ],
      options: [{ label: "Option A" }, { label: "Option B" }, { label: "Option C" }],
    },
  },
  askm: {
    top: 325.55,
    item: {
      ...base,
      role: "prompt",
      prompt_id: ID(3),
      kind: "question",
      title: "Question Text 346: pick all that apply.",
      questions: [
        {
          text: "Question Text 346: pick all that apply.",
          header: "Area",
          multi: true,
          other: true,
          options: [
            { label: "Option A", description: "First test choice" },
            { label: "Option B", description: "Second test choice" },
            { label: "Option C", description: "Third test choice" },
          ],
        },
        { text: "Question Text 347: pick the order.", header: "Order", multi: false, other: true, options: [{ label: "Option A", description: null }] },
      ],
      options: [{ label: "Option A" }, { label: "Option B" }, { label: "Option C" }],
    },
  },
  plan: {
    top: 299.4,
    item: {
      ...base,
      role: "prompt",
      prompt_id: ID(4),
      kind: "plan",
      title: "Would you like to proceed?",
      plan_md: "# Plan: Parser rewrite\n\n1. Split `parse.rs` into three passes\n2. Keep the old entry point as a wrapper\n3. Add tests for empty input\n4. Update the docs",
      options: [{ label: "Yes, and use auto mode" }, { label: "Yes, manually approve edits" }, { label: "No, keep planning" }],
    },
  },
  changed: {
    top: 332.4,
    item: { ...base, role: "prompt", prompt_id: ID(5), kind: "permission", title: "Do you want to proceed?", summary: "cargo test -p parser", options: [{ label: "Yes" }, { label: "Yes, and don’t ask again for: cargo test *" }, { label: "No" }] },
    result: { ok: false, code: "prompt_changed" },
  },
};

/** One card on the chat's background, where the board puts it. */
export function PromptCardsBoard({ state, top }: { state: string | null; top?: number }) {
  const f = PROMPT_FIXTURES[state ?? "perm"] ?? PROMPT_FIXTURES.perm!;
  const act: PromptAct = () => Promise.resolve(f.result ?? { ok: true });
  return (
    <div className="hd ph">
      <div className="col" style={{ position: "absolute", left: 16, right: 16, top: top ?? f.top, gap: 14 }}>
        <PromptCard item={f.item as bridgeApi.ChatItem & PromptItem} terminal="t1" agent="Agent 1" desk="desk-1" act={act} />
      </div>
    </div>
  );
}
