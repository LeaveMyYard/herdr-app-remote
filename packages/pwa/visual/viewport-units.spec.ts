import { expect, test } from "@playwright/test";

/**
 * An installed (Home Screen) iOS PWA with viewport-fit=cover and a translucent status bar reports 100vh/100dvh as the
 * screen height less the top inset, so a full-height frame sized in viewport-height units ends short of the bottom and
 * leaves an empty band under the tab bar. No test browser reproduces that, so this guards the cause instead: no
 * stylesheet rule may use a viewport-height unit, and the frame must fill the window with a body that does not scroll.
 */
test("no rule uses a viewport-height unit", async ({ page }) => {
  await page.goto("/?fixture=agents#/agents");
  await page.waitForSelector(".tabbar");
  const offenders = await page.evaluate(() => {
    const unit = /(?:^|[^\w-])-?[\d.]+(?:vh|dvh|svh|lvh|vb)\b/;
    const out: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) {
          for (const name of Array.from(r.style)) {
            const v = r.style.getPropertyValue(name);
            if (unit.test(v)) out.push(`${r.selectorText} { ${name}: ${v} }`);
          }
        } else if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
    return out;
  });
  expect(offenders).toEqual([]);
});

test("the frame fills the window and the body does not scroll", async ({ page }) => {
  await page.goto("/?fixture=agents#/agents");
  await page.waitForSelector(".tabbar");
  const m = await page.evaluate(() => {
    const ph = document.querySelector(".ph")!.getBoundingClientRect();
    return {
      top: ph.top, bottom: ph.bottom, w: ph.width, h: window.innerHeight, iw: window.innerWidth,
      bodyOverflow: getComputedStyle(document.body).overflow,
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  });
  expect([m.top, m.bottom, m.w]).toEqual([0, m.h, m.iw]);
  expect(m.bodyOverflow).toBe("hidden");
  expect(m.scrolls).toBe(false);
});
