import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Binaries } from "../../src/plugins/detect.js";

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export function tmp(prefix = "s7-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** A fake CLI: a POSIX shell script that replays `body` (exit code and output chosen by the test). */
export function fakeCli(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Fake panorama contract: same exports as the real one, but written here (no real plugin code is copied). */
export const FAKE_CONTRACT = `export const FEED_PROBE = 'panorama app-feed v2';
export function parseFeed(text) {
  const f = JSON.parse(text);
  if (f.v !== 2 || !Array.isArray(f.roots)) throw Error('feed');
  return f;
}
export const aged = (p, now = Date.now()) => !Number.isFinite(p?.generated_at) || p.generated_at * 1000 > now || now - p.generated_at * 1000 > 15000;
`;

export const NOW = 1_800_000_000_000;

export function panoramaHome(opts: { contract?: string; pinned?: string; feed?: unknown | null; receipt?: "none" | "bad" | "ok" } = {}): string {
  const home = tmp("s7-home-");
  const contract = opts.contract ?? FAKE_CONTRACT;
  const rel = "mods/panorama/contract.js";
  put(home, rel, contract);
  if (opts.receipt !== "none") {
    const receipt =
      opts.receipt === "bad"
        ? "{not json"
        : JSON.stringify({ v: 2, files: { [rel]: { sha256: opts.pinned ?? sha(contract), mode: 420 } } });
    put(home, "data/panorama/install.json", receipt);
  }
  if (opts.feed !== null) {
    put(home, "data/panorama/feed.json", typeof opts.feed === "string" ? opts.feed : JSON.stringify(opts.feed ?? feed()));
  }
  return home;
}

export function feed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, generated_at: NOW / 1000 - 3, herdr_ok: true, inbox_ok: true, errors: [], counts: {}, roots: [], ...over };
}

export function bins(dir: string, over: Partial<Binaries> = {}): Binaries {
  return { hc: join(dir, "absent-hc"), inbox: join(dir, "absent-inbox"), usagebar: join(dir, "absent-usagebar"), ...over };
}
