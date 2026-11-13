/* iOS 26 standalone (Home Screen) PWA workaround. Measured on an iPhone, iOS 26.6.1: screen 430x932, innerHeight 873,
   visualViewport 873, inset-top 59, inset-bottom 34. The layout viewport starts at the screen top but is 59 pt short,
   so the bottom 59 pt of the screen is outside it (an empty band under the tab bar). screen.height - innerHeight equals
   inset-top. We detect exactly that and extend the app frame by the deficit (--ios-vp-fix, used by .ph in app.css). */

export interface VpInput {
  standalone: boolean;
  screenWidth: number;
  screenHeight: number;
  /** innerWidth / innerHeight: the layout viewport, which the keyboard does not resize on iOS. */
  viewportWidth: number;
  viewportHeight: number;
  insetTop: number;
}

const TOLERANCE = 2;

/** The px to extend the frame by, or 0 when the workaround must not apply. */
export function detectDeficit(i: VpInput): number {
  if (!i.standalone) return 0; // a normal Safari tab
  // Landscape (iOS keeps screen.width/height portrait when rotated, so look at the layout viewport too).
  if (i.screenHeight < i.screenWidth || i.viewportWidth > i.viewportHeight) return 0;
  const deficit = i.screenHeight - i.viewportHeight;
  if (!(deficit > 0) || !(i.insetTop > 0)) return 0; // a shrunken viewport (not the bug) never equals inset-top
  return Math.abs(deficit - i.insetTop) <= TOLERANCE ? Math.round(deficit) : 0;
}

function insetTop(doc: Document): number {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;width:0;height:0;padding-top:env(safe-area-inset-top)";
  doc.body.appendChild(probe);
  const v = parseFloat(getComputedStyle(probe).paddingTop);
  probe.remove();
  return Number.isFinite(v) ? v : 0;
}

function read(win: Window, doc: Document, readInset: (d: Document) => number): VpInput {
  return {
    // iOS only: navigator.standalone exists nowhere else, which keeps Android and desktop installs out.
    standalone: (win.navigator as unknown as { standalone?: boolean }).standalone === true,
    screenWidth: win.screen.width,
    screenHeight: win.screen.height,
    viewportWidth: win.innerWidth,
    viewportHeight: win.innerHeight,
    insetTop: readInset(doc),
  };
}

/** After applying, something must still be hit at the top edge of the frame's bottom bar (the tab bar, or on a full-screen route the frame's last child: chat footer, question footer); false means it is not laid out where it can be hit. */
function tabbarReachable(win: Window, doc: Document): boolean {
  const bar = doc.querySelector(".tabbar") ?? doc.querySelector(".ph > :last-child");
  if (!bar || typeof doc.elementFromPoint !== "function") return true; // nothing to check against
  const r = bar.getBoundingClientRect();
  if (r.height === 0) return true;
  // elementFromPoint is null outside the layout viewport, so test the bar's top edge, which stays inside it.
  const hit = doc.elementFromPoint(
    Math.min(win.innerWidth - 1, r.x + r.width / 2),
    Math.max(0, Math.min(r.y + 1, win.innerHeight - 1)),
  );
  // Only null (nothing painted there) counts as failure; another layer on top (key sheet, diagnostics) is inconclusive.
  return hit !== null;
}

/** Keeps --ios-vp-fix on the root in step with the window. Returns the cleanup. `readInset` is injectable for tests. */
export function installIosVpFix(win: Window = window, doc: Document = document, readInset = insetTop): () => void {
  const root = doc.documentElement;
  let disposed = false;
  let frame = 0;
  let droppedFor = ""; // inputs for which the tab bar check failed: stay off until they change
  const set = (px: number, note = "") => {
    root.style.setProperty("--ios-vp-fix", `${px}px`);
    if (note) root.dataset.iosVpFix = note;
    else delete root.dataset.iosVpFix;
  };
  const update = () => {
    const input = read(win, doc, readInset);
    const key = JSON.stringify(input);
    const px = detectDeficit(input);
    if (px > 0 && key === droppedFor) return set(0, "dropped: tab bar not hit");
    set(px);
    if (px > 0 && typeof win.requestAnimationFrame === "function") {
      win.cancelAnimationFrame?.(frame);
      frame = win.requestAnimationFrame(() => {
        if (disposed || tabbarReachable(win, doc)) return;
        droppedFor = key;
        set(0, "dropped: tab bar not hit");
      });
    }
  };
  update();
  win.addEventListener("resize", update);
  win.addEventListener("orientationchange", update);
  win.visualViewport?.addEventListener("resize", update);
  return () => {
    disposed = true;
    win.cancelAnimationFrame?.(frame);
    win.removeEventListener("resize", update);
    win.removeEventListener("orientationchange", update);
    win.visualViewport?.removeEventListener("resize", update);
    root.style.removeProperty("--ios-vp-fix");
    delete root.dataset.iosVpFix;
  };
}
