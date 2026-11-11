export type TabId = "agents" | "swarm" | "inbox" | "chat" | "usage";

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "swarm", label: "Swarm" },
  { id: "inbox", label: "Inbox" },
  { id: "chat", label: "Chat" },
  { id: "usage", label: "Usage" },
];

export interface Space {
  id: string;
  name: string;
  /** One-letter avatar. */
  letter: string;
  /** Avatar background. */
  color: string;
  branch?: string;
  /** Commits behind upstream, shown as a down-arrow count. */
  behind?: number;
  detached?: boolean;
  selected?: boolean;
}

export type AgentStatus = "needs-you" | "working" | "done" | "idle";

export interface BasicAgent {
  id: string;
  name: string;
  harness: "claude" | "codex";
  tab: string;
  /** Pre-formatted age, for example "26m". */
  age: string;
  status: AgentStatus;
  spaceId: string;
}

export type PluginState = "ready" | "missing" | "outdated" | "error";

export interface PluginRow {
  name: string;
  state: PluginState;
  version?: string;
}

/** Tab-bar badges: the label is rendered as-is (for example "?2"). */
export type TabBadges = Partial<Record<TabId, string>>;

export type ConnectionStatus = "online" | "connecting" | "offline" | "stale";

export interface Connection {
  status: ConnectionStatus;
  /** For "stale": how old the data is, pre-formatted ("2m"). */
  age?: string;
}

export interface HostInfo {
  name: string;
}
