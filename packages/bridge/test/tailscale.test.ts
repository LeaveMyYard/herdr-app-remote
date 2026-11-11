// S14: Tailscale setup and serve control, against a fake `tailscale` CLI (test/fake-tailscale.mjs) that replays
// recorded outputs and keeps its serve config in a temp dir. The real tailscale is never run.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { run } from "../src/plugins/exec.js";
import type { ServeIdentity } from "../src/security/security.js";
import {
  classifyTrouble,
  OPERATOR_FIX,
  parseStatus,
  parseVersion,
  portUse,
  versionBelow,
} from "../src/tailscale/cli.js";
import { SERVE_RECORD, Setup, SetupClosedError, type SetupAction } from "../src/tailscale/setup.js";

const FAKE = fileURLToPath(new URL("./fake-tailscale.mjs", import.meta.url));
const FIX = fileURLToPath(new URL("./fixtures/tailscale/", import.meta.url));
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");
const fxj = (n: string): unknown => JSON.parse(fx(n));
const DNS = "desk-1.example-tailnet.ts.net";
const API = 47391;
const HOST = `${DNS}:8443`;

const dirs: string[] = [];
const setups: Setup[] = [];
afterEach(async () => {
  for (const s of setups.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  dir: string;
  bin: string;
  dataDir: string;
  setup: Setup;
  ids: (ServeIdentity | null)[];
  states: bridgeApi.SetupTopic[];
  actions: SetupAction[];
  conf(c: Record<string, string>): void;
  serve(doc: unknown): void;
  serveDoc(): unknown;
  calls(): string[][];
  phone: { on: boolean };
}

function rig(opts: { conf?: Record<string, string>; serve?: string; serveTimeoutMs?: number; bin?: string; onFunnel?: () => void } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "s14-ts-"));
  dirs.push(dir);
  const bin = join(dir, "tailscale");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${dir}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "calls.log"), "");
  const conf = (c: Record<string, string>) => writeFileSync(join(dir, "conf.json"), JSON.stringify(c));
  const serve = (doc: unknown) => writeFileSync(join(dir, "serve.json"), JSON.stringify(doc));
  conf(opts.conf ?? {});
  serve(opts.serve ? fxj(opts.serve) : {});
  const ids: (ServeIdentity | null)[] = [];
  const states: bridgeApi.SetupTopic[] = [];
  const phone = { on: false };
  const actions: SetupAction[] = [];
  const dataDir = join(dir, "data");
  const setup = new Setup({
    run,
    tailscale: opts.bin ?? bin,
    apiPort: API,
    dataDir,
    hasPhone: () => phone.on,
    onIdentity: (id) => ids.push(id),
    onState: (s) => states.push(s),
    onAction: (a) => actions.push(a),
    ...(opts.serveTimeoutMs ? { serveTimeoutMs: opts.serveTimeoutMs } : {}),
    ...(opts.onFunnel ? { onFunnel: opts.onFunnel } : {}),
  });
  setups.push(setup);
  return {
    dir,
    bin,
    dataDir,
    setup,
    ids,
    states,
    actions,
    conf,
    serve,
    serveDoc: () => JSON.parse(readFileSync(join(dir, "serve.json"), "utf8")) as unknown,
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
    phone,
  };
}

const READS = [["version"], ["status", "--json"], ["serve", "status", "--json"]].map((a) => JSON.stringify(a));
const mutating = (calls: string[][]) => calls.filter((c) => !READS.includes(JSON.stringify(c)));
const START = ["serve", "--bg", "--https=8443", `http://127.0.0.1:${API}`];
const STOP = ["serve", "--https=8443", "off"];
const step = (s: bridgeApi.SetupTopic, id: bridgeApi.SetupStepId) => s.steps.find((x) => x.id === id)!;

describe("tailscale CLI parsing", () => {
  it("reads the version and compares it with the minimum", () => {
    expect(parseVersion(fx("version.txt"))).toBe("1.76.1");
    expect(parseVersion("1.80.0-t0123-gabc\n")).toBe("1.80.0");
    expect(parseVersion("not a version")).toBeUndefined();
    expect(versionBelow("1.50.1", "1.52.0")).toBe(true);
    expect(versionBelow("1.52.0", "1.52.0")).toBe(false);
    expect(versionBelow("2.0.0", "1.52.0")).toBe(false);
  });

  it("reads status: owner login, DNS name, HTTPS, tags", () => {
    expect(parseStatus(fxj("status-running.json"))).toEqual({
      backend: "Running",
      hostName: "desk-1",
      dnsName: DNS,
      tailnet: "example-tailnet",
      magicDns: true,
      https: true,
      tagged: false,
      login: "user-1@example",
    });
    const tagged = parseStatus(fxj("status-tagged.json"))!;
    expect(tagged.tagged).toBe(true);
    expect(tagged.login).toBeNull(); // a tagged node has no owner login, even though `User` names one
    expect(parseStatus(fxj("status-https-off.json"))!.https).toBe(false);
    expect(parseStatus(fxj("status-magicdns-off.json"))!.magicDns).toBe(false);
    expect(parseStatus(fxj("status-other-login.json"))!.login).toBe("user-2@example");
    expect(parseStatus({ nope: 1 })).toBeUndefined();
  });

  it.each([
    ["serve-empty.json", "off"],
    ["serve-ours.json", "exact"],
    ["serve-other-port.json", "off"],
    ["serve-ours-and-other.json", "exact"],
    ["serve-foreign-8443.json", "foreign"],
    ["serve-extra-path.json", "foreign"],
    ["serve-tcp-8443.json", "foreign"],
    ["serve-funnel.json", "funnel"],
    ["serve-foreground.json", "foreign"],
    ["serve-ours-plus-foreground.json", "foreign"],
    ["serve-ours-bad-tcp.json", "foreign"],
    ["serve-ours-no-tcp.json", "foreign"],
  ])("port use of %s is %s", (f, want) => {
    expect(portUse(fxj(f), { port: 8443, apiPort: API, dnsName: DNS })).toBe(want);
  });

  it("an exact-looking handler for another host name or API port is not ours", () => {
    expect(portUse(fxj("serve-ours.json"), { port: 8443, apiPort: API, dnsName: "desk-2.example-tailnet.ts.net" })).toBe("foreign");
    expect(portUse(fxj("serve-ours.json"), { port: 8443, apiPort: 47392, dnsName: DNS })).toBe("foreign");
    expect(portUse("[]", { port: 8443, apiPort: API, dnsName: DNS })).toBeUndefined();
  });

  it("classifies the CLI's error text", () => {
    expect(classifyTrouble(fx("err-operator.txt"))).toEqual({ kind: "operator" });
    expect(classifyTrouble(fx("err-serve-disabled.txt"))).toEqual({ kind: "serve_disabled", url: "https://login.tailscale.com/f/serve?node=n0001ExAmPlE" });
    expect(classifyTrouble("Serve is not enabled. To enable, visit: https://evil.example/x")).toEqual({ kind: "serve_disabled", url: null });
    expect(classifyTrouble(fx("err-daemon-down.txt"))).toEqual({ kind: "daemon_down" });
    expect(classifyTrouble("something else")).toEqual({ kind: "other" });
  });
});

describe("setup steps", () => {
  it.each<[string, Parameters<typeof rig>[0], number, bridgeApi.SetupProblemCode]>([
    ["not installed", { bin: "/nonexistent/s14/tailscale" }, 1, "not_installed"],
    ["too old", { conf: { version: "version-old.txt" } }, 1, "too_old"],
    ["daemon down", { conf: { status: "daemon-down" } }, 2, "daemon_down"],
    ["needs login", { conf: { status: "status-needs-login.json" } }, 2, "needs_login"],
    ["stopped", { conf: { status: "status-stopped.json" } }, 2, "stopped"],
    ["tagged", { conf: { status: "status-tagged.json" } }, 2, "tagged"],
    ["unreadable status", { conf: { status: "garbage" } }, 2, "unknown"],
    ["MagicDNS off", { conf: { status: "status-magicdns-off.json" } }, 3, "magicdns_off"],
    ["HTTPS off", { conf: { status: "status-https-off.json" } }, 3, "https_off"],
  ])("%s stops at step %i", async (_n, opts, at, code) => {
    const r = rig(opts);
    const s = await r.setup.check();
    expect(bridgeApi.SetupTopic.safeParse(s).success).toBe(true);
    expect(s.step).toBe(at);
    expect(s.steps[at - 1]!.state).toBe("current");
    expect(s.steps[at - 1]!.problem?.code).toBe(code);
    for (let i = 0; i < at - 1; i++) expect(s.steps[i]!.state).toBe("done");
    for (let i = at; i < 5; i++) expect(s.steps[i]!.state).toBe("todo");
    expect(s.can_start).toBe(false);
    expect(r.ids).toEqual([]);
    expect(mutating(r.calls())).toEqual([]);
  });

  it("the HTTPS step links the admin DNS page", async () => {
    const r = rig({ conf: { status: "status-https-off.json" } });
    expect(step(await r.setup.check(), "https").problem).toMatchObject({ code: "https_off", url: "https://login.tailscale.com/admin/dns" });
  });

  it("with steps 1-3 done and an empty port: step 4, Start serving offered, no identity", async () => {
    const r = rig();
    const s = await r.setup.check();
    expect(s.step).toBe(4);
    expect(s.serving).toBe("off");
    expect(s.can_start).toBe(true);
    expect(s.can_stop).toBe(false);
    expect(step(s, "signed_in").detail).toBe("example-tailnet · this computer is desk-1");
    expect(step(s, "installed").detail).toBe("Found tailscale 1.76.1 on this computer");
    expect(s.url).toBeNull();
    expect(r.ids).toEqual([]);
  });

  it("a handler on another port is left alone and does not block", async () => {
    const r = rig({ serve: "serve-other-port.json" });
    expect((await r.setup.check()).can_start).toBe(true);
  });

  it("checks only ever read", async () => {
    for (const serve of ["serve-empty.json", "serve-ours.json", "serve-foreign-8443.json", "serve-funnel.json"]) {
      const r = rig({ serve });
      await r.setup.check();
      await r.setup.check();
      expect(mutating(r.calls())).toEqual([]);
    }
  });

  it("step 5 follows approved devices", async () => {
    const r = rig();
    expect((await r.setup.start()).ok).toBe(true);
    expect(r.setup.state.step).toBe(5);
    expect(step(r.setup.state, "phone").problem?.code).toBe("no_device");
    r.phone.on = true;
    r.setup.refreshPhone();
    expect(r.setup.state.step).toBe(6);
    expect(r.setup.state.steps.every((x) => x.state === "done")).toBe(true);
  });
});

describe("Start serving", () => {
  it("runs exactly `tailscale serve --bg --https=8443 http://127.0.0.1:<api>`, records it, and supplies the identity", async () => {
    const r = rig();
    expect(await r.setup.start()).toEqual({ ok: true });
    expect(mutating(r.calls())).toEqual([START]);
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]);
    const s = r.setup.state;
    expect(s.serving).toBe("ours");
    expect(s.url).toBe(`https://${HOST}/`);
    expect(s.login).toBe("user-1@example");
    expect(s.can_stop).toBe(true);
    const rec = join(r.dataDir, SERVE_RECORD);
    expect(statSync(rec).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(rec, "utf8"))).toMatchObject({ v: 1, port: 8443, target: `http://127.0.0.1:${API}`, host: HOST });
    // Already served: a second start changes nothing.
    expect(await r.setup.start()).toEqual({ ok: true });
    expect(mutating(r.calls())).toEqual([START]);
  });

  it.each(["serve-foreign-8443.json", "serve-extra-path.json", "serve-tcp-8443.json", "serve-foreground.json"])(
    "refuses when the port has a handler that is not ours (%s), and changes nothing",
    async (f) => {
      const r = rig({ serve: f });
      const before = JSON.stringify(r.serveDoc());
      const res = await r.setup.start();
      expect(res).toMatchObject({ ok: false, code: "port_taken" });
      expect(mutating(r.calls())).toEqual([]);
      expect(JSON.stringify(r.serveDoc())).toBe(before);
      expect(r.ids).toEqual([]);
      expect(existsSync(join(r.dataDir, SERVE_RECORD))).toBe(false);
      expect(step(r.setup.state, "serving").problem?.code).toBe("port_taken");
      expect(r.setup.state.can_start).toBe(false);
    },
  );

  it("refuses while Funnel is on for the port, and never runs funnel", async () => {
    const r = rig({ serve: "serve-funnel.json" });
    expect(await r.setup.start()).toMatchObject({ ok: false, code: "funnel_on" });
    expect(mutating(r.calls())).toEqual([]);
    expect(r.setup.state.serving).toBe("funnel");
    expect(r.ids).toEqual([]);
    expect(r.calls().flat()).not.toContain("funnel");
  });

  it.each([{ serveStatus: "fail" }, { serveStatus: "garbage" }])("refuses when the serve config can't be read (%o), and runs nothing", async (c) => {
    const r = rig({ conf: c, serve: "serve-foreign-8443.json" });
    expect(await r.setup.start()).toMatchObject({ ok: false, code: "unknown" });
    expect(mutating(r.calls())).toEqual([]);
    expect(r.ids).toEqual([]);
  });

  it.each<[string, Record<string, string>, bridgeApi.SetupProblemCode]>([
    ["HTTPS off", { status: "status-https-off.json" }, "https_off"],
    ["MagicDNS off", { status: "status-magicdns-off.json" }, "magicdns_off"],
    ["signed out", { status: "status-needs-login.json" }, "needs_login"],
    ["tagged", { status: "status-tagged.json" }, "tagged"],
    ["too old", { version: "version-old.txt" }, "too_old"],
    ["tailscale unreadable", { version: "garbage" }, "unknown"],
  ])("refuses before steps 1-3 are done (%s) with the blocking step's code, and runs nothing", async (_n, c, code) => {
    const r = rig({ conf: c });
    const res = await r.setup.start();
    // The refusal names the step that blocks (the panel shows that step's problem), never a generic failure.
    expect(res).toMatchObject({ ok: false, code, problem: { code } });
    expect(r.setup.state.steps.find((x) => x.state === "current")?.problem?.code).toBe(code);
    expect(mutating(r.calls())).toEqual([]);
    expect(r.actions).toEqual([{ op: "start", ok: false, code }]);
  });

  it("not installed: refused with not_installed", async () => {
    const r = rig({ bin: "/nonexistent/s14/tailscale" });
    expect(await r.setup.start()).toMatchObject({ ok: false, code: "not_installed" });
  });

  it("served by our command but the record can't be written: `failed`, with the command that stops it, and never removed by herdr", async () => {
    const r = rig();
    writeFileSync(r.dataDir, "not a directory"); // the data dir can't be created: writing the record fails
    const res = await r.setup.start();
    expect(res).toMatchObject({ ok: false, code: "failed", problem: { code: "failed", fix: "tailscale serve --https=8443 off" } });
    expect(mutating(r.calls())).toEqual([START]);
    // It works (served exactly as ours), but herdr does not treat it as its own.
    expect(r.setup.state.serving).toBe("identical");
    expect(r.setup.state.can_stop).toBe(false);
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]);
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "not_ours" });
    expect(mutating(r.calls())).toEqual([START]);
    expect(r.actions).toEqual([
      { op: "start", ok: false, code: "failed" },
      { op: "stop", ok: false, code: "not_ours" },
    ]);
  });

  it("an exact handler that appears while our command failed is not adopted as ours", async () => {
    const r = rig({ conf: { set: "applied-then-denied" } });
    expect(await r.setup.start()).toMatchObject({ ok: false, code: "operator" });
    expect(existsSync(join(r.dataDir, SERVE_RECORD))).toBe(false);
    expect(r.setup.state.serving).toBe("identical");
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "not_ours" });
    expect(mutating(r.calls())).toEqual([START]);
  });

  it("detects the Linux operator error and shows the fix, without running it", async () => {
    const r = rig({ conf: { set: "operator" } });
    const res = await r.setup.start();
    expect(res).toMatchObject({ ok: false, code: "operator" });
    expect(OPERATOR_FIX).toBe("sudo tailscale set --operator=$USER");
    expect(step(r.setup.state, "serving").problem).toMatchObject({ code: "operator", fix: OPERATOR_FIX });
    expect(mutating(r.calls())).toEqual([START]); // `tailscale set` is never run
    expect(r.ids).toEqual([]);
    expect(existsSync(join(r.dataDir, SERVE_RECORD))).toBe(false);
    // The problem stays on screen through the periodic checks.
    await r.setup.check();
    expect(step(r.setup.state, "serving").problem?.code).toBe("operator");
  });

  it("serve not enabled on the tailnet: the CLI waits; it is cut off and the enable link is shown", async () => {
    const r = rig({ conf: { set: "disabled" }, serveTimeoutMs: 1500 });
    const res = await r.setup.start();
    expect(res).toMatchObject({ ok: false, code: "serve_disabled", problem: { url: "https://login.tailscale.com/f/serve?node=n0001ExAmPlE" } });
    expect(r.ids).toEqual([]);
  });

  it("a handler that reads back different after start is not recorded as ours, and is never removed", async () => {
    const r = rig({ conf: { set: "foreign" } });
    expect(await r.setup.start()).toMatchObject({ ok: false, code: "failed" });
    expect(existsSync(join(r.dataDir, SERVE_RECORD))).toBe(false);
    expect(r.ids).toEqual([]);
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "not_ours" });
    expect(mutating(r.calls())).toEqual([START]);
  });
});

describe("Stop serving", () => {
  it("removes only our handler; another port's handler stays", async () => {
    const r = rig({ serve: "serve-other-port.json" });
    expect((await r.setup.start()).ok).toBe(true);
    expect(await r.setup.stop()).toEqual({ ok: true });
    expect(mutating(r.calls())).toEqual([START, STOP]);
    expect(r.serveDoc()).toEqual(fxj("serve-other-port.json"));
    expect(existsSync(join(r.dataDir, SERVE_RECORD))).toBe(false);
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }, null]);
    expect(r.setup.state.serving).toBe("off");
    expect(r.setup.state.can_start).toBe(true);
  });

  it("never removes an identical handler herdr did not create", async () => {
    const r = rig({ serve: "serve-ours.json" });
    const s = await r.setup.check();
    expect(s.serving).toBe("identical");
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]); // used as is
    expect(s.can_stop).toBe(false);
    const res = await r.setup.stop();
    expect(res).toMatchObject({ ok: false, code: "not_ours", problem: { fix: "tailscale serve --https=8443 off" } });
    expect(mutating(r.calls())).toEqual([]);
    expect(r.serveDoc()).toEqual(fxj("serve-ours.json"));
  });

  it("never removes a foreign handler", async () => {
    const r = rig({ serve: "serve-foreign-8443.json" });
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "not_ours" });
    expect(mutating(r.calls())).toEqual([]);
  });

  it("a record does not survive the port being emptied or changed by someone else", async () => {
    const r = rig();
    expect((await r.setup.start()).ok).toBe(true);
    r.serve({}); // removed outside herdr
    await r.setup.check();
    expect(existsSync(join(r.dataDir, SERVE_RECORD))).toBe(false);
    expect(r.ids.at(-1)).toBeNull();
    r.serve(fxj("serve-ours.json")); // and put back by someone else
    expect((await r.setup.check()).serving).toBe("identical");
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "not_ours" });
    expect(mutating(r.calls())).toEqual([START]);
  });

  it("the operator error on stop shows the fix too", async () => {
    const r = rig();
    expect((await r.setup.start()).ok).toBe(true);
    r.conf({ off: "operator" });
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "operator", problem: { fix: OPERATOR_FIX } });
    expect(r.setup.state.serving).toBe("ours");
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]);
  });
});

describe("audit and shutdown", () => {
  it("every Start and Stop reports its outcome as codes only; checks report nothing", async () => {
    const r = rig();
    await r.setup.check();
    expect(await r.setup.start()).toEqual({ ok: true });
    expect(await r.setup.stop()).toEqual({ ok: true });
    r.conf({ set: "operator" });
    await r.setup.start();
    expect(r.actions).toEqual([
      { op: "start", ok: true },
      { op: "stop", ok: true },
      { op: "start", ok: false, code: "operator" },
    ]);
    for (const a of r.actions) expect(Object.keys(a).sort()).toEqual(a.ok ? ["ok", "op"] : ["code", "ok", "op"]);
  });

  it("close waits for a Start in flight, then refuses new operations", async () => {
    const r = rig({ conf: { set: "disabled" }, serveTimeoutMs: 800 });
    const p = r.setup.start();
    await new Promise((res) => setTimeout(res, 100)); // the serve command is running
    expect(r.setup.state.busy).toBe(true);
    await r.setup.close();
    // Finished and reported before close resolved.
    expect(r.actions).toEqual([{ op: "start", ok: false, code: "serve_disabled" }]);
    expect(r.setup.state.busy).toBe(false);
    expect(await p).toMatchObject({ ok: false, code: "serve_disabled" });
    await expect(r.setup.start()).rejects.toBeInstanceOf(SetupClosedError);
    await expect(r.setup.check()).rejects.toBeInstanceOf(SetupClosedError);
    expect(r.actions).toEqual([{ op: "start", ok: false, code: "serve_disabled" }]);
  });
});

describe("serve identity", () => {
  it("a check that can't tell keeps the identity; a proven change replaces it", async () => {
    const r = rig();
    expect((await r.setup.start()).ok).toBe(true);
    for (const c of [{ serveStatus: "fail" }, { serveStatus: "garbage" }, { status: "garbage" }, { version: "fail" }]) {
      r.conf(c);
      await r.setup.check();
    }
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]);
    r.conf({ status: "status-other-login.json" });
    await r.setup.check();
    expect(r.ids.at(-1)).toEqual({ host: HOST, login: "user-2@example" });
    r.conf({ status: "status-tagged.json" });
    await r.setup.check();
    expect(r.ids.at(-1)).toBeNull();
  });

  it.each<[string, Record<string, string>]>([
    ["tailscaled down", { status: "daemon-down" }],
    ["tailscale stopped", { status: "status-stopped.json" }],
    ["signed out", { status: "status-needs-login.json" }],
    ["HTTPS off", { status: "status-https-off.json" }],
  ])("keeps the identity while %s (phones would otherwise be refused for good)", async (_n, c) => {
    const r = rig();
    expect((await r.setup.start()).ok).toBe(true);
    r.conf(c);
    await r.setup.check();
    r.conf({});
    await r.setup.check();
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]);
  });

  it("the owner changing while blocked clears the identity", async () => {
    const r = rig();
    expect((await r.setup.start()).ok).toBe(true);
    r.conf({ status: "status-other-login-https-off.json" }); // HTTPS off, and another owner
    await r.setup.check();
    expect(r.ids.at(-1)).toBeNull();
  });

  it("Funnel turning on for our handler keeps the identity and asks for a Funnel re-check", async () => {
    let funnels = 0;
    const r = rig({ onFunnel: () => (funnels += 1) });
    expect((await r.setup.start()).ok).toBe(true);
    r.serve({ ...(r.serveDoc() as object), AllowFunnel: { [HOST]: true } });
    expect((await r.setup.check()).serving).toBe("funnel");
    expect(funnels).toBe(1);
    expect(r.ids).toEqual([{ host: HOST, login: "user-1@example" }]); // the Funnel guard refuses; 4004, not 4001
    // Changed outside herdr: no longer ours to remove, even once Funnel is off again.
    expect(await r.setup.stop()).toMatchObject({ ok: false, code: "funnel_on" });
    r.serve(fxj("serve-ours.json"));
    expect((await r.setup.check()).serving).toBe("identical");
    expect(mutating(r.calls())).toEqual([START]);
  });

  it("identity callbacks fire only on change (a repeat would drop sockets and pairing codes)", async () => {
    const r = rig();
    await r.setup.start();
    await r.setup.check();
    await r.setup.check();
    expect(r.ids).toHaveLength(1);
  });

  it("a periodic check whose callback throws is not an unhandled rejection", async () => {
    const r = rig();
    const s = new Setup({
      run,
      tailscale: r.bin,
      apiPort: API,
      dataDir: r.dataDir,
      hasPhone: () => false,
      onIdentity: () => {},
      onState: (st) => {
        if (st.checked_at !== null && !st.busy) throw new Error("subscriber failed");
      },
    });
    setups.push(s);
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onRej);
    try {
      s.startTimer();
      await new Promise((res) => setTimeout(res, 1500));
    } finally {
      process.off("unhandledRejection", onRej);
    }
    expect(seen).toEqual([]);
    expect(r.calls().length).toBeGreaterThan(0);
  });

  it("every published state matches the protocol schema", async () => {
    const r = rig({ conf: { set: "operator" } });
    await r.setup.check();
    await r.setup.start();
    expect(r.states.length).toBeGreaterThan(2);
    for (const s of r.states) expect(bridgeApi.SetupTopic.safeParse(s).success).toBe(true);
    expect(r.states.some((s) => s.busy)).toBe(true);
  });
});
