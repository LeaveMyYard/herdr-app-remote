import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rigDir = resolve(import.meta.dirname, "..");

// A private rig dir: inner.sh is run without bwrap, with fake hc/herdr-app that would fail the
// test loudly if a guard let execution reach them.
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rig-guard-"));
  made.push(root);
  const bin = join(root, "fakebin");
  mkdirSync(bin);
  for (const t of ["hc", "herdr-app", "node", "mutter", "dbus-run-session"]) {
    writeFileSync(join(bin, t), `#!/bin/sh\necho "FAKE-${t} reached" >> "${root}/reached"\nexit 0\n`);
    chmodSync(join(bin, t), 0o755);
  }
  mkdirSync(join(root, "empty-run-user"));
  return { root, bin };
}

function runInner(env: Record<string, string>, root: string, bin: string) {
  return spawnSync("sh", [join(rigDir, "inner.sh")], {
    env: { RIG_RUN_USER: join(root, "empty-run-user"), PATH: `${bin}:/usr/bin:/bin`, RIG: root, SCENARIO: "isolation", ...env },
    encoding: "utf8",
  });
}

describe("inner.sh ABORT guards", () => {
  it("aborts when the runtime dir is under /run/user", () => {
    const { root, bin } = sandbox();
    const r = runInner({ XDG_RUNTIME_DIR: "/run/user/1000", HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: runtime dir unset or under /run/user");
  });

  it("aborts when the runtime dir is unset", () => {
    const { root, bin } = sandbox();
    const r = runInner({ HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: runtime dir");
  });

  it("aborts when the app home is outside the rig", () => {
    const { root, bin } = sandbox();
    const r = runInner({ XDG_RUNTIME_DIR: `${root}/run`, HERDR_APP_HOME: "/home/user-1/.config/herdr-app", HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: app home is not inside the rig");
  });

  it("aborts when HOME is outside the rig", () => {
    const { root, bin } = sandbox();
    const r = runInner({ XDG_RUNTIME_DIR: `${root}/run`, HERDR_APP_HOME: `${root}/h`, HOME: "/home/user-1", HC_SESSION: "x" }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: HOME is not inside the rig");
  });

  it("aborts when the hc socket is outside the rig", () => {
    const { root, bin } = sandbox();
    writeFileSync(join(bin, "hc"), `#!/bin/sh\necho "socket /tmp/elsewhere/s.sock"\n`);
    chmodSync(join(bin, "hc"), 0o755);
    const r = runInner({ XDG_RUNTIME_DIR: `${root}/run`, HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: hc socket outside the rig");
    expect(existsSync(`${root}/reached`)).toBe(false);
  });

  it("aborts when HC_SESSION is unset", () => {
    const { root, bin } = sandbox();
    const r = runInner({ XDG_RUNTIME_DIR: `${root}/run`, HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h` }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: HC_SESSION unset");
  });

  it("aborts when the hc socket is not inside the rig", () => {
    const { root, bin } = sandbox();
    writeFileSync(join(bin, "hc"), `#!/bin/sh\necho "socket /run/user/1000/herdr-core/s.sock"\n`);
    chmodSync(join(bin, "hc"), 0o755);
    const r = runInner({ XDG_RUNTIME_DIR: `${root}/run`, HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ABORT: hc socket under /run/user");
  });

  it("never starts the app or the display after an abort", () => {
    const { root, bin } = sandbox();
    runInner({ XDG_RUNTIME_DIR: "/run/user/1000", HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
    const reached = spawnSync("cat", [`${root}/reached`], { encoding: "utf8" });
    expect(reached.status).not.toBe(0);
  });
});

it("aborts when /run/user is visible", () => {
  const { root, bin } = sandbox();
  writeFileSync(join(root, "empty-run-user", "x"), "");
  const r = runInner({ XDG_RUNTIME_DIR: `${root}/run`, HERDR_APP_HOME: `${root}/h`, HOME: `${root}/h`, HC_SESSION: "x" }, root, bin);
  expect(r.status).toBe(1);
  expect(r.stdout).toContain("ABORT: /run/user is visible");
});

describe("run.sh outer guards", () => {
  // Never creates anything: the path is judged before mkdir (the dir must not exist afterwards).
  it.each([
    ["/run/user/1000/rig-guard-test-scratch", "ABORT: scratch dir under /run/user"],
    ["/run/user/../user/1000/rig-guard-test-scratch2", "ABORT: scratch dir under /run/user"],
    [`${process.env.HOME}/.config/herdr-app/rig-guard-test-scratch`, "ABORT: scratch dir inside the live app home"],
  ])("aborts before creating %s", (path, msg) => {
    expect(existsSync(path)).toBe(false);
    const r = spawnSync("sh", [join(rigDir, "run.sh"), "isolation", path], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(msg);
    expect(existsSync(path)).toBe(false);
  });

  it("aborts on an unknown scenario", () => {
    const r = spawnSync("sh", [join(rigDir, "run.sh"), "no-such-scenario", tmpdir()], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ABORT: no such scenario");
  });

  it("keeps the bwrap isolation flags", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(rigDir, "run.sh"), "utf8");
    for (const flag of ["--tmpfs /run/user", '--tmpfs "$HOME/.config/herdr-app"', "--unshare-pid", "--proc /proc", "--unshare-net", "--die-with-parent", "HERDR_APP_HOME=", "HC_SESSION=", "XDG_RUNTIME_DIR=", "XDG_STATE_HOME=", "XDG_CONFIG_HOME="]) {
      expect(src).toContain(flag);
    }
  });
});
