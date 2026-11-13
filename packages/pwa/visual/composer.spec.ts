import { expect, test } from "@playwright/test";

/**
 * iPhone chat view: the composer is fully visible (nothing clips it), and no text field makes Safari zoom in (iOS Safari
 * zooms into any field whose computed font-size is under 16px). The safe-area hook (`&inset-*`, main.tsx) stands in for
 * the notch and home indicator.
 */
const at = (url: string, top: number, bottom: number) => url.replace(/(#|$)/, (m) => `${url.includes("?") ? "&" : "?"}inset-top=${top}&inset-bottom=${bottom}${m}`);

const CHAT_VIEW = "/?fixture=chatview&view=chat#/chat/a-1";
const CONTROLS = [".chat-text", ".chat-send"];

/** Each control sits inside the window and inside every ancestor that clips (overflow other than visible). */
async function unclipped(page: import("@playwright/test").Page) {
  return page.evaluate((sels) => {
    const out: string[] = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const sel of [".chat-form", ...sels]) {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > w || r.bottom > h) out.push(`${sel} outside the window: ${JSON.stringify(r)}`);
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const pr = p.getBoundingClientRect();
        if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5 || r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) out.push(`${sel} clipped by ${p.className || p.tagName}`);
      }
    }
    return out;
  }, CONTROLS);
}

for (const [name, top, bottom] of [["home indicator", 47, 34], ["Safari tab, no insets", 0, 0]] as const) {
  test(`chat composer is fully visible (${name}), keyboard closed`, async ({ page }) => {
    await page.goto(at(CHAT_VIEW, top, bottom));
    await page.waitForSelector(".chat-form");
    expect(await unclipped(page)).toEqual([]);
    const m = await page.evaluate(() => {
      const f = document.querySelector(".chat-form")!.getBoundingClientRect();
      return { bottom: f.bottom, h: window.innerHeight, send: document.querySelector(".chat-send")!.getBoundingClientRect().bottom, scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight };
    });
    expect(m.bottom).toBe(m.h);
    expect(m.send).toBe(m.h - bottom - 4);
    expect(m.scrolls).toBe(false);
  });
}

test("every text field computes to at least 16px, so iOS never zooms in", async ({ page }) => {
  const sizes: Record<string, number[]> = {};
  const scan = async (label: string) => {
    sizes[label] = await page.$$eval("input, textarea, select", (els) => els.filter((e) => !["checkbox", "radio", "button", "submit", "hidden"].includes((e as HTMLInputElement).type)).map((e) => Number.parseFloat(getComputedStyle(e).fontSize)));
    expect(sizes[label]!.length, `${label}: a text field is on screen`).toBeGreaterThan(0);
  };
  await page.goto(CHAT_VIEW);
  await page.waitForSelector(".chat-text");
  await scan("chat view composer");
  await page.goto("/?fixture=chat&typing=bar#/chat/a-1");
  await page.waitForSelector(".chat-text");
  await scan("text view composer");
  // Inbox: the Other answer (textarea), then the note field under a picked option.
  await page.goto("/?fixture=inbox&pick=0#/inbox/q/group%3A123/123");
  await page.waitForSelector(".qn-input");
  await scan("inbox note");
  // A question ignores taps for a moment after it opens (useArmed): keep tapping until the answer box is there.
  await expect(async () => {
    await page.getByRole("button", { name: /Something else/ }).click();
    await page.waitForSelector("#qn-text", { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await scan("inbox Other");
  // Prompt card: the Other field.
  await page.goto("/?fixture=prompt-cards&state=ask1");
  await page.waitForSelector(".pc-other");
  await scan("prompt card Other");
  for (const [label, list] of Object.entries(sizes)) for (const px of list) expect(px, label).toBeGreaterThanOrEqual(16);
});
