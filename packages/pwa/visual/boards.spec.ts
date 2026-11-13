import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { compare, MAX_DIFF_RATIO, type Rect } from "./compare";

/**
 * `fixture` selects the fake data behind the screen (main.tsx; without it the app connects to the bridge); `nav: false` is a full-screen sheet with no tab bar.
 * `skip` is a region of the design render that this slice leaves out on purpose (painted out of both images).
 * `viewport` and `clip` are for a board drawn inside browser chrome: the page gets the height the browser leaves it,
 * and only `clip` (the part above the chrome, from the top) is compared.
 * `compare` lists `[data-vis-mask]` elements this board does draw, so they are compared, not masked.
 */
/** The design-only state switcher at the top of the PhonePair, PhoneBanners and PhoneKeys boards; not part of the app. */
const SWITCHER: Rect = { x: 0, y: 0, width: 390, height: 44 };
/** The composer's Stop button (CV8) in the chat view boards. */
const STOP_BUTTON: Rect = { x: 330, y: 762, width: 56, height: 52 };
const BOARDS: readonly { ref: string; url: string; nav?: boolean; skip?: Rect[]; viewport?: { width: number; height: number }; clip?: Rect; compare?: string }[] = [
  { ref: "PhoneAgentsBasic", url: "/?fixture=basic#/agents" },
  { ref: "PhoneUsage", url: "/?fixture=usage#/usage" },
  { ref: "PhoneMissing", url: "/?fixture=usage#/usage/missing" },
  { ref: "PhoneAgents", url: "/?fixture=agents#/agents" },
  { ref: "PhoneSwarm", url: "/?fixture=swarm#/swarm/sp-1" },
  { ref: "PhonePeek", url: "/?fixture=peek#/swarm/peek/t2%00a9f8e7d6", nav: false },
  // Chat's terminal text, spinner, tile and footer slot (S16's key bar and composer) are masked in the page.
  { ref: "PhoneChat", url: "/?fixture=chat#/chat/a-1", nav: false },
  // PhoneKeys (S16b): the key bar, Keys sheet, typing-time line and ran-out footer are compared; the text stays masked.
  ...(["bar", "menu", "off", "soon", "gone"] as const).map((s) => ({ ref: `PhoneKeys-${s}`, url: `/?fixture=chat&typing=${s}#/chat/a-1`, nav: false, skip: [SWITCHER], compare: ".chat-foot" })),
  // CV4: the chat view, with the timeline strip (CV5b) drawn and compared under the header. The Stop button (CV8) and
  // prompt cards (CV7) are not drawn yet, so those parts are skipped. The other board states (history, off) have
  // items from CV7 and I1 (the answered row) or a different scroll position and are checked by eye (screenshots in
  // the PRs); Codex's notice card is compared.
  { ref: "PhoneChatView-chat", url: "/?fixture=chatview&view=chat#/chat/a-1", nav: false, skip: [SWITCHER, STOP_BUTTON] },
  { ref: "PhoneChatView-new", url: "/?fixture=chatview&view=new#/chat/a-1", nav: false, skip: [SWITCHER] },
  { ref: "PhoneChatView-codex", url: "/?fixture=chatview&view=codex#/chat/a-1", nav: false, skip: [SWITCHER], clip: { x: 0, y: 158, width: 390, height: 72 } },
  // PhoneInbox: the fourth row is the placeholder of an answer the phone saw delivered (demo data seeds it).
  { ref: "PhoneInbox", url: "/?fixture=inbox#/inbox" },
  { ref: "PhoneQuestion", url: "/?fixture=inbox&pick=0#/inbox/q/group%3A123/123", nav: false },
  { ref: "PhoneReview", url: "/?fixture=inbox&inbox=review#/inbox/q/group%3A123/submit", nav: false },
  // S5b: the pairing screen, one ref per board state.
  ...(["check", "wait", "ok", "bad", "first"] as const).map((st) => ({ ref: `PhonePair-${st}`, url: `/?fixture=pair&state=${st}`, nav: false, skip: [SWITCHER] })),
  // "In Safari": the board draws Safari's toolbar under the app (147 px from the tab bar's top down), so the page is
  // as tall as Safari leaves it and the part above the tab bar is compared (the prompt sits 8 px above the tab bar).
  {
    ref: "PhonePair-safari",
    url: "/?fixture=agents&prompt=1#/agents",
    skip: [SWITCHER],
    viewport: { width: 390, height: 786 },
    clip: { x: 0, y: 0, width: 390, height: 697 },
  },
  // S5b: the connection banners with the approved copy.
  ...(["unpaired", "refused", "paused", "unavailable"] as const).map((st) => ({ ref: `PhoneBanners-${st}`, url: `/?fixture=agents&banner=${st}#/agents`, skip: [SWITCHER] })),
];

for (const board of BOARDS) {
  test(`${board.ref} matches the design render`, async ({ page }, info) => {
    const nav = board.nav !== false;
    if (board.viewport) await page.setViewportSize(board.viewport);
    await page.goto(board.url);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector(nav ? ".tabbar" : "[aria-label=Peek], .chat-head, .qn-head, .pair");
    const masks: Rect[] = [
      ...(await page.$$eval("[data-vis-mask]", (els, keep) => {
        // A mask stops where an open sheet starts: the sheet is drawn over it and is compared.
        const sheet = document.querySelector(".keys-sheet")?.getBoundingClientRect();
        return els
          .filter((e) => !(keep && e.matches(keep)) && !e.closest(".keys-sheet"))
          .map((e) => {
            const r = e.getBoundingClientRect();
            const bottom = sheet ? Math.min(r.bottom, sheet.top) : r.bottom;
            return { x: r.x, y: r.y, width: r.width, height: Math.max(0, bottom - r.y) };
          });
      }, board.compare ?? "")),
      ...(board.skip ?? []),
    ];
    const shot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    const diffOut = info.outputPath(`${board.ref}.diff.png`);
    const result = compare(shot, board.ref, masks, diffOut, board.clip);
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
