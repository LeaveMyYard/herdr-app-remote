import { Icon } from "../components/Icon";
import type { HostInfo, PluginRow } from "../model";

/** Swarm without herdr-panorama data: no lease owner, or no feed has ever been read. Says why instead of showing an empty swarm. */
export function SwarmUnavailable({ host, error, plugins }: { host: HostInfo; error: string | null; plugins: PluginRow[] }) {
  return (
    <>
      <div className="nf status-spacer" />
      <div className="row nf screen-title">
        <span>Swarm</span>
      </div>
      <main className="col f1 missing">
        <div aria-hidden="true" className="row missing-icon">
          <Icon name="layers" size={28} />
        </div>
        <h1 className="missing-head">The swarm isn&apos;t available</h1>
        <p className="missing-body">
          {error ? `The herdr-panorama feed on ${host.name} can't be read right now (${error}). ` : ""}
          This tab shows each agent&apos;s subagents while herdr-panorama&apos;s sidebar is open in herdr-app on {host.name}. The Agents tab keeps working without it.
        </p>
        <p className="missing-foot">The tab turns on by itself once the feed is running.</p>
      </main>
      <section className="col nf plugin-card" aria-label={`Plugins on ${host.name}`}>
        <span className="plugin-card-head">Plugins on {host.name}</span>
        {plugins
          .filter((p) => p.name === "herdr-panorama")
          .map((p) => (
            <div className="row plugin-row" key={p.name} data-state={p.state}>
              <span className="plugin-dot" aria-hidden="true" />
              <span className="f1">{p.name}</span>
              <span className="plugin-state">{p.state.replace("_", " ")}</span>
            </div>
          ))}
      </section>
    </>
  );
}
