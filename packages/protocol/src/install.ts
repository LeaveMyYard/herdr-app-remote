// The install record (`data/herdr-app-remote/install.json`), written by scripts/app-install and read
// by the bridge (to check its own bundle) and by the link mod (to verify the bundle before a launch).
// The mod mirrors the parts it needs in mod/herdr-app-remote/install.js; a parity test keeps them equal.
import { z } from "zod";

export const MOD_NAME = "herdr-app-remote";
export const DATA_DIR = "data/herdr-app-remote";
export const MOD_DIR = "mods/herdr-app-remote";
export const RECEIPT_PATH = `${DATA_DIR}/install.json`;
/** The esbuild bundle of the bridge. Run with the recorded `node`; it needs no exec bit. */
export const BUNDLE_PATH = `${DATA_DIR}/bin/bridge.mjs`;
/** The built PWA, served by the bridge's API listener. */
export const PWA_DIR = `${DATA_DIR}/pwa`;
/** Held by `flock -n` for the bridge's whole life: one bridge per app home. */
export const LOCK_PATH = `${DATA_DIR}/bridge.lock`;
export const STAGE_PATH = `${DATA_DIR}/stage`;
/** Derived layouts: copies of the shipped `main` and of panorama's layout with our two blocks added. */
export const LAYOUT_REMOTE = "layouts/herdr-remote.json";
export const LAYOUT_PANORAMA_REMOTE = "layouts/panorama-remote.json";
/** The mod command a `--key` binding sends: shows the panel column and selects the Remote child. */
export const OPEN_COMMAND = `${MOD_NAME}.open`;
/** Ids of the blocks the derived layouts add. */
export const LINK_BLOCK_ID = "remote-link";
export const PANEL_BLOCK_ID = "remote";
/** Ids the derived layouts hang the blocks on. */
export const LINK_PARENT_ID = "work";
export const PANEL_PARENT_ID = "panel-body";
export const PANEL_COLUMN_ID = "panel";
/** Receipts are small; anything bigger is refused before parsing. */
export const RECEIPT_LIMIT = 1024 * 1024;
export const MIN_NODE_MAJOR = 22;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Every path the record may name: our mod folder, our data folder, or one of our two layouts. */
export function ownedPath(path: string): boolean {
  if (path === LAYOUT_REMOTE || path === LAYOUT_PANORAMA_REMOTE) return true;
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some((p) => p === "" || p === "." || p === "..")) return false;
  return path.startsWith(`${MOD_DIR}/`) || path.startsWith(`${DATA_DIR}/bin/`) || path.startsWith(`${PWA_DIR}/`);
}

const OwnedPath = z.string().refine(ownedPath, "not a path this install owns");

export const FileEntry = z.object({ sha256: Sha256, mode: z.union([z.literal(0o644), z.literal(0o755)]) }).strict();

export const KEY_PATTERN = /^((ctrl|alt|shift|cmd|super)-)+([a-z0-9]|f[0-9]{1,2})$/;

export const KeyBinding = z
  .object({
    /** At least one modifier and one letter, digit or f-key, as keys.json spells it: `ctrl-alt-r`. */
    key: z.string().regex(KEY_PATTERN),
    action: z.literal(OPEN_COMMAND),
    sections: z.array(z.string().regex(/^layout:[a-z0-9-]+$/)).min(1).max(2),
  })
  .strict();
export type KeyBinding = z.infer<typeof KeyBinding>;

export const InstallReceipt = z
  .object({
    v: z.literal(1),
    install_id: z.string().regex(/^[0-9a-f]{32}$/),
    /** Absolute path of the node (>= 22) the mod launches the bundle with. */
    node: z.string().startsWith("/").max(4096),
    /** Top-level folders the first install created; uninstall removes them only if empty. */
    dirs: z.array(z.enum(["mods", "data", "layouts"])),
    files: z.record(OwnedPath, FileEntry),
    /** Digests of an earlier generation an upgrade had not finished replacing (a journal). */
    previous: z.record(OwnedPath, z.array(Sha256)),
    keys: KeyBinding.nullable(),
  })
  .strict()
  .refine((r) => r.files[BUNDLE_PATH] !== undefined, "the record names no bridge bundle");
export type InstallReceipt = z.infer<typeof InstallReceipt>;
