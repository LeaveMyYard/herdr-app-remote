import { describe, expect, it } from "vitest";
import { hostNameOfMeta } from "../src/bridge/host-name";

describe("hostNameOfMeta", () => {
  it("reads host_name, and anything else as absent", () => {
    expect(hostNameOfMeta({ api: 1, bridge: "0", host_name: " desk-1 " })).toBe("desk-1");
    expect(hostNameOfMeta({ api: 1, bridge: "0" })).toBeNull();
    expect(hostNameOfMeta({ host_name: "" })).toBeNull();
    expect(hostNameOfMeta({ host_name: 5 })).toBeNull();
    expect(hostNameOfMeta(null)).toBeNull();
  });
});
