import { encode } from "uqr";

/** The QR module matrix for `text` (true = dark), including a 4-module quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "M", border: 4 }).data;
}

/**
 * A static SVG of the QR code: one path, no script, no external references. `text` is
 * only encoded into modules, never written into the markup.
 */
export function qrSvg(text: string): string {
  const m = qrMatrix(text);
  const n = m.length;
  let d = "";
  for (let y = 0; y < n; y++) {
    const row = m[y]!;
    let x = 0;
    while (x < n) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`
  );
}
