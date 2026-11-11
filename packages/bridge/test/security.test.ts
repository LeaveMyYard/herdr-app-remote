import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { bridgeApi } from "@herdr-remote/protocol";
import { createBridgeServer, type BridgeServer } from "../src/server.js";
import type { ActHandler, Hub } from "../src/hub.js";
import {
  CLOSE_NO_VIEW,
  CLOSE_PAUSED,
  CLOSE_REVOKED,
  CODE_TTL_MS,
  MAX_PENDING,
  PAIR_FAIL_LIMIT,
  PENDING_TTL_MS,
  Security,
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
      return { ok: true };
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

function ws(headers: Headers): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (typeof v === "string") h[k] = v;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, { headers: h });
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

const wsHeaders = (cookie: string): Headers => ({ ...OK_GET, Origin: ORIGIN, "X-Remote-Api": "1", Cookie: cookie });

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

  it("the WS upgrade needs Origin, X-Remote-Api and an approved device cookie", async () => {
    await start();
    const { cookie } = await pairedDevice();
    await expect(ws({ ...wsHeaders(cookie), Origin: "https://evil.example" })).rejects.toThrow(/403/);
    await expect(ws({ ...wsHeaders(cookie), Origin: undefined })).rejects.toThrow(/403/);
    await expect(ws({ ...wsHeaders(cookie), "X-Remote-Api": undefined })).rejects.toThrow(/403/);
    await expect(ws({ ...wsHeaders(cookie), Cookie: undefined })).rejects.toThrow(/401/);
    await expect(ws({ ...wsHeaders(cookie), Cookie: "__Host-hr-device=" + "A".repeat(43) })).rejects.toThrow(/401/);
    await expect(ws({ ...wsHeaders(cookie), Cookie: `${cookie}; ${cookie}` })).rejects.toThrow(/401/);
    (await greeted(cookie)).ws.close();
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

    const r = await pair(issued.code, OK_POST, "Phone\n1\u0000");
    expect(r.status).toBe(202);
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
    expect(me2.device.caps).toEqual({ view: true, "inbox.answer": true, navigate: false, "terminal.input": false, push: false });
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
    expect(await act(s, "inbox.answer", { id: "Q119", label: "Option B", text: "secret free text" })).toMatchObject({ ok: true });
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
    expect(await act(s, "inbox.dismiss", { id: "Q1" })).toMatchObject({ ok: false, code: "forbidden" });
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
    expect(await act(s, "inbox.answer", { id: "Q1" })).toMatchObject({ ok: false, code: "unsupported_action" });
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
    expect(await act(s, "inbox.ack", { id: "A1" })).toEqual({ type: "res", id: "a1", ok: false, code: "internal_error", unknown_effect: true });
    expect(activity()).toContain("Phone 1 acknowledged A1: result unknown");
    s.ws.close();
  });

  it("every act re-checks the device, so a revoked one is refused and closed", async () => {
    await start();
    const { id } = await pairedDevice();
    const closes: number[] = [];
    const client = { principal: { deviceId: id }, send: () => undefined, close: (c: number) => void closes.push(c) };
    expect(await sec.act(client, "inbox.ack", { id: "A1" })).toMatchObject({ ok: true });
    sec.revoke(id);
    expect(await sec.act(client, "inbox.ack", { id: "A1" })).toMatchObject({ ok: false, code: "unpaired" });
    expect(closes).toEqual([CLOSE_REVOKED]);
    expect(acts).toHaveLength(1);
  });

  it("an act from a device of a previous owner login, or still pending, is refused", async () => {
    await start();
    const { id } = await pairedDevice();
    const client = { principal: { deviceId: id }, send: () => undefined, close: () => undefined };
    sec.setServe({ host: SERVE, login: "user-2@example" });
    expect(await sec.act(client, "inbox.ack", { id: "A1" })).toMatchObject({ ok: false, code: "unpaired" });
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
