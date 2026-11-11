// S14 end to end inside one process: the bridge started without a serve identity gets it from Tailscale setup
// (Start serving through the fake `tailscale` CLI), the S5 guards then accept the owner through the serve name
// only, and Stop serving takes it away again. The real tailscale is never run.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { LinkServer, startApp, type App } from "../src/index.js";

const FAKE = fileURLToPath(new URL("./fake-tailscale.mjs", import.meta.url));
const HOST = "desk-1.example-tailnet.ts.net:8443";
const OWNER = "user-1@example";
const ORIGIN = `https://${HOST}`;

let dir: string;
let link: LinkServer;
let app: App | undefined;
const socks: WebSocket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "s14-app-"));
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${dir}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "calls.log"), "");
  writeFileSync(join(dir, "serve.json"), "{}");
  link = new LinkServer({ token: "token-0123456789abcdef0123456789abcdef" });
  await link.listen();
  app = await startApp({
    appHome: join(dir, "home"),
    home: dir,
    link,
    port: 0,
    tailscale: bin,
    binaries: { hc: "/nonexistent/s14/hc", inbox: "/nonexistent/s14/inbox", usagebar: "/nonexistent/s14/usagebar" },
    funnelCheckMs: 60_000,
  });
});

afterEach(async () => {
  for (const s of socks.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
  await link.close();
  rmSync(dir, { recursive: true, force: true });
});

type H = Record<string, string>;
const GET: H = { Host: HOST, "Tailscale-User-Login": OWNER };
const POST: H = { ...GET, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" };

function http(method: string, path: string, headers: H, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: app!.port, method, path, headers, setHost: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const setupTopic = () => app!.hub.get("setup") as bridgeApi.SetupTopic | undefined;

describe("startApp with Tailscale setup", () => {
  it("serves nothing but /healthz until Start serving; then only through the serve name and owner login", async () => {
    await until(() => setupTopic()?.checked_at != null && !setupTopic()!.busy);
    expect(setupTopic()!.step).toBe(4);
    expect(setupTopic()!.can_start).toBe(true);
    expect((await http("GET", "/api/v1/meta", GET)).status).toBe(403);

    expect(await app!.setup!.start()).toEqual({ ok: true });
    const calls = readFileSync(join(dir, "calls.log"), "utf8");
    expect(calls).toContain(JSON.stringify(["serve", "--bg", "--https=8443", `http://127.0.0.1:${app!.port}`]));
    await until(() => setupTopic()?.serving === "ours");
    expect(setupTopic()).toMatchObject({ step: 5, url: `https://${HOST}/`, login: OWNER });

    expect((await http("GET", "/api/v1/meta", GET)).status).toBe(200);
    expect((await http("GET", "/api/v1/meta", { ...GET, Host: "desk-1.example-tailnet.ts.net" })).status).toBe(403); // port is part of the name
    expect((await http("GET", "/api/v1/meta", { ...GET, Host: "evil.example" })).status).toBe(403);
    expect((await http("GET", "/api/v1/meta", { ...GET, "Tailscale-User-Login": "user-2@example" })).status).toBe(403);
    expect((await http("GET", "/api/v1/meta", { Host: HOST })).status).toBe(403);

    // Pair and approve: step 5 follows the approval at once.
    const { code, url } = app!.security.issueCode();
    expect(url).toBe(`https://${HOST}/pair#c=${code}`);
    const r = await http("POST", "/api/v1/pair", POST, JSON.stringify({ code, name: "Phone 1" }));
    expect(r.status).toBe(202);
    const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
    app!.security.approve(id);
    expect(setupTopic()!.step).toBe(6);
    const sc = r.headers["set-cookie"];
    const cookie = (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]!;

    const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { ...GET, Origin: ORIGIN, Cookie: cookie } });
    socks.push(ws);
    await new Promise((res, rej) => ws.once("open", res).once("error", rej));
    const closed = new Promise<number>((res) => ws.once("close", (c) => res(c)));

    // Stop serving: our handler goes, the identity is cleared, the live phone is dropped.
    expect(await app!.setup!.stop()).toEqual({ ok: true });
    expect(await closed).toBe(4001);
    expect((await http("GET", "/api/v1/meta", GET)).status).toBe(403);
    expect(JSON.parse(readFileSync(join(dir, "serve.json"), "utf8"))).toEqual({});
    expect(setupTopic()).toMatchObject({ serving: "off", url: null, login: null, can_start: true });
  });

  it("Funnel seen first by a setup check still refuses with 503 funnel and closes 4004, then serves again", async () => {
    expect((await app!.setup!.start()).ok).toBe(true);
    const { code } = app!.security.issueCode();
    const r = await http("POST", "/api/v1/pair", POST, JSON.stringify({ code, name: "Phone 1" }));
    app!.security.approve((JSON.parse(r.body) as { device: { id: string } }).device.id);
    const sc = r.headers["set-cookie"];
    const cookie = (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]!;
    const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { ...GET, Origin: ORIGIN, Cookie: cookie } });
    socks.push(ws);
    await new Promise((res, rej) => ws.once("open", res).once("error", rej));
    const closed = new Promise<number>((res) => ws.once("close", (c) => res(c)));
    const cfgPath = join(dir, "serve.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, AllowFunnel: { [HOST]: true } }));
    await app!.setup!.check(); // setup sees Funnel before the 60 s Funnel timer
    expect(await closed).toBe(4004);
    await until(() => app!.funnel?.state === "on");
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(503);
    writeFileSync(cfgPath, JSON.stringify(cfg));
    await app!.checkFunnel();
    await app!.setup!.check();
    expect((await http("GET", "/api/v1/me", { ...GET, Cookie: cookie })).status).toBe(200); // the phone was not revoked
  });

  it("App.setServe refuses while setup owns the identity", () => {
    expect(() => app!.setServe({ host: HOST, login: OWNER })).toThrow(/setup/);
  });

  it("an explicit serve identity runs no setup", async () => {
    await app!.stop();
    app = await startApp({ appHome: join(dir, "home2"), link, port: 0, serve: { host: HOST, login: OWNER }, tailscale: join(dir, "tailscale"), funnelCheckMs: 60_000, binaries: { hc: "/nonexistent/s14/hc", inbox: "/nonexistent/s14/inbox", usagebar: "/nonexistent/s14/usagebar" } });
    expect(app.setup).toBeNull();
    const calls = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
    expect(calls.every((l) => l === JSON.stringify(["serve", "status", "--json"]) || l === JSON.stringify(["version"]) || l === JSON.stringify(["status", "--json"]))).toBe(true);
  });
});
