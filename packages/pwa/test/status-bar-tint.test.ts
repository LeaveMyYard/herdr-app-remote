import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frameColour, hexOf, installStatusBarTint } from "../src/status-bar-tint";

// The black status bar takes theme-color; the question screen's frame is --t-popover (fake values here).
const meta = () => document.querySelector('meta[name="theme-color"]')!;
const win = (standalone: boolean) => {
  const w = Object.create(window) as Window;
  Object.defineProperty(w, "navigator", { value: { standalone } });
  Object.defineProperty(w, "requestAnimationFrame", { value: (f: FrameRequestCallback) => (f(0), 1) });
  Object.defineProperty(w, "cancelAnimationFrame", { value: () => undefined });
  return w;
};

describe("hexOf", () => {
  // iOS ignores an rgb() theme-color (iOS 26.5 Simulator), so the meta always gets #rrggbb.
  it("turns an opaque computed colour into #rrggbb", () => {
    expect(hexOf("rgb(28, 29, 32)")).toBe("#1c1d20");
    expect(hexOf("rgba(16, 17, 20, 1)")).toBe("#101114");
  });
  it("refuses transparent, translucent and anything unparsed", () => {
    for (const v of ["rgba(0, 0, 0, 0)", "rgba(16, 17, 20, 0.5)", "transparent", "", "color(srgb 0 0 0)"]) expect(hexOf(v), v).toBeNull();
  });
});

describe("installStatusBarTint", () => {
  let cleanup: () => void = () => undefined;
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#101114" />';
    document.body.innerHTML = '<div id="root"><div class="hd ph" style="background-color: rgb(16, 17, 20)"></div></div>';
  });
  afterEach(() => {
    cleanup();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("follows the frame's background in the Home Screen app", async () => {
    cleanup = installStatusBarTint(win(true), document);
    expect(meta().getAttribute("content")).toBe("#101114");
    // A route renders the question frame (a new child of #root).
    document.getElementById("root")!.innerHTML = '<div class="hd ph qn" style="background-color: rgb(28, 29, 32)"></div>';
    await Promise.resolve();
    expect(meta().getAttribute("content")).toBe("#1c1d20");
  });

  it("follows a class change on the same frame", async () => {
    cleanup = installStatusBarTint(win(true), document);
    const frame = document.querySelector<HTMLElement>(".ph")!;
    frame.style.backgroundColor = "rgb(28, 29, 32)";
    frame.className = "hd ph qn";
    await Promise.resolve();
    expect(meta().getAttribute("content")).toBe("#1c1d20");
  });

  it("leaves theme-color alone in a Safari tab", () => {
    document.querySelector<HTMLElement>(".ph")!.style.backgroundColor = "rgb(28, 29, 32)";
    cleanup = installStatusBarTint(win(false), document);
    expect(meta().getAttribute("content")).toBe("#101114");
  });

  it("falls back to the original colour without an opaque frame, and cleanup restores it", () => {
    document.getElementById("root")!.innerHTML = '<div class="hd ph" style="background-color: rgba(0, 0, 0, 0)"></div>';
    expect(frameColour(document)).toBeNull();
    cleanup = installStatusBarTint(win(true), document);
    expect(meta().getAttribute("content")).toBe("#101114");
    document.getElementById("root")!.innerHTML = '<div class="hd ph" style="background-color: rgb(28, 29, 32)"></div>';
    cleanup();
    cleanup = () => undefined;
    expect(meta().getAttribute("content")).toBe("#101114");
  });
});
