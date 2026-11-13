import { expect, test } from "@playwright/test";

/**
 * iOS 26 Home Screen app: the layout viewport is 59 px short of the screen (430x932 screen, innerHeight 873), and
 * src/ios-vp-fix.ts extends the app frame by the deficit (--ios-vp-fix). No test browser has that window, so the
 * harness stands it in: a 430x873 viewport with --ios-vp-fix forced to 59px. The composer must end exactly where the
 * frame ends (the screen bottom), and nothing between the composer and the frame may clip it.
 */
const DEFICIT = 59;
test.use({ viewport: { width: 430, height: 873 } });

for (const [name, url] of [
  ["chat view", "/?fixture=chatview&view=chat&inset-top=59&inset-bottom=34#/chat/a-1"],
  ["text view", "/?fixture=chat&typing=bar&inset-top=59&inset-bottom=34#/chat/a-1"],
] as const) {
  test(`${name}: the composer ends at the extended frame's bottom and nothing clips it`, async ({ page }) => {
    await page.goto(url);
    await page.waitForSelector(".chat-form");
    await page.evaluate((d) => document.documentElement.style.setProperty("--ios-vp-fix", `${d}px`), DEFICIT);
    const m = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const out: string[] = [];
      for (const sel of [".chat-form", ".chat-text", ".chat-send"]) {
        const r = box(sel);
        for (let p = document.querySelector(sel)!.parentElement; p && !p.matches("html, body, #root"); p = p.parentElement) {
          const cs = getComputedStyle(p);
          // html and body are not its containing block: .ph is position:fixed, so only .ph and what is inside it can clip.
          if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
          const pr = p.getBoundingClientRect();
          if (r.bottom > pr.bottom + 0.5 || r.top < pr.top - 0.5) out.push(`${sel} clipped by ${p.className || p.tagName}`);
        }
      }
      return { ph: box(".ph").bottom, form: box(".chat-form").bottom, foot: box(".chat-foot").bottom, send: box(".chat-send").bottom, h: window.innerHeight, clipped: out };
    });
    expect(m.ph).toBe(m.h + DEFICIT);
    expect(m.foot).toBe(m.ph);
    expect(m.form).toBe(m.ph);
    expect(m.send).toBe(m.ph - 34 - 4);
    expect(m.clipped).toEqual([]);
  });
}
