import { chmodSync, utimesSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import {
  DEFAULT_KEYS,
  deriveId,
  KEYS_DAMAGED_FILE,
  KEYS_FILE,
  KEYS_FILE_MAX_BYTES,
  KEYS_SETTLE_MS,
  KeysMenu,
  loadKeys,
  menuRev,
  menuTopic,
  parseKeysFile,
} from "../../src/terminal/keys-config.js";
import { tmp } from "../plugins/helpers.js";

let dir: string;
beforeEach(() => {
  dir = tmp("s16b-keys-");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
});
afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // already gone
  }
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, KEYS_FILE);
const aside = () => join(dir, KEYS_DAMAGED_FILE);
const write = (v: unknown, mode = 0o644) => {
  writeFileSync(file(), typeof v === "string" ? v : JSON.stringify(v), { mode });
  chmodSync(file(), mode);
};
const mode = (p: string) => statSync(p).mode & 0o777;
const defaults = menuTopic(DEFAULT_KEYS);
/** A clock past the settle time, so an edit in the test is read at once. */
const later = () => Date.now() + 60_000;

describe("default menu", () => {
  it("is valid against the protocol, uses only allowed tokens, and has Esc, Tab, Shift-Tab, Ctrl-C and the arrows", () => {
    expect(bridgeApi.KeysTopic.safeParse(defaults).success).toBe(true);
    expect(DEFAULT_KEYS.flatMap((e) => e.keys)).toEqual(["esc", "tab", "shift+tab", "ctrl+c", "up", "down", "left", "right"]);
  });

  it("matches the protocol fixture fixtures/bridge-api/keys/default.json", () => {
    expect(JSON.parse(readFileSync(new URL("../../../../fixtures/bridge-api/keys/default.json", import.meta.url), "utf8"))).toEqual(defaults);
  });

  it("is used when there is no keys.json, and nothing is written", () => {
    const l = loadKeys(dir);
    expect(l.topic).toEqual(defaults);
    expect(l.load).toEqual({ state: "default" });
    expect(existsSync(file())).toBe(false);
  });
});

describe("keys.json", () => {
  it("is loaded, given derived ids where it has none, and made 0600", () => {
    write({ v: 1, keys: [{ label: "Ctrl-C", keys: ["ctrl+c"] }, { id: "twice-up", label: "↑↑", keys: ["up", "up"] }, { label: "Up Up", keys: ["up", "up"] }] });
    const l = loadKeys(dir);
    expect(l.load).toEqual({ state: "loaded", entries: 3 });
    expect(l.topic.keys).toEqual([
      { id: "ctrl-c", label: "Ctrl-C", keys: ["ctrl+c"] },
      { id: "twice-up", label: "↑↑", keys: ["up", "up"] },
      { id: "up_up", label: "Up Up", keys: ["up", "up"] },
    ]);
    expect(bridgeApi.KeysTopic.safeParse(l.topic).success).toBe(true);
    expect(mode(file())).toBe(0o600);
    expect(existsSync(aside())).toBe(false);
  });

  it("an empty list is an empty menu, not the default", () => {
    write({ v: 1, keys: [] });
    expect(loadKeys(dir).topic.keys).toEqual([]);
  });

  it("the rev changes with any id, label or key, and only then", () => {
    const base = [{ id: "esc", label: "Esc", keys: ["esc"] }];
    expect(menuRev(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(menuRev(base)).toBe(menuRev([{ id: "esc", label: "Esc", keys: ["esc"] }]));
    expect(menuRev([{ ...base[0]!, id: "esc2" }])).not.toBe(menuRev(base));
    expect(menuRev([{ ...base[0]!, label: "Escape" }])).not.toBe(menuRev(base));
    expect(menuRev([{ ...base[0]!, keys: ["tab"] }])).not.toBe(menuRev(base));
    expect(menuRev([...base, ...base])).not.toBe(menuRev(base));
  });

  it("deriveId reads + as - and joins keys with _", () => {
    expect(deriveId(["ctrl+c"])).toBe("ctrl-c");
    expect(deriveId(["shift+tab"])).toBe("shift-tab");
    expect(deriveId(["esc", "ctrl+alt+x"])).toBe("esc_ctrl-alt-x");
  });
});

describe("a damaged keys.json is set aside, never fatal and never used", () => {
  const cases: [string, unknown, string][] = [
    ["not JSON", "{ v: 1, keys: [", "bad_json"],
    ["wrong version", { v: 2, keys: [] }, "invalid"],
    ["an unknown field", { v: 1, keys: [], run: "rm -rf x" }, "invalid"],
    ["an unknown entry field", { v: 1, keys: [{ label: "x", keys: ["esc"], exec: "id" }] }, "invalid"],
    ["a bare letter (text)", { v: 1, keys: [{ label: "A", keys: ["a"] }] }, "invalid"],
    ["a shifted letter (text)", { v: 1, keys: [{ label: "A", keys: ["shift+a"] }] }, "invalid"],
    ["ctrl+digit (types the digit)", { v: 1, keys: [{ label: "0", keys: ["ctrl+0"] }] }, "invalid"],
    ["a word", { v: 1, keys: [{ label: "hi", keys: ["hello"] }] }, "invalid"],
    ["hc's other spelling", { v: 1, keys: [{ label: "Esc", keys: ["Escape"] }] }, "invalid"],
    ["a flag", { v: 1, keys: [{ label: "f", keys: ["--force"] }] }, "invalid"],
    ["a shell string", { v: 1, keys: [{ label: "s", keys: ["$(id)"] }] }, "invalid"],
    ["keys as a string", { v: 1, keys: [{ label: "s", keys: "ctrl+c" }] }, "invalid"],
    ["no keys", { v: 1, keys: [{ label: "none", keys: [] }] }, "invalid"],
    ["too many keys", { v: 1, keys: [{ label: "many", keys: Array(9).fill("up") }] }, "invalid"],
    ["too many entries", { v: 1, keys: Array.from({ length: 33 }, (_, i) => ({ id: `k${i}`, label: "x", keys: ["esc"] })) }, "invalid"],
    ["a long label", { v: 1, keys: [{ label: "x".repeat(25), keys: ["esc"] }] }, "invalid"],
    ["an empty label", { v: 1, keys: [{ label: "", keys: ["esc"] }] }, "invalid"],
    ["a label with a newline", { v: 1, keys: [{ label: "a\nb", keys: ["esc"] }] }, "invalid"],
    ["a label with a bidi override", { v: 1, keys: [{ label: "a\u202eb", keys: ["esc"] }] }, "invalid"],
    ["a bad id", { v: 1, keys: [{ id: "Ctrl C", label: "x", keys: ["esc"] }] }, "invalid"],
    ["a duplicate id", { v: 1, keys: [{ label: "x", keys: ["esc"] }, { id: "esc", label: "y", keys: ["tab"] }] }, "duplicate_id"],
    ["a derived id that is too long", { v: 1, keys: [{ label: "x", keys: Array(8).fill("ctrl+alt+shift+pagedown") }] }, "id_too_long"],
  ];
  for (const [name, content, reason] of cases) {
    it(name, () => {
      write(content);
      const l = loadKeys(dir);
      expect(l.load).toMatchObject({ state: "damaged", reason, setAside: true });
      expect(l.topic).toEqual(defaults);
      expect(existsSync(file())).toBe(false);
      expect(mode(aside())).toBe(0o600);
      expect(readFileSync(aside(), "utf8")).toBe(typeof content === "string" ? content : JSON.stringify(content));
    });
  }

  it("says where the problem is by index and field name only, never the file's words", () => {
    write({ v: 1, keys: [{ label: "Esc", keys: ["esc"] }, { label: "secret words", keys: ["esc", "hello"] }] });
    const l = loadKeys(dir);
    expect(l.load).toEqual({ state: "damaged", reason: "invalid", where: "keys[1].keys[1]", setAside: true });
    write({ v: 1, keys: [], "secret-field": 1 });
    expect(JSON.stringify(loadKeys(dir).load)).not.toContain("secret");
    expect(parseKeysFile({ v: 1, keys: [{ label: "x", keys: ["esc"], "secret-field": 1 }] })).toEqual({ ok: false, reason: "invalid", where: "keys[0]" });
  });

  it("a newer damaged file replaces the older one", () => {
    write("first");
    loadKeys(dir);
    write("second");
    loadKeys(dir);
    expect(readFileSync(aside(), "utf8")).toBe("second");
  });

  it("over 64 KiB is not read", () => {
    write(JSON.stringify({ v: 1, keys: [] }) + " ".repeat(KEYS_FILE_MAX_BYTES));
    expect(loadKeys(dir).load).toMatchObject({ state: "damaged", reason: "too_large" });
  });

  it("a symlink is moved aside as a link, and its target is neither read nor touched", () => {
    const target = join(dir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ v: 1, keys: [{ label: "Esc", keys: ["esc"] }] }), { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, file());
    const l = loadKeys(dir);
    expect(l.load).toMatchObject({ state: "damaged", reason: "not_a_file", setAside: true });
    expect(l.topic).toEqual(defaults);
    expect(lstatSync(aside()).isSymbolicLink()).toBe(true);
    expect(mode(target)).toBe(0o644);
  });

  it("a directory is moved aside", () => {
    mkdirSync(file());
    expect(loadKeys(dir).load).toMatchObject({ state: "damaged", reason: "not_a_file", setAside: true });
  });

  it("a file that can't be moved is still not used, and is not re-read until it changes", () => {
    if (process.getuid?.() === 0) return; // root ignores the directory's mode
    write("{ broken");
    chmodSync(dir, 0o500);
    const onLoad = vi.fn();
    const menu = new KeysMenu(dir, onLoad, later);
    expect(menu.load).toMatchObject({ state: "damaged", reason: "bad_json", setAside: false });
    expect(menu.current()).toEqual(defaults);
    expect(menu.refresh()).toBe(false);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});

describe("KeysMenu", () => {
  it("re-reads keys.json when it changes and reports each load", () => {
    const onLoad = vi.fn();
    const menu = new KeysMenu(dir, onLoad, later);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(menu.current()).toEqual(defaults);
    expect(menu.refresh()).toBe(false);

    write({ v: 1, keys: [{ label: "Esc", keys: ["esc"] }] });
    expect(menu.refresh()).toBe(true);
    expect(menu.current().keys).toEqual([{ id: "esc", label: "Esc", keys: ["esc"] }]);
    expect(onLoad).toHaveBeenCalledTimes(2);

    // Damaged later: set aside, back to the default menu.
    write("nope");
    const rev = menu.current().rev;
    expect(rev).toBe(defaults.rev);
    expect(menu.load).toMatchObject({ state: "damaged", reason: "bad_json" });
    expect(onLoad).toHaveBeenCalledTimes(3);

    // Removed: the default menu, no report when nothing changed.
    rmSync(aside());
    expect(menu.refresh()).toBe(false);
    expect(onLoad).toHaveBeenCalledTimes(3);
  });

  it("a file changed less than a second ago is left for a later look (an in-place save may be half-written)", () => {
    let clock = Date.now();
    const onLoad = vi.fn();
    const menu = new KeysMenu(dir, onLoad, () => clock);
    // Truncated by an editor that saves in place: not read yet, so not set aside.
    write("");
    clock = Date.now() + 10;
    expect(menu.refresh()).toBe(false);
    expect(existsSync(file())).toBe(true);
    write({ v: 1, keys: [{ label: "Esc", keys: ["esc"] }] });
    clock = Date.now() + 10;
    expect(menu.current()).toEqual(defaults);
    clock += KEYS_SETTLE_MS + 2_000;
    expect(menu.refresh()).toBe(true);
    expect(menu.current().keys.map((k) => k.id)).toEqual(["esc"]);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it("a file stamped in the future is read at once, not waited for", () => {
    // ctime is set by the kernel to now, so the clock is past its settle time; mtime is an hour ahead.
    const menu = new KeysMenu(dir, undefined, () => Date.now() + KEYS_SETTLE_MS + 1_000);
    write({ v: 1, keys: [{ label: "Esc", keys: ["esc"] }] });
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(file(), future, future);
    expect(menu.refresh()).toBe(true);
    expect(menu.current().keys.map((k) => k.id)).toEqual(["esc"]);
  });

  it("a listener that throws changes nothing", () => {
    const menu = new KeysMenu(dir, () => {
      throw new Error("listener");
    }, later);
    expect(menu.current()).toEqual(defaults);
  });
});
