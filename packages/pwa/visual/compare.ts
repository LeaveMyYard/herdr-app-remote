import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
export const REFS = resolve(here, "../../../design/refs");

/** At most this share of pixels may differ (PLAN section 5). */
export const MAX_DIFF_RATIO = 0.005;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function blank(png: PNG, rects: Rect[]): void {
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(png.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }
}

export interface Result {
  ratio: number;
  diffPixels: number;
  total: number;
}

/** The `clip` part of an image (whole pixels, clamped to the image). */
function crop(png: PNG, r: Rect): PNG {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const w = Math.min(png.width - x0, Math.ceil(r.width));
  const h = Math.min(png.height - y0, Math.ceil(r.height));
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x0, y0, w, h, 0, 0);
  return out;
}

/**
 * Compares a screenshot with a design render; masked rects (animations) are painted out of both. With `clip`, only
 * that part of each image is compared (a board drawn inside browser chrome).
 */
export function compare(actual: Buffer, refName: string, masks: Rect[], diffOut?: string, clip?: Rect): Result {
  let a: PNG = PNG.sync.read(actual);
  let b: PNG = PNG.sync.read(readFileSync(resolve(REFS, `${refName}.png`)));
  if (clip) {
    a = crop(a, clip);
    b = crop(b, clip);
  }
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch for ${refName}: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  blank(a, masks);
  blank(b, masks);
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  if (diffOut && diffPixels > 0) {
    mkdirSync(dirname(diffOut), { recursive: true });
    writeFileSync(diffOut, PNG.sync.write(diff));
  }
  const total = a.width * a.height;
  return { ratio: diffPixels / total, diffPixels, total };
}
