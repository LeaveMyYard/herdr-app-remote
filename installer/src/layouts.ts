// The derived layouts: a copy of a layout with our two blocks added, nothing else changed.
// - the link block: the last child of the always-shown `work` column, 1 px, role "link";
// - the panel block: the last child of the `panel-body` stack, role "panel" (the stack's
//   `active` child is left as it was, so the panel opens on Files as before).
// A copy without a role stays inert (mod-link-v1.md "Copies"), so the roles are what make it work.
import { install } from "@herdr-remote/protocol";

type Node = { id?: unknown; type?: unknown; hidden?: unknown; children?: unknown; content?: unknown; [k: string]: unknown };

export const LINK_BLOCK = Object.freeze({
  id: install.LINK_BLOCK_ID,
  type: "block",
  size: { px: 1 },
  content: { mod: install.MOD_NAME, props: { role: "link" } },
});

export const PANEL_BLOCK = Object.freeze({
  id: install.PANEL_BLOCK_ID,
  type: "block",
  content: { mod: install.MOD_NAME, props: { role: "panel" } },
});

function isNode(v: unknown): v is Node {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function* nodes(n: Node, path: Node[] = []): Generator<[Node, Node[]]> {
  yield [n, path];
  if (Array.isArray(n.children)) for (const c of n.children) if (isNode(c)) yield* nodes(c, [...path, n]);
  // Floating blocks are over a node, never part of its children; our ids must not clash with them either.
  if (Array.isArray(n.floating)) for (const c of n.floating) if (isNode(c)) yield* nodes(c, [...path, n]);
}

/** Every string anywhere in a layout (to find which mods it names). */
export function strings(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isNode(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Whether a layout uses our mod (any block naming it). */
export function usesMod(layout: unknown): boolean {
  return strings(layout).has(install.MOD_NAME);
}

/**
 * The derived layout's bytes from the source layout's bytes. Throws, naming what is wrong, when the
 * source is not a layout we can extend: not JSON, no `work` column, `work` (or a node above it)
 * hidden, no `panel-body` stack, or ids or our mod already there.
 */
export function derive(source: Buffer | string, name: string): string {
  let root: unknown;
  try {
    root = JSON.parse(source.toString());
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (!isNode(root)) throw new Error(`${name} is not a layout`);
  if (usesMod(root)) throw new Error(`${name} already names ${install.MOD_NAME}`);
  let work: [Node, Node[]] | undefined;
  let stack: Node | undefined;
  for (const [n, path] of nodes(root)) {
    if (n.id === install.LINK_BLOCK_ID || n.id === install.PANEL_BLOCK_ID) throw new Error(`${name} already has a node with id ${String(n.id)}`);
    if (n.id === install.LINK_PARENT_ID) work = [n, path];
    if (n.id === install.PANEL_PARENT_ID) stack = n;
  }
  if (!work || work[0].type !== "column" || !Array.isArray(work[0].children)) throw new Error(`${name} has no "${install.LINK_PARENT_ID}" column`);
  // A hidden node never starts its mod, so the link must sit where nothing hides it.
  if ([work[0], ...work[1]].some((n) => n.hidden === true)) throw new Error(`${name} hides the "${install.LINK_PARENT_ID}" column`);
  if (!stack || stack.type !== "stack" || !Array.isArray(stack.children)) throw new Error(`${name} has no "${install.PANEL_PARENT_ID}" stack`);
  work[0].children.push(structuredClone(LINK_BLOCK));
  stack.children.push(structuredClone(PANEL_BLOCK));
  return JSON.stringify(root, null, 2) + "\n";
}

/**
 * Panorama's own record of its layout: `{v: 2, files: {"layouts/panorama.json": {sha256, mode}}}`.
 * Returns the recorded hash, or null when panorama's record is missing or not that shape.
 */
export function panoramaLayoutSha(receiptText: string | null): string | null {
  if (receiptText === null) return null;
  let r: unknown;
  try {
    r = JSON.parse(receiptText);
  } catch {
    return null;
  }
  if (!isNode(r) || r.v !== 2 || !isNode(r.files)) return null;
  const entry = (r.files as Record<string, unknown>)["layouts/panorama.json"];
  if (!isNode(entry) || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
  return entry.sha256;
}
