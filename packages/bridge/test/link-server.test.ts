import net from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LinkServer, type LinkLogEvent, type LinkServerOptions } from "../src/index.js";

const TOKEN = "token-0123456789abcdef0123456789abcdef";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const HOST = JSON.parse(readFileSync(join(FIXTURES, "host/typical.json"), "utf8")) as Record<string, unknown>;

const servers: LinkServer[] = [];
const peers: Peer[] = [];

afterEach(async () => {
  for (const p of peers.splice(0)) p.socket.destroy();
  for (const s of servers.splice(0)) await s.close();
});

async function start(opts: Partial<LinkServerOptions> = {}) {
  const log: LinkLogEvent[] = [];
  const server = new LinkServer({ token: TOKEN, log: (e) => log.push(e), ...opts });
  servers.push(server);
  const port = await server.listen();
  return { server, port, log };
}

class Peer {
  lines: Record<string, unknown>[] = [];
  raw = "";
  closed: Promise<void>;
  isClosed = false;
  private waiters: (() => void)[] = [];
  constructor(public socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.raw += d;
      let i;
      while ((i = this.raw.indexOf("\n")) >= 0) {
        this.lines.push(JSON.parse(this.raw.slice(0, i)) as Record<string, unknown>);
        this.raw = this.raw.slice(i + 1);
      }
      for (const w of this.waiters.splice(0)) w();
    });
    socket.on("error", () => {});
    this.closed = new Promise((r) =>
      socket.on("close", () => {
        this.isClosed = true;
        r();
      }),
    );
  }
  send(obj: unknown) {
    this.socket.write(JSON.stringify(obj) + "\n");
  }
  async next(pred: (m: Record<string, unknown>) => boolean = () => true, ms = 2000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.lines.findIndex(pred);
      if (i >= 0) return this.lines.splice(i, 1)[0]!;
      if (Date.now() > deadline) throw new Error("timed out waiting for a line");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 20);
      });
    }
  }
}

async function connect(port: number): Promise<Peer> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((r, j) => socket.once("connect", () => r()).once("error", j));
  const p = new Peer(socket);
  peers.push(p);
  return p;
}

const hello = (copy: "link" | "panel" = "link", token = TOKEN) => ({
  type: "hello",
  v: 1,
  token,
  copy,
  layout: "herdr-remote",
  app: { version: "0.0.1" },
});

async function linked(server: LinkServer, port: number, copy: "link" | "panel" = "link") {
  const p = await connect(port);
  const up = new Promise((r) => server.once("link", r));
  p.send(hello(copy));
  await up;
  return p;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("LinkServer binding", () => {
  it("listens on 127.0.0.1 only", async () => {
    const { server } = await start();
    expect(server.address).toBe("127.0.0.1");
  });

  it("refuses any other bind address", () => {
    expect(() => new LinkServer({ token: TOKEN, host: "0.0.0.0" })).toThrow(/127\.0\.0\.1/);
    expect(() => new LinkServer({ token: TOKEN, host: "::" })).toThrow(/127\.0\.0\.1/);
  });

  it("refuses a short token", () => {
    expect(() => new LinkServer({ token: "short" })).toThrow();
  });
});

describe("LinkServer authentication", () => {
  it("drops a hello with the wrong token and never links", async () => {
    const { server, port, log } = await start();
    let linkedEvents = 0;
    server.on("link", () => linkedEvents++);
    const p = await connect(port);
    p.send(hello("link", TOKEN.replace(/f$/, "e")));
    await p.closed;
    expect(linkedEvents).toBe(0);
    expect(server.connected()).toBe(false);
    expect(log).toContainEqual({ event: "auth_failed", reason: "bad_token" });
    expect(JSON.stringify(log)).not.toContain(TOKEN.slice(0, 20));
  });

  it("drops a peer whose first line is not a hello, without processing it", async () => {
    const { server, port, log } = await start();
    let host = 0;
    server.on("host", () => host++);
    const p = await connect(port);
    p.send({ type: "state", seq: 1, host: HOST });
    await p.closed;
    expect(host).toBe(0);
    expect(log).toContainEqual({ event: "auth_failed", reason: "not_hello" });
  });

  it("drops a malformed hello (wrong version)", async () => {
    const { port, log } = await start();
    const p = await connect(port);
    p.send({ ...hello(), v: 2 });
    await p.closed;
    expect(log).toContainEqual({ event: "auth_failed", reason: "bad_hello" });
  });

  it("drops a peer that never says hello", async () => {
    const { port, log } = await start({ helloTimeoutMs: 80 });
    const p = await connect(port);
    await p.closed;
    expect(log).toContainEqual({ event: "auth_failed", reason: "timeout" });
  });

  it("drops a complete over-limit line before hello, sent in one chunk", async () => {
    const { port, log } = await start();
    const p = await connect(port);
    p.socket.write(JSON.stringify({ ...hello(), layout: "x".repeat(17 * 1024) }) + "\n");
    await p.closed;
    expect(log).toContainEqual({ event: "auth_failed", reason: "too_long" });
  });

  it("idle unauthenticated sockets can't keep the real mod out: the oldest is evicted", async () => {
    const { server, port, log } = await start({ maxPending: 4 });
    const idle = await Promise.all(Array.from({ length: 12 }, () => connect(port)));
    await tick(60);
    const p = await linked(server, port);
    expect(p.isClosed).toBe(false);
    expect(server.connected()).toBe(true);
    await tick(60);
    expect(idle.filter((x) => x.isClosed).length).toBeGreaterThanOrEqual(9);
    expect(log.filter((e) => e.event === "auth_failed" && e.reason === "evicted").length).toBeGreaterThanOrEqual(9);
  });

  it("evicting pending sockets never touches authenticated ones", async () => {
    const { server, port } = await start({ maxPending: 2 });
    const link = await linked(server, port, "link");
    const panel = await linked(server, port, "panel");
    await Promise.all(Array.from({ length: 6 }, () => connect(port)));
    await tick(60);
    expect(link.isClosed).toBe(false);
    expect(panel.isClosed).toBe(false);
  });

  it("drops an oversized preamble before any newline", async () => {
    const { port, log } = await start();
    const p = await connect(port);
    p.socket.write("x".repeat(17 * 1024));
    await p.closed;
    expect(log).toContainEqual({ event: "auth_failed", reason: "too_long" });
  });
});

describe("LinkServer slots", () => {
  it("keeps one slot per copy: the newest valid hello wins", async () => {
    const { server, port, log } = await start();
    const a = await linked(server, port);
    const b = await linked(server, port);
    await a.closed;
    expect(b.isClosed).toBe(false);
    expect(server.connected("link")).toBe(true);
    expect(log).toContainEqual({ event: "link", copy: "link", replaced: true });
  });

  it("does not let a panel displace the link (or the reverse)", async () => {
    const { server, port } = await start();
    const link = await linked(server, port, "link");
    const panel = await linked(server, port, "panel");
    await tick();
    expect(link.isClosed).toBe(false);
    expect(panel.isClosed).toBe(false);
    expect(server.connected("link")).toBe(true);
    expect(server.connected("panel")).toBe(true);
  });

  it("a failed hello does not displace the current link", async () => {
    const { server, port } = await start();
    const link = await linked(server, port);
    const bad = await connect(port);
    bad.send(hello("link", "x".repeat(40)));
    await bad.closed;
    expect(link.isClosed).toBe(false);
    expect(server.connected("link")).toBe(true);
  });

  it("emits unlink when the link goes, and keeps the last host", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    p.send({ type: "state", seq: 1, host: HOST });
    await new Promise((r) => server.once("host", r));
    const down = new Promise((r) => server.once("unlink", r));
    p.socket.end();
    expect(await down).toEqual({ copy: "link" });
    expect(server.connected()).toBe(false);
    expect(server.lastHost?.state).toEqual(HOST);
  });

  it("does not emit unlink for a replaced connection", async () => {
    const { server, port } = await start();
    const a = await linked(server, port);
    let unlinks = 0;
    server.on("unlink", () => unlinks++);
    await linked(server, port);
    await a.closed;
    await tick();
    expect(unlinks).toBe(0);
  });
});

describe("LinkServer state", () => {
  it("feeds host from the link copy", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    const got = new Promise((r) => server.once("host", r));
    p.send({ type: "state", seq: 1, host: HOST });
    expect(await got).toEqual({ state: HOST, seq: 1, layout: "herdr-remote", app: { version: "0.0.1" } });
  });

  it("ignores state from the panel copy", async () => {
    const { server, port, log } = await start();
    const p = await linked(server, port, "panel");
    let host = 0;
    server.on("host", () => host++);
    p.send({ type: "state", seq: 1, host: HOST });
    await tick(60);
    expect(host).toBe(0);
    expect(log).toContainEqual({ event: "dropped_line", copy: "panel", reason: "panel_state" });
  });

  it("drops invalid lines without closing the link", async () => {
    const { server, port, log } = await start();
    const p = await linked(server, port);
    p.socket.write("{nope\n");
    p.send({ type: "state", seq: 1, host: { ...HOST, layout_name: "" } });
    const got = new Promise((r) => server.once("host", r));
    p.send({ type: "state", seq: 2, host: HOST });
    await got;
    expect(p.isClosed).toBe(false);
    expect(log.filter((e) => e.event === "dropped_line" && e.reason === "invalid")).toHaveLength(2);
  });

  it("drops a state whose seq does not increase", async () => {
    const { server, port, log } = await start();
    const p = await linked(server, port);
    const seqs: number[] = [];
    server.on("host", (h) => seqs.push(h.seq));
    p.send({ type: "state", seq: 5, host: HOST });
    p.send({ type: "state", seq: 5, host: HOST });
    p.send({ type: "state", seq: 3, host: HOST });
    p.send({ type: "state", seq: 6, host: HOST });
    await tick(80);
    expect(seqs).toEqual([5, 6]);
    expect(log.filter((e) => e.event === "dropped_line" && e.reason === "stale_seq")).toHaveLength(2);
  });

  it("drops a link that sends an over-limit line", async () => {
    const { server, port, log } = await start();
    const p = await linked(server, port);
    p.socket.write("x".repeat(8 * 1024 * 1024 + 10));
    await p.closed;
    expect(server.connected()).toBe(false);
    expect(log).toContainEqual({ event: "dropped_peer", copy: "link", reason: "too_long" });
  });
});

describe("LinkServer run", () => {
  it("never sends a command that is not on the allowlist", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    for (const name of ["tab.new", "terminal.open", "space.new", "app.reset"]) {
      expect(await server.run(name, { argv: ["sh"] })).toEqual({ ok: false, code: "not_allowed", unknown_effect: false });
    }
    expect(await server.run("tab.select", { id: "tab-1", argv: ["sh"] })).toEqual({
      ok: false,
      code: "bad_args",
      unknown_effect: false,
    });
    await tick(60);
    expect(p.lines.filter((m) => m.type === "run")).toEqual([]);
  });

  it("sends an allowlisted run and resolves with the mod's result", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    const pending = server.run("space.select", { id: "space-1" });
    const msg = await p.next((m) => m.type === "run");
    expect(msg).toMatchObject({ type: "run", name: "space.select", args: { id: "space-1" } });
    p.send({ type: "result", id: msg.id, ok: true });
    expect(await pending).toEqual({ ok: true });
  });

  it("maps a mod refusal to no effect and a mod failure to unknown effect", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    const a = server.run("tab.select", { index: 1 });
    const ma = await p.next((m) => m.type === "run");
    p.send({ type: "result", id: ma.id, ok: false, error: "not_allowed" });
    expect(await a).toEqual({ ok: false, code: "not_allowed", unknown_effect: false });
    const b = server.run("tab.select", { index: 1 });
    const mb = await p.next((m) => m.type === "run");
    p.send({ type: "result", id: mb.id, ok: false, error: "boom" });
    expect(await b).toEqual({ ok: false, code: "failed", error: "boom", unknown_effect: true });
  });

  it("a run dropped for backpressure reports no_link with no effect, and nothing is sent", async () => {
    const { server, port, log } = await start();
    const p = await linked(server, port);
    // Simulate a mod that stopped reading: the socket's queued output is over the cap.
    const conn = [...(server as unknown as { conns: Set<{ socket: { writableLength: number } }> }).conns][0]!;
    Object.defineProperty(conn.socket, "writableLength", { get: () => 10 * 1024 * 1024 });
    expect(await server.run("tab.select", { index: 1 })).toEqual({ ok: false, code: "no_link", unknown_effect: false });
    await p.closed;
    expect(p.lines.filter((m) => m.type === "run")).toEqual([]);
    expect(log).toContainEqual({ event: "dropped_peer", copy: "link", reason: "backpressure" });
  });

  it("sends the checked copy of args, not the caller's object", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    let reads = 0;
    const args = {
      get index() {
        reads += 1;
        return reads === 1 ? 1 : "terminal.open";
      },
    };
    const pending = server.run("tab.select", args as unknown as Record<string, unknown>);
    const msg = await p.next((m) => m.type === "run");
    expect(msg.args).toEqual({ index: 1 });
    p.send({ type: "result", id: msg.id, ok: true });
    await pending;
  });

  it("reports no_link when nothing is linked", async () => {
    const { server } = await start();
    expect(await server.run("tab.select", { index: 1 })).toEqual({ ok: false, code: "no_link", unknown_effect: false });
  });

  it("times out with unknown effect", async () => {
    const { server, port } = await start();
    await linked(server, port);
    expect(await server.run("tab.select", { index: 1 }, { timeoutMs: 50 })).toEqual({
      ok: false,
      code: "timeout",
      unknown_effect: true,
    });
  });

  it("resolves pending runs with unknown effect when the link drops", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    const pending = server.run("tab.select", { index: 1 });
    await p.next((m) => m.type === "run");
    p.socket.destroy();
    expect(await pending).toEqual({ ok: false, code: "link_lost", unknown_effect: true });
  });

  it("ignores a result for an id it never sent, or from another connection", async () => {
    const { server, port, log } = await start();
    const link = await linked(server, port, "link");
    const panel = await linked(server, port, "panel");
    const pending = server.run("tab.select", { index: 1 });
    const msg = await link.next((m) => m.type === "run");
    panel.send({ type: "result", id: msg.id, ok: false, error: "spoofed" });
    link.send({ type: "result", id: "run-999", ok: true });
    await tick(60);
    link.send({ type: "result", id: msg.id, ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(log.filter((e) => e.event === "dropped_line" && e.reason === "unknown_result")).toHaveLength(2);
  });

  it("routes runs to the panel copy when asked", async () => {
    const { server, port } = await start();
    const link = await linked(server, port, "link");
    const panel = await linked(server, port, "panel");
    const pending = server.run("tab.select", { index: 2 }, { copy: "panel" });
    const msg = await panel.next((m) => m.type === "run");
    panel.send({ type: "result", id: msg.id, ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(link.lines.filter((m) => m.type === "run")).toEqual([]);
  });
});

describe("LinkServer keep-alive and notify", () => {
  it("pings linked copies and drops one that goes silent", async () => {
    const { server, port, log } = await start({ pingIntervalMs: 40, idleTimeoutMs: 150 });
    const p = await linked(server, port);
    await p.next((m) => m.type === "ping");
    await p.closed;
    expect(log).toContainEqual({ event: "dropped_peer", copy: "link", reason: "idle" });
  });

  it("keeps a copy that answers pings", async () => {
    const { server, port } = await start({ pingIntervalMs: 40, idleTimeoutMs: 150 });
    const p = await linked(server, port);
    p.socket.on("data", () => p.send({ type: "pong" }));
    await tick(400);
    expect(p.isClosed).toBe(false);
    expect(server.connected()).toBe(true);
  });

  it("sends notify as ASCII-only NDJSON", async () => {
    const { server, port } = await start();
    const p = await linked(server, port);
    const raw: string[] = [];
    p.socket.on("data", (d) => raw.push(String(d)));
    expect(server.notify("info", "Question Title 123 — ok")).toBe(true);
    expect(await p.next((m) => m.type === "notify")).toEqual({
      type: "notify",
      level: "info",
      message: "Question Title 123 — ok",
    });
    expect(raw.join("")).toMatch(/^[\x20-\x7e\n]*$/);
    expect(server.notify("info", "x", "panel")).toBe(false);
  });
});
