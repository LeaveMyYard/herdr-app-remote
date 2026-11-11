import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../public/sw.js"), "utf8");
const ORIGIN = "https://desk-1.example";
const SCOPE = `${ORIGIN}/`;

function load(windows: { url: string; navigate?: (u: string) => Promise<unknown>; focus?: () => Promise<unknown> }[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  runInNewContext(source, {
    self: {
      addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h),
      location: { origin: ORIGIN },
      registration: { scope: SCOPE, showNotification },
      clients: { claim() {}, matchAll: async () => windows, openWindow },
      skipWaiting() {},
    },
    caches: {},
    fetch: () => Promise.reject(new Error("no network")),
    URL,
    Response: { error: () => "ERROR" },
  });
  const push = async (data: unknown) => {
    let p: Promise<unknown> | undefined;
    handlers["push"]?.({ data, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const click = async (data: unknown) => {
    let p: Promise<unknown> | undefined;
    const close = vi.fn();
    handlers["notificationclick"]?.({ notification: { data, close }, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
    return close;
  };
  return { push, click, showNotification, openWindow };
}

const json = (v: unknown) => ({ json: () => v });

describe("service worker push", () => {
  it("shows the payload's title and body as a notification that opens its route", async () => {
    const sw = load();
    await sw.push(json({ v: 1, kind: "question", title: "Agent 1: Question Title 123", body: "New question", tag: "q-123", url: "#/inbox/q/group%3A123" }));
    expect(sw.showNotification).toHaveBeenCalledWith("Agent 1: Question Title 123", {
      body: "New question",
      tag: "q-123",
      icon: "icons/icon-192.png",
      data: { url: "#/inbox/q/group%3A123" },
    });
  });

  it.each([
    ["no data", null],
    ["unreadable JSON", { json: () => JSON.parse("{") }],
    ["another version", json({ v: 2, title: "x" })],
  ])("still shows a notification for %s (iOS drops subscriptions that show none)", async (_n, data) => {
    const sw = load();
    await sw.push(data);
    expect(sw.showNotification).toHaveBeenCalledWith("Herdr", expect.objectContaining({ data: { url: "#/inbox" } }));
  });

  it("never lets a payload pick a URL outside the app's routes", async () => {
    const sw = load();
    for (const url of ["https://example.com/", "javascript:alert(1)", "//example.com", "#/a b"]) {
      await sw.push(json({ v: 1, kind: "alert", title: "Agent 1: Alert Title 456", body: "Alert", tag: "a-456", url }));
    }
    for (const call of sw.showNotification.mock.calls as unknown as [string, { data: { url: string } }][]) expect(call[1].data.url).toBe("#/inbox");
  });

  it("a tap focuses the open app on the route, or opens it", async () => {
    const navigate = vi.fn(async () => null);
    const focus = vi.fn(async () => undefined);
    const sw = load([{ url: `${ORIGIN}/#/agents`, navigate, focus }]);
    const close = await sw.click({ url: "#/inbox/q/group%3A123" });
    expect(close).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/#/inbox/q/group%3A123`);
    expect(focus).toHaveBeenCalled();
    const none = load([]);
    await none.click({ url: "https://example.com/" });
    expect(none.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#/inbox`);
  });
});
