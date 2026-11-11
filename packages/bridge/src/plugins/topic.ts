import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { detectHc, detectHost, detectInbox, detectPanorama, detectUsage, type DetectEnv, type PluginStatus } from "./detect.js";

export const PLUGINS_TOPIC = "plugins";

export interface PluginsTopicOptions extends DetectEnv {
  hub: Hub;
  /** How often the CLI and file probes re-run. Default 30 s. */
  intervalMs?: number;
  /** How often the (free) host status is re-derived from the host topic. Default 1 s. */
  hostIntervalMs?: number;
  onInvalid?: (error: string) => void;
}

/**
 * Publishes the `plugins` topic: one probe per plugin (panorama, inbox, usage, hc) re-run on an interval,
 * plus `host`, derived from the `host` topic. The whole value is published each time; the hub diffs it.
 */
export class PluginsTopicDriver {
  private readonly opts: PluginsTopicOptions;
  private last: Omit<bridgeApi.PluginsTopic, "host"> | undefined;
  private timers: NodeJS.Timeout[] = [];
  private inflight: Promise<void> | undefined;
  private running = false;

  constructor(opts: PluginsTopicOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.refresh();
    const probes = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 30_000);
    const host = setInterval(() => this.publish(), this.opts.hostIntervalMs ?? 1_000);
    probes.unref();
    host.unref();
    this.timers = [probes, host];
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Re-runs every probe. Overlapping calls share one run. */
  refresh(): Promise<void> {
    this.inflight ??= this.probeAll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async probeAll(): Promise<void> {
    const guard = async (f: () => Promise<PluginStatus>): Promise<PluginStatus> => {
      try {
        return await f();
      } catch {
        return { state: "broken", detail: "probe failed" };
      }
    };
    const [panorama, inbox, usage, hc] = await Promise.all([
      guard(() => detectPanorama(this.opts)),
      guard(() => detectInbox(this.opts)),
      guard(() => detectUsage(this.opts)),
      guard(() => detectHc(this.opts)),
    ]);
    this.last = { panorama, inbox, usage, hc };
    this.publish();
  }

  /** Recomputes `host` from the host topic and publishes if anything changed. */
  publish(): void {
    if (!this.running || !this.last) return;
    const { hub } = this.opts;
    const host = detectHost({ hasState: hub.get("host") !== undefined, stale: hub.isStale("host") });
    const value = { ...this.last, host };
    const r = bridgeApi.PluginsTopic.safeParse(value);
    if (!r.success) {
      this.opts.onInvalid?.(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    hub.publish(PLUGINS_TOPIC, r.data as unknown as Json);
  }
}
