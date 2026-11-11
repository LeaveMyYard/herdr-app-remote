import { describe, expect, it } from "vitest";
import { diff, type Json } from "../src/patch.js";
import { join, newHub } from "./helpers.js";

/** Builds roughly `bytes` of JSON of host-like shape. */
function big(bytes: number, tweak: number): Json {
  const items: Json[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const it = { id: `item-${i}`, name: `Agent ${i}`, state: i === 7 ? `s${tweak}` : "idle", tags: ["a", "b"], n: i, text: "x".repeat(60) };
    items.push(it);
    size += JSON.stringify(it).length + 1;
  }
  return { items };
}

describe("performance", () => {
  it("a 1 MiB topic patches in under 10 ms (median of 15 runs)", async () => {
    const hub = newHub();
    hub.publish("host", big(1024 * 1024, 0));
    const { send } = await join(hub);
    await send({ type: "sub", topics: ["host"] });
    const times: number[] = [];
    for (let i = 1; i <= 15; i++) {
      const next = big(1024 * 1024, i);
      const t0 = performance.now();
      hub.publish("host", next);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[7]!;
    expect(median).toBeLessThan(10);
    expect(diff(big(1024 * 1024, 0), big(1024 * 1024, 1))).toHaveLength(1);
  });
});
