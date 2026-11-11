// S5b: the Home Screen transfer code, attacked at the socket level. Safari (an approved device) mints a code over its
// own WebSocket; only that device's manifest carries it; the Home Screen app spends it once for its own token of the
// same device. Fake data only: "desk-1", "user-1@example", "Phone 1".
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { createBridgeServer, type BridgeServer } from "../src/server.js";
import { manifestRoute } from "../src/app/manifest.js";
import {
  CLOSE_REVOKED,
  Security,
  TRANSFER_FAIL_LIMIT,
  TRANSFER_PATH,
  TRANSFER_PER_DEVICE,
  TRANSFER_TTL_MS,
} from "../src/security/index.js";
import { newHub } from "./helpers.js";

const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;
const BUILT = { name: "Herdr", id: "./", start_url: "./", scope: "./", display: "standalone" };

let dir: string;
let sec: Security;
let srv: BridgeServer;
let port: number;
let clock: number;

async function start() {
  const staticDir = join(dir, "static");
  await import("node:fs/promises").then((fs) => fs.mkdir(staticDir, { recursive: true }));
  await writeFile(join(staticDir, "manifest.webmanifest"), JSON.stringify(BUILT));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Herdr</title>");
  sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: () => ({ ok: true }) });
  const hub = newHub({ onAct: sec.act });
  const manifest = manifestRoute(staticDir, (req) => sec.manifestStartUrl(req));
  srv = createBridgeServer({
    hub,
    staticDir,
    guard: sec.guard,
    routes: async (req, res, path) => (await sec.routes(req, res, path)) || manifest(req, res, path),
    onConnect: sec.onConnect,
  });
  port = (await srv.listen()).port;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-transfer-"));
  clock = 1_000_000;
  await start();
});
afterEach(async () => {
  sec?.close();
  await srv?.close();
  await rm(dir, { recursive: true, force: true });
});

type Headers = Record<string, string | undefined>;
interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const OK_GET: Headers = { Host: SERVE, "Tailscale-User-Login": OWNER };
const OK_POST: Headers = { ...OK_GET, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" };

function http(method: string, path: string, headers: Headers, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
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
  return ((Array.isArray(sc) ? sc[0] : sc) ?? "").split(";")[0]!;
};

/** Pairs a device through the QR code and approves it on the desktop: Safari's cookie. */
async function safariDevice(name = "Phone 1"): Promise<{ cookie: string; id: string }> {
  const { code } = sec.issueCode();
  const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name }));
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

function ws(headers: Headers, protocols: string[] = [bridgeApi.WS_PROTOCOL]): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
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

async function act(s: Sock, kind: string, args: Record<string, unknown> = {}): Promise<bridgeApi.Res> {
  const before = s.msgs.length;
  s.ws.send(JSON.stringify({ type: "act", id: `a${before}`, kind, args }));
  await s.next(before + 1);
  return s.msgs[before] as bridgeApi.Res;
}

/** Safari asks for a transfer code over its own authenticated socket. */
async function mint(cookie: string): Promise<bridgeApi.Res> {
  const s = await ws({ ...OK_GET, Origin: ORIGIN, Cookie: cookie });
  s.ws.send(JSON.stringify({ type: "hello", api: 1 }));
  await s.next(1);
  const r = await act(s, "pair.transfer");
  s.ws.close();
  await s.closed;
  return r;
}

/** The manifest as a browser fetches it (`crossorigin="use-credentials"`: with the cookie, if any). */
async function manifest(cookie?: string, headers: Headers = OK_GET): Promise<{ status: number; start_url?: string; id?: string; headers: Resp["headers"] }> {
  const r = await http("GET", "/manifest.webmanifest", { ...headers, Cookie: cookie });
  if (r.status !== 200) return { status: r.status, headers: r.headers };
  const m = JSON.parse(r.body) as { start_url: string; id: string };
  return { status: 200, start_url: m.start_url, id: m.id, headers: r.headers };
}

/** The code in this device's manifest start_url (`./pair#t=<code>`). */
async function codeFor(cookie: string): Promise<string> {
  const m = await manifest(cookie);
  const hit = /^\.\/pair#t=([A-Za-z0-9_-]{22})$/.exec(m.start_url ?? "");
  expect(hit, `start_url ${m.start_url}`).not.toBeNull();
  return hit![1]!;
}

/** The Home Screen app's first launch: no cookie of its own (iOS keeps it apart from Safari's). */
function redeem(code: string, headers: Headers = OK_POST, body?: string): Promise<Resp> {
  return http("POST", TRANSFER_PATH, headers, body ?? JSON.stringify({ code }));
}

const me = (cookie: string) => http("GET", "/api/v1/me", { ...OK_GET, Cookie: cookie });
const devices = async () => JSON.parse(await readFile(join(dir, "data", "devices.json"), "utf8")) as { devices: Record<string, unknown>[] };

describe("transfer: the happy path", () => {
  it("Safari mints over its socket, its manifest carries the code, the Home Screen app gets its own token for the same device", async () => {
    const safari = await safariDevice();
    expect((await manifest(safari.cookie)).start_url).toBe("./");
    expect(await mint(safari.cookie)).toMatchObject({ ok: true });
    const code = await codeFor(safari.cookie);
    const m = await manifest(safari.cookie);
    expect(m.id).toBe("./");
    expect(m.headers["cache-control"]).toBe("no-store");
    expect(m.headers["access-control-allow-origin"]).toBeUndefined();

    const r = await redeem(code);
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"]?.[0]).toMatch(/^__Host-hr-device=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    const home = cookieOf(r);
    expect(home).not.toBe(safari.cookie);
    const view = JSON.parse(r.body) as { device: { id: string; state: string; name: string } };
    expect(view.device).toMatchObject({ id: safari.id, state: "approved", name: "Phone 1" });
    // Both stores now hold the same device; Safari keeps working.
    for (const c of [home, safari.cookie]) expect(JSON.parse((await me(c)).body)).toMatchObject({ device: { id: safari.id, state: "approved" } });
    const s = await ws({ ...OK_GET, Origin: ORIGIN, Cookie: home });
    s.ws.close();
    // Spent: the manifest is plain again; only hashes are on disk.
    expect((await manifest(safari.cookie)).start_url).toBe("./");
    const disk = JSON.stringify(await devices());
    expect(disk).not.toContain(code);
    expect(disk).not.toContain(home.split("=")[1]);
    expect(sec.activity(50).map((e) => e.text)).toEqual(expect.arrayContaining(["Phone 1 asked for a Home Screen setup code", "Phone 1 set up on the Home Screen"]));
    expect(sec.devices()).toHaveLength(1);
  });

  it("the transfer never skips approval: a pending device can't mint, and its manifest is plain", async () => {
    const { code } = sec.issueCode();
    const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code }));
    const pending = cookieOf(r);
    await expect(ws({ ...OK_GET, Origin: ORIGIN, Cookie: pending })).rejects.toThrow(/401/);
    expect((await manifest(pending)).start_url).toBe("./");
  });

  it("a new Home Screen token replaces the last one; Safari's stays", async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const first = cookieOf(await redeem(await codeFor(safari.cookie)));
    await mint(safari.cookie);
    const second = cookieOf(await redeem(await codeFor(safari.cookie)));
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
    expect((await me(safari.cookie)).status).toBe(200);
  });
});

describe("attack: replay", () => {
  it("a spent code is refused, and so is every other code the device held", async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const older = await codeFor(safari.cookie);
    await mint(safari.cookie);
    const newer = await codeFor(safari.cookie);
    expect(newer).not.toBe(older);
    expect((await redeem(newer)).status).toBe(200);
    for (const c of [newer, older]) {
      const r = await redeem(c);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: "bad_code" });
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("an older code still works until one of them is spent (a re-mint doesn't break an add in progress)", async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const older = await codeFor(safari.cookie);
    await mint(safari.cookie);
    expect((await redeem(older)).status).toBe(200);
  });

  it(`keeps at most ${TRANSFER_PER_DEVICE} codes per device: minting more drops the oldest`, async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const oldest = await codeFor(safari.cookie);
    for (let i = 0; i < TRANSFER_PER_DEVICE; i++) await mint(safari.cookie);
    expect((await redeem(oldest)).status).toBe(403);
  });
});

describe("attack: expiry", () => {
  it(`a code is refused from ${TRANSFER_TTL_MS / 60_000} minutes on, and leaves the manifest`, async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const code = await codeFor(safari.cookie);
    clock += TRANSFER_TTL_MS - 1;
    expect(await codeFor(safari.cookie)).toBe(code);
    clock += 1;
    expect((await manifest(safari.cookie)).start_url).toBe("./");
    expect((await redeem(code)).status).toBe(403);
  });

  it("redemption checks the time itself (nothing else pruned the code first)", async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const code = await codeFor(safari.cookie);
    clock += TRANSFER_TTL_MS;
    expect((await redeem(code)).status).toBe(403);
  });

  it("a code minted just before is still good", async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const code = await codeFor(safari.cookie);
    clock += TRANSFER_TTL_MS - 1;
    expect((await redeem(code)).status).toBe(200);
  });

  it("a restart voids every code (they live in memory only)", async () => {
    const safari = await safariDevice();
    await mint(safari.cookie);
    const code = await codeFor(safari.cookie);
    sec.close();
    await srv.close();
    await start();
    expect((await redeem(code)).status).toBe(403);
  });
});

describe("attack: wrong device", () => {
  it("another device's manifest never carries the code", async () => {
    const a = await safariDevice("Phone 1");
    const b = await safariDevice("Phone 2");
    await mint(a.cookie);
    await codeFor(a.cookie);
    expect((await manifest(b.cookie)).start_url).toBe("./");
    expect((await manifest(undefined)).start_url).toBe("./");
    expect((await manifest("__Host-hr-device=" + "A".repeat(43))).start_url).toBe("./");
  });

  it("a request carrying another device's cookie can't spend the code (and burns it)", async () => {
    const a = await safariDevice("Phone 1");
    const b = await safariDevice("Phone 2");
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    const r = await redeem(code, { ...OK_POST, Cookie: b.cookie });
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse((await me(b.cookie)).body)).toMatchObject({ device: { id: b.id } });
    expect((await redeem(code)).status).toBe(403);
  });

  it("the code binds to the device that minted it: the new token is that device, with its own name and caps", async () => {
    const a = await safariDevice("Phone 1");
    const b = await safariDevice("Phone 2");
    sec.setCap(b.id, "navigate", true);
    await mint(a.cookie);
    const home = cookieOf(await redeem(await codeFor(a.cookie)));
    const d = (JSON.parse((await me(home)).body) as { device: { id: string; name: string; caps: Record<string, boolean> } }).device;
    expect(d).toMatchObject({ id: a.id, name: "Phone 1" });
    expect(d.caps.navigate).toBe(false);
  });

  it("redeeming with the same device's own cookie is allowed (a browser that shares storage)", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    expect((await redeem(await codeFor(a.cookie), { ...OK_POST, Cookie: a.cookie })).status).toBe(200);
  });
});

describe("attack: revoked or limited device", () => {
  it("revoking the device voids its codes, and the Home Screen token goes with it", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const home = cookieOf(await redeem(await codeFor(a.cookie)));
    const s = await ws({ ...OK_GET, Origin: ORIGIN, Cookie: home });
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    sec.revoke(a.id);
    expect(await s.closed).toBe(CLOSE_REVOKED);
    expect((await redeem(code)).status).toBe(403);
    expect((await me(home)).status).toBe(401);
    expect((await me(a.cookie)).status).toBe(401);
  });

  it("turning view off voids the codes; a device without view can't mint", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    sec.setCap(a.id, "view", false);
    sec.setCap(a.id, "view", true);
    expect((await redeem(code)).status).toBe(403);
  });

  it("a code held while view is off can't be spent even if it wasn't cleared", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    // Straight to the store, bypassing setCap's clean-up: redemption checks the device itself.
    (sec as unknown as { store: { update(id: string, fn: (d: { caps: { view: boolean } }) => void): void } }).store.update(a.id, (d) => {
      d.caps.view = false;
    });
    expect((await redeem(code)).status).toBe(403);
  });

  it("a device that may no longer view gets the plain manifest, even with a code still held", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    await codeFor(a.cookie);
    (sec as unknown as { store: { update(id: string, fn: (d: { caps: { view: boolean } }) => void): void } }).store.update(a.id, (d) => {
      d.caps.view = false;
    });
    expect((await manifest(a.cookie)).start_url).toBe("./");
  });

  it("pause voids the codes", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    sec.pause();
    expect((await redeem(code)).status).toBe(503);
    sec.resume();
    expect((await redeem(code)).status).toBe(403);
  });

  it("a change of serve identity voids the codes", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    sec.setServe({ host: SERVE, login: "user-2@example" });
    sec.setServe({ host: SERVE, login: OWNER });
    expect((await redeem(code)).status).toBe(403);
  });
});

describe("clean-up: no code outlives the reason it was minted", () => {
  const held = (id: string) => (sec as unknown as { transfers: Map<string, unknown[]> }).transfers.has(id);
  it.each([
    ["revoke", (id: string) => sec.revoke(id)],
    ["view off", (id: string) => sec.setCap(id, "view", false)],
    ["pause", () => sec.pause()],
    ["serve change", () => sec.setServe({ host: SERVE, login: "user-2@example" })],
  ] as const)("%s forgets the device's codes", async (_what, fn) => {
    const a = await safariDevice();
    await mint(a.cookie);
    expect(held(a.id)).toBe(true);
    fn(a.id);
    expect(held(a.id)).toBe(false);
  });
});

describe("attack: cross-origin and CSRF", () => {
  it("redeeming needs the exact Origin, X-Remote-Api and JSON, and the owner's identity on the serve name", async () => {
    const a = await safariDevice();
    const bad: [string, Headers][] = [
      ["foreign Origin", { ...OK_POST, Origin: "https://evil.example" }],
      ["http Origin", { ...OK_POST, Origin: `http://${SERVE}` }],
      ["no Origin", { ...OK_POST, Origin: undefined }],
      ["no X-Remote-Api", { ...OK_POST, "X-Remote-Api": undefined }],
      ["X-Remote-Api 0", { ...OK_POST, "X-Remote-Api": "0" }],
      ["foreign Host", { ...OK_POST, Host: "evil.example" }],
      ["no identity", { ...OK_POST, "Tailscale-User-Login": undefined }],
      ["other login", { ...OK_POST, "Tailscale-User-Login": "user-2@example" }],
    ];
    for (const [what, headers] of bad) {
      await mint(a.cookie);
      const code = await codeFor(a.cookie);
      const r = await redeem(code, headers);
      expect(r.status, what).toBe(403);
      expect(r.headers["set-cookie"], what).toBeUndefined();
      // The guard refused before the code was looked at: it still works.
      expect((await redeem(code)).status, what).toBe(200);
    }
  });

  it("a simple cross-site form post (text/plain) is refused", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    const r = await redeem(code, { ...OK_POST, "Content-Type": "text/plain" });
    expect(r.status).toBe(415);
    expect((await redeem(code, { ...OK_POST, "Content-Type": "application/x-www-form-urlencoded" }, `code=${code}`)).status).toBe(415);
  });

  it("GET and other methods don't redeem", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    expect((await http("GET", `${TRANSFER_PATH}?code=${code}`, OK_GET)).status).toBe(405);
    expect((await http("PUT", TRANSFER_PATH, OK_POST, JSON.stringify({ code }))).status).toBe(405);
    expect((await redeem(code)).status).toBe(200);
  });

  it("minting needs the authenticated socket: the WS guard (Origin, subprotocol, cookie) applies", async () => {
    const a = await safariDevice();
    await expect(ws({ ...OK_GET, Origin: "https://evil.example", Cookie: a.cookie })).rejects.toThrow(/403/);
    await expect(ws({ ...OK_GET, Origin: ORIGIN, Cookie: a.cookie }, [])).rejects.toThrow(/403/);
    await expect(ws({ ...OK_GET, Origin: ORIGIN })).rejects.toThrow(/401/);
    expect((await manifest(a.cookie)).start_url).toBe("./");
  });

  it("the manifest is guarded like any GET and is never readable cross-origin", async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    expect((await manifest(a.cookie, { ...OK_GET, Host: "evil.example" })).status).toBe(403);
    expect((await manifest(a.cookie, { ...OK_GET, "Tailscale-User-Login": "user-2@example" })).status).toBe(403);
    const m = await manifest(a.cookie, { ...OK_GET, Origin: "https://evil.example" });
    expect(m.headers["access-control-allow-origin"]).toBeUndefined();
    expect(m.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(m.headers.vary).toBe("Cookie");
  });
});

describe("attack: brute force", () => {
  it(`answers 429 after ${TRANSFER_FAIL_LIMIT} failed codes in a minute, even for a valid code, then recovers`, async () => {
    const a = await safariDevice();
    await mint(a.cookie);
    const code = await codeFor(a.cookie);
    for (let i = 0; i < TRANSFER_FAIL_LIMIT; i++) {
      const guess = `${String(i).padStart(2, "0")}${"x".repeat(20)}`;
      expect((await redeem(guess)).status).toBe(403);
    }
    expect((await redeem(code)).status).toBe(429);
    // The 429 didn't spend it.
    clock += 60_000;
    expect((await redeem(code)).status).toBe(200);
  });

  it("malformed codes count as failures and are never compared", async () => {
    for (const c of ["", "short", "x".repeat(23), "!".repeat(22), "../../etc/passwd"]) expect((await redeem(c)).status).toBe(403);
    expect((await redeem("x", OK_POST, JSON.stringify({ code: 123 }))).status).toBe(403);
    expect(sec.activity(50).filter((e) => e.event === "pair.transfer_fail")).toHaveLength(6);
  });

  it("the pairing code can't be spent as a transfer code, nor a transfer code as a pairing code", async () => {
    const a = await safariDevice();
    const { code: pairCode } = sec.issueCode();
    expect((await redeem(pairCode)).status).toBe(403);
    await mint(a.cookie);
    const t = await codeFor(a.cookie);
    expect((await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code: t }))).status).toBe(403);
  });
});
