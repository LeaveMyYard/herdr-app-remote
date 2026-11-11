// Web Push (S17): subscriptions from paired phones with the `push` capability, triggers from the topics, and
// encrypted, VAPID-signed delivery. A subscription is bound to the device a WebSocket acts as, so it does not
// care how that device was paired.
import type { IncomingMessage, ServerResponse } from "node:http";
import { bridgeApi } from "@herdr-remote/protocol";
import type { Actor } from "../app/act.js";
import type { ActResult, HubClient } from "../hub.js";
import type { AuditEntry } from "../security/audit.js";
import { encryptPayload, validUaKeys } from "./encrypt.js";
import { defaultTransport, knownPushEndpoint, type PushTransport } from "./send.js";
import { PushStore } from "./store.js";
import { PushTriggers, type PushEvent, type TopicValues } from "./triggers.js";
import { DEFAULT_SUBJECT, loadVapid, vapidAuthorization, type Vapid } from "./vapid.js";

/** What the push service needs from the security layer. */
export interface PushGate {
  /** Approved, current, not paused, with `view` and `push` now. */
  mayPush(deviceId: string): boolean;
  /** The device a request's cookie names, when it may hold a socket (approved, current, `view`). */
  requestDevice(req: IncomingMessage): { id: string } | undefined;
  /** A known device's name, and whether it is approved with `push` on (as stored; expiry and pause aside). */
  device(deviceId: string): { name: string; push: boolean } | undefined;
  /** Writes one Activity entry (identifiers only). Never throws. */
  note(e: Omit<AuditEntry, "ts">): void;
}

export interface PushOptions {
  /** `data/herdr-app-remote`: holds `vapid.json` and `push.json`. */
  dataDir: string;
  gate: PushGate;
  /** The current topic values (the hub's). */
  topics: () => TopicValues;
  /** False while the bridge refuses to serve (Funnel on, or not checked yet): nothing is sent. */
  serving?: () => boolean;
  now?: () => number;
  /** Test seams: the POST and the endpoint check. Production uses HTTPS to the known push services only. */
  transport?: PushTransport;
  allowEndpoint?: (endpoint: string) => boolean;
  subject?: string;
  /** How often the topics are looked at. Default 1 s. */
  tickMs?: number;
  /** Notifications per device per {@link RATE_WINDOW_MS}. */
  rateLimit?: number;
}

/** A notification may wait this long at the push service while the phone is unreachable. */
export const PUSH_TTL_S = 4 * 60 * 60;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_RATE_LIMIT = 20;
/** Statuses that mean the subscription is gone for good (RFC 8030 §7.3: 404 and 410). */
const GONE = new Set([404, 410]);

const SubscribeArgs = bridgeApi.PushSubscribeArgs;
const UnsubscribeArgs = bridgeApi.PushUnsubscribeArgs;

export class PushService {
  private readonly store: PushStore;
  private readonly vapid: Vapid;
  private readonly triggers = new PushTriggers();
  private readonly now: () => number;
  private readonly transport: PushTransport;
  private readonly allow: (endpoint: string) => boolean;
  private readonly sent = new Map<string, number[]>();
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;

  constructor(private readonly o: PushOptions) {
    this.vapid = loadVapid(o.dataDir, o.now);
    this.store = new PushStore(o.dataDir);
    this.now = o.now ?? Date.now;
    this.transport = o.transport ?? defaultTransport();
    this.allow = o.allowEndpoint ?? knownPushEndpoint;
  }

  /** The public VAPID key (base64url): the PWA's `applicationServerKey`. Not a secret. */
  get publicKey(): string {
    return this.vapid.publicKey;
  }

  /** True when the device holds a subscription. */
  subscribed(deviceId: string): boolean {
    return this.store.get(deviceId) !== undefined;
  }

  start(): void {
    if (this.store.damaged) {
      this.o.gate.note({ event: "push.reset", text: "Push subscriptions were unreadable and were set aside; phones must turn notifications on again", ok: false, code: "damaged" });
    }
    // Devices revoked or with `push` turned off while the bridge was down.
    this.sync();
    // The first look seeds every source: what is there now is never announced.
    this.triggers.observe(this.o.topics(), this.now());
    // A tick never throws on its own; this is the backstop, so nothing becomes an unhandled rejection.
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.o.tickMs ?? 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Looks at the topics once and sends what is new. Ticks never overlap; a tick during a send is skipped. */
  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    const events = this.triggers.observe(this.o.topics(), this.now());
    if (events.length === 0) return Promise.resolve();
    this.inflight = this.deliver(events).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Drops the subscriptions of devices that are gone (revoked) or have `push` turned off. Call on every security
   * change. Pause, a login change or `view` off only stop sends (`mayPush`); the subscription stays.
   */
  sync(): void {
    let gone: { device: string }[] = [];
    try {
      gone = this.store.retain((d) => this.o.gate.device(d)?.push === true);
      for (const d of [...this.sent.keys()]) if (!this.store.get(d)) this.sent.delete(d);
    } catch {
      // A failed write leaves the subscription on disk; every send is gated on `mayPush` anyway.
      return;
    }
    for (const s of gone) {
      const d = this.o.gate.device(s.device);
      this.o.gate.note(d ? { event: "push.drop", device: d.name, text: `${d.name}: push subscription removed` } : { event: "push.drop", text: "Push subscription of a removed device dropped" });
    }
  }

  private dev(device: string): { device?: string } {
    const d = this.o.gate.device(device);
    return d ? { device: d.name } : {};
  }

  private label(device: string): string {
    return this.o.gate.device(device)?.name ?? "a removed device";
  }

  // ---- acts ----

  /** `push.subscribe` and `push.unsubscribe`. `Security.act` has checked `push` and records the outcome. */
  readonly act: Actor = (client: HubClient, kind, args): ActResult | undefined => {
    if (kind !== "push.subscribe" && kind !== "push.unsubscribe") return undefined;
    const device = client.principal?.deviceId;
    if (device === undefined) return { ok: false, code: "unpaired" };
    if (kind === "push.unsubscribe") {
      if (!UnsubscribeArgs.safeParse(args).success) return { ok: false, code: "bad_args" };
      this.store.remove(device);
      return { ok: true };
    }
    const p = SubscribeArgs.safeParse(args);
    if (!p.success) return { ok: false, code: "bad_args" };
    const { endpoint, keys } = p.data;
    if (!this.allow(endpoint)) return { ok: false, code: "bad_endpoint" };
    const p256dh = Buffer.from(keys.p256dh, "base64url");
    const auth = Buffer.from(keys.auth, "base64url");
    // Canonical base64url only, so what is stored is exactly what was checked.
    if (p256dh.toString("base64url") !== keys.p256dh || auth.toString("base64url") !== keys.auth || !validUaKeys({ p256dh, auth })) {
      return { ok: false, code: "bad_keys" };
    }
    this.store.put({ device, endpoint, p256dh: keys.p256dh, auth: keys.auth, created_at: this.now() });
    return { ok: true };
  };

  // ---- HTTP ----

  /** `GET /api/v1/push`: `{key, allowed, subscribed}` for the cookie's device. Read-only. */
  readonly routes = (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    if (path !== "/api/v1/push") return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const d = this.o.gate.requestDevice(req);
    if (!d) {
      json(res, 401, { error: "unpaired" });
      return true;
    }
    const body: bridgeApi.PushInfo = { key: this.vapid.publicKey, allowed: this.o.gate.mayPush(d.id), subscribed: this.subscribed(d.id) };
    json(res, 200, body);
    return true;
  };

  // ---- delivery ----

  private async deliver(events: PushEvent[]): Promise<void> {
    if (this.o.serving && !this.o.serving()) return;
    const msg = summarize(events);
    const subs = this.store.all().filter((s) => this.o.gate.mayPush(s.device));
    await Promise.all(subs.map((s) => this.sendOne(s.device, s.endpoint, s.p256dh, s.auth, msg)));
  }

  private allowRate(device: string, now: number): boolean {
    const limit = this.o.rateLimit ?? DEFAULT_RATE_LIMIT;
    const recent = (this.sent.get(device) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= limit) {
      this.sent.set(device, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(device, recent);
    return true;
  }

  private async sendOne(device: string, endpoint: string, p256dh: string, auth: string, m: Summary): Promise<void> {
    const name = this.label(device);
    const now = this.now();
    // Checked again at send time: a subscription stored under another check must still pass this one.
    if (!this.allow(endpoint)) {
      try {
        this.store.remove(device, endpoint);
      } catch {
        // Stays on disk, and is refused again at the next send.
      }
      this.o.gate.note({ event: "push.drop", ...this.dev(device), text: `${name}: push subscription removed`, ok: false, code: "bad_endpoint" });
      return;
    }
    if (!this.allowRate(device, now)) {
      this.o.gate.note({ event: "push.skip", ...this.dev(device), text: `Push to ${name} skipped: ${m.audit}`, ok: false, code: "rate_limited" });
      return;
    }
    let body: Buffer;
    try {
      body = encryptPayload(Buffer.from(JSON.stringify(m.payload)), { p256dh: Buffer.from(p256dh, "base64url"), auth: Buffer.from(auth, "base64url") });
    } catch {
      this.o.gate.note({ event: "push.fail", ...this.dev(device), text: `Push to ${name} failed: ${m.audit}`, ok: false, code: "encrypt" });
      return;
    }
    const status = await this.transport({
      endpoint,
      headers: {
        Authorization: vapidAuthorization(this.vapid, endpoint, this.o.subject ?? DEFAULT_SUBJECT, now),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_S),
        Urgency: "high",
      },
      body,
    });
    if (status !== null && status >= 200 && status < 300) {
      this.o.gate.note({ event: "push.send", ...this.dev(device), text: `Push sent to ${name}: ${m.audit}`, ok: true });
      return;
    }
    if (status !== null && GONE.has(status)) {
      // Only this endpoint: the phone may have subscribed again meanwhile.
      try {
        this.store.remove(device, endpoint);
      } catch {
        // Sent again next time; the push service keeps refusing it.
      }
      this.o.gate.note({ event: "push.expire", ...this.dev(device), text: `${name}: push subscription expired`, ok: false, code: `http_${status}` });
      return;
    }
    this.o.gate.note({ event: "push.fail", ...this.dev(device), text: `Push to ${name} failed: ${m.audit}`, ok: false, code: status === null ? "no_answer" : `http_${status}` });
  }
}

interface Summary {
  payload: bridgeApi.PushPayload;
  audit: string;
}

/** One notification per tick: the event itself, or the first one and a count. */
export function summarize(events: readonly PushEvent[]): Summary {
  const first = events[0]!;
  if (events.length === 1) {
    return { payload: { v: 1, kind: first.kind, title: first.title, body: first.body, tag: first.tag, url: first.url }, audit: first.audit };
  }
  const more = events.length - 1;
  return {
    payload: { v: 1, kind: first.kind, title: first.title, body: `and ${more} more`, tag: "batch", url: events.every((e) => e.kind === "blocked") ? "#/agents" : "#/inbox" },
    audit: `${events.length} updates`,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Security-Policy": "default-src 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(s),
  });
  res.end(s);
}
