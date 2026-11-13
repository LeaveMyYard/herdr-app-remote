// Native prompt answering (CV7, docs/chatview.md §3a): the screen parser, the T+S+V matcher, the answer actor and the
// one guarded `hc send --force` (other.ts).
export { parseScreen, screenLines, PROMPT_READ_LINES, type PromptRow, type ScreenPrompt, type ScreenRead } from "./screen.js";
export { matchPrompt, pendingTools, promptId, promptItem, cardRev, isReview, type Match, type PendingTool, type PromptKind } from "./match.js";
export { promptAnswerActor, PROMPT_ANSWER, type PromptAnswerActor, type PromptAnswerOptions, type PromptSource, type PublishedPrompt } from "./answer.js";
export { confirmOtherField, otherSendArgs, OTHER_CONFIRM_MAX_MS, type OtherFieldConfirmation } from "./other.js";
