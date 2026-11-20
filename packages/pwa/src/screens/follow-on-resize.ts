import { useEffect, type RefObject } from "react";

/**
 * A log that follows its end (chat view, text view) only re-scrolled when its content changed. When the keyboard opens,
 * the frame shrinks (src/ios-keyboard.ts) and so does the log: keep the newest lines in view while it was following.
 */
export function useFollowOnResize(view: RefObject<HTMLElement | null>, pinned: RefObject<boolean>): void {
  useEffect(() => {
    const el = view.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, pinned]);
}
