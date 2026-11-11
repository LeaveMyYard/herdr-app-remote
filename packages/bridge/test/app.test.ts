import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { CLOSE_FUNNEL, LinkServer, startApp, type App, type Runner, type RunResult } from "../src/index.js";

// Fake tailnet identity and fake data only.
const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;
const TOKEN = "token-0123456789abcdef0123456789abcdef";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const USAGE_DOC = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures/collect-v1.json"), "utf8");

let home: string;
let link: LinkServer;
let app: App | undefined;
let calls: { cmd: string; args: string[] }[];
/** What the fake `tailscale serve status --json` prints. */
let tsStatus: RunResult;
const peers: net.Socket[] = [];
const socks: WebSocket[] = [];

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });

/** Replays fixed outputs and records every command. Nothing is spawned. */
const fakeRun: Runner = async (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "fake-tailscale") return tsStatus;
  if (cmd === "fake-hc" && args[0] === "send") return ok('{"started":null,"status":null,"turn":0}\n');
  if (cmd === "fake-hc") return ok("hc 0.9.0\n");
  if (cmd === "fake-inbox") return ok("herdr-inbox app v1\n");
  if (cmd === "fake-usagebar" || (cmd === "/usr/bin/env" && args.includes("collect"))) return ok(USAGE_DOC);
  return { code: null, stdout: "", stderr: "", error: "ENOENT" };
};

const funnelOn = (hostPort: string, proxy = "http://127.0.0.1:1"): RunResult =>
  ok(JSON.stringify({ TCP: { "8443": { HTTPS: true } }, Web: { [hostPort]: { Handlers: { "/": { Proxy: proxy } } } }, AllowFunnel: { [hostPort]: true } }));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bridge-app-"));
  calls = [];
  tsStatus = ok("{}");
  link = new LinkServer({ token: TOKEN });
  await link.listen();
});

afterEach(async () => {
  for (const s of socks.splice(0)) s.terminate();
  for (const p of peers.splice(0)) p.destroy();
  await app?.stop();
  app = undefined;
  await link.close();
  await rm(home, { recursive: true, force: true });
});

async function start(over: Partial<Parameters<typeof startApp>[0]> = {}) {
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
    ...over,
  });
  return app;
}

// ---- the fake link mod ----

const HOST_TEXT = await readFile(join(FIXTURES, "host/typical.json"), "utf8");
const hostFixture = (): unknown => JSON.parse(HOST_TEXT);

interface Mod {
  socket: net.Socket;
  lines: Record<string, unknown>[];
  send(o: unknown): void;
}

async function linkMod(): Promise<Mod> {
  const socket = net.connect(link.port, "127.0.0.1");
  peers.push(socket);
  await new Promise<void>((r, j) => socket.once("connect", () => r()).once("error", j));
  const mod: Mod = { socket, lines: [], send: (o) => socket.write(JSON.stringify(o) + "\n") };
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      mod.lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
    }
  });
  const up = new Promise((r) => link.once("link", r));
  mod.send({ type: "hello", v: 1, token: TOKEN, copy: "link", layout: "herdr-remote", app: { version: "0.0.1" } });
  await up;
  return mod;
}

async function sendState(mod: Mod, seq = 1): Promise<void> {
  const got = new Promise((r) => link.once("host", r));
  mod.send({ type: "state", seq, host: hostFixture() });
  await got;
}

// ---- HTTP and WS as the phone, through a stand-in for serve ----

type Headers = Record<string, string>;
const OK_GET: Headers = { Host: SERVE, "Tailscale-User-Login": OWNER };
const OK_POST: Headers = { ...OK_GET, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" };

function http(method: string, path: string, headers: Headers, body?: string) {
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

async function paired(caps: { navigate?: boolean; terminal?: boolean } = {}): Promise<string> {
  const { code } = app!.security.issueCode();
  const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name: "Phone 1" }));
  expect(r.status).toBe(202);
  const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
  app!.security.approve(id);
  if (caps.navigate) app!.security.setCap(id, "navigate", true);
  if (caps.terminal) app!.security.setCap(id, "terminal.input", true);
  const sc = r.headers["set-cookie"];
  return (Array.isArray(sc) ? sc[0]! : sc!).split(";")[0]!;
}

interface Phone {
  ws: WebSocket;
  msgs: bridgeApi.ServerMessage[];
  until<T extends bridgeApi.ServerMessage>(pred: (m: bridgeApi.ServerMessage) => m is T, ms?: number): Promise<T>;
  until(pred: (m: bridgeApi.ServerMessage) => boolean, ms?: number): Promise<bridgeApi.ServerMessage>;
  closed: Promise<number>;
}

function phone(cookie: string): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app!.port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { ...OK_GET, Origin: ORIGIN, Cookie: cookie } });
    socks.push(ws);
    const msgs: bridgeApi.ServerMessage[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as bridgeApi.ServerMessage));
    const until = async (pred: (m: bridgeApi.ServerMessage) => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      for (;;) {
        const m = msgs.find(pred);
        if (m) return m;
        if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(msgs.map((x) => x.type))}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const closed = new Promise<number>((r) => ws.once("close", (c) => r(c)));
    ws.once("open", () => resolve({ ws, msgs, until: until as Phone["until"], closed }));
    ws.once("unexpected-response", (_q, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

const send = (p: Phone, m: unknown) => p.ws.send(JSON.stringify(m));
const snapOf = (topic: string) => (m: bridgeApi.ServerMessage): m is bridgeApi.Snap => m.type === "snap" && m.topic === topic;
const resOf = (id: string) => (m: bridgeApi.ServerMessage): m is bridgeApi.Res => m.type === "res" && m.id === id;

describe("startApp: binding and the guards", () => {
  it("binds the API on 127.0.0.1 only and answers /healthz", async () => {
    await start();
    expect((app!.server.server.address() as net.AddressInfo).address).toBe("127.0.0.1");
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
  });

  it("wires the S5 guard: no identity, a foreign Host or no device are refused", async () => {
    await start();
    expect((await http("GET", "/api/v1/meta", { Host: SERVE })).status).toBe(403);
    expect((await http("GET", "/api/v1/meta", { ...OK_GET, Host: "evil.example" })).status).toBe(403);
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(200);
    await expect(phone("__Host-hr-device=" + "x".repeat(43))).rejects.toThrow(/401/);
  });

  it("refuses everything but /healthz until setup gave a serve name", async () => {
    await start({ serve: null });
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(403);
    app!.setServe({ host: SERVE, login: OWNER });
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(200);
  });
});

describe("startApp: Funnel", () => {
  it("refuses every request, /healthz included, while Funnel is on for the serve port", async () => {
    tsStatus = funnelOn(`${SERVE}:8443`);
    await start();
    expect(app!.funnel).toEqual({ state: "on", where: `${SERVE}:8443` });
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(503);
    expect((await http("GET", "/api/v1/meta", OK_GET)).status).toBe(503);
  });

  it("refuses while Funnel is on for another port that forwards to the API port", async () => {
    await start();
    tsStatus = funnelOn(`${SERVE}:443`, `http://127.0.0.1:${app!.port}`);
    await app!.checkFunnel();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(503);
  });

  it("drops live sockets when Funnel turns on, and serves again once it is off", async () => {
    await start();
    const p = await phone(await paired());
    tsStatus = funnelOn(`${SERVE}:8443`);
    await app!.checkFunnel();
    expect(await p.closed).toBe(CLOSE_FUNNEL);
    tsStatus = ok("{}");
    await app!.checkFunnel();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
  });

  it("keeps refusing when a later check can't tell (tailscale fails)", async () => {
    tsStatus = funnelOn(`${SERVE}:8443`);
    await start();
    tsStatus = { code: 1, stdout: "", stderr: "boom" };
    await app!.checkFunnel();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(503);
  });

  it("refuses while the first check can't tell, and serves once a check says off", async () => {
    tsStatus = { code: 1, stdout: "", stderr: "boom" };
    await start();
    expect(app!.funnel?.state).toBe("unknown");
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(503);
    tsStatus = ok("{}");
    await app!.checkFunnel();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
  });

  it("keeps serving when a check fails after a clean off", async () => {
    await start();
    tsStatus = { code: null, stdout: "", stderr: "", error: "timeout" };
    await app!.checkFunnel();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
  });

  it("refuses acts from the moment Funnel turns on, before the socket is gone", async () => {
    await start();
    const cookie = await paired();
    const id = app!.security.devices()[0]!.id;
    const got: bridgeApi.ServerMessage[] = [];
    const client = { principal: { deviceId: id }, send: (m: bridgeApi.ServerMessage) => void got.push(m), close: () => undefined };
    expect(cookie).toBeTruthy();
    const conn = app!.hub.connect(client);
    await app!.hub.handleRaw(conn, JSON.stringify({ type: "hello", api: 1 }));
    tsStatus = funnelOn(`${SERVE}:8443`);
    await app!.checkFunnel();
    await app!.hub.handleRaw(conn, JSON.stringify({ type: "act", id: "f1", kind: "usage.refresh", args: {} }));
    expect(got.at(-1)).toMatchObject({ type: "res", id: "f1", ok: false, code: "funnel" });
    expect(calls.some((c) => c.cmd === "/usr/bin/env")).toBe(false);
  });

  it("serves when tailscale is not installed (nothing can be funneled)", async () => {
    tsStatus = { code: null, stdout: "", stderr: "", error: "ENOENT" };
    await start();
    expect((await http("GET", "/healthz", { Host: "127.0.0.1" })).status).toBe(200);
  });

  it("only ever reads serve status", async () => {
    await start();
    await app!.checkFunnel();
    const ts = calls.filter((c) => c.cmd === "fake-tailscale");
    expect(ts.length).toBeGreaterThan(0);
    for (const c of ts) expect(c.args).toEqual(["serve", "status", "--json"]);
  });
});

describe("startApp: topics over the link", () => {
  it("publishes host from the link (as HostSource), plugins and panorama to a paired phone", async () => {
    await start();
    const mod = await linkMod();
    await sendState(mod);
    const p = await phone(await paired());
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["host", "plugins", "panorama"] });
    const host = await p.until(snapOf("host"));
    expect(host.data).toEqual(hostFixture());
    const plugins = await p.until(snapOf("plugins"));
    expect(bridgeApi.PluginsTopic.parse(plugins.data)).toMatchObject({ hc: { state: "ready" }, inbox: { state: "ready" }, usage: { state: "ready" } });
    send(p, { type: "sub", topics: ["inbox"] });
    const inbox = await p.until(snapOf("inbox"), 4000);
    expect(bridgeApi.InboxTopic.safeParse(inbox.data).success).toBe(true);
    const pano = await p.until(snapOf("panorama"), 4000);
    expect(bridgeApi.PanoramaTopic.safeParse(pano.data).success).toBe(true);
  });

  it("picks up a link that was already up before the app started", async () => {
    const mod = await linkMod();
    await sendState(mod);
    await start();
    expect(app!.hub.get("host")).toEqual(hostFixture());
  });

  it("marks host stale reconnecting when the link copy goes, keeping the last state", async () => {
    await start();
    const mod = await linkMod();
    await sendState(mod);
    const p = await phone(await paired());
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["host"] });
    await p.until(snapOf("host"));
    mod.socket.destroy();
    const st = await p.until((m) => m.type === "stale" && m.topic === "host");
    expect(st).toMatchObject({ reason: "reconnecting" });
    expect(app!.hub.get("host")).toEqual(hostFixture());
  });

  it("polls usage only while subscribed, and routes usage acts through the security layer", async () => {
    await start();
    expect(calls.some((c) => c.args.includes("collect") && c.cmd === "/usr/bin/env")).toBe(false);
    const p = await phone(await paired());
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["usage"] });
    const snap = await p.until((m): m is bridgeApi.Snap => m.type === "snap" && m.topic === "usage" && (m.data as { report: unknown }).report !== null);
    expect(bridgeApi.UsageTopic.parse(snap.data).filter).toBe("open-panes");
    send(p, { type: "act", id: "u1", kind: "usage.set_filter", args: { filter: "all" } });
    expect(await p.until(resOf("u1"))).toMatchObject({ ok: true });
    expect(calls.some((c) => c.args.includes("--all"))).toBe(true);
    send(p, { type: "act", id: "u2", kind: "usage.refresh", args: {} });
    expect(await p.until(resOf("u2"))).toMatchObject({ ok: true });
    // The bridge never consumes the desktop's toasts.
    expect(calls.some((c) => c.args.includes("notify"))).toBe(false);
    // Collect runs the binary from agent-usage's local.json defaults under the (fake) home, never a shell.
    expect(calls.find((c) => c.cmd === "/usr/bin/env")!.args[1]).toBe(`${home}/.local/bin/usagebar`);
  });

  it("sends navigate acts to the link copy as an allowlisted run, only with the navigate capability", async () => {
    await start();
    const mod = await linkMod();
    const plain = await phone(await paired());
    send(plain, { type: "hello", api: 1 });
    send(plain, { type: "act", id: "n0", kind: "tab.select", args: { index: 2 } });
    expect(await plain.until(resOf("n0"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mod.lines.some((l) => l.type === "run")).toBe(false);

    const nav = await phone(await paired({ navigate: true }));
    send(nav, { type: "hello", api: 1 });
    send(nav, { type: "act", id: "n1", kind: "tab.select", args: { index: 2 } });
    const end = Date.now() + 2000;
    while (!mod.lines.some((l) => l.type === "run") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const run = mod.lines.find((l) => l.type === "run")!;
    expect(run).toMatchObject({ name: "tab.select", args: { index: 2 } });
    mod.send({ type: "result", id: run.id, ok: true });
    expect(await nav.until(resOf("n1"))).toMatchObject({ ok: true });
    expect(app!.security.activity().some((e) => e.text.includes("tab.select"))).toBe(true);
  });

  it("routes inbox acts to the inbox driver, and refuses anything off the allowlist", async () => {
    await start();
    const p = await phone(await paired());
    send(p, { type: "hello", api: 1 });
    // The inbox driver takes it (no inbox installed here: unavailable), and a malformed one is bad_args.
    send(p, { type: "act", id: "x1", kind: "inbox.ack", args: { key: "alert:1", rev: "r" } });
    send(p, { type: "act", id: "x3", kind: "inbox.ack", args: { id: "Q1" } });
    send(p, { type: "act", id: "x2", kind: "tab.new", args: {} });
    expect(await p.until(resOf("x1"))).toMatchObject({ ok: false, code: "unavailable" });
    expect(await p.until(resOf("x3"))).toMatchObject({ ok: false, code: "bad_args" });
    expect(await p.until(resOf("x2"))).toMatchObject({ ok: false, code: "unsupported_action" });
  });

  it("reads a chat:<t> topic with hc read while subscribed, and nothing before", async () => {
    await start();
    expect(calls.some((c) => c.cmd === "fake-hc" && c.args[0] === "read")).toBe(false);
    const p = await phone(await paired());
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["chat:t3"] });
    const end = Date.now() + 3000;
    while (!calls.some((c) => c.cmd === "fake-hc" && c.args[0] === "read") && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const read = calls.find((c) => c.cmd === "fake-hc" && c.args[0] === "read")!;
    expect(read.args.slice(0, 2)).toEqual(["read", "t3"]);
    // Read-only: nothing is ever sent to a terminal.
    expect(calls.some((c) => c.args.includes("send"))).toBe(false);
  });

  it("terminal.send runs hc send only with terminal.input, and Activity holds the length, never the text", async () => {
    await start();
    const off = await phone(await paired());
    send(off, { type: "hello", api: 1 });
    send(off, { type: "act", id: "s0", kind: "terminal.send", args: { terminal: "t3", text: "secret words here" } });
    expect(await off.until(resOf("s0"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls.some((c) => c.args[0] === "send")).toBe(false);

    const on = await phone(await paired({ terminal: true }));
    send(on, { type: "hello", api: 1 });
    send(on, { type: "act", id: "s1", kind: "terminal.send", args: { terminal: "t3", text: "secret words here" } });
    expect(await on.until(resOf("s1"))).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.args[0] === "send")).toEqual([{ cmd: "fake-hc", args: ["send", "--json", "--", "t3", "secret words here"] }]);
    const text = app!.security.activity().map((e) => e.text);
    expect(text).toContain("Phone 1 (2) sent 17 chars to t3");
    expect(JSON.stringify(app!.security.activity())).not.toContain("secret");
  });

  it("stop() closes the API listener and leaves the link server to its owner", async () => {
    await start();
    const port = app!.port;
    await app!.stop();
    app = undefined;
    expect(link.port).toBeGreaterThan(0);
    await expect(
      new Promise((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, path: "/healthz" }, resolve);
        r.on("error", reject);
        r.end();
      }),
    ).rejects.toThrow();
  });
});

describe("startApp: the desktop panel", () => {
  async function panelMod(): Promise<Mod> {
    const socket = net.connect(link.port, "127.0.0.1");
    peers.push(socket);
    await new Promise<void>((r, j) => socket.once("connect", () => r()).once("error", j));
    const mod: Mod = { socket, lines: [], send: (o) => socket.write(JSON.stringify(o) + "\n") };
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        mod.lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        buf = buf.slice(i + 1);
      }
    });
    const up = new Promise((r) => link.once("link", r));
    mod.send({ type: "hello", v: 1, token: TOKEN, copy: "panel", layout: "herdr-remote", app: { version: "0.0.1" } });
    await up;
    return mod;
  }
  const waitLine = async (m: Mod, pred: (l: Record<string, unknown>) => boolean, ms = 1000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = m.lines.findIndex(pred);
      if (i >= 0) return m.lines.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error("timed out waiting for a line");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("a pairing request toasts the link copy with open_panel, and the panel copy sees the pending phone", async () => {
    await start();
    const mod = await linkMod();
    const panel = await panelMod();
    await waitLine(panel, (l) => l.type === "panel");
    const { code } = app!.security.issueCode();
    const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name: "Phone 1" }));
    expect(r.status).toBe(202);
    const toast = await waitLine(mod, (l) => l.type === "notify");
    expect(toast).toMatchObject({ level: "info", action: "open_panel" });
    expect(String(toast.message)).toContain("Phone 1");
    const view = (await waitLine(panel, (l) => l.type === "panel" && (l.view as { devices: unknown[] }).devices.length === 1)).view as { devices: { state: string }[] };
    expect(view.devices[0]!.state).toBe("pending");
  });

  it("a security change reaches the panel at once, not on the 2 s recheck", async () => {
    await start();
    const panel = await panelMod();
    await waitLine(panel, (l) => l.type === "panel");
    app!.security.pause();
    const m = await waitLine(panel, (l) => l.type === "panel" && (l.view as { status: string }).status === "paused", 800);
    expect(m.type).toBe("panel");
  });
});
