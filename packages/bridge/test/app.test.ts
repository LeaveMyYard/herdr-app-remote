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
/** When set, `hc send` waits for its abort signal instead of answering (a send held while the desktop is typed on). */
let holdSends = false;
/** Likewise for `hc keys`. */
let holdKeys = false;
const fakeRun: Runner = async (cmd, args, opts) => {
  calls.push({ cmd, args });
  if (cmd === "fake-hc" && args[0] === "keys" && holdKeys)
    return new Promise((resolve) => opts.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "", error: "aborted" })));
  if (cmd === "fake-hc" && args[0] === "keys") return ok('{"status":null,"turn":0}\n');
  if (cmd === "fake-hc" && args[0] === "send" && holdSends)
    return new Promise((resolve) => opts.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "", error: "aborted" })));
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
  holdSends = false;
  holdKeys = false;
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

async function paired(caps: { navigate?: boolean; terminal?: boolean; keys?: boolean; prompts?: boolean } = {}): Promise<string> {
  const { code } = app!.security.issueCode();
  const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name: "Phone 1" }));
  expect(r.status).toBe(202);
  const id = (JSON.parse(r.body) as { device: { id: string } }).device.id;
  app!.security.approve(id);
  if (caps.navigate) app!.security.setCap(id, "navigate", true);
  if (caps.terminal) app!.security.setCap(id, "terminal.input", true);
  if (caps.keys) app!.security.setCap(id, "terminal.keys", true);
  if (caps.prompts) app!.security.setCap(id, "prompt.answer", true);
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

  it("meta carries the computer's name from the serve identity", async () => {
    await start();
    const m = await http("GET", "/api/v1/meta", OK_GET);
    expect(JSON.parse(m.body)).toMatchObject({ api: 1, host_name: "desk-1" });
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

  it("builds --panes from the mod's agents the way the desktop panel does (program key, not the app name), for both filters", async () => {
    await start();
    const mod = await linkMod();
    const host = hostFixture() as { agents: Record<string, unknown>[] };
    host.agents = [
      { ...host.agents[0], harness: "claude-code", program: "claude" },
      { ...host.agents[1], harness: "codex", program: "codex" },
      { ...host.agents[1], id: "agent-3", name: "Agent 3", terminal_id: "term-3", harness: "antigravity-cli", program: "antigravity" },
      { id: "agent-4", name: "Agent 4", harness: "claude-code", state: "idle", space_id: "space-1", terminal_id: "term-4" },
    ];
    const got = new Promise((r) => link.once("host", r));
    mod.send({ type: "state", seq: 1, host });
    await got;
    const p = await phone(await paired());
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["usage"] });
    await p.until((m): m is bridgeApi.Snap => m.type === "snap" && m.topic === "usage" && (m.data as { report: unknown }).report !== null);
    const panes = (args: string[]) => JSON.parse(args[args.indexOf("--panes") + 1]!) as { paneId: string; agent: string; label: string }[];
    const want = [
      { paneId: "term-1", agent: "claude", label: "Agent 1" },
      { paneId: "term-2", agent: "codex", label: "Agent 2" },
      { paneId: "term-3", agent: "agy", label: "Agent 3" },
      // An older link mod sends no program: the app name is mapped.
      { paneId: "term-4", agent: "claude", label: "Agent 4" },
    ];
    const open = calls.find((c) => c.cmd === "/usr/bin/env" && c.args.includes("collect"))!;
    expect(open.args).not.toContain("--all");
    expect(panes(open.args)).toEqual(want);
    send(p, { type: "act", id: "u1", kind: "usage.set_filter", args: { filter: "all" } });
    expect(await p.until(resOf("u1"))).toMatchObject({ ok: true });
    const all = calls.filter((c) => c.cmd === "/usr/bin/env" && c.args.includes("--all")).at(-1)!;
    expect(panes(all.args)).toEqual(want);
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
    expect(text).toContain("Phone 2 sent 17 chars to t3");
    expect(JSON.stringify(app!.security.activity())).not.toContain("secret");
  });

  it("turning terminal.input off kills a send still held by hc: an unknown effect, not a late keystroke", async () => {
    await start();
    holdSends = true;
    const p = await phone(await paired({ terminal: true }));
    send(p, { type: "hello", api: 1 });
    send(p, { type: "act", id: "h1", kind: "terminal.send", args: { terminal: "t3", text: "held" } });
    const end = Date.now() + 2000;
    while (!calls.some((c) => c.args[0] === "send") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const id = app!.security.devices().find((d) => d.caps["terminal.input"])!.id;
    app!.security.setCap(id, "terminal.input", false);
    expect(await p.until(resOf("h1"))).toMatchObject({ ok: false, code: "cancelled", unknown_effect: true });
  });

  it("Funnel turning on kills every send still held by hc", async () => {
    await start();
    holdSends = true;
    const p = await phone(await paired({ terminal: true }));
    send(p, { type: "hello", api: 1 });
    send(p, { type: "act", id: "f1", kind: "terminal.send", args: { terminal: "t3", text: "held" } });
    const end = Date.now() + 2000;
    while (!calls.some((c) => c.args[0] === "send") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const res = p.until(resOf("f1"));
    tsStatus = funnelOn(`${SERVE}:8443`);
    await app!.checkFunnel();
    // The socket closes for Funnel; the res may still arrive before the close completes, so either proves the kill.
    const settled = await Promise.race([res.then(() => "res"), p.closed.then(() => "closed")]);
    expect(["res", "closed"]).toContain(settled);
    const held = calls.filter((c) => c.args[0] === "send");
    expect(held).toHaveLength(1);
    expect(app!.security.activity().some((e) => e.text.includes("sent 4 chars to t3: result unknown"))).toBe(true);
  });

  it("transcript topics (CV1) need transcript.read: refused without it, served with it, ended when it goes off", async () => {
    await start();
    const cookie = await paired();
    const id = app!.security.devices()[0]!.id;
    // A stand-in for the CV3 source: the hub holds a value, so a granted sub would snap at once.
    app!.hub.publish("chatview:t3", { terminal: "t3", text: "Question Title 123" });
    app!.hub.publish("timeline:t3", { terminal: "t3", items: [] });
    const p = await phone(cookie);
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["chatview:t3", "timeline:t3", "host"] });
    const isStale = (t: string) => (m: bridgeApi.ServerMessage) => m.type === "stale" && m.topic === t;
    expect(await p.until(isStale("chatview:t3"))).toEqual({ type: "stale", topic: "chatview:t3", reason: "forbidden" });
    await p.until(isStale("timeline:t3"));
    expect(p.msgs.some((m) => m.type === "snap" && m.topic !== "host")).toBe(false);
    expect(app!.security.activity().map((e) => e.text)).toContain("Phone 1 opened the chat of t3: refused, chat history is off");

    app!.security.setCap(id, "transcript.read", true);
    send(p, { type: "sub", topics: ["chatview:t3", "timeline:t3"] });
    expect(await p.until(snapOf("chatview:t3"))).toMatchObject({ data: { text: "Question Title 123" } });
    await p.until(snapOf("timeline:t3"));

    const n = p.msgs.length;
    app!.security.setCap(id, "transcript.read", false);
    await p.until((m) => p.msgs.indexOf(m) >= n && m.type === "stale" && m.topic === "chatview:t3");
    await p.until((m) => p.msgs.indexOf(m) >= n && m.type === "stale" && m.topic === "timeline:t3");
    app!.hub.publish("chatview:t3", { terminal: "t3", text: "Question Title 124" });
    // The socket stays open (view is untouched), and a ping round trip proves nothing more came on the topic.
    send(p, { type: "ping" });
    await p.until((m) => p.msgs.indexOf(m) >= n && m.type === "pong");
    expect(p.msgs.slice(n).filter((m) => (m.type === "patch" || m.type === "snap") && m.topic === "chatview:t3")).toEqual([]);
    expect(JSON.stringify(p.msgs)).not.toContain("Question Title 124");
  });

  it("serves chatview:<t> (CV3) and its older pages behind transcript.read; without panorama it is unavailable, never guessed", async () => {
    await start();
    const mod = await linkMod();
    await sendState(mod);
    const cookie = await paired();
    const id = app!.security.devices()[0]!.id;
    const page = (c: string, extra: Headers = {}) => http("GET", "/api/v1/chatview/term-1?before=a1000000-0000-4000-8000-000000000002", { ...OK_GET, "X-Remote-Api": "1", Cookie: c, ...extra });
    expect((await page(cookie)).status).toBe(403);
    app!.security.setCap(id, "transcript.read", true);
    const p = await phone(cookie);
    send(p, { type: "hello", api: 1 });
    send(p, { type: "sub", topics: ["chatview:term-1"] });
    const snap = await p.until(snapOf("chatview:term-1"));
    // No feed in this app home: panorama can't prove a session, so there is no chat view (the phone shows the terminal).
    expect(snap.data).toEqual({ terminal: "term-1", harness: "unknown", state: "unavailable", reason: "no_panorama", items: [], older: false, rev: "", status: { state: "working", since: null } });
    expect(app!.security.activity().map((e) => e.text)).toContain("Phone 1 opened the chat of term-1");
    // Pages come only from an open chat view.
    const r = await page(cookie);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "not_open" });
  });

  it("terminal.keys presses a menu entry's keys only with terminal.keys; Activity names the entry, never the label", async () => {
    await start();
    const off = await phone(await paired({ terminal: true }));
    send(off, { type: "hello", api: 1 });
    send(off, { type: "sub", topics: ["keys"] });
    const snap = await off.until(snapOf("keys"));
    const menu = bridgeApi.KeysTopic.parse(snap.data);
    expect(menu.keys.map((k) => k.id)).toEqual(["esc", "tab", "shift-tab", "ctrl-c", "up", "down", "left", "right"]);
    send(off, { type: "act", id: "k0", kind: "terminal.keys", args: { terminal: "t3", key: "ctrl-c", rev: menu.rev } });
    expect(await off.until(resOf("k0"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls.some((c) => c.args[0] === "keys")).toBe(false);

    const on = await phone(await paired({ keys: true }));
    send(on, { type: "hello", api: 1 });
    send(on, { type: "act", id: "k1", kind: "terminal.keys", args: { terminal: "t3", key: "shift-tab", rev: menu.rev } });
    const r = await on.until(resOf("k1"));
    expect(r).toMatchObject({ ok: true });
    // audit_label stays on the bridge.
    expect(JSON.stringify(r)).not.toContain("audit");
    send(on, { type: "act", id: "k2", kind: "terminal.keys", args: { terminal: "t3", key: "esc", rev: "0123456789abcdef" } });
    expect(await on.until(resOf("k2"))).toMatchObject({ ok: false, code: "keys_changed" });
    // A device with terminal.keys alone can't type text.
    send(on, { type: "act", id: "k3", kind: "terminal.send", args: { terminal: "t3", text: "hello" } });
    expect(await on.until(resOf("k3"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls.filter((c) => c.args[0] === "keys" || c.args[0] === "send")).toEqual([{ cmd: "fake-hc", args: ["keys", "--json", "--", "t3", "shift+tab"] }]);
    const text = app!.security.activity().map((e) => e.text);
    expect(text).toContain("Phone 2 pressed shift-tab (1 key) in t3");
    expect(text).toContain("Phone 2 pressed a key in t3: failed");
    expect(JSON.stringify(app!.security.activity())).not.toContain("Shift-Tab");
  });

  it("prompt.answer (CV7) needs its own capability; with it, a card the bridge never published presses nothing", async () => {
    await start();
    const args = { terminal: "t3", prompt_id: "a".repeat(64), rev: "r1", choice: { option: 0 } };
    // Typing and the key menu don't imply it.
    const off = await phone(await paired({ terminal: true, keys: true }));
    send(off, { type: "hello", api: 1 });
    send(off, { type: "act", id: "p0", kind: "prompt.answer", args });
    expect(await off.until(resOf("p0"))).toMatchObject({ ok: false, code: "forbidden" });
    const on = await phone(await paired({ prompts: true }));
    send(on, { type: "hello", api: 1 });
    send(on, { type: "act", id: "p1", kind: "prompt.answer", args });
    expect(await on.until(resOf("p1"))).toMatchObject({ ok: false, code: "prompt_changed" });
    // prompt.answer alone can't type.
    send(on, { type: "act", id: "p2", kind: "terminal.send", args: { terminal: "t3", text: "hello" } });
    expect(await on.until(resOf("p2"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(calls.some((c) => c.args[0] === "keys" || c.args[0] === "send")).toBe(false);
    const text = app!.security.activity().map((e) => e.text);
    expect(text).toContain("Phone 1 answered a prompt in t3: refused");
    expect(text).toContain("Phone 2 answered a prompt in t3: failed");
    expect(text).toContain("Phone 2: prompt.answer on");
  });

  it("turning prompt.answer off leaves a held send alone; losing terminal.input does not end prompt.answer", async () => {
    await start();
    holdSends = true;
    const cookie = await paired({ terminal: true, prompts: true });
    const ps = await phone(cookie);
    send(ps, { type: "hello", api: 1 });
    send(ps, { type: "act", id: "hs", kind: "terminal.send", args: { terminal: "t3", text: "held" } });
    const end = Date.now() + 2000;
    while (!calls.some((c) => c.args[0] === "send") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    const id = app!.security.devices()[0]!.id;
    app!.security.setCap(id, "prompt.answer", false);
    await new Promise((r) => setTimeout(r, 100));
    expect(ps.msgs.some(resOf("hs"))).toBe(false);
    app!.security.setCap(id, "prompt.answer", true, Date.now() + 60_000);
    app!.security.setCap(id, "terminal.input", false);
    expect(await ps.until(resOf("hs"))).toMatchObject({ ok: false, code: "cancelled" });
    expect(app!.security.devices()[0]!.caps["prompt.answer"]).toBe(true);
    expect(app!.security.devices()[0]!.prompt_answer_until).not.toBeNull();
  });

  it("an edited keys.json is published; a damaged one is set aside, said in Activity and the log, and never used", async () => {
    const events: unknown[] = [];
    const dataDir = join(home, "data/herdr-app-remote");
    await import("node:fs/promises").then((fs) => fs.mkdir(dataDir, { recursive: true }));
    await import("node:fs/promises").then((fs) => fs.writeFile(join(dataDir, "keys.json"), '{"v":1,"keys":[{"label":"secret words","keys":["hello"]}]}'));
    await start({ log: (e) => events.push(e) });
    expect(events).toContainEqual({ event: "keys_config", state: "damaged", reason: "invalid", where: "keys[0].keys[0]", setAside: true });
    expect(app!.security.activity().map((e) => e.text)).toContain("Key menu file is invalid (invalid at keys[0].keys[0]): set aside as keys.json.damaged, the default menu is in use");
    expect(JSON.stringify(app!.security.activity())).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("secret");
    const before = bridgeApi.KeysTopic.parse(app!.hub.get("keys"));
    expect(before.keys).toHaveLength(8);

    await import("node:fs/promises").then((fs) => fs.writeFile(join(dataDir, "keys.json"), '{"v":1,"keys":[{"label":"Ctrl-D","keys":["ctrl+d"]}]}'));
    // A file changed under a second ago is left alone (an in-place save may be half-written).
    await new Promise((r) => setTimeout(r, 1_200));
    const p = await phone(await paired({ keys: true }));
    send(p, { type: "hello", api: 1 });
    // A press from the menu as it was is refused, and the press itself picks up the edit at once.
    send(p, { type: "act", id: "e1", kind: "terminal.keys", args: { terminal: "t3", key: "esc", rev: before.rev } });
    expect(await p.until(resOf("e1"))).toMatchObject({ ok: false, code: "keys_changed" });
    const after = bridgeApi.KeysTopic.parse(app!.hub.get("keys"));
    expect(after.keys).toEqual([{ id: "ctrl-d", label: "Ctrl-D", keys: ["ctrl+d"] }]);
    expect(events).toContainEqual({ event: "keys_config", state: "loaded", entries: 1 });
    expect(calls.some((c) => c.args[0] === "keys")).toBe(false);
  });

  it("turning terminal.keys off kills a press held by hc, and leaves a held send alone", async () => {
    await start();
    holdKeys = true;
    holdSends = true;
    // Two sockets of the same device: acts on one socket run one at a time, so the press and the send must be held
    // on separate sockets to be in flight together.
    const cookie = await paired({ terminal: true, keys: true });
    const pk = await phone(cookie);
    const ps = await phone(cookie);
    send(pk, { type: "hello", api: 1 });
    send(ps, { type: "hello", api: 1 });
    const rev = bridgeApi.KeysTopic.parse(app!.hub.get("keys")).rev;
    send(pk, { type: "act", id: "hk", kind: "terminal.keys", args: { terminal: "t3", key: "ctrl-c", rev } });
    send(ps, { type: "act", id: "hs", kind: "terminal.send", args: { terminal: "t3", text: "held" } });
    const end = Date.now() + 2000;
    while (!(calls.some((c) => c.args[0] === "keys") && calls.some((c) => c.args[0] === "send")) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.args[0] === "keys" || c.args[0] === "send").map((c) => c.args[0]).sort()).toEqual(["keys", "send"]);
    const id = app!.security.devices().find((d) => d.caps["terminal.keys"])!.id;
    app!.security.setCap(id, "terminal.keys", false);
    expect(await pk.until(resOf("hk"))).toMatchObject({ ok: false, code: "cancelled", unknown_effect: true });
    await new Promise((r) => setTimeout(r, 100));
    // The send is still held: losing terminal.keys did not touch it.
    expect(ps.msgs.some(resOf("hs"))).toBe(false);
    // And the reverse: a new press is held, then losing terminal.input kills the send only.
    app!.security.setCap(id, "terminal.keys", true);
    // The killed press holds the device for TIMEOUT_HOLD_MS while hc dies.
    await new Promise((r) => setTimeout(r, 1_100));
    send(pk, { type: "act", id: "hk2", kind: "terminal.keys", args: { terminal: "t3", key: "esc", rev } });
    const end2 = Date.now() + 2000;
    while (calls.filter((c) => c.args[0] === "keys").length < 2 && Date.now() < end2) await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.args[0] === "keys")).toHaveLength(2);
    app!.security.setCap(id, "terminal.input", false);
    expect(await ps.until(resOf("hs"))).toMatchObject({ ok: false, code: "cancelled" });
    await new Promise((r) => setTimeout(r, 100));
    expect(pk.msgs.some(resOf("hk2"))).toBe(false);
    app!.security.revoke(id);
    expect(app!.security.activity().map((e) => e.text)).toContain("Phone 1 pressed ctrl-c (1 key) in t3: result unknown");
  });

  it("revoking the device, or Funnel turning on, kills a press held by hc", async () => {
    await start();
    holdKeys = true;
    const rev = bridgeApi.KeysTopic.parse(app!.hub.get("keys")).rev;
    const held = async (cookie: string, aid: string) => {
      const p = await phone(cookie);
      send(p, { type: "hello", api: 1 });
      const n = calls.filter((c) => c.args[0] === "keys").length;
      send(p, { type: "act", id: aid, kind: "terminal.keys", args: { terminal: "t3", key: "ctrl-c", rev } });
      const end = Date.now() + 2000;
      while (calls.filter((c) => c.args[0] === "keys").length === n && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      return p;
    };
    const unknown = (n: number) => app!.security.activity().filter((e) => e.text.endsWith("pressed ctrl-c (1 key) in t3: result unknown")).length === n;
    // Revoke: the socket closes and the held hc keys is killed (its Activity line says the result is unknown).
    await held(await paired({ keys: true }), "r1");
    const id = app!.security.devices().find((d) => d.caps["terminal.keys"])!.id;
    app!.security.revoke(id);
    const end1 = Date.now() + 2000;
    while (!unknown(1) && Date.now() < end1) await new Promise((r) => setTimeout(r, 10));
    expect(unknown(1)).toBe(true);
    // Funnel: every press held is killed.
    await held(await paired({ keys: true }), "f1");
    tsStatus = funnelOn(`${SERVE}:8443`);
    await app!.checkFunnel();
    const end2 = Date.now() + 2000;
    while (!unknown(2) && Date.now() < end2) await new Promise((r) => setTimeout(r, 10));
    expect(unknown(2)).toBe(true);
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
    const r = await http("POST", "/api/v1/pair", OK_POST, JSON.stringify({ code, name: "Evil Name 123" }));
    expect(r.status).toBe(202);
    const toast = await waitLine(mod, (l) => l.type === "notify");
    expect(toast).toMatchObject({ level: "info", action: "open_panel" });
    // Exactly this text: nothing the phone sent, not even the bridge-made label.
    expect(toast.message).toBe("Approve a new phone?");
    const view = (await waitLine(panel, (l) => l.type === "panel" && (l.view as { devices: unknown[] }).devices.length === 1)).view as { devices: { state: string; name: string }[] };
    expect(view.devices[0]!.state).toBe("pending");
    expect(view.devices[0]!.name).toBe("Phone 1");
    expect(JSON.stringify([toast, view])).not.toContain("Evil");
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
