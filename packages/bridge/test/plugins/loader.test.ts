import { describe, expect, it } from "vitest";
import { hasImports, loadPinned, parseReceipt } from "../../src/plugins/loader.js";
import { put, sha, tmp } from "./helpers.js";

const receipt = (files: Record<string, unknown>) => JSON.stringify({ v: 1, files });

describe("parseReceipt", () => {
  it("accepts both the panorama and inbox shapes", () => {
    const h = sha("x");
    expect(parseReceipt(JSON.stringify({ files: { a: { sha256: h, mode: 420 } } }))?.get("a")).toBe(h);
    expect(parseReceipt(JSON.stringify({ files: { a: h } }))?.get("a")).toBe(h);
  });
  it("rejects garbage", () => {
    expect(parseReceipt("{")).toBeUndefined();
    expect(parseReceipt(JSON.stringify({ files: { a: "short" } }))).toBeUndefined();
    expect(parseReceipt(JSON.stringify({ files: [] }))).toBeUndefined();
    expect(parseReceipt("null")).toBeUndefined();
  });
});

describe("hasImports", () => {
  it("spots static, re-export and dynamic imports but not words in strings", () => {
    expect(hasImports("import { a } from './a.js';")).toBe(true);
    expect(hasImports("const x = 1;\nimport a from 'b';")).toBe(true);
    expect(hasImports("export * from './a.js';")).toBe(true);
    expect(hasImports("const m = await import('./a.js');")).toBe(true);
    expect(hasImports("export const x = 'important';\n// reimport later")).toBe(false);
  });
});

describe("loadPinned", () => {
  const files = "mods/p/a.js";
  const make = (src: string, pin = sha(src)) => {
    const home = tmp();
    put(home, files, src);
    put(home, "r.json", receipt({ [files]: pin }));
    return home;
  };
  it("loads the verified bytes", async () => {
    const r = await loadPinned(make("export const n = 41 + 1;"), "r.json", [files]);
    expect(r.ok && r.modules[files]?.["n"]).toBe(42);
  });
  it("runs the checked bytes, not the file on disk afterwards", async () => {
    const home = make("export const n = 1;");
    const r = await loadPinned(home, "r.json", [files]);
    put(home, files, "export const n = 2;");
    expect(r.ok && r.modules[files]?.["n"]).toBe(1);
  });
  it("broken on a hash mismatch", async () => {
    const r = await loadPinned(make("export const n = 1;", sha("other")), "r.json", [files]);
    expect(r).toMatchObject({ ok: false, reason: "broken" });
  });
  it("broken when the file is not in the receipt", async () => {
    const home = make("export const n = 1;");
    expect(await loadPinned(home, "r.json", ["mods/p/b.js"])).toMatchObject({ ok: false, reason: "broken" });
  });
  it("broken when the file has imports, even if pinned", async () => {
    const r = await loadPinned(make("import './x.js';\nexport const n = 1;"), "r.json", [files]);
    expect(r).toMatchObject({ ok: false, reason: "broken", detail: expect.stringMatching(/imports/) });
  });
  it("broken when evaluation throws", async () => {
    expect(await loadPinned(make("throw new Error('x');"), "r.json", [files])).toMatchObject({ ok: false, reason: "broken" });
  });
  it("missing without a receipt", async () => {
    expect(await loadPinned(tmp(), "r.json", [files])).toMatchObject({ ok: false, reason: "missing" });
  });
});
