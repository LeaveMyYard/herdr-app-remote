import { expect, test, type Page } from "@playwright/test";

/**
 * iOS 26 Home Screen app added with the old translucent status bar: the window is 59 px short of the screen (430x932
 * screen, innerHeight 873) and iOS paints nothing below it, so the composer and the tab bar must end at the window's
 * bottom, with the bottom inset shrunk by the deficit (34 - 59 -> 0). No test browser has that window, so the harness
 * stands it in: a 430x873 viewport, insets 59/34, --ios-vp-deficit forced to 59px. Reproduced in the iOS 26.5
 * Simulator (RECIPE.md). With the black status bar (index.html now) the same window has inset-top 0 and no deficit, and
 * the composer keeps the full 34 px home-indicator inset.
 */
const DEFICIT = 59;
test.use({ viewport: { width: 430, height: 873 } });

const CHATS = [
  ["chat view", "/?fixture=chatview&view=chat#/chat/a-1"],
  ["text view", "/?fixture=chat&typing=bar#/chat/a-1"],
] as const;

async function open(page: Page, url: string, insets: string, deficit: number, ready: string) {
  const [path, hash] = url.split("#");
  await page.goto(`${path}&${insets}#${hash}`);
  await page.waitForSelector(ready);
  await page.evaluate((d) => document.documentElement.style.setProperty("--ios-vp-deficit", `${d}px`), deficit);
}

/** Bottoms of the frame and the composer, and every ancestor inside the frame that clips one of them. */
function composer(page: Page) {
  return page.evaluate(() => {
    const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const clipped: string[] = [];
    for (const sel of [".chat-form", ".chat-text", ".chat-send"]) {
      const r = box(sel);
      for (let p = document.querySelector(sel)!.parentElement; p && !p.matches("html, body, #root"); p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const pr = p.getBoundingClientRect();
        if (r.bottom > pr.bottom + 0.5 || r.top < pr.top - 0.5) clipped.push(`${sel} clipped by ${p.className || p.tagName}`);
      }
    }
    return { ph: box(".ph").bottom, form: box(".chat-form").bottom, foot: box(".chat-foot").bottom, send: box(".chat-send").bottom, h: window.innerHeight, clipped };
  });
}

for (const [name, url] of CHATS) {
  test(`${name}, old translucent install: the composer ends at the short window's bottom, inset shrunk to 0`, async ({ page }) => {
    await open(page, url, "inset-top=59&inset-bottom=34", DEFICIT, ".chat-form");
    const m = await composer(page);
    expect(m.ph).toBe(m.h);
    expect(m.foot).toBe(m.h);
    expect(m.form).toBe(m.h);
    expect(m.send).toBe(m.h - 0 - 4);
    expect(m.clipped).toEqual([]);
  });

  test(`${name}, black status bar: the composer keeps the 34 px home-indicator inset`, async ({ page }) => {
    await open(page, url, "inset-top=0&inset-bottom=34", 0, ".chat-form");
    const m = await composer(page);
    expect(m.ph).toBe(m.h);
    expect(m.form).toBe(m.h);
    expect(m.send).toBe(m.h - 34 - 4);
    expect(m.clipped).toEqual([]);
  });
}

test("agents, old translucent install: the tab bar and its labels end inside the short window", async ({ page }) => {
  await open(page, "/?fixture=basic#/agents", "inset-top=59&inset-bottom=34", DEFICIT, ".tabbar");
  const m = await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".tab")].map((t) => {
      const text = [...t.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNodeContents(text);
      return range.getBoundingClientRect().bottom;
    });
    return { bar: document.querySelector(".tabbar")!.getBoundingClientRect().bottom, labels, h: window.innerHeight };
  });
  expect(m.bar).toBe(m.h);
  expect(m.labels).toHaveLength(5);
  for (const b of m.labels) expect(b).toBeLessThanOrEqual(m.h);
});
