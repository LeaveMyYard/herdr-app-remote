import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { compare, MAX_DIFF_RATIO, type Rect } from "./compare";

const BOARDS = [
  { ref: "PhoneAgentsBasic", hash: "#/agents" },
  { ref: "PhoneMissing", hash: "#/usage" },
] as const;

for (const board of BOARDS) {
  test(`${board.ref} matches the design render`, async ({ page }, info) => {
    await page.goto(`/${board.hash}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector(".tabbar");
    const masks: Rect[] = await page.$$eval("[data-vis-mask]", (els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
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
    expect(layout.tabBarBottom).toBe(layout.innerHeight);
    expect(layout.inter).toBe(true);
  });
}
