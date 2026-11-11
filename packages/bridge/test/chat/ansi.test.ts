import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { parseAnsi } from "../../src/chat/ansi.js";

const text = (s: string) => parseAnsi(s).lines.map((l) => l.map((x) => x.t).join(""));
const fixture = (n: string) => readFileSync(new URL(`../fixtures/hc/${n}`, import.meta.url), "utf8");

describe("parseAnsi", () => {
  it("splits lines and merges runs of the same style", () => {
    expect(parseAnsi("ab\ncd\n").lines).toEqual([[{ t: "ab" }], [{ t: "cd" }]]);
    expect(parseAnsi("\x1b[31ma\x1b[31mb\x1b[0m").lines).toEqual([[{ t: "ab", fg: 1 }]]);
  });

  it("reads the 16 colours, bright variants, backgrounds and weights", () => {
    expect(parseAnsi("\x1b[1;32mx\x1b[0m\x1b[91my\x1b[44mz").lines).toEqual([
      [{ t: "x", fg: 2, b: true }, { t: "y", fg: 9 }, { t: "z", fg: 9, bg: 4 }],
    ]);
    expect(parseAnsi("\x1b[2;3;4;7mx\x1b[22;23;24;27my").lines).toEqual([[{ t: "x", d: true, i: true, u: true, r: true }, { t: "y" }]]);
  });

  it("reads 256-colour and truecolour; 0-15 stay palette indexes", () => {
    const [[a, b, c, d]] = parseAnsi("\x1b[38;5;5ma\x1b[38;5;208mb\x1b[38;5;244mc\x1b[48;2;1;2;3md").lines as [bridgeApi.ChatSpan[]];
    expect(a).toMatchObject({ fg: 5 });
    expect(b).toMatchObject({ fg: "#ff8700" });
    expect(c).toMatchObject({ fg: "#808080" });
    expect(d).toMatchObject({ fg: "#808080", bg: "#010203" });
  });

  it("ignores out-of-range colours and unknown codes", () => {
    expect(parseAnsi("\x1b[38;5;999mx\x1b[38;2;300;0;0my\x1b[99mz").lines).toEqual([[{ t: "xyz" }]]);
  });

  it("carries style across lines, like a terminal", () => {
    expect(parseAnsi("\x1b[31ma\nb\x1b[0m\nc").lines).toEqual([[{ t: "a", fg: 1 }], [{ t: "b", fg: 1 }], [{ t: "c" }]]);
  });

  it("drops every non-SGR escape and control character", () => {
    expect(text("a\x1b[2Jb\x1b[1;1Hc\x1b[?25ld\x1b(Be\x07f\x08g\rh\x00i\x7fj\x9bk")).toEqual(["abcdefghijk"]);
    expect(text("x\x1b]0;title\x07y\x1b]8;;http://a.example\x1b\\z\x1bPdcs\x1b\\w")).toEqual(["xyzw"]);
  });

  it("copes with a truncated escape at the end", () => {
    expect(text("ok\x1b[3")).toEqual(["ok"]);
    expect(text("ok\x1b")).toEqual(["ok"]);
    expect(text("ok\x1b]0;unterminated")).toEqual(["ok"]);
  });

  it("expands tabs to the next stop", () => {
    expect(text("a\tb")).toEqual(["a       b"]);
  });

  it("drops trailing blank lines and keeps the newest lines when over the cap", () => {
    expect(text("a\n\n\n")).toEqual(["a"]);
    const r = parseAnsi("1\n2\n3\n4\n", { maxLines: 2 });
    expect(r.truncated).toBe(true);
    expect(r.lines.map((l) => l[0]?.t)).toEqual(["3", "4"]);
    expect(parseAnsi("1\n2\n", { maxLines: 2 }).truncated).toBe(false);
  });

  it("keeps markup as literal text, never interpreting it", () => {
    const r = parseAnsi(fixture("read-hostile.ansi"));
    expect(r.lines.map((l) => l.map((x) => x.t).join(""))).toEqual(["plain <script>alert(1)</script> text", "red &amp; link done"]);
  });

  it("produces spans the protocol schema accepts", () => {
    const r = parseAnsi(fixture("read-agent.ansi"));
    expect(bridgeApi.ChatTopic.safeParse({ terminal: "t3", lines: r.lines }).success).toBe(true);
    expect(r.lines[0]?.[0]).toEqual({ t: "●", b: true });
    expect(r.lines[4]?.[0]).toEqual({ t: "●", b: true, fg: "#ff8700" });
  });
});
