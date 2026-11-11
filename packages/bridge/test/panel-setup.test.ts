/* eslint-disable @typescript-eslint/no-explicit-any */
// S14b: the desktop panel's Setup view and its setup.check / setup.start / setup.stop acts, through the real
// LinkServer and PanelDriver with a stand-in for Tailscale setup. The real tailscale is never run here (see
// app-setup.test.ts for the same acts against the fake CLI).
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeApi, modLink } from "@herdr-remote/protocol";
import { Hub, LinkServer } from "../src/index.js";
import { PanelDriver, type SetupControl } from "../src/panel/driver.js";
import { Security } from "../src/security/security.js";
import type { SetupResult } from "../src/tailscale/setup.js";

const TOKEN = "token-0123456789abcdef0123456789abcdef";
const fx = (n: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/bridge-api/setup/${n}`, import.meta.url)), "utf8")) as bridgeApi.SetupTopic;

class FakeSetup implements SetupControl {
  state: bridgeApi.SetupTopic = fx("operator.json");
  calls: string[] = [];
  next: SetupResult = { ok: true };
  check() {
    this.calls.push("check");
    return Promise.resolve(this.state);
  }
  start() {
    this.calls.push("start");
    return Promise.resolve(this.next);
  }
  stop() {
    this.calls.push("stop");
    return Promise.resolve(this.next);
  }
}

let dir: string;
let server: LinkServer;
let security: Security;
let driver: PanelDriver;
let setup: FakeSetup | null;
const peers: net.Socket[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-panel-setup-"));
  security = new Security({ dataDir: dir, serve: null });
  server = new LinkServer({ token: TOKEN });
  await server.listen();
  setup = new FakeSetup();
  driver = new PanelDriver({ link: server, security, hub: new Hub({ bridgeVersion: "0" }), funnel: () => "off", setup: () => setup, refreshMs: 60_000 });
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
let n = 0;
const act = async (p: Peer, kind: string, args: Record<string, unknown>) => {
  n += 1;
  p.send({ type: "panel_act", id: `a${n}`, kind, args });
  return p.next("panel_res");
};

describe("setup in the panel view", () => {
  it("carries the setup state while not serving, valid against the protocol", async () => {
    const p = await open("panel");
    const m = await p.next("panel");
    expect(m.view.status).toBe("setup");
    expect(m.view.setup).toEqual(fx("operator.json"));
    expect(modLink.PanelView.safeParse(m.view).success).toBe(true);
    // Steps 1-3 done: the Status tab's Tailscale lines appear.
    expect(m.view.checks.map((c: any) => c.id)).toEqual(["tailscale", "https", "serve", "bridge", "link"]);
    expect(m.view.checks[0]).toMatchObject({ label: "Tailscale connected", detail: "example-tailnet · this computer is desk-1", state: "ok" });
  });

  it("no Tailscale lines before the steps are done; none at all without setup", () => {
    setup!.state = fx("https-off.json");
    expect(driver.view().checks.map((c) => c.id)).toEqual(["tailscale", "serve", "bridge", "link"]);
    setup = null;
    const v = driver.view();
    expect(v.setup).toBeNull();
    expect(v.checks.map((c) => c.id)).toEqual(["serve", "bridge", "link"]);
  });
});

describe("setup acts", () => {
  it("check, start and stop run the setup and answer with its outcome", async () => {
    const p = await open("panel");
    expect(await act(p, "setup.check", {})).toMatchObject({ ok: true });
    expect(await act(p, "setup.start", {})).toMatchObject({ ok: true });
    setup!.next = { ok: false, code: "operator", problem: { code: "operator", message: "x", fix: "sudo tailscale set --operator=$USER" } };
    expect(await act(p, "setup.start", {})).toMatchObject({ ok: false, code: "operator" });
    setup!.next = { ok: false, code: "not_ours", problem: { code: "not_ours", message: "x" } };
    expect(await act(p, "setup.stop", {})).toMatchObject({ ok: false, code: "not_ours" });
    expect(setup!.calls).toEqual(["check", "start", "start", "stop"]);
  });

  it("any argument at all is refused before setup is reached", async () => {
    const p = await open("panel");
    for (const kind of ["setup.check", "setup.start", "setup.stop"]) {
      for (const args of [{ port: 443 }, { target: "http://127.0.0.1:1" }, { fix: "sudo tailscale set --operator=$USER" }, { funnel: true }]) {
        expect(await act(p, kind, args)).toMatchObject({ ok: false, code: "bad_args" });
      }
    }
    for (const kind of ["setup.funnel", "setup.set", "setup.run", "tailscale.serve"]) {
      expect(await act(p, kind, {})).toMatchObject({ ok: false, code: "unsupported_action" });
    }
    expect(setup!.calls).toEqual([]);
  });

  it("the link copy can't run setup", async () => {
    const p = await open("link");
    p.send({ type: "panel_act", id: "x", kind: "setup.start", args: {} });
    await new Promise((r) => setTimeout(r, 150));
    expect(p.lines.filter((l) => l.type === "panel_res")).toEqual([]);
    expect(setup!.calls).toEqual([]);
  });

  it("without setup (a fixed serve identity) the acts answer no_setup", async () => {
    setup = null;
    const p = await open("panel");
    for (const kind of ["setup.check", "setup.start", "setup.stop"]) expect(await act(p, kind, {})).toMatchObject({ ok: false, code: "no_setup" });
  });

  it("a throwing setup answers failed", async () => {
    setup!.start = () => Promise.reject(new Error("setup is closed"));
    const p = await open("panel");
    expect(await act(p, "setup.start", {})).toMatchObject({ ok: false, code: "failed" });
  });
});
