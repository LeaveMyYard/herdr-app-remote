import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import type { HostInfo, PluginRow, PluginState } from "../model";

export interface MissingProps {
  host: HostInfo;
  /** Screen title in the header, for example "Agent Usage". */
  title: string;
  /** Plugin the screen needs, for example "agent-usage". */
  plugin: string;
  /** What the tab shows, one sentence without the plugin requirement. */
  blurb: string;
  /** Install command to copy; the screen shows it verbatim. */
  command: string;
  plugins: PluginRow[];
  /** Icon in the tile; defaults to a generic one. */
  icon?: ReactNode;
  /** Why the tab is not available: not installed (default), too old, or not answering. */
  state?: Extract<PluginState, "missing" | "too_old" | "broken">;
  onCopy?: (text: string) => Promise<void> | void;
}

/** One label per protocol plugin state (bridge-api PLUGIN_STATES). "ready", "not installed" and
    "not responding" are the design's words; the others are provisional (see the PR). */
const STATE_LABEL: Record<PluginRow["state"], string> = {
  ready: "ready",
  missing: "not installed",
  too_old: "too old",
  broken: "broken",
  stale: "stale",
  not_running: "not running",
};

export function UsageGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="2.5" y="8" width="2.5" height="5.5" rx="0.8" />
      <rect x="6.75" y="2.5" width="2.5" height="11" rx="0.8" />
      <rect x="11" y="5.5" width="2.5" height="8" rx="0.8" />
    </svg>
  );
}

/** Words per reason. "missing" is the design's; too_old and broken are provisional like STATE_LABEL. */
const COPY = {
  missing: {
    head: (p: string) => `${p} isn't installed`,
    body: (p: string, host: string) => `It needs the ${p} plugin in herdr-app on ${host}.`,
    label: "On the computer, run:",
    foot: "The tab turns on by itself once it's installed.",
  },
  too_old: {
    head: (p: string) => `${p} needs an update`,
    body: (p: string, host: string) => `The ${p} plugin in herdr-app on ${host} is too old for this app.`,
    label: "On the computer, run:",
    foot: "The tab turns on by itself once it's updated.",
  },
  broken: {
    head: (p: string) => `${p} isn't responding`,
    body: (p: string, host: string) => `The ${p} plugin in herdr-app on ${host} didn't answer as expected.`,
    label: "To reinstall it, run:",
    foot: "The tab turns on by itself once it responds.",
  },
} as const;

export function Missing({ host, title, plugin, blurb, command, plugins, icon, state = "missing", onCopy }: MissingProps) {
  const words = COPY[state];
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await (onCopy ? onCopy(command) : navigator.clipboard.writeText(command));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <div className="nf status-spacer" />
      <div className="row nf screen-title">
        <span>{title}</span>
      </div>
      <main className="col f1 missing">
        <div aria-hidden="true" className="row missing-icon">
          {icon ?? <Icon name="layers" size={28} />}
        </div>
        <h1 className="missing-head">{words.head(plugin)}</h1>
        <p className="missing-body">
          {blurb} {words.body(plugin, host.name)}
        </p>
        <div className="col cmd-block">
          <span className="cmd-label">{words.label}</span>
          <div className="row cmd-row">
            <span className="mono f1 cmd-text">{command}</span>
            <button type="button" className="cmd-copy" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <p className="missing-foot">{words.foot}</p>
      </main>
      <section className="col nf plugin-card" aria-label={`Plugins on ${host.name}`}>
        <span className="plugin-card-head">Plugins on {host.name}</span>
        {plugins.map((p) => (
          <div className="row plugin-row" key={p.name} data-state={p.state}>
            <span className="plugin-dot" aria-hidden="true" />
            <span className="f1">{p.name}</span>
            <span className="plugin-state">
              {STATE_LABEL[p.state]}
              {p.state === "ready" && p.version ? ` · ${p.version}` : ""}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
