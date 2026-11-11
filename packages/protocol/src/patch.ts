import type * as bridgeApi from "./bridge-api.js";

type PatchOp = bridgeApi.PatchOp;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const escape = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1");
const unescape = (k: string): string => k.replace(/~1/g, "/").replace(/~0/g, "~");

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * RFC 6902 diff of two JSON values. Objects diff by key, arrays by index
 * (common prefix element-wise, then a tail add/remove). Linear in the size of the
 * data and allocation-light, so a 1 MiB topic diffs in a few milliseconds.
 */
export function diff(a: Json, b: Json): PatchOp[] {
  const ops: PatchOp[] = [];
  walk(a, b, [], ops);
  return ops;
}

/** Paths are kept as a token stack and only joined when an op is emitted. */
const ptr = (stack: string[], last?: string): string => {
  let out = "";
  for (const t of stack) out += "/" + escape(t);
  return last === undefined ? out : out + "/" + escape(last);
};

function walk(a: Json, b: Json, stack: string[], ops: PatchOp[]): void {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i] as Json;
      const y = b[i] as Json;
      if (x === y) continue;
      stack.push(String(i));
      walk(x, y, stack, ops);
      stack.pop();
    }
    for (let i = a.length - 1; i >= n; i--) ops.push({ op: "remove", path: ptr(stack, String(i)) });
    for (let i = n; i < b.length; i++) ops.push({ op: "add", path: ptr(stack, String(i)), value: b[i] });
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k in a) {
      if (!Object.hasOwn(b, k)) ops.push({ op: "remove", path: ptr(stack, k) });
    }
    for (const k in b) {
      const bv = b[k] as Json;
      if (!Object.hasOwn(a, k)) {
        ops.push({ op: "add", path: ptr(stack, k), value: bv });
        continue;
      }
      const av = a[k] as Json;
      if (av === bv) continue;
      stack.push(k);
      walk(av, bv, stack, ops);
      stack.pop();
    }
    return;
  }
  ops.push({ op: "replace", path: ptr(stack), value: b });
}

export class PatchError extends Error {}

function parse(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new PatchError(`bad pointer ${path}`);
  return path.slice(1).split("/").map(unescape);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function locate(doc: Json, tokens: string[]): { parent: Json; key: string } {
  let cur: Json = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i] as string;
    const next: Json | undefined = Array.isArray(cur) ? cur[Number(t)] : isObj(cur) && Object.hasOwn(cur, t) ? cur[t] : undefined;
    if (next === undefined) throw new PatchError(`missing ${t}`);
    cur = next;
  }
  return { parent: cur, key: tokens[tokens.length - 1] as string };
}

function getAt(doc: Json, path: string): Json {
  const tokens = parse(path);
  if (tokens.length === 0) return doc;
  const { parent, key } = locate(doc, tokens);
  const v = Array.isArray(parent) ? parent[Number(key)] : isObj(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined;
  if (v === undefined) throw new PatchError(`missing ${path}`);
  return v;
}

function arrayIndex(key: string, len: number, allowEnd: boolean): number {
  if (key === "-" && allowEnd) return len;
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`bad index ${key}`);
  const i = Number(key);
  if (i > len || (!allowEnd && i === len)) throw new PatchError(`index out of range ${key}`);
  return i;
}

function addAt(doc: Json, path: string, value: Json): Json {
  const tokens = parse(path);
  if (tokens.length === 0) return value;
  const { parent, key } = locate(doc, tokens);
  if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length, true), 0, value);
  else if (isObj(parent)) Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
  else throw new PatchError(`cannot add at ${path}`);
  return doc;
}

function removeAt(doc: Json, path: string): Json {
  const tokens = parse(path);
  if (tokens.length === 0) throw new PatchError("cannot remove root");
  const { parent, key } = locate(doc, tokens);
  if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length, false), 1);
  else if (isObj(parent) && Object.hasOwn(parent, key)) delete parent[key];
  else throw new PatchError(`missing ${path}`);
  return doc;
}

/** Applies RFC 6902 operations to a deep copy of `doc` (reference client behaviour, used by tests and tools). */
export function applyPatch(doc: Json, ops: readonly PatchOp[]): Json {
  let cur = clone(doc);
  for (const op of ops) {
    switch (op.op) {
      case "add":
        cur = addAt(cur, op.path, clone(op.value as Json));
        break;
      case "remove":
        cur = removeAt(cur, op.path);
        break;
      case "replace":
        getAt(cur, op.path);
        cur = op.path === "" ? clone(op.value as Json) : addAt(removeAt(cur, op.path), op.path, clone(op.value as Json));
        break;
      case "move": {
        const v = getAt(cur, op.from);
        cur = addAt(removeAt(cur, op.from), op.path, v);
        break;
      }
      case "copy":
        cur = addAt(cur, op.path, clone(getAt(cur, op.from)));
        break;
      case "test":
        if (JSON.stringify(getAt(cur, op.path)) !== JSON.stringify(op.value)) throw new PatchError(`test failed ${op.path}`);
        break;
    }
  }
  return cur;
}
