import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { boardData, swarmTopic } from "../src/fixtures";
import { nodeUid } from "../src/panorama/select";
import { installIosVpFix } from "../src/ios-vp-fix";

const dir = join(process.cwd(), "src/styles");
const css = (n: string) => readFileSync(join(dir, n), "utf8");

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

describe("every route renders inside the one app frame (.ph, extended by --ios-vp-fix)", () => {
  const routes: [string, string, () => React.ReactElement][] = [
    ["a tab", "#/agents", () => <App />],
    ["chat", "#/chat/a-1", () => <App />],
    ["a question", "#/inbox/q/group%3A123/124", () => <App />],
    ["peek", `#/swarm/peek/${encodeURIComponent(nodeUid(swarmTopic.roots[0]!, "a9f8e7d6"))}`, () => <App data={boardData("peek")} />],
  ];
  for (const [name, hash, el] of routes) {
    it(`${name}: one .hd.ph root holds the whole screen`, () => {
      window.location.hash = hash;
      const { container } = render(el());
      const frames = container.querySelectorAll(".ph");
      expect(frames).toHaveLength(1);
      expect(container.firstElementChild).toBe(frames[0]);
      expect(frames[0]).toHaveClass("hd");
    });
  }

  it("chat has no frame-level height of its own and its read-only footer is not a fixed slot", () => {
    const app = css("app.css");
    expect(app).toContain(".ph{position:fixed;inset:0 0 calc(-1 * var(--ios-vp-fix, 0px)) 0;");
    const foot = css("chat.css").match(/^\.chat-foot\{([^}]*)\}/m)?.[1] ?? "";
    expect(foot).not.toMatch(/(^|;)\s*height:/);
    expect(foot).toContain("calc(var(--sab) + 8px)");
  });
});

describe("the iOS 26 viewport fix on the chat route (no tab bar)", () => {
  let cleanup: () => void = () => undefined;
  const fakeWin = () =>
    ({
      navigator: { standalone: true },
      screen: { width: 430, height: 932 },
      innerWidth: 430,
      innerHeight: 873,
      visualViewport: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      requestAnimationFrame: (f: () => void) => (f(), 1),
      cancelAnimationFrame: () => undefined,
    }) as unknown as Window;
  beforeEach(() => {
    document.elementFromPoint = () => null;
  });
  afterEach(() => {
    cleanup();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  const chatDom = () => {
    document.body.innerHTML = '<div class="hd ph"><header></header><main></main><footer class="chat-foot"></footer></div>';
    const foot = document.querySelector("footer")!;
    foot.getBoundingClientRect = () => ({ x: 0, y: 790, width: 430, height: 143 }) as DOMRect;
    return foot;
  };
  it("applies and keeps the fix while the chat footer is hit", () => {
    const foot = chatDom();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(foot);
    cleanup = installIosVpFix(fakeWin(), document, () => 59);
    expect(document.documentElement.style.getPropertyValue("--ios-vp-fix")).toBe("59px");
  });
  it("drops it when nothing is hit at the chat footer's top edge", () => {
    chatDom();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(null);
    cleanup = installIosVpFix(fakeWin(), document, () => 59);
    expect(document.documentElement.style.getPropertyValue("--ios-vp-fix")).toBe("0px");
  });
});
