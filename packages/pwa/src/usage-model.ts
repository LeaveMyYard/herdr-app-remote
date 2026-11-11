// Pure view logic for the Usage screen, ported from agent-usage's `mods/agent-usage/main.js` so the phone
// and the desktop panel group, name and word things the same way.
import type { bridgeApi } from "@herdr-remote/protocol";

export type UsageProvider = bridgeApi.UsageProvider;
export type UsageWindow = bridgeApi.UsageWindow;

export interface UsageRow extends UsageProvider {
  /** Labels of entries folded into this one (the same account signed in elsewhere). */
  alsoIn: string[];
}

export interface UsageGroup {
  family: string;
  members: UsageRow[];
}

/** Provider families as usagebar names them (main.js `FAMILIES`); others get their id with a capital. */
const FAMILY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  agy: "Antigravity",
  kilo: "Kilo Code",
};

export function familyName(family: string, fallback: string): string {
  return FAMILY_NAMES[family] ?? (fallback || family);
}

/**
 * The entries shown as rows, grouped by family. Providers with nothing on this machine are hidden, and an
 * entry for an account already listed folds into that account's row (`alsoIn`).
 */
export function groupProviders(providers: readonly UsageProvider[]): UsageGroup[] {
  const shown = providers.filter((p) => p.inUse !== false);
  const alsoIn = new Map<string, string[]>();
  for (const p of shown) {
    if (!p.sameAccountAs) continue;
    alsoIn.set(p.sameAccountAs, [...(alsoIn.get(p.sameAccountAs) ?? []), p.profileLabel || p.label]);
  }
  const groups: UsageGroup[] = [];
  for (const p of shown.filter((x) => !x.sameAccountAs)) {
    const last = groups[groups.length - 1];
    const row: UsageRow = { ...p, alsoIn: alsoIn.get(p.providerId) ?? [] };
    if (last && last.family === p.family) last.members.push(row);
    else groups.push({ family: p.family, members: [row] });
  }
  return groups;
}

export function groupName(g: UsageGroup): string {
  const first = g.members[0] as UsageRow;
  return g.members.length > 1 ? first.groupLabel || familyName(g.family, first.label) : familyName(g.family, first.label);
}

/** The right-hand hint of an account: its identity and the other places it is signed in. */
export function hint(p: UsageRow): string {
  return [p.identity, ...p.alsoIn.map((label) => `also ${label}`)].filter(Boolean).join(" · ");
}

export function accountName(p: UsageRow): string {
  return p.profileLabel || p.accountLabel || p.label;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** Local HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The small line under an account's windows. */
export function metaLine(p: UsageRow, now: number): string {
  const source = p.source && p.source !== "none" ? p.source : "no source";
  if (p.status === "stale") return [`stale ~${p.staleMinutes ?? 0}m ago`, source].join(" · ");
  if (p.windows.length > 0 && p.fetchedAtMs != null) return [source, `updated ${ago(p.fetchedAtMs, now)}`].join(" · ");
  return source;
}

export const BAND_COLOR: Record<string, string> = { high: "var(--t-ansi2)", mid: "var(--t-ansi3)", low: "var(--t-ansi1)" };

export function bandColor(band: string): string {
  return BAND_COLOR[band] ?? "var(--t-muted)";
}

/** Bar fill as a percentage with one decimal, clamped. */
export function fillPercent(barFill: number): number {
  return Math.round(Math.max(0, Math.min(1, barFill)) * 1000) / 10;
}

/** Fixed sentences for the bridge's error codes; the bridge never forwards CLI output. */
export const ERROR_TEXT: Record<bridgeApi.UsageError, string> = {
  unavailable: "usagebar could not be run on the computer",
  timeout: "usagebar took too long to answer",
  failed: "usagebar reported an error",
  bad_output: "usagebar printed something unexpected",
  unsupported: "usagebar is newer than this app understands",
};
