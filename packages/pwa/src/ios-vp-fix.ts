/* iOS 26 standalone (Home Screen) PWA workaround, for apps added to the Home Screen while index.html asked for the
   `black-translucent` status bar (iOS keeps the style it saw when the app was added; index.html now asks for `black`,
   which does not have the bug). Measured on an iPhone, iOS 26.6.1, and reproduced in the iOS 26.5 Simulator: screen
   430x932, innerHeight/visualViewport 873, inset-top 59, inset-bottom 34. The layout viewport starts at the screen top
   but is 59 pt short, and iOS paints nothing below it: content laid out there is not drawn and cannot be tapped (the
   Agents tab bar lost its labels, the chat composer was cut in half). So nothing may extend past the window; instead the
   bottom inset shrinks by the deficit (--ios-vp-deficit, used by --sab in app.css), since the short viewport already
   ends above the home indicator. screen.height - innerHeight equals inset-top; we detect exactly that.
   app.css now gives such apps the whole screen (an html min-height of the window plus inset-top, WebKit bug 301108),
   so the deficit is normally 0; this stays as the fallback should iOS not honour that rule. */

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

/** The px the layout viewport is short of the screen, or 0 when this is not the iOS 26 bug. */
export function detectDeficit(i: VpInput): number {
  if (!i.standalone) return 0; // a normal Safari tab
  // Landscape (iOS keeps screen.width/height portrait when rotated, so look at the layout viewport too).
  if (i.screenHeight < i.screenWidth || i.viewportWidth > i.viewportHeight) return 0;
  const deficit = i.screenHeight - i.viewportHeight;
  // A shrunken viewport (not the bug) never equals inset-top. With the `black` status bar the web view starts below
  // the status bar: the viewport is also screen.height - 59 tall there, but inset-top is 0, so this stays 0.
  if (!(deficit > 0) || !(i.insetTop > 0)) return 0;
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

/** Keeps --ios-vp-deficit on the root in step with the window. Returns the cleanup. `readInset` is injectable for tests. */
export function installIosVpFix(win: Window = window, doc: Document = document, readInset = insetTop): () => void {
  const root = doc.documentElement;
  const update = () => root.style.setProperty("--ios-vp-deficit", `${detectDeficit(read(win, doc, readInset))}px`);
  update();
  win.addEventListener("resize", update);
  win.addEventListener("orientationchange", update);
  win.visualViewport?.addEventListener("resize", update);
  return () => {
    win.removeEventListener("resize", update);
    win.removeEventListener("orientationchange", update);
    win.visualViewport?.removeEventListener("resize", update);
    root.style.removeProperty("--ios-vp-deficit");
  };
}
