// The `timeline:<t>` topic driver (docs/chatview.md §4; CV5). While someone is subscribed it rebuilds the value
// whenever a topic it reads changes (`inbox`, `panorama`, `host`, and `chatview:<t>` for the anchors) and publishes
// it; the hub sends only the patch. The subscription itself was allowed by the hub's topic gate (`view` +
// `transcript.read`, the open recorded in Activity).
import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { Json } from "../patch.js";
import { buildTimeline } from "./build.js";

export interface TimelineOptions {
  hub: Hub;
  /** `ask_operator` call ids in terminal t's own transcript, from the open chat view (`ChatviewTopicDriver.inboxAsks`). */
  asks: (terminal: string) => ReadonlySet<string> | null;
  /** The inbox's recorded call id of a group row (`InboxTopicDriver.toolUseIdOf`). */
  toolUseIdOf: (key: string) => string | undefined;
  /** Keeps the `usage` topic collecting while a timeline is open (`UsageTopicDriver.hold`); returns the release. */
  holdUsage?: () => () => void;
  /** The value failed its own schema (a bug): logged by the app, the topic goes stale. */
  onInvalid?: (topic: string, error: string) => void;
}

const SOURCES = ["inbox", "panorama", "host", "usage"] as const;

export class TimelineTopicDriver {
  private readonly open = new Map<string, { terminal: string; unwatch: () => void; release: () => void }>();
  private unwatch: (() => void)[] = [];

  constructor(private readonly o: TimelineOptions) {}

  start(): void {
    this.unwatch.push(this.o.hub.watchPrefix(bridgeApi.TIMELINE_PREFIX, (topic, n) => (n > 0 ? this.add(topic) : this.remove(topic))));
    for (const s of SOURCES) this.unwatch.push(this.o.hub.watchValue(s, () => this.refreshAll()));
  }

  stop(): void {
    for (const u of this.unwatch) u();
    this.unwatch = [];
    for (const topic of [...this.open.keys()]) this.remove(topic);
  }

  get activeTopics(): string[] {
    return [...this.open.keys()];
  }

  /** Rebuilds every open timeline now (also what a source change does). */
  refreshAll(): void {
    for (const topic of this.open.keys()) this.refresh(topic);
  }

  private add(topic: string): void {
    if (this.open.has(topic)) return;
    const terminal = bridgeApi.timelineTerminal(topic);
    if (terminal === null) return void this.o.hub.setStale(topic, "bad_terminal");
    const unwatch = this.o.hub.watchValue(`${bridgeApi.CHATVIEW_PREFIX}${terminal}`, () => this.refresh(topic));
    this.open.set(topic, { terminal, unwatch, release: this.o.holdUsage?.() ?? (() => {}) });
    this.refresh(topic);
  }

  private remove(topic: string): void {
    const w = this.open.get(topic);
    if (w) {
      w.unwatch();
      w.release();
      this.open.delete(topic);
    }
    this.o.hub.discard(topic);
  }

  private refresh(topic: string): void {
    const w = this.open.get(topic);
    if (!w) return;
    const { hub } = this.o;
    const value = buildTimeline({
      terminal: w.terminal,
      inbox: hub.get("inbox"),
      panorama: hub.get("panorama"),
      host: hub.get("host"),
      usage: hub.get("usage"),
      asks: this.o.asks(w.terminal),
      toolUseIdOf: this.o.toolUseIdOf,
    });
    const r = bridgeApi.TimelineTopic.safeParse(value);
    if (!r.success) {
      this.o.onInvalid?.(topic, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      // Nothing on an unchecked value can be acted on: the last good one stays, marked.
      if (hub.get(topic) !== undefined) hub.setStale(topic, "source_unavailable");
      return;
    }
    hub.publish(topic, value as unknown as Json);
  }
}
