// Installer tests. Every one runs in a temp app home built from fixtures/app-home (fake data); none
// touches a real app home, runs herdr-app, or runs tailscale. The fake `herdr-app` and `tailscale`
// below only record their arguments.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { install as P } from "@herdr-remote/protocol";
import { checkBundle } from "@herdr-remote/bridge";
import { DEFAULT_SOURCE, LINK_BLOCK, PANEL_BLOCK, run } from "../src/index.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = join(REPO, "fixtures", "app-home");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface World {
  home: string;
  bin: string;
  log: string;
  /** What the fake herdr-app says to `status`: stdout and exit code. */
  says(stdout: string, code?: number): void;
  calls(): string[];
}

/** A temp app home like a real one after herdr-app's first start, with panorama installed. */
function world(o: { panorama?: boolean | "edited"; keys?: boolean } = {}): World {
  const root = tmp("ri-"); // short: the app socket path must fit in sun_path
  const home = join(root, "h");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(join(home, "layouts"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(FIX, "main.json"), join(home, "layouts/main.json"));
  copyFileSync(join(FIX, "settings.json"), join(home, "settings.json"));
  if (o.keys !== false) copyFileSync(join(FIX, "keys.json"), join(home, "keys.json"));
  if (o.panorama !== false) {
    copyFileSync(join(FIX, "panorama.json"), join(home, "layouts/panorama.json"));
    mkdirSync(join(home, "data/panorama"), { recursive: true });
    const recorded = sha(readFileSync(join(FIX, "panorama.json")));
    const receipt = { v: 2, install_id: "fedcba9876543210fedcba9876543210", files: { "layouts/panorama.json": { sha256: recorded, mode: 0o644 } }, dirs: [], keys: null };
    writeFileSync(join(home, "data/panorama/install.json"), JSON.stringify(receipt), { mode: 0o600 });
    if (o.panorama === "edited") writeFileSync(join(home, "layouts/panorama.json"), readFileSync(join(FIX, "panorama.json"), "utf8").replace("368", "400"));
  }
  for (const name of ["herdr-app", "tailscale"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n[ "${name}" = herdr-app ] || exit 0\ncat '${root}/says' 2>/dev/null\nexit $(cat '${root}/code' 2>/dev/null || echo 2)\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return {
    home,
    bin,
    log,
    says(stdout, code = 0) {
      writeFileSync(join(root, "says"), stdout);
      writeFileSync(join(root, "code"), String(code));
    },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []),
  };
}

/** Every path under the home -> sha256 and mode (folders: "dir" and mode). */
function tree(home: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(home, rel)).sort()) {
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(home, p));
    if (st.isSymbolicLink()) out[p] = `link`;
    else if (st.isDirectory()) {
      out[p] = `dir ${(st.mode & 0o777).toString(8)}`;
      Object.assign(out, tree(home, p));
    } else out[p] = `${sha(readFileSync(join(home, p)))} ${(st.mode & 0o777).toString(8)}`;
  }
  return out;
}

/** The files the installer must never change, by hash. */
function shipped(w: World): Record<string, string> {
  const t = tree(w.home);
  return Object.fromEntries(Object.entries(t).filter(([p]) => ["layouts/main.json", "layouts/panorama.json", "data/panorama/install.json", "settings.json", "keys.json"].includes(p)));
}

let out: string[] = [];
let err = "";
async function cli(w: World, ...args: string[]): Promise<number> {
  out = [];
  err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const action = args[0]!;
    const checker = action === "uninstall" && !args.includes("--checker") ? ["--checker", join(w.bin, "herdr-app")] : [];
    return await run([...args, "--app-home", w.home, ...checker], { source: DEFAULT_SOURCE, log: (l) => out.push(l), which: () => null });
  } finally {
    process.stderr.write = write;
  }
}

const json = (w: World, p: string) => JSON.parse(readFileSync(join(w.home, p), "utf8"));

describe("install", () => {
  it("installs the mod, the bundle, the record and both derived layouts", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    expect(out[0]).toMatch(/^Installed herdr-app-remote, with layouts herdr-remote and panorama-remote\. No layout was selected/);
    const t = tree(w.home);
    for (const f of readdirSync(join(REPO, "mod/herdr-app-remote"))) {
      expect(t[`mods/herdr-app-remote/${f}`]).toBe(`${sha(readFileSync(join(REPO, "mod/herdr-app-remote", f)))} 644`);
    }
    // the tab icon is part of the mod, so it is copied and recorded like the rest
    expect(t["mods/herdr-app-remote/remote.svg"]).toBe(`${sha(readFileSync(join(REPO, "mod/herdr-app-remote/remote.svg")))} 644`);
    expect(t[`${P.PWA_DIR}/index.html`]).toBe(`${sha(readFileSync(join(REPO, "packages/pwa/dist/index.html")))} 644`);
    expect(t[P.BUNDLE_PATH]).toBe(`${sha(readFileSync(join(REPO, "packages/bridge/dist/bridge.mjs")))} 644`);
    expect(t[P.READER_PATH]).toBe(`${sha(readFileSync(join(REPO, "packages/bridge/dist/claude-reader.mjs")))} 644`);
    expect(t[P.DATA_DIR]).toBe("dir 700");
    expect(t[P.RECEIPT_PATH]).toMatch(/ 600$/);
    const record = P.InstallReceipt.parse(json(w, P.RECEIPT_PATH));
    expect(record.node).toBe(process.execPath);
    expect(record.previous).toEqual({});
    expect(record.keys).toBeNull();
    // the record names exactly what was written, with each file's hash and mode
    for (const [p, f] of Object.entries(record.files)) expect(t[p]).toBe(`${f.sha256} ${f.mode.toString(8)}`);
    expect(Object.keys(record.files).sort()).toEqual(Object.keys(t).filter((p) => t[p] !== undefined && !t[p]!.startsWith("dir") && (p.startsWith("mods/") || p.startsWith(`${P.DATA_DIR}/bin`) || p.startsWith(`${P.PWA_DIR}/`) || p.endsWith("-remote.json"))).sort());
    // the bridge accepts the installed bundle
    expect(await checkBundle(w.home, join(w.home, P.BUNDLE_PATH))).toMatchObject({ ok: true });
  });

  it("derives each layout by adding only the link block (last in work, 1 px) and the panel block (in panel-body)", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    for (const [derived, source] of [[P.LAYOUT_REMOTE, "main.json"], [P.LAYOUT_PANORAMA_REMOTE, "panorama.json"]] as const) {
      const d = json(w, derived);
      const find = (n: { id?: string; children?: unknown[] }, id: string): { children: unknown[]; active?: string } | undefined =>
        n.id === id ? (n as never) : (n.children ?? []).map((c) => find(c as never, id)).find(Boolean);
      const work = find(d, "work")!;
      expect(work.children.at(-1)).toEqual(LINK_BLOCK);
      expect(LINK_BLOCK).toEqual({ id: "remote-link", type: "block", size: { px: 1 }, content: { mod: "herdr-app-remote", props: { role: "link" } } });
      const stack = find(d, "panel-body")!;
      expect(stack.children.at(-1)).toEqual(PANEL_BLOCK);
      expect(PANEL_BLOCK.content.props.role).toBe("panel");
      expect(stack.active).toBe("files");
      work.children.pop();
      stack.children.pop();
      expect(d).toEqual(JSON.parse(readFileSync(join(FIX, source), "utf8")));
    }
  });

  it("leaves the shipped layout, panorama's layout and record, settings and keys byte for byte unchanged", async () => {
    const w = world();
    const before = shipped(w);
    expect(Object.keys(before)).toHaveLength(5);
    expect(await cli(w, "install")).toBe(0);
    expect(shipped(w)).toEqual(before);
    expect(await cli(w, "install")).toBe(0);
    expect(shipped(w)).toEqual(before);
    expect(await cli(w, "uninstall")).toBe(0);
    expect(shipped(w)).toEqual(before);
  });

  it("selects nothing: never runs herdr-app or tailscale, and writes no settings, view or shared state", async () => {
    const w = world();
    const before = tree(w.home);
    expect(await cli(w, "install")).toBe(0);
    expect(w.calls()).toEqual([]);
    const after = tree(w.home);
    for (const p of Object.keys(after).filter((p) => !(p in before))) {
      expect(p.startsWith("mods") || p.startsWith("data/herdr-app-remote") || p === P.LAYOUT_REMOTE || p === P.LAYOUT_PANORAMA_REMOTE, p).toBe(true);
    }
    for (const p of Object.keys(before)) expect(after[p], p).toBe(before[p]);
    expect(out.join("\n")).not.toMatch(/tailscale/i);
  });

  it("is idempotent: a second install changes nothing, record included", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const first = tree(w.home);
    const record = readFileSync(join(w.home, P.RECEIPT_PATH), "utf8");
    expect(await cli(w, "install")).toBe(0);
    expect(out[0]).toMatch(/^Upgraded/);
    expect(tree(w.home)).toEqual(first);
    expect(readFileSync(join(w.home, P.RECEIPT_PATH), "utf8")).toBe(record);
  });

  it("upgrades in place: new bytes replace ours, files the new version dropped go, the id stays", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const id = json(w, P.RECEIPT_PATH).install_id;
    // pretend the last install was an older version with one more file and an older main.js
    const rec = json(w, P.RECEIPT_PATH);
    writeFileSync(join(w.home, "mods/herdr-app-remote/old.js"), "// gone in this version\n");
    rec.files["mods/herdr-app-remote/old.js"] = { sha256: sha("// gone in this version\n"), mode: 0o644 };
    writeFileSync(join(w.home, "mods/herdr-app-remote/main.js"), "// older main\n");
    rec.files["mods/herdr-app-remote/main.js"].sha256 = sha("// older main\n");
    writeFileSync(join(w.home, P.RECEIPT_PATH), JSON.stringify(rec), { mode: 0o600 });
    expect(await cli(w, "install")).toBe(0);
    expect(existsSync(join(w.home, "mods/herdr-app-remote/old.js"))).toBe(false);
    expect(readFileSync(join(w.home, "mods/herdr-app-remote/main.js"))).toEqual(readFileSync(join(REPO, "mod/herdr-app-remote/main.js")));
    expect(json(w, P.RECEIPT_PATH).install_id).toBe(id);
    expect(json(w, P.RECEIPT_PATH).files["mods/herdr-app-remote/old.js"]).toBeUndefined();
  });

  it("takes the files herdr-app writes into the mod folder as ours, only at its top level", async () => {
    const w = world();
    const before = tree(w.home);
    expect(await cli(w, "install")).toBe(0);
    // what the app writes into every mod folder it loads (editor support)
    writeFileSync(join(w.home, P.MOD_DIR, "gpui-kit.d.ts"), "// written by the app\n");
    writeFileSync(join(w.home, P.MOD_DIR, "jsconfig.json"), "{}\n");
    expect(await cli(w, "install")).toBe(0);
    writeFileSync(join(w.home, P.MOD_DIR, "jsconfig.json"), "{}\n");
    mkdirSync(join(w.home, P.MOD_DIR, "sub"));
    writeFileSync(join(w.home, P.MOD_DIR, "sub", "jsconfig.json"), "{}\n");
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(/would be lost, nothing changed: mods\/herdr-app-remote\/sub\/jsconfig.json$/m);
    rmSync(join(w.home, P.MOD_DIR, "sub"), { recursive: true });
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out.filter((l) => l.startsWith("Kept"))).toEqual([]);
    expect(tree(w.home)).toEqual(before);
  });

  it("an upgrade drops PWA files the new build no longer has, and their empty folders", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const good = tree(w.home);
    const old = `${P.PWA_DIR}/assets/old-chunk/index-abc123.js`;
    mkdirSync(join(w.home, dirname(old)), { recursive: true });
    writeFileSync(join(w.home, old), "// last build\n");
    const rec = json(w, P.RECEIPT_PATH);
    rec.files[old] = { sha256: sha("// last build\n"), mode: 0o644 };
    writeFileSync(join(w.home, P.RECEIPT_PATH), JSON.stringify(rec), { mode: 0o600 });
    expect(await cli(w, "install")).toBe(0);
    expect(tree(w.home)).toEqual(good);
  });

  it("finishes after a crash between the two folder renames", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const good = tree(w.home);
    mkdirSync(join(w.home, P.STAGE_PATH), { recursive: true });
    renameSync(join(w.home, P.MOD_DIR), join(w.home, P.STAGE_PATH, "old"));
    expect(await cli(w, "install")).toBe(0);
    expect(tree(w.home)).toEqual(good);
  });

  it("takes no layout from panorama when its layout differs from panorama's record", async () => {
    const w = world({ panorama: "edited" });
    const before = shipped(w);
    expect(await cli(w, "install")).toBe(0);
    expect(existsSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE))).toBe(false);
    expect(out.join("\n")).toMatch(/No panorama-remote layout: layouts\/panorama.json differs from panorama's install record/);
    expect(shipped(w)).toEqual(before);
  });

  it("skips panorama-remote, and still installs, when panorama's layout can't take the blocks", async () => {
    const w = world();
    const changed = readFileSync(join(FIX, "panorama.json"), "utf8").replace('"id": "panel-body"', '"id": "panel-stack"');
    writeFileSync(join(w.home, "layouts/panorama.json"), changed);
    const rec = json(w, "data/panorama/install.json");
    rec.files["layouts/panorama.json"].sha256 = sha(changed);
    writeFileSync(join(w.home, "data/panorama/install.json"), JSON.stringify(rec), { mode: 0o600 });
    expect(await cli(w, "install")).toBe(0);
    expect(existsSync(join(w.home, P.LAYOUT_REMOTE))).toBe(true);
    expect(existsSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE))).toBe(false);
    expect(out.join("\n")).toMatch(/No panorama-remote layout: layouts\/panorama.json has no "panel-body" stack/);
  });

  it("makes only herdr-remote without panorama", async () => {
    const w = world({ panorama: false });
    expect(await cli(w, "install")).toBe(0);
    expect(existsSync(join(w.home, P.LAYOUT_REMOTE))).toBe(true);
    expect(existsSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE))).toBe(false);
    expect(out.join("\n")).toMatch(/panorama is not installed/);
  });

  it("keeps the earlier panorama-remote when panorama's layout no longer matches its record", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const derived = readFileSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE));
    writeFileSync(join(w.home, "layouts/panorama.json"), "{}");
    expect(await cli(w, "install")).toBe(0);
    expect(readFileSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE))).toEqual(derived);
    expect(out.join("\n")).toMatch(/Kept panorama-remote from the last install/);
    expect(json(w, P.RECEIPT_PATH).files[P.LAYOUT_PANORAMA_REMOTE].sha256).toBe(sha(derived));
  });

  it("needs the app's own main layout", async () => {
    const w = world();
    rmSync(join(w.home, "layouts/main.json"));
    const before = tree(w.home);
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(/layouts\/main.json is missing/);
    expect(tree(w.home)).toEqual(before);
  });

  it("refuses a node older than 22", async () => {
    const w = world();
    const old = join(w.bin, "node-20");
    writeFileSync(old, "#!/bin/sh\necho v20.11.0\n");
    chmodSync(old, 0o755);
    const before = tree(w.home);
    expect(await cli(w, "install", "--node", old)).toBe(1);
    expect(err).toMatch(/needs node >= 22/);
    expect(tree(w.home)).toEqual(before);
  });
});

describe("crash safety", () => {
  const root = typeof process.getuid === "function" && process.getuid() === 0;

  /** An installed home whose record and mod folder look like an older version's. */
  async function olderInstalled(w: World) {
    expect(await cli(w, "install")).toBe(0);
    const rec = json(w, P.RECEIPT_PATH);
    writeFileSync(join(w.home, "mods/herdr-app-remote/old.js"), "// gone in this version\n");
    rec.files["mods/herdr-app-remote/old.js"] = { sha256: sha("// gone in this version\n"), mode: 0o644 };
    writeFileSync(join(w.home, "mods/herdr-app-remote/main.js"), "// older main\n");
    rec.files["mods/herdr-app-remote/main.js"].sha256 = sha("// older main\n");
    writeFileSync(join(w.home, P.RECEIPT_PATH), JSON.stringify(rec), { mode: 0o600 });
  }

  /** Runs an upgrade that fails after the journal is saved, before the mod folder is replaced. */
  async function crashedUpgrade(w: World) {
    chmodSync(join(w.home, "mods"), 0o555); // the rename out of mods/ fails: EACCES
    try {
      expect(await cli(w, "install")).toBe(1);
    } finally {
      chmodSync(join(w.home, "mods"), 0o755);
    }
    const rec = json(w, P.RECEIPT_PATH);
    expect(rec.previous["mods/herdr-app-remote/main.js"]).toContain(sha("// older main\n")); // the journal
    expect(readFileSync(join(w.home, "mods/herdr-app-remote/main.js"), "utf8")).toBe("// older main\n");
  }

  it.skipIf(root)("an upgrade that dies after the journal is finished by a re-run", async () => {
    const w = world();
    await olderInstalled(w);
    await crashedUpgrade(w);
    expect(await cli(w, "install")).toBe(0);
    const clean = world();
    expect(await cli(clean, "install")).toBe(0);
    const strip = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([p]) => p !== P.RECEIPT_PATH));
    expect(strip(tree(w.home))).toEqual(strip(tree(clean.home)));
    expect(json(w, P.RECEIPT_PATH).previous).toEqual({});
  });

  it.skipIf(root)("an upgrade that dies after the journal can be uninstalled cleanly", async () => {
    const w = world();
    const before = tree(w.home);
    await olderInstalled(w);
    await crashedUpgrade(w);
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out.filter((l) => l.startsWith("Kept"))).toEqual([]);
    expect(tree(w.home)).toEqual(before);
  });

  it.skipIf(root)("a first install that fails part-way leaves the home as it was", async () => {
    const w = world();
    const before = tree(w.home);
    chmodSync(join(w.home, "layouts"), 0o555); // the derived layouts are written after the mod folder
    try {
      expect(await cli(w, "install")).toBe(1);
    } finally {
      chmodSync(join(w.home, "layouts"), 0o755);
    }
    expect(tree(w.home)).toEqual(before);
  });

  it("never removes a lock that is not its own", async () => {
    const w = world();
    const other = `${process.pid} someone-else\n`;
    // another run takes the lock while this one works: simulated from inside the log callback
    const code = await run(["install", "--app-home", w.home], {
      source: DEFAULT_SOURCE, which: () => null,
      log: () => writeFileSync(join(w.home, ".herdr-app-remote-install.lock"), other),
    });
    expect(code).toBe(0);
    expect(readFileSync(join(w.home, ".herdr-app-remote-install.lock"), "utf8")).toBe(other);
  });

  it("uninstall finishes even when keys.json can't be read, and says so", async () => {
    const w = world();
    expect(await cli(w, "install", "--key", "ctrl-alt-r")).toBe(0);
    renameSync(join(w.home, "keys.json"), join(w.home, "keys.real.json"));
    symlinkSync(join(w.home, "keys.real.json"), join(w.home, "keys.json"));
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out.some((l) => l.startsWith("Kept, not ours: keys.json (could not read it"))).toBe(true);
    expect(existsSync(join(w.home, P.RECEIPT_PATH))).toBe(false);
    expect(existsSync(join(w.home, P.MOD_DIR))).toBe(false);
  });

  it("takes over a lock whose installer is gone, never a live one", async () => {
    const w = world();
    writeFileSync(join(w.home, ".herdr-app-remote-install.lock"), `${2 ** 22 + 12345}\n`);
    expect(await cli(w, "install")).toBe(0);
    expect(existsSync(join(w.home, ".herdr-app-remote-install.lock"))).toBe(false);
    writeFileSync(join(w.home, ".herdr-app-remote-install.lock"), `${process.pid}\n`);
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(/another install is running/);
  });
});

describe("collisions are refused before the first write", () => {
  const cases: [string, (w: World) => void, RegExp][] = [
    ["a mod folder with no record", (w) => (mkdirSync(join(w.home, P.MOD_DIR), { recursive: true }), writeFileSync(join(w.home, P.MOD_DIR, "main.js"), "// someone else's\n")), /Name collision: mods\/herdr-app-remote/],
    ["a herdr-remote layout of someone else's", (w) => writeFileSync(join(w.home, P.LAYOUT_REMOTE), "{}"), /Name collision: layouts\/herdr-remote.json is not ours/],
    ["a panorama-remote layout of someone else's", (w) => writeFileSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE), "{}"), /Name collision: layouts\/panorama-remote.json is not ours/],
    ["foreign files in our data folder", (w) => (mkdirSync(join(w.home, P.DATA_DIR), { recursive: true }), writeFileSync(join(w.home, P.DATA_DIR, "notes.txt"), "x")), /holds files that are not ours \(notes.txt\)/],
    ["mods as a file", (w) => writeFileSync(join(w.home, "mods"), ""), /Name collision: mods is not a folder/],
    ["a link where the mod folder goes", (w) => (mkdirSync(join(w.home, "mods")), symlinkSync(join(w.home, "layouts"), join(w.home, P.MOD_DIR))), /Name collision: mods\/herdr-app-remote is not a folder/],
    ["a link where our layout goes", (w) => symlinkSync(join(w.home, "layouts/main.json"), join(w.home, P.LAYOUT_REMOTE)), /Name collision: layouts\/herdr-remote.json is not ours/],
  ];
  it.each(cases)("%s", async (_name, setup, message) => {
    const w = world();
    setup(w);
    const before = tree(w.home);
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(message);
    expect(tree(w.home)).toEqual(before);
  });

  it("an edited mod file or derived layout stops an upgrade", async () => {
    for (const edit of [`${P.MOD_DIR}/main.js`, P.LAYOUT_REMOTE]) {
      const w = world();
      expect(await cli(w, "install")).toBe(0);
      writeFileSync(join(w.home, edit), "// mine now\n");
      const before = tree(w.home);
      expect(await cli(w, "install")).toBe(1);
      expect(err).toMatch(/Edited (or added )?files would be lost/);
      expect(tree(w.home)).toEqual(before);
    }
  });

  it("an added file in the mod folder stops an upgrade", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    writeFileSync(join(w.home, P.MOD_DIR, "extra.js"), "// added\n");
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(/Edited or added files would be lost, nothing changed: mods\/herdr-app-remote\/extra.js/);
  });

  it("a broken or loosened record stops everything", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    chmodSync(join(w.home, P.RECEIPT_PATH), 0o644);
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(/install.json cannot be used: it must have mode 0600/);
    expect(await cli(w, "uninstall")).toBe(1);
    chmodSync(join(w.home, P.RECEIPT_PATH), 0o600);
    const rec = json(w, P.RECEIPT_PATH);
    rec.files["layouts/main.json"] = rec.files[P.LAYOUT_REMOTE];
    writeFileSync(join(w.home, P.RECEIPT_PATH), JSON.stringify(rec));
    const before = tree(w.home);
    expect(await cli(w, "uninstall")).toBe(1);
    expect(err).toMatch(/not a record this installer wrote/);
    expect(tree(w.home)).toEqual(before);
  });

  it("one install at a time", async () => {
    const w = world();
    writeFileSync(join(w.home, ".herdr-app-remote-install.lock"), "");
    expect(await cli(w, "install")).toBe(1);
    expect(err).toMatch(/another install is running/);
    expect(existsSync(join(w.home, P.MOD_DIR))).toBe(false);
  });
});

describe("uninstall", () => {
  it("restores the home exactly as it was, and a second uninstall is a no-op", async () => {
    const w = world();
    const before = tree(w.home);
    expect(await cli(w, "install")).toBe(0);
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(tree(w.home)).toEqual(before);
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out).toEqual(["Nothing is installed here."]);
    expect(tree(w.home)).toEqual(before);
  });

  it("removes runtime files the bridge left, and keeps what is not ours", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    writeFileSync(join(w.home, P.DATA_DIR, "runtime.json"), "{}", { mode: 0o600 });
    writeFileSync(join(w.home, P.LOCK_PATH), "");
    writeFileSync(join(w.home, P.MOD_DIR, "notes.md"), "mine\n");
    writeFileSync(join(w.home, P.LAYOUT_REMOTE), "{\"mine\": true}\n");
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out).toContain(`Kept, not ours: ${P.MOD_DIR}/notes.md`);
    expect(out).toContain(`Kept, not ours: ${P.LAYOUT_REMOTE}`);
    expect(existsSync(join(w.home, P.MOD_DIR, "main.js"))).toBe(false);
    expect(existsSync(join(w.home, P.MOD_DIR, "notes.md"))).toBe(true);
    expect(existsSync(join(w.home, P.DATA_DIR))).toBe(false);
    expect(existsSync(join(w.home, P.LAYOUT_PANORAMA_REMOTE))).toBe(false);
  });

  it("refuses while the window shows a layout that uses the mod", async () => {
    for (const shown of ["herdr-remote", "panorama-remote"]) {
      const w = world();
      expect(await cli(w, "install")).toBe(0);
      w.says(JSON.stringify({ layout: shown }));
      const before = tree(w.home);
      expect(await cli(w, "uninstall")).toBe(1);
      expect(err).toMatch(new RegExp(`Layout ${shown} is showing herdr-app-remote; nothing changed`));
      expect(tree(w.home)).toEqual(before);
      expect(w.calls()).toEqual(["herdr-app status"]);
    }
  });

  it("refuses a user's own layout that uses the mod while it is shown, and names it otherwise", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    copyFileSync(join(w.home, P.LAYOUT_REMOTE), join(w.home, "layouts/my-remote.json"));
    w.says(JSON.stringify({ layout: "my-remote" }));
    expect(await cli(w, "uninstall")).toBe(1);
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out).toContain("Layout my-remote still names herdr-app-remote.");
  });

  it("goes ahead with no window, and refuses when the window's answer can't be used", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    for (const [stdout, code] of [["not json", 0], [JSON.stringify({ layout: "../x" }), 0], ["", 1]] as const) {
      w.says(stdout, code);
      expect(await cli(w, "uninstall")).toBe(1);
      expect(err).toMatch(/did not say what it shows; nothing changed/);
    }
    w.says("", 2);
    expect(await cli(w, "uninstall")).toBe(0);
  });

  it("with no herdr-app to ask, refuses while the app's socket answers", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(join(w.home, "herdr-app.sock"), r));
    try {
      const code = await run(["uninstall", "--app-home", w.home], { log: () => {}, which: () => null, checker: null });
      expect(code).toBe(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    expect(existsSync(join(w.home, P.MOD_DIR))).toBe(true);
    rmSync(join(w.home, "herdr-app.sock"), { force: true });
    expect(await run(["uninstall", "--app-home", w.home], { log: () => {}, which: () => null, checker: null })).toBe(0);
    expect(existsSync(join(w.home, P.MOD_DIR))).toBe(false);
  });

  it("with no record, clears only runtime leftovers and refuses a mod folder", async () => {
    const w = world();
    mkdirSync(join(w.home, P.DATA_DIR), { recursive: true });
    writeFileSync(join(w.home, P.DATA_DIR, "runtime.json"), "{}");
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out).toEqual(["Removed what an interrupted install or uninstall left."]);
    expect(existsSync(join(w.home, P.DATA_DIR))).toBe(false);
    mkdirSync(join(w.home, P.MOD_DIR), { recursive: true });
    expect(await cli(w, "uninstall")).toBe(1);
    expect(err).toMatch(/not ours to remove/);
    expect(existsSync(join(w.home, P.MOD_DIR))).toBe(true);
  });
});

describe("--key", () => {
  it("binds the key to the open command in our layouts' sections only, and uninstall takes it back out", async () => {
    const w = world();
    const keysBefore = json(w, "keys.json");
    expect(await cli(w, "install", "--key", "ctrl-alt-r")).toBe(0);
    const keys = json(w, "keys.json");
    expect(keys["layout:herdr-remote"]).toEqual({ "ctrl-alt-r": "herdr-app-remote.open" });
    expect(keys["layout:panorama-remote"]).toEqual({ "ctrl-alt-r": "herdr-app-remote.open" });
    expect({ ...keys, "layout:herdr-remote": undefined, "layout:panorama-remote": undefined }).toEqual({ ...keysBefore, "layout:herdr-remote": undefined, "layout:panorama-remote": undefined });
    expect(json(w, P.RECEIPT_PATH).keys).toEqual({ key: "ctrl-alt-r", action: "herdr-app-remote.open", sections: ["layout:herdr-remote", "layout:panorama-remote"] });
    // an upgrade without --key keeps it; with another key it moves
    expect(await cli(w, "install")).toBe(0);
    expect(json(w, "keys.json")).toEqual(keys);
    expect(await cli(w, "install", "--key", "ctrl-alt-m")).toBe(0);
    expect(json(w, "keys.json")["layout:herdr-remote"]).toEqual({ "ctrl-alt-m": "herdr-app-remote.open" });
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(json(w, "keys.json")).toEqual(keysBefore);
  });

  it("refuses a key bound in global, terminal or our sections, and a malformed key", async () => {
    for (const [key, where] of [["ctrl-shift-t", "global"], ["ctrl-shift-c", "terminal"]]) {
      const w = world();
      const before = tree(w.home);
      expect(await cli(w, "install", "--key", key!)).toBe(1);
      expect(err).toMatch(new RegExp(`already bound in keys.json \\(${where}`));
      expect(tree(w.home)).toEqual(before);
    }
    const w = world();
    for (const bad of ["r", "ctrl-ctrl-r"]) {
      expect(await cli(w, "install", "--key", bad)).toBe(1);
      expect(err).toMatch(/is not a key like ctrl-alt-r/);
    }
  });

  it("sees the same chord spelled another way", async () => {
    const w = world();
    const keys = json(w, "keys.json");
    keys.global["Alt-Ctrl-R"] = "tab.new";
    writeFileSync(join(w.home, "keys.json"), JSON.stringify(keys));
    expect(await cli(w, "install", "--key", "ctrl-alt-r")).toBe(1);
    expect(err).toMatch(/already bound in keys.json \(global: "tab.new"\)/);
  });

  it("leaves a binding the person changed since", async () => {
    const w = world();
    expect(await cli(w, "install", "--key", "ctrl-alt-r")).toBe(0);
    const keys = json(w, "keys.json");
    keys["layout:herdr-remote"]["ctrl-alt-r"] = "tab.new";
    writeFileSync(join(w.home, "keys.json"), JSON.stringify(keys));
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(json(w, "keys.json")["layout:herdr-remote"]).toEqual({ "ctrl-alt-r": "tab.new" });
    expect(json(w, "keys.json")["layout:panorama-remote"]).toBeUndefined();
  });

  it("needs keys.json to exist (the app writes it on its first start)", async () => {
    const w = world({ keys: false });
    expect(await cli(w, "install", "--key", "ctrl-alt-r")).toBe(1);
    expect(err).toMatch(/keys.json is missing/);
    expect(existsSync(join(w.home, "keys.json"))).toBe(false);
  });
});

describe("herdr-app icon", () => {
  // A made-up tile with a glyph: the tests never carry herdr-app art.
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" rx="20" fill="#336699"/><circle cx="50" cy="50" r="20" fill="#ffffff"/></svg>';
  const PWA = P.PWA_DIR;
  const ICONS = ["apple-touch-icon", "icon-192", "icon-512", "icon-maskable-512", "favicon", "app-logo"].map((n) => `${PWA}/icons/${n}.png`);
  const dims = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];
  const neutral = (p: string) => readFileSync(join(REPO, "packages/pwa/dist", p.slice(PWA.length + 1)));
  const svgIn = (w: World, rel: string, body = SVG) => {
    const f = join(w.home, "..", rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
    return f;
  };

  it("keeps the neutral icons and says so in one line when no herdr-app icon is found", async () => {
    const w = world();
    expect(await cli(w, "install")).toBe(0);
    const lines = out.filter((l) => /icon/i.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Kept the neutral icons: no herdr-app icon found/);
    for (const p of ICONS) expect(readFileSync(join(w.home, p)).equals(neutral(p)), p).toBe(true);
  });

  it("renders every size from --icon, records the files, and uninstall removes them", async () => {
    const w = world();
    const before = tree(w.home);
    expect(await cli(w, "install", "--icon", svgIn(w, "art/herdr-app.svg"))).toBe(0);
    expect(out.filter((l) => /icon/i.test(l))).toEqual([expect.stringMatching(/^Used the herdr-app icon from .*herdr-app\.svg/)]);
    const want: Record<string, number> = { "apple-touch-icon": 180, "icon-192": 192, "icon-512": 512, "icon-maskable-512": 512, favicon: 64, "app-logo": 192 };
    const record = json(w, P.RECEIPT_PATH);
    for (const [n, size] of Object.entries(want)) {
      const p = `${PWA}/icons/${n}.png`;
      const b = readFileSync(join(w.home, p));
      expect(dims(b), n).toEqual([size, size]);
      expect(b.equals(neutral(p)), n).toBe(false);
      expect(record.files[p].sha256).toBe(sha(b));
    }
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(tree(w.home)).toEqual(before);
  });

  it("keeps an icon that was edited after install, like any other file", async () => {
    const w = world();
    expect(await cli(w, "install", "--icon", svgIn(w, "art/herdr-app.svg"))).toBe(0);
    writeFileSync(join(w.home, `${PWA}/icons/favicon.png`), "mine");
    w.says(JSON.stringify({ layout: "main" }));
    expect(await cli(w, "uninstall")).toBe(0);
    expect(out).toContain(`Kept, not ours: ${PWA}/icons/favicon.png`);
    expect(existsSync(join(w.home, `${PWA}/icons/icon-192.png`))).toBe(false);
  });

  it("finds the icon next to the herdr-app binary, following a symlink in PATH, or in ../share/herdr-app", async () => {
    for (const rel of ["real/herdr-app.svg", "prefix/share/herdr-app/herdr-app.svg"]) {
      const w = world();
      svgIn(w, rel);
      const target = join(w.home, "..", rel.startsWith("real") ? "real/herdr-app" : "prefix/bin/herdr-app");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
      const link = join(w.bin, "herdr-app-link");
      symlinkSync(target, link);
      expect(await run(["install", "--app-home", w.home], { source: DEFAULT_SOURCE, log: (l) => out.push(l), which: () => link })).toBe(0);
      expect(dims(readFileSync(join(w.home, `${PWA}/icons/icon-192.png`)))).toEqual([192, 192]);
    }
  });

  it("keeps the neutral icons when the SVG cannot be rendered or --icon is not absolute", async () => {
    const w = world();
    expect(await cli(w, "install", "--icon", svgIn(w, "art/bad.svg", "<svg>not an icon"))).toBe(0);
    expect(out.filter((l) => /icon/i.test(l))).toEqual([expect.stringMatching(/^Kept the neutral icons: could not render/)]);
    for (const p of ICONS) expect(readFileSync(join(w.home, p)).equals(neutral(p)), p).toBe(true);
    const before = tree(w.home);
    expect(await cli(w, "install", "--icon", "relative.svg")).toBe(1);
    expect(err).toMatch(/--icon must be an absolute path; nothing changed/);
    expect(tree(w.home)).toEqual(before);
  });

  it("keeps the neutral icons for an SVG over 1 MiB", async () => {
    const w = world();
    expect(await cli(w, "install", "--icon", svgIn(w, "art/big.svg", SVG + " ".repeat(1024 * 1024)))).toBe(0);
    expect(out.filter((l) => /icon/i.test(l))).toEqual([expect.stringMatching(/^Kept the neutral icons: could not render .*larger than 1 MiB/)]);
    for (const p of ICONS) expect(readFileSync(join(w.home, p)).equals(neutral(p)), p).toBe(true);
  });

  it("an upgrade without the icon puts the neutral icons back", async () => {
    const w = world();
    expect(await cli(w, "install", "--icon", svgIn(w, "art/herdr-app.svg"))).toBe(0);
    expect(await cli(w, "install")).toBe(0);
    for (const p of ICONS) expect(readFileSync(join(w.home, p)).equals(neutral(p)), p).toBe(true);
  });
});

describe("scripts/app-install", () => {
  const script = join(REPO, "scripts/app-install");
  const built = existsSync(join(REPO, "installer/dist/index.js"));

  it.skipIf(!built)("runs install and uninstall end to end, with exit codes", () => {
    const w = world();
    const env = { ...process.env, PATH: `${w.bin}:/usr/bin:/bin` };
    const usage = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/usage: app-install/);
    const before = tree(w.home);
    const i = spawnSync(process.execPath, [script, "install", "--app-home", w.home], { encoding: "utf8", env });
    expect(i.status, i.stderr).toBe(0);
    expect(relative(w.home, join(w.home, P.MOD_DIR, "main.js"))).toBe("mods/herdr-app-remote/main.js");
    expect(existsSync(join(w.home, P.MOD_DIR, "main.js"))).toBe(true);
    w.says(JSON.stringify({ layout: "main" }));
    const u = spawnSync(process.execPath, [script, "uninstall", "--app-home", w.home], { encoding: "utf8", env });
    expect(u.status, u.stderr).toBe(0);
    expect(tree(w.home)).toEqual(before);
    expect(w.calls()).toEqual(["herdr-app status"]); // found on PATH: the fake one, asked once
  });
});
