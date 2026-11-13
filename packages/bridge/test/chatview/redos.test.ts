// Every pattern the chat view runs over agent or user text, against adversarial input. These run synchronously on
// the bridge's main thread for every read, so each must stay linear: a regression to backtracking fails here.
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { label, mapMessages, messageText, stripBlock, userText } from "../../src/chatview/map.js";
import { redact } from "../../src/chatview/redact.js";
import { agent, tool, user } from "./helpers.js";

const MB = 1024 * 1024;
/** Milliseconds `f` takes (best of 2, so a GC pause doesn't fail it). */
function ms(f: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe("no catastrophic backtracking (H2)", () => {
  it("200 tagged sections followed by text map in under 50 ms (the ONLY_TAGS case)", () => {
    const html = Array.from({ length: 200 }, (_, i) => `<li>item ${i}</li>`).join("") + "\nwhy?";
    expect(ms(() => userText([html]))).toBeLessThan(50);
    expect(userText([html])).toEqual({ kept: [html.trim()] });
    const chain = "<a>" + "x</a><a>".repeat(200) + "x</a> z";
    expect(ms(() => userText([chain]))).toBeLessThan(50);
  });

  it.each([
    ["unclosed opens", "<a".repeat(MB / 2)],
    ["opens with attributes, never closed", "<x ".repeat(MB / 3)],
    ["opens with a long attribute", ("<a " + "b".repeat(5000)).repeat(200)],
    ["closed opens", "<a>".repeat(MB / 3)],
    ["unmatched closes", "</a>".repeat(MB / 4)],
    ["wrapper opens", "<system-reminder>".repeat(MB / 17)],
    ["nested sections", "<a>".repeat(20_000) + "x" + "</a>".repeat(20_000)],
    ["angle brackets", "<<<>>>".repeat(MB / 6)],
  ])("a 1 MB user block of %s is scanned in under 300 ms", (_name, text) => {
    expect(ms(() => stripBlock(text))).toBeLessThan(300);
    expect(ms(() => mapMessages([user(1, text)]))).toBeLessThan(300);
  });

  it.each([
    ["sk-ant- runs", "sk-ant-".repeat(MB / 7)],
    ["a key-like run", "sk-ant-" + "a".repeat(MB)],
    ["PEM BEGINs with no END", "-----BEGIN RSA PRIVATE KEY-----\n".repeat(MB / 32)],
    ["PEM-ish prefixes", "-----BEGIN ".repeat(MB / 11)],
    ["ghp_ runs", "ghp_".repeat(MB / 4)],
    ["AKIA runs", "AKIA".repeat(MB / 4)],
    ["xoxb- runs", "xoxb-".repeat(MB / 5)],
    ["Authorization headers", "Authorization: Bearer ".repeat(MB / 22)],
    ["Authorization with spaces", "Authorization" + " ".repeat(MB)],
    ["Bearer and spaces", ("Bearer" + " ".repeat(1000)).repeat(1000)],
  ])("redaction of 1 MB of %s takes under 300 ms", (_name, text) => {
    expect(ms(() => redact(text))).toBeLessThan(300);
  });

  it("labels, cuts and tool rows stay linear on 1 MB", () => {
    const ws = " \t\n".repeat(MB / 3);
    expect(ms(() => label(ws + "x", 200))).toBeLessThan(300);
    expect(ms(() => messageText(["😀".repeat(MB / 2)]))).toBeLessThan(300);
    const name = "mcp__" + "herdr-inbox_".repeat(10_000) + "__ask";
    expect(ms(() => mapMessages([agent(1, [tool("t", name, { file_path: "/w/" + "a/".repeat(MB / 4) })])]))).toBeLessThan(300);
    expect(bridgeApi.CHATVIEW_TEXT_MAX_BYTES).toBe(16 * 1024);
  });
});

describe("tag scanning (L8, L9)", () => {
  it("a nested same-name wrapper hides its whole span; a stray wrapper close hides the block", () => {
    expect(userText(["hi <system-reminder>a<system-reminder>b</system-reminder>LEAK</system-reminder>"])).toEqual({ kept: ["hi"] });
    expect(userText(["LEAK</system-reminder> after"])).toBe("hidden");
  });

  it("matches tag names in any case and up to 64 characters", () => {
    expect(userText(["<System-Reminder>HOOKCTX</System-Reminder>ok"])).toEqual({ kept: ["ok"] });
    const long = `ide_${"x".repeat(50)}`;
    expect(userText([`<${long}>HOOKCTX</${long}>ok`])).toEqual({ kept: ["ok"] });
  });
});
