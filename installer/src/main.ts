// scripts/app-install: installs herdr-app-remote into an app home, upgrades it in place, removes it.
// It mirrors herdr-inbox's installer (app/installer/main.py): an install record lists every file with
// its sha256 and mode and is the only authority for what uninstall removes; collisions are refused
// before the first write; files are staged and published whole; uninstall removes only unchanged
// files and refuses while the shown layout uses the mod. It never selects a layout, never edits
// settings, and never touches `tailscale serve`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { install as P } from "@herdr-remote/protocol";
import { guardRemoval } from "./guard.js";
import { digest, Home } from "./home.js";
import { addBinding, chord, removeBinding, sectionFor } from "./keys.js";
import { chooseIcons } from "./icons.js";
import { derive, panoramaLayoutSha } from "./layouts.js";

export const PANORAMA_RECEIPT = "data/panorama/install.json";
export const PANORAMA_LAYOUT = "layouts/panorama.json";
export const MAIN_LAYOUT = "layouts/main.json";
export const KEYS = "keys.json";
/** Files the bridge and installer leave in our data folder that an install may take over. */
export const RUNTIME_NAMES = ["runtime.json", "bridge.lock", "stage"];
/**
 * Files herdr-app itself writes into every mod folder (editor support). They are the app's, not the
 * person's, so they count as ours at the folder's top level, whatever their bytes: same rule as
 * herdr-inbox's installer (package.HOST_FILES).
 */
export const HOST_FILES = ["gpui-kit.d.ts", "jsconfig.json"];
const LIMIT = 4 * 1024 * 1024;
const MOD_STAGE = `${P.STAGE_PATH}/mod`;
const OLD_STAGE = `${P.STAGE_PATH}/old`;

export interface Options {
  appHome: string;
  /** Repository root with the built bundle and the mod (default: this checkout). */
  source?: string;
  /** Absolute node >= 22 the mod launches the bridge with (default: the node running this). */
  node?: string;
  /** `--key ctrl-alt-r`: bind the Remote panel in our layouts' sections of keys.json. */
  key?: string | null;
  /** Absolute herdr-app, asked what the window shows (default: herdr-app on PATH, else none). */
  checker?: string | null;
  log?: (line: string) => void;
  /** `--icon ABS`: the herdr-app SVG to render the app's icons from (default: found next to the herdr-app binary). */
  icon?: string | null;
  /** PATH lookup, a test seam. */
  which?: (name: string) => string | null;
}

type Payload = Map<string, { data: Buffer; mode: 0o644 | 0o755 }>;

export const DEFAULT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir.startsWith("/")) continue;
    try {
      const p = join(dir, name);
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

// ---- payload ----

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
    else throw new Error(`Not a regular file in the mod: ${p}`);
  }
  return out.sort();
}

/** The mod folder and the bridge bundle, read from the source checkout. */
export function loadPayload(source: string): Payload {
  const payload: Payload = new Map();
  const modDir = join(source, "mod", P.MOD_NAME);
  for (const f of filesUnder(modDir)) if (!HOST_FILES.includes(relative(modDir, f))) payload.set(`${P.MOD_DIR}/${relative(modDir, f)}`, { data: readFileSync(f), mode: 0o644 });
  if (!payload.has(`${P.MOD_DIR}/main.js`) || !payload.has(`${P.MOD_DIR}/mod.json`)) throw new Error(`${modDir} is not the herdr-app-remote mod`);
  let bundle: Buffer;
  try {
    bundle = readFileSync(join(source, "packages", "bridge", "dist", "bridge.mjs"));
  } catch {
    throw new Error("The bridge bundle is not built: run pnpm install && pnpm build first. Nothing changed");
  }
  payload.set(P.BUNDLE_PATH, { data: bundle, mode: 0o644 });
  const pwa = join(source, "packages", "pwa", "dist");
  let pwaFiles: string[];
  try {
    pwaFiles = filesUnder(pwa);
  } catch {
    throw new Error("The PWA is not built: run pnpm install && pnpm build first. Nothing changed");
  }
  if (!pwaFiles.some((f) => relative(pwa, f) === "index.html")) throw new Error(`${pwa} has no index.html: run pnpm build first. Nothing changed`);
  for (const f of pwaFiles) payload.set(`${P.PWA_DIR}/${relative(pwa, f)}`, { data: readFileSync(f), mode: 0o644 });
  return payload;
}

export function checkNode(node: string): string {
  if (!node.startsWith("/")) throw new Error("--node must be an absolute path");
  const r = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const m = /^v(\d+)\./.exec(r.stdout ?? "");
  if (r.status !== 0 || !m) throw new Error(`${node} is not a working node; nothing changed`);
  if (Number(m[1]) < P.MIN_NODE_MAJOR) throw new Error(`The bridge needs node >= ${P.MIN_NODE_MAJOR}, and ${node} is ${r.stdout.trim()}; nothing changed. Pass --node`);
  return node;
}

// ---- record ----

export function loadReceipt(home: Home): P.InstallReceipt | null {
  const stored = home.read(P.RECEIPT_PATH, P.RECEIPT_LIMIT);
  if (!stored) return null;
  try {
    if (stored.mode !== 0o600) throw new Error("it must have mode 0600");
    return P.InstallReceipt.parse(JSON.parse(stored.data.toString("utf8")));
  } catch (e) {
    const why = e instanceof Error && !(e.name === "ZodError") ? e.message : "it is not a record this installer wrote";
    throw new Error(`${P.RECEIPT_PATH} cannot be used: ${why}. Nothing changed. If it is lost, remove ${P.MOD_DIR}, ${P.DATA_DIR} and our layouts by hand and install again`);
  }
}

function saveReceipt(home: Home, record: P.InstallReceipt): void {
  home.write(P.RECEIPT_PATH, JSON.stringify(P.InstallReceipt.parse(record), null, 2) + "\n", 0o600);
}

/** path -> every digest of ours: this generation's, and an unfinished upgrade's. */
export function known(record: P.InstallReceipt | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!record) return out;
  for (const [p, ds] of Object.entries(record.previous)) out.set(p, new Set(ds));
  for (const [p, f] of Object.entries(record.files)) (out.get(p) ?? out.set(p, new Set()).get(p)!).add(f.sha256);
  return out;
}

const isHostFile = (path: string): boolean => HOST_FILES.some((f) => path === `${P.MOD_DIR}/${f}`);

const isOurs = (home: Home, path: string, k: Map<string, Set<string>>): boolean => {
  const stored = home.kind(path) === "file" ? home.read(path) : null;
  return !!stored && (isHostFile(path) || !!k.get(path)?.has(digest(stored.data)));
};

// ---- preflight ----

function preflight(home: Home, payload: Payload, old: P.InstallReceipt | null, carried: string[]): void {
  for (const top of ["mods", "layouts", "data"]) {
    const k = home.kind(top);
    if (k !== null && k !== "dir") throw new Error(`Name collision: ${top} is not a folder`);
  }
  const k = known(old);
  const modKind = home.kind(P.MOD_DIR);
  if (modKind !== null) {
    if (modKind !== "dir") throw new Error(`Name collision: ${P.MOD_DIR} is not a folder`);
    if (!old) throw new Error(`Name collision: ${P.MOD_DIR}. With no install record nothing proves it ours: if it is, remove it by hand and install again`);
    const others = home.walk(P.MOD_DIR).filter((p) => !isOurs(home, p, k));
    if (others.length) throw new Error(`Edited or added files would be lost, nothing changed: ${others.join(", ")}`);
  }
  for (const path of payload.keys()) {
    if (path.startsWith(`${P.MOD_DIR}/`) || carried.includes(path) || home.kind(path) === null) continue;
    if (!isOurs(home, path, k)) {
      throw new Error(old?.files[path] || old?.previous[path]
        ? `Edited files would be lost, nothing changed: ${path}. Move it aside and install again`
        : `Name collision: ${path} is not ours. Move it aside and install again`);
    }
  }
  if (!old && home.kind(P.DATA_DIR) !== null) {
    const others = home.list(P.DATA_DIR).filter((n) => !RUNTIME_NAMES.includes(n));
    if (others.length) throw new Error(`Name collision: ${P.DATA_DIR} holds files that are not ours (${others.join(", ")}): move them, then install again`);
  }
}

/** Makes the folders above a data-folder file (the bundle's bin is 0700, the PWA's folders 0755). */
function ensureParents(home: Home, path: string): void {
  const segs = path.split("/");
  for (let d = 3; d < segs.length; d++) {
    const dir = segs.slice(0, d).join("/");
    home.mkdir(dir, dir === `${P.DATA_DIR}/bin` ? 0o700 : 0o755);
  }
}

/** Removes the now-empty folders above these data-folder paths, deepest first. */
function pruneParents(home: Home, paths: Iterable<string>): void {
  const dirs = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(`${P.DATA_DIR}/`)) continue;
    const segs = p.split("/");
    for (let d = 3; d < segs.length; d++) dirs.add(segs.slice(0, d).join("/"));
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) home.rmdir(d);
}

// ---- erase ----

/** Removes everything the record owns, the record last, so a crash can be run again. Returns what stayed. */
function erase(home: Home, record: P.InstallReceipt): string[] {
  const k = known(record);
  const leftovers: string[] = [];
  if (home.kind(P.MOD_DIR) === "dir") {
    for (const p of home.walk(P.MOD_DIR)) {
      if (isOurs(home, p, k)) home.remove(p);
      else leftovers.push(p);
    }
    const dirs = new Set<string>();
    for (const p of [...k.keys(), ...leftovers]) {
      if (!p.startsWith(`${P.MOD_DIR}/`)) continue;
      const segs = p.split("/");
      for (let d = 3; d < segs.length; d++) dirs.add(segs.slice(0, d).join("/"));
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) home.rmdir(d);
    home.rmdir(P.MOD_DIR);
  } else if (home.kind(P.MOD_DIR) !== null) leftovers.push(P.MOD_DIR);
  for (const p of k.keys()) {
    if (p.startsWith(`${P.MOD_DIR}/`) || home.kind(p) === null) continue;
    if (isOurs(home, p, k)) home.remove(p);
    else leftovers.push(p);
  }
  pruneParents(home, k.keys());
  if (record.keys) {
    // Never let keys.json (a link, unreadable, not JSON) stop the uninstall halfway: report it instead.
    try {
      const kj = home.read(KEYS, LIMIT);
      const next = kj ? removeBinding(kj.data.toString("utf8"), record.keys) : null;
      if (kj && next !== null) home.write(KEYS, next, kj.mode);
    } catch {
      leftovers.push(`${KEYS} (could not read it to remove ${record.keys.key}; remove that binding by hand)`);
    }
  }
  home.rmtree(P.STAGE_PATH);
  home.remove(`${P.DATA_DIR}/runtime.json`);
  home.remove(`${P.DATA_DIR}/bridge.lock`);
  home.rmdir(`${P.DATA_DIR}/bin`);
  home.remove(P.RECEIPT_PATH);
  if (!home.rmdir(P.DATA_DIR)) leftovers.push(...home.list(P.DATA_DIR).map((n) => `${P.DATA_DIR}/${n}`));
  for (const d of record.dirs) home.rmdir(d);
  return leftovers;
}

// ---- install ----

function created(home: Home): P.InstallReceipt["dirs"] {
  const dataOurs = home.kind("data") === null || home.list("data").every((n) => n === P.MOD_NAME);
  return [...(dataOurs ? (["data"] as const) : []), ...(home.kind("mods") === null ? (["mods"] as const) : [])];
}

function publishMod(home: Home, payload: Payload): void {
  home.rmtree(P.STAGE_PATH);
  home.mkdir(P.STAGE_PATH, 0o700);
  home.mkdir(MOD_STAGE);
  for (const [path, { data, mode }] of payload) {
    if (!path.startsWith(`${P.MOD_DIR}/`)) continue;
    const rel = path.slice(P.MOD_DIR.length + 1).split("/");
    for (let d = 1; d < rel.length; d++) home.mkdir(`${MOD_STAGE}/${rel.slice(0, d).join("/")}`);
    home.write(`${MOD_STAGE}/${rel.join("/")}`, data, mode);
  }
  // Two renames, not one exchange (Node has no renameat2): for a moment there is no mod folder. The
  // app keeps a running copy across a broken reload, and a re-run finishes a crash in between.
  if (home.kind(P.MOD_DIR) !== null) home.rename(P.MOD_DIR, OLD_STAGE);
  home.rename(MOD_STAGE, P.MOD_DIR);
  home.rmtree(P.STAGE_PATH);
}

export async function install(o: Options): Promise<void> {
  const log = o.log ?? ((l: string) => process.stdout.write(l + "\n"));
  const home = new Home(o.appHome);
  const node = checkNode(o.node ?? process.execPath);
  if (o.key != null && (!P.KEY_PATTERN.test(o.key) || chord(o.key).split("-").length !== o.key.split("-").length)) throw new Error(`--key ${o.key} is not a key like ctrl-alt-r; nothing changed`);
  if (o.icon != null && !o.icon.startsWith("/")) throw new Error("--icon must be an absolute path; nothing changed");
  const payload = loadPayload(o.source ?? DEFAULT_SOURCE);
  const old = loadReceipt(home);
  const notes: string[] = [];

  // The herdr-app icon replaces the neutral icons in the payload, so it is recorded and removed like any file.
  const icons = await chooseIcons({ icon: o.icon, bin: o.checker !== undefined ? o.checker : (o.which ?? which)("herdr-app") });
  if (icons.files) for (const [p, data] of icons.files) payload.set(p, { data, mode: 0o644 });
  notes.push(icons.line);

  const main = home.read(MAIN_LAYOUT, LIMIT);
  if (!main) throw new Error(`${MAIN_LAYOUT} is missing: start herdr-app once with this home so it writes its layouts. Nothing changed`);
  payload.set(P.LAYOUT_REMOTE, { data: Buffer.from(derive(main.data, MAIN_LAYOUT)), mode: 0o644 });

  const carried: string[] = [];
  const pano = panoramaSource(home);
  if (pano.ok) {
    payload.set(P.LAYOUT_PANORAMA_REMOTE, { data: Buffer.from(pano.derived), mode: 0o644 });
  } else if (old?.files[P.LAYOUT_PANORAMA_REMOTE] && isOurs(home, P.LAYOUT_PANORAMA_REMOTE, known(old))) {
    carried.push(P.LAYOUT_PANORAMA_REMOTE);
    notes.push(`Kept panorama-remote from the last install: ${pano.reason}.`);
  } else {
    notes.push(`No panorama-remote layout: ${pano.reason}.`);
  }
  const layouts = [P.LAYOUT_REMOTE, ...(pano.ok || carried.length ? [P.LAYOUT_PANORAMA_REMOTE] : [])];

  let keys = old?.keys ?? null;
  let keysText: { text: string; mode: number } | null = null;
  if (o.key != null) {
    const binding: P.KeyBinding = { key: o.key, action: P.OPEN_COMMAND, sections: layouts.map(sectionFor) };
    const kj = home.read(KEYS, LIMIT);
    if (!kj) throw new Error(`${KEYS} is missing: start herdr-app once with this home first. Nothing changed`);
    keysText = { text: addBinding(kj.data.toString("utf8"), binding, old?.keys ?? null), mode: kj.mode };
    keys = binding;
  }

  preflight(home, payload, old, carried);

  const files: P.InstallReceipt["files"] = {};
  for (const [p, { data, mode }] of payload) files[p] = { sha256: digest(data), mode };
  for (const p of carried) files[p] = old!.files[p]!;
  const previous: P.InstallReceipt["previous"] = {};
  for (const [p, ds] of known(old)) previous[p] = [...ds].sort();
  const record: P.InstallReceipt = {
    v: 1,
    install_id: old?.install_id ?? randomBytes(16).toString("hex"),
    node,
    dirs: old?.dirs ?? created(home),
    files,
    previous,
    keys,
  };

  try {
    home.mkdir("data");
    home.mkdir(P.DATA_DIR, 0o700);
    home.chmod(P.DATA_DIR, 0o700);
    saveReceipt(home, record); // a journal from here on: a crash can be run again or uninstalled
    home.mkdir("mods");
    publishMod(home, payload);
    home.mkdir(`${P.DATA_DIR}/bin`, 0o700);
    for (const [p, { data, mode }] of payload) {
      if (p.startsWith(`${P.MOD_DIR}/`)) continue;
      ensureParents(home, p);
      home.write(p, data, mode);
    }
    const dropped = Object.keys(old?.files ?? {}).filter((p) => !files[p] && !p.startsWith(`${P.MOD_DIR}/`));
    for (const p of dropped) if (isOurs(home, p, known(old))) home.remove(p);
    pruneParents(home, dropped);
    if (keysText) home.write(KEYS, keysText.text, keysText.mode);
    record.previous = {};
    saveReceipt(home, record);
  } catch (e) {
    if (!old) erase(home, record);
    throw e;
  }
  log(`${old ? "Upgraded" : "Installed"} herdr-app-remote, with layouts ${layouts.map((l) => l.slice(8, -5)).join(" and ")}. No layout was selected and no setting changed.`);
  if (keysText) log(`Bound ${o.key} to open the Remote panel in those layouts (keys.json).`);
  for (const n of notes) log(n);
  log("Switch to the herdr-remote layout to start it: herdr-app do layout.switch '{\"name\":\"herdr-remote\"}'.");
}

function panoramaSource(home: Home): { ok: true; derived: string } | { ok: false; reason: string } {
  let receipt: { data: Buffer } | null;
  try {
    receipt = home.read(PANORAMA_RECEIPT, LIMIT);
  } catch {
    return { ok: false, reason: "panorama's install record cannot be read" };
  }
  if (!receipt) return { ok: false, reason: "panorama is not installed" };
  const want = panoramaLayoutSha(receipt.data.toString("utf8"));
  if (!want) return { ok: false, reason: "panorama's install record does not name its layout" };
  let layout: { data: Buffer } | null;
  try {
    layout = home.read(PANORAMA_LAYOUT, LIMIT);
  } catch {
    return { ok: false, reason: `${PANORAMA_LAYOUT} cannot be read` };
  }
  if (!layout) return { ok: false, reason: `${PANORAMA_LAYOUT} is missing` };
  if (digest(layout.data) !== want) return { ok: false, reason: `${PANORAMA_LAYOUT} differs from panorama's install record (edited?)` };
  // panorama-remote is optional: a panorama release we can't extend skips it, it never blocks ours.
  try {
    return { ok: true, derived: derive(layout.data, PANORAMA_LAYOUT) };
  } catch (e) {
    return { ok: false, reason: `${(e as Error).message}, so it can't take the Remote blocks` };
  }
}

// ---- uninstall ----

function recover(home: Home, log: (l: string) => void): void {
  if (home.kind(P.MOD_DIR) !== null) {
    throw new Error(`Nothing is installed here (no install record), and with no record ${P.MOD_DIR} is not ours to remove. If it is yours to lose, remove it by hand`);
  }
  if (home.kind(P.DATA_DIR) === null) {
    log("Nothing is installed here.");
    return;
  }
  const others = home.list(P.DATA_DIR).filter((n) => !RUNTIME_NAMES.includes(n));
  if (others.length) throw new Error(`Nothing is installed here, and ${P.DATA_DIR} holds files that are not ours (${others.join(", ")}); nothing changed`);
  home.rmtree(P.STAGE_PATH);
  home.remove(`${P.DATA_DIR}/runtime.json`);
  home.remove(`${P.DATA_DIR}/bridge.lock`);
  home.rmdir(P.DATA_DIR);
  log("Removed what an interrupted install or uninstall left.");
}

export async function uninstall(o: Options): Promise<void> {
  const log = o.log ?? ((l: string) => process.stdout.write(l + "\n"));
  const home = new Home(o.appHome);
  const record = loadReceipt(home);
  if (!record) return recover(home, log);
  const checker = o.checker !== undefined ? o.checker : (o.which ?? which)("herdr-app");
  const leaving = Object.keys(record.files).filter((p) => p.startsWith("layouts/"));
  const notes = await guardRemoval(home.path, checker, leaving);
  const leftovers = erase(home, record);
  for (const p of leftovers) log(`Kept, not ours: ${p}`);
  for (const n of notes) log(n);
  log("Uninstalled herdr-app-remote. A running bridge stops by itself within seconds.");
}

// ---- the command ----

export const USAGE = "usage: app-install install|uninstall --app-home ABS [--key KEY] [--node ABS] [--icon ABS] [--checker ABS]";

export function parseArgs(argv: string[]): ({ action: "install" | "uninstall" } & Options) | null {
  const [action, ...rest] = argv;
  if (action !== "install" && action !== "uninstall") return null;
  const o: { action: "install" | "uninstall" } & Options = { action, appHome: "" };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--app-home") o.appHome = value;
    else if (flag === "--key" && action === "install") o.key = value;
    else if (flag === "--node" && action === "install") o.node = value;
    else if (flag === "--icon" && action === "install") o.icon = value;
    else if (flag === "--checker") o.checker = value;
    else return null;
  }
  return o.appHome ? o : null;
}

/**
 * One install or uninstall at a time per home: a lock file holding the installer's pid. Node has no
 * flock(), so a lock left by a killed run is taken over once its pid is gone.
 */
export const LOCK = ".herdr-app-remote-install.lock";

/** The lock's content for this run: the pid to judge it by, and a token nobody else writes. */
const lockToken = `${process.pid} ${randomBytes(8).toString("hex")}\n`;

function takeLock(home: Home): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (home.create(LOCK, 0o600, lockToken)) return true;
    const seen = home.read(LOCK, 256)?.data.toString();
    if (seen === undefined) continue; // gone meanwhile: try again
    const pid = Number(seen.split(" ")[0]);
    if (!Number.isInteger(pid) || pid < 1) return false; // no pid to judge by: never take it
    try {
      process.kill(pid, 0);
      return false; // that run is alive
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    // Take the dead run's lock aside with one atomic rename, then check it is the one judged dead:
    // a racing run may have taken it over first and written its own.
    const aside = `${LOCK}.stale-${randomBytes(6).toString("hex")}`;
    try {
      home.rename(LOCK, aside);
    } catch {
      continue;
    }
    if (home.read(aside, 256)?.data.toString() !== seen) {
      try {
        home.rename(aside, LOCK); // someone else's live lock: put it back
      } catch {
        /* a third run holds LOCK now; the moved one is a live run's and it removes its own */
      }
      return false;
    }
    home.remove(aside);
  }
  return false;
}

/** Removes the lock only while it is still this run's. */
function dropLock(home: Home): void {
  if (home.read(LOCK, 256)?.data.toString() === lockToken) home.remove(LOCK);
}

export async function run(argv: string[], extra: Partial<Options> = {}): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  const o = { ...args, ...extra };
  let home: Home;
  try {
    home = new Home(o.appHome);
  } catch (e) {
    process.stderr.write(`herdr-app-remote ${o.action}: ${(e as Error).message}\n`);
    return 1;
  }
  if (!takeLock(home)) {
    process.stderr.write(`herdr-app-remote ${o.action}: another install is running in this app home (or one was killed: if none runs, remove ${join(home.path, LOCK)})\n`);
    return 1;
  }
  try {
    await (o.action === "install" ? install(o) : uninstall(o));
    return 0;
  } catch (e) {
    process.stderr.write(`herdr-app-remote ${o.action}: ${(e as Error).message}\n`);
    return 1;
  } finally {
    dropLock(home);
  }
}
