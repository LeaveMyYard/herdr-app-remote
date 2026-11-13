import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { compare, MAX_DIFF_RATIO, type Rect } from "./compare";

/**
 * CV7: the prompt cards against the PhoneChatView board's renders (states perm, ask1, askm, plan, changed). The chat
 * screen around them is CV4's, so only the card's own band of the board is compared (`clip`), with the card placed
 * where the board puts it (`?fixture=prompt-cards`, chatview/prompt/fixtures.tsx).
 *
 * `skip` (painted out of both): ask1's Skip button only. The board draws Skip beside Answer on a one-question card;
 * the operator decided (Q521, 2026-11-13) that Skip only moves to the next question, so the card hides it on the last
 * or only one: an operator-approved deviation. The Answer button is compared.
 * `skip` also paints out the text line of the Other field in ask1 and askm (otherText): the board draws it at 14 px, the app at 16 px,
 * because iOS Safari zooms into any field under 16 px (a functional deviation requested by the operator, 2026-11-13).
 * The field's box (border, fill, height) stays compared.
 */
const W = 390;
/** The Other field's text line, relative to the clip, for a card whose field is at page y `fieldY` (x 31, 330 x 46: ask1 607, askm 607 with clip tops 357 and 325). */
const otherText = (clipTop: number, fieldY = 607): Rect => ({ x: 40, y: fieldY - clipTop + 12, width: 300, height: 22 });
const CARDS: readonly { state: string; top: number; bottom: number; picks?: string[]; press?: string; skip?: Rect[] }[] = [
  { state: "perm", top: 409, bottom: 721 },
  { state: "ask1", top: 357, bottom: 721, picks: ["Option A"], skip: [{ x: 296, y: 303, width: 66, height: 48 }, otherText(357)] },
  { state: "askm", top: 325, bottom: 721, picks: ["Option A", "Option C"], skip: [otherText(325)] },
  { state: "plan", top: 298, bottom: 721 },
  { state: "changed", top: 330, bottom: 721, press: "Yes" },
];

for (const c of CARDS) {
  test(`PhoneChatView-${c.state} prompt card matches the design render`, async ({ page }, info) => {
    await page.goto(`/?fixture=prompt-cards&state=${c.state}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector(".pc-card");
    for (const p of c.picks ?? []) await page.getByRole("button", { name: new RegExp(`^${p}`) }).click();
    if (c.press) {
      await page.getByRole("button", { name: new RegExp(`^${c.press}`) }).first().click();
      await page.waitForSelector("[role=alert]");
    }
    // No focus ring or caret in the shot.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const shot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    const clip = { x: 0, y: c.top, width: W, height: c.bottom - c.top };
    const ref = `PhoneChatView-${c.state}`;
    const result = compare(shot, ref, c.skip ?? [], info.outputPath(`${ref}.diff.png`), clip);
    writeFileSync(info.outputPath(`${ref}.actual.png`), shot);
    info.annotations.push({ type: "diff", description: `${(result.ratio * 100).toFixed(3)}% (${result.diffPixels} px)` });
    console.log(`${ref} card [${info.project.name}] ${(result.ratio * 100).toFixed(3)}%`);
    if (info.project.name === "chromium-phone") expect(result.ratio, `${result.diffPixels} of ${result.total} pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowX).toBeLessThanOrEqual(0);
  });
}
