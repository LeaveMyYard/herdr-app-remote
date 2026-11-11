import type { bridgeApi } from "@herdr-remote/protocol";

export type TabId = "agents" | "swarm" | "inbox" | "chat" | "usage";

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "swarm", label: "Swarm" },
  { id: "inbox", label: "Inbox" },
  { id: "chat", label: "Chat" },
  { id: "usage", label: "Usage" },
];

/** A state tile: a status code and, for the finished tile or a needs tile, a count. */
export interface TileSpec {
  code: bridgeApi.AgentCode;
  count?: number | undefined;
}

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
  /** Needs-you and working tiles on the space row (Agents with herdr-panorama only). */
  tiles?: TileSpec[];
}

export type AgentStatus = "needs-you" | "working" | "done" | "idle";

export interface BasicAgent {
  id: string;
  name: string;
  /** `claude` and `codex` have their own icon; any other harness gets the generic one. */
  harness: string;
  /** Empty when unknown (the host topic carries no tab number). */
  tab: string;
  /** Pre-formatted age, for example "26m"; empty when unknown. */
  age: string;
  status: AgentStatus;
  spaceId: string;
}

export type PluginState = bridgeApi.PluginState;

export interface PluginRow {
  name: string;
  state: PluginState;
  version?: string;
}

/** Tab-bar badges: the label is rendered as-is (for example "?2"). */
export type TabBadges = Partial<Record<TabId, string>>;

export type ConnectionStatus = "online" | "connecting" | "offline" | "stale" | "unpaired" | "refused" | "paused" | "unavailable";

export interface Connection {
  status: ConnectionStatus;
  /** For "stale": how old the data is, pre-formatted ("2m"). */
  age?: string | undefined;
  /** For "stale": the bridge's reason (`stale {reason}` in the bridge API), for example "layout_without_remote". */
  reason?: string | undefined;
}

export interface HostInfo {
  name: string;
}
