import { HostState } from "@herdr-remote/protocol";
import type { Hub } from "./hub.js";
import type { Json } from "./patch.js";

/**
 * Where host state comes from. S2's link server implements this over the mod link;
 * tests (and a future `herdr-app status` fallback) implement it directly.
 * All callbacks are set before `start`, and are called on the event loop.
 */
export interface HostSource {
  /** Registers the sink for the source's events. Called once, before `start`. */
  subscribe(sink: HostSink): void;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  /**
   * Asked once the link has been gone for `layoutGraceMs`: does the layout the app is
   * showing contain the link block? `undefined` means "can't tell" (stay `reconnecting`).
   */
  layoutHasLink?(): Promise<boolean | undefined>;
}

export interface HostSink {
  /** A fresh host snapshot (validated here, so a bad one is dropped, not published). */
  state(state: unknown): void;
  /** The link (or other source) went away. */
  disconnected(): void;
  /** The source cannot work at all (for example bad setup). */
  unavailable(): void;
}

export interface HostTopicOptions {
  hub: Hub;
  source: HostSource;
  /** No hello within this long after a disconnect triggers the layout probe. Default 5000. */
  layoutGraceMs?: number;
  /** Called when a source state is rejected by the schema. */
  onInvalid?: (error: string) => void;
}

export const HOST_TOPIC = "host";

/**
 * Drives the `host` topic from a `HostSource`:
 * - a valid state publishes (clearing any staleness);
 * - a disconnect marks the topic stale `reconnecting` and keeps the last state;
 * - if nothing returns within the grace period and the shown layout has no link
 *   block, the reason becomes `layout_without_remote`.
 */
export class HostTopic {
  private readonly hub: Hub;
  private readonly source: HostSource;
  private readonly grace: number;
  private readonly onInvalid: ((e: string) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private running = false;

  constructor(opts: HostTopicOptions) {
    this.hub = opts.hub;
    this.source = opts.source;
    this.grace = opts.layoutGraceMs ?? 5000;
    this.onInvalid = opts.onInvalid;
    this.source.subscribe({
      state: (s) => this.onState(s),
      disconnected: () => this.onDisconnected(),
      unavailable: () => this.onUnavailable(),
    });
  }

  async start(): Promise<void> {
    this.running = true;
    // Until the first hello there is no state; subscribers see stale "reconnecting".
    this.hub.setStale(HOST_TOPIC, "reconnecting");
    this.armProbe();
    await this.source.start();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.disarm();
    await this.source.stop();
  }

  private onState(raw: unknown): void {
    if (!this.running) return;
    const r = HostState.safeParse(raw);
    if (!r.success) {
      this.onInvalid?.(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    this.disarm();
    this.hub.publish(HOST_TOPIC, r.data as unknown as Json);
  }

  private onDisconnected(): void {
    if (!this.running) return;
    this.hub.setStale(HOST_TOPIC, "reconnecting");
    this.armProbe();
  }

  private onUnavailable(): void {
    if (!this.running) return;
    this.disarm();
    this.hub.setStale(HOST_TOPIC, "source_unavailable");
  }

  private disarm(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private armProbe(): void {
    this.disarm();
    const gen = this.generation;
    this.timer = setTimeout(() => void this.probe(gen), this.grace);
    this.timer.unref();
  }

  private async probe(gen: number): Promise<void> {
    let has: boolean | undefined;
    try {
      has = await this.source.layoutHasLink?.();
    } catch {
      has = undefined;
    }
    // A hello (or another disconnect) since the probe started supersedes it.
    if (gen !== this.generation || !this.running) return;
    if (has === false) this.hub.setStale(HOST_TOPIC, "layout_without_remote");
  }
}
