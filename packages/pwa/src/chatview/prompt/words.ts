// The prompt cards' words (CV7): docs/chatview.md §11 and design/COPY.md ("Card: …", "Prompt: …"). Nothing here is
// new copy: the refusal lines for forbidden, rate_limited and audit_unavailable were decided by the main session
// (operator-delegated copy, 2026-11-13) and added to COPY.md with this slice.
import { RESULT } from "../../inbox/words";

export const KIND = { permission: "PERMISSION", question: "QUESTION", plan: "PLAN" } as const;
export const PERMISSION_TITLE = "Allow this command?";
export const SHELL_COMMAND = "Shell command";
export const insteadOf = (agent: string): string => `Then tell ${agent} what to do instead`;
export const PLAN_TITLE = "Ready to start?";
export const SHOW_PLAN = "Show the whole plan ›";
export const planChange = (agent: string): string => `Tell ${agent} what to change`;
export const OTHER_PLACEHOLDER = "Other: type your own answer…";
export const ANSWER = "Answer";
export const step = (i: number, n: number): string => `${i} of ${n}`;
// CV9 (operator-delegated copy, COPY.md "Card: questions"): the button under a card with several questions.
export const SUBMIT = "Submit";
export const answeredOf = (done: number, n: number): string => `${done} of ${n} answered`;
export const asks = (agent: string): string => `${agent} asks`;
export const answerOnDesk = (desk: string): string => `Answer it on ${desk}.`;
export const LOCKED = "Answer the prompt above first";

/** What the phone says for a refused or unknown answer: a line, and an optional second one. */
export function refusal(code: string | undefined, unknown: boolean, o: { agent: string; desk: string }): [string, string?] {
  if (unknown) return [`${o.agent} may have got your answer. Look before you answer again.`];
  switch (code) {
    case "prompt_changed":
    case "bad_choice":
      return ["The prompt changed. Look again.", "Nothing was pressed."];
    case "prompt_moved":
      // Keys were pressed (phase A) before the change was seen: nothing was answered (main, review round 1).
      return ["The prompt changed. Look again.", "Nothing was answered."];
    case "prompt_gone":
      return [`Already answered on ${o.desk}.`];
    case "busy":
      return [`${o.desk} is typing. Try again in a moment.`];
    case "forbidden":
      return ["Answering prompts is off for this phone.", `Turn it on in Remote on ${o.desk}.`];
    case "rate_limited":
      return ["Too many answers. Wait a moment and try again."];
    case "audit_unavailable":
      return ["Not sent: the activity log can't be written. Nothing changed."];
    case "offline":
      return [RESULT.offline];
    default:
      return [RESULT.failed(code ?? "failed")];
  }
}

/** Results after which the card is dimmed and never offers a second press (§3a.4: nothing is pressed again by itself). */
export const DIMS: ReadonlySet<string> = new Set(["prompt_changed", "prompt_moved", "prompt_gone", "bad_choice"]);
