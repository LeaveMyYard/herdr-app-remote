// `GET /api/v1/chatview/<t>` (CV3): the same guards as every request, the topic's capabilities, a rate limit,
// and Activity by count only. And the chat open's Activity line (once per subscription; refused when Activity
// can't record it).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { chatviewRoute, PAGE_LIMIT } from "../../src/chatview/route.js";
import type { PageResult } from "../../src/chatview/topic.js";
import type { Hub } from "../../src/hub.js";
import { Security } from "../../src/security/index.js";
import { createBridgeServer, type BridgeServer } from "../../src/server.js";
import { newHub } from "../helpers.js";
import { U } from "./helpers.js";

const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;

let dir: string;
let sec: Security;
let srv: BridgeServer;
let hub: Hub;
let port: number;
let clock: number;
let pages: { t: string; before: string; n: number; rev?: string | undefined }[];
let answer: PageResult;

const PAGE: bridgeApi.ChatviewPage = { items: [{ id: U(1), role: "you", at: null, text: "Question Title 123 secret text" }], older: true, rev: "ab12" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-chatview-"));
  clock = 1_000_000;
  pages = [];
  answer = { ok: true, page: PAGE };
  sec = new Security({ dataDir: join(dir, "data"), serve: { host: SERVE, login: OWNER }, now: () => clock, inner: () => ({ ok: true }), onTopicsCut: (id) => hub.recheck(id) });
  hub = newHub({ onAct: sec.act, mayRead: sec.mayRead });
  const route = chatviewRoute({
    gate: {
      requestDevice: (req, needs) => sec.requestDevice(req, needs),
      auditChatPage: (id, t, n) => sec.auditChatPage(id, t, n),
      note: (e) => sec.note(e),
      deviceName: (id) => sec.deviceName(id),
      origin: () => sec.origin(),
    },
    page: (t, before, n, rev) => {
      pages.push({ t, before, n, rev });
      return answer;
    },
    now: () => clock,
  });
  srv = createBridgeServer({ hub, guard: sec.guard, routes: async (req, res, path) => (await sec.routes(req, res, path)) || route(req, res, path), onConnect: sec.onConnect });
  port = (await srv.listen()).port;
});
afterEach(async () => {
  sec?.close();
  await srv?.close();
  await rm(dir, { recursive: true, force: true });
});

type Headers = Record<string, string | undefined>;
interface Resp {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
function http(method: string, path: string, headers: Headers, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const r = request({ host: "127.0.0.1", port, method, path, headers: h, setHost: false }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

async function paired(): Promise<{ id: string; cookie: string }> {
  const { code } = sec.issueCode();
  const r = await http("POST", "/api/v1/pair", { Host: SERVE, "Tailscale-User-Login": OWNER, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" }, JSON.stringify({ code }));
  const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
  sec.approve(id);
  const sc = r.headers["set-cookie"];
  return { id, cookie: (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]! };
}

const get = (path: string, cookie: string | undefined, over: Headers = {}) =>
  http("GET", path, { Host: SERVE, "Tailscale-User-Login": OWNER, "X-Remote-Api": "1", ...(cookie ? { Cookie: cookie } : {}), ...over });
const activity = () => sec.activity(1000).map((e) => e.text);
const PATH = `/api/v1/chatview/t3?before=${U(5)}&n=20`;

describe("GET /api/v1/chatview/<t>", () => {
  it("returns the page to a device with view and transcript.read, and records it by count only", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    const r = await get(`${PATH}&rev=ab12`, cookie);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(bridgeApi.ChatviewPage.parse(JSON.parse(r.body))).toEqual(PAGE);
    expect(pages).toEqual([{ t: "t3", before: U(5), n: 20, rev: "ab12" }]);
    expect(activity()).toContain("Phone 1 loaded 1 earlier message of t3");
    expect(JSON.stringify(sec.activity(1000))).not.toContain("Question Title");
    // n defaults to 50; a terminal on another host is an address with a slash.
    expect((await get(`/api/v1/chatview/vps%2Ft7?before=${U(5)}`, cookie)).status).toBe(200);
    expect(pages.at(-1)).toEqual({ t: "vps/t7", before: U(5), n: 50, rev: undefined });
  });

  it("is 403 without transcript.read, and reads nothing", async () => {
    const { cookie } = await paired();
    const r = await get(PATH, cookie);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "forbidden" });
    expect(pages).toEqual([]);
  });

  it("is 401 without view or a device, and refused by the guard while paused", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    sec.setCap(id, "view", false);
    expect((await get(PATH, cookie)).status).toBe(401);
    sec.setCap(id, "view", true);
    sec.pause();
    expect((await get(PATH, cookie)).status).toBe(503);
    sec.resume();
    expect((await get(PATH, undefined)).status).toBe(401);
    sec.revoke(id);
    expect((await get(PATH, cookie)).status).toBe(401);
    expect(pages).toEqual([]);
  });

  it("has the guards of every request: Host, login, the API marker and the exact Origin", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    expect((await get(PATH, cookie, { Host: "evil.example" })).status).toBe(403);
    expect((await get(PATH, cookie, { "Tailscale-User-Login": "user-2@example" })).status).toBe(403);
    expect((await get(PATH, cookie, { "X-Remote-Api": undefined })).status).toBe(403);
    expect((await get(PATH, cookie, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await get(PATH, cookie, { Origin: ORIGIN })).status).toBe(200);
    expect((await http("POST", PATH, { Host: SERVE, "Tailscale-User-Login": OWNER, Origin: ORIGIN, "X-Remote-Api": "1", Cookie: cookie })).status).toBe(405);
    expect(pages).toHaveLength(1);
  });

  it("refuses bad arguments", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    for (const p of [
      `/api/v1/chatview/-rf?before=${U(5)}`,
      `/api/v1/chatview/t3?before=`,
      `/api/v1/chatview/t3?before=${U(5)}&n=51`,
      `/api/v1/chatview/t3?before=${U(5)}&n=0`,
      `/api/v1/chatview/t3?before=${U(5)}&n=abc`,
      `/api/v1/chatview/t3?before=${U(5)}&rev=../x`,
      `/api/v1/chatview/t3?before=..%2Fetc`,
    ]) {
      expect((await get(p, cookie)).status, p).toBe(400);
    }
    expect(pages).toEqual([]);
  });

  it("passes the topic's refusals on", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    answer = { ok: false, status: 409, code: "not_open" };
    const r = await get(PATH, cookie);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "not_open" });
  });

  it("allows 20 per 10 s per device", async () => {
    expect(PAGE_LIMIT).toEqual({ max: 20, windowMs: 10_000 });
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    for (let i = 0; i < PAGE_LIMIT.max; i++) expect((await get(PATH, cookie)).status).toBe(200);
    expect((await get(PATH, cookie)).status).toBe(429);
    expect((await get(PATH, cookie)).status).toBe(429);
    expect(activity().filter((t) => t === "Phone 1 loaded earlier messages too fast: refused")).toHaveLength(1);
    clock += PAGE_LIMIT.windowMs;
    expect((await get(PATH, cookie)).status).toBe(200);
  });

  it("is refused while Activity can't be written", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    const f = join(dir, "data", "activity.jsonl");
    await rm(f, { force: true });
    await mkdir(f);
    const r = await get(PATH, cookie);
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ error: "audit_unavailable" });
  });
});

describe("opening a chat (Activity, §5.3)", () => {
  interface Sock {
    ws: WebSocket;
    msgs: bridgeApi.ServerMessage[];
    next(n: number): Promise<void>;
  }
  async function socket(cookie: string): Promise<Sock> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { Host: SERVE, "Tailscale-User-Login": OWNER, Origin: ORIGIN, Cookie: cookie } });
    const msgs: bridgeApi.ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.on("message", (m: Buffer) => {
      msgs.push(JSON.parse(m.toString()) as bridgeApi.ServerMessage);
      for (const w of waiters) w();
    });
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    const next = (n: number) =>
      new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`got ${JSON.stringify(msgs)}`)), 3000);
        const c = () => {
          if (msgs.length >= n) {
            clearTimeout(t);
            res();
          }
        };
        waiters.push(c);
        c();
      });
    ws.send(JSON.stringify({ type: "hello", api: 1 }));
    await next(1);
    return { ws, msgs, next };
  }
  const opens = () => activity().filter((t) => t === "Phone 1 opened the chat of t3");

  it("is one Activity line per subscription: not for a re-sub of the one it holds, again for a new connection", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    hub.publish("chatview:t3", { n: 1 });
    const s = await socket(cookie);
    s.ws.send(JSON.stringify({ type: "sub", topics: ["chatview:t3", "timeline:t3", "keys"] }));
    await s.next(2);
    expect(opens()).toHaveLength(1);
    s.ws.send(JSON.stringify({ type: "sub", topics: ["chatview:t3", "timeline:t3"] }));
    await s.next(3);
    expect(opens()).toHaveLength(1);
    // The timeline (CV5) is its own open, once per subscription too.
    expect(activity().filter((t) => t === "Phone 1 opened the timeline of t3")).toHaveLength(1);
    s.ws.close();
    const s2 = await socket(cookie);
    s2.ws.send(JSON.stringify({ type: "sub", topics: ["chatview:t3"] }));
    await s2.next(2);
    expect(opens()).toHaveLength(2);
    // The desktop turning it off is a recheck: no open line, the switch's own line says it.
    sec.setCap(id, "transcript.read", false);
    await s2.next(3);
    expect(s2.msgs[2]).toEqual({ type: "stale", topic: "chatview:t3", reason: "forbidden" });
    expect(opens()).toHaveLength(2);
    s2.ws.close();
  });

  it("is refused (stale audit_unavailable, nothing sent) while Activity can't record it", async () => {
    const { id, cookie } = await paired();
    sec.setCap(id, "transcript.read", true);
    hub.publish("chatview:t3", { n: 1 });
    const f = join(dir, "data", "activity.jsonl");
    await rm(f, { force: true });
    await mkdir(f);
    const s = await socket(cookie);
    s.ws.send(JSON.stringify({ type: "sub", topics: ["chatview:t3", "keys"] }));
    await s.next(2);
    expect(s.msgs[1]).toEqual({ type: "stale", topic: "chatview:t3", reason: "audit_unavailable" });
    expect(bridgeApi.ServerMessage.safeParse(s.msgs[1]).success).toBe(true);
    expect(s.msgs.some((m) => m.type === "snap" && m.topic === "chatview:t3")).toBe(false);
    await rm(f, { recursive: true });
    s.ws.send(JSON.stringify({ type: "sub", topics: ["chatview:t3"] }));
    await s.next(3);
    expect(s.msgs[2]).toMatchObject({ type: "snap", topic: "chatview:t3" });
    expect(opens()).toHaveLength(1);
    s.ws.close();
  });
});

describe("requestDevice needs a capability list", () => {
  it("has no default: every caller names what it needs", async () => {
    const { cookie } = await paired();
    const req = { rawHeaders: ["Cookie", cookie] } as unknown as import("node:http").IncomingMessage;
    // @ts-expect-error `needs` is required, so no route grants by default.
    expect(() => sec.requestDevice(req)).toThrow();
    expect(sec.requestDevice(req, [])).toBeDefined();
    expect(sec.requestDevice(req, ["transcript.read"])).toBeUndefined();
  });
});
