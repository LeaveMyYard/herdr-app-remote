/* Home Screen app only. With the `black` status bar (index.html) iOS paints the status bar in the page's theme-color
   (checked in the iOS 26.5 Simulator; it follows a runtime change of the meta). Most screens are --t-chrome, the same
   as theme-color, but the question screen is --t-popover: keep theme-color equal to the app frame's background so the
   status bar never shows as a darker band above it. A Safari tab keeps the fixed theme-color. */

/** `rgb(r, g, b)` as `#rrggbb`, or null for anything else (transparent, translucent, unparsed). */
export function hexOf(rgb: string): string | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d*\.?\d+))?\)$/.exec(rgb.trim());
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return null;
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
}

/** The frame's background as `#rrggbb` (the form iOS takes for theme-color), or null when it is missing or not opaque. */
export function frameColour(doc: Document): string | null {
  const frame = doc.querySelector(".ph");
  return frame ? hexOf(getComputedStyle(frame).backgroundColor) : null;
}

/** Keeps `<meta name="theme-color">` in step with the frame. Returns the cleanup. */
export function installStatusBarTint(win: Window = window, doc: Document = document): () => void {
  if ((win.navigator as unknown as { standalone?: boolean }).standalone !== true) return () => undefined;
  const meta = doc.querySelector('meta[name="theme-color"]');
  const root = doc.getElementById("root");
  if (!meta || !root) return () => undefined;
  const initial = meta.getAttribute("content");
  let frame = 0;
  const update = () => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      const colour = frameColour(doc) ?? initial;
      if (colour && meta.getAttribute("content") !== colour) meta.setAttribute("content", colour);
    });
  };
  // Routes are hash routes; a route renders a new frame (or changes its class) under #root.
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, attributes: true, attributeFilter: ["class"], subtree: false });
  const watchFrame = () => {
    const f = root.firstElementChild;
    if (f) observer.observe(f, { attributes: true, attributeFilter: ["class"] });
  };
  const onRoot = new MutationObserver(watchFrame);
  onRoot.observe(root, { childList: true });
  watchFrame();
  win.addEventListener("hashchange", update);
  update();
  return () => {
    win.cancelAnimationFrame(frame);
    observer.disconnect();
    onRoot.disconnect();
    win.removeEventListener("hashchange", update);
    if (initial !== null) meta.setAttribute("content", initial);
  };
}
