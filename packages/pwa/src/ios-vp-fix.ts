/* iOS 26 standalone (Home Screen) PWA workaround. Measured on an iPhone, iOS 26.6.1: screen 430x932, innerHeight 873,
   visualViewport 873, inset-top 59, inset-bottom 34. The layout viewport starts at the screen top but is 59 pt short,
   so the bottom 59 pt of the screen is outside it (an empty band under the tab bar). screen.height - innerHeight equals
   inset-top. We detect exactly that and extend the app frame by the deficit (--ios-vp-fix, used by .ph in app.css). */

export interface VpInput {
  standalone: boolean;
  screenWidth: number;
  screenHeight: number;
  /** visualViewport.height, else innerHeight. */
  viewportHeight: number;
  insetTop: number;
}

const TOLERANCE = 2;

/** The px to extend the frame by, or 0 when the workaround must not apply. */
export function detectDeficit(i: VpInput): number {
  if (!i.standalone) return 0; // a normal Safari tab
  if (i.screenHeight < i.screenWidth) return 0; // landscape
  const deficit = i.screenHeight - i.viewportHeight;
  if (!(deficit > 0) || !(i.insetTop > 0)) return 0; // keyboard open shrinks it by far more than inset-top
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

function read(win: Window, doc: Document): VpInput {
  const standaloneMq = typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches;
  return {
    standalone: (win.navigator as unknown as { standalone?: boolean }).standalone === true || standaloneMq,
    screenWidth: win.screen.width,
    screenHeight: win.screen.height,
    viewportHeight: win.visualViewport?.height ?? win.innerHeight,
    insetTop: insetTop(doc),
  };
}

/** After applying, the tab bar must still be reachable at the screen bottom; false means painting is clipped. */
function tabbarReachable(win: Window, doc: Document): boolean {
  const bar = doc.querySelector(".tabbar");
  if (!bar || typeof doc.elementFromPoint !== "function") return true; // nothing to check against
  const r = bar.getBoundingClientRect();
  if (r.height === 0) return true;
  const hit = doc.elementFromPoint(Math.min(win.innerWidth - 1, r.x + r.width / 2), r.y + r.height / 2);
  return hit !== null && bar.contains(hit);
}

/** Keeps --ios-vp-fix on the root in step with the window. Returns the cleanup. */
export function installIosVpFix(win: Window = window, doc: Document = document): () => void {
  const set = (px: number) => doc.documentElement.style.setProperty("--ios-vp-fix", `${px}px`);
  const update = () => {
    const px = detectDeficit(read(win, doc));
    set(px);
    // The variable only takes effect after layout; check the tab bar then, and drop the fix if it is not hit.
    if (px > 0) {
      win.requestAnimationFrame?.(() => {
        if (!tabbarReachable(win, doc)) set(0);
      });
    }
  };
  update();
  win.addEventListener("resize", update);
  win.addEventListener("orientationchange", update);
  win.visualViewport?.addEventListener("resize", update);
  return () => {
    win.removeEventListener("resize", update);
    win.removeEventListener("orientationchange", update);
    win.visualViewport?.removeEventListener("resize", update);
    doc.documentElement.style.removeProperty("--ios-vp-fix");
  };
}
