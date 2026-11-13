// ReaderPool against a fake reader child (test/fake-reader.mjs): one child per projects root, clean env,
// the permission model, per-call timeout, RSS limit, idle exit and the cap of 4. Fake data only.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claude } from "../../src/index.js";

const { ReaderPool, permissionFlag, procRss } = claude;
type ReaderEvent = claude.ReaderEvent;
type ClaudeRoot = claude.ClaudeRoot;

const FAKE = fileURLToPath(new URL("../fake-reader.mjs", import.meta.url));
const sid = (kind: string, n = 0) => `0000000${n}-0000-4000-8000-0000000000${kind}`;

const dirs: string[] = [];
const pools: claude.ReaderPool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const d = mkdtempSync(join(process.env.HERDR_REMOTE_TEST_TMP ?? tmpdir(), "cr-"));
  dirs.push(d);
  return d;
}

/** A root under a private home: `<home>/.claude-<n>` with a `projects` dir. */
function root(h: string, n: number): ClaudeRoot {
  const configDir = join(h, `.claude-${n}`);
  mkdirSync(join(configDir, "projects"), { recursive: true });
  return { configDir, projects: join(configDir, "projects"), profileIds: [`agent-${n}`] };
}

function pool(h: string, o: Partial<claude.ReaderPoolOptions> = {}): { pool: claude.ReaderPool; events: ReaderEvent[] } {
  const events: ReaderEvent[] = [];
  const p = new ReaderPool({ script: FAKE, home: h, onEvent: (e) => events.push(e), ...o });
  pools.push(p);
  return { pool: p, events };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const exitOf = (events: ReaderEvent[], pid: number) => events.find((e) => e.kind === "exit" && e.pid === pid);

describe("ReaderPool", () => {
  it("starts a child on first use with a clean env: only CLAUDE_CONFIG_DIR and HOME", async () => {
    const h = home();
    const r = root(h, 1);
    process.env.HERDR_TEST_SECRET = "sk-ant-fake-token";
    try {
      const { pool: p } = pool(h);
      expect(p.running).toBe(0);
      const got = await p.call(r, { op: "messages", session: sid("01") });
      expect(got.ok).toBe(true);
      const v = (got as { value: { env: Record<string, string>; cwd: string; argv: string[] } }).value;
      expect(v.env).toEqual({ CLAUDE_CONFIG_DIR: r.configDir, HOME: h });
      expect(v.cwd).toBe("/");
      expect(v.argv).toEqual([FAKE, "--idle-ms", "60000"]);
      expect(p.running).toBe(1);
    } finally {
      delete process.env.HERDR_TEST_SECRET;
    }
  });

  it("runs the child under the permission model: no writes, no child processes", async () => {
    const h = home();
    const { pool: p } = pool(h);
    const got = await p.call(root(h, 1), { op: "info", session: sid("07") });
    expect(got).toEqual({ ok: true, value: { write: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED" } });
    expect(existsSync(join(h, "written-by-reader"))).toBe(false);
  });

  it("picks the permission flag the running node knows", () => {
    expect(permissionFlag("22.12.0")).toBe("--experimental-permission");
    expect(permissionFlag("22.13.0")).toBe("--permission");
    expect(permissionFlag("23.4.0")).toBe("--experimental-permission");
    expect(permissionFlag("23.5.0")).toBe("--permission");
    expect(permissionFlag("24.0.0")).toBe("--permission");
  });

  it("uses one child per projects root and reuses it", async () => {
    const h = home();
    const a = root(h, 1);
    const b = root(h, 2);
    const { pool: p, events } = pool(h);
    const pid = async (r: ClaudeRoot) => ((await p.call(r, { op: "info", session: sid("01") })) as { value: { pid: number; env: Record<string, string> } }).value;
    const a1 = await pid(a);
    const a2 = await pid(a);
    const b1 = await pid(b);
    expect(a1.pid).toBe(a2.pid);
    expect(b1.pid).not.toBe(a1.pid);
    expect(b1.env.CLAUDE_CONFIG_DIR).toBe(b.configDir);
    expect(events.filter((e) => e.kind === "spawn")).toHaveLength(2);
  });

  it("runs one call at a time per child", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p } = pool(h);
    const order: string[] = [];
    const slow = p.call(r, { op: "info", session: sid("08") }).then(() => order.push("slow"));
    const fast = p.call(r, { op: "info", session: sid("09") }).then(() => order.push("fast"));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("kills the child when a call takes longer than the limit", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p, events } = pool(h, { callTimeoutMs: 300 });
    const queued = p.call(r, { op: "info", session: sid("09") });
    const hung = p.call(r, { op: "info", session: sid("02") });
    expect(await queued).toMatchObject({ ok: true });
    const pid = p.pidFor(r)!;
    const t0 = Date.now();
    expect(await hung).toEqual({ ok: false, error: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events).toContainEqual({ kind: "kill", pid, projects: r.projects, why: "timeout" });
    await until(() => !!exitOf(events, pid));
    expect(alive(pid)).toBe(false);
    expect(p.running).toBe(0);
    // the next call starts a fresh child
    expect(await p.call(r, { op: "info", session: sid("09") })).toMatchObject({ ok: true });
    expect(p.pidFor(r)).not.toBe(pid);
  });

  it("the default call limit is 5 s", () => {
    expect(claude.READER_CALL_TIMEOUT_MS).toBe(5000);
    expect(claude.READER_RSS_LIMIT).toBe(512 * 1024 * 1024);
    expect(claude.READER_IDLE_MS).toBe(60_000);
    expect(claude.READER_MAX).toBe(4);
  });

  it("kills the child when its RSS goes over the limit", async () => {
    const h = home();
    const r = root(h, 1);
    let rss = 100;
    const { pool: p, events } = pool(h, { rssOf: () => rss, rssLimitBytes: 1000, rssPollMs: 20 });
    const hung = p.call(r, { op: "info", session: sid("02") });
    await until(() => p.pidFor(r) !== undefined);
    const pid = p.pidFor(r)!;
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(true);
    rss = 1001;
    expect(await hung).toEqual({ ok: false, error: "rss" });
    expect(events).toContainEqual({ kind: "kill", pid, projects: r.projects, why: "rss" });
    await until(() => !alive(pid));
  });

  it("reads a real child's RSS from /proc and kills it over the limit", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p } = pool(h, { rssLimitBytes: 200 * 1024 * 1024, rssPollMs: 50, callTimeoutMs: 10_000 });
    const got = p.call(r, { op: "info", session: sid("03") });
    await until(() => p.pidFor(r) !== undefined);
    const pid = p.pidFor(r)!;
    expect(procRss(pid)).toBeGreaterThan(0);
    expect(await got).toEqual({ ok: false, error: "rss" });
    await until(() => !alive(pid));
  });

  it("stops a child after the idle time", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p, events } = pool(h, { idleMs: 200 });
    await p.call(r, { op: "info", session: sid("09") });
    const pid = p.pidFor(r)!;
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(pid)).toBe(true);
    await until(() => !!exitOf(events, pid));
    expect(events).toContainEqual({ kind: "idle", pid, projects: r.projects });
    expect(alive(pid)).toBe(false);
    expect(p.running).toBe(0);
  });

  it("a call before the idle time keeps the child", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p } = pool(h, { idleMs: 300 });
    await p.call(r, { op: "info", session: sid("09") });
    const pid = p.pidFor(r)!;
    for (let i = 0; i < 4; i++) {
      await new Promise((res) => setTimeout(res, 150));
      await p.call(r, { op: "info", session: sid("09") });
    }
    expect(p.pidFor(r)).toBe(pid);
  });

  it("runs at most 4 children: a fifth root is busy while all 4 are working", async () => {
    const h = home();
    const roots = [1, 2, 3, 4, 5].map((n) => root(h, n));
    const { pool: p, events } = pool(h, { callTimeoutMs: 2000 });
    let peak = 0;
    const hung = roots.slice(0, 4).map((r, i) => p.call(r, { op: "info", session: sid("02", i) }));
    peak = Math.max(peak, p.running);
    expect(await p.call(roots[4]!, { op: "info", session: sid("09") })).toEqual({ ok: false, error: "busy" });
    expect(p.running).toBe(4);
    expect(events.filter((e) => e.kind === "spawn")).toHaveLength(4);
    p.close();
    for (const c of hung) expect(await c).toMatchObject({ ok: false });
    expect(peak).toBe(4);
  });

  it("makes room by stopping the least recently used idle child, never running five", async () => {
    const h = home();
    const roots = [1, 2, 3, 4, 5].map((n) => root(h, n));
    let peak = 0;
    const events: ReaderEvent[] = [];
    const p = new ReaderPool({
      script: FAKE,
      home: h,
      onEvent: (e) => {
        events.push(e);
        if (e.kind === "spawn") peak = Math.max(peak, p.running);
      },
    });
    pools.push(p);
    for (const r of roots.slice(0, 4)) await p.call(r, { op: "info", session: sid("09") });
    await p.call(roots[1]!, { op: "info", session: sid("09") }); // roots[0] is now the least recently used
    const first = p.pidFor(roots[0]!)!;
    expect(await p.call(roots[4]!, { op: "info", session: sid("09") })).toMatchObject({ ok: true });
    expect(events).toContainEqual({ kind: "kill", pid: first, projects: roots[0]!.projects, why: "evict" });
    expect(exitOf(events, first)).toBeDefined();
    expect(p.pidFor(roots[0]!)).toBeUndefined();
    expect(p.running).toBe(4);
    expect(peak).toBe(4);
  });

  it("refuses a bad request without starting a child", async () => {
    const h = home();
    const { pool: p } = pool(h);
    expect(await p.call(root(h, 1), { op: "info", session: "../../etc/passwd" })).toEqual({ ok: false, error: "bad_request" });
    expect(await p.call(root(h, 1), { op: "info", session: sid("09"), dir: "relative/dir" })).toEqual({ ok: false, error: "bad_request" });
    expect(p.running).toBe(0);
  });

  it("reports a child that exits mid-call as crashed and starts a new one next time", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p } = pool(h);
    expect(await p.call(r, { op: "info", session: sid("04") })).toEqual({ ok: false, error: "crashed" });
    expect(await p.call(r, { op: "info", session: sid("09") })).toMatchObject({ ok: true });
  });

  it("kills a child whose reply is over the size limit", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p, events } = pool(h, { maxReplyBytes: 1024 * 1024 });
    expect(await p.call(r, { op: "info", session: sid("05") })).toEqual({ ok: false, error: "too_large" });
    expect(events.some((e) => e.kind === "kill" && e.why === "too_large")).toBe(true);
  });

  it("kills a child that answers a request it was not asked", async () => {
    const h = home();
    const r = root(h, 1);
    const { pool: p, events } = pool(h);
    expect(await p.call(r, { op: "info", session: sid("06") })).toEqual({ ok: false, error: "crashed" });
    expect(events.some((e) => e.kind === "kill" && e.why === "protocol")).toBe(true);
  });

  it("close kills every child", async () => {
    const h = home();
    const { pool: p, events } = pool(h);
    const hung = p.call(root(h, 1), { op: "info", session: sid("02") });
    await p.call(root(h, 2), { op: "info", session: sid("09") });
    const pids = events.filter((e) => e.kind === "spawn").map((e) => e.pid);
    p.close();
    expect(await hung).toEqual({ ok: false, error: "crashed" });
    await until(() => pids.every((pid) => !alive(pid)));
    expect(await p.call(root(h, 1), { op: "info", session: sid("09") })).toEqual({ ok: false, error: "crashed" });
  });
});
