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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { bridgeApi } from "../../packages/protocol/dist/index.js";
import { chatview, claude, Hub } from "../../packages/bridge/dist/index.js";

const REPO = resolve(import.meta.dirname, "../..");
const FIX = join(REPO, "fixtures/claude");
const SCRIPT = join(REPO, "packages/bridge/dist/claude-reader.mjs");
const SCRIPT_SHA = createHash("sha256").update(readFileSync(SCRIPT)).digest("hex");
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
  history = new claude.ClaudeHistory({ appHome, home, pool: { script: SCRIPT, scriptSha256: SCRIPT_SHA, home } });
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

  it("an unknown session, or one in another root, is not_found", async () => {
    const roots = await history.discover();
    if (!roots.ok) throw new Error("no roots");
    expect(await history.read({ sessionId: "44444444-4444-4444-8444-444444444444", root: roots.roots[0]!, via: "transcript" })).toEqual({ ok: false, reason: "not_found" });
    expect(await history.read({ sessionId: S2, root: roots.roots[0]!, via: "transcript" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("reads through a profile whose projects dir is a symlink (the read grant covers its own path)", async () => {
    const h2 = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "rig-claude-link-"));
    try {
      cpSync(join(FIX, "roots/claude-1/projects"), join(h2, "shared-projects"), { recursive: true });
      mkdirSync(join(h2, "claude-agent-1"));
      symlinkSync(join(h2, "shared-projects"), join(h2, "claude-agent-1/projects"));
      mkdirSync(join(h2, ".config/agent-usage"), { recursive: true });
      writeFileSync(join(h2, ".config/agent-usage/config.toml"), `[[claude.profiles]]\nid = "agent-1"\nconfig_dir = "~/claude-agent-1"\n`);
      const h = new claude.ClaudeHistory({ appHome: join(h2, ".config/herdr-app"), home: h2, pool: { script: SCRIPT, scriptSha256: SCRIPT_SHA, home: h2 } });
      try {
        const b = await h.bind({ sessionId: S1, transcript: join(h2, "claude-agent-1/projects/-work-project-alpha", `${S1}.jsonl`), cwd: null });
        if (!b.ok) throw new Error(`not bound: ${JSON.stringify(b)}`);
        const r = await h.read(b.binding);
        expect(r.ok && r.messages.length).toBe(18);
      } finally {
        h.close();
      }
    } finally {
      rmSync(h2, { recursive: true, force: true });
    }
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

describe("chat view on the real reader (CV3)", () => {
  const T = "t1";
  const TOPIC = `chatview:${T}`;
  let h3 = "";
  let transcript = "";
  const lines: string[] = [];

  beforeAll(() => {
    h3 = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "rig-chatview-"));
    cpSync(join(FIX, "roots/claude-1"), join(h3, "claude-agent-1"), { recursive: true });
    mkdirSync(join(h3, ".config/agent-usage"), { recursive: true });
    writeFileSync(join(h3, ".config/agent-usage/config.toml"), `[[claude.profiles]]\nid = "agent-1"\nconfig_dir = "~/claude-agent-1"\n`);
    transcript = join(h3, "claude-agent-1/projects/-work-project-alpha", `${S1}.jsonl`);
    // Without the fixture's half-written last line, so a line can be appended.
    lines.push(...readFileSync(transcript, "utf8").split("\n").filter((l) => l.endsWith("}")));
    writeFileSync(transcript, lines.join("\n") + "\n");
  });
  afterAll(() => {
    if (h3) rmSync(h3, { recursive: true, force: true });
  });

  /** A fake host and a fake panorama feed v2 root that proves S1 at terminal t1. */
  const host = {
    spaces: [{ id: "space-1", name: "Project Alpha", focused: true }],
    agents: [{ id: "agent-1", name: "Agent 1", harness: "claude", program: "claude", state: "idle", space_id: "space-1", terminal_id: T }],
    terminals: [],
    panes: [],
    focused: { space_id: "space-1", pane_id: null, agent_id: null },
    theme: { name: "Theme 1", mode: "dark" },
    layout_name: "herdr-remote",
    shared: { "panorama.feed.owner": "owner-1" },
  };
  const feed = () => ({
    view: {
      feed: { v: 2, generated_at: Date.now() / 1000, roots: [{ pane_id: "core:t1", host: "herdr-core", terminal: T, harness: "claude", session_id: S1, cwd: "/work/project-alpha", transcript, agents: [] }] },
      stale: false,
      aged: false,
      error: null,
    },
    contract: {},
  });

  function world(sha = SCRIPT_SHA) {
    const hub = new Hub({ bridgeVersion: "rig", mayRead: () => true });
    hub.publish("host", host);
    const history = new claude.ClaudeHistory({ appHome: join(h3, ".config/herdr-app"), home: h3, pool: { script: SCRIPT, scriptSha256: sha, home: h3 } });
    const drv = new chatview.ChatviewTopicDriver({ hub, history, feed: feed as never, intervalMs: 1e9, map: { dayOf: (iso: string) => iso.slice(0, 10) } });
    drv.start();
    const got: { type: string; ops?: unknown[] }[] = [];
    const conn = hub.connect({ send: (m: { type: string }) => void got.push(m), close: () => undefined });
    return { hub, history, drv, got, conn };
  }

  it("binds through the feed, reads with the real SDK, and publishes the fixture's items", async () => {
    const { hub, history, drv, got, conn } = world();
    try {
      await hub.handleRaw(conn, JSON.stringify({ type: "hello", api: 1 }));
      await hub.handleRaw(conn, JSON.stringify({ type: "sub", topics: [TOPIC] }));
      await drv.settled(TOPIC);
      const v = hub.get(TOPIC) as { state: string; items: unknown[]; rev: string };
      expect(bridgeApi.ChatviewTopic.safeParse(v).success).toBe(true);
      expect(v.state).toBe("ok");
      const fixture = JSON.parse(readFileSync(join(REPO, "fixtures/bridge-api/chatview/typical.json"), "utf8"));
      expect(v.items).toEqual(fixture.items);
      const text = JSON.stringify(got);
      for (const never of [transcript, h3, S1, "claude-agent-1", "Fake thinking", "Fake test output"]) expect(text).not.toContain(never);

      // A new line: the stat sees it, and it goes out as a patch.
      const line = JSON.parse(lines.at(-1)!);
      const next = { ...line, parentUuid: line.uuid, uuid: "a1000000-0000-4000-8000-000000000030", timestamp: "2026-01-02T10:02:00.000Z", type: "user", message: { role: "user", content: "Thanks, Agent 1." } };
      delete next.requestId;
      writeFileSync(transcript, [...lines, JSON.stringify(next)].join("\n") + "\n");
      await drv.poll(TOPIC);
      const patches = got.filter((m) => m.type === "patch");
      expect(patches).toHaveLength(1);
      expect((hub.get(TOPIC) as { items: { text?: string }[] }).items.at(-1)).toMatchObject({ role: "you", text: "Thanks, Agent 1." });

      // A rewound chain (the later messages gone): a fresh snap with a new rev.
      writeFileSync(transcript, lines.slice(0, 4).join("\n") + "\n");
      await drv.poll(TOPIC);
      expect(got.filter((m) => m.type === "snap")).toHaveLength(2);
      expect((hub.get(TOPIC) as { rev: string }).rev).not.toBe(v.rev);
    } finally {
      drv.stop();
      history.close();
      writeFileSync(transcript, lines.join("\n") + "\n");
    }
  });

  it("a reader file that is not the one built with the bridge never runs: reader_failed", async () => {
    const { hub, history, drv, conn } = world("0".repeat(64));
    try {
      await hub.handleRaw(conn, JSON.stringify({ type: "hello", api: 1 }));
      await hub.handleRaw(conn, JSON.stringify({ type: "sub", topics: [TOPIC] }));
      await drv.settled(TOPIC);
      expect(hub.get(TOPIC)).toMatchObject({ state: "unavailable", reason: "reader_failed" });
      expect(history.pool.running).toBe(0);
    } finally {
      drv.stop();
      history.close();
    }
  });

  it("the built bridge.mjs carries the reader's hash, so it runs no other reader", () => {
    const bundle = readFileSync(join(REPO, "packages/bridge/dist/bridge.mjs"), "utf8");
    expect(bundle).toContain(JSON.stringify(SCRIPT_SHA));
    expect(bundle).not.toContain("__HERDR_READER_SHA256__");
  });
});
