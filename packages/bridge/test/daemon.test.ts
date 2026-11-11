import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { install } from "@herdr-remote/protocol";
import { appRuns, checkBundle, launch, liveBridge, main, parseArgs, readRuntimeFile, serve, serveArgv, type Bridge } from "../src/index.js";

const dirs: string[] = [];
const bridges: Bridge[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop("signal");
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM"); // exact pids this test started, never a pattern
    } catch {
      /* gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const d = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "remote-daemon-"));
  dirs.push(d);
  return d;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function receipt(bundleSha: string) {
  return {
    v: 1,
    install_id: "0123456789abcdef0123456789abcdef",
    node: process.execPath,
    dirs: [],
    files: { [install.BUNDLE_PATH]: { sha256: bundleSha, mode: 0o644 } },
    previous: {},
    keys: null,
  };
}

/** An app home with a bundle at the installed path and a record naming it. */
function installed(bytes: Buffer | string = "// fake bundle\n", recorded?: string): { home: string; bundle: string; sha: string } {
  const h = home();
  const bundle = join(h, install.BUNDLE_PATH);
  mkdirSync(dirname(bundle), { recursive: true, mode: 0o700 });
  writeFileSync(bundle, bytes);
  writeFileSync(join(h, install.RECEIPT_PATH), JSON.stringify(receipt(recorded ?? sha(bytes))), { mode: 0o600 });
  return { home: h, bundle, sha: sha(bytes) };
}

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
};

function linkClient(port: number, token: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      s.write(JSON.stringify({ type: "hello", v: 1, token, copy: "link", layout: "herdr-remote", app: { version: "0.0.1" } }) + "\n");
      resolve(s);
    });
    s.once("error", reject);
  });
}

describe("checkBundle", () => {
  it("accepts only the installed bundle whose bytes match the record", async () => {
    const { home: h, bundle, sha: s } = installed();
    expect(await checkBundle(h, bundle)).toEqual({ ok: true, sha256: s });
    writeFileSync(bundle, "// swapped\n");
    expect(await checkBundle(h, bundle)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a bundle elsewhere, a missing record and a broken one", async () => {
    const { home: h, bundle } = installed();
    const other = join(h, "elsewhere.mjs");
    copyFileSync(bundle, other);
    expect(await checkBundle(h, other)).toEqual({ ok: false, reason: "wrong_path" });
    writeFileSync(join(h, install.RECEIPT_PATH), "{");
    expect(await checkBundle(h, bundle)).toEqual({ ok: false, reason: "bad_receipt" });
    writeFileSync(join(h, install.RECEIPT_PATH), JSON.stringify({ ...receipt("ab".repeat(32)), extra: true }));
    expect(await checkBundle(h, bundle)).toEqual({ ok: false, reason: "bad_receipt" });
    rmSync(join(h, install.RECEIPT_PATH));
    expect(await checkBundle(h, bundle)).toEqual({ ok: false, reason: "not_installed" });
  });
});

describe("appRuns", () => {
  it("is false with no socket or a refused one, true while something listens", async () => {
    const h = home();
    expect(await appRuns(h)).toBe(false);
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(join(h, "herdr-app.sock"), r));
    expect(await appRuns(h)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    writeFileSync(join(h, "herdr-app.sock"), ""); // not a socket at all: refused, as a stale one is
    expect(await appRuns(h)).toBe(false);
  });
});

describe("serve", () => {
  async function start(h: string, s: string, over: Partial<Parameters<typeof serve>[0]> = {}) {
    const b = await serve({ appHome: h, bundleSha256: s, checkMs: 20, graceMs: 100, appAlive: async () => true, ...over });
    if (b) bridges.push(b);
    return b;
  }

  it("writes runtime.json 0600 with its pid, port and bundle hash, and removes it on stop", async () => {
    const { home: h, sha: s } = installed();
    const b = (await start(h, s))!;
    const rt = (await readRuntimeFile(h))!;
    expect(rt).toMatchObject({ v: 1, port: b.port, pid: process.pid, bundle_sha256: s });
    expect(statSync(join(h, install.DATA_DIR, "runtime.json")).mode & 0o777).toBe(0o600);
    expect(await b.stop("signal")).toBe("signal");
    expect(await readRuntimeFile(h)).toBeNull();
  });

  it("does not start while another live bridge serves the home", async () => {
    const { home: h, sha: s } = installed();
    await start(h, s);
    expect(await start(h, s, { pid: 2 ** 22 + 12345 })).toBeNull();
    expect((await readRuntimeFile(h))!.pid).toBe(process.pid);
  });

  it("stops when the install record goes (uninstall)", async () => {
    const { home: h, sha: s } = installed();
    const b = (await start(h, s))!;
    rmSync(join(h, install.RECEIPT_PATH));
    expect(await b.stopped).toBe("uninstalled");
    expect(existsSync(join(h, install.DATA_DIR, "runtime.json"))).toBe(false);
  });

  it("stops when the record names another bundle (upgrade), freeing the lock for the new one", async () => {
    const { home: h, sha: s } = installed();
    const b = (await start(h, s))!;
    writeFileSync(join(h, install.RECEIPT_PATH), JSON.stringify(receipt("cd".repeat(32))));
    expect(await b.stopped).toBe("superseded");
  });

  it("stops when runtime.json names another pid, and leaves that file alone", async () => {
    const { home: h, sha: s } = installed();
    const b = (await start(h, s))!;
    const rt = (await readRuntimeFile(h))!;
    const theirs = { ...rt, pid: rt.pid + 1 };
    writeFileSync(join(h, install.DATA_DIR, "runtime.json"), JSON.stringify(theirs));
    expect(await b.stopped).toBe("replaced");
    expect(await readRuntimeFile(h)).toEqual(theirs);
  });

  it("idles out once no link is connected for the grace period and the app is gone", async () => {
    const { home: h, sha: s } = installed();
    let alive = true;
    const b = (await start(h, s, { appAlive: async () => alive }))!;
    await new Promise((r) => setTimeout(r, 250));
    expect(await Promise.race([b.stopped, Promise.resolve("running")])).toBe("running"); // app still there
    alive = false;
    expect(await b.stopped).toBe("app_gone");
  });

  it("waits out the grace period before asking whether the app is gone", async () => {
    const { home: h, sha: s } = installed();
    let asked = 0;
    const b = (await start(h, s, { graceMs: 60_000, appAlive: async () => (asked++, false) }))!;
    await new Promise((r) => setTimeout(r, 300));
    expect(await Promise.race([b.stopped, Promise.resolve("running")])).toBe("running");
    expect(asked).toBe(0);
  });

  it("keeps serving while the link copy is connected, even with the app socket gone", async () => {
    const { home: h, sha: s } = installed();
    const b = (await start(h, s, { appAlive: async () => false }))!;
    const rt = (await readRuntimeFile(h))!;
    const c = await linkClient(rt.port, rt.token);
    await waitFor(() => b.link.connected("link"));
    await new Promise((r) => setTimeout(r, 300));
    expect(await Promise.race([b.stopped, Promise.resolve("running")])).toBe("running");
    c.destroy();
    expect(await b.stopped).toBe("app_gone");
  });
});

describe("launch", () => {
  it("refuses a bundle that does not match the record, and spawns nothing", async () => {
    const { home: h, bundle } = installed("// a\n", "ab".repeat(32));
    const spawned: unknown[] = [];
    const r = await launch({ appHome: h, bundle, node: "/n", flock: null, spawn: (...a) => (spawned.push(a), { unref() {}, on() {} }) });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
    expect(spawned).toEqual([]);
  });

  it("does nothing while a live bridge runs this same bundle", async () => {
    const { home: h, bundle, sha: s } = installed();
    bridges.push((await serve({ appHome: h, bundleSha256: s, appAlive: async () => true }))!);
    const spawned: unknown[] = [];
    const r = await launch({ appHome: h, bundle, node: "/n", flock: null, spawn: (...a) => (spawned.push(a), { unref() {}, on() {} }) });
    expect(r).toEqual({ ok: true, started: false });
    expect(spawned).toEqual([]);
  });

  it("starts a new bridge when the live one runs another bundle (an upgrade it has not noticed yet)", async () => {
    const { home: h, bundle } = installed();
    bridges.push((await serve({ appHome: h, bundleSha256: "cd".repeat(32), appAlive: async () => true }))!);
    const spawned: unknown[] = [];
    const r = await launch({ appHome: h, bundle, node: "/n", flock: null, spawn: (...a) => (spawned.push(a), { unref() {}, on() {} }) });
    expect(r).toEqual({ ok: true, started: true });
    expect(spawned).toHaveLength(1);
  });

  it("starts serve detached, under flock -n on the lock file when flock exists", async () => {
    const { home: h, bundle } = installed();
    chmodSync(join(h, install.DATA_DIR), 0o755);
    const spawned: [string, string[], Record<string, unknown>][] = [];
    const spawn = (cmd: string, args: string[], opts: object) => (spawned.push([cmd, args, opts as Record<string, unknown>]), { unref() {}, on() {} });
    expect(await launch({ appHome: h, bundle, node: "/n", flock: "/usr/bin/flock", spawn })).toEqual({ ok: true, started: true });
    expect(spawned[0]![0]).toBe("/usr/bin/flock");
    expect(spawned[0]![1]).toEqual(["-n", join(h, install.LOCK_PATH), "/n", bundle, "serve", "--app-home", h]);
    expect(spawned[0]![2]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(statSync(join(h, install.DATA_DIR)).mode & 0o777).toBe(0o700);
    await launch({ appHome: h, bundle, node: "/n", flock: null, spawn });
    expect(spawned[1]![0]).toBe("/n");
    expect(spawned[1]![1]).toEqual([bundle, "serve", "--app-home", h]);
  });

  it("builds argv only: paths with spaces and quotes stay single arguments", () => {
    const appHome = "/tmp/a b'c";
    const [cmd, args] = serveArgv({ appHome, bundle: `${appHome}/x.mjs`, node: "/n", flock: null });
    expect([cmd, ...args]).toEqual(["/n", `${appHome}/x.mjs`, "serve", "--app-home", appHome]);
  });
});

describe("cli", () => {
  it("takes exactly launch|serve --app-home ABS", async () => {
    expect(parseArgs(["launch", "--app-home", "/x"])).toEqual({ cmd: "launch", appHome: "/x" });
    expect(parseArgs(["serve", "--app-home", "/x"])).toEqual({ cmd: "serve", appHome: "/x" });
    for (const bad of [[], ["run"], ["launch"], ["launch", "--app-home", "rel"], ["launch", "--app-home", "/x", "more"], ["exec", "--app-home", "/x"]]) {
      expect(parseArgs(bad)).toBeNull();
    }
    expect(await main(["exec", "--app-home", "/x"], "/b")).toBe(2);
  });

  it("serve refuses a bundle the record does not name", async () => {
    const { home: h } = installed("// a\n", "ab".repeat(32));
    expect(await main(["serve", "--app-home", h], join(h, install.BUNDLE_PATH))).toBe(1);
    expect(await readRuntimeFile(h)).toBeNull();
  });
});

const BUNDLE = fileURLToPath(new URL("../dist/bridge.mjs", import.meta.url));
const flock = ["/usr/bin/flock", "/bin/flock"].find((p) => existsSync(p));

describe.skipIf(!existsSync(BUNDLE))("the built bundle, end to end", () => {
  it("launch starts one detached bridge, a second launch adds none, and it stops on uninstall", async () => {
    const { home: h, bundle } = installed(readFileSync(BUNDLE));
    const run = () => spawnSync(process.execPath, [bundle, "launch", "--app-home", h], { encoding: "utf8", timeout: 10_000 });
    const first = run();
    expect(first.status).toBe(0);
    await waitFor(async () => (await liveBridge(h, -1)) !== null, 8000);
    const rt = (await readRuntimeFile(h))!;
    pids.push(rt.pid);
    expect(rt.bundle_sha256).toBe(sha(readFileSync(BUNDLE)));
    expect(run().status).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect((await readRuntimeFile(h))!.pid).toBe(rt.pid);
    if (flock) expect(existsSync(join(h, install.LOCK_PATH))).toBe(true);
    rmSync(join(h, install.RECEIPT_PATH));
    await waitFor(() => !existsSync(join(h, install.DATA_DIR, "runtime.json")), 9000);
    await waitFor(() => {
      try {
        process.kill(rt.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000);
  }, 20_000);

  it("two racing launches leave one bridge", async () => {
    const { home: h, bundle } = installed(readFileSync(BUNDLE));
    const a = spawnSync(process.execPath, [bundle, "launch", "--app-home", h], { timeout: 10_000 });
    const b = spawnSync(process.execPath, [bundle, "launch", "--app-home", h], { timeout: 10_000 });
    expect([a.status, b.status]).toEqual([0, 0]);
    await waitFor(async () => (await liveBridge(h, -1)) !== null, 8000);
    const rt = (await readRuntimeFile(h))!;
    pids.push(rt.pid);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await readRuntimeFile(h))!.pid).toBe(rt.pid);
    rmSync(join(h, install.RECEIPT_PATH));
    await waitFor(() => !existsSync(join(h, install.DATA_DIR, "runtime.json")), 9000);
  }, 20_000);
});
