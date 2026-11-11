// The desktop's key menu (S16b): `data/herdr-app-remote/keys.json`, next to devices.json and the other bridge
// files. The operator edits it on the desktop; the phone only ever names an entry of it by id.
//
// The file is checked against a strict schema before anything in it is used: each `keys` token must be one the
// protocol's `isKeyToken` allows (a strict subset of `hc keys`, none of which types plain text), an entry holds at
// most 8 keys, the menu at most 32 entries, and a label is 1 to 24 characters of plain text. A file that fails is
// not fatal: it is moved aside to `keys.json.damaged` (0600) and the default menu is used, so a typo can neither
// stop the bridge nor leave a half-read menu in force.
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { bridgeApi } from "@herdr-remote/protocol";

export const KEYS_FILE = "keys.json";
export const KEYS_DAMAGED_FILE = "keys.json.damaged";
/** A key menu file larger than this is not read. 32 entries of 8 keys fit in a few KiB. */
export const KEYS_FILE_MAX_BYTES = 64 * 1024;

type Entry = bridgeApi.KeyEntry;

/** The menu when there is no `keys.json`: the keys an agent's TUI asks for most (protocol `DEFAULT_KEYS`). */
export const DEFAULT_KEYS: readonly Entry[] = bridgeApi.DEFAULT_KEYS;

/**
 * The id an entry without one gets: its tokens, `+` read as `-`, joined by `_` (`["ctrl+c"]` is `ctrl-c`,
 * `["up", "up"]` is `up_up`). It must still fit {@link bridgeApi.KEY_ID}; a longer one needs an explicit `id`.
 */
export function deriveId(keys: readonly string[]): string {
  return keys.map((k) => k.replace(/\+/g, "-")).join("_");
}

const FileEntry = z
  .object({
    id: z.string().regex(bridgeApi.KEY_ID).optional(),
    label: bridgeApi.KeyLabel,
    keys: z.array(bridgeApi.KeyToken).min(1).max(bridgeApi.KEYS_MAX_PER_ENTRY),
  })
  .strict();

export const KeysFile = z
  .object({
    v: z.literal(1),
    keys: z.array(FileEntry).max(bridgeApi.KEYS_MAX_ENTRIES),
  })
  .strict();
export type KeysFile = z.infer<typeof KeysFile>;

/** The menu's revision: a hash of its entries, so any change to an id, label or key gives a new one. */
export function menuRev(entries: readonly Entry[]): string {
  return createHash("sha256").update(JSON.stringify(entries.map((e) => [e.id, e.label, e.keys]))).digest("hex").slice(0, 16);
}

export function menuTopic(entries: readonly Entry[]): bridgeApi.KeysTopic {
  const keys = entries.map((e) => ({ id: e.id, label: e.label, keys: [...e.keys] }));
  return { rev: menuRev(keys), keys };
}

/** Why a key menu file was set aside. Fixed words: nothing from the file's content is ever repeated. */
export type DamagedReason = "not_a_file" | "too_large" | "unreadable" | "bad_json" | "invalid" | "duplicate_id" | "id_too_long";

export type ParseResult = { ok: true; entries: Entry[] } | { ok: false; reason: DamagedReason; where?: string };

/**
 * Where in the file a schema issue is, from numeric indices and the schema's own field names only (an unknown key
 * in the file is reported at its parent), e.g. `keys[3].label`.
 */
function where(path: readonly PropertyKey[]): string | undefined {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else if (p === "v" || p === "keys" || p === "id" || p === "label") out += out ? `.${p}` : p;
    else break;
  }
  return out || undefined;
}

/** Checks a parsed key menu file and gives every entry its id. */
export function parseKeysFile(raw: unknown): ParseResult {
  const r = KeysFile.safeParse(raw);
  if (!r.success) {
    const at = where(r.error.issues[0]?.path ?? []);
    return { ok: false, reason: "invalid", ...(at ? { where: at } : {}) };
  }
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const [i, e] of r.data.keys.entries()) {
    const id = e.id ?? deriveId(e.keys);
    if (!bridgeApi.KEY_ID.test(id)) return { ok: false, reason: "id_too_long", where: `keys[${i}]` };
    if (seen.has(id)) return { ok: false, reason: "duplicate_id", where: `keys[${i}]` };
    seen.add(id);
    entries.push({ id, label: e.label, keys: [...e.keys] });
  }
  return { ok: true, entries };
}

export type LoadState =
  | { state: "default" }
  | { state: "loaded"; entries: number }
  | { state: "damaged"; reason: DamagedReason; where?: string; setAside: boolean };

export interface Loaded {
  topic: bridgeApi.KeysTopic;
  /** The file as it was read (size, mtime, inode), to notice an edit; null when there was none. */
  stamp: string | null;
  load: LoadState;
}

function stampOf(st: { size: number; mtimeMs: number; ino: number; ctimeMs: number }): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

/** The later of mtime and ctime in a stamp (a rename or chmod moves only ctime). */
function changedAt(stamp: string): number {
  const [, , m, c] = stamp.split(":");
  return Math.max(Number(m), Number(c));
}

/** How long a changed `keys.json` is left alone before it is read (see {@link KeysMenu.refresh}). */
export const KEYS_SETTLE_MS = 1_000;

/** The current file's stamp, or null if there is none (or it is not a regular file, which the loader sets aside). */
export function keysFileStamp(dataDir: string): string | null {
  try {
    return stampOf(lstatSync(join(dataDir, KEYS_FILE)));
  } catch {
    return null;
  }
}

/**
 * Reads `keys.json` from the bridge's data dir (made 0600 as it is read). Missing: the default menu. Valid: its menu. Anything else (a symlink or other non-file, over 64 KiB, unreadable, not JSON, failing the schema): moved
 * aside to `keys.json.damaged` (replacing an older one, made 0600) and the default menu is used. Never throws.
 */
export function loadKeys(dataDir: string): Loaded {
  const file = join(dataDir, KEYS_FILE);
  const fallback = (load: LoadState, stamp: string | null = null): Loaded => ({ topic: menuTopic(DEFAULT_KEYS), stamp, load });
  const damaged = (reason: DamagedReason, at?: string): Loaded => {
    let setAside = false;
    try {
      const aside = join(dataDir, KEYS_DAMAGED_FILE);
      renameSync(file, aside);
      setAside = true;
      // A symlink is moved as a link: never chmod (or follow) what it points at. O_NOFOLLOW refuses one (ELOOP).
      const fd = openSync(aside, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (fstatSync(fd).isFile()) fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Could not move it: still never used. The default menu is in force either way.
    }
    // A file that could not be moved keeps its stamp, so it is not re-read (and re-reported) until it changes.
    return fallback({ state: "damaged", reason, ...(at ? { where: at } : {}), setAside }, setAside ? null : keysFileStamp(dataDir));
  };

  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback({ state: "default" });
    return damaged("unreadable");
  }
  if (!st.isFile()) return damaged("not_a_file");
  if (st.size > KEYS_FILE_MAX_BYTES) return damaged("too_large");

  let text: string;
  let stamp: string;
  try {
    // O_NOFOLLOW: a file swapped for a symlink after the lstat is refused, not followed.
    // O_NONBLOCK: a FIFO swapped in after the lstat can't hold the bridge on the open (fstat then refuses it).
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      let fst = fstatSync(fd);
      if (!fst.isFile()) return damaged("not_a_file");
      // 0600 like the other bridge files, before the stamp is taken (a chmod changes ctime).
      if ((fst.mode & 0o777) !== 0o600) {
        fchmodSync(fd, 0o600);
        fst = fstatSync(fd);
      }
      if (fst.size > KEYS_FILE_MAX_BYTES) return damaged("too_large");
      const buf = Buffer.alloc(KEYS_FILE_MAX_BYTES + 1);
      let n = 0;
      for (;;) {
        const r = readSync(fd, buf, n, buf.length - n, null);
        if (r === 0) break;
        n += r;
        if (n > KEYS_FILE_MAX_BYTES) return damaged("too_large");
      }
      text = buf.subarray(0, n).toString("utf8");
      stamp = stampOf(fst);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return damaged((e as NodeJS.ErrnoException).code === "ELOOP" ? "not_a_file" : "unreadable");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return damaged("bad_json");
  }
  const parsed = parseKeysFile(raw);
  if (!parsed.ok) return damaged(parsed.reason, parsed.where);
  return { topic: menuTopic(parsed.entries), stamp, load: { state: "loaded", entries: parsed.entries.length } };
}

/**
 * The key menu in force, re-read when `keys.json` changes (checked by stat on every press and on a timer). Every
 * load that changes the menu or sets a file aside is reported through `onLoad`.
 */
export class KeysMenu {
  private cur: Loaded;
  private readonly dataDir: string;
  private readonly onLoad: (l: Loaded) => void;
  private readonly now: () => number;

  constructor(dataDir: string, onLoad: (l: Loaded) => void = () => {}, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.onLoad = onLoad;
    this.now = now;
    this.cur = loadKeys(dataDir);
    this.report(this.cur);
  }

  /** The menu now, after re-reading the file if it changed since the last read. */
  current(): bridgeApi.KeysTopic {
    this.refresh();
    return this.cur.topic;
  }

  /**
   * Re-reads the file if its stamp changed. True when the menu (its `rev`) changed. A file changed less than
   * {@link KEYS_SETTLE_MS} ago is left for a later look: an editor that saves in place truncates and then writes,
   * and a read in between would set a good file aside. The menu in force stays until then.
   */
  refresh(): boolean {
    const stamp = keysFileStamp(this.dataDir);
    if (stamp === this.cur.stamp) return false;
    // A time in the future (clock skew, touch -d) is not waited for: only 0 to KEYS_SETTLE_MS ago counts as just saved.
    const age = stamp === null ? Infinity : this.now() - changedAt(stamp);
    if (age >= 0 && age < KEYS_SETTLE_MS) return false;
    const before = this.cur.topic.rev;
    this.cur = loadKeys(this.dataDir);
    this.report(this.cur);
    return this.cur.topic.rev !== before;
  }

  get load(): LoadState {
    return this.cur.load;
  }

  /** The last load, as `onLoad` saw it. */
  get loaded(): Loaded {
    return this.cur;
  }

  private report(l: Loaded): void {
    try {
      this.onLoad(l);
    } catch {
      // A listener's failure must not change the menu.
    }
  }
}
