import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { FeedReader, type Contract, type FeedView } from "./feed.js";
import { buildPanoramaTopic } from "./join.js";

export const PANORAMA_TOPIC = "panorama";

export interface PanoramaTopicOptions {
  hub: Hub;
  appHome: string;
  /** Default 1 s: cheap, and it is what notices a feed turning 15 s old. */
  intervalMs?: number;
  now?: () => number;
  onInvalid?: (error: string) => void;
}

/**
 * Publishes the `panorama` topic: the feed (validated by panorama's own contract.js) joined with the `host`
 * topic. Nothing is published until the host topic exists. The bridge never starts the feed writer: only the
 * app-side lease owner may.
 */
export class PanoramaTopicDriver {
  private readonly reader: FeedReader;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private running = false;
  private last: { view: FeedView; contract: Contract | undefined } | undefined;

  constructor(private readonly opts: PanoramaTopicOptions) {
    this.reader = new FeedReader(opts.appHome, opts.now);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 1_000);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The feed as of the last refresh (at most a second old) and the contract that validated it, for the chat view
   * (CV3), which needs a root's `session_id` and `transcript`: fields the `panorama` topic never carries.
   */
  feedView(): { view: FeedView; contract: Contract | undefined } | undefined {
    return this.last;
  }

  /** Overlapping calls share one run. */
  refresh(): Promise<void> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async run(): Promise<void> {
    const view = await this.reader.read();
    if (!this.running) return;
    this.last = { view, contract: this.reader.contractFor() };
    const hostRaw = this.opts.hub.get("host");
    if (hostRaw === undefined) return;
    const host = bridgeApi.HostTopic.safeParse(hostRaw);
    if (!host.success) return;
    const topic = buildPanoramaTopic(host.data, view, this.reader.contractFor());
    const r = bridgeApi.PanoramaTopic.safeParse(topic);
    if (!r.success) {
      this.opts.onInvalid?.(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    this.opts.hub.publish(PANORAMA_TOPIC, r.data as unknown as Json);
  }
}
