import { useCallback, useEffect, useRef, useState } from "react";

/* Hidden, read-only viewport diagnostics (tap the header title 5 times within 3 s). Numbers only: it reads the
   window and the DOM, and loads or sends nothing. */

const TAPS = 5;
const WINDOW_MS = 3000;

/** Counts taps and fires once TAPS land within WINDOW_MS. */
export function useTapGesture(onOpen: () => void) {
  const taps = useRef<number[]>([]);
  return useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < WINDOW_MS), now];
    if (taps.current.length >= TAPS) {
      taps.current = [];
      onOpen();
    }
  }, [onOpen]);
}

type Row = readonly [label: string, value: string];

const n = (v: number | undefined) => (v === undefined ? "n/a" : String(Math.round(v * 100) / 100));

function rect(label: string, el: Element | null): Row {
  if (!el) return [label, "not found"];
  const r = el.getBoundingClientRect();
  return [label, `x ${n(r.x)} y ${n(r.y)} w ${n(r.width)} h ${n(r.height)} bottom ${n(r.bottom)}`];
}

function insets(): Row[] {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;width:0;height:0;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const rows: Row[] = [
    ["inset top", cs.paddingTop],
    ["inset right", cs.paddingRight],
    ["inset bottom", cs.paddingBottom],
    ["inset left", cs.paddingLeft],
  ];
  probe.remove();
  return rows;
}

export function collect(): Row[] {
  const q = (s: string) => document.querySelector(s);
  const vv = window.visualViewport;
  const standaloneMq = typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)").matches : "n/a";
  const tabbar = q(".tabbar");
  return [
    ["navigator.standalone", String((navigator as unknown as { standalone?: boolean }).standalone)],
    ["display-mode: standalone", String(standaloneMq)],
    ["screen", `${screen.width} x ${screen.height}`],
    ["devicePixelRatio", String(window.devicePixelRatio)],
    ["innerWidth x innerHeight", `${window.innerWidth} x ${window.innerHeight}`],
    ["outerHeight", String(window.outerHeight)],
    ["documentElement.clientHeight", String(document.documentElement.clientHeight)],
    ["visualViewport width", n(vv?.width)],
    ["visualViewport height", n(vv?.height)],
    ["visualViewport offsetTop", n(vv?.offsetTop)],
    ["visualViewport pageTop", n(vv?.pageTop)],
    ...insets(),
    rect("html", document.documentElement),
    rect("body", document.body),
    rect("#root", q("#root")),
    rect(".ph", q(".ph")),
    rect(".app-header", q(".app-header")),
    rect(".screen", q(".screen")),
    rect(".tabbar", tabbar),
    [".tabbar padding-bottom", tabbar ? getComputedStyle(tabbar).paddingBottom : "not found"],
    ["userAgent", navigator.userAgent],
  ];
}

export function DiagnosticsOverlay({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(collect);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const update = () => setRows(collect());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className="diag" role="dialog" aria-label="Diagnostics">
      <div className="diag-bar">
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="diag-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
