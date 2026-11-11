import { describe, expect, it } from "vitest";
import { applyPatch, diff, PatchError, type Json } from "../src/patch.js";

function roundtrip(a: Json, b: Json): void {
  expect(applyPatch(a, diff(a, b))).toEqual(b);
}

describe("diff/applyPatch", () => {
  it("round-trips objects, arrays, scalars and escaped keys", () => {
    roundtrip({ a: 1 }, { a: 2 });
    roundtrip({ a: 1 }, { b: 1 });
    roundtrip({ "a/b": { "~x": 1 } }, { "a/b": { "~x": 2 } });
    roundtrip([1, 2, 3], [1, 9]);
    roundtrip([1], [1, 2, 3]);
    roundtrip({ l: [{ id: 1 }, { id: 2 }] }, { l: [{ id: 2 }] });
    roundtrip({ a: null }, { a: { b: [] } });
    roundtrip({ a: [1] }, { a: { b: 1 } });
    roundtrip(1, "x");
  });

  it("emits no ops for equal values and minimal ops for one change", () => {
    expect(diff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
    expect(diff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })).toEqual([{ op: "replace", path: "/a/c", value: 3 }]);
  });

  it("applies move/copy/test and rejects bad patches", () => {
    expect(applyPatch({ a: 1, b: {} }, [{ op: "move", from: "/a", path: "/b/c" }])).toEqual({ b: { c: 1 } });
    expect(applyPatch({ a: [1] }, [{ op: "copy", from: "/a/0", path: "/a/-" }])).toEqual({ a: [1, 1] });
    expect(() => applyPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }])).toThrow(PatchError);
    expect(() => applyPatch({ a: 1 }, [{ op: "remove", path: "/zzz" }])).toThrow(PatchError);
    expect(() => applyPatch({ a: [1] }, [{ op: "add", path: "/a/5", value: 1 }])).toThrow(PatchError);
  });
});
