/* iOS Safari and the Home Screen app do not resize the layout viewport when the keyboard opens: it covers the bottom of
   the window, and the browser pans the page to show the focused field. The app frame (.ph, position:fixed; inset:0)
   keeps its full size, so the composer sits behind the keyboard or is half hidden by the pan. The visual viewport is
   the part of the window that can be seen. While a text field has focus and the visual viewport is clearly shorter
   than the window, --kb-top and --kb-bottom (px) make the frame match it, and data-kb on the root lets the footer drop
   the home indicator inset, which the keyboard covers. Otherwise both are 0 and nothing changes. */

/** Below this much of the window covered, it is the browser's own toolbar moving, not a keyboard. */
export const KEYBOARD_MIN = 120;

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
}

/** The px of the layout viewport the keyboard covers, as `{top, bottom}`, or null when no keyboard is up. */
export function keyboardInset(innerHeight: number, vv: VisualViewportLike | null | undefined, fieldFocused: boolean): { top: number; bottom: number } | null {
  if (!vv || !fieldFocused) return null;
  const bottom = innerHeight - (vv.offsetTop + vv.height);
  if (!(bottom >= KEYBOARD_MIN)) return null;
  return { top: Math.max(0, Math.round(vv.offsetTop)), bottom: Math.round(bottom) };
}

const isField = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  return el instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "range", "file", "image", "reset", "color"].includes(el.type);
};

/** Keeps --kb-top, --kb-bottom and data-kb on the root in step with the keyboard. Returns the cleanup. */
export function installKeyboardInset(win: Window = window, doc: Document = document): () => void {
  const root = doc.documentElement;
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const update = () => {
    const k = keyboardInset(win.innerHeight, vv, isField(doc.activeElement));
    if (k) {
      root.style.setProperty("--kb-top", `${k.top}px`);
      root.style.setProperty("--kb-bottom", `${k.bottom}px`);
      root.dataset.kb = "";
    } else {
      root.style.removeProperty("--kb-top");
      root.style.removeProperty("--kb-bottom");
      delete root.dataset.kb;
    }
  };
  const events = ["focusin", "focusout"] as const;
  for (const e of events) doc.addEventListener(e, update);
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  win.addEventListener("orientationchange", update);
  update();
  return () => {
    for (const e of events) doc.removeEventListener(e, update);
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    win.removeEventListener("orientationchange", update);
    root.style.removeProperty("--kb-top");
    root.style.removeProperty("--kb-bottom");
    delete root.dataset.kb;
  };
}
