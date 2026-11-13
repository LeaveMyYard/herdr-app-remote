import { afterEach, describe, expect, it, vi } from "vitest";
import { detectDeficit, installIosVpFix, type VpInput } from "../src/ios-vp-fix";

// Measured on an iPhone, iOS 26.6.1, standalone.
const device: VpInput = { standalone: true, screenWidth: 430, screenHeight: 932, viewportWidth: 430, viewportHeight: 873, insetTop: 59 };

describe("detectDeficit", () => {
  it("applies the measured iOS 26 standalone numbers", () => expect(detectDeficit(device)).toBe(59));
  it("tolerates 2 px of difference", () => {
    expect(detectDeficit({ ...device, viewportHeight: 871 })).toBe(61);
    expect(detectDeficit({ ...device, viewportHeight: 870 })).toBe(0);
  });
  it("does not apply in a Safari tab", () => expect(detectDeficit({ ...device, standalone: false })).toBe(0));
  it("does not apply when the viewport already fills the screen", () => expect(detectDeficit({ ...device, viewportHeight: 932 })).toBe(0));
  it("does not apply in landscape (iOS keeps screen portrait)", () =>
    expect(detectDeficit({ ...device, viewportWidth: 932, viewportHeight: 371, insetTop: 0 })).toBe(0));
  it("does not apply with a shrunken viewport (keyboard)", () => expect(detectDeficit({ ...device, viewportHeight: 520 })).toBe(0));
  it("does not apply without a top inset", () => expect(detectDeficit({ ...device, insetTop: 0 })).toBe(0));
});

describe("installIosVpFix", () => {
  let cleanup: () => void = () => undefined;
  const fix = () => document.documentElement.style.getPropertyValue("--ios-vp-fix");
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  const listeners = new Map<string, () => void>();
  const fakeWin = (standalone: boolean, innerHeight = 873) => {
    listeners.clear();
    return {
      navigator: { standalone },
      screen: { width: 430, height: 932 },
      innerWidth: 430,
      innerHeight,
      visualViewport: null,
      addEventListener: (t: string, f: () => void) => void listeners.set(t, f),
      removeEventListener: (t: string) => void listeners.delete(t),
      requestAnimationFrame: (f: () => void) => (f(), 1),
      cancelAnimationFrame: () => undefined,
    } as unknown as Window;
  };

  it("is 0px when the fix does not apply (Safari tab)", () => {
    cleanup = installIosVpFix(fakeWin(false), document, () => 59);
    expect(fix()).toBe("0px");
  });
  it("is 0px with no safe-area inset (jsdom default)", () => {
    cleanup = installIosVpFix(fakeWin(true), document);
    expect(fix()).toBe("0px");
  });
  it("sets 59px on the measured device and follows a resize", () => {
    const win = fakeWin(true);
    cleanup = installIosVpFix(win, document, () => 59);
    expect(fix()).toBe("59px");
    (win as { innerHeight: number }).innerHeight = 932;
    listeners.get("resize")!();
    expect(fix()).toBe("0px");
  });
  it("drops the fix, and keeps it dropped, when the tab bar cannot be hit", () => {
    document.body.innerHTML = '<div class="tabbar"></div>';
    const bar = document.querySelector(".tabbar")!;
    bar.getBoundingClientRect = () => ({ x: 0, y: 850, width: 430, height: 83 }) as DOMRect;
    document.elementFromPoint = () => null;
    cleanup = installIosVpFix(fakeWin(true), document, () => 59);
    expect(fix()).toBe("0px");
    expect(document.documentElement.dataset.iosVpFix).toBe("dropped: tab bar not hit");
    listeners.get("resize")!();
    expect(fix()).toBe("0px");
  });
  it("keeps the fix when the tab bar is hit, and cleanup removes it", () => {
    document.body.innerHTML = '<div class="tabbar"></div>';
    const bar = document.querySelector(".tabbar")!;
    bar.getBoundingClientRect = () => ({ x: 0, y: 850, width: 430, height: 83 }) as DOMRect;
    document.elementFromPoint = () => bar;
    cleanup = installIosVpFix(fakeWin(true), document, () => 59);
    expect(fix()).toBe("59px");
    cleanup();
    expect(fix()).toBe("");
    expect(listeners.size).toBe(0);
  });
});
