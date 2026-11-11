import type { bridgeApi } from "@herdr-remote/protocol";

type Span = bridgeApi.ChatSpan;
type Color = bridgeApi.ChatColor;

interface Style {
  fg?: Color;
  bg?: Color;
  b?: true;
  d?: true;
  i?: true;
  u?: true;
  r?: true;
}

const hex = (n: number): string => n.toString(16).padStart(2, "0");
const CUBE = [0, 95, 135, 175, 215, 255];

/** An xterm 256-colour index: 0-15 stay theme palette indexes, the rest become `#rrggbb`. */
function indexed(n: number): Color | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const c = n - 16;
  return `#${hex(CUBE[Math.floor(c / 36)]!)}${hex(CUBE[Math.floor(c / 6) % 6]!)}${hex(CUBE[c % 6]!)}`;
}

function rgb(r: number, g: number, b: number): Color | undefined {
  return [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? `#${hex(r)}${hex(g)}${hex(b)}` : undefined;
}

/** Applies one SGR parameter list to `st`. Unknown codes are ignored. */
function sgr(st: Style, params: number[]): void {
  if (params.length === 0) params = [0];
  for (let k = 0; k < params.length; k++) {
    const p = params[k]!;
    if (p === 0) {
      delete st.fg;
      delete st.bg;
      delete st.b;
      delete st.d;
      delete st.i;
      delete st.u;
      delete st.r;
    } else if (p === 1) st.b = true;
    else if (p === 2) st.d = true;
    else if (p === 3) st.i = true;
    else if (p === 4) st.u = true;
    else if (p === 7) st.r = true;
    else if (p === 22) {
      delete st.b;
      delete st.d;
    } else if (p === 23) delete st.i;
    else if (p === 24) delete st.u;
    else if (p === 27) delete st.r;
    else if (p >= 30 && p <= 37) st.fg = p - 30;
    else if (p >= 90 && p <= 97) st.fg = p - 90 + 8;
    else if (p >= 40 && p <= 47) st.bg = p - 40;
    else if (p >= 100 && p <= 107) st.bg = p - 100 + 8;
    else if (p === 39) delete st.fg;
    else if (p === 49) delete st.bg;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      const mode = params[k + 1];
      let color: Color | undefined;
      if (mode === 5) {
        color = indexed(params[k + 2] ?? -1);
        k += 2;
      } else if (mode === 2) {
        color = rgb(params[k + 2] ?? -1, params[k + 3] ?? -1, params[k + 4] ?? -1);
        k += 4;
      } else k = params.length;
      if (color !== undefined) st[key] = color;
    }
  }
}

export interface ParsedAnsi {
  lines: Span[][];
  /** True when `maxLines` dropped older lines. */
  truncated: boolean;
}

export interface ParseOptions {
  /** Keep this many lines (the newest). Default 500. */
  maxLines?: number;
  /** Tab stops. Default 8. */
  tabWidth?: number;
}

const ESC = 0x1b;

/**
 * Turns `hc read` output (text with ANSI escapes) into lines of styled spans.
 *
 * It reads only SGR (colour and weight). Every other escape sequence (cursor moves, OSC titles and hyperlinks, DCS,
 * charset selects) and every other control character is dropped, so what comes out is printable text and a small
 * set of style flags: nothing a renderer could mistake for markup. Style carries from line to line, as in a terminal.
 */
export function parseAnsi(input: string, opts: ParseOptions = {}): ParsedAnsi {
  const maxLines = opts.maxLines ?? 500;
  const tab = opts.tabWidth ?? 8;
  const st: Style = {};
  const lines: Span[][] = [];
  let line: Span[] = [];
  let col = 0;

  const push = (text: string): void => {
    if (text === "") return;
    col += text.length;
    const last = line[line.length - 1];
    if (last && last.fg === st.fg && last.bg === st.bg && last.b === st.b && last.d === st.d && last.i === st.i && last.u === st.u && last.r === st.r) {
      last.t += text;
      return;
    }
    const span: Span = { t: text };
    if (st.fg !== undefined) span.fg = st.fg;
    if (st.bg !== undefined) span.bg = st.bg;
    if (st.b) span.b = true;
    if (st.d) span.d = true;
    if (st.i) span.i = true;
    if (st.u) span.u = true;
    if (st.r) span.r = true;
    line.push(span);
  };
  const endLine = (): void => {
    lines.push(line);
    line = [];
    col = 0;
  };

  let buf = "";
  const flush = (): void => {
    push(buf);
    buf = "";
  };

  const n = input.length;
  for (let i = 0; i < n; i++) {
    const code = input.charCodeAt(i);
    if (code === ESC) {
      const next = input[i + 1];
      if (next === "[") {
        // CSI: parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, one final byte 0x40-0x7e.
        let j = i + 2;
        while (j < n && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j++;
        const params = input.slice(i + 2, j);
        while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        const final = input[j];
        if (final === undefined) break;
        if (final === "m" && /^[0-9;:]*$/.test(params)) {
          flush();
          sgr(st, params === "" ? [] : params.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x))));
        }
        i = j;
      } else if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        // OSC, DCS, SOS, PM, APC: skip to BEL or ST (ESC \).
        let j = i + 2;
        while (j < n && input.charCodeAt(j) !== 0x07 && !(input.charCodeAt(j) === ESC && input[j + 1] === "\\")) j++;
        i = input.charCodeAt(j) === ESC ? j + 1 : j;
      } else if (next !== undefined && next >= " " && next <= "/") {
        // ESC + intermediates + final (charset selects, `ESC ( B`).
        let j = i + 1;
        while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        i = j;
      } else {
        i += 1;
      }
      continue;
    }
    if (code === 0x0a) {
      flush();
      endLine();
    } else if (code === 0x09) {
      const width = tab - ((col + buf.length) % tab);
      buf += " ".repeat(width);
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      // \r, BEL, BS, C1 controls and the rest: dropped.
    } else {
      buf += input[i];
    }
  }
  flush();
  if (line.length > 0) endLine();
  // `hc read` ends with a newline; drop trailing blank lines so the view ends at the last text.
  while (lines.length > 0 && lines[lines.length - 1]!.every((s) => s.t.trim() === "")) lines.pop();
  const truncated = lines.length > maxLines;
  return { lines: truncated ? lines.slice(lines.length - maxLines) : lines, truncated };
}
