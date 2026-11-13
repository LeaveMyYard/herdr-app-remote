import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { createBridgeServer, type BridgeServer } from "../src/server.js";
import type { ActHandler, Hub } from "../src/hub.js";
import {
  CLOSE_NO_VIEW,
  CLOSE_PAUSED,
  CLOSE_REVOKED,
  ACT_LIMIT,
  CODE_TTL_MS,
  CONNECT_LIMIT,
  KIND_LIMITS,
  ACTION_CAPS,
  MAX_PENDING,
  PAIR_FAIL_LIMIT,
  PENDING_TTL_MS,
  Security,
  TOPIC_REFUSAL_LOG_LIMIT,
  topicCaps,
} from "../src/security/index.js";
import { newHub } from "./helpers.js";

/** Fake tailnet identity: the serve name and the owner's login. */
const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;

let dir: string;
let sec: Security;
let srv: BridgeServer;
let hub: Hub;
let port: number;
let clock: number;
let acts: { kind: string; args: Record<string, unknown> }[];

async function start(opts: { inner?: ActHandler | null } = {}) {
  acts = [];
  const inner: ActHandler =
    opts.inner ??
    ((_c, kind, args) => {
      acts.push({ kind, args });
      // Stands in for S11 resolving the chosen option's label from inbox data.
      return kind === "inbox.answer" ? { ok: true, audit_label: "Option B" } : { ok: true };
    });
  sec = new Security({
    dataDir: join(dir, "data"),
    serve: { host: SERVE, login: OWNER },
    now: () => clock,
    ...(opts.inner === null ? {} : { inner }),
  });
  hub = newHub({ onAct: sec.act });
  srv = createBridgeServer({ hub, guard: sec.guard, routes: sec.routes, onConnect: sec.onConnect });
  port = (await srv.listen()).port;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-sec-"));
  clock = 1_000_000;
});
afterEach(async () => {
  sec?.close();
  await srv?.close();
  await rm(dir, { recursive: true, force: true });
});

// ---- raw HTTP, so every header (Host included) is under the test's control ----

type Headers = Record<string, string | string[] | undefined>;
interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** The headers `tailscale serve` adds for the owner's own device. */
const OK_GET: Headers = { Host: SERVE, "Tailscale-User-Login": OWNER };
const OK_POST: Headers = { ...OK_GET, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" };

function http(method: string, path: string, headers: Headers, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const r = request({ host: "127.0.0.1", port, method, path, headers: h, setHost: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const cookieOf = (r: Resp): string => {
  const sc = r.headers["set-cookie"];
  const first = Array.isArray(sc) ? sc[0] : sc;
  return (first ?? "").split(";")[0]!;
};

function pair(code: string, headers: Headers = OK_POST, name?: string): Promise<Resp> {
  return http("POST", "/api/v1/pair", headers, JSON.stringify(name ? { code, name } : { code }));
}

/** Pairs and approves a device; returns its cookie and id. */
async function pairedDevice(name = "Phone 1"): Promise<{ cookie: string; id: string }> {
  const { code } = sec.issueCode();
  const r = await pair(code, OK_POST, name);
  expect(r.status).toBe(202);
  const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
  sec.approve(id);
  return { cookie: cookieOf(r), id };
}

interface Sock {
  ws: WebSocket;
  msgs: bridgeApi.ServerMessage[];
  next: (n: number) => Promise<void>;
  closed: Promise<number>;
}

/** Opens the WS with what a browser controls: its cookies and Origin, plus subprotocols. */
function ws(headers: Headers, protocols: string[] = [bridgeApi.WS_PROTOCOL]): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (typeof v === "string") h[k] = v;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, protocols, { headers: h });
    const msgs: bridgeApi.ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    sock.on("message", (d) => {
      msgs.push(JSON.parse(d.toString()) as bridgeApi.ServerMessage);
      waiters.forEach((w) => w());
    });
    const next = (n: number) =>
      new Promise<void>((res) => {
        const check = () => msgs.length >= n && res();
        waiters.push(check);
        check();
      });
    const closed = new Promise<number>((r) => sock.once("close", (c) => r(c)));
    sock.once("open", () => resolve({ ws: sock, msgs, next, closed }));
    sock.once("unexpected-response", (_r, resp) => reject(new Error(`status ${resp.statusCode}`)));
    sock.once("error", reject);
  });
}

const wsHeaders = (cookie: string): Headers => ({ ...OK_GET, Origin: ORIGIN, Cookie: cookie });

async function greeted(cookie: string): Promise<Sock> {
  const s = await ws(wsHeaders(cookie));
  s.ws.send(JSON.stringify({ type: "hello", api: 1 }));
  await s.next(1);
  return s;
}

async function act(s: Sock, kind: string, args: Record<string, unknown> = {}): Promise<bridgeApi.Res> {
  const before = s.msgs.length;
  const id = `a${before}`;
  s.ws.send(JSON.stringify({ type: "act", id, kind, args }));
  await s.next(before + 1);
  return s.msgs[before] as bridgeApi.Res;
}

const activity = () => sec.activity(1000).map((e) => e.text);

// ---- the attack cases from PLAN §6 S5 ----

describe("attack: Host spoof (DNS rebinding)", () => {
  it("refuses a foreign Host on GET, POST and the WS upgrade, even with a valid cookie", async () => {
    await start();
    const { cookie } = await pairedDevice();
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(200);
    for (const host of ["evil.example", `${SERVE}.evil.example`, "127.0.0.1", `${SERVE}:1234`]) {
      expect((await http("GET", "/api/v1/meta", { ...OK_GET, Host: host })).status).toBe(403);
      expect((await http("GET", "/api/v1/me", { ...OK_GET, Host: host, Cookie: cookie })).status).toBe(403);
      const { code } = sec.issueCode();
      expect((await pair(code, { ...OK_POST, Host: host })).status).toBe(403);
      await expect(ws({ ...wsHeaders(cookie), Host: host })).rejects.toThrow(/403/);
    }
    await (await greeted(cookie)).ws.close();
  });

  it("refuses a missing or duplicated Host", async () => {
    await start();
    // Node itself answers 400 to HTTP/1.1 without a Host; the guard would say 403.
    expect([400, 403]).toContain((await http("GET", "/api/v1/meta", { ...OK_GET, Host: undefined })).status);
    const { connect } = await import("node:net");
    const rawGet = (hosts: string[]) =>
      new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1");
        let out = "";
        sock.on("data", (d) => (out += d.toString()));
        sock.on("close", () => resolve(out));
        sock.on("error", () => undefined);
        const hs = hosts.map((h) => `Host: ${h}\r\n`).join("");
        sock.write(`GET /api/v1/meta HTTP/1.1\r\n${hs}Tailscale-User-Login: ${OWNER}\r\nConnection: close\r\n\r\n`);
      });
    expect(await rawGet([SERVE])).toMatch(/^HTTP\/1.1 200/);
    expect(await rawGet([SERVE, "evil.example"])).toMatch(/^HTTP\/1.1 (400|403)/);
    expect(await rawGet(["evil.example", SERVE])).toMatch(/^HTTP\/1.1 (400|403)/);
    expect(await rawGet([SERVE, SERVE])).toMatch(/^HTTP\/1.1 (400|403)/);
  });
});

describe("attack: missing identity", () => {
  it("refuses requests without Tailscale-User-Login, cookie or not", async () => {
    await start();
    const { cookie } = await pairedDevice();
    const noId = { Host: SERVE };
    expect((await http("GET", "/", noId)).status).toBe(403);
    expect((await http("GET", "/api/v1/me", { ...noId, Cookie: cookie })).status).toBe(403);
    expect((await http("GET", "/api/v1/me", { ...noId, "Tailscale-User-Login": "", Cookie: cookie })).status).toBe(403);
    const { code } = sec.issueCode();
    expect((await pair(code, { ...OK_POST, "Tailscale-User-Login": undefined })).status).toBe(403);
    await expect(ws({ ...wsHeaders(cookie), "Tailscale-User-Login": undefined })).rejects.toThrow(/403/);
    // The same code still works for the real owner: the refused attempt didn't consume it.
    expect((await pair(code)).status).toBe(202);
  });
});

describe("attack: wrong login", () => {
  it("refuses another tailnet user, and a duplicated login header", async () => {
    await start();
    const { cookie } = await pairedDevice();
    for (const login of ["user-2@example", "USER-1@example", `x${OWNER}`, `${OWNER}, user-2@example`]) {
      const h = { ...wsHeaders(cookie), "Tailscale-User-Login": login };
      expect((await http("GET", "/api/v1/me", h)).status).toBe(403);
      await expect(ws(h)).rejects.toThrow(/403/);
    }
    expect((await http("GET", "/api/v1/me", { ...OK_GET, "Tailscale-User-Login": [OWNER, "user-2@example"], Cookie: cookie })).status).toBe(403);
  });

  it("a device paired under one owner login stops working when the owner login changes", async () => {
    await start();
    const { cookie } = await pairedDevice();
    sec.setServe({ host: SERVE, login: "user-2@example" });
    const h = { ...wsHeaders(cookie), "Tailscale-User-Login": "user-2@example" };
    expect((await http("GET", "/api/v1/me", h)).status).toBe(401);
    await expect(ws(h)).rejects.toThrow(/401/);
  });
});

describe("attack: tagged device", () => {
  it("a tagged node sends no identity headers and is refused everywhere", async () => {
    await start();
    const { cookie } = await pairedDevice();
    // What serve forwards for a tagged source: the request, but no Tailscale-User-* headers.
    const tagged: Headers = { Host: SERVE, Origin: ORIGIN, "X-Remote-Api": "1", Cookie: cookie };
    expect((await http("GET", "/", tagged)).status).toBe(403);
    expect((await http("GET", "/api/v1/meta", tagged)).status).toBe(403);
    expect((await http("GET", "/api/v1/me", tagged)).status).toBe(403);
    const { code } = sec.issueCode();
    expect((await pair(code, { ...tagged, "Content-Type": "application/json" })).status).toBe(403);
    await expect(ws(tagged)).rejects.toThrow(/403/);
  });
});

describe("attack: replayed pairing code", () => {
  it("a code works once; a replay, an expired code and a superseded code are refused", async () => {
    await start();
    const first = sec.issueCode();
    expect((await pair(first.code)).status).toBe(202);
    const replay = await pair(first.code);
    expect(replay.status).toBe(403);
    expect(JSON.parse(replay.body)).toEqual({ error: "bad_code" });
    expect(replay.headers["set-cookie"]).toBeUndefined();

    const old = sec.issueCode();
    sec.issueCode();
    expect((await pair(old.code)).status).toBe(403);

    const late = sec.issueCode();
    clock += CODE_TTL_MS;
    expect((await pair(late.code)).status).toBe(403);
    expect(activity()).toContain("Pairing refused: invalid or used code");
  });

  it("guessing is rate limited", async () => {
    await start();
    const { code } = sec.issueCode();
    for (let i = 0; i < PAIR_FAIL_LIMIT; i++) expect((await pair("A".repeat(22))).status).toBe(403);
    expect((await pair(code)).status).toBe(429);
    clock += 60_000;
    expect((await pair(code)).status).toBe(202);
  });
});

describe("attack: CSRF", () => {
  it("pairing needs the exact Origin and X-Remote-Api", async () => {
    await start();
    const { code } = sec.issueCode();
    for (const h of [
      { ...OK_POST, Origin: "https://evil.example" },
      { ...OK_POST, Origin: "null" },
      { ...OK_POST, Origin: `http://${SERVE}` },
      { ...OK_POST, Origin: undefined },
      { ...OK_POST, "X-Remote-Api": undefined },
      { ...OK_POST, "X-Remote-Api": "0" },
    ]) {
      expect((await pair(code, h)).status).toBe(403);
    }
    // A form post can't send JSON with a custom header; plain text bodies are refused too.
    expect((await http("POST", "/api/v1/pair", { ...OK_POST, "Content-Type": "text/plain" }, JSON.stringify({ code }))).status).toBe(415);
    expect((await pair(code)).status).toBe(202);
  });

  it("the WS upgrade needs Origin, the herdr-remote.v1 subprotocol and an approved device cookie", async () => {
    await start();
    const { cookie } = await pairedDevice();
    await expect(ws({ ...wsHeaders(cookie), Origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(ws({ ...wsHeaders(cookie), Origin: undefined })).rejects.toThrow(/403/);
    // Browsers can't set X-Remote-Api on an upgrade; the subprotocol is the marker instead.
    await expect(ws({ ...wsHeaders(cookie), "X-Remote-Api": "1" }, [])).rejects.toThrow(/403/);
    await expect(ws(wsHeaders(cookie), ["herdr-remote.v2"])).rejects.toThrow(/403/);
    await expect(ws(wsHeaders(cookie), ["chat"])).rejects.toThrow(/403/);
    await expect(ws({ ...wsHeaders(cookie), Cookie: undefined })).rejects.toThrow(/401/);
    await expect(ws({ ...wsHeaders(cookie), Cookie: "__Host-hr-device=" + "A".repeat(43) })).rejects.toThrow(/401/);
    await expect(ws({ ...wsHeaders(cookie), Cookie: `${cookie}; ${cookie}` })).rejects.toThrow(/401/);
    const ok = await ws(wsHeaders(cookie), ["chat", bridgeApi.WS_PROTOCOL]);
    expect(ok.ws.protocol).toBe(bridgeApi.WS_PROTOCOL);
    ok.ws.close();
  });

  it("oversized and malformed pairing bodies are refused without hurting the server", async () => {
    await start();
    const uncaught: unknown[] = [];
    const onErr = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onErr);
    try {
      const big = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code: "x".repeat(64 * 1024) })).catch(() => ({ status: -1 }));
      expect([413, -1]).toContain(big.status);
      expect((await http("POST", "/api/v1/pair", OK_POST, "{bad")).status).toBe(400);
      expect((await http("POST", "/api/v1/pair", OK_POST, "[1]")).status).toBe(400);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", onErr);
    }
    expect(uncaught).toEqual([]);
    expect((await pair(sec.issueCode().code)).status).toBe(202);
  });

  it("preflight and other non-GET methods are refused", async () => {
    await start();
    expect((await http("OPTIONS", "/api/v1/pair", { ...OK_GET, Origin: "https://evil.example" })).status).toBe(403);
    const { cookie } = await pairedDevice();
    expect((await http("PUT", "/api/v1/me", { ...OK_POST, Cookie: cookie })).status).toBe(405);
    expect((await http("GET", "/api/v1/pair", OK_GET)).status).toBe(405);
  });

  it("the device cookie is __Host-, HttpOnly, Secure, SameSite=Strict", async () => {
    await start();
    const { code } = sec.issueCode();
    const r = await pair(code);
    const sc = String(r.headers["set-cookie"]);
    expect(sc).toMatch(/^__Host-hr-device=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict"]) expect(sc).toContain(attr);
    expect(sc).not.toMatch(/Domain=/i);
  });
});

describe("attack: revoked device", () => {
  it("revoke drops the live socket and the cookie stops working", async () => {
    await start();
    const { cookie, id } = await pairedDevice();
    const s = await greeted(cookie);
    expect(sec.devices().find((d) => d.id === id)?.live).toBe(1);
    sec.revoke(id);
    expect(await s.closed).toBe(CLOSE_REVOKED);
    await expect(ws(wsHeaders(cookie))).rejects.toThrow(/401/);
    expect((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie })).status).toBe(401);
    expect(activity()).toContain("Phone 1 revoked");
  });

  it("revoke, pause and view-off drop live sockets even when devices.json can't be written", async () => {
    await start();
    const a = await pairedDevice("Phone 1");
    const b = await pairedDevice("Phone 2");
    const c = await pairedDevice("Phone 3");
    const [sa, sb, sc] = [await greeted(a.cookie), await greeted(b.cookie), await greeted(c.cookie)];
    const data = join(dir, "data");
    await chmod(data, 0o500);
    try {
      expect(() => sec.revoke(a.id)).toThrow();
      expect(await sa.closed).toBe(CLOSE_REVOKED);
      await expect(ws(wsHeaders(a.cookie))).rejects.toThrow(/401/);
      expect(() => sec.setCap(b.id, "view", false)).toThrow();
      expect(await sb.closed).toBe(CLOSE_NO_VIEW);
      expect(() => sec.pause()).toThrow();
      expect(await sc.closed).toBe(CLOSE_PAUSED);
      expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(503);
    } finally {
      await chmod(data, 0o700);
    }
  });

  it("changing or clearing serve drops live sockets", async () => {
    await start();
    const { cookie } = await pairedDevice();
    const s1 = await greeted(cookie);
    sec.setServe({ host: SERVE, login: OWNER });
    const s2 = await greeted(cookie);
    expect(s1.ws.readyState).toBe(WebSocket.OPEN);
    sec.setServe({ host: SERVE, login: "user-2@example" });
    expect(await s1.closed).toBe(CLOSE_REVOKED);
    expect(await s2.closed).toBe(CLOSE_REVOKED);
    sec.setServe({ host: SERVE, login: OWNER });
    const s3 = await greeted(cookie);
    sec.setServe(null);
    expect(await s3.closed).toBe(CLOSE_REVOKED);
  });

  it("onConnect re-checks the device: stale principals are closed at once", async () => {
    await start();
    const { id } = await pairedDevice();
    const r = await pair(sec.issueCode().code);
    const pendingId = (JSON.parse(r.body) as { device: { id: string } }).device.id;
    const closes: number[] = [];
    const client = (deviceId: string) => ({ principal: { deviceId }, send: () => undefined, close: (c: number) => void closes.push(c) });
    sec.onConnect(client(pendingId));
    sec.onConnect(client("d-0000000000000000"));
    sec.setCap(id, "view", false);
    sec.onConnect(client(id));
    sec.setCap(id, "view", true);
    sec.pause();
    sec.onConnect(client(id));
    expect(closes).toEqual([CLOSE_REVOKED, CLOSE_REVOKED, CLOSE_REVOKED, CLOSE_PAUSED]);
    expect(sec.devices().every((d) => d.live === 0)).toBe(true);
  });

  it("turning view off drops the live socket and refuses new ones", async () => {
    await start();
    const { cookie, id } = await pairedDevice();
    const s = await greeted(cookie);
    sec.setCap(id, "view", false);
    expect(await s.closed).toBe(CLOSE_NO_VIEW);
    await expect(ws(wsHeaders(cookie))).rejects.toThrow(/403/);
  });
});

// ---- pairing state machine end to end ----

describe("pairing", () => {
  it("code → pending → approved, with the cookie granting nothing until approval", async () => {
    const pending: string[] = [];
    await start();
    // Re-create with an onPending listener.
    await srv.close();
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, onPending: (d) => pending.push(d.name) });
    hub = newHub({ onAct: sec.act });
    srv = createBridgeServer({ hub, guard: sec.guard, routes: sec.routes, onConnect: sec.onConnect });
    port = (await srv.listen()).port;

    const issued = sec.issueCode();
    expect(issued.url).toMatch(new RegExp(`^https://${SERVE.replace(/\./g, "\\.")}/pair#c=[A-Za-z0-9_-]{22}$`));
    expect(issued.svg.startsWith("<svg")).toBe(true);

    // The phone-chosen name never reaches the pending row, the listener or Activity.
    const r = await pair(issued.code, OK_POST, "Evil Name\n1\u0000");
    expect(r.status).toBe(202);
    expect(r.body).not.toContain("Evil");
    expect(activity().join("\n")).not.toContain("Evil");
    const body = JSON.parse(r.body) as { device: { id: string; name: string; state: string } };
    expect(body.device).toMatchObject({ name: "Phone 1", state: "pending" });
    expect(pending).toEqual(["Phone 1"]);
    const cookie = cookieOf(r);

    const me = await http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie });
    expect(JSON.parse(me.body)).toMatchObject({ device: { state: "pending", caps: { view: false } } });
    await expect(ws(wsHeaders(cookie))).rejects.toThrow(/401/);

    sec.approve(body.device.id);
    const me2 = JSON.parse((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie })).body) as { device: { state: string; caps: Record<string, boolean> } };
    expect(me2.device.state).toBe("approved");
    expect(me2.device.caps).toEqual({ view: true, "inbox.answer": true, navigate: false, "terminal.input": false, "terminal.keys": false, push: false, "transcript.read": false });
    (await greeted(cookie)).ws.close();

    // Only the token's hash is stored, in a 0600 file.
    const file = join(dir, "data", "devices.json");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(cookie.split("=")[1]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("a pending request expires; the queue of pending requests is capped", async () => {
    await start();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      const r = await pair(sec.issueCode().code);
      expect(r.status).toBe(202);
      ids.push((JSON.parse(r.body) as { device: { id: string } }).device.id);
    }
    const { code } = sec.issueCode();
    expect((await pair(code)).status).toBe(429);
    // The 429 did not consume the code: once there is room, it still works.
    sec.revoke(ids.pop()!);
    expect((await pair(code)).status).toBe(202);
    clock += PENDING_TTL_MS;
    expect(sec.devices()).toEqual([]);
    expect(() => sec.approve(ids[0]!)).toThrow();
    expect(activity()).toContain("Phone 1: pairing request expired");
  });

  it("a pending cookie stops working at the pending deadline, before any sweep", async () => {
    await start();
    const r = await pair(sec.issueCode().code);
    const cookie = cookieOf(r);
    expect((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie })).status).toBe(200);
    clock += PENDING_TTL_MS - 1;
    expect((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie })).status).toBe(200);
    clock += 1;
    expect((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie })).status).toBe(401);
  });

  it("a phone-chosen name, long or odd, is ignored: the bridge names the device", async () => {
    await start();
    const r = await pair(sec.issueCode().code, OK_POST, "\u{1F600}".repeat(40));
    expect((JSON.parse(r.body) as { device: { name: string } }).device.name).toBe("Phone 1");
    expect(r.body).not.toContain("\u{1F600}");
    await srv.close();
    await start();
    expect(sec.devices().map((d) => d.name)).toEqual(["Phone 1"]);
  });

  it("default names count up, and rejecting a pending device removes it", async () => {
    await start();
    const a = await pair(sec.issueCode().code);
    const b = await pair(sec.issueCode().code);
    const [da, db] = [a, b].map((r) => (JSON.parse(r.body) as { device: { id: string; name: string } }).device);
    expect([da!.name, db!.name]).toEqual(["Phone 1", "Phone 2"]);
    sec.revoke(da!.id);
    expect(sec.devices().map((d) => d.name)).toEqual(["Phone 2"]);
    expect(activity()).toContain("Phone 1: pairing refused");
    sec.rename(db!.id, "Laptop 1");
    expect(sec.devices()[0]?.name).toBe("Laptop 1");
    // A client-chosen name is ignored; renames can't collide.
    const c = await pair(sec.issueCode().code, OK_POST, "Laptop 1");
    const dc = (JSON.parse(c.body) as { device: { id: string; name: string } }).device;
    expect(dc.name).toBe("Phone 1");
    expect(() => sec.rename(dc.id, "Laptop 1")).toThrow(/in use/);
  });

  it("terminal.input expiry must be a future integer", async () => {
    await start();
    const { id } = await pairedDevice();
    for (const bad of [clock, clock - 1, clock + 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => sec.setCap(id, "terminal.input", true, bad)).toThrow();
    }
    expect(() => sec.setCap(id, "navigate", true, clock + 10)).toThrow();
    sec.setCap(id, "terminal.input", true, clock + 10);
    expect(sec.devices()[0]?.terminal_input_until).toBe(clock + 10);
  });

  it("devices survive a bridge restart; revocations too", async () => {
    await start();
    const keep = await pairedDevice("Phone 1");
    const gone = await pairedDevice("Phone 2");
    sec.revoke(gone.id);
    await srv.close();
    await start();
    expect((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: keep.cookie })).status).toBe(200);
    expect((await http("GET", "/api/v1/me", { ...OK_GET, Cookie: gone.cookie })).status).toBe(401);
  });

  it("without serve configured, everything but /healthz is refused", async () => {
    await start();
    sec.setServe(null);
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
    expect((await http("GET", "/", OK_GET)).status).toBe(403);
    expect(() => sec.issueCode()).toThrow();
  });
});

// ---- capabilities and audit over a live socket ----

describe("capabilities", () => {
  it("each action needs its capability; unknown actions are refused and logged", async () => {
    await start();
    const { cookie, id } = await pairedDevice();
    const s = await greeted(cookie);
    const answered = await act(s, "inbox.answer", { key: "group:119", rev: "r", question: 119, label: "secret label", detail: { choices: [], notes: {}, text: "secret free text" } });
    expect(answered).toEqual({ type: "res", id: "a1", ok: true });
    expect(await act(s, "tab.select", { id: "t2" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await act(s, "terminal.send", { terminal: "t3", text: "ls -la secret" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await act(s, "push.subscribe", {})).toMatchObject({ ok: false, code: "forbidden" });
    for (const k of ["run", "exec", "app.do", "__proto__", "tab.new"]) {
      expect(await act(s, k, { cmd: "secret" })).toMatchObject({ ok: false, code: "unsupported_action" });
    }
    expect(acts.map((a) => a.kind)).toEqual(["inbox.answer"]);

    sec.setCap(id, "navigate", true);
    expect(await act(s, "tab.select", { id: "t2" })).toMatchObject({ ok: true });
    sec.setCap(id, "terminal.input", true, clock + 1000);
    expect(await act(s, "terminal.send", { terminal: "t3", text: "hello world!" })).toMatchObject({ ok: true });
    clock += 1000;
    expect(await act(s, "terminal.send", { terminal: "t3", text: "again" })).toMatchObject({ ok: false, code: "forbidden" });
    sec.setCap(id, "inbox.answer", false);
    expect(await act(s, "inbox.dismiss", { key: "group:1", question: 1 })).toMatchObject({ ok: false, code: "forbidden" });
    s.ws.close();
    await s.closed;

    const log = activity();
    expect(log).toContain("Phone 1 answered Q119 (Option B)");
    expect(log).toContain("Phone 1 sent 12 chars to t3");
    expect(log).toContain("Phone 1 tried exec: refused");
    expect(log).toContain("Phone 1 connected");
    const raw = await readFile(join(dir, "data", "activity.jsonl"), "utf8");
    expect(raw).not.toMatch(/secret|hello world|ls -la/);
    expect((await stat(join(dir, "data", "activity.jsonl"))).mode & 0o777).toBe(0o600);
    await new Promise((r) => setTimeout(r, 20));
    expect(activity()).toContain("Phone 1 disconnected");
  });

  it("allowlisted actions are refused while no handler is registered", async () => {
    await start({ inner: null });
    const { cookie } = await pairedDevice();
    const s = await greeted(cookie);
    expect(await act(s, "inbox.answer", { key: "group:1", question: 1 })).toMatchObject({ ok: false, code: "unsupported_action" });
    s.ws.close();
  });

  it("a throwing handler is an unknown effect, and is logged as such", async () => {
    await start({
      inner: () => {
        throw new Error("boom");
      },
    });
    const { cookie } = await pairedDevice();
    const s = await greeted(cookie);
    expect(await act(s, "inbox.ack", { key: "alert:1" })).toEqual({ type: "res", id: "a1", ok: false, code: "internal_error", unknown_effect: true });
    expect(activity()).toContain("Phone 1 acknowledged A1: result unknown");
    s.ws.close();
  });

  it("every act re-checks the device, so a revoked one is refused and closed", async () => {
    await start();
    const { id } = await pairedDevice();
    const closes: number[] = [];
    const client = { principal: { deviceId: id }, send: () => undefined, close: (c: number) => void closes.push(c) };
    expect(await sec.act(client, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: true });
    sec.revoke(id);
    expect(await sec.act(client, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: false, code: "unpaired" });
    expect(closes).toEqual([CLOSE_REVOKED]);
    expect(acts).toHaveLength(1);
  });

  it("a dropped client can't act while its close is pending, and is terminated soon after", async () => {
    await start();
    const { id } = await pairedDevice();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const mk = () => {
        const c = { closes: [] as number[], terminated: 0 };
        const client = {
          principal: { deviceId: id },
          send: () => undefined,
          close: (code: number) => void c.closes.push(code),
          terminate: () => void (c.terminated += 1),
        };
        return { c, client };
      };
      // A peer that ignores the close frame keeps a readable socket: view off must still stop it.
      const a = mk();
      sec.onConnect(a.client);
      sec.setCap(id, "view", false);
      expect(a.c.closes).toEqual([CLOSE_NO_VIEW]);
      expect(await sec.act(a.client, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: false, code: "unpaired" });
      expect(a.c.terminated).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(a.c.terminated).toBe(1);
      sec.setCap(id, "view", true);

      // Same login, new serve host: the old socket is dropped and can't act either.
      const b = mk();
      sec.onConnect(b.client);
      sec.setServe({ host: "desk-2.example-tailnet.ts.net", login: OWNER });
      expect(b.c.closes).toEqual([CLOSE_REVOKED]);
      expect(await sec.act(b.client, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: false, code: "unpaired" });
      // A fresh connection of the same device is fine.
      const c = mk();
      sec.onConnect(c.client);
      expect(await sec.act(c.client, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: true });
      expect(acts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an act from a device of a previous owner login, or still pending, is refused", async () => {
    await start();
    const { id } = await pairedDevice();
    const client = { principal: { deviceId: id }, send: () => undefined, close: () => undefined };
    sec.setServe({ host: SERVE, login: "user-2@example" });
    expect(await sec.act(client, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: false, code: "unpaired" });
    sec.setServe({ host: SERVE, login: OWNER });
    const r = await pair(sec.issueCode().code);
    const pendingId = (JSON.parse(r.body) as { device: { id: string } }).device.id;
    expect(await sec.act({ ...client, principal: { deviceId: pendingId } }, "inbox.ack", {})).toMatchObject({ ok: false, code: "unpaired" });
    expect(acts).toHaveLength(0);
  });
});

describe("pause", () => {
  it("refuses everything except /healthz, drops live sockets, and persists", async () => {
    await start();
    const { cookie } = await pairedDevice();
    const s = await greeted(cookie);
    sec.pause();
    expect(await s.closed).toBe(CLOSE_PAUSED);
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
    for (const p of ["/", "/api/v1/meta", "/api/v1/me"]) expect((await http("GET", p, { ...OK_GET, Cookie: cookie })).status).toBe(503);
    await expect(ws(wsHeaders(cookie))).rejects.toThrow(/503/);
    expect(() => sec.issueCode()).toThrow(/paused/);
    expect(await sec.act({ principal: { deviceId: "d-0000000000000000" }, send: () => undefined, close: () => undefined }, "inbox.ack", {})).toMatchObject({ code: "paused" });

    await srv.close();
    await start();
    expect(sec.paused).toBe(true);
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(503);
    sec.resume();
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(200);
    expect(activity()).toEqual(expect.arrayContaining(["Remote access paused", "Remote access resumed"]));
  });

  it("/healthz is exempt only for GET", async () => {
    await start();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
    expect((await http("POST", "/healthz", { Host: "127.0.0.1" })).status).toBe(403);
  });
});

// ---- S16: terminal input expiry, rate limits, audit health ----

describe("terminal.input expiry (S16)", () => {
  const client = (id: string) => ({ principal: { deviceId: id }, send: () => undefined, close: () => undefined });

  it("is turned off when its time is up: in devices.json, in Activity and for the panel", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const changed = vi.fn();
      await start();
      const { id } = await pairedDevice();
      sec.close();
      sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: (_c, kind, args) => (acts.push({ kind, args }), { ok: true }), onChange: changed });
      sec.setCap(id, "terminal.input", true, clock + 60_000);
      expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "hi" })).toMatchObject({ ok: true });
      changed.mockClear();
      clock += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(changed).toHaveBeenCalled();
      expect(activity()).toContain("Phone 1: terminal.input expired");
      const stored = JSON.parse(await readFile(join(dir, "data", "devices.json"), "utf8")) as { devices: { caps: Record<string, unknown> }[] };
      expect(stored.devices[0]?.caps).toMatchObject({ "terminal.input": false, "terminal.input.until": null });
      expect(sec.devices()[0]).toMatchObject({ terminal_input_until: null, caps: { "terminal.input": false } });
      expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "hi" })).toMatchObject({ ok: false, code: "forbidden" });
      expect(acts).toHaveLength(1);
    } finally {
      sec.close();
      vi.useRealTimers();
    }
  });

  it("a grant that ran out while the bridge was down is off at start", async () => {
    await start();
    const { id } = await pairedDevice();
    sec.setCap(id, "terminal.input", true, clock + 1000);
    sec.close();
    await srv.close();
    clock += 5000;
    await start();
    expect(activity()).toContain("Phone 1: terminal.input expired");
    const stored = JSON.parse(await readFile(join(dir, "data", "devices.json"), "utf8")) as { devices: { caps: Record<string, unknown> }[] };
    expect(stored.devices[0]?.caps["terminal.input"]).toBe(false);
    sec.close();
  });

  it("turning it off, or on with no limit, disarms the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await start();
      const { id } = await pairedDevice();
      sec.setCap(id, "terminal.input", true, clock + 1000);
      sec.setCap(id, "terminal.input", true);
      clock += 2000;
      vi.advanceTimersByTime(2000);
      expect(activity()).not.toContain("Phone 1: terminal.input expired");
      expect(sec.devices()[0]?.caps["terminal.input"]).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sec.close();
      vi.useRealTimers();
    }
  });
});

describe("rate limits (S16, owed from S5)", () => {
  const client = (id: string) => ({ principal: { deviceId: id }, send: () => undefined, close: () => undefined });

  it("an act loop is refused past the limit, with one Activity line per window, and recovers", async () => {
    await start();
    const { id } = await pairedDevice();
    const c = client(id);
    for (let i = 0; i < ACT_LIMIT.max; i++) expect(await sec.act(c, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: true });
    const before = activity().length;
    for (let i = 0; i < 20; i++) expect(await sec.act(c, i % 2 ? "inbox.ack" : "exec", { cmd: "x" })).toMatchObject({ ok: false, code: "rate_limited" });
    const added = activity().slice(before);
    expect(added).toEqual(["Phone 1 sent actions too fast: refused"]);
    expect(acts).toHaveLength(ACT_LIMIT.max);
    clock += ACT_LIMIT.windowMs;
    expect(await sec.act(c, "inbox.ack", { key: "alert:1" })).toMatchObject({ ok: true });
  });

  it("one device's loop does not limit another", async () => {
    await start();
    const a = await pairedDevice("Phone 1");
    const b = await pairedDevice("Phone 2");
    for (let i = 0; i <= ACT_LIMIT.max; i++) await sec.act(client(a.id), "inbox.ack", {});
    expect(await sec.act(client(a.id), "inbox.ack", {})).toMatchObject({ code: "rate_limited" });
    expect(await sec.act(client(b.id), "inbox.ack", {})).toMatchObject({ ok: true });
  });

  it("terminal.send has its own tighter limit, counted only once the capability allows it", async () => {
    await start();
    const { id } = await pairedDevice();
    const c = client(id);
    const max = KIND_LIMITS.get("terminal.send")!.max;
    // Refused sends (capability off) don't use up the send window.
    for (let i = 0; i < 3; i++) expect(await sec.act(c, "terminal.send", { terminal: "t3", text: "x" })).toMatchObject({ code: "forbidden" });
    sec.setCap(id, "terminal.input", true);
    for (let i = 0; i < max; i++) expect(await sec.act(c, "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: true });
    expect(await sec.act(c, "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await sec.act(c, "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(acts.filter((a) => a.kind === "terminal.send")).toHaveLength(max);
    expect(activity().filter((t) => t === "Phone 1 terminal.send: too fast, refused")).toHaveLength(1);
    // Other kinds are not held back by it.
    expect(await sec.act(c, "inbox.ack", {})).toMatchObject({ ok: true });
    clock += KIND_LIMITS.get("terminal.send")!.windowMs;
    expect(await sec.act(c, "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: true });
    expect(activity()).toContain("Phone 1 sent 5 chars to t3");
  });

  it("a reconnect loop gets 429 past the limit, logged once, and only for that device", async () => {
    await start();
    const a = await pairedDevice("Phone 1");
    const b = await pairedDevice("Phone 2");
    for (let i = 0; i < CONNECT_LIMIT.max; i++) {
      const s = await ws(wsHeaders(a.cookie));
      s.ws.close();
      await s.closed;
    }
    await expect(ws(wsHeaders(a.cookie))).rejects.toThrow(/429/);
    await expect(ws(wsHeaders(a.cookie))).rejects.toThrow(/429/);
    expect(activity().filter((t) => t === "Phone 1 reconnected too often: refused for a minute")).toHaveLength(1);
    const other = await ws(wsHeaders(b.cookie));
    other.ws.close();
    await other.closed;
    clock += CONNECT_LIMIT.windowMs;
    const again = await ws(wsHeaders(a.cookie));
    again.ws.close();
    await again.closed;
  });

});

describe("audit health (S16, owed from S5)", () => {
  const client = (id: string) => ({ principal: { deviceId: id }, send: () => undefined, close: () => undefined });
  const breakLog = async () => {
    const f = join(dir, "data", "activity.jsonl");
    await rm(f, { force: true });
    // A directory where the file should be: every append fails with EISDIR.
    await import("node:fs/promises").then((fs) => fs.mkdir(f));
  };
  const fixLog = () => rm(join(dir, "data", "activity.jsonl"), { recursive: true, force: true });

  it("a failed write is flagged, refuses terminal.send until a line goes through, and clears", async () => {
    const health = vi.fn();
    await start();
    const { id } = await pairedDevice();
    sec.close();
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: (_c, kind, args) => (acts.push({ kind, args }), { ok: true }), onAuditHealth: health });
    sec.setCap(id, "terminal.input", true);
    expect(sec.auditHealth).toEqual({ ok: true, since: null, failures: 0 });
    await breakLog();
    // The act itself still completes (the decision was made); its lost line is flagged.
    expect(await sec.act(client(id), "inbox.ack", {})).toMatchObject({ ok: true });
    expect(sec.auditHealth).toMatchObject({ ok: false, since: clock, failures: 1 });
    expect(health).toHaveBeenLastCalledWith({ ok: false, since: clock, failures: 1 });
    // terminal.send's only safeguard is its audit line: refused while the log is failing.
    expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: false, code: "audit_unavailable" });
    expect(acts.filter((a) => a.kind === "terminal.send")).toHaveLength(0);
    expect(sec.auditHealth.failures).toBe(2);
    await fixLog();
    // The next refusal line goes through: the flag clears and the following send runs.
    expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: false, code: "audit_unavailable" });
    expect(sec.auditHealth.ok).toBe(true);
    expect(health).toHaveBeenLastCalledWith({ ok: true, since: null, failures: 0 });
    expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "hello" })).toMatchObject({ ok: true });
    expect(activity()).toContain("Phone 1 sent 5 chars to t3");
    sec.close();
  });

  it("a refusal whose line can't be written is still a refusal, not an internal error", async () => {
    await start();
    const { id } = await pairedDevice();
    await breakLog();
    expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "x" })).toEqual({ ok: false, code: "forbidden" });
    expect(await sec.act(client(id), "exec", {})).toEqual({ ok: false, code: "unsupported_action" });
    expect(sec.auditHealth.ok).toBe(false);
    await fixLog();
  });
});

describe("cutting a device's sends in flight (S16)", () => {
  it("tells the app when a device may no longer type, before anything is written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cuts: (string | null)[] = [];
      await start();
      const a = await pairedDevice("Phone 1");
      const b = await pairedDevice("Phone 2");
      sec.close();
      sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, onCut: (id) => cuts.push(id) });
      // Setting the first serve identity counts as a change (nothing can be in flight yet).
      cuts.length = 0;
      sec.setCap(a.id, "navigate", false);
      sec.setCap(a.id, "terminal.input", true, clock + 1000);
      expect(cuts).toEqual([]);
      sec.setCap(a.id, "terminal.input", false);
      sec.setCap(a.id, "view", false);
      sec.setCap(b.id, "terminal.input", true, clock + 1000);
      clock += 1000;
      vi.advanceTimersByTime(1000);
      sec.revoke(b.id);
      sec.pause();
      sec.resume();
      sec.setServe({ host: SERVE, login: "user-2@example" });
      expect(cuts).toEqual([a.id, a.id, b.id, b.id, null, null]);
    } finally {
      sec.close();
      vi.useRealTimers();
    }
  });
});

// ---- S16b: terminal.keys, a capability of its own ----

describe("terminal.keys (S16b)", () => {
  const client = (id: string) => ({ principal: { deviceId: id }, send: () => undefined, close: () => undefined });
  const PRESS = { terminal: "t3", key: "ctrl-c", rev: "0123456789abcdef" };
  /** Stands in for the keys actor: it resolves the entry and names it for Activity. */
  const keysInner: ActHandler = (_c, kind, args) => {
    acts.push({ kind, args });
    return kind === "terminal.keys" ? { ok: true, audit_label: "ctrl-c (1 key)" } : { ok: true };
  };
  async function startWith(extra: Partial<ConstructorParameters<typeof Security>[0]> = {}) {
    await start();
    const { id } = await pairedDevice();
    sec.close();
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: keysInner, ...extra });
    return id;
  }

  it("is off after approval, refused while off, and the refusal names no key", async () => {
    const id = await startWith();
    expect(sec.devices()[0]).toMatchObject({ caps: { "terminal.keys": false }, terminal_keys_until: null });
    expect(await sec.act(client(id), "terminal.keys", { ...PRESS, key: "secretword" })).toEqual({ ok: false, code: "forbidden" });
    expect(acts).toHaveLength(0);
    expect(activity()).toContain("Phone 1 pressed a key in t3: refused");
    expect(JSON.stringify(sec.activity(1000))).not.toContain("secretword");
  });

  it("is separate from terminal.input both ways", async () => {
    const id = await startWith();
    sec.setCap(id, "terminal.input", true);
    expect(await sec.act(client(id), "terminal.keys", PRESS)).toMatchObject({ ok: false, code: "forbidden" });
    sec.setCap(id, "terminal.input", false);
    sec.setCap(id, "terminal.keys", true);
    expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await sec.act(client(id), "terminal.keys", PRESS)).toEqual({ ok: true, audit_label: "ctrl-c (1 key)" });
    expect(acts.map((a) => a.kind)).toEqual(["terminal.keys"]);
    // Activity names the entry the bridge resolved (id and count), never what the client sent beyond the terminal.
    expect(activity()).toContain("Phone 1 pressed ctrl-c (1 key) in t3");
    expect(activity()).toContain("Phone 1: terminal.keys on");
  });

  it("expires by itself, and only it: Activity, devices.json, the panel, and a cut of keys alone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onCut = vi.fn();
      const id = await startWith({ onCut });
      sec.setCap(id, "terminal.input", true, clock + 120_000);
      sec.setCap(id, "terminal.keys", true, clock + 60_000);
      expect(sec.devices()[0]).toMatchObject({ terminal_keys_until: clock + 60_000, terminal_input_until: clock + 120_000 });
      expect(activity().some((t) => /^Phone 1: terminal\.keys on until \d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(t))).toBe(true);
      clock += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(activity()).toContain("Phone 1: terminal.keys expired");
      expect(activity()).not.toContain("Phone 1: terminal.input expired");
      expect(onCut).toHaveBeenCalledWith(id, "terminal.keys");
      expect(onCut).not.toHaveBeenCalledWith(id, "terminal.input");
      const stored = JSON.parse(await readFile(join(dir, "data", "devices.json"), "utf8")) as { devices: { caps: Record<string, unknown> }[] };
      expect(stored.devices[0]?.caps).toMatchObject({ "terminal.keys": false, "terminal.keys.until": null, "terminal.input": true });
      expect(await sec.act(client(id), "terminal.keys", PRESS)).toMatchObject({ code: "forbidden" });
      clock += 60_000;
      vi.advanceTimersByTime(60_000);
      expect(activity()).toContain("Phone 1: terminal.input expired");
      expect(onCut).toHaveBeenCalledWith(id, "terminal.input");
    } finally {
      sec.close();
      vi.useRealTimers();
    }
  });

  it("a keys grant that ran out while the bridge was down is off at start", async () => {
    const id = await startWith();
    sec.setCap(id, "terminal.keys", true, clock + 1000);
    sec.close();
    clock += 5000;
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: keysInner });
    expect(activity()).toContain("Phone 1: terminal.keys expired");
    expect(sec.devices()[0]?.caps["terminal.keys"]).toBe(false);
  });

  it("losing one capability cuts only its own work; losing the device or view cuts both", async () => {
    const onCut = vi.fn();
    const id = await startWith({ onCut });
    sec.setCap(id, "terminal.input", true);
    sec.setCap(id, "terminal.keys", true);
    sec.setCap(id, "terminal.keys", false);
    expect(onCut).toHaveBeenLastCalledWith(id, "terminal.keys");
    sec.setCap(id, "terminal.input", false);
    expect(onCut).toHaveBeenLastCalledWith(id, "terminal.input");
    sec.setCap(id, "view", false);
    expect(onCut.mock.lastCall).toEqual([id]);
    sec.revoke(id);
    expect(onCut.mock.lastCall).toEqual([id]);
  });

  it("only terminal.input and terminal.keys can expire", async () => {
    const id = await startWith();
    for (const cap of ["view", "navigate", "push", "inbox.answer"] as const) expect(() => sec.setCap(id, cap, true, clock + 1000)).toThrow();
    expect(() => sec.setCap(id, "terminal.keys", true, clock - 1)).toThrow();
  });

  it("has its own rate limit, counted only once the capability allows it", async () => {
    const id = await startWith();
    const c = client(id);
    const lim = KIND_LIMITS.get("terminal.keys")!;
    expect(lim).toEqual({ max: 10, windowMs: 10_000 });
    for (let i = 0; i < 3; i++) expect(await sec.act(c, "terminal.keys", PRESS)).toMatchObject({ code: "forbidden" });
    sec.setCap(id, "terminal.keys", true);
    for (let i = 0; i < lim.max; i++) expect(await sec.act(c, "terminal.keys", PRESS)).toMatchObject({ ok: true });
    expect(await sec.act(c, "terminal.keys", PRESS)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await sec.act(c, "terminal.keys", PRESS)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(acts).toHaveLength(lim.max);
    expect(activity().filter((t) => t === "Phone 1 terminal.keys: too fast, refused")).toHaveLength(1);
    clock += lim.windowMs;
    expect(await sec.act(c, "terminal.keys", PRESS)).toMatchObject({ ok: true });
  });

  it("is refused while Activity can't be written", async () => {
    const id = await startWith();
    sec.setCap(id, "terminal.keys", true);
    const f = join(dir, "data", "activity.jsonl");
    await rm(f, { force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(f));
    await sec.act(client(id), "inbox.ack", {});
    expect(sec.auditHealth.ok).toBe(false);
    expect(await sec.act(client(id), "terminal.keys", PRESS)).toEqual({ ok: false, code: "audit_unavailable" });
    expect(acts.filter((a) => a.kind === "terminal.keys")).toHaveLength(0);
  });

  it("a devices.json from before S16b loads, with terminal.keys off", async () => {
    const id = await startWith();
    sec.close();
    const p = join(dir, "data", "devices.json");
    const stored = JSON.parse(await readFile(p, "utf8")) as { devices: { caps: Record<string, unknown> }[] };
    delete stored.devices[0]!.caps["terminal.keys"];
    delete stored.devices[0]!.caps["terminal.keys.until"];
    await import("node:fs/promises").then((fs) => fs.writeFile(p, JSON.stringify(stored)));
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: keysInner });
    expect(sec.devices()[0]).toMatchObject({ id, caps: { "terminal.keys": false }, terminal_keys_until: null });
    expect(await sec.act(client(id), "terminal.keys", PRESS)).toMatchObject({ code: "forbidden" });
  });
});

// ---- CV1: transcript.read (chat history), a capability of its own ----

describe("transcript.read (CV1)", () => {
  async function startPaired() {
    const onTopicsCut = vi.fn();
    await start();
    const { id, cookie } = await pairedDevice();
    sec.close();
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: () => ({ ok: true }), onTopicsCut });
    return { id, cookie, onTopicsCut };
  }
  const client = (id: string) => ({ principal: { deviceId: id }, send: () => undefined, close: () => undefined });
  const TRANSCRIPT = ["chatview:t3", "timeline:t3"];
  const OTHERS = ["host", "plugins", "panorama", "inbox", "usage", "setup", "keys", "chat:t3"];

  it("is off after approval: the transcript topics are refused, every other topic is not", async () => {
    const { id } = await startPaired();
    expect(sec.devices()[0]).toMatchObject({ caps: { view: true, "transcript.read": false } });
    for (const t of TRANSCRIPT) expect(sec.mayRead(client(id), t), t).toBe(false);
    for (const t of OTHERS) expect(sec.mayRead(client(id), t), t).toBe(true);
    const stored = JSON.parse(await readFile(join(dir, "data", "devices.json"), "utf8")) as { devices: { caps: Record<string, unknown> }[] };
    expect(stored.devices[0]?.caps["transcript.read"]).toBe(false);
  });

  it("turns on and off from the desktop, with Activity lines, and has no expiry", async () => {
    const { id, onTopicsCut } = await startPaired();
    sec.setCap(id, "transcript.read", true);
    for (const t of TRANSCRIPT) expect(sec.mayRead(client(id), t), t).toBe(true);
    expect(activity()).toContain("Phone 1: transcript.read on");
    expect(onTopicsCut).not.toHaveBeenCalled();
    // Still on long after: no expiry.
    clock += 400 * 24 * 3600_000;
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(true);
    expect(() => sec.setCap(id, "transcript.read", true, clock + 60_000)).toThrow();
    sec.setCap(id, "transcript.read", false);
    expect(activity()).toContain("Phone 1: transcript.read off");
    expect(onTopicsCut).toHaveBeenCalledWith(id);
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
  });

  it("is separate from view both ways, and never outlives the socket's own rights", async () => {
    const { id } = await startPaired();
    sec.setCap(id, "transcript.read", true);
    sec.pause();
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
    sec.resume();
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(true);
    sec.setCap(id, "view", false);
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
    sec.setCap(id, "view", true);
    // view back on does not bring chat history back with it: approval-time defaults are not reapplied, it stays as set.
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(true);
    sec.revoke(id);
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
    expect(sec.mayRead({ send: () => undefined, close: () => undefined }, "chatview:t3")).toBe(false);
  });

  it("grants nothing else: no act needs it, and it implies no other capability", async () => {
    const { id } = await startPaired();
    sec.setCap(id, "transcript.read", true);
    expect([...ACTION_CAPS.values()]).not.toContain("transcript.read");
    expect(await sec.act(client(id), "terminal.send", { terminal: "t3", text: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await sec.act(client(id), "agent.focus", { id: "a1" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("a refused subscription is in Activity by identifiers only, throttled per device", async () => {
    const { id } = await startPaired();
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
    expect(sec.mayRead(client(id), "timeline:t3")).toBe(false);
    expect(activity()).toContain("Phone 1 opened the chat of t3: refused, chat history is off");
    expect(activity()).toContain("Phone 1 opened the timeline of t3: refused, chat history is off");
    // A name that is not an id is never written.
    expect(sec.mayRead(client(id), "chatview:Question Title 123 secret")).toBe(false);
    expect(activity()).toContain("Phone 1 opened the chat of a terminal: refused, chat history is off");
    expect(activity().join("\n")).not.toContain("secret");
    const n = activity().length;
    for (let i = 0; i < 50; i++) sec.mayRead(client(id), "chatview:t3");
    expect(activity().length - n).toBe(TOPIC_REFUSAL_LOG_LIMIT.max - 3);
    clock += TOPIC_REFUSAL_LOG_LIMIT.windowMs;
    sec.mayRead(client(id), "chatview:t3");
    expect(activity().length - n).toBe(TOPIC_REFUSAL_LOG_LIMIT.max - 2);
    // A recheck (the switch was just turned off, and Activity says so) writes nothing.
    clock += TOPIC_REFUSAL_LOG_LIMIT.windowMs;
    const m = activity().length;
    expect(sec.mayRead(client(id), "chatview:t3", true)).toBe(false);
    expect(activity().length).toBe(m);
  });

  it("requestDevice with needs is the guard for the chat history pages", async () => {
    const { id, cookie } = await startPaired();
    const req = { rawHeaders: ["Cookie", cookie] } as unknown as import("node:http").IncomingMessage;
    const needs = topicCaps("chatview:t3");
    expect(needs).toEqual(["transcript.read"]);
    expect(topicCaps("chat:t3")).toEqual([]);
    expect(sec.requestDevice(req, needs)).toBeUndefined();
    expect(sec.requestDevice(req)).toEqual({ id });
    sec.setCap(id, "transcript.read", true);
    expect(sec.requestDevice(req, needs)).toEqual({ id });
    sec.pause();
    expect(sec.requestDevice(req, needs)).toBeUndefined();
    sec.resume();
    sec.setCap(id, "view", false);
    expect(sec.requestDevice(req, needs)).toBeUndefined();
  });

  /** Like `start`, with the hub's topic gate and the topic cut wired as the app wires them. */
  async function startGated() {
    acts = [];
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: () => ({ ok: true }), onTopicsCut: (id) => hub.recheck(id) });
    hub = newHub({ onAct: sec.act, mayRead: sec.mayRead });
    srv = createBridgeServer({ hub, guard: sec.guard, routes: sec.routes, onConnect: sec.onConnect });
    port = (await srv.listen()).port;
  }

  it("turning it off ends open subscriptions even when devices.json can't be written", async () => {
    await startGated();
    const { id, cookie } = await pairedDevice();
    sec.setCap(id, "transcript.read", true);
    hub.publish("chatview:t3", { text: "Question Title 123" });
    const s = await greeted(cookie);
    s.ws.send(JSON.stringify({ type: "sub", topics: ["chatview:t3"] }));
    await s.next(2);
    expect(s.msgs[1]).toMatchObject({ type: "snap", topic: "chatview:t3" });
    const data = join(dir, "data");
    await chmod(data, 0o500);
    try {
      expect(() => sec.setCap(id, "transcript.read", false)).toThrow();
      await s.next(3);
      expect(s.msgs[2]).toEqual({ type: "stale", topic: "chatview:t3", reason: "forbidden" });
      hub.publish("chatview:t3", { text: "Question Title 124" });
      expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      await chmod(data, 0o700);
    }
    s.ws.send(JSON.stringify({ type: "ping" }));
    await s.next(4);
    expect(s.msgs.slice(3)).toEqual([{ type: "pong" }]);
    s.ws.close();
  });

  it("a connection the bridge dropped can't read, even while its close is pending (serve change, same login)", async () => {
    const { id } = await startPaired();
    sec.setCap(id, "transcript.read", true);
    const closes: number[] = [];
    const kicked = { principal: { deviceId: id }, send: () => undefined, close: (code: number) => void closes.push(code) };
    sec.onConnect(kicked);
    expect(sec.mayRead(kicked, "chatview:t3")).toBe(true);
    // Another serve host with the same owner login: every socket is dropped, the device itself stays current.
    sec.setServe({ host: "desk-2.example-tailnet.ts.net", login: OWNER });
    expect(closes).toEqual([CLOSE_REVOKED]);
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(true);
    expect(sec.mayRead(kicked, "chatview:t3")).toBe(false);
  });

  it("a refusal while Activity can't be written is still a refusal, and doesn't throw", async () => {
    const { id } = await startPaired();
    const f = join(dir, "data", "activity.jsonl");
    await rm(f, { force: true });
    await import("node:fs/promises").then((fs) => fs.mkdir(f));
    expect(() => sec.mayRead(client(id), "chatview:t3")).not.toThrow();
    expect(sec.mayRead(client(id), "timeline:t3")).toBe(false);
    expect(sec.auditHealth.ok).toBe(false);
  });

  it("a devices.json from before CV1 loads, with transcript.read off", async () => {
    const { id } = await startPaired();
    sec.close();
    const p = join(dir, "data", "devices.json");
    const stored = JSON.parse(await readFile(p, "utf8")) as { devices: { caps: Record<string, unknown> }[] };
    delete stored.devices[0]!.caps["transcript.read"];
    // A file from before S16b too: both migrations apply.
    delete stored.devices[0]!.caps["terminal.keys"];
    delete stored.devices[0]!.caps["terminal.keys.until"];
    await import("node:fs/promises").then((fs) => fs.writeFile(p, JSON.stringify(stored)));
    sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock });
    expect(sec.devices()[0]).toMatchObject({ id, caps: { "transcript.read": false, "terminal.keys": false } });
    expect(sec.mayRead(client(id), "chatview:t3")).toBe(false);
    // The next write stores it, so the file is now the new shape.
    sec.setCap(id, "navigate", true);
    const again = JSON.parse(await readFile(p, "utf8")) as { devices: { caps: Record<string, unknown> }[] };
    expect(again.devices[0]?.caps["transcript.read"]).toBe(false);
  });
});
