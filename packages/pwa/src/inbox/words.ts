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
