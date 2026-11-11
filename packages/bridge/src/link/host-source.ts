import type { HostSink, HostSource } from "../host.js";
import type { LinkServer } from "./server.js";

export interface LinkHostSourceOptions {
  /**
   * Whether this source owns the server's lifecycle: `start` listens and `stop` closes it. Default true.
   * The bridge process (`serve`) owns the link server itself, because its idle-out watches the link; there the
   * source only attaches to it (`owned: false`).
   */
  owned?: boolean;
}

/**
 * The `host` topic's source over the mod link: each `state` from the link copy is a snapshot,
 * and the link copy going away is a disconnect. Whether the shown layout has a link block can't
 * be read from outside the app, so `layoutHasLink` is not implemented (the topic stays
 * `reconnecting` until something else can tell).
 */
export class LinkHostSource implements HostSource {
  private sink: HostSink | null = null;
  private readonly owned: boolean;
  private readonly onHost = (e: { state: unknown }) => this.sink?.state(e.state);
  private readonly onUnlink = (e: { copy: string }) => {
    if (e.copy === "link") this.sink?.disconnected();
  };

  constructor(
    private readonly server: LinkServer,
    opts: LinkHostSourceOptions = {},
  ) {
    this.owned = opts.owned ?? true;
  }

  subscribe(sink: HostSink): void {
    this.sink = sink;
  }

  async start(): Promise<void> {
    this.server.on("host", this.onHost);
    this.server.on("unlink", this.onUnlink);
    if (this.owned) {
      await this.server.listen();
      return;
    }
    // Attached to a server that may already have a link: its latest state would otherwise wait for the next change.
    const last = this.server.lastHost;
    if (last && this.server.connected("link")) this.sink?.state(last.state);
  }

  async stop(): Promise<void> {
    this.server.off("host", this.onHost);
    this.server.off("unlink", this.onUnlink);
    if (this.owned) await this.server.close();
  }
}
