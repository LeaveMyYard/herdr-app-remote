import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { bridgeApi } from "@herdr-remote/protocol";
import { PUSH_WORDS, PushRow } from "../src/push/PushRow";
import { readState, turnOff, turnOn, type PushEnv, type PushManagerLike, type SubscriptionLike } from "../src/push/push";

// A fake VAPID key (65 bytes, base64url) and fake subscription values only.
const KEY = `B${"A".repeat(86)}`;
const OTHER_KEY = `B${"Q".repeat(86)}`;
const keyBytes = (k: string) => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));

function fakeSub(key = KEY): SubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    endpoint: "https://web.push.apple.com/fake-endpoint-1",
    options: { applicationServerKey: keyBytes(key).buffer },
    toJSON: () => ({ endpoint: "https://web.push.apple.com/fake-endpoint-1", keys: { p256dh: "fake-p256dh", auth: "fake-auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function env(over: Partial<PushEnv> = {}, o: { info?: bridgeApi.PushInfo | null; sub?: SubscriptionLike | null; perm?: NotificationPermission } = {}) {
  let current = o.sub ?? null;
  const calls: string[] = [];
  const pm: PushManagerLike = {
    getSubscription: async () => current,
    subscribe: vi.fn(async ({ applicationServerKey }) => {
      calls.push(`subscribe:${applicationServerKey.length}`);
      current = fakeSub();
      return current;
    }),
  };
  let perm: NotificationPermission = o.perm ?? "default";
  const e: PushEnv = {
    standalone: () => true,
    permission: () => perm,
    requestPermission: vi.fn(async () => {
      calls.push("permission");
      perm = perm === "default" ? "granted" : perm;
      return perm;
    }),
    pushManager: async () => pm,
    info: async () => (o.info === undefined ? { key: KEY, allowed: true, subscribed: false } : o.info),
    act: vi.fn(async (kind: string) => {
      calls.push(kind);
      return { ok: true };
    }),
    ...over,
  };
  return { e, pm, calls };
}

describe("push state", () => {
  it("is unsupported outside the Home Screen app or without Web Push", async () => {
    expect((await readState(env({ standalone: () => false }).e)).state).toEqual({ s: "unsupported" });
    expect((await readState(env({ permission: () => undefined }).e)).state).toEqual({ s: "unsupported" });
    expect((await readState(env({ pushManager: async () => null }).e)).state).toEqual({ s: "unsupported" });
  });

  it("follows the bridge: not allowed without the capability, on only when both ends hold it", async () => {
    expect((await readState(env({}, { info: { key: KEY, allowed: false, subscribed: false } }).e)).state).toEqual({ s: "not_allowed" });
    expect((await readState(env({}, { perm: "denied" }).e)).state).toEqual({ s: "denied" });
    expect((await readState(env({}, { info: { key: KEY, allowed: true, subscribed: true }, sub: fakeSub() }).e)).state).toEqual({ s: "on" });
    expect((await readState(env({}, { info: { key: KEY, allowed: true, subscribed: true }, sub: null }).e)).state).toEqual({ s: "off" });
    expect((await readState(env({}, { info: { key: KEY, allowed: true, subscribed: false }, sub: fakeSub() }).e)).state).toEqual({ s: "off" });
    expect((await readState(env({}, { info: null }).e)).state).toEqual({ s: "failed" });
  });
});

describe("turning push on and off", () => {
  it("asks permission first, subscribes with the bridge's key, then sends push.subscribe", async () => {
    const { e, calls } = env();
    expect(await turnOn(e, KEY)).toEqual({ s: "on" });
    expect(calls).toEqual(["permission", "subscribe:65", "push.subscribe"]);
    expect(e.act).toHaveBeenCalledWith("push.subscribe", { endpoint: "https://web.push.apple.com/fake-endpoint-1", keys: { p256dh: "fake-p256dh", auth: "fake-auth" } });
  });

  it("stops at a refused permission, and replaces a subscription made for another key", async () => {
    const denied = env({}, { perm: "denied" });
    expect(await turnOn(denied.e, KEY)).toEqual({ s: "denied" });
    expect(denied.e.act).not.toHaveBeenCalled();
    const old = fakeSub(OTHER_KEY);
    const stale = env({}, { sub: old });
    expect(await turnOn(stale.e, KEY)).toEqual({ s: "on" });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(stale.calls).toContain("subscribe:65");
  });

  it("maps the bridge's refusal: forbidden is not allowed, anything else failed", async () => {
    const f = env({ act: async () => ({ ok: false, code: "forbidden" }) });
    expect(await turnOn(f.e, KEY)).toEqual({ s: "not_allowed" });
    const b = env({ act: async () => ({ ok: false, code: "bad_endpoint" }) });
    expect(await turnOn(b.e, KEY)).toEqual({ s: "failed" });
  });

  it("off tells the bridge first, then drops the browser's subscription", async () => {
    const sub = fakeSub();
    const { e, calls } = env({}, { sub });
    expect(await turnOff(e)).toEqual({ s: "off" });
    expect(calls).toEqual(["push.unsubscribe"]);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});

describe("PushRow", () => {
  it("renders nothing outside the Home Screen app", async () => {
    const { container } = render(<PushRow env={env({ standalone: () => false }).e} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("the tap requests permission inside the same task as the click (iOS needs the gesture)", async () => {
    const { e } = env();
    let duringClick = false;
    e.requestPermission = vi.fn(() => {
      duringClick = inClick;
      return Promise.resolve<NotificationPermission>("granted");
    });
    let inClick = false;
    render(<PushRow env={e} />);
    const btn = await screen.findByRole("button", { name: PUSH_WORDS.turnOn });
    btn.addEventListener("click", () => (inClick = true), { capture: true });
    // React handles clicks at its root; the document sees the click after that, when the gesture's dispatch ends.
    const reset = () => (inClick = false);
    document.addEventListener("click", reset);
    await userEvent.click(btn);
    document.removeEventListener("click", reset);
    expect(duringClick).toBe(true);
    expect(await screen.findByText(PUSH_WORDS.on)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: PUSH_WORDS.turnOff }));
    expect(await screen.findByText(PUSH_WORDS.off)).toBeInTheDocument();
  });

  it("says where to turn push on when the desktop has not", async () => {
    render(<PushRow env={env({}, { info: { key: KEY, allowed: false, subscribed: false } }).e} />);
    expect(await screen.findByText(PUSH_WORDS.notAllowed)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("App", () => {
  it("shows the notifications row at the top of the live Inbox", async () => {
    const { App } = await import("../src/App");
    const { inboxScenario } = await import("../src/inbox-fixtures");
    window.location.hash = "#/inbox";
    render(
      <App
        live={{ hostName: "desk-1", plugins: undefined, inbox: inboxScenario("typical").topic, usage: undefined, onUsageFilter: () => undefined, onUsageRefresh: async () => undefined, push: env().e }}
      />,
    );
    expect(await screen.findByRole("button", { name: PUSH_WORDS.turnOn })).toBeInTheDocument();
    window.location.hash = "";
  });
});
