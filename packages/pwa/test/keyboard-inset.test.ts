import { afterEach, describe, expect, it } from "vitest";
import { installKeyboardInset, keyboardInset, KEYBOARD_MIN } from "../src/keyboard-inset";

describe("keyboardInset", () => {
  it("is the part of the window under the visual viewport, while a field has focus", () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 0 }, true)).toEqual({ top: 0, bottom: 336 });
    expect(keyboardInset(844, { height: 400, offsetTop: 108 }, true)).toEqual({ top: 108, bottom: 336 });
  });
  it("is null with no field focused, no visual viewport, or only a toolbar's worth of change", () => {
    expect(keyboardInset(844, { height: 508, offsetTop: 0 }, false)).toBeNull();
    expect(keyboardInset(844, null, true)).toBeNull();
    expect(keyboardInset(844, { height: 844 - KEYBOARD_MIN + 1, offsetTop: 0 }, true)).toBeNull();
  });
});

describe("installKeyboardInset", () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });
  const fakeWin = (vv: { height: number; offsetTop: number }) => {
    const l = new Set<() => void>();
    const visualViewport = Object.assign(vv, { addEventListener: (_: string, f: () => void) => l.add(f), removeEventListener: (_: string, f: () => void) => l.delete(f) });
    return { win: { innerHeight: 844, visualViewport, addEventListener() {}, removeEventListener() {} } as unknown as Window, fire: () => l.forEach((f) => f()), vv };
  };

  it("sets the frame variables while a text field is focused and the keyboard is up, and clears them after", () => {
    document.body.innerHTML = `<textarea id="t"></textarea>`;
    const { win, fire, vv } = fakeWin({ height: 508, offsetTop: 0 });
    cleanup = installKeyboardInset(win, document);
    const root = document.documentElement;
    expect(root.dataset.kb).toBeUndefined();
    (document.getElementById("t") as HTMLElement).focus();
    fire();
    expect([root.style.getPropertyValue("--kb-top"), root.style.getPropertyValue("--kb-bottom"), root.dataset.kb]).toEqual(["0px", "336px", ""]);
    vv.height = 844;
    fire();
    expect([root.style.getPropertyValue("--kb-bottom"), root.dataset.kb]).toEqual(["", undefined]);
  });

  it("ignores a focused button", () => {
    document.body.innerHTML = `<button id="b"></button>`;
    const { win, fire } = fakeWin({ height: 508, offsetTop: 0 });
    cleanup = installKeyboardInset(win, document);
    (document.getElementById("b") as HTMLElement).focus();
    fire();
    expect(document.documentElement.dataset.kb).toBeUndefined();
  });
});
