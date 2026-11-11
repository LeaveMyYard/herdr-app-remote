import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { init, parse } from "es-module-lexer";
import { join } from "node:path";

export type ReceiptKind = "panorama" | "inbox";

export type LoadResult =
  | { ok: true; modules: Record<string, Record<string, unknown>> }
  | { ok: false; reason: "missing" | "broken"; detail: string };

/**
 * Reads an install receipt into `relative path -> sha256`. Both shapes are accepted:
 * panorama `{v: 2, files: {path: {sha256, mode}}}` and inbox `{v: 1, files: {path: sha256}}`.
 */
export function parseReceipt(text: string): Map<string, string> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object") return undefined;
  const files = (doc as { files?: unknown }).files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return undefined;
  const out = new Map<string, string>();
  for (const [path, v] of Object.entries(files)) {
    const sha = typeof v === "string" ? v : v !== null && typeof v === "object" ? (v as { sha256?: unknown }).sha256 : undefined;
    if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return undefined;
    out.set(path, sha);
  }
  return out;
}

/**
 * True if the source has any static or dynamic import or `export ... from` (found by a real lexer, so comments,
 * strings and unusual spacing can't hide one). `import.meta` is not an import.
 */
export async function hasImports(source: string): Promise<boolean> {
  await init;
  try {
    return parse(source)[0].some((i) => i.t !== 3);
  } catch {
    return true; // unparsable: refuse
  }
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Hash-pinned loading of a plugin's own pure JS. Each file's bytes are read once, compared with the plugin's
 * install receipt, and then imported from those same bytes (a data: URL), so a swap after the check can't
 * be executed. Only import-free files are loadable; anything else is `broken`.
 *
 * - no receipt: `missing` (not installed)
 * - receipt unreadable, file not in it, hash differs, file unreadable, imports present, or evaluation throws: `broken`
 */
export async function loadPinned(
  appHome: string,
  receiptPath: string,
  files: string[],
  /** Test seam: the file reader. */
  read: (path: string) => Promise<Buffer> = (p) => readFile(p),
): Promise<LoadResult> {
  let receiptText: string;
  try {
    receiptText = await readFile(join(appHome, receiptPath), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing", detail: "not installed" };
    return { ok: false, reason: "broken", detail: "install receipt unreadable" };
  }
  const receipt = parseReceipt(receiptText);
  if (!receipt) return { ok: false, reason: "broken", detail: "install receipt invalid" };
  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of files) {
    const pinned = receipt.get(file);
    if (!pinned) return { ok: false, reason: "broken", detail: "a plugin file is not in the install receipt" };
    let bytes: Buffer;
    try {
      bytes = await read(join(appHome, file));
    } catch {
      return { ok: false, reason: "broken", detail: "a plugin file is unreadable" };
    }
    if (sha256(bytes) !== pinned) return { ok: false, reason: "broken", detail: "a plugin file does not match its install receipt" };
    const source = bytes.toString("utf8");
    if (await hasImports(source)) return { ok: false, reason: "broken", detail: "a plugin file has imports and cannot be loaded" };
    try {
      modules[file] = (await import(`data:text/javascript;base64,${bytes.toString("base64")}`)) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "broken", detail: "a plugin file failed to load" };
    }
  }
  return { ok: true, modules };
}
