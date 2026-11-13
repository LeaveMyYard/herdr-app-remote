import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { compare, MAX_DIFF_RATIO, type Rect } from "./compare";

/**
 * CV5: the timeline parts of design/PhoneChatView, each compared where the board draws it (`clip`): the inline
 * question ("Typing off"), the alert row ("History") and the strip's subagent link and account chip (every state). The
 * chat around them is CV4's screen. Animated tiles are masked in both images.
 */
const PARTS: readonly { name: string; ref: string; state: string; clip: Rect }[] = [
  { name: "question", ref: "PhoneChatView-off", state: "off", clip: { x: 16, y: 488, width: 358, height: 253 } },
  { name: "alert", ref: "PhoneChatView-history", state: "history", clip: { x: 16, y: 565, width: 358, height: 54 } },
  { name: "strip", ref: "PhoneChatView-chat", state: "off", clip: { x: 16, y: 114, width: 180, height: 36 } },
  { name: "account", ref: "PhoneChatView-chat", state: "off", clip: { x: 214, y: 116, width: 160, height: 32 } },
];

for (const part of PARTS) {
  test(`timeline ${part.name} matches ${part.ref}`, async ({ page }, info) => {
    await page.goto(`/?fixture=timeline&state=${part.state}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector(".tl-strip");
    // Masks are in page coordinates; compare() crops to the clip first, so they are shifted into it.
    const local: Rect[] = await page.$$eval(
      "[data-vis-mask]",
      (els, clip) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x - clip.x, y: r.y - clip.y, width: r.width, height: r.height };
        }),
      part.clip,
    );
    const shot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    writeFileSync(info.outputPath(`${part.name}.actual.png`), shot);
    const result = compare(shot, part.ref, local, info.outputPath(`${part.name}.diff.png`), part.clip);
    console.log(`timeline ${part.name} [${info.project.name}] ${(result.ratio * 100).toFixed(3)}%`);
    if (info.project.name === "chromium-phone") {
      expect(result.ratio, `${result.diffPixels} of ${result.total} pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    }
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX).toBeLessThanOrEqual(0);
  });
}
