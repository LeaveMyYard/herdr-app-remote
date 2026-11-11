import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Only the argument check of scripts/release.sh is exercised. PATH holds just the tools that check
// needs (sh builtins, dirname, grep), so a version that passes it stops at "missing tool" before any
// build, install, tag or file write.
const script = resolve(import.meta.dirname, "../../scripts/release.sh");
const dir = mkdtempSync(join(tmpdir(), "release-args-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
for (const t of ["dirname", "grep"]) {
  const found = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
  symlinkSync(found, join(dir, t));
}

const run = (...args: string[]) =>
  spawnSync("/bin/sh", [script, ...args], { env: { PATH: dir }, encoding: "utf8" });

describe("release.sh version argument", () => {
  it.each([
    ["no argument", []],
    ["empty", [""]],
    ["a newline after a valid version", ["1.2.3\nevil"]],
    ["a newline before a valid version", ["evil\n1.2.3"]],
    ["only a newline", ["\n"]],
    ["two parts", ["1.2"]],
    ["a leading v", ["v1.2.3"]],
    ["a trailing dot", ["1.2.3."]],
    ["a dangling hyphen", ["1.2.3-"]],
    ["a space", ["1.2.3 x"]],
    ["a slash", ["1.2.3/x"]],
    ["a shell metacharacter", ["1.2.3;ls"]],
  ] as [string, string[]][])("refuses %s", (_name, args) => {
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: scripts/release.sh");
  });

  it.each(["0.1.0", "10.20.30", "0.1.0-rc.1", "1.0.0-beta", "1.0.0.4"])("accepts %s as a version", (v) => {
    const r = run(v);
    expect(r.stderr).not.toContain("usage:");
    expect(r.stderr).toContain("missing tool");
  });
});
