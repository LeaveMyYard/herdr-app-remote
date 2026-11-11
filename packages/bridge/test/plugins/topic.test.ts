import { afterEach, describe, expect, it } from "vitest";
import { bridgeApi } from "@herdr-remote/protocol";
import { PluginsTopicDriver } from "../../src/plugins/topic.js";
import { run } from "../../src/plugins/exec.js";
import { join as joinc, newHub } from "../helpers.js";
import { bins, fakeCli, NOW, panoramaHome, tmp } from "./helpers.js";

let driver: PluginsTopicDriver | undefined;
afterEach(() => driver?.stop());

function setup() {
  const d = tmp();
  const hub = newHub();
  driver = new PluginsTopicDriver({
    hub,
    appHome: panoramaHome(),
    run,
    now: () => NOW,
    binaries: bins(d, {
      hc: fakeCli(d, "hc", "echo hc 0.2.0"),
      inbox: fakeCli(d, "herdr-inbox", 'echo "herdr-inbox app v1"'),
      usagebar: fakeCli(d, "usagebar", `echo '{"version":1}'`),
    }),
    intervalMs: 3_600_000,
    hostIntervalMs: 3_600_000,
  });
  return { hub, driver };
}

describe("plugins topic", () => {
  it("publishes a schema-valid snapshot after start, with host derived from the host topic", async () => {
    const { hub, driver } = setup();
    await driver.start();
    const v = bridgeApi.PluginsTopic.parse(hub.get("plugins"));
    expect(v).toMatchObject({ panorama: { state: "ready" }, inbox: { state: "ready" }, usage: { state: "ready" }, hc: { state: "ready" }, host: { state: "not_running" } });
  });
  it("sends a snap to a subscriber, then a patch only for what changed", async () => {
    const { hub, driver } = setup();
    await driver.start();
    const c = await joinc(hub);
    await c.send({ type: "sub", topics: ["plugins"] });
    expect(c.client.ofType("snap")).toHaveLength(1);
    hub.publish("host", { n: 1 });
    driver.publish();
    const patches = c.client.ofType("patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.ops.every((o) => o.path.startsWith("/host"))).toBe(true);
    driver.publish();
    expect(c.client.ofType("patch")).toHaveLength(1);
  });
  it("refresh picks up a plugin that changed", async () => {
    const d = tmp();
    const hub = newHub();
    const inbox = fakeCli(d, "herdr-inbox", 'echo "herdr-inbox app v1"');
    driver = new PluginsTopicDriver({ hub, appHome: panoramaHome(), run, now: () => NOW, binaries: bins(d, { inbox }), intervalMs: 3_600_000, hostIntervalMs: 3_600_000 });
    await driver.start();
    expect((hub.get("plugins") as { inbox: { state: string } }).inbox.state).toBe("ready");
    fakeCli(d, "herdr-inbox", 'echo "herdr-inbox 0.1.0"');
    await driver.refresh();
    expect((hub.get("plugins") as { inbox: { state: string } }).inbox.state).toBe("too_old");
  });
  it("a throwing probe becomes broken, not a crash", async () => {
    const hub = newHub();
    driver = new PluginsTopicDriver({
      hub,
      appHome: panoramaHome(),
      run: () => Promise.reject(new Error("boom")),
      binaries: bins(tmp()),
      intervalMs: 3_600_000,
      hostIntervalMs: 3_600_000,
    });
    await driver.start();
    expect((hub.get("plugins") as { hc: { state: string } }).hc.state).toBe("broken");
  });
  it("publish after stop does nothing", async () => {
    const { hub, driver } = setup();
    await driver.start();
    driver.stop();
    const before = hub.seqOf("plugins");
    hub.publish("host", { n: 2 });
    driver.publish();
    expect(hub.seqOf("plugins")).toBe(before);
  });
});
