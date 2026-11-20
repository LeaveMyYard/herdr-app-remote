import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installIosKeyboard, keyboardFrame, revealFocused, type KbInput } from "../src/ios-keyboard";

// Measured in the iOS 26.5 Simulator (430x932, black status bar), keyboard open on the chat composer.
const open: KbInput = { standalone: true, editing: true, layoutHeight: 873, vvHeight: 460, vvTop: 413, vvScale: 1 };

describe("keyboardFrame", () => {
  it("is the visible area above the keyboard", () => expect(keyboardFrame(open)).toEqual({ top: 413, height: 460 }));
  it("is the old translucent install's numbers too", () => expect(keyboardFrame({ ...open, vvHeight: 519, vvTop: 354 })).toEqual({ top: 354, height: 519 }));
  it("does nothing in a Safari tab", () => expect(keyboardFrame({ ...open, standalone: false })).toBeNull());
  it("does nothing without a focused field", () => expect(keyboardFrame({ ...open, editing: false })).toBeNull());
  it("does nothing while pinch-zoomed", () => expect(keyboardFrame({ ...open, vvScale: 1.5 })).toBeNull());
  it("does nothing when the view is barely smaller (not a keyboard)", () => expect(keyboardFrame({ ...open, vvHeight: 820, vvTop: 0 })).toBeNull());
});

describe("installIosKeyboard", () => {
  let cleanup: () => void = () => undefined;
  const root = document.documentElement;
  const listeners = new Map<string, () => void>();
  const vv = { height: 873, offsetTop: 0, scale: 1, addEventListener: (t: string, f: () => void) => void listeners.set(`vv.${t}`, f), removeEventListener: (t: string) => void listeners.delete(`vv.${t}`) };
  const win = (standalone: boolean) => {
    const w = Object.create(window) as Window;
    Object.defineProperty(w, "navigator", { value: { standalone } });
    Object.defineProperty(w, "visualViewport", { value: vv });
    Object.defineProperty(w, "requestAnimationFrame", { value: (f: FrameRequestCallback) => (f(0), 1) });
    Object.defineProperty(w, "cancelAnimationFrame", { value: () => undefined });
    return w;
  };
  beforeEach(() => {
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 873 });
    document.body.innerHTML = '<div class="ph"><textarea id="t"></textarea></div>';
    Object.assign(vv, { height: 873, offsetTop: 0 });
  });
  afterEach(() => {
    cleanup();
    cleanup = () => undefined;
    document.body.innerHTML = "";
  });

  it("pins the frame while the keyboard is open and lets go when it closes", () => {
    cleanup = installIosKeyboard(win(true), document);
    expect("kb" in root.dataset).toBe(false);
    document.getElementById("t")!.focus();
    Object.assign(vv, { height: 460, offsetTop: 413 });
    listeners.get("vv.resize")!();
    expect("kb" in root.dataset).toBe(true);
    expect(root.style.getPropertyValue("--kb-top")).toBe("413px");
    expect(root.style.getPropertyValue("--kb-h")).toBe("460px");
    (document.activeElement as HTMLElement).blur();
    Object.assign(vv, { height: 873, offsetTop: 0 });
    listeners.get("vv.resize")!();
    expect("kb" in root.dataset).toBe(false);
    expect(root.style.getPropertyValue("--kb-top")).toBe("");
  });

  it("does nothing in a Safari tab, and cleanup removes every listener", () => {
    cleanup = installIosKeyboard(win(false), document);
    expect(listeners.size).toBe(0);
    cleanup = installIosKeyboard(win(true), document);
    expect(listeners.size).toBe(2);
    cleanup();
    cleanup = () => undefined;
    expect(listeners.size).toBe(0);
  });
});

describe("revealFocused", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 430, width: 430, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  it("scrolls the field's list so the field shows above the frame's bottom", () => {
    document.body.innerHTML = '<div class="ph"><main id="list" style="overflow-y:auto"><input id="note" /></main></div>';
    const list = document.getElementById("list")!;
    Object.defineProperty(list, "scrollHeight", { value: 900 });
    Object.defineProperty(list, "clientHeight", { value: 300 });
    list.getBoundingClientRect = () => rect(60, 300); // 60..360
    document.getElementById("note")!.getBoundingClientRect = () => rect(480, 40); // below it
    document.getElementById("note")!.focus();
    revealFocused(document);
    expect(list.scrollTop).toBe(480 + 40 - 360 + 12);
  });

  it("leaves a field that already shows, or one outside any list, alone", () => {
    document.body.innerHTML = '<div class="ph"><main id="list" style="overflow-y:auto"><input id="note" /></main><textarea id="t"></textarea></div>';
    const list = document.getElementById("list")!;
    Object.defineProperty(list, "scrollHeight", { value: 900 });
    Object.defineProperty(list, "clientHeight", { value: 300 });
    list.getBoundingClientRect = () => rect(60, 300);
    document.getElementById("note")!.getBoundingClientRect = () => rect(200, 40);
    document.getElementById("note")!.focus();
    revealFocused(document);
    expect(list.scrollTop).toBe(0);
    document.getElementById("t")!.focus();
    revealFocused(document);
    expect(list.scrollTop).toBe(0);
  });
});
