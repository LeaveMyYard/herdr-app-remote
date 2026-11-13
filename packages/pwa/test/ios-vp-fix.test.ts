import { afterEach, describe, expect, it } from "vitest";
import { detectDeficit, installIosVpFix, type VpInput } from "../src/ios-vp-fix";

// Measured on an iPhone, iOS 26.6.1, standalone.
const device: VpInput = { standalone: true, screenWidth: 430, screenHeight: 932, viewportHeight: 873, insetTop: 59 };

describe("detectDeficit", () => {
  it("applies the measured iOS 26 standalone numbers", () => expect(detectDeficit(device)).toBe(59));
  it("tolerates 2 px of difference", () => {
    expect(detectDeficit({ ...device, viewportHeight: 871 })).toBe(61);
    expect(detectDeficit({ ...device, viewportHeight: 870 })).toBe(0);
  });
  it("does not apply in a Safari tab", () => expect(detectDeficit({ ...device, standalone: false })).toBe(0));
  it("does not apply when the viewport already fills the screen", () => expect(detectDeficit({ ...device, viewportHeight: 932 })).toBe(0));
  it("does not apply in landscape", () =>
    expect(detectDeficit({ standalone: true, screenWidth: 932, screenHeight: 430, viewportHeight: 371, insetTop: 59 })).toBe(0));
  it("does not apply with the keyboard open", () => expect(detectDeficit({ ...device, viewportHeight: 520 })).toBe(0));
  it("does not apply without a top inset", () => expect(detectDeficit({ ...device, insetTop: 0 })).toBe(0));
});

describe("installIosVpFix", () => {
  let cleanup: () => void = () => undefined;
  afterEach(() => cleanup());
  const fakeWin = (standalone: boolean) =>
    ({
      navigator: { standalone },
      screen: { width: 430, height: 932 },
      innerWidth: 430,
      innerHeight: 873,
      visualViewport: { height: 873, addEventListener() {}, removeEventListener() {} },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as Window;

  it("sets --ios-vp-fix to 0px when the fix does not apply", () => {
    cleanup = installIosVpFix(fakeWin(false), document);
    expect(document.documentElement.style.getPropertyValue("--ios-vp-fix")).toBe("0px");
  });
  it("sets 0px when there is no safe-area inset (jsdom)", () => {
    cleanup = installIosVpFix(fakeWin(true), document);
    expect(document.documentElement.style.getPropertyValue("--ios-vp-fix")).toBe("0px");
  });
});
