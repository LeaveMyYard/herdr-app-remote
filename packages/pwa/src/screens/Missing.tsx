import { useState } from "react";
import { Icon } from "../components/Icon";
import type { HostInfo, PluginRow } from "../model";

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
  onCopy?: (text: string) => Promise<void> | void;
}

const STATE_LABEL: Record<PluginRow["state"], string> = {
  ready: "ready",
  missing: "not installed",
  outdated: "needs an update",
  error: "not responding",
};

function UsageGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="2.5" y="8" width="2.5" height="5.5" rx="0.8" />
      <rect x="6.75" y="2.5" width="2.5" height="11" rx="0.8" />
      <rect x="11" y="5.5" width="2.5" height="8" rx="0.8" />
    </svg>
  );
}

export function Missing({ host, title, plugin, blurb, command, plugins, onCopy }: MissingProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await (onCopy ? onCopy(command) : navigator.clipboard.writeText(command));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
          {plugin === "agent-usage" ? <UsageGlyph /> : <Icon name="layers" size={28} />}
        </div>
        <h1 className="missing-head">{plugin} isn&apos;t installed</h1>
        <p className="missing-body">
          {blurb} It needs the {plugin} plugin in herdr-app on {host.name}.
        </p>
        <div className="col cmd-block">
          <span className="cmd-label">On the computer, run:</span>
          <div className="row cmd-row">
            <span className="mono f1 cmd-text">{command}</span>
            <button type="button" className="cmd-copy" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <p className="missing-foot">The tab turns on by itself once it&apos;s installed.</p>
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
