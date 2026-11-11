// @vitest-environment node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pwa = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("CSP: default-src 'self'", () => {
  it("the production build emits no data: URLs", async () => {
    const { build } = await import("vite");
    const built = (await build({ root: pwa, logLevel: "silent", build: { write: false, outDir: resolve(pwa, "dist-test") } })) as unknown as { output: { type: string; fileName: string; code?: string; source?: string | Uint8Array }[] }[];
    const out = Array.isArray(built) ? built : [built];
    const texts = out.flatMap((o) => o.output).filter((f) => /\.(js|css|html)$/.test(f.fileName)).map((f) => ({ name: f.fileName, text: String(f.code ?? f.source) }));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t.text, t.name).not.toMatch(/data:(image|font|application)/);
  }, 60_000);
});
