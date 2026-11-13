// The chat view's wording (docs/chatview.md §11, design/COPY.md "Chat view"). Nothing here is invented: the
// progressive forms of the tool rows ("Reading 2 files") and the failed row of a non-shell kind are derived from it.
import type { bridgeApi } from "@herdr-remote/protocol";

type ToolKind = bridgeApi.ToolKind;
const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;

/** "Ran 2 shell commands", or while running "Running 2 shell commands". */
export function toolsLabel(kind: ToolKind, count: number, running: boolean): string {
  switch (kind) {
    case "shell":
      return `${running ? "Running" : "Ran"} ${n(count, "shell command", "shell commands")}`;
    case "read":
      return `${running ? "Reading" : "Read"} ${n(count, "file", "files")}`;
    case "edit":
      return `${running ? "Editing" : "Edited"} ${n(count, "file", "files")}`;
    case "search":
      return `${running ? "Searching" : "Searched"} ${n(count, "time", "times")}`;
    case "subagent":
      return `${running ? "Running" : "Ran"} ${n(count, "subagent", "subagents")}`;
    case "other":
      return `${running ? "Using" : "Used"} ${n(count, "tool", "tools")}`;
  }
}

/** "1 command failed" (the amber row). */
export function failedLabel(kind: ToolKind, failed: number): string {
  return kind === "shell" ? `${failed} ${failed === 1 ? "command" : "commands"} failed` : `${failed} ${failed === 1 ? "call" : "calls"} failed`;
}

export const WORKING = "Working";
export const WAITING = "Waiting for you";
export const LOADING_OLDER = "Loading earlier messages…";
export const SHOW_OLDER = "Show earlier messages";
export const EMPTY_TITLE = "No messages yet";
export const emptyBody = (folder: string) => `New session in ${folder}. What you send appears here.`;
export const COMPACTED = "Earlier messages were summarised";
export const CUT = "Cut here";
export const ASKED = "Asked you a question";
export const jumpLabel = (fresh: number) => (fresh > 0 ? `${fresh} new` : "Latest");
export const composerPlaceholder = (agent: string) => `Message ${agent}…`;
export const LOCKED = "Answer the prompt above first";
export const TYPING_OFF = "Read-only here. Typing is off for this phone.";

/** "1m 12s", "12s", "1h 2m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (x: number) => String(x).padStart(2, "0");

/** "Today 21:02", "Yesterday 18:40", else "12 Nov 18:40"; the phone's local time. */
export function dayLabel(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const t = new Date(nowMs);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86_400_000);
  if (diff === 0) return `Today ${clock}`;
  if (diff === 1) return `Yesterday ${clock}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
}

export type NoticeKind = "codex" | "no_panorama" | "no_profiles" | "no_binding" | "reader_failed" | "forbidden";

export function noticeWords(kind: NoticeKind, host: string): { title: string; body: string } {
  switch (kind) {
    case "codex":
      return { title: "No chat view for Codex yet", body: "This is its terminal, as before." };
    case "no_panorama":
      return { title: "Chat view needs herdr-panorama", body: "Showing the terminal." };
    case "no_profiles":
      return { title: "Chat view needs herdr-agent-usage", body: "Showing the terminal." };
    case "no_binding":
      return { title: "Can't match this agent to its history", body: "Showing the terminal." };
    case "reader_failed":
      return { title: "Can't read this agent's history right now", body: "Showing the terminal." };
    case "forbidden":
      return { title: "Chat history is off for this phone", body: `Turn it on in Remote on ${host}.` };
  }
}
