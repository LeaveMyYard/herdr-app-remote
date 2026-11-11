import { useEffect, useState } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";
import type { HostInfo, PluginRow } from "../model";
import { Missing, UsageGlyph } from "./Missing";
import { Usage, type UsageView } from "./Usage";

export interface UsageTabProps {
  host: HostInfo;
  /** `plugins.usage.state` from the bridge. */
  state: bridgeApi.PluginState;
  /** The `usage` topic; undefined until the first snap. */
  topic: bridgeApi.UsageTopic | undefined;
  /** The plugin card on the Missing screen. */
  plugins: PluginRow[];
  installCommand: string;
  /** Fixed clock for tests and the visual harness. */
  now?: number | undefined;
  /** `usage.set_filter`. */
  onFilter: (filter: bridgeApi.UsageTopic["filter"]) => void;
  /** `usage.refresh`; resolves when the bridge has answered. */
  onRefresh: () => Promise<unknown> | void;
}

const VIEW_KEY = "usage.view";

function loadView(): UsageView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "compact" ? "compact" : "full";
  } catch {
    return "full";
  }
}

/** Ticks so "updated 1m ago" moves on its own. */
function useNow(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? now;
}

/**
 * The Usage tab. `missing`, `too_old` and `broken` plugins show the Missing screen (the tab turns on by
 * itself once the state becomes ready); everything else draws the panel from the `usage` topic.
 */
export function UsageTab({ host, state, topic, plugins, installCommand, now: fixedNow, onFilter, onRefresh }: UsageTabProps) {
  const [view, setView] = useState<UsageView>(loadView);
  const [busy, setBusy] = useState(false);
  const now = useNow(fixedNow);
  const chooseView = (v: UsageView) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Private mode: the choice lasts until the tab closes.
    }
  };
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRefresh();
    } catch {
      // A failed refresh reaches the screen as the topic's `error`; nothing to retry here.
    } finally {
      setBusy(false);
    }
  };
  if (state === "missing" || state === "too_old" || state === "broken") {
    return (
      <Missing
        host={host}
        title="Agent Usage"
        plugin="agent-usage"
        blurb="This tab shows how much of each Claude and Codex account is left."
        command={installCommand}
        icon={<UsageGlyph />}
        plugins={plugins}
        state={state}
      />
    );
  }
  return <Usage topic={topic} now={now} view={view} busy={busy} onView={chooseView} onFilter={onFilter} onRefresh={() => void refresh()} />;
}
