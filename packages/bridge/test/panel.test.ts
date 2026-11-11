/* eslint-disable @typescript-eslint/no-explicit-any */
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub, LinkServer } from "../src/index.js";
import { PanelDriver } from "../src/panel/driver.js";
import { defaultCaps } from "../src/security/caps.js";
import { DeviceStore, type Device } from "../src/security/devices.js";
import { Security } from "../src/security/security.js";

const TOKEN = "token-0123456789abcdef0123456789abcdef";
const PENDING = "d-0000000000000001";
const APPROVED = "d-0000000000000002";

let dir: string;
let server: LinkServer;
let security: Security;
let driver: PanelDriver;
const peers: net.Socket[] = [];
let funnel: "on" | "off" | "unknown" | null = "off";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-panel-"));
  const store = new DeviceStore(dir);
  const dev = (id: string, name: string, state: Device["state"]): Device => ({
    id, name, login: "user-1@example", token_sha256: "a".repeat(64), state, caps: defaultCaps(),
    created_at: Date.now() - 1_000, approved_at: state === "approved" ? Date.now() - 500 : null, last_seen: null,
  });
  store.add(dev(PENDING, "Phone 1", "pending"));
  store.add(dev(APPROVED, "Laptop 1", "approved"));
  security = new Security({ dataDir: dir, serve: { host: "desk-1.example-tailnet.ts.net", login: "user-1@example" }, onChange: () => driver?.changed() });
  server = new LinkServer({ token: TOKEN });
  await server.listen();
  funnel = "off";
  driver = new PanelDriver({ link: server, security, hub: new Hub({ bridgeVersion: "0" }), funnel: () => funnel, refreshMs: 60_000 });
});

afterEach(async () => {
  for (const p of peers.splice(0)) p.destroy();
  driver.stop();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

class Peer {
  lines: Record<string, any>[] = [];
  private buf = "";
  constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        this.lines.push(JSON.parse(this.buf.slice(0, i)));
        this.buf = this.buf.slice(i + 1);
      }
    });
    socket.on("error", () => {});
  }
  send(o: unknown) {
    this.socket.write(JSON.stringify(o) + "\n");
  }
  async next(type: string, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.lines.findIndex((l) => l.type === type);
      if (i >= 0) return this.lines.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`no ${type}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function open(copy: "link" | "panel"): Promise<Peer> {
  const s = net.connect(server.port, "127.0.0.1");
  await new Promise<void>((r) => s.once("connect", () => r()));
  peers.push(s);
  const p = new Peer(s);
  p.send({ type: "hello", v: 1, token: TOKEN, copy, layout: "x", app: { version: "1" } });
  await new Promise((r) => server.once("link", r));
  return p;
}
const act = async (p: Peer, kind: string, args: Record<string, unknown>, id = "a1") => {
  p.send({ type: "panel_act", id, kind, args });
  return p.next("panel_res");
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("panel view", () => {
  it("a panel copy gets the view on connect, with no secrets", async () => {
    const p = await open("panel");
    const m = await p.next("panel");
    expect(m.view.status).toBe("serving");
    expect(m.view.url).toBe("https://desk-1.example-tailnet.ts.net");
    expect(m.view.devices.map((d: any) => [d.name, d.state])).toEqual([["Phone 1", "pending"], ["Laptop 1", "approved"]]);
    expect(JSON.stringify(m)).not.toContain("token");
    expect(JSON.stringify(m)).not.toContain("a".repeat(64));
  });

  it("the link copy is never sent a view", async () => {
    const p = await open("link");
    await tick();
    expect(p.lines.filter((l) => l.type === "panel")).toEqual([]);
  });

  it("status follows funnel, pause and serve", async () => {
    funnel = "on";
    expect(driver.view().status).toBe("blocked");
    funnel = "off";
    security.setServe(null);
    expect(driver.view().status).toBe("setup");
    security.pause();
    expect(driver.view().status).toBe("paused");
  });
});

describe("panel acts", () => {
  it("approve and revoke work, are audited, and push a fresh view", async () => {
    const p = await open("panel");
    await p.next("panel");
    expect(await act(p, "device.approve", { id: PENDING })).toMatchObject({ ok: true, id: "a1" });
    const m = await p.next("panel");
    expect(m.view.devices.find((d: any) => d.id === PENDING).state).toBe("approved");
    expect(m.view.activity[0].text).toBe("Phone 1 approved");
    expect(await act(p, "device.revoke", { id: APPROVED })).toMatchObject({ ok: true });
    expect(security.devices().map((d) => d.id)).toEqual([PENDING]);
  });

  it("an unknown device is not_found", async () => {
    const p = await open("panel");
    expect(await act(p, "device.approve", { id: "d-00000000000000ff" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("terminal.input turns on with an expiry, and off again", async () => {
    const p = await open("panel");
    const before = Date.now();
    expect(await act(p, "device.cap", { id: APPROVED, cap: "terminal.input", on: true, minutes: 60 })).toMatchObject({ ok: true });
    const d = security.devices().find((x) => x.id === APPROVED)!;
    expect(d.caps["terminal.input"]).toBe(true);
    expect(d.terminal_input_until).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(await act(p, "device.cap", { id: APPROVED, cap: "terminal.input", on: false })).toMatchObject({ ok: true });
    expect(security.devices().find((x) => x.id === APPROVED)!.caps["terminal.input"]).toBe(false);
  });

  it("minutes on any other capability, or on off, is refused and changes nothing", async () => {
    const p = await open("panel");
    expect(await act(p, "device.cap", { id: APPROVED, cap: "navigate", on: true, minutes: 5 })).toMatchObject({ ok: false, code: "bad_args" });
    expect(await act(p, "device.cap", { id: APPROVED, cap: "terminal.input", on: false, minutes: 5 })).toMatchObject({ ok: false, code: "bad_args" });
    expect(security.devices().find((x) => x.id === APPROVED)!.caps.navigate).toBe(false);
  });

  it("pause and resume", async () => {
    const p = await open("panel");
    await act(p, "remote.pause", {});
    expect(security.paused).toBe(true);
    await act(p, "remote.resume", {});
    expect(security.paused).toBe(false);
  });

  it("pair.code shows a QR, and an unset serve is a clear refusal", async () => {
    const p = await open("panel");
    await p.next("panel");
    expect(await act(p, "pair.code", {})).toMatchObject({ ok: true });
    const m = (await p.next("panel")).view;
    expect(m.pairing.url).toMatch(/^https:\/\/desk-1\.example-tailnet\.ts\.net\/pair#c=/);
    expect(m.pairing.qr.length).toBeGreaterThan(20);
    expect(m.pairing.qr.every((r: string) => r.length === m.pairing.qr.length && /^[01]+$/.test(r))).toBe(true);
    await act(p, "pair.hide", {});
    expect(driver.view().pairing).toBeNull();
    security.setServe(null);
    expect(await act(p, "pair.code", {})).toMatchObject({ ok: false, code: "serve_not_configured" });
  });

  it("refuses anything outside the allowlist, extra keys and bad ids, changing nothing", async () => {
    const p = await open("panel");
    for (const [kind, args] of [
      ["run", { name: "space.close" }],
      ["exec", { argv: ["id"] }],
      ["tab.new", {}],
      ["__proto__", {}],
      ["device.approve", { id: PENDING, extra: 1 }],
      ["device.approve", { id: "../x" }],
      ["device.cap", { id: APPROVED, cap: "admin", on: true }],
    ] as const) {
      const r = await act(p, kind, args as Record<string, unknown>);
      expect(r.ok, kind).toBe(false);
    }
    expect(security.devices().find((d) => d.id === PENDING)!.state).toBe("pending");
  });

  it("a panel_act from the link copy is dropped without an answer or effect", async () => {
    const p = await open("link");
    p.send({ type: "panel_act", id: "x", kind: "device.approve", args: { id: PENDING } });
    await tick(150);
    expect(p.lines.filter((l) => l.type === "panel_res")).toEqual([]);
    expect(security.devices().find((d) => d.id === PENDING)!.state).toBe("pending");
  });
});
