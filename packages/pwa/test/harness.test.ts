import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compare, MAX_DIFF_RATIO, REFS } from "../visual/compare";

const refBytes = () => readFileSync(resolve(REFS, "PhoneMissing.png"));

/** The ref with a w x h block painted white at (x, y). */
function withBlock(x: number, y: number, w: number, h: number): Buffer {
  const png = PNG.sync.read(refBytes());
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const o = (j * png.width + i) * 4;
      png.data.fill(255, o, o + 4);
    }
  }
  return PNG.sync.write(png);
}

describe("visual harness compare()", () => {
  it("reports no difference for an identical image", () => {
    expect(compare(refBytes(), "PhoneMissing", []).diffPixels).toBe(0);
  });

  it("catches a regression bigger than the threshold", () => {
    const r = compare(withBlock(100, 100, 100, 100), "PhoneMissing", []);
    expect(r.ratio).toBeGreaterThan(MAX_DIFF_RATIO);
  });

  it("ignores a change inside a masked rect (animations) but not outside it", () => {
    const img = withBlock(100, 100, 100, 100);
    expect(compare(img, "PhoneMissing", [{ x: 90, y: 90, width: 130, height: 130 }]).diffPixels).toBe(0);
    expect(compare(img, "PhoneMissing", [{ x: 0, y: 0, width: 50, height: 50 }]).diffPixels).toBeGreaterThan(0);
  });

  it("rejects an image of a different size", () => {
    const small = PNG.sync.write(new PNG({ width: 10, height: 10 }));
    expect(() => compare(small, "PhoneMissing", [])).toThrow(/size mismatch/);
  });
});
