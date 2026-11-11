// Fake data only (design boards). Replaced by bridge data from S4/S5 onwards.
import type { BasicAgent, HostInfo, PluginRow, Space, TabBadges } from "./model";

export const host: HostInfo = { name: "desk-1" };

export const spaces: Space[] = [
  { id: "sp-1", name: "Project Alpha", letter: "P", color: "#22a99a", branch: "alpha-core", behind: 12, selected: true },
  { id: "sp-2", name: "Project Beta", letter: "P", color: "#e3814f", detached: true },
  { id: "sp-3", name: "Sandbox", letter: "S", color: "#5b8def" },
];

export const agents: BasicAgent[] = [
  { id: "a-1", name: "Agent 1", harness: "claude", tab: "tab 2", age: "26m", status: "needs-you", spaceId: "sp-1" },
  { id: "a-2", name: "Agent 2", harness: "claude", tab: "tab 3", age: "9m", status: "working", spaceId: "sp-1" },
  { id: "a-3", name: "Agent 3", harness: "codex", tab: "tab 1", age: "4m", status: "working", spaceId: "sp-2" },
  { id: "a-4", name: "Agent 4", harness: "claude", tab: "tab 3", age: "1h", status: "done", spaceId: "sp-2" },
];

export const plugins: PluginRow[] = [
  { name: "herdr-panorama", state: "ready", version: "0.4" },
  { name: "herdr-inbox", state: "ready", version: "0.10" },
  { name: "agent-usage", state: "missing" },
];

export const badges: TabBadges = { inbox: "?2" };

/** Placeholder from the board; the real command comes from the plugin probe (S7). */
export const usageInstallCommand = "[AGENT-USAGE INSTALL COMMAND]";
