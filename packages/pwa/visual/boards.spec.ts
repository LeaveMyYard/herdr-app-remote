import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { compare, MAX_DIFF_RATIO, type Rect } from "./compare";

/**
 * `fixture` selects the fake data behind the screen (main.tsx; without it the app connects to the bridge); `nav: false` is a full-screen sheet with no tab bar.
 * `skip` is a region of the design render that this slice leaves out on purpose (painted out of both images).
 */
const BOARDS: readonly { ref: string; url: string; nav?: boolean; skip?: Rect[] }[] = [
  { ref: "PhoneAgentsBasic", url: "/?fixture=basic#/agents" },
  { ref: "PhoneUsage", url: "/?fixture=usage#/usage" },
  { ref: "PhoneMissing", url: "/?fixture=usage#/usage/missing" },
  { ref: "PhoneAgents", url: "/?fixture=agents#/agents" },
  { ref: "PhoneSwarm", url: "/?fixture=swarm#/swarm/sp-1" },
  { ref: "PhonePeek", url: "/?fixture=peek#/swarm/peek/t2%00a9f8e7d6", nav: false },
  // Chat's terminal text, spinner, tile and footer slot (S16's key bar and composer) are masked in the page.
  { ref: "PhoneChat", url: "/?fixture=chat#/chat/a-1", nav: false },
  // PhoneInbox: the fourth row is the placeholder of an answer the phone saw delivered (demo data seeds it).
  { ref: "PhoneInbox", url: "/?fixture=inbox#/inbox" },
  { ref: "PhoneQuestion", url: "/?fixture=inbox&pick=0#/inbox/q/group%3A123/123", nav: false },
  { ref: "PhoneReview", url: "/?fixture=inbox&inbox=review#/inbox/q/group%3A123/submit", nav: false },
];

for (const board of BOARDS) {
  test(`${board.ref} matches the design render`, async ({ page }, info) => {
    const nav = board.nav !== false;
    await page.goto(board.url);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector(nav ? ".tabbar" : "[aria-label=Peek], .chat-head, .qn-head");
    const masks: Rect[] = [
      ...(await page.$$eval("[data-vis-mask]", (els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      )),
      ...(board.skip ?? []),
    ];
    const shot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    const diffOut = info.outputPath(`${board.ref}.diff.png`);
    const result = compare(shot, board.ref, masks, diffOut);
    writeFileSync(info.outputPath(`${board.ref}.actual.png`), shot);
    info.annotations.push({ type: "diff", description: `${(result.ratio * 100).toFixed(3)}% (${result.diffPixels} px)` });
    console.log(`${board.ref} [${info.project.name}] ${(result.ratio * 100).toFixed(3)}%`);
    // Pixel gate: Chromium only, because the renders come from Chromium. WebKit rasterises text
    // differently, so there it logs the ratio and gates on layout instead.
    if (info.project.name === "chromium-phone") {
      expect(result.ratio, `${result.diffPixels} of ${result.total} pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    }
    const layout = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      tabBarBottom: document.querySelector(".tabbar")?.getBoundingClientRect().bottom ?? -1,
      innerHeight: window.innerHeight,
      inter: document.fonts.check('14px "Inter"'),
    }));
    expect(layout.overflowX).toBeLessThanOrEqual(0);
    if (nav) expect(layout.tabBarBottom).toBe(layout.innerHeight);
    expect(layout.inter).toBe(true);
  });
}
