// The push service end to end on loopback: a paired device subscribes over the real WebSocket (the security layer's
// capability check and audit included), triggers fire from topic values, and the bridge POSTs encrypted, VAPID-signed
// pushes to a local fake push service. No real push endpoint is contacted.
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { routeActs } from "../../src/app/act.js";
import type { Hub } from "../../src/hub.js";
import { PushService } from "../../src/push/service.js";
import { PUSH_FILE } from "../../src/push/store.js";
import { VAPID_FILE } from "../../src/push/vapid.js";
import { ACTIVITY_FILE, Security } from "../../src/security/index.js";
import { createBridgeServer, type BridgeServer } from "../../src/server.js";
import { newHub } from "../helpers.js";
import { FakePushService, FakeUa } from "./fake-push.js";

const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;
const OK_GET = { Host: SERVE, "Tailscale-User-Login": OWNER };
const OK_POST = { ...OK_GET, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" };

const load = (p: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../../../fixtures/${p}`, import.meta.url), "utf8")) as Record<string, unknown>;

let dir: string;
let sec: Security;
let hub: Hub;
let srv: BridgeServer;
let port: number;
let push: PushService;
let fake: FakePushService;
let topics: { inbox: unknown; panorama: unknown; host: unknown };
let serving: boolean;
let clock: number;
/** False: security changes are not passed on (stands for changes made while the bridge was down). */
let syncOn: boolean;
const socks: WebSocket[] = [];

function baseInbox(): bridgeApi.InboxTopic {
  const t = bridgeApi.InboxTopic.parse(load("bridge-api/inbox/typical.json"));
  for (const r of t.entries) r.new = false;
  return t;
}
function host() {
  const h = load("host/typical.json") as { agents: { terminal_id?: string }[] };
  h.agents[0]!.terminal_id = "t1";
  return h;
}
function addQuestion(id: number): void {
  const t = topics.inbox as bridgeApi.InboxTopic;
  const g = structuredClone(t.entries.find((r) => r.key === "group:123") ?? baseInbox().entries.find((r) => r.key === "group:123")!) as Record<string, unknown>;
  const q = (g.questions as Record<string, unknown>[])[0]!;
  const row = bridgeApi.InboxRow.parse({ ...g, key: `group:${id}`, group: id, title: `Question Title ${id}`, new: true, questions: [{ ...q, id, question: `SECRET body ${id}` }] });
  topics.inbox = { ...t, entries: [...t.entries, row] };
}

const gate = () => ({ mayPush: (id: string) => sec.mayPush(id), requestDevice: (r: Parameters<Security["requestDevice"]>[0]) => sec.requestDevice(r), device: (id: string) => sec.pushDevice(id), note: (e: Parameters<Security["note"]>[0]) => sec.note(e) });

/** A second push service on the same data dir: the bridge restarted (production endpoint check unless given). */
function restartPush(allowFake = false): void {
  push.stop();
  push = new PushService({
    dataDir: join(dir, "data"),
    gate: gate(),
    topics: () => topics,
    now: () => clock,
    tickMs: 3_600_000,
    ...(allowFake ? { allowEndpoint: (u: string) => u.startsWith(`http://127.0.0.1:${fake.port}/`) } : {}),
  });
  push.start();
}

async function start(o: { rateLimit?: number } = {}) {
  sec = new Security({
    dataDir: join(dir, "data"),
    serve: { host: SERVE, login: OWNER },
    now: () => clock,
    inner: routeActs([(c, kind, args) => push.act(c, kind, args)]),
    onChange: () => {
      if (syncOn) push?.sync();
    },
  });
  hub = newHub({ onAct: sec.act });
  push = new PushService({
    dataDir: join(dir, "data"),
    gate: gate(),
    topics: () => topics,
    serving: () => serving,
    now: () => clock,
    // The fake push service is plain HTTP on loopback: allowed here only.
    allowEndpoint: (u) => u.startsWith(`http://127.0.0.1:${fake.port}/`),
    tickMs: 3_600_000,
    ...(o.rateLimit !== undefined ? { rateLimit: o.rateLimit } : {}),
  });
  srv = createBridgeServer({
    hub,
    guard: sec.guard,
    routes: async (req, res, path) => (await sec.routes(req, res, path)) || push.routes(req, res, path),
    onConnect: sec.onConnect,
  });
  port = (await srv.listen()).port;
  push.start();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-push-"));
  clock = 1_800_000_000_000;
  serving = true;
  syncOn = true;
  topics = { inbox: baseInbox(), panorama: undefined, host: host() };
  fake = new FakePushService();
  await fake.start();
});

afterEach(async () => {
  for (const s of socks.splice(0)) s.terminate();
  push?.stop();
  await srv?.close();
  await fake.stop();
  await rm(dir, { recursive: true, force: true });
});

function http(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

async function device(name = "Phone 1", caps: { push?: boolean } = { push: true }): Promise<{ id: string; cookie: string }> {
  const { code } = sec.issueCode();
  const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name }));
  const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
  sec.approve(id);
  if (caps.push) sec.setCap(id, "push", true);
  const sc = r.headers["set-cookie"];
  return { id, cookie: (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]! };
}

/** A phone's socket: `act` resolves with the `res`. */
async function phone(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { ...OK_GET, Origin: ORIGIN, Cookie: cookie } });
  socks.push(ws);
  const waiting = new Map<string, (r: bridgeApi.Res) => void>();
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as bridgeApi.ServerMessage;
    if (m.type === "res") waiting.get(m.id)?.(m);
  });
  await new Promise<void>((r, j) => ws.once("open", () => r()).once("error", j));
  ws.send(JSON.stringify({ type: "hello", api: 1 }));
  let n = 0;
  return {
    act: (kind: string, args: Record<string, unknown>) =>
      new Promise<bridgeApi.Res>((resolve) => {
        const id = `a${++n}`;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ type: "act", id, kind, args }));
      }),
  };
}

const subArgs = (ua: FakeUa, path = "/sub/1") => ({ endpoint: fake.endpoint(path), keys: ua.keys });
const activity = async () =>
  (await readFile(join(dir, "data", ACTIVITY_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { event: string; text: string; code?: string; ok?: boolean });

describe("push: subscribing", () => {
  it("a device with `push` subscribes over its socket; GET /api/v1/push reports it with the VAPID key", async () => {
    await start();
    const d = await device();
    const before = await http("GET", "/api/v1/push", { ...OK_GET, Cookie: d.cookie });
    expect(before.status).toBe(200);
    const info = bridgeApi.PushInfo.parse(JSON.parse(before.body));
    expect(info).toEqual({ key: push.publicKey, allowed: true, subscribed: false });
    const p = await phone(d.cookie);
    expect(await p.act("push.subscribe", subArgs(new FakeUa()))).toMatchObject({ ok: true });
    expect(JSON.parse((await http("GET", "/api/v1/push", { ...OK_GET, Cookie: d.cookie })).body)).toMatchObject({ subscribed: true });
    expect((await activity()).map((e) => e.text)).toContain("Phone 1 turned push on");
    // The subscription and the keys are kept 0600; the endpoint is never written to the Activity log.
    expect((await stat(join(dir, "data", PUSH_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "data", VAPID_FILE))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "data", ACTIVITY_FILE), "utf8")).not.toContain("/sub/1");
  });

  it("is refused without the `push` capability (off by default) and the refusal is audited", async () => {
    await start();
    const d = await device("Phone 1", {});
    expect(JSON.parse((await http("GET", "/api/v1/push", { ...OK_GET, Cookie: d.cookie })).body)).toMatchObject({ allowed: false });
    const p = await phone(d.cookie);
    expect(await p.act("push.subscribe", subArgs(new FakeUa()))).toMatchObject({ ok: false, code: "forbidden" });
    expect(push.subscribed(d.id)).toBe(false);
    expect((await activity()).at(-1)).toMatchObject({ text: "Phone 1 turned push on: refused", code: "forbidden" });
  });

  it("refuses endpoints outside the push services, bad keys and extra fields", async () => {
    await start();
    const d = await device();
    const p = await phone(d.cookie);
    const ua = new FakeUa();
    expect(await p.act("push.subscribe", { endpoint: "http://127.0.0.1:1/x", keys: ua.keys })).toMatchObject({ ok: false, code: "bad_endpoint" });
    expect(await p.act("push.subscribe", { endpoint: `https://${SERVE}/api/v1/pair`, keys: ua.keys })).toMatchObject({ ok: false, code: "bad_endpoint" });
    const off = Buffer.from(ua.keys.p256dh, "base64url");
    off[64] = off[64]! ^ 1;
    expect(await p.act("push.subscribe", { endpoint: fake.endpoint("/x"), keys: { ...ua.keys, p256dh: off.toString("base64url") } })).toMatchObject({ ok: false, code: "bad_keys" });
    expect(await p.act("push.subscribe", { ...subArgs(ua), extra: 1 })).toMatchObject({ ok: false, code: "bad_args" });
    expect(await p.act("push.subscribe", { endpoint: fake.endpoint("/x") })).toMatchObject({ ok: false, code: "bad_args" });
    expect(push.subscribed(d.id)).toBe(false);
  });

  it("GET /api/v1/push needs an approved device; it has no other method", async () => {
    await start();
    expect((await http("GET", "/api/v1/push", OK_GET)).status).toBe(401);
    const d = await device();
    expect((await http("POST", "/api/v1/push", { ...OK_POST, Cookie: d.cookie }, "{}")).status).toBe(405);
    sec.pause();
    expect((await http("GET", "/api/v1/push", { ...OK_GET, Cookie: d.cookie })).status).toBe(503);
  });

  it("unsubscribe forgets it; a revoked device or `push` turned off loses it at once", async () => {
    await start();
    const a = await device("Phone 1");
    const b = await device("Phone 2");
    const pa = await phone(a.cookie);
    const pb = await phone(b.cookie);
    await pa.act("push.subscribe", subArgs(new FakeUa(), "/a"));
    await pb.act("push.subscribe", subArgs(new FakeUa(), "/b"));
    expect(await pa.act("push.unsubscribe", {})).toMatchObject({ ok: true });
    expect(push.subscribed(a.id)).toBe(false);
    await pa.act("push.subscribe", subArgs(new FakeUa(), "/a"));
    sec.setCap(a.id, "push", false);
    expect(push.subscribed(a.id)).toBe(false);
    sec.revoke(b.id);
    expect(push.subscribed(b.id)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "data", PUSH_FILE), "utf8"))).toEqual({ v: 1, subs: [] });
  });
});

describe("push: delivery", () => {
  async function subscribed(name = "Phone 1", path = "/sub/1") {
    const d = await device(name);
    const ua = new FakeUa();
    const p = await phone(d.cookie);
    expect(await p.act("push.subscribe", subArgs(ua, path))).toMatchObject({ ok: true });
    return { ...d, ua };
  }

  it("a new question reaches the phone, encrypted, VAPID-signed, showing only 'Agent 1: Question Title N'", async () => {
    await start();
    const d = await subscribed();
    addQuestion(130);
    await push.tick();
    expect(fake.received).toHaveLength(1);
    const got = fake.received[0]!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.ttl).toBe("14400");
    expect(got.vapidKey).toBe(push.publicKey);
    expect(got.claims).toMatchObject({ aud: `http://127.0.0.1:${fake.port}`, sub: "https://github.com/LeaveMyYard/herdr-app-remote" });
    const text = d.ua.decrypt(got.body);
    expect(bridgeApi.PushPayload.parse(JSON.parse(text))).toEqual({ v: 1, kind: "question", title: "Agent 1: Question Title 130", body: "New question", tag: "q-130", url: "#/inbox/q/group%3A130/130" });
    expect(text).not.toContain("SECRET");
    // The body is ciphertext: nothing readable for the push service.
    expect(got.body.toString("latin1")).not.toContain("Question Title");
    // Not announced twice.
    await push.tick();
    expect(fake.received).toHaveLength(1);
    // The audit names the group, never the title.
    const last = (await activity()).at(-1)!;
    expect(last).toMatchObject({ event: "push.send", text: "Push sent to Phone 1: group 130", ok: true });
    expect(JSON.stringify(await activity())).not.toContain("Question Title 130");
  });

  it("announces nothing that was there when the bridge started (the first look seeds)", async () => {
    addQuestion(150);
    const p = structuredClone(load("bridge-api/panorama/rich.json")) as { roots: { status: string }[] };
    p.roots[0]!.status = "blk";
    topics.panorama = p;
    await start();
    await subscribed();
    await push.tick();
    await push.tick();
    expect(fake.received).toHaveLength(0);
  });

  it("an agent turning blocked is pushed", async () => {
    const p = structuredClone(load("bridge-api/panorama/rich.json")) as { roots: { status: string }[] };
    topics.panorama = p;
    await start();
    const d = await subscribed();
    const next = structuredClone(p);
    next.roots[0]!.status = "blk";
    topics.panorama = next;
    await push.tick();
    expect(JSON.parse(d.ua.decrypt(fake.received[0]!.body))).toMatchObject({ kind: "blocked", title: "Agent 1 is blocked", url: "#/agents" });
    expect((await activity()).at(-1)).toMatchObject({ text: "Push sent to Phone 1: an agent" });
  });

  it("sends only to devices that may get pushes now: not without the cap, not while paused, not while not serving", async () => {
    await start();
    await subscribed("Phone 1", "/a");
    const other = await device("Phone 2", {});
    expect(other).toBeDefined();
    serving = false;
    addQuestion(131);
    await push.tick();
    expect(fake.received).toHaveLength(0);
    serving = true;
    sec.pause();
    addQuestion(132);
    await push.tick();
    expect(fake.received).toHaveLength(0);
    sec.resume();
    addQuestion(133);
    await push.tick();
    expect(fake.received.map((r) => r.path)).toEqual(["/a"]);
  });

  it("a 410 or 404 drops that subscription and is audited without the endpoint; a 500 keeps it", async () => {
    await start();
    const a = await subscribed("Phone 1", "/gone");
    const b = await subscribed("Phone 2", "/missing");
    const c = await subscribed("Phone 3", "/flaky");
    fake.status.set("/gone", 410);
    fake.status.set("/missing", 404);
    fake.status.set("/flaky", 500);
    addQuestion(134);
    await push.tick();
    expect(push.subscribed(a.id)).toBe(false);
    expect(push.subscribed(b.id)).toBe(false);
    expect(push.subscribed(c.id)).toBe(true);
    const log = await activity();
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "push.expire", text: "Phone 1: push subscription expired", code: "http_410" }),
        expect.objectContaining({ event: "push.expire", text: "Phone 2: push subscription expired", code: "http_404" }),
        expect.objectContaining({ event: "push.fail", text: "Push to Phone 3 failed: group 134", code: "http_500" }),
      ]),
    );
    expect(JSON.stringify(log)).not.toMatch(/\/gone|\/missing|\/flaky|127\.0\.0\.1/);
  });

  it("a 410 for an old endpoint does not drop the phone's newer subscription", async () => {
    await start();
    const d = await subscribed("Phone 1", "/old");
    fake.status.set("/old", 410);
    // The phone subscribes again while the push to the old endpoint is on its way; the 410 answers after that.
    const p = await phone(d.cookie);
    let release!: () => void;
    fake.hold.set("/old", new Promise<void>((r) => (release = r)));
    const arrived = fake.arrived("/old");
    addQuestion(135);
    const sending = push.tick();
    await arrived;
    expect(await p.act("push.subscribe", subArgs(new FakeUa(), "/new"))).toMatchObject({ ok: true });
    release();
    await sending;
    expect(push.subscribed(d.id)).toBe(true);
  });

  it("several new things in one look become one notification; the rate limit caps the rest", async () => {
    await start({ rateLimit: 2 });
    const d = await subscribed();
    addQuestion(136);
    addQuestion(137);
    await push.tick();
    expect(fake.received).toHaveLength(1);
    expect(JSON.parse(d.ua.decrypt(fake.received[0]!.body))).toMatchObject({ title: "Agent 1: Question Title 136", body: "and 1 more", tag: "batch" });
    addQuestion(138);
    await push.tick();
    addQuestion(139);
    await push.tick();
    expect(fake.received).toHaveLength(2);
    expect((await activity()).at(-1)).toMatchObject({ event: "push.skip", text: "Push to Phone 1 skipped: group 139", code: "rate_limited" });
  });

  it("a subscription stored for an endpoint that no longer passes the check is dropped, never POSTed", async () => {
    await start();
    const d = await subscribed();
    const file = join(dir, "data", PUSH_FILE);
    const doc = JSON.parse(await readFile(file, "utf8")) as { subs: { endpoint: string }[] };
    expect(doc.subs[0]!.endpoint).toBe(fake.endpoint("/sub/1"));
    // Restart with the production check: the loopback endpoint is refused.
    restartPush();
    addQuestion(140);
    await push.tick();
    expect(fake.received).toHaveLength(0);
    expect(push.subscribed(d.id)).toBe(false);
  });

  it("a failed write while dropping a refused endpoint never rejects the tick", async () => {
    await start();
    const d = await subscribed();
    restartPush();
    await chmod(join(dir, "data"), 0o500);
    try {
      addQuestion(141);
      await expect(push.tick()).resolves.toBeUndefined();
    } finally {
      await chmod(join(dir, "data"), 0o700);
    }
    expect(fake.received).toHaveLength(0);
    expect(push.subscribed(d.id)).toBe(true);
  });
});

describe("push: storage and restart", () => {
  it("a damaged push.json is set aside: the bridge starts, nothing is sent, and the Activity log says so", async () => {
    await start();
    const d = await device();
    push.stop();
    await writeFile(join(dir, "data", PUSH_FILE), "SECRET-endpoint-bytes{");
    restartPush(true);
    expect(push.subscribed(d.id)).toBe(false);
    expect(await readFile(join(dir, "data", `${PUSH_FILE}.damaged`), "utf8")).toBe("SECRET-endpoint-bytes{");
    expect((await stat(join(dir, "data", `${PUSH_FILE}.damaged`))).mode & 0o777).toBe(0o600);
    const log = await activity();
    expect(log.at(-1)).toMatchObject({ event: "push.reset", code: "damaged" });
    expect(JSON.stringify(log)).not.toContain("SECRET");
    expect(await readdir(join(dir, "data"))).not.toContain(PUSH_FILE);
  });

  it("tightens a key or subscription file found readable by others", async () => {
    await start();
    await chmod(join(dir, "data", VAPID_FILE), 0o644);
    await writeFile(join(dir, "data", PUSH_FILE), JSON.stringify({ v: 1, subs: [] }), { mode: 0o644 });
    await chmod(join(dir, "data", PUSH_FILE), 0o644);
    restartPush(true);
    expect((await stat(join(dir, "data", VAPID_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "data", PUSH_FILE))).mode & 0o777).toBe(0o600);
  });

  it("at start, drops subscriptions of devices revoked or with push turned off while it was down", async () => {
    await start();
    const a = await device("Phone 1");
    const b = await device("Phone 2");
    await (await phone(a.cookie)).act("push.subscribe", subArgs(new FakeUa(), "/a"));
    await (await phone(b.cookie)).act("push.subscribe", subArgs(new FakeUa(), "/b"));
    syncOn = false;
    sec.revoke(a.id);
    sec.setCap(b.id, "push", false);
    expect(push.subscribed(a.id)).toBe(true);
    restartPush(true);
    expect(push.subscribed(a.id)).toBe(false);
    expect(push.subscribed(b.id)).toBe(false);
  });

  it("refuses non-canonical base64url keys", async () => {
    await start();
    const d = await device();
    const p = await phone(d.cookie);
    const ua = new FakeUa();
    // 16 bytes take 22 characters; the last one's low 4 bits must be zero. Flip one of them.
    const last = ua.keys.auth.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const flipped = alphabet[alphabet.indexOf(last) ^ 1]!;
    const auth = ua.keys.auth.slice(0, -1) + flipped;
    expect(Buffer.from(auth, "base64url").toString("base64url")).not.toBe(auth);
    expect(await p.act("push.subscribe", { endpoint: fake.endpoint("/x"), keys: { ...ua.keys, auth } })).toMatchObject({ ok: false, code: "bad_keys" });
  });

  it("one subscription per endpoint: a phone paired again is not notified twice", async () => {
    await start();
    const a = await device("Phone 1");
    const b = await device("Phone 1 again");
    const ua = new FakeUa();
    await (await phone(a.cookie)).act("push.subscribe", subArgs(ua, "/same"));
    await (await phone(b.cookie)).act("push.subscribe", subArgs(ua, "/same"));
    expect(push.subscribed(a.id)).toBe(false);
    expect(push.subscribed(b.id)).toBe(true);
    addQuestion(142);
    await push.tick();
    expect(fake.received).toHaveLength(1);
  });

  it("GET /api/v1/push refuses a device that is only pending", async () => {
    await start();
    const { code } = sec.issueCode();
    const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name: "Phone 9" }));
    const sc = r.headers["set-cookie"];
    const cookie = (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]!;
    expect((await http("GET", "/api/v1/push", { ...OK_GET, Cookie: cookie })).status).toBe(401);
  });
});
