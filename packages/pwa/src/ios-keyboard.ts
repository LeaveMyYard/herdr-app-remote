/* Home Screen app on iOS: the keyboard. iOS does not shrink the app frame for the keyboard; it scrolls the whole
   page up until the focused field is above it (iOS 26.5 Simulator, 430x932, black status bar: visualViewport 460 tall
   at offsetTop 413, documentElement.clientHeight still 873). The frame (.ph, pinned to the layout viewport) then had
   its header scrolled off the top, the newest messages under the composer, and, in an app added with the translucent
   status bar, the page sliding under the status bar. While the keyboard is open the frame is pinned to the visual
   viewport instead (--kb-top / --kb-h, used by app.css under :root[data-kb]), and the bottom inset is dropped: the
   keyboard covers the home indicator, so its 34 pt only left a gap above the keyboard. */

/** Less than this between the visual and the layout viewport is not a keyboard (a toolbar, rounding). */
const MIN_KEYBOARD = 80;

export interface KbInput {
  standalone: boolean;
  /** An editable element has focus: the keyboard shows only for those. */
  editing: boolean;
  /** documentElement.clientHeight: the layout viewport, which the keyboard does not change. */
  layoutHeight: number;
  vvHeight: number;
  vvTop: number;
  vvScale: number;
}

/** The visible area to pin the frame to, or null while no keyboard is open (or pinch zoom is what shrank the view). */
export function keyboardFrame(i: KbInput): { top: number; height: number } | null {
  if (!i.standalone || !i.editing) return null;
  if (Math.abs(i.vvScale - 1) > 0.01) return null;
  if (!(i.vvHeight > 0) || i.vvHeight > i.layoutHeight - MIN_KEYBOARD) return null;
  return { top: Math.max(0, Math.round(i.vvTop)), height: Math.round(i.vvHeight) };
}

function editing(doc: Document): boolean {
  const el = doc.activeElement;
  if (!el || el === doc.body) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

/** iOS scrolled the page to show the focused field, not the list it sits in. Once the frame is the visible area, bring
    the field into view inside its nearest scrolling ancestor (the question screen's note field sits below its options). */
export function revealFocused(doc: Document, margin = 12): void {
  const el = doc.activeElement;
  if (!(el instanceof HTMLElement) || el === doc.body) return;
  for (let p = el.parentElement; p && !p.classList.contains("ph"); p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy !== "auto" && oy !== "scroll") || p.scrollHeight <= p.clientHeight) continue;
    const r = el.getBoundingClientRect();
    const box = p.getBoundingClientRect();
    if (r.bottom > box.bottom - margin) p.scrollTop += r.bottom - box.bottom + margin;
    else if (r.top < box.top + margin) p.scrollTop -= box.top + margin - r.top;
    return;
  }
}

/** Keeps data-kb, --kb-top and --kb-h on the root in step with the keyboard. Returns the cleanup. */
export function installIosKeyboard(win: Window = window, doc: Document = document): () => void {
  const vv = win.visualViewport;
  if ((win.navigator as unknown as { standalone?: boolean }).standalone !== true || !vv) return () => undefined;
  const root = doc.documentElement;
  let frame = 0;
  let shown = ""; // the geometry last applied, so the field is revealed only when the frame or the focus changes
  const apply = (focusMoved = false) => {
    const f = keyboardFrame({
      standalone: true,
      editing: editing(doc),
      layoutHeight: root.clientHeight,
      vvHeight: vv.height,
      vvTop: vv.offsetTop,
      vvScale: vv.scale,
    });
    if (f) {
      root.style.setProperty("--kb-top", `${f.top}px`);
      root.style.setProperty("--kb-h", `${f.height}px`);
      root.dataset.kb = "";
      const key = `${f.top}/${f.height}`;
      if (key !== shown || focusMoved) win.requestAnimationFrame(() => revealFocused(doc));
      shown = key;
    } else if ("kb" in root.dataset) {
      shown = "";
      delete root.dataset.kb;
      root.style.removeProperty("--kb-top");
      root.style.removeProperty("--kb-h");
    }
  };
  // Focus moves between fields without the keyboard closing: decide on the next frame, not on focusout itself.
  let focusMoved = false;
  const update = () => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      apply(focusMoved);
      focusMoved = false;
    });
  };
  const onFocus = () => {
    focusMoved = true;
    update();
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  doc.addEventListener("focusin", onFocus);
  doc.addEventListener("focusout", update);
  apply();
  return () => {
    win.cancelAnimationFrame(frame);
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    doc.removeEventListener("focusin", onFocus);
    doc.removeEventListener("focusout", update);
    delete root.dataset.kb;
    root.style.removeProperty("--kb-top");
    root.style.removeProperty("--kb-h");
  };
}
