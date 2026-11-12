import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { DEFAULT_BINARIES, type Binaries } from "./detect.js";

/**
 * Where the desktop CLIs are looked for when they are not on the bridge's PATH. herdr-app started from a desktop
 * launcher often has a PATH without `~/.local/bin`, which is where hc, usagebar and herdr-inbox install themselves.
 */
export const FALLBACK_DIRS = (home: string): string[] => [join(home, ".local/bin"), join(home, ".cargo/bin"), "/usr/local/bin", "/opt/homebrew/bin"];

/** How long a found binary is trusted before it is looked up again (a missing one is looked for on every use). */
export const RESOLVE_TTL_MS = 30_000;

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolveEnv {
  /** The PATH to search; default the bridge's own. */
  path?: string;
  /** For the fallback dirs; default the user's home. */
  home?: string;
}

/**
 * The absolute path of `name`: the first executable on PATH (absolute entries only: a relative one depends on the
 * cwd), else in {@link FALLBACK_DIRS}. A name with a slash is taken as given. Null when it is nowhere.
 */
export function resolveBinary(name: string, env: ResolveEnv = {}): string | null {
  if (name.includes("/")) return isAbsolute(name) && executable(name) ? name : null;
  const path = env.path ?? process.env.PATH ?? "";
  const dirs = [...path.split(delimiter).filter((d) => isAbsolute(d)), ...FALLBACK_DIRS(env.home ?? homedir())];
  for (const dir of dirs) {
    const p = join(dir, name);
    if (executable(p)) return p;
  }
  return null;
}

/**
 * The binaries the bridge runs, each resolved to an absolute path by {@link resolveBinary} and shared by every user:
 * the `hc` that detection (`plugins`, the panel's Setup) reports on is the one chat, `terminal.send` and
 * `terminal.keys` run. Read at each use, so installing a CLI later is noticed without a restart. When a name is
 * found nowhere its bare name is returned, so running it fails with ENOENT and is reported as missing.
 */
export function resolvedBinaries(env: ResolveEnv & { ttlMs?: number; now?: () => number } = {}): Binaries {
  const ttl = env.ttlMs ?? RESOLVE_TTL_MS;
  const now = env.now ?? Date.now;
  const cache = new Map<string, { path: string; at: number }>();
  const get = (name: string): string => {
    const hit = cache.get(name);
    if (hit && now() - hit.at < ttl) return hit.path;
    const p = resolveBinary(name, env);
    if (p === null) {
      cache.delete(name);
      return name;
    }
    cache.set(name, { path: p, at: now() });
    return p;
  };
  return {
    get hc() {
      return get(DEFAULT_BINARIES.hc);
    },
    get inbox() {
      return get(DEFAULT_BINARIES.inbox);
    },
    get usagebar() {
      return get(DEFAULT_BINARIES.usagebar);
    },
  };
}
