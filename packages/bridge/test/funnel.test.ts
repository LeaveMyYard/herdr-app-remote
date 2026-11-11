import { describe, expect, it } from "vitest";
import { checkFunnel, funnelFromStatus, targetPort } from "../src/index.js";

const HOST = "desk-1.example-tailnet.ts.net";
const API = 47391;

describe("targetPort", () => {
  it("reads the port from every target shape serve prints", () => {
    expect(targetPort("http://127.0.0.1:47391")).toBe(47391);
    expect(targetPort("http://localhost:3000/")).toBe(3000);
    expect(targetPort("127.0.0.1:3000")).toBe(3000);
    expect(targetPort("3000")).toBe(3000);
    expect(targetPort("tcp://[::1]:22")).toBe(22);
    expect(targetPort("text:hello")).toBeUndefined();
    expect(targetPort("/var/www")).toBeUndefined();
  });
});

describe("funnelFromStatus", () => {
  const web = (hp: string, proxy: string) => ({ [hp]: { Handlers: { "/": { Proxy: proxy } } } });

  it("is off for an empty config and for Funnel on someone else's port", () => {
    expect(funnelFromStatus({}, API)).toEqual({ state: "off" });
    expect(funnelFromStatus({ Web: web(`${HOST}:443`, "http://127.0.0.1:3000"), AllowFunnel: { [`${HOST}:443`]: true } }, API)).toEqual({ state: "off" });
  });

  it("is off when the serve port is served without Funnel", () => {
    const doc = { TCP: { "8443": { HTTPS: true } }, Web: web(`${HOST}:8443`, `http://127.0.0.1:${API}`), AllowFunnel: { [`${HOST}:8443`]: false } };
    expect(funnelFromStatus(doc, API)).toEqual({ state: "off" });
  });

  it("is on for the serve port, whatever it forwards to", () => {
    expect(funnelFromStatus({ AllowFunnel: { [`${HOST}:8443`]: true } }, API)).toEqual({ state: "on", where: `${HOST}:8443` });
  });

  it("is on for any port whose web or TCP handler reaches the API port", () => {
    expect(funnelFromStatus({ Web: web(`${HOST}:443`, `${API}`), AllowFunnel: { [`${HOST}:443`]: true } }, API).state).toBe("on");
    expect(funnelFromStatus({ TCP: { "10000": { TCPForward: `127.0.0.1:${API}` } }, AllowFunnel: { [`${HOST}:10000`]: true } }, API).state).toBe("on");
  });

  it("looks inside foreground sessions too", () => {
    const doc = { Foreground: { s1: { AllowFunnel: { [`${HOST}:8443`]: true } } } };
    expect(funnelFromStatus(doc, API).state).toBe("on");
  });

  it("can't tell from something that isn't an object", () => {
    expect(funnelFromStatus([], API).state).toBe("unknown");
    expect(funnelFromStatus("x", API).state).toBe("unknown");
  });
});

describe("checkFunnel", () => {
  const run = (r: { code: number | null; stdout: string; error?: "ENOENT" | "timeout" | "other" }) => async () => ({ stderr: "", ...r });

  it("treats empty output as nothing served", async () => {
    expect(await checkFunnel({ run: run({ code: 0, stdout: "" }), tailscale: "ts", apiPort: API })).toEqual({ state: "off" });
  });

  it("is off when tailscale is not installed: nothing can be funneled", async () => {
    expect(await checkFunnel({ run: run({ code: null, stdout: "", error: "ENOENT" }), tailscale: "ts", apiPort: API })).toEqual({ state: "off" });
  });

  it("can't tell when tailscale fails, times out or prints garbage", async () => {
    expect((await checkFunnel({ run: run({ code: null, stdout: "", error: "timeout" }), tailscale: "ts", apiPort: API })).state).toBe("unknown");
    expect((await checkFunnel({ run: run({ code: 1, stdout: "" }), tailscale: "ts", apiPort: API })).state).toBe("unknown");
    expect((await checkFunnel({ run: run({ code: 0, stdout: "{nope" }), tailscale: "ts", apiPort: API })).state).toBe("unknown");
  });
});
