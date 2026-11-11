import type { HostSink, HostSource } from "../host.js";
import type { LinkServer } from "./server.js";

/**
 * The `host` topic's source over the mod link: each `state` from the link copy is a snapshot,
 * and the link copy going away is a disconnect. Whether the shown layout has a link block can't
 * be read from outside the app, so `layoutHasLink` is not implemented (the topic stays
 * `reconnecting` until something else can tell).
 */
export class LinkHostSource implements HostSource {
  private sink: HostSink | null = null;
  private readonly onHost = (e: { state: unknown }) => this.sink?.state(e.state);
  private readonly onUnlink = (e: { copy: string }) => {
    if (e.copy === "link") this.sink?.disconnected();
  };

  constructor(private readonly server: LinkServer) {}

  subscribe(sink: HostSink): void {
    this.sink = sink;
  }

  async start(): Promise<void> {
    this.server.on("host", this.onHost);
    this.server.on("unlink", this.onUnlink);
    await this.server.listen();
  }

  async stop(): Promise<void> {
    this.server.off("host", this.onHost);
    this.server.off("unlink", this.onUnlink);
    await this.server.close();
  }
}
