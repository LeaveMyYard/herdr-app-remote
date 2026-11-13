// Claude config roots for the chat view (docs/chatview.md §2.2). The only source is herdr-agent-usage's
// profile list: `[[claude.profiles]].config_dir` in `<agent-usage config dir>/config.toml`, the file the
// desktop panel's `usagebar` reads. The file is read, never written. There is no `~/.claude*` scan, no
// `$CLAUDE_CONFIG_DIR` source and no fallback: without a usable profile list the result is `no_profiles`.
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readLocal } from "../usage.js";

/** The agent-usage config is small; anything bigger is refused unread. */
export const PROFILES_FILE_LIMIT = 1024 * 1024;

/** One reader root: a config dir and the realpath of its `projects` dir, which is what roots are deduplicated by. */
export interface ClaudeRoot {
  /** The first profile's `config_dir` (absolute, `~` expanded). The reader child runs with `CLAUDE_CONFIG_DIR` set to it. */
  configDir: string;
  /** realpath of `<configDir>/projects`. Two profiles whose `projects` resolve to one dir share one root. */
  projects: string;
  /** agent-usage profile ids that resolved to this root, in config order. */
  profileIds: string[];
}

/**
 * Why there are no roots. All map to the §6 `no_profiles` case:
 * - `missing`: no agent-usage config file (agent-usage is not installed or never configured);
 * - `unreadable`: the file exists but can't be read, or is over the size limit;
 * - `invalid`: it is not TOML;
 * - `empty`: no valid `[[claude.profiles]]` entry;
 * - `no_projects`: valid profiles, but none has a `projects` dir yet.
 */
export type NoProfilesDetail = "missing" | "unreadable" | "invalid" | "empty" | "no_projects";

export type DiscoverResult = { ok: true; roots: ClaudeRoot[] } | { ok: false; reason: "no_profiles"; detail: NoProfilesDetail };

export interface DiscoverOptions {
  /** The herdr-app home: `<appHome>/mods/agent-usage/local.json` may move agent-usage's config dir, as for the usage topic. */
  appHome: string;
  /** For `~` and the default config dir (`~/.config/agent-usage`). Default: the bridge user's home. */
  home?: string;
}

/** The path the profile list is read from: `<configDir>/config.toml`, where configDir follows `local.json` like `usage.ts`. */
export async function profilesPath(o: DiscoverOptions): Promise<string> {
  const home = o.home ?? homedir();
  const local = await readLocal(o.appHome);
  return join(local.configDir ?? join(home, ".config", "agent-usage"), "config.toml");
}

/** Like agent-usage's `normalizePath`: a leading `~` is expanded, the result cleaned. A relative path is not resolved. */
export function normalizeDir(path: string, home: string): string {
  if (path === "") return "";
  if (home && (path === "~" || path.startsWith("~/"))) path = join(home, path.slice(1));
  const n = normalize(path);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * The `[[claude.profiles]]` entries agent-usage itself would accept (its `validateSpec`): a non-empty string
 * `id` and a `config_dir` that normalizes to an absolute path, first wins on a repeated id or dir. Everything
 * else in the document is ignored.
 */
export function profileDirs(doc: unknown, home: string): { id: string; configDir: string }[] {
  const claude = isRecord(doc) ? doc.claude : undefined;
  const list = isRecord(claude) ? claude.profiles : undefined;
  if (!Array.isArray(list)) return [];
  const out: { id: string; configDir: string }[] = [];
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const p of list) {
    if (!isRecord(p) || typeof p.id !== "string" || typeof p.config_dir !== "string" || p.id === "") continue;
    const dir = normalizeDir(p.config_dir, home);
    if (!dir || !isAbsolute(dir) || ids.has(p.id) || dirs.has(dir)) continue;
    ids.add(p.id);
    dirs.add(dir);
    out.push({ id: p.id, configDir: dir });
  }
  return out;
}

async function readCapped(path: string): Promise<{ ok: true; text: string } | { ok: false; detail: "missing" | "unreadable" }> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (e) {
    return { ok: false, detail: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > PROFILES_FILE_LIMIT) return { ok: false, detail: "unreadable" };
    const buf = Buffer.alloc(PROFILES_FILE_LIMIT + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > PROFILES_FILE_LIMIT) return { ok: false, detail: "unreadable" };
    return { ok: true, text: buf.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { ok: false, detail: "unreadable" };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Lists the reader roots, from agent-usage's profile list only. */
export async function discoverRoots(o: DiscoverOptions): Promise<DiscoverResult> {
  const home = o.home ?? homedir();
  const file = await readCapped(await profilesPath(o));
  if (!file.ok) return { ok: false, reason: "no_profiles", detail: file.detail };
  let doc: unknown;
  try {
    doc = parseToml(file.text);
  } catch {
    return { ok: false, reason: "no_profiles", detail: "invalid" };
  }
  const profiles = profileDirs(doc, home);
  if (profiles.length === 0) return { ok: false, reason: "no_profiles", detail: "empty" };
  const byProjects = new Map<string, ClaudeRoot>();
  for (const p of profiles) {
    let projects: string;
    try {
      projects = await realpath(join(p.configDir, "projects"));
      if (!(await stat(projects)).isDirectory()) continue;
    } catch {
      continue; // no sessions under this profile yet
    }
    const seen = byProjects.get(projects);
    if (seen) seen.profileIds.push(p.id);
    else byProjects.set(projects, { configDir: p.configDir, projects, profileIds: [p.id] });
  }
  if (byProjects.size === 0) return { ok: false, reason: "no_profiles", detail: "no_projects" };
  return { ok: true, roots: [...byProjects.values()] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
