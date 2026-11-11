// Every visible string the design (PhoneInbox) does not draw. Each one is copied from the herdr-inbox plugin's
// own overlay (app/mods/herdr-inbox/*), the source named beside it: same product, same words. Nothing here is new copy.
import type { bridgeApi } from "@herdr-remote/protocol";

type Problem = NonNullable<bridgeApi.InboxTopic["problem"]>;

/** view-rows.js:35 */
export const CUT = "This text was cut to fit the feed.";
/** view.js:16 (the problem word is the reader's own: missing, unreadable, unsupported, not-ok) */
export const staleWords = (problem: Problem | null): string =>
  problem ? `The inbox feed can't be read (${problem}): this is the last good copy. It may be out of date.` : "The inbox feed is out of date: this may not be the inbox as it is now.";
/** view.js:21-22 (without the overlay's "Press o to open them.", a key the phone has not) */
export const leftOut = (counts: readonly string[]): string => `Left out of this list: ${counts.join(", ")}.`;
export const noId = (n: number): string => `${n} of those have no id here: the herdr popup has them.`;
/** view.js:75 */
export const EMPTY = "No open questions";
/** view.js:89 and main.js:24 */
export const UNAVAILABLE = "Inbox unavailable";
export const noFeed = (problem: Problem | null): string => `There is no inbox feed to read (${problem ?? "missing"}).`;
/** main.js:13-15 (WHY) and main.js:23 (the default wait) */
export const PLUGIN_WHY = {
  missing: "The install record is missing or unreadable. Run scripts/app-install from the plugin.",
  too_old: "The plugin has no app commands: it runs Python, it has no Rust binary, or that binary is older than this mod.",
  broken: "Waiting for the inbox feed…",
} as const;
/** view-text.js:30 (the summary row's second line is "d hides them; check_answers still has them"; "d" is a key the phone has not) */
export const goneTitle = (n: number): string => `${n} answers whose agents are gone`;
export const GONE_SUB = "check_answers still has them";
/** view-text.js:44, 57, 64 */
export const answerNotDelivered = (qid: number): string => `Answer to Q${qid} not delivered`;
export const outboxTitle = (action: string, qid: number): string => `${action} for Q${qid}`;
export const READ_ONLY = "read-only";

/**
 * Answering (S11). The board's own words (design/PhoneQuestion, PhoneReview, PhoneInbox) and the few the boards
 * do not draw. `DISMISS*` belong to an undrawn control, provisional until the design has one (conductor, S11).
 */
export const ANSWER = {
  other: "Something else…",
  otherSub: "Type your own answer.",
  chat: "Chat about this",
  chatSub: "Go to the agent",
  note: "Note for the agent",
  notePlaceholder: "Add a note for the agent…",
  yourAnswer: "Your answer",
  yourAnswerPlaceholder: "Type your answer…",
  later: "Later",
  next: "Next ⏎",
  send: "Send ⏎",
  sending: "Sending…",
  pickFirst: "Pick an option or type an answer.",
  review: "Review your answers",
  submit: "Submit answers ✓",
  submitTab: "Submit ✓",
  cancel: "Cancel",
  cancelSub: "Sends nothing",
  noAnswer: "No answer yet: it stays open",
  nothingYet: "Nothing to send yet",
  answerOneFirst: "Answer at least one question first.",
  gone: "This group is no longer open.",
  backToInbox: "Back to the inbox",
  DISMISS: "Dismiss",
  DISMISS_CONFIRM: "Dismiss all?",
  DISMISS_LABEL: "Dismiss: tap again to close every question in this group",
  seen: "Seen",
  stopShowing: "Stop showing",
  needsNoAnswer: (title: string): string => `${title} needs no answer.`,
  sends: (n: number, of: number, open: readonly string[]): string =>
    `Sends ${n} of ${of}${open.length > 0 ? ` · ${open.join(", ")} ${open.length === 1 ? "stays" : "stay"} open` : ""}`,
} as const;

/** What the phone says for a result when the bridge sent no words of its own. */
export const RESULT = {
  offline: "Not connected to the desktop. Nothing was sent.",
  unknown: "The result is unknown. It may or may not have been done, and it was not repeated. Check the row after this reload.",
  done: "Done.",
  stale: "This changed, look again. Nothing was sent.",
  forbidden: "This phone may not answer the inbox. Turn on “Answer the inbox” for it on the desktop.",
  paused: "Remote access is paused on the desktop.",
  failed: (code: string): string => `Not done (${code}). Nothing changed.`,
} as const;
