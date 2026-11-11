import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Home } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home(): string {
  const d = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "rh-"));
  dirs.push(d);
  return d;
}

describe("Home never follows a link inside the home", () => {
  it("refuses to read a file through a link, or under a linked folder", () => {
    const d = home();
    writeFileSync(join(d, "real.json"), "{}");
    symlinkSync(join(d, "real.json"), join(d, "link.json"));
    mkdirSync(join(d, "dir"));
    writeFileSync(join(d, "dir", "f"), "x");
    symlinkSync(join(d, "dir"), join(d, "linkdir"));
    const h = new Home(d);
    expect(h.read("real.json")?.data.toString()).toBe("{}");
    expect(() => h.read("link.json")).toThrow(/a link/);
    expect(() => h.read("linkdir/f")).toThrow(/Not a folder/);
    expect(h.kind("link.json")).toBe("other");
    expect(() => h.write("linkdir/g", "x", 0o644)).toThrow(/Not a folder/);
  });

  it("rejects unsafe relative paths", () => {
    const h = new Home(home());
    for (const p of ["/etc/passwd", "../x", "a/../b", "a//b", "", "a/"]) expect(() => h.read(p)).toThrow(/Unsafe relative path/);
  });
});
