// Config-root discovery: agent-usage's `[[claude.profiles]]` only, deduplicated by the projects realpath.
// No `~/.claude*` scan, no CLAUDE_CONFIG_DIR, no fallback. Every home here is private and fake.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claude } from "../../src/index.js";

const { discoverRoots, normalizeDir, profileDirs, PROFILES_FILE_LIMIT } = claude;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, ".config/agent-usage"), 0o700);
      chmodSync(join(d, ".config/agent-usage/config.toml"), 0o600);
    } catch {
      // not every test makes them
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A private home with an app home and, unless told otherwise, `.claude-1` and `.claude-2` with projects dirs. */
function home(o: { claudeDirs?: string[] } = {}): { home: string; appHome: string } {
  const h = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "cp-"));
  dirs.push(h);
  const appHome = join(h, ".config/herdr-app");
  mkdirSync(appHome, { recursive: true });
  for (const d of o.claudeDirs ?? [".claude-1", ".claude-2"]) mkdirSync(join(h, d, "projects"), { recursive: true });
  return { home: h, appHome };
}

function config(h: string, toml: string, dir = join(h, ".config/agent-usage")): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), toml);
  return join(dir, "config.toml");
}

const TWO = `
[notify]
delivery = "external"

[[claude.profiles]]
id = "agent-1"
label = "Agent 1"
config_dir = "~/.claude-1"

[[claude.profiles]]
id = "agent-2"
config_dir = "~/.claude-2/"
`;

describe("discoverRoots", () => {
  it("lists one root per profile from agent-usage's config, with ~ expanded", async () => {
    const w = home();
    config(w.home, TWO);
    const r = await discoverRoots(w);
    expect(r).toEqual({
      ok: true,
      roots: [
        { configDir: join(w.home, ".claude-1"), projects: join(w.home, ".claude-1/projects"), profileIds: ["agent-1"] },
        { configDir: join(w.home, ".claude-2"), projects: join(w.home, ".claude-2/projects"), profileIds: ["agent-2"] },
      ],
    });
  });

  it("does not scan ~/.claude*: a ~/.claude and a ~/.claude-3 the profile list doesn't name are ignored", async () => {
    const w = home({ claudeDirs: [".claude", ".claude-1", ".claude-3"] });
    config(w.home, `[[claude.profiles]]\nid = "agent-1"\nconfig_dir = "~/.claude-1"\n`);
    const r = await discoverRoots(w);
    expect(r.ok && r.roots.map((x) => x.configDir)).toEqual([join(w.home, ".claude-1")]);
  });

  it("is no_profiles when agent-usage has no config, even with ~/.claude present (no fallback)", async () => {
    const w = home({ claudeDirs: [".claude", ".claude-1"] });
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "missing" });
  });

  it("ignores CLAUDE_CONFIG_DIR", async () => {
    const w = home({ claudeDirs: [".claude-1", ".claude-env"] });
    config(w.home, `[[claude.profiles]]\nid = "agent-1"\nconfig_dir = "~/.claude-1"\n`);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(w.home, ".claude-env");
    try {
      const r = await discoverRoots(w);
      expect(r.ok && r.roots.map((x) => x.configDir)).toEqual([join(w.home, ".claude-1")]);
      // and with no profile list at all it is still no_profiles, not the env dir
      rmSync(join(w.home, ".config/agent-usage"), { recursive: true });
      expect(await discoverRoots(w)).toMatchObject({ ok: false, reason: "no_profiles" });
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("is no_profiles (unreadable) when the config can't be read", async () => {
    const w = home();
    const file = config(w.home, TWO);
    chmodSync(file, 0o000);
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "unreadable" });
  });

  it("is no_profiles (unreadable) for a directory or an oversized file", async () => {
    const w = home();
    mkdirSync(join(w.home, ".config/agent-usage/config.toml"), { recursive: true });
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "unreadable" });
    const v = home();
    config(v.home, TWO + "#".repeat(PROFILES_FILE_LIMIT));
    expect(await discoverRoots(v)).toEqual({ ok: false, reason: "no_profiles", detail: "unreadable" });
  });

  it("is no_profiles (invalid) when the config is not TOML", async () => {
    const w = home();
    config(w.home, "[[claude.profiles]\nid = ");
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "invalid" });
  });

  it("is no_profiles (empty) with no [[claude.profiles]], unlike agent-usage's implicit ~/.claude default", async () => {
    const w = home({ claudeDirs: [".claude"] });
    config(w.home, `[notify]\ndelivery = "external"\n`);
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "empty" });
    config(w.home, `[claude]\nprofiles = "~/.claude"\n`);
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "empty" });
  });

  it("is no_profiles (no_projects) when no profile has a projects dir yet", async () => {
    const w = home({ claudeDirs: [] });
    config(w.home, TWO);
    expect(await discoverRoots(w)).toEqual({ ok: false, reason: "no_profiles", detail: "no_projects" });
  });

  it("skips a profile without a projects dir and keeps the others", async () => {
    const w = home({ claudeDirs: [".claude-2"] });
    config(w.home, TWO);
    const r = await discoverRoots(w);
    expect(r.ok && r.roots.map((x) => x.profileIds)).toEqual([["agent-2"]]);
  });

  it("collapses profiles whose projects dirs are one dir (symlink) into one root", async () => {
    const w = home({ claudeDirs: [".claude-1"] });
    mkdirSync(join(w.home, ".claude-2"));
    symlinkSync(join(w.home, ".claude-1/projects"), join(w.home, ".claude-2/projects"));
    config(w.home, TWO);
    expect(await discoverRoots(w)).toEqual({
      ok: true,
      roots: [{ configDir: join(w.home, ".claude-1"), projects: join(w.home, ".claude-1/projects"), profileIds: ["agent-1", "agent-2"] }],
    });
  });

  it("follows mods/agent-usage/local.json configDir, like the usage topic", async () => {
    const w = home();
    const moved = join(w.home, "elsewhere/agent-usage");
    config(w.home, `[[claude.profiles]]\nid = "agent-2"\nconfig_dir = "~/.claude-2"\n`, moved);
    config(w.home, TWO); // the default location is not read when local.json moves it
    mkdirSync(join(w.appHome, "mods/agent-usage"), { recursive: true });
    writeFileSync(join(w.appHome, "mods/agent-usage/local.json"), JSON.stringify({ configDir: moved }));
    const r = await discoverRoots(w);
    expect(r.ok && r.roots.map((x) => x.profileIds)).toEqual([["agent-2"]]);
  });
});

describe("profileDirs", () => {
  it("keeps what agent-usage's validateSpec keeps: id, absolute dir, first wins on a repeated id or dir", () => {
    const h = "/home/user-1";
    const doc = {
      claude: {
        profiles: [
          { id: "agent-1", config_dir: "~/.claude-1" },
          { id: "", config_dir: "~/.claude-2" },
          { id: "agent-3", config_dir: "relative/dir" },
          { id: "agent-4" },
          { id: "agent-1", config_dir: "~/.claude-5" },
          { id: "agent-6", config_dir: "/home/user-1/./.claude-1/" },
          { id: 7, config_dir: "~/.claude-7" },
          "not a table",
          { id: "agent-8", config_dir: "/home/user-1/.claude-8" },
        ],
      },
    };
    expect(profileDirs(doc, h)).toEqual([
      { id: "agent-1", configDir: "/home/user-1/.claude-1" },
      { id: "agent-8", configDir: "/home/user-1/.claude-8" },
    ]);
  });

  it("normalizes like agent-usage", () => {
    expect(normalizeDir("~", "/home/user-1")).toBe("/home/user-1");
    expect(normalizeDir("~/.claude-1/", "/home/user-1")).toBe("/home/user-1/.claude-1");
    expect(normalizeDir("/a/./b/../c", "/home/user-1")).toBe("/a/c");
    expect(normalizeDir("~other/x", "/home/user-1")).toBe("~other/x");
    expect(normalizeDir("", "/home/user-1")).toBe("");
  });
});
