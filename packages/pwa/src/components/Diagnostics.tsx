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

/** What is painted at (x, y), ignoring this overlay: the first element under the point that is not inside it. */
function hitRow(label: string, x: number, y: number): Row {
  const key = `hit ${label} (x ${n(x)} y ${n(y)})`;
  if (typeof document.elementsFromPoint !== "function") return [key, "n/a"];
  const at = document.elementsFromPoint(x, y).find((e) => !e.closest(".diag"));
  return [key, at ? `${at.tagName.toLowerCase()}.${String(at.className).slice(0, 30)}` : "nothing (outside the layout viewport)"];
}

/** The chat screens' own boxes (empty elsewhere): where the footer and composer sit against the frame and the window, what is hit there, and whether the page has been scrolled. */
function chatRows(): Row[] {
  const foot = document.querySelector(".chat-foot");
  if (!foot) return [];
  const q = (s: string) => document.querySelector(s);
  const form = q(".chat-form")?.getBoundingClientRect();
  const send = q(".chat-send")?.getBoundingClientRect();
  const ph = q(".ph")?.getBoundingClientRect();
  const h = window.innerHeight;
  const x = window.innerWidth / 2;
  const probes: Row[] = [
    ...(form ? [hitRow("composer top", x, form.top + 1), hitRow("composer middle", x, form.top + form.height / 2), hitRow("composer bottom", x, form.bottom - 1)] : []),
    ...(send ? [hitRow("send centre", send.left + send.width / 2, send.top + send.height / 2)] : []),
    hitRow("just above innerHeight", x, h - 1),
    ...(ph && ph.bottom > h ? [hitRow("between innerHeight and .ph bottom", x, (h + ph.bottom) / 2)] : []),
  ];
  return [
    rect(".ph > :last-child", q(".ph")?.lastElementChild ?? null),
    rect(".chat-main / .cv-main", q(".cv-main") ?? q(".chat-main")),
    rect(".chat-foot", foot),
    rect(".chat-form", q(".chat-form")),
    rect(".chat-text", q(".chat-text")),
    rect(".chat-send", q(".chat-send")),
    [".ph top", ph ? n(ph.top) : "not found"],
    ["window.scrollY", n(window.scrollY)],
    ["scrollingElement.scrollTop", n(document.scrollingElement?.scrollTop)],
    ["html.scrollTop", n(document.documentElement.scrollTop)],
    ["body.scrollTop", n(document.body.scrollTop)],
    ...probes,
  ];
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
    ["--ios-vp-fix", document.documentElement.style.getPropertyValue("--ios-vp-fix") || "unset"] as Row,
    ["ios-vp-fix state", document.documentElement.dataset.iosVpFix ?? "active or not detected"],
    rect(".ph", q(".ph")),
    rect(".app-header", q(".app-header")),
    rect(".screen", q(".screen")),
    rect(".tabbar", tabbar),
    [".tabbar padding-bottom", tabbar ? getComputedStyle(tabbar).paddingBottom : "not found"],
    ...chatRows(),
    ["userAgent", navigator.userAgent],
  ];
}

export function DiagnosticsOverlay({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>(collect);
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
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
    if (!navigator.clipboard) return setCopied("failed");
    navigator.clipboard.writeText(text).then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };
  return (
    <div className="diag" role="dialog" aria-label="Diagnostics">
      <div className="diag-bar">
        <button type="button" onClick={copy}>
          {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
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
