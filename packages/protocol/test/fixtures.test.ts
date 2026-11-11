import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { bridgeApi, HostState, install, modLink } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

/** Fixture directory (relative to fixtures/ or fixtures/invalid/) -> schema. */
const SCHEMAS: Record<string, z.ZodTypeAny> = {
  host: HostState,
  "mod-link/mod-to-bridge": modLink.ModToBridge,
  "mod-link/bridge-to-mod": modLink.BridgeToMod,
  "mod-link/runtime": modLink.Runtime,
  "bridge-api/client": bridgeApi.ClientMessage,
  "bridge-api/server": bridgeApi.ServerMessage,
  "bridge-api/meta": bridgeApi.Meta,
  "bridge-api/plugins": bridgeApi.PluginsTopic,
  "bridge-api/panorama": bridgeApi.PanoramaTopic,
  "bridge-api/usage": bridgeApi.UsageTopic,
  "bridge-api/inbox": bridgeApi.InboxTopic,
  "bridge-api/chat": bridgeApi.ChatTopic,
  "install/receipt": install.InstallReceipt,
};

/** Fake app-home files for the installer tests: not protocol messages, so no schema. */
const NOT_PROTOCOL = join(ROOT, "app-home");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function collect(base: string, skip?: string) {
  return walk(base)
    .filter((f) => f.endsWith(".json") && !(skip && f.startsWith(skip)) && !f.startsWith(NOT_PROTOCOL + "/"))
    .map((f) => {
      const dir = relative(base, dirname(f));
      const schema = SCHEMAS[dir];
      if (!schema) throw new Error(`fixture ${f} is in a directory with no schema mapping`);
      return { file: relative(ROOT, f), json: JSON.parse(readFileSync(f, "utf8")) as unknown, schema };
    });
}

const valid = collect(ROOT, join(ROOT, "invalid"));
const invalid = collect(join(ROOT, "invalid"));

describe("fixtures", () => {
  it("covers every schema directory with valid and invalid fixtures", () => {
    const dirs = Object.keys(SCHEMAS);
    for (const d of dirs) {
      expect(valid.some((f) => f.file.startsWith(d + "/")), `valid fixture for ${d}`).toBe(true);
      expect(invalid.some((f) => f.file.startsWith(`invalid/${d}/`)), `invalid fixture for ${d}`).toBe(true);
    }
  });

  describe.each(valid)("valid $file", ({ json, schema }) => {
    it("validates and round-trips without losing fields", () => {
      const r = schema.safeParse(json);
      expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
      if (r.success) expect(r.data).toEqual(json);
    });
  });

  it("every valid run fixture passes the allowlist", () => {
    const runs = valid.filter((f) => (f.json as { type?: string }).type === "run");
    expect(runs.length).toBeGreaterThan(0);
    for (const { json } of runs) {
      const r = json as { name: string; args: unknown };
      expect(modLink.checkRun(r.name, r.args)).toEqual({ ok: true, name: r.name, args: r.args });
    }
  });

  describe.each(invalid)("invalid $file", ({ json, schema }) => {
    it("is rejected", () => {
      expect(schema.safeParse(json).success).toBe(false);
    });
  });
});

describe("no real data in fixtures, protocol docs or design", () => {
  const REPO = join(ROOT, "..");
  const files = [
    ...walk(ROOT),
    ...walk(join(REPO, "docs/protocol")),
    ...walk(join(REPO, "design")).filter((f) => /\.(html|py|sh|js|json|svg)$/.test(f)),
  ];

  it("scans a non-trivial set of files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((f) => relative(REPO, f)))("%s has no machine-specific paths or addresses", (rel) => {
    const text = readFileSync(join(REPO, rel), "utf8");
    expect(text).not.toMatch(/\/home\/|\/Users\/|\/tmp\/claude|scratchpad|leavemyyard|\.claude/i);
    const emails = text.match(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]+/g) ?? [];
    for (const e of emails) expect(e, `address ${e}`).toMatch(/^user-\d+@example\.com$/);
  });
});
