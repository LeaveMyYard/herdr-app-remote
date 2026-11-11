import type { CSSProperties } from "react";
import type { bridgeApi } from "@herdr-remote/protocol";

type Span = bridgeApi.ChatSpan;

/** A protocol colour (palette index 0-15, or `#rrggbb`) as a CSS value. Anything else is dropped, never passed through. */
function css(c: bridgeApi.ChatColor | undefined): string | undefined {
  if (typeof c === "number") return Number.isInteger(c) && c >= 0 && c <= 15 ? `var(--ans-${c})` : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/.test(c) ? c : undefined;
}

/** Style for one span. Reverse video swaps the colours, falling back to the terminal's own. */
export function spanStyle(s: Span): CSSProperties | undefined {
  let fg = css(s.fg);
  let bg = css(s.bg);
  if (s.r) [fg, bg] = [bg ?? "var(--t-background)", fg ?? "var(--t-foreground)"];
  const style: CSSProperties = {};
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;
  if (s.b) style.fontWeight = 600;
  if (s.i) style.fontStyle = "italic";
  if (s.u) style.textDecoration = "underline";
  if (s.d) style.opacity = 0.6;
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * Terminal text. Every span is a React text child, so the browser never parses it as markup,
 * whatever the terminal printed; styles come only from the validated protocol fields.
 */
export function AnsiText({ lines }: { lines: bridgeApi.ChatLine[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <div className="cl" key={i}>
          {line.map((s, j) => {
            const style = spanStyle(s);
            return style ? (
              <span key={j} style={style}>
                {s.t}
              </span>
            ) : (
              s.t
            );
          })}
        </div>
      ))}
    </>
  );
}
