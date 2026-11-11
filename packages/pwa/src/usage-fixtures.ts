// Fake data for the Usage screen (design boards). Replaced by the `usage` topic once the bridge client lands.
import type { bridgeApi } from "@herdr-remote/protocol";

/** 11:15 UTC, the time the PhoneUsage board shows. */
export const DEMO_UPDATED_AT = 1_793_704_500_000;
const MIN = 60_000;

const win = (over: Partial<bridgeApi.UsageWindow>): bridgeApi.UsageWindow => ({
  slot: "primary",
  tag: "7d",
  windowMinutes: 10080,
  displayPercent: 0,
  barFill: 0,
  band: "low",
  resetIn: "",
  ...over,
});

export const demoUsage: bridgeApi.UsageTopic = {
  filter: "all",
  updatedAtMs: DEMO_UPDATED_AT,
  report: {
    version: 1,
    generatedAtMs: DEMO_UPDATED_AT,
    filter: "all",
    limitPercent: "remaining",
    providers: [
      {
        providerId: "claude-1",
        family: "claude",
        label: "claude-1",
        groupLabel: "Claude",
        profileLabel: "claude-1",
        identity: "user-1@example.com",
        source: "claude statusLine cache",
        fetchedAtMs: DEMO_UPDATED_AT,
        status: "ok",
        windows: [win({ displayPercent: 15, barFill: 0.15, resetIn: "2d 12h", runOut: { text: "empty in ~18h 56m" } })],
      },
      {
        providerId: "claude-2",
        family: "claude",
        label: "claude-2",
        groupLabel: "Claude",
        profileLabel: "claude-2",
        identity: "user-2@example.com",
        source: "claude statusLine cache via claude",
        fetchedAtMs: DEMO_UPDATED_AT - MIN,
        status: "ok",
        windows: [win({ displayPercent: 99, barFill: 0.99, band: "high", resetIn: "6d 20h" })],
      },
      {
        providerId: "claude-2-dup",
        family: "claude",
        label: "claude",
        profileLabel: "claude",
        identity: "user-2@example.com",
        sameAccountAs: "claude-2",
        status: "ok",
        windows: [],
      },
      {
        providerId: "claude-3",
        family: "claude",
        label: "claude-3",
        groupLabel: "Claude",
        profileLabel: "claude-3",
        identity: "user-3@example.com",
        source: "claude statusLine cache",
        fetchedAtMs: DEMO_UPDATED_AT - 1315 * MIN,
        status: "stale",
        staleMinutes: 1315,
        windows: [win({ displayPercent: 0, barFill: 0, resetIn: "1d 9h", runOut: { text: "empty in ~<1m" } })],
      },
      {
        providerId: "codex",
        family: "codex",
        label: "codex",
        identity: "~/.codex",
        planType: "Pro",
        source: "codex rollout",
        fetchedAtMs: DEMO_UPDATED_AT - 840 * MIN,
        status: "stale",
        staleMinutes: 840,
        windows: [win({ displayPercent: 100, barFill: 1, band: "high" })],
      },
    ],
  },
};

export const demoUsageNow = DEMO_UPDATED_AT + 5_000;

export interface UsageScenario {
  name: string;
  /** `plugins.usage.state`. */
  state: bridgeApi.PluginState;
  topic: bridgeApi.UsageTopic | undefined;
  /** Use the fixed clock of the boards. */
  fixedNow: boolean;
}

const SCENARIOS: Record<string, UsageScenario> = {
  ready: { name: "ready", state: "ready", topic: demoUsage, fixedNow: true },
  missing: { name: "missing", state: "missing", topic: undefined, fixedNow: true },
  too_old: { name: "too_old", state: "too_old", topic: undefined, fixedNow: true },
  broken: { name: "broken", state: "broken", topic: undefined, fixedNow: true },
  error: { name: "error", state: "ready", topic: { ...demoUsage, error: "timeout" }, fixedNow: true },
  loading: { name: "loading", state: "ready", topic: undefined, fixedNow: true },
  empty: { name: "empty", state: "ready", topic: { filter: "open-panes", updatedAtMs: DEMO_UPDATED_AT, report: { ...(demoUsage.report as bridgeApi.UsageReport), providers: [] } }, fixedNow: true },
};

/** The scenario for `#/usage/<name>`; anything else is the board's data. */
export function usageScenario(name: string | undefined): UsageScenario {
  return SCENARIOS[name ?? ""] ?? (SCENARIOS.ready as UsageScenario);
}
