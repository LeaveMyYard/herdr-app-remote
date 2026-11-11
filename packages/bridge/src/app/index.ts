// The bridge's API side, assembled: the hub and its topics (host, plugins, panorama, inbox, usage, chat:<t>), the security layer and the 127.0.0.1 API listener.
//
// The bridge process (`serve`, S12) owns the link server, runtime.json and the idle-out; it calls `startApp` with
// its listening link server and stops the app before it closes the link. Nothing here writes runtime.json or
// decides when the bridge exits.
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { DEFAULT_BINARIES, type Binaries } from "../plugins/detect.js";
import { run as defaultRun, type Runner } from "../plugins/exec.js";
import { ChatTopicDriver } from "../chat/topic.js";
import { HostTopic } from "../host.js";
import { InboxTopicDriver } from "../inbox/topic.js";
import { Hub } from "../hub.js";
import { LinkHostSource } from "../link/host-source.js";
import type { LinkServer } from "../link/server.js";
import { PanelDriver } from "../panel/driver.js";
import { PanoramaTopicDriver } from "../panorama/topic.js";
import { PluginsTopicDriver } from "../plugins/topic.js";
import { Security, type DeviceView, type ServeIdentity } from "../security/security.js";
import { createBridgeServer, type BridgeServer, type GuardVerdict } from "../server.js";
import { UsageTopicDriver } from "../usage.js";
import { navigateActor, routeActs, type Actor } from "./act.js";
import { checkFunnel, SERVE_PORT, type FunnelVerdict } from "./funnel.js";

export { routeActs, navigateActor, fromRun, type Actor } from "./act.js";
export { checkFunnel, funnelFromStatus, targetPort, SERVE_PORT, FUNNEL_TIMEOUT_MS, type FunnelVerdict } from "./funnel.js";

/** The API listener's port on 127.0.0.1: fixed, because `tailscale serve` (S14) is configured to forward to it. */
export const DEFAULT_API_PORT = 47391;
/** How often the Funnel state is re-read. */
export const FUNNEL_CHECK_MS = 30_000;
/** While no check has told yet, it is retried this often. */
export const FUNNEL_RETRY_MS = 5_000;
/** Close code for clients dropped because Funnel turned on (the 4001–4003 codes are the security layer's). */
export const CLOSE_FUNNEL = 4004;
export const BRIDGE_VERSION = "0.0.0";

export interface AppOptions {
  /** The herdr-app home (absolute): data, plugin receipts and feeds are read under it. */
  appHome: string;
  /** The listening link server of the bridge process. The app attaches to it and never closes it. */
  link: LinkServer;
  /** The built PWA (`packages/pwa/dist`); omitted means no static files. */
  staticDir?: string;
  /** Default {@link DEFAULT_API_PORT}; 0 picks a free port (tests). Always bound on 127.0.0.1. */
  port?: number;
  /** The serve name and owner login. Unset until setup (S14) is done: then only `/healthz` answers. */
  serve?: ServeIdentity | null;
  bridgeVersion?: string;
  /** Test seams: the command runner and binaries (fake CLIs). */
  run?: Runner;
  binaries?: Binaries;
  tailscale?: string;
  /** For the usage topic's `~` abbreviation. */
  home?: string;
  funnelCheckMs?: number;
  /** Extra `act` handlers (later slices: inbox, chat, terminal, push), tried before the built-in ones. */
  actors?: readonly Actor[];
  /** A device asked to pair: the desktop panel and a toast ask "Approve Phone 1?" (S13 wires it). */
  onPending?: (d: DeviceView) => void;
  /** Extra Status checks and panel operations (S14). */
  panel?: Pick<import("../panel/driver.js").PanelDriverOptions, "extraChecks" | "extraAct">;
  log?: (e: AppLogEvent) => void;
}

/** Structured log events. Never carries tokens, cookies, headers or topic contents. */
export type AppLogEvent =
  | { event: "api_listening"; port: number }
  | { event: "funnel"; verdict: FunnelVerdict }
  | { event: "invalid_topic"; topic: string; error: string };

export interface App {
  readonly hub: Hub;
  readonly security: Security;
  readonly server: BridgeServer;
  /** The bound API port on 127.0.0.1. */
  readonly port: number;
  /** The last Funnel verdict that decided serving; `on` refuses every request. */
  readonly funnel: FunnelVerdict | null;
  /** Re-reads the Funnel state now (also runs every `funnelCheckMs`). */
  checkFunnel(): Promise<FunnelVerdict>;
  setServe(serve: ServeIdentity | null): void;
  /** Stops the topics and the API listener. Leaves the link server running. */
  stop(): Promise<void>;
}

/**
 * Starts the API side of the bridge. Every request is refused until a Funnel check has said `off`; while
 * Funnel is on (for the serve port, or for any handler that reaches the API port) every request, `/healthz`
 * included, answers `503 funnel` and live sockets are dropped with {@link CLOSE_FUNNEL}.
 */
export async function startApp(o: AppOptions): Promise<App> {
  const run = o.run ?? defaultRun;
  const binaries = o.binaries ?? DEFAULT_BINARIES;
  const log = o.log ?? (() => {});
  const invalid = (topic: string) => (error: string) => log({ event: "invalid_topic", topic, error });

  let usage: UsageTopicDriver | undefined = undefined;
  let inboxDriver: InboxTopicDriver | undefined = undefined;
  const actors: Actor[] = [
    ...(o.actors ?? []),
    (_c, kind, args) => usage?.act(kind, args),
    // The inbox verbs (S11): bound to the row the phone was shown; `inbox.answer` capability, audited.
    (_c, kind, args) => inboxDriver?.act(kind, args),
    navigateActor(o.link),
  ];
  // The desktop panel (S13) hears of security changes and new pairing requests through these two.
  const panelRef: { current?: PanelDriver } = {};
  const security = new Security({
    dataDir: join(o.appHome, "data/herdr-app-remote"),
    serve: o.serve ?? null,
    inner: routeActs(actors),
    onChange: () => panelRef.current?.changed(),
    onPending: (d) => {
      o.link.notify("info", `Approve ${d.name}? Open the Remote panel.`, "link", "open_panel");
      o.onPending?.(d);
    },
  });
  // null: not checked yet. Serving needs an `off` verdict; anything else refuses requests and acts alike.
  let funnel: FunnelVerdict | null = null;
  const serving = () => funnel?.state === "off";
  // A socket closed for Funnel stays readable until its close completes: its acts are refused from the close on.
  const hub = new Hub({
    bridgeVersion: o.bridgeVersion ?? BRIDGE_VERSION,
    onAct: (client, kind, args) => (serving() ? security.act(client, kind, args) : { ok: false, code: "funnel" }),
  });

  const host = new HostTopic({ hub, source: new LinkHostSource(o.link, { owned: false }), onInvalid: invalid("host") });
  const plugins = new PluginsTopicDriver({ hub, appHome: o.appHome, run, binaries, onInvalid: invalid("plugins") });
  const panorama = new PanoramaTopicDriver({ hub, appHome: o.appHome, onInvalid: invalid("panorama") });
  const chat = new ChatTopicDriver({ hub, run, binaries });
  const inbox = (inboxDriver = new InboxTopicDriver({ hub, appHome: o.appHome, run, binaries }));
  usage = new UsageTopicDriver({ hub, run, binaries, appHome: o.appHome, ...(o.home !== undefined ? { home: o.home } : {}) });

  const panel = (panelRef.current = new PanelDriver({
    link: o.link,
    security,
    hub,
    funnel: () => funnel?.state ?? null,
    ...(o.panel ?? {}),
  }));

  const guard = (req: IncomingMessage, kind: "http" | "ws"): GuardVerdict => {
    if (funnel === null) return { allow: false, status: 503, reason: "starting" };
    if (funnel.state === "on") return { allow: false, status: 503, reason: "funnel" };
    // The first check could not tell: no proof Funnel is off yet.
    if (funnel.state === "unknown") return { allow: false, status: 503, reason: "funnel_unknown" };
    return security.guard(req, kind);
  };
  const server = createBridgeServer({
    hub,
    ...(o.staticDir ? { staticDir: o.staticDir } : {}),
    port: o.port ?? DEFAULT_API_PORT,
    guard,
    routes: security.routes,
    onConnect: security.onConnect,
  });
  const { port } = await server.listen();
  log({ event: "api_listening", port });

  const recheck = async (): Promise<FunnelVerdict> => {
    let v: FunnelVerdict;
    try {
      v = await checkFunnel({ run, tailscale: o.tailscale ?? "tailscale", apiPort: port, servePort: SERVE_PORT });
    } catch {
      v = { state: "unknown", detail: "check failed" };
    }
    const before = funnel?.state;
    // A check that can't tell keeps the last verdict: `on` keeps refusing, `off` keeps serving (one failed read
    // between two clean ones is not evidence Funnel turned on). With no verdict yet, it refuses.
    if (v.state !== "unknown" || funnel === null || funnel.state === "unknown") funnel = v;
    if (funnel.state === "on" && before !== "on") hub.closeAll(CLOSE_FUNNEL, "funnel");
    log({ event: "funnel", verdict: v });
    return v;
  };

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  try {
    await recheck();
    await host.start();
    await plugins.start();
    await panorama.start();
    await inbox.start();
    usage.start();
    chat.start();
  } catch (e) {
    panel.stop();
    // Each stop is safe on a driver that never started.
    chat.stop();
    usage.stop();
    inbox.stop();
    panorama.stop();
    plugins.stop();
    await host.stop().catch(() => {});
    await server.close().catch(() => {});
    throw e;
  }
  const tick = () => {
    timer = setTimeout(() => {
      void recheck().finally(() => {
        if (!stopped) tick();
      });
    }, funnel?.state === "unknown" ? FUNNEL_RETRY_MS : (o.funnelCheckMs ?? FUNNEL_CHECK_MS));
    timer.unref();
  };
  tick();

  return {
    hub,
    security,
    server,
    port,
    get funnel() {
      return funnel;
    },
    checkFunnel: recheck,
    setServe: (s) => security.setServe(s),
    async stop() {
      if (stopped) return;
      stopped = true;
      panel.stop();
      if (timer) clearTimeout(timer);
      usage?.stop();
      chat.stop();
      inbox.stop();
      panorama.stop();
      plugins.stop();
      await host.stop();
      await server.close();
    },
  };
}
