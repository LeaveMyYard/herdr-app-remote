import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newLinkToken, removeRuntime, runtimePath, writeRuntime } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home() {
  const base = process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir();
  const d = mkdtempSync(join(base, "remote-runtime-"));
  dirs.push(d);
  return d;
}

describe("runtime.json", () => {
  it("makes 256-bit url-safe tokens that differ", () => {
    const a = newLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newLinkToken()).not.toBe(a);
  });

  it("lives under data/herdr-app-remote in the app home", () => {
    expect(runtimePath("/app")).toBe("/app/data/herdr-app-remote/runtime.json");
  });

  it("is written 0600 in a 0700 directory, atomically, with no temp files left", async () => {
    const path = runtimePath(home());
    const rt = { v: 1 as const, port: 47123, token: newLinkToken(), pid: process.pid, bundle_sha256: null };
    await writeRuntime(path, rt);
    await writeRuntime(path, { ...rt, port: 47124 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...rt, port: 47124 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path))).toEqual(["runtime.json"]);
  });

  it("refuses to write an invalid runtime", async () => {
    const path = runtimePath(home());
    await expect(writeRuntime(path, { v: 1, port: 0, token: "x", pid: 1, bundle_sha256: null })).rejects.toThrow();
  });

  it("removes only its own runtime", async () => {
    const path = runtimePath(home());
    await writeRuntime(path, { v: 1, port: 47123, token: newLinkToken(), pid: 4242, bundle_sha256: null });
    await removeRuntime(path, 4243);
    expect(statSync(path).isFile()).toBe(true);
    await removeRuntime(path, 4242);
    expect(() => statSync(path)).toThrow();
    writeFileSync(path, "not json");
    await removeRuntime(path, 4242);
    expect(statSync(path).isFile()).toBe(true);
  });
});
