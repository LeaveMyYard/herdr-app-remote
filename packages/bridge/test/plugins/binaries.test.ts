import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp, type App } from "../../src/app/index.js";
import { resolveBinary, resolvedBinaries } from "../../src/plugins/binaries.js";
import { detectHc } from "../../src/plugins/detect.js";
import { run, type Runner } from "../../src/plugins/exec.js";
import { LinkServer } from "../../src/link/server.js";
import { fakeCli, tmp, put } from "./helpers.js";

/** A home with `~/.local/bin/<name>` and a PATH dir, both empty unless filled. */
function layout() {
  const home = tmp("bin-home-");
  const local = join(home, ".local/bin");
  const onPath = join(tmp("bin-path-"), "bin");
  mkdirSync(local, { recursive: true });
  mkdirSync(onPath, { recursive: true });
  return { home, local, onPath };
}

describe("resolveBinary", () => {
  it("takes the first executable on PATH", () => {
    const { home, local, onPath } = layout();
    const a = fakeCli(onPath, "hc", "echo a");
    fakeCli(local, "hc", "echo b");
    expect(resolveBinary("hc", { path: `/nonexistent:${onPath}`, home })).toBe(a);
  });

  it("falls back to ~/.local/bin when PATH lacks it (herdr-app started from a desktop launcher)", () => {
    const { home, local } = layout();
    const b = fakeCli(local, "hc", "echo b");
    expect(resolveBinary("hc", { path: "/usr/bin:/bin", home })).toBe(b);
    expect(resolveBinary("hc", { path: "", home })).toBe(b);
  });

  it("follows a symlink in ~/.local/bin", () => {
    const { home, local, onPath } = layout();
    const real = fakeCli(onPath, "hc-real", "echo r");
    symlinkSync(real, join(local, "hc"));
    expect(resolveBinary("hc", { path: "/usr/bin", home })).toBe(join(local, "hc"));
  });

  it("ignores relative PATH entries, non-executables and directories", () => {
    const { home, local, onPath } = layout();
    put(onPath, "hc", "not executable");
    mkdirSync(join(local, "hc"));
    expect(resolveBinary("hc", { path: `.:bin:${onPath}`, home })).toBeNull();
  });

  it("is null when found nowhere, and takes a path with a slash as given", () => {
    const { home, onPath } = layout();
    expect(resolveBinary("hc", { path: "/usr/bin", home: join(home, "nope") })).toBeNull();
    const x = fakeCli(onPath, "x", "true");
    expect(resolveBinary(x, { path: "", home })).toBe(x);
    expect(resolveBinary("rel/x", { path: "", home })).toBeNull();
  });
});

describe("resolvedBinaries", () => {
  afterEach(() => vi.useRealTimers());

  it("gives the absolute path, and notices an install without a restart", () => {
    const { home, local } = layout();
    const b = resolvedBinaries({ path: "/usr/bin", home });
    expect(b.hc).toBe("hc");
    const hc = fakeCli(local, "hc", "echo hc 0.1.20");
    expect(b.hc).toBe(hc);
  });

  it("keeps a found path for its TTL, then looks again", () => {
    const { home, local, onPath } = layout();
    let now = 0;
    const b = resolvedBinaries({ path: onPath, home, ttlMs: 1000, now: () => now });
    const first = fakeCli(local, "hc", "echo 1");
    expect(b.hc).toBe(first);
    const second = fakeCli(onPath, "hc", "echo 2");
    now = 999;
    expect(b.hc).toBe(first);
    now = 1000;
    expect(b.hc).toBe(second);
  });

  it("detection and chat use the same hc, found off PATH", async () => {
    const { home, local } = layout();
    fakeCli(local, "hc", 'echo "hc 0.1.20"');
    const binaries = resolvedBinaries({ path: "/usr/bin:/bin", home });
    expect(await detectHc({ appHome: "/none", run, binaries })).toEqual({ state: "ready" });
    rmSync(join(local, "hc"));
    // Gone: detection says so, with where it looked; the cached absolute path fails the same way (ENOENT).
    expect(await detectHc({ appHome: "/none", run, binaries })).toEqual({ state: "missing", detail: "hc not found on PATH or in ~/.local/bin" });
  });
});

describe("startApp", () => {
  let app: App | undefined;
  let link: LinkServer | undefined;
  afterEach(async () => {
    await app?.stop();
    await link?.close();
    app = link = undefined;
  });

  it("runs chat's hc from ~/.local/bin when PATH lacks it", async () => {
    const { home, local } = layout();
    const hc = fakeCli(local, "hc", "true");
    const calls: string[] = [];
    const recording: Runner = async (cmd, args) => {
      calls.push(`${cmd} ${args[0]}`);
      return { code: 1, stdout: "", stderr: "" };
    };
    const oldPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      link = new LinkServer({ token: "t".repeat(32) });
      await link.listen();
      app = await startApp({ appHome: tmp("bin-app-"), link, port: 0, serve: { host: "desk-1.example-tailnet.ts.net", login: "user-1@example" }, home, run: recording, tailscale: "/nonexistent/tailscale" });
      const c = app.hub.connect({ send: () => {}, close: () => {} });
      await app.hub.handleRaw(c, JSON.stringify({ type: "hello", api: 1 }));
      await app.hub.handleRaw(c, JSON.stringify({ type: "sub", topics: ["chat:t1"] }));
      await vi.waitFor(() => expect(calls).toContain(`${hc} ls`));
      expect(calls).toContain(`${hc} --version`);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
