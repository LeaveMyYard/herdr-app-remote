// The push service as `startApp` wires it: the act route, `GET /api/v1/push`, the security-change sync, and
// delivery to a local fake push service.
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { LinkServer, startApp, type App, type Runner } from "../../src/index.js";
import { FakePushService, FakeUa } from "./fake-push.js";

const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;
const OK_GET = { Host: SERVE, "Tailscale-User-Login": OWNER };
const OK_POST = { ...OK_GET, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" };

let home: string;
let link: LinkServer;
let app: App | undefined;
let fake: FakePushService;
const socks: WebSocket[] = [];

/** Nothing is spawned: Tailscale reports no Funnel, and every plugin is missing. */
const fakeRun: Runner = async (cmd) => (cmd === "fake-tailscale" ? { code: 0, stdout: "{}", stderr: "" } : { code: null, stdout: "", stderr: "", error: "ENOENT" });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bridge-app-push-"));
  link = new LinkServer({ token: "token-0123456789abcdef0123456789abcdef" });
  await link.listen();
  fake = new FakePushService();
  await fake.start();
});

afterEach(async () => {
  for (const s of socks.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
  await link.close();
  await fake.stop();
  await rm(home, { recursive: true, force: true });
});

function http(method: string, path: string, headers: Record<string, string>, body?: string) {
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

it("subscribes over the socket, reports it, delivers, and drops it when the device is revoked", async () => {
  app = await startApp({
    appHome: home,
    home,
    link,
    port: 0,
    serve: { host: SERVE, login: OWNER },
    run: fakeRun,
    binaries: { hc: "fake-hc", inbox: "fake-inbox", usagebar: "fake-usagebar" },
    tailscale: "fake-tailscale",
    funnelCheckMs: 60_000,
    push: { allowEndpoint: (u) => u.startsWith(`http://127.0.0.1:${fake.port}/`), tickMs: 3_600_000 },
  });
  const { code } = app.security.issueCode();
  const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name: "Phone 1" }));
  const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
  app.security.approve(id);
  app.security.setCap(id, "push", true);
  const sc = r.headers["set-cookie"];
  const cookie = (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]!;

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { ...OK_GET, Origin: ORIGIN, Cookie: cookie } });
  socks.push(ws);
  await new Promise<void>((res, rej) => ws.once("open", () => res()).once("error", rej));
  const res = new Promise<bridgeApi.Res>((resolve) =>
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as bridgeApi.ServerMessage;
      if (m.type === "res") resolve(m);
    }),
  );
  ws.send(JSON.stringify({ type: "hello", api: 1 }));
  const ua = new FakeUa();
  ws.send(JSON.stringify({ type: "act", id: "a1", kind: "push.subscribe", args: { endpoint: fake.endpoint("/p1"), keys: ua.keys } }));
  expect(await res).toMatchObject({ ok: true });

  const info = await http("GET", "/api/v1/push", { ...OK_GET, Cookie: cookie });
  expect(bridgeApi.PushInfo.parse(JSON.parse(info.body))).toEqual({ key: app.push.publicKey, allowed: true, subscribed: true });

  // The hub's own topics feed the triggers: a panorama root turning blocked after the first look.
  const rich = (status: string) => ({
    mode: "rich",
    stale: false,
    aged: false,
    error: null,
    collected_at: 1,
    roots: [{ key: "r1", agent_id: null, space_id: null, terminal: null, live: false, shadowed: false, harness: "claude", title: "Agent 1", tab_no: null, status, inbox: [], hidden_finished: 0, last_activity: null, agents: [] }],
  });
  app.hub.publish("panorama", rich("run"));
  await app.push.tick();
  app.hub.publish("panorama", rich("blk"));
  await app.push.tick();
  expect(fake.received).toHaveLength(1);
  expect(JSON.parse(ua.decrypt(fake.received[0]!.body))).toMatchObject({ title: "Agent 1 is blocked" });

  app.security.revoke(id);
  expect(app.push.subscribed(id)).toBe(false);
});
