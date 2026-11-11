import { z } from "zod";

/** Agent lifecycle states as mirrored from herdr-app. */
export const AgentState = z.enum(["idle", "working", "waiting", "done", "error", "unknown"]);
export type AgentState = z.infer<typeof AgentState>;

export const Space = z.object({
  id: z.string().min(1),
  name: z.string(),
  focused: z.boolean(),
});
export type Space = z.infer<typeof Space>;

export const Agent = z.object({
  id: z.string().min(1),
  name: z.string(),
  harness: z.string().min(1),
  state: AgentState,
  space_id: z.string().min(1),
  terminal_id: z.string().min(1).optional(),
});
export type Agent = z.infer<typeof Agent>;

export const Terminal = z.object({
  id: z.string().min(1),
  title: z.string(),
  space_id: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type Terminal = z.infer<typeof Terminal>;

export const Pane = z.object({
  id: z.string().min(1),
  space_id: z.string().min(1),
  terminal_id: z.string().min(1).optional(),
  kind: z.string().min(1),
});
export type Pane = z.infer<typeof Pane>;

export const Focused = z.object({
  space_id: z.string().min(1).nullable(),
  pane_id: z.string().min(1).nullable(),
  agent_id: z.string().min(1).nullable(),
});
export type Focused = z.infer<typeof Focused>;

export const Theme = z.object({
  name: z.string().min(1),
  mode: z.enum(["dark", "light"]),
});
export type Theme = z.infer<typeof Theme>;

/** The `shared` keys the link mod mirrors. */
export const HostShared = z.object({
  "panorama.feed.owner": z.string().nullable(),
});
export type HostShared = z.infer<typeof HostShared>;

/** The host snapshot carried by mod-link `state` and the bridge-api `host` topic. */
export const HostState = z.object({
  spaces: z.array(Space),
  agents: z.array(Agent),
  terminals: z.array(Terminal),
  panes: z.array(Pane),
  focused: Focused,
  theme: Theme,
  layout_name: z.string().min(1),
  shared: HostShared,
});
export type HostState = z.infer<typeof HostState>;
