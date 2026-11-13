// Choosing a reader root for a panorama-proved session (docs/chatview.md §2.2), and the ClaudeHistory
// facade's results. Private fake homes; the pool here is a stub, so no child runs.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claude } from "../../src/index.js";

const { chooseRoot, ClaudeHistory, ReaderPool } = claude;
type ClaudeRoot = claude.ClaudeRoot;
type ReaderRequest = claude.ReaderRequest;
type ReaderReply = claude.ReaderReply;

const S = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
  const h = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "cb-"));
  dirs.push(h);
  const roots: ClaudeRoot[] = [1, 2].map((n) => {
    const configDir = join(h, `.claude-${n}`);
    mkdirSync(join(configDir, "projects/-work-project-alpha"), { recursive: true });
    return { configDir, projects: join(configDir, "projects"), profileIds: [`agent-${n}`] };
  });
  return { h, roots };
}

/** A pool stub: answers getSessionInfo from a table of root configDir -> reply, and records the calls. */
function stub(answers: Record<string, ReaderReply>) {
  const calls: { root: string; req: ReaderRequest }[] = [];
  return {
    calls,
    pool: {
      call: (root: ClaudeRoot, req: ReaderRequest): Promise<ReaderReply> => {
        calls.push({ root: root.configDir, req });
        return Promise.resolve(answers[root.configDir] ?? { ok: true, value: null });
      },
    },
  };
}

describe("chooseRoot", () => {
  it("matches the realpath of the transcript's projects dir, without asking any reader", async () => {
    const { roots } = world();
    const s = stub({});
    const transcript = join(roots[1]!.projects, "-work-project-alpha", `${S}.jsonl`);
    expect(await chooseRoot(roots, s.pool, { sessionId: S, transcript, cwd: "/work/project-alpha" })).toEqual({
      ok: true,
      binding: { sessionId: S, root: roots[1], via: "transcript" },
    });
    expect(s.calls).toEqual([]);
  });

  it("matches through a symlinked config dir", async () => {
    const { h, roots } = world();
    symlinkSync(roots[0]!.configDir, join(h, ".claude-link"));
    const transcript = join(h, ".claude-link/projects/-work-project-alpha", `${S}.jsonl`);
    const r = await chooseRoot(roots, stub({}).pool, { sessionId: S, transcript, cwd: null });
    expect(r).toMatchObject({ ok: true, binding: { root: roots[0], via: "transcript" } });
  });

  it("falls back to getSessionInfo(id, {dir: cwd}) in each agent-usage reader, first hit wins", async () => {
    const { h, roots } = world();
    const elsewhere = join(h, ".claude/projects/-work-project-alpha");
    mkdirSync(elsewhere, { recursive: true });
    const s = stub({ [roots[1]!.configDir]: { ok: true, value: { sessionId: S, cwd: "/work/project-alpha" } } });
    const r = await chooseRoot(roots, s.pool, { sessionId: S, transcript: join(elsewhere, `${S}.jsonl`), cwd: "/work/project-alpha" });
    expect(r).toEqual({ ok: true, binding: { sessionId: S, root: roots[1], via: "info" } });
    // only agent-usage roots were asked, never the ~/.claude the transcript is under
    expect(s.calls).toEqual([
      { root: roots[0]!.configDir, req: { op: "info", session: S, dir: "/work/project-alpha" } },
      { root: roots[1]!.configDir, req: { op: "info", session: S, dir: "/work/project-alpha" } },
    ]);
  });

  it("does not accept info for another session", async () => {
    const { roots } = world();
    const other = "22222222-2222-4222-8222-222222222222";
    const s = stub({ [roots[0]!.configDir]: { ok: true, value: { sessionId: other } } });
    expect(await chooseRoot(roots, s.pool, { sessionId: S, transcript: null, cwd: "/work/project-alpha" })).toEqual({ ok: false, reason: "no_binding" });
  });

  it("is no_binding when no reader has the session", async () => {
    const { roots } = world();
    expect(await chooseRoot(roots, stub({}).pool, { sessionId: S, transcript: "/nowhere/projects/x/y.jsonl", cwd: "/work/project-alpha" })).toEqual({ ok: false, reason: "no_binding" });
  });

  it("is reader_failed when a reader that might have it could not answer", async () => {
    const { roots } = world();
    const s = stub({ [roots[0]!.configDir]: { ok: false, error: "timeout" } });
    expect(await chooseRoot(roots, s.pool, { sessionId: S, transcript: null, cwd: "/work/project-alpha" })).toEqual({ ok: false, reason: "reader_failed", detail: "timeout" });
  });

  it("asks no reader without an absolute cwd or a session id that is a UUID", async () => {
    const { roots } = world();
    const s = stub({});
    expect(await chooseRoot(roots, s.pool, { sessionId: S, transcript: null, cwd: null })).toEqual({ ok: false, reason: "no_binding" });
    expect(await chooseRoot(roots, s.pool, { sessionId: S, transcript: "relative/x.jsonl", cwd: "work" })).toEqual({ ok: false, reason: "no_binding" });
    expect(await chooseRoot(roots, s.pool, { sessionId: "../x", transcript: join(roots[0]!.projects, "p/x.jsonl"), cwd: "/w" })).toEqual({ ok: false, reason: "no_binding" });
    expect(s.calls).toEqual([]);
  });
});

describe("ClaudeHistory", () => {
  it("bind is no_profiles without agent-usage, and starts no reader", async () => {
    const { h } = world();
    const pool = new ReaderPool({ script: "/nonexistent/claude-reader.mjs", home: h });
    const history = new ClaudeHistory({ appHome: join(h, ".config/herdr-app"), home: h, pool });
    expect(await history.bind({ sessionId: S, transcript: null, cwd: "/work/project-alpha" })).toEqual({ ok: false, reason: "no_profiles", detail: "missing" });
    expect(pool.running).toBe(0);
    history.close();
  });

  it("bind uses the roots from the profile list", async () => {
    const { h, roots } = world();
    mkdirSync(join(h, ".config/agent-usage"), { recursive: true });
    writeFileSync(join(h, ".config/agent-usage/config.toml"), `[[claude.profiles]]\nid = "agent-2"\nconfig_dir = "~/.claude-2"\n`);
    const history = new ClaudeHistory({ appHome: join(h, ".config/herdr-app"), home: h, pool: { script: "/nonexistent/claude-reader.mjs", home: h } });
    const transcript = join(roots[1]!.projects, "-work-project-alpha", `${S}.jsonl`);
    expect(await history.bind({ sessionId: S, transcript, cwd: null })).toMatchObject({ ok: true, binding: { root: { configDir: roots[1]!.configDir, profileIds: ["agent-2"] } } });
    // a transcript under a root the list doesn't name is not bound by path
    const other = join(roots[0]!.projects, "-work-project-alpha", `${S}.jsonl`);
    expect(await history.bind({ sessionId: S, transcript: other, cwd: null })).toEqual({ ok: false, reason: "no_binding" });
    history.close();
  });

  it("read maps reader errors and shape failures to reader_failed", async () => {
    const { roots } = world();
    const binding = { sessionId: S, root: roots[0]!, via: "transcript" as const };
    const fake = (reply: ReaderReply) => {
      const p = new ReaderPool({ script: "/nonexistent/claude-reader.mjs" });
      p.call = () => Promise.resolve(reply);
      return new ClaudeHistory({ appHome: "/nonexistent", pool: p });
    };
    expect(await fake({ ok: false, error: "rss" }).read(binding)).toEqual({ ok: false, reason: "reader_failed", detail: "rss" });
    expect(await fake({ ok: true, value: { not: "an array" } }).read(binding)).toMatchObject({ ok: false, reason: "reader_failed", detail: "shape" });
    expect(await fake({ ok: true, value: [] }).read(binding)).toMatchObject({ ok: true, messages: [] });
  });
});
