import { modLink } from "@herdr-remote/protocol";
import type { ActHandler, ActResult, HubClient } from "../hub.js";
import type { LinkServer, RunOutcome } from "../link/server.js";

/**
 * One topic's (or the link's) share of the `act` kinds: a result for a kind it handles, undefined otherwise.
 * Capabilities and the audit log are not its concern: `Security.act` checks and records before and after.
 */
export type Actor = (client: HubClient, kind: string, args: Record<string, unknown>) => Promise<ActResult | undefined> | ActResult | undefined;

/** The first actor that knows the kind answers; none means `unsupported_action` (later slices add actors). */
export function routeActs(actors: readonly Actor[]): ActHandler {
  return async (client, kind, args) => {
    for (const a of actors) {
      const r = await a(client, kind, args);
      if (r !== undefined) return r;
    }
    return { ok: false, code: "unsupported_action" };
  };
}

export function fromRun(o: RunOutcome): ActResult {
  if (o.ok) return { ok: true };
  return o.unknown_effect ? { ok: false, code: o.code, unknown_effect: true } : { ok: false, code: o.code };
}

/**
 * The `navigate` kinds (`agent.focus`, `tab.select`, `space.select`, `pane.focus`), sent to the link copy as an
 * allowlisted `run`. The link server checks the allowlist and the argument shapes again, and so does the mod.
 */
export function navigateActor(link: LinkServer): Actor {
  return async (_client, kind, args) => {
    if (!Object.prototype.hasOwnProperty.call(modLink.RUN_ARGS, kind)) return undefined;
    return fromRun(await link.run(kind, args));
  };
}
