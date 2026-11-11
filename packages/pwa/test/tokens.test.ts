import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCK, GLYPHS, ICON, STATES, SURFACE, T } from "../src/tokens.generated";

const pwa = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const common = resolve(pwa, "../../design/work");

function py(code: string): unknown {
  return JSON.parse(execFileSync("python3", ["-I", "-c", `import sys;sys.path.insert(0,sys.argv[1]);${code}`, common], { encoding: "utf8" }));
}

describe("tokens equal design/work/common.py", () => {
  it("T, DOCK, SURFACE, GLYPHS and ICON match", () => {
    const fresh = py("import json,common;print(json.dumps(dict(T=common.T,DOCK=common.DOCK,SURFACE=common.SURFACE,GLYPHS=common.GLYPHS,ICON=common.ICON)))") as Record<string, unknown>;
    expect(T).toEqual(fresh["T"]);
    expect(DOCK).toEqual(fresh["DOCK"]);
    expect(SURFACE).toEqual(fresh["SURFACE"]);
    expect(GLYPHS).toEqual(fresh["GLYPHS"]);
    expect(ICON).toEqual(fresh["ICON"]);
  });

  it("every state matches STATES and the derived card colours", () => {
    const fresh = py(
      "import json,common;print(json.dumps({c:dict(label=v[0],text=v[1],hue=v[2],fill=v[3],ink=v[4],glyph=v[5],mute=v[6] or v[2],cf=common.mix(v[2],0x0e/255),cb=common.mix(v[2],0x38/255)) for c,v in common.STATES.items()}))",
    ) as Record<string, Record<string, unknown>>;
    expect(Object.keys(STATES)).toEqual(Object.keys(fresh));
    for (const [code, want] of Object.entries(fresh)) {
      expect(STATES[code as keyof typeof STATES], code).toMatchObject(want);
    }
  });

  it("generated files are up to date (gen-tokens.py --check)", () => {
    expect(() => execFileSync("python3", ["-I", resolve(pwa, "scripts/gen-tokens.py"), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
