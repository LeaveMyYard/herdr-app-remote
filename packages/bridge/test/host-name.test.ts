import { describe, expect, it } from "vitest";
import { hostName } from "../src/security/host-name.js";

const os = () => "Desk-9.local";

describe("hostName (the phone's name for the computer)", () => {
  it("is the first label of the serve name, port dropped", () => {
    expect(hostName({ host: "desk-1.example-tailnet.ts.net:8443", login: "user-1@example" }, os)).toBe("desk-1");
    expect(hostName({ host: "desk-1.example-tailnet.ts.net", login: "user-1@example" }, os)).toBe("desk-1");
  });

  it("drops the port of a single-label serve name", () => {
    expect(hostName({ host: "desk-1:8443", login: "user-1@example" }, os)).toBe("desk-1");
  });

  it("falls back to the bridge's hostname without a serve identity", () => {
    expect(hostName(null, os)).toBe("Desk-9");
  });

  it("falls back when the serve host is empty, and never returns empty", () => {
    expect(hostName({ host: "", login: "user-1@example" }, os)).toBe("Desk-9");
    expect(hostName(null, () => "")).toBe("this computer");
  });
});
