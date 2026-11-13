// Rig test for the chat view's Claude reader (docs/chatview.md §2.2): the real bundled reader child
// (packages/bridge/dist/claude-reader.mjs, with the pinned Claude Agent SDK) reads the fake transcripts in
// fixtures/claude under a private HOME, with roots from a fake agent-usage config. The SDK's raw output is
// compared byte for byte with fixtures/claude/expected, so an SDK bump that changes the shape fails CI, not
// the phone. Needs `pnpm -r build` first (CI builds before it tests). Fake data only; nothing here reads the
// real HOME, and no Claude process is ever started.
//
// To refresh the expected files after a deliberate SDK bump: UPDATE_CLAUDE_FIXTURES=1 pnpm --filter
// @herdr-remote/rig test, then review the diff like code.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claude } from "../../packages/bridge/dist/index.js";

const REPO = resolve(import.meta.dirname, "../..");
const FIX = join(REPO, "fixtures/claude");
const SCRIPT = join(REPO, "packages/bridge/dist/claude-reader.mjs");
const SDK_PKG = join(REPO, "packages/bridge/node_modules/@anthropic-ai/claude-agent-sdk/package.json");
const PINNED = "0.3.312";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const UPDATE = process.env.UPDATE_CLAUDE_FIXTURES === "1";

let home = "";
let appHome = "";
let history: claude.ClaudeHistory;

/** Every file under the private HOME with its size and mtime: the reader must leave it as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = statSync(p);
      out[relative(home, p)] = e.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function expected(name: string, actual: unknown): unknown {
  const file = join(FIX, "expected", name);
  if (UPDATE) {
    mkdirSync(join(FIX, "expected"), { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

beforeAll(() => {
  home = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "rig-claude-"));
  // claude-1 and claude-2 are the two profiles' config dirs; claude becomes a decoy ~/.claude that no profile names.
  for (const [from, to] of [["claude-1", "claude-agent-1"], ["claude-2", "claude-agent-2"], ["claude", ".claude"]]) cpSync(join(FIX, "roots", from!), join(home, to!), { recursive: true });
  mkdirSync(join(home, ".config/agent-usage"), { recursive: true });
  cpSync(join(FIX, "agent-usage/config.toml"), join(home, ".config/agent-usage/config.toml"));
  appHome = join(home, ".config/herdr-app");
  mkdirSync(appHome, { recursive: true });
  history = new claude.ClaudeHistory({ appHome, home, pool: { script: SCRIPT, home } });
});

afterAll(() => {
  history?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("Claude reader rig", () => {
  it("runs the pinned SDK, installed without its native binary", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(JSON.parse(readFileSync(SDK_PKG, "utf8")).version).toBe(PINNED);
    expect(readFileSync(SCRIPT, "utf8")).toContain(`/@anthropic-ai+claude-agent-sdk@${PINNED}_`);
    const sdkScope = join(REPO, "node_modules/.pnpm");
    expect(readdirSync(sdkScope).filter((d) => d.startsWith("@anthropic-ai+claude-agent-sdk-"))).toEqual([]);
  });

  it("lists the agent-usage roots only: ~/.claude is not one of them", async () => {
    expect(await history.discover()).toEqual({
      ok: true,
      roots: [
        { configDir: join(home, "claude-agent-1"), projects: join(home, "claude-agent-1/projects"), profileIds: ["agent-1"] },
        { configDir: join(home, "claude-agent-2"), projects: join(home, "claude-agent-2/projects"), profileIds: ["agent-2"] },
      ],
    });
  });

  it("binds by the transcript's projects dir", async () => {
    const transcript = join(home, "claude-agent-1/projects/-work-project-alpha", `${S1}.jsonl`);
    expect(await history.bind({ sessionId: S1, transcript, cwd: "/work/project-alpha" })).toMatchObject({ ok: true, binding: { via: "transcript", root: { profileIds: ["agent-1"] } } });
  });

  it("binds through the real getSessionInfo fallback in the agent-usage readers", async () => {
    expect(await history.bind({ sessionId: S2, transcript: null, cwd: "/work/project-beta" })).toMatchObject({ ok: true, binding: { via: "info", root: { profileIds: ["agent-2"] } } });
  });

  it("never finds a session that only ~/.claude holds", async () => {
    const transcript = join(home, ".claude/projects/-work-project-alpha", `${S3}.jsonl`);
    expect(await history.bind({ sessionId: S3, transcript, cwd: "/work/project-alpha" })).toEqual({ ok: false, reason: "no_binding" });
  });

  it("the SDK's raw shape is the pinned one", async () => {
    const roots = await history.discover();
    if (!roots.ok) throw new Error("no roots");
    const raw = await history.pool.call(roots.roots[0]!, { op: "messages", session: S1 });
    expect(raw.ok).toBe(true);
    const value = (raw as { value: unknown }).value;
    expect(value).toEqual(expected(`${S1}.raw.json`, value));
  });

  it("reads and checks the session: nothing failed, thinking and tool output gone", async () => {
    const transcript = join(home, "claude-agent-1/projects/-work-project-alpha", `${S1}.jsonl`);
    const b = await history.bind({ sessionId: S1, transcript, cwd: "/work/project-alpha" });
    if (!b.ok) throw new Error("not bound");
    const r = await history.read(b.binding);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats.failed).toBe(0);
    expect(r).toEqual(expected(`${S1}.checked.json`, r));
    const text = JSON.stringify(r);
    expect(text).not.toContain("Fake thinking");
    expect(text).not.toContain("Fake test output");
    expect(text).not.toContain("subagent prompt");
    expect(text).not.toContain("half-wri");
    // a page of it is the same messages
    const page = await history.read(b.binding, { offset: 2, limit: 3 });
    expect(page.ok && page.messages).toEqual(r.messages.slice(2, 5));
  });

  it("an unknown session reads as empty", async () => {
    const roots = await history.discover();
    if (!roots.ok) throw new Error("no roots");
    const r = await history.read({ sessionId: "44444444-4444-4444-8444-444444444444", root: roots.roots[0]!, via: "transcript" });
    expect(r).toMatchObject({ ok: true, messages: [] });
  });

  it("left the private HOME as it was", async () => {
    const before = snapshot(home);
    const roots = await history.discover();
    if (!roots.ok) throw new Error("no roots");
    for (const root of roots.roots) await history.pool.call(root, { op: "messages", session: S1 });
    await history.bind({ sessionId: S2, transcript: null, cwd: "/work/project-beta" });
    expect(snapshot(home)).toEqual(before);
  });

  it("the real child exits by itself when idle, and refuses to start without CLAUDE_CONFIG_DIR", async () => {
    const run = (env: Record<string, string>) =>
      new Promise<{ code: number | null; ms: number }>((done) => {
        const t0 = Date.now();
        // stdin stays open: only the child's own idle timer can end it
        const p = spawn(process.execPath, [SCRIPT, "--idle-ms", "300"], { env, stdio: ["pipe", "ignore", "ignore"] });
        p.on("exit", (code) => done({ code, ms: Date.now() - t0 }));
      });
    const idle = await run({ CLAUDE_CONFIG_DIR: join(home, "claude-agent-1"), HOME: home });
    expect(idle.code).toBe(0);
    expect(idle.ms).toBeGreaterThanOrEqual(300);
    expect(idle.ms).toBeLessThan(5000);
    expect((await run({ HOME: home })).code).toBe(2);
  });
});
