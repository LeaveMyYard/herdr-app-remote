import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addBinding, chord, derive, panoramaLayoutSha, removeBinding, sectionFor, usesMod } from "../src/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "app-home");
const main = () => JSON.parse(readFileSync(join(FIX, "main.json"), "utf8"));
type N = { id?: string; children?: N[]; hidden?: boolean; type?: string; floating?: N[] };
const find = (n: N, id: string): N | undefined => (n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean));

describe("derive", () => {
  it("adds the two role blocks and names our mod", () => {
    const d = JSON.parse(derive(JSON.stringify(main()), "main"));
    expect(usesMod(d)).toBe(true);
    expect(usesMod(main())).toBe(false);
    expect(find(d, "remote-link")).toMatchObject({ content: { props: { role: "link" } } });
    expect(find(d, "remote")).toMatchObject({ content: { props: { role: "panel" } } });
  });

  const broken: [string, (m: N) => void, RegExp][] = [
    ["no work column", (m) => (find(m, "work")!.id = "elsewhere"), /no "work" column/],
    ["work is a row", (m) => (find(m, "work")!.type = "row"), /no "work" column/],
    ["work hidden", (m) => (find(m, "work")!.hidden = true), /hides the "work" column/],
    ["an ancestor of work hidden", (m) => (m.hidden = true), /hides the "work" column/],
    ["no panel-body stack", (m) => (find(m, "panel-body")!.type = "column"), /no "panel-body" stack/],
    ["our id taken", (m) => (find(m, "tabs")!.id = "remote-link"), /already has a node with id remote-link/],
    ["our id taken by a floating block", (m) => (m.floating = [{ id: "remote", type: "block" }]), /already has a node with id remote/],
  ];
  it.each(broken)("refuses a layout with %s", (_n, edit, message) => {
    const m = main();
    edit(m);
    expect(() => derive(JSON.stringify(m), "main")).toThrow(message);
  });

  it("refuses non-JSON, non-objects, and a layout that already uses our mod", () => {
    expect(() => derive("{", "main")).toThrow(/not valid JSON/);
    expect(() => derive("[]", "main")).toThrow(/not a layout/);
    expect(() => derive(derive(JSON.stringify(main()), "main"), "main")).toThrow(/already names herdr-app-remote/);
  });
});

describe("panorama's record", () => {
  it("gives the recorded layout hash only for its v2 shape", () => {
    const sha = "ab".repeat(32);
    expect(panoramaLayoutSha(JSON.stringify({ v: 2, files: { "layouts/panorama.json": { sha256: sha, mode: 420 } } }))).toBe(sha);
    expect(panoramaLayoutSha(JSON.stringify({ v: 1, files: { "layouts/panorama.json": sha } }))).toBeNull();
    expect(panoramaLayoutSha(JSON.stringify({ v: 2, files: {} }))).toBeNull();
    expect(panoramaLayoutSha("{")).toBeNull();
    expect(panoramaLayoutSha(null)).toBeNull();
  });
});

describe("key bindings", () => {
  const binding = { key: "ctrl-alt-r", action: "herdr-app-remote.open" as const, sections: [sectionFor("layouts/herdr-remote.json")] };

  it("normalises chords: modifier order and case don't matter, the minus key survives", () => {
    expect(chord("Alt-Ctrl-R")).toBe(chord("ctrl-alt-r"));
    expect(chord("ctrl-alt-r")).not.toBe(chord("ctrl-r"));
    expect(chord("ctrl--")).toBe("ctrl--");
    expect(chord("shift-ctrl--")).toBe(chord("ctrl-shift--"));
  });

  it("names sections after our layouts", () => {
    expect(sectionFor("layouts/herdr-remote.json")).toBe("layout:herdr-remote");
  });

  it("matches keys case-insensitively when checking for a collision", () => {
    expect(() => addBinding(JSON.stringify({ global: { "Ctrl-Alt-R": "tab.new" } }), binding, null)).toThrow(/already bound/);
  });

  it("refuses a keys.json it can't read as sections", () => {
    expect(() => addBinding("[]", binding, null)).toThrow(/not an object/);
    expect(() => addBinding(JSON.stringify({ global: "x" }), binding, null)).toThrow(/section global is not an object/);
  });

  it("removes only its own action and leaves other keys in the section", () => {
    const text = JSON.stringify({ "layout:herdr-remote": { "ctrl-alt-r": "herdr-app-remote.open", "ctrl-alt-x": "tab.new" } });
    expect(JSON.parse(removeBinding(text, binding)!)).toEqual({ "layout:herdr-remote": { "ctrl-alt-x": "tab.new" } });
    expect(removeBinding(JSON.stringify({ global: {} }), binding)).toBeNull();
  });
});
