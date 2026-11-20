import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useFollowOnResize } from "../src/screens/follow-on-resize";

// jsdom has no ResizeObserver: a stand-in that lets the test fire the resize.
let fire: () => void = () => undefined;
class FakeResizeObserver {
  constructor(cb: () => void) {
    fire = cb;
  }
  observe() {}
  disconnect() {}
}

function Log({ following }: { following: boolean }) {
  const view = useRef<HTMLDivElement>(null);
  const pinned = useRef(following);
  useFollowOnResize(view, pinned);
  return <div ref={view} data-testid="log" />;
}

describe("useFollowOnResize", () => {
  const saved = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = saved;
  });

  it("keeps a following log at its end when it shrinks (keyboard open)", () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const { getByTestId } = render(<Log following />);
    const el = getByTestId("log");
    Object.defineProperty(el, "scrollHeight", { value: 2000 });
    fire();
    expect(el.scrollTop).toBe(2000);
  });

  it("leaves a log the reader scrolled up in place", () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    const { getByTestId } = render(<Log following={false} />);
    const el = getByTestId("log");
    Object.defineProperty(el, "scrollHeight", { value: 2000 });
    el.scrollTop = 120;
    fire();
    expect(el.scrollTop).toBe(120);
  });
});
