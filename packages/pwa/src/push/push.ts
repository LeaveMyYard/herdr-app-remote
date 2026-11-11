// Web Push on the phone (S17). Subscribing happens only inside the Home Screen app, only from a tap (iOS asks for
// permission only from a user gesture), and only for a device the desktop gave the `push` capability. The
// subscription goes to the bridge as `push.subscribe` over the device's own socket, so it works however the device
// was paired.
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActOutcome } from "../bridge/client";

export type PushState =
  /** Not the Home Screen app, or the browser has no Web Push: nothing is shown. */
  | { s: "unsupported" }
  | { s: "loading" }
  /** The desktop has not turned `push` on for this phone. */
  | { s: "not_allowed" }
  /** Notifications are blocked for the app (iOS Settings). */
  | { s: "denied" }
  | { s: "off" }
  | { s: "on" }
  | { s: "busy" }
  | { s: "failed" };

/** The parts of the browser this uses; injected so tests run without one. */
export interface PushEnv {
  /** True in the Home Screen app (standalone display mode). */
  standalone(): boolean;
  /** Undefined when the browser has no Notification API. */
  permission(): NotificationPermission | undefined;
  requestPermission(): Promise<NotificationPermission>;
  /** The service worker's push manager, or null without one. */
  pushManager(): Promise<PushManagerLike | null>;
  /** `GET /api/v1/push`, or null when it failed. */
  info(): Promise<bridgeApi.PushInfo | null>;
  act(kind: "push.subscribe" | "push.unsubscribe", args: Record<string, unknown>): Promise<ActOutcome>;
}

export interface SubscriptionLike {
  readonly endpoint: string;
  readonly options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}
export interface PushManagerLike {
  getSubscription(): Promise<SubscriptionLike | null>;
  subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>;
}

const toBytes = (b64u: string): Uint8Array => {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const toB64u = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** What the row shows, from the bridge's view and the browser's. */
export async function readState(env: PushEnv): Promise<{ state: PushState; key: string | null }> {
  if (!env.standalone() || env.permission() === undefined) return { state: { s: "unsupported" }, key: null };
  const pm = await env.pushManager();
  if (!pm) return { state: { s: "unsupported" }, key: null };
  const info = await env.info();
  if (!info) return { state: { s: "failed" }, key: null };
  if (!info.allowed) return { state: { s: "not_allowed" }, key: info.key };
  if (env.permission() === "denied") return { state: { s: "denied" }, key: info.key };
  const sub = await pm.getSubscription();
  // On only when both ends agree: the bridge holds one, and this browser still has it.
  return { state: { s: info.subscribed && sub ? "on" : "off" }, key: info.key };
}

/**
 * Turns notifications on. Call it straight from the tap handler: the permission request is the first thing it
 * does, so iOS still sees the user gesture.
 */
export async function turnOn(env: PushEnv, key: string): Promise<PushState> {
  const perm = await env.requestPermission();
  if (perm === "denied") return { s: "denied" };
  if (perm !== "granted") return { s: "off" };
  const pm = await env.pushManager();
  if (!pm) return { s: "unsupported" };
  let sub = await pm.getSubscription();
  // A subscription made for another key (the bridge's keys were made again) can't receive this bridge's pushes.
  const own = sub?.options?.applicationServerKey;
  if (sub && own && toB64u(own) !== key) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  try {
    sub ??= await pm.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
  } catch {
    return { s: "failed" };
  }
  const j = sub.toJSON();
  const r = await env.act("push.subscribe", { endpoint: j.endpoint ?? sub.endpoint, keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" } });
  if (r.ok) return { s: "on" };
  if (r.code === "forbidden") return { s: "not_allowed" };
  return { s: "failed" };
}

/** Turns notifications off: the bridge forgets the subscription first, then the browser drops it. */
export async function turnOff(env: PushEnv): Promise<PushState> {
  const r = await env.act("push.unsubscribe", {});
  if (!r.ok) return r.code === "forbidden" ? { s: "not_allowed" } : { s: "failed" };
  const pm = await env.pushManager();
  const sub = await pm?.getSubscription();
  await sub?.unsubscribe().catch(() => false);
  return { s: "off" };
}

/** The real browser. */
export function browserEnv(act: PushEnv["act"]): PushEnv {
  return {
    standalone: () =>
      (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) || (navigator as { standalone?: boolean }).standalone === true,
    permission: () => (typeof Notification === "undefined" ? undefined : Notification.permission),
    requestPermission: () => Notification.requestPermission(),
    pushManager: async () => {
      if (!("serviceWorker" in navigator) || typeof PushManager === "undefined") return null;
      const reg = await navigator.serviceWorker.getRegistration();
      return (reg?.pushManager as unknown as PushManagerLike | undefined) ?? null;
    },
    info: async () => {
      try {
        const r = await fetch("/api/v1/push", { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) return null;
        const p = bridgeApi.PushInfo.safeParse(await r.json());
        return p.success ? p.data : null;
      } catch {
        return null;
      }
    },
    act,
  };
}
