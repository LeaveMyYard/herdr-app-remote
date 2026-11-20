import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { boardData, swarmTopic } from "../src/fixtures";
import { nodeUid } from "../src/panorama/select";
import { Chat } from "../src/screens/Chat";

const dir = join(process.cwd(), "src/styles");
const css = (n: string) => readFileSync(join(dir, n), "utf8");

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = "";
});

describe("every route renders inside the one app frame (.ph, pinned to the window)", () => {
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
    expect(app).toContain(".ph{position:fixed;inset:0;");
    const foot = css("chat.css").match(/^\.chat-foot\{([^}]*)\}/m)?.[1] ?? "";
    expect(foot).not.toMatch(/(^|;)\s*height:/);
    expect(foot).toContain("calc(var(--sab) + 8px)");
    expect(css("chat.css")).toContain(".chat-foot-slot{height:calc(var(--sab) + 109px)");
  });

  it("the board's footer slot is demo data only: a real (live) chat footer is content-sized", () => {
    window.location.hash = "#/chat/a-1";
    const demo = render(<App />);
    expect(demo.container.querySelector("footer")).toHaveClass("chat-foot-slot");
    demo.unmount();
    const live = render(<Chat agent={{ name: "Agent 1", folder: "tab 1", harness: "claude", status: "idle" }} topic={{ terminal: "t3", lines: [] }} />);
    expect(live.container.querySelector("footer")).toHaveClass("chat-foot");
    expect(live.container.querySelector("footer")).not.toHaveClass("chat-foot-slot");
  });
});

describe("iOS 26: nothing extends past the window", () => {
  // On iOS 26 with the translucent status bar the Home Screen app's window is 59 pt short of the screen and iOS paints
  // nothing below it (src/ios-vp-fix.ts): a frame stretched down there drew the tab bar without its labels and cut the
  // chat composer in half. Reproduced in the iOS 26.5 Simulator (RECIPE.md).
  const styles = ["app.css", "chat.css", "inbox.css", "pair.css", "panorama.css", "usage.css", "prompt-card.css"];

  it("no stylesheet pushes anything below the window's bottom edge", () => {
    for (const n of styles) expect(css(n), n).not.toMatch(/calc\(-1 \* var\(--ios-vp/);
  });

  it("while the keyboard is open the frame is the visible area and there is no bottom inset (src/ios-keyboard.ts)", () => {
    const app = css("app.css");
    expect(app).toContain(":root[data-kb]{--sab:0px}");
    expect(app).toContain(":root[data-kb] .ph{top:var(--kb-top,0px);bottom:auto;height:var(--kb-h,100%)}");
  });

  it("the bottom inset shrinks by the iOS deficit and never goes below 0 (the status bar style is in shell.test.ts)", () => {
    expect(css("app.css")).toContain("--sab:max(0px,calc(var(--inset-bottom,env(safe-area-inset-bottom,0px)) - var(--ios-vp-deficit,0px)));");
  });
});
