// The herdr-app icon on the operator's machine becomes this PWA's icons at install time. The repository and
// the release bundle never contain it: herdr-app is Apache-2.0 with no trademark grant, so its art is read from the
// operator's own install, rendered here into the installed PWA folder, and recorded like any other installed file.
// Without it (or if rendering fails) the neutral icons from the build stay, and the installer says so in one line.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { install as P } from "@herdr-remote/protocol";

export const ICON_NAME = "herdr-app.svg";
const SVG_LIMIT = 1024 * 1024;

/** Installed PWA file -> the square size it is rendered at, and how. */
export const ICON_FILES: { path: string; size: number; kind: "tile" | "flat" | "maskable" }[] = [
  { path: `${P.PWA_DIR}/icons/apple-touch-icon.png`, size: 180, kind: "flat" },
  { path: `${P.PWA_DIR}/icons/icon-192.png`, size: 192, kind: "tile" },
  { path: `${P.PWA_DIR}/icons/icon-512.png`, size: 512, kind: "tile" },
  { path: `${P.PWA_DIR}/icons/icon-maskable-512.png`, size: 512, kind: "maskable" },
  { path: `${P.PWA_DIR}/icons/favicon.png`, size: 64, kind: "tile" },
  { path: `${P.PWA_DIR}/icons/app-logo.png`, size: 192, kind: "tile" },
];

/** Where herdr-app keeps its icon, from the `herdr-app` binary (a symlink in PATH is followed): beside it, or in ../share/herdr-app. */
export function findIcon(bin: string | null): string | null {
  if (!bin) return null;
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return null;
  }
  const dir = dirname(real);
  for (const c of [join(dir, ICON_NAME), join(dir, "..", "share", "herdr-app", ICON_NAME)]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

let ready: Promise<void> | null = null;
function wasm(): Promise<void> {
  ready ??= initWasm(readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")));
  return ready;
}

interface Tile {
  box: [number, number, number, number];
  fill: string | null;
}

/** The artwork's tile (a rect covering most of the canvas), if it has one: its box and flat fill. */
function tileOf(svg: string, canvas: [number, number, number, number]): Tile | null {
  const num = (tag: string, a: string): number | null => {
    const m = new RegExp(`\\s${a}="(-?[0-9.]+)(?:px)?"`).exec(tag);
    return m ? Number(m[1]) : null;
  };
  let tile: Tile | null = null;
  for (const m of svg.matchAll(/<rect\b[^>]*>/g)) {
    const [x, y, w, h] = [num(m[0], "x") ?? 0, num(m[0], "y") ?? 0, num(m[0], "width"), num(m[0], "height")];
    if (w === null || h === null || w < canvas[2] * 0.8 || h < canvas[3] * 0.8) continue;
    const fill = /\sfill="(#[0-9a-fA-F]{6})"/.exec(m[0]);
    // The first big rect gives the box (it may be a clip path); the first one with a flat fill gives the colour.
    tile ??= { box: [x, y, w, h], fill: null };
    if (fill) {
      tile.fill = fill[1]!;
      break;
    }
  }
  return tile;
}

function withViewBox(svg: string, box: [number, number, number, number]): string {
  return svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    const rest = attrs.replace(/\s(?:viewBox|width|height)="[^"]*"/g, "");
    return `<svg${rest} viewBox="${box.join(" ")}">`;
  });
}

/** Renders every PWA icon from herdr-app's SVG. Throws if the SVG cannot be rendered; never returns a partial set. */
export async function renderIcons(svgBytes: Buffer): Promise<Map<string, Buffer>> {
  await wasm();
  const svg = svgBytes.toString("utf8");
  const vb = /\sviewBox="\s*(-?[0-9.]+)[\s,]+(-?[0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*"/.exec(svg.match(/<svg\b[^>]*>/)?.[0] ?? "");
  if (!vb) throw new Error("the icon has no viewBox");
  const canvas = [Number(vb[1]), Number(vb[2]), Number(vb[3]), Number(vb[4])] as [number, number, number, number];
  const tile = tileOf(svg, canvas);
  const [x, y, w, h] = tile?.box ?? canvas;
  const out = new Map<string, Buffer>();
  for (const f of ICON_FILES) {
    // tile: the artwork cropped to its tile (transparent corners). flat: the same on its own colour, full bleed, for iOS.
    // maskable: the tile at 80% inside a full-bleed square, so a mask never cuts the art.
    const pad = f.kind === "maskable" ? 0.125 : 0;
    const box: [number, number, number, number] = [x - w * pad, y - h * pad, w * (1 + 2 * pad), h * (1 + 2 * pad)];
    const background = f.kind === "tile" ? undefined : (tile?.fill ?? "#101114");
    const r = new Resvg(withViewBox(svg, box), { fitTo: { mode: "width", value: f.size }, ...(background ? { background } : {}) });
    try {
      out.set(f.path, Buffer.from(r.render().asPng()));
    } finally {
      r.free();
    }
  }
  return out;
}

export interface IconChoice {
  files: Map<string, Buffer> | null;
  /** The one line to tell the operator. */
  line: string;
}

/** Finds (or takes `--icon`) and renders the herdr-app icon. Never throws: any failure keeps the neutral icons. */
export async function chooseIcons(o: { icon?: string | null | undefined; bin: string | null }): Promise<IconChoice> {
  const neutral = (why: string): IconChoice => ({ files: null, line: `Kept the neutral icons: ${why}.` });
  const path = o.icon ?? findIcon(o.bin);
  if (!path) return neutral(`no herdr-app icon found next to the herdr-app binary (pass --icon /abs/path/${ICON_NAME})`);
  try {
    if (statSync(path).size > SVG_LIMIT) throw new Error("it is larger than 1 MiB");
    const files = await renderIcons(readFileSync(path));
    return { files, line: `Used the herdr-app icon from ${path} for the app's icons. On an iPhone, remove and re-add the Home Screen app to see it.` };
  } catch (e) {
    return neutral(`could not render ${path} (${e instanceof Error ? e.message.split("\n")[0] : "error"})`);
  }
}
