import { expect, test } from "@playwright/test";

/**
 * Safe-area insets are applied exactly once per screen. No test browser has a real notch, so the harness hook
 * (`&inset-top=`, `&inset-bottom=`, main.tsx) stands in for env(safe-area-inset-*) with deliberately unlike values.
 */
const TOP = 47;
const BOTTOM = 34;
const q = (url: string) => {
  const [path, hash] = url.split("#");
  return `${path}${path!.includes("?") ? "&" : "?"}inset-top=${TOP}&inset-bottom=${BOTTOM}${hash === undefined ? "" : `#${hash}`}`;
};

const px = (v: string) => Number.parseFloat(v);

test.describe("tabbed screens", () => {
  for (const [name, url, top] of [
    ["Agents", "/?fixture=agents#/agents", ".app-header"],
    ["Swarm", "/?fixture=swarm#/swarm/sp-1", ".sw-head"],
    ["Inbox", "/?fixture=inbox#/inbox", ".ib-head"],
    ["Usage", "/?fixture=usage#/usage", ".status-spacer"],
    ["Missing", "/?fixture=usage#/usage/missing", ".status-spacer"],
  ] as const) {
    test(`${name}: one top inset, tab bar clear of the home indicator`, async ({ page }) => {
      await page.goto(q(url));
      await page.waitForSelector(".tabbar");
      const m = await page.evaluate((sel) => {
        const el = document.querySelector(sel)!;
        const cs = getComputedStyle(el);
        const bar = document.querySelector(".tabbar")!.getBoundingClientRect();
        const lastTab = [...document.querySelectorAll(".tabbar .tab")].pop()!.getBoundingClientRect();
        return { top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, pad: cs.paddingTop, barBottom: bar.bottom, tabBottom: lastTab.bottom, h: window.innerHeight };
      }, top);
      expect(m.top).toBe(0);
      if (top === ".status-spacer") expect(m.height).toBe(TOP - 6);
      else if (top === ".app-header") expect([px(m.pad), m.height]).toEqual([TOP, TOP + 44]);
      else expect(px(m.pad)).toBe(top === ".ib-head" ? TOP + 6 : TOP);
      expect(m.barBottom).toBe(m.h);
      expect(m.tabBottom).toBe(m.h - BOTTOM);
    });
  }

  test("banner and Home Screen prompt sit right above the tab bar", async ({ page }) => {
    for (const [url, sel] of [["/?fixture=agents&banner=paused#/agents", ".banner"], ["/?fixture=agents&prompt=1#/agents", ".home-prompt"]] as const) {
      await page.goto(q(url));
      await page.waitForSelector(sel);
      const gap = await page.evaluate((s) => document.querySelector(".tabbar")!.getBoundingClientRect().top - document.querySelector(s)!.getBoundingClientRect().bottom, sel);
      expect(gap).toBe(7);
    }
  });
});

test.describe("full-screen views", () => {
  for (const [name, url, head] of [
    ["Chat", "/?fixture=chat#/chat/a-1", ".chat-head"],
    ["Question", "/?fixture=inbox&pick=0#/inbox/q/group%3A123/123", ".qn-head"],
  ] as const) {
    test(`${name}: one top inset and one bottom inset`, async ({ page }) => {
      await page.goto(q(url));
      await page.waitForSelector(head);
      const m = await page.evaluate((sel) => {
        const el = document.querySelector(sel)!;
        const last = document.querySelector(".ph")!.lastElementChild!.querySelector(".chat-form, .qn-foot, .qn-rfoot, .qn-dismissbar") ?? document.querySelector(".ph")!.lastElementChild!;
        return { top: el.getBoundingClientRect().top, pad: getComputedStyle(el).paddingTop, lastBottom: last.getBoundingClientRect().bottom, slot: document.querySelector(".chat-foot")?.getBoundingClientRect().height, lastPad: getComputedStyle(last).paddingBottom, h: window.innerHeight };
      }, head);
      expect(m.top).toBe(0);
      expect(px(m.pad)).toBe(TOP);
      expect(m.lastBottom).toBe(m.h);
      // Chat's footer is a slot of (inset + 109) px; a question's footers pad by the inset.
      if (name === "Chat") expect(m.slot).toBe(BOTTOM + 109);
      else expect(px(m.lastPad)).toBe(BOTTOM + 4);
    });
  }

  // What a phone gets: no board slot, the read-only footer is its text plus the inset (no empty band under it).
  test("Chat read-only footer (no board slot) ends at the window bottom with one inset", async ({ page }) => {
    await page.goto(q("/?fixture=chat&slot=0#/chat/a-1"));
    await page.waitForSelector(".chat-head");
    const m = await page.evaluate(() => {
      const f = document.querySelector(".chat-foot")!;
      return { bottom: f.getBoundingClientRect().bottom, h: window.innerHeight, pad: getComputedStyle(f).paddingBottom, height: f.getBoundingClientRect().height };
    });
    expect(m.bottom).toBe(m.h);
    expect(px(m.pad)).toBe(BOTTOM + 8);
    expect(m.height).toBeLessThan(BOTTOM + 109);
  });

  test("pair: insets top and bottom", async ({ page }) => {
    await page.goto(q("/?fixture=pair&state=ok"));
    await page.waitForSelector(".pair");
    const m = await page.evaluate(() => ({ top: document.querySelector(".pair-top")!.getBoundingClientRect().height, pad: getComputedStyle(document.querySelector(".pair-foot")!).paddingBottom }));
    expect(m.top).toBe(TOP - 6);
    expect(px(m.pad)).toBe(BOTTOM + 4);
  });

  test("key sheet clears the home indicator", async ({ page }) => {
    await page.goto(q("/?fixture=chat&typing=menu#/chat/a-1"));
    await page.waitForSelector(".keys-sheet");
    const m = await page.evaluate(() => {
      const s = document.querySelector(".keys-sheet")!;
      return { bottom: s.getBoundingClientRect().bottom, pad: getComputedStyle(s).paddingBottom, h: window.innerHeight };
    });
    expect(m.bottom).toBe(m.h);
    expect(px(m.pad)).toBe(BOTTOM + 4);
  });
});

test("chat footer variants and Peek use the inset exactly", async ({ page }) => {
  // Composer: the form pads by inset + 4; ran out: the footer by inset + 8; read-only: a slot of inset + 109.
  await page.goto(q("/?fixture=chat&typing=bar#/chat/a-1"));
  await page.waitForSelector(".chat-form");
  expect(px(await page.$eval(".chat-form", (e) => getComputedStyle(e).paddingBottom))).toBe(BOTTOM + 4);
  await page.goto(q("/?fixture=chat&typing=gone#/chat/a-1"));
  await page.waitForSelector(".chat-foot-out");
  expect(px(await page.$eval(".chat-foot-out", (e) => getComputedStyle(e).paddingBottom))).toBe(BOTTOM + 8);
  await page.goto(q("/?fixture=peek#/swarm/peek/t2%00a9f8e7d6"));
  await page.waitForSelector("[aria-label=Peek]");
  const p = await page.evaluate(() => {
    const box = (c: string) => document.querySelector(c)!;
    return { back: getComputedStyle(box(".pk-back")).paddingTop, sheetTop: box(".pk-sheet").getBoundingClientRect().top, bodyPad: getComputedStyle(box(".pk-body")).paddingBottom, sheetBottom: box(".pk-sheet").getBoundingClientRect().bottom, h: window.innerHeight };
  });
  expect(px(p.back)).toBe(TOP + 6);
  expect(p.sheetTop).toBe(TOP + 60);
  expect(px(p.bodyPad)).toBe(BOTTOM - 2);
  expect(p.sheetBottom).toBe(p.h);
});

test("zero insets (a Safari tab): nothing is added", async ({ page }) => {
  const at = (url: string) => url.replace(/(#|$)/, (m) => `${url.includes("?") ? "&" : "?"}inset-top=0&inset-bottom=0${m}`);
  await page.goto(at("/?fixture=agents#/agents"));
  await page.waitForSelector(".tabbar");
  const a = await page.evaluate(() => ({ pad: getComputedStyle(document.querySelector(".app-header")!).paddingTop, h: document.querySelector(".app-header")!.getBoundingClientRect().height, tab: [...document.querySelectorAll(".tabbar .tab")].pop()!.getBoundingClientRect().bottom, bar: document.querySelector(".tabbar")!.getBoundingClientRect().bottom, inner: window.innerHeight }));
  expect([px(a.pad), a.h]).toEqual([0, 44]);
  expect(a.bar).toBe(a.inner);
  expect(a.inner - a.tab).toBe(0);
  await page.goto(at("/?fixture=usage#/usage"));
  await page.waitForSelector(".status-spacer", { state: "attached" });
  expect(await page.$eval(".status-spacer", (e) => e.getBoundingClientRect().height)).toBe(0);
  await page.goto(at("/?fixture=pair&state=check"));
  await page.waitForSelector(".pair-main", { state: "attached" });
  expect(await page.$eval(".pair-top", (e) => e.getBoundingClientRect().height)).toBe(0);
  expect(px(await page.$eval(".pair-main", (e) => getComputedStyle(e).paddingBottom))).toBe(24);
});

