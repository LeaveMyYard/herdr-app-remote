import net from "node:net";
import { describe, expect, it } from "vitest";
import { HostTopic } from "../src/host.js";
import { LinkHostSource, LinkServer } from "../src/index.js";
import { fixture, join, newHub } from "./helpers.js";

const TOKEN = "token-0123456789abcdef0123456789abcdef";
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function mod(port: number, copy = "link") {
  const s = net.connect(port, "127.0.0.1");
  await new Promise((r) => s.once("connect", r));
  const send = (o: unknown) => s.write(JSON.stringify(o) + "\n");
  send({ type: "hello", v: 1, token: TOKEN, copy, layout: "herdr-remote", app: { version: "0.0.1" } });
  return { s, send };
}

describe("LinkHostSource feeding the host topic", () => {
  it("publishes link state, ignores panel state, and goes stale when the link drops", async () => {
    const hub = newHub();
    const server = new LinkServer({ token: TOKEN });
    const topic = new HostTopic({ hub, source: new LinkHostSource(server), layoutGraceMs: 60_000 });
    await topic.start();
    try {
      const c = await join(hub);
      await c.send({ type: "sub", topics: ["host"] });
      expect(hub.isStale("host")).toBe("reconnecting");

      const panel = await mod(server.port, "panel");
      panel.send({ type: "state", seq: 1, host: fixture("idle-and-done") });
      const link = await mod(server.port);
      await tick();
      link.send({ type: "state", seq: 1, host: fixture("typical") });
      await tick();
      expect(hub.get("host")).toEqual(fixture("typical"));
      expect(hub.isStale("host")).toBeFalsy();

      panel.s.destroy();
      await tick();
      expect(hub.isStale("host")).toBeFalsy();

      link.s.destroy();
      await tick();
      expect(hub.isStale("host")).toBe("reconnecting");
      expect(hub.get("host")).toEqual(fixture("typical"));
    } finally {
      await topic.stop();
    }
  });
});
