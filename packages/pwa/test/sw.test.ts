import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../public/sw.js"), "utf8");
const ORIGIN = "https://desk-1.example";

interface FetchEvent {
  request: { method: string; url: string; mode: string };
  respondWith: (p: Promise<unknown>) => void;
}

function load(network: (url: string) => Promise<unknown>) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const store = new Map<string, unknown>();
  const caches = {
    keys: async () => [],
    delete: async () => true,
    match: async (k: unknown) => store.get(typeof k === "string" ? k : (k as { url: string }).url),
    open: async () => ({ put: async (k: unknown, v: unknown) => void store.set(typeof k === "string" ? k : (k as { url: string }).url, v) }),
  };
  const fetch = vi.fn((req: { url: string }) => network(req.url));
  runInNewContext(source, {
    self: { addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h), location: { origin: ORIGIN }, skipWaiting() {}, clients: { claim() {} } },
    caches,
    fetch,
    URL,
    Response: { error: () => "ERROR" },
  });
  const dispatch = async (method: string, path: string, mode = "no-cors", base = ORIGIN) => {
    let responded: Promise<unknown> | undefined;
    const e: FetchEvent = { request: { method, url: base + path, mode }, respondWith: (p) => (responded = p) };
    handlers["fetch"]?.(e);
    return responded ? await responded : undefined;
  };
  return { dispatch, fetch, store };
}

const page = (over: Record<string, unknown> = {}) => ({
  ok: true,
  redirected: false,
  headers: { get: () => "text/html; charset=utf-8" },
  clone() {
    return this;
  },
  ...over,
});

describe("service worker", () => {
  it("never intercepts /api, non-GET or cross-origin requests", async () => {
    const sw = load(async () => page());
    expect(await sw.dispatch("GET", "/api/v1/meta")).toBeUndefined();
    expect(await sw.dispatch("POST", "/assets/app.js")).toBeUndefined();
    expect(await sw.dispatch("GET", "/assets/app.js", "no-cors", "https://elsewhere.example")).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it("leaves non-asset GETs such as the manifest to the network", async () => {
    const sw = load(async () => page());
    expect(await sw.dispatch("GET", "/manifest.webmanifest")).toBeUndefined();
    expect(await sw.dispatch("GET", "/healthz")).toBeUndefined();
  });

  it("caches a good navigation as the offline shell and serves it when the network fails", async () => {
    let down = false;
    const sw = load(async () => {
      if (down) throw new Error("offline");
      return page({ tag: "index" });
    });
    await sw.dispatch("GET", "/", "navigate");
    await new Promise((r) => setTimeout(r, 0));
    down = true;
    expect(await sw.dispatch("GET", "/", "navigate")).toMatchObject({ tag: "index" });
  });

  it.each([
    ["an error status", { ok: false }],
    ["a redirect", { redirected: true }],
    ["a non-HTML body", { headers: { get: () => "application/json" } }],
  ])("does not cache %s as the offline shell", async (_name, over) => {
    const sw = load(async () => page(over));
    await sw.dispatch("GET", "/", "navigate");
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.store.has("shell")).toBe(false);
  });

  it("serves hashed assets cache-first", async () => {
    const sw = load(async () => page({ tag: "asset" }));
    await sw.dispatch("GET", "/assets/app-abc.js");
    await new Promise((r) => setTimeout(r, 0));
    await sw.dispatch("GET", "/assets/app-abc.js");
    expect(sw.fetch).toHaveBeenCalledTimes(1);
  });
});
