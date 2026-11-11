import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { createBridgeServer, type BridgeServer } from "../src/server.js";
import type { Hub } from "../src/hub.js";
import { fixture, newHub } from "./helpers.js";

let root: string;
let dir: string;
let srv: BridgeServer;
let hub: Hub;
let base: string;

async function start(guard?: Parameters<typeof createBridgeServer>[0]["guard"]) {
  hub = newHub();
  srv = createBridgeServer({ hub, staticDir: dir, ...(guard ? { guard } : {}) });
  const { host, port } = await srv.listen();
  expect(host).toBe("127.0.0.1");
  base = `127.0.0.1:${port}`;
}

beforeEach(async () => {
  root = await mkdtemp(pjoin(tmpdir(), "bridge-static-"));
  dir = pjoin(root, "static");
  await mkdir(dir);
  await writeFile(pjoin(root, "bridge-secret.txt"), "secret");
  await writeFile(pjoin(dir, "index.html"), "<html>app</html>");
  await mkdir(pjoin(dir, "assets"));
  await writeFile(pjoin(dir, "assets", "a.js"), "console.log(1)");
});
afterEach(async () => {
  await srv?.close();
  await rm(root, { recursive: true, force: true });
});

function open(path = "/api/v1/ws"): Promise<{ ws: WebSocket; msgs: bridgeApi.ServerMessage[]; next: (n: number) => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}${path}`);
    const msgs: bridgeApi.ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (d) => {
      msgs.push(JSON.parse(d.toString()) as bridgeApi.ServerMessage);
      waiters.forEach((w) => w());
    });
    const next = (n: number) =>
      new Promise<void>((res) => {
        const check = () => msgs.length >= n && res();
        waiters.push(check);
        check();
      });
    ws.once("open", () => resolve({ ws, msgs, next }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_r, resp) => reject(new Error(`status ${resp.statusCode}`)));
  });
}

describe("http", () => {
  it("serves meta, healthz, static files and the SPA fallback with security headers", async () => {
    await start();
    const meta = await fetch(`http://${base}/api/v1/meta`);
    expect(await meta.json()).toEqual({ api: 1, bridge: "0.0.0-test" });
    expect(meta.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect((await fetch(`http://${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`http://${base}/`)).text()).toBe("<html>app</html>");
    const js = await fetch(`http://${base}/assets/a.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`http://${base}/agents/deep/route`)).text()).toBe("<html>app</html>");
    expect((await fetch(`http://${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`http://${base}/api/v1/nope`)).status).toBe(404);
    expect((await fetch(`http://${base}/`, { method: "POST" })).status).toBe(405);
  });

  it("refuses path traversal", async () => {
    await start();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const [h, p] = base.split(":");
      const req = request({ host: h, port: Number(p), path: "/../bridge-secret.txt", method: "GET" }, (r) => resolve(r.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    expect(status).not.toBe(200);
    for (const p of ["/%2e%2e/bridge-secret.txt", "/..%2fbridge-secret.txt"]) {
      const r = await fetch(`http://${base}${p}`);
      expect(await r.text()).not.toBe("secret");
    }
  });

  it("the guard blocks http and ws", async () => {
    await start(() => false);
    expect((await fetch(`http://${base}/api/v1/meta`)).status).toBe(403);
    await expect(open()).rejects.toThrow(/403/);
  });
});

describe("websocket", () => {
  it("hello, sub, snap, patch end to end over a real socket", async () => {
    await start();
    hub.publish("host", fixture("typical"));
    const { ws, msgs, next } = await open();
    ws.send(JSON.stringify({ type: "hello", api: 1 }));
    ws.send(JSON.stringify({ type: "sub", topics: ["host"] }));
    await next(2);
    expect(msgs.map((m) => m.type)).toEqual(["welcome", "snap"]);
    hub.publish("host", fixture("idle-and-done"));
    await next(3);
    expect(msgs[2]?.type).toBe("patch");
    for (const m of msgs) expect(bridgeApi.ServerMessage.safeParse(m).success).toBe(true);
    ws.close();
  });

  it("only upgrades /api/v1/ws, rejects binary and oversized frames", async () => {
    await start();
    await expect(open("/other")).rejects.toThrow(/404/);
    const a = await open();
    const closed = new Promise<number>((r) => a.ws.once("close", (c) => r(c)));
    a.ws.send(Buffer.from([1, 2, 3]));
    expect(await closed).toBe(1003);
    const b = await open();
    const closed2 = new Promise<number>((r) => b.ws.once("close", (c) => r(c)));
    b.ws.send("x".repeat(70 * 1024));
    expect(await closed2).toBe(1009);
  });

  it("close() disconnects clients", async () => {
    await start();
    const { ws } = await open();
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    await srv.close();
    await closed;
    expect(hub.connectionCount).toBe(0);
  });
});
