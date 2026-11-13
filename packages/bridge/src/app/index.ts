// The bridge's API side, assembled: the hub and its topics (host, plugins, panorama, inbox, usage, chat:<t>), the security layer and the 127.0.0.1 API listener.
//
// The bridge process (`serve`, S12) owns the link server, runtime.json and the idle-out; it calls `startApp` with
// its listening link server and stops the app before it closes the link. Nothing here writes runtime.json or
// decides when the bridge exits.
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { type Binaries } from "../plugins/detect.js";
import { resolvedBinaries } from "../plugins/binaries.js";
import { run as defaultRun, type Runner } from "../plugins/exec.js";
import { randomBytes } from "node:crypto";
import { CHAT_READ_TIMEOUT_MS, ChatTopicDriver } from "../chat/topic.js";
import { ChatviewTopicDriver } from "../chatview/topic.js";
import { chatviewRoute } from "../chatview/route.js";
import { TimelineTopicDriver } from "../timeline/topic.js";
import { ClaudeHistory, type ReaderPoolOptions } from "../claude/index.js";
import { HostTopic } from "../host.js";
import { InboxTopicDriver } from "../inbox/topic.js";
import { Hub } from "../hub.js";
import { LinkHostSource } from "../link/host-source.js";
import type { LinkServer } from "../link/server.js";
import { PanelDriver } from "../panel/driver.js";
import { PanoramaTopicDriver } from "../panorama/topic.js";
import { PluginsTopicDriver } from "../plugins/topic.js";
import { PushService, type PushOptions } from "../push/service.js";
import { hostName } from "../security/host-name.js";
import { Security, type DeviceView, type ServeIdentity } from "../security/security.js";
import { createBridgeServer, type BridgeServer, type GuardVerdict } from "../server.js";
import type { PromptSource } from "../prompt/answer.js";
import type { StopSource } from "../prompt/stop.js";
import { pressActors } from "./presses.js";
import { PROMPT_READ_LINES } from "../prompt/screen.js";
import { KeysMenu, type Loaded as KeysLoaded, type LoadState as KeysLoadState } from "../terminal/keys-config.js";
import { UsageTopicDriver } from "../usage.js";
import type { Json } from "../patch.js";
import { navigateActor, routeActs, type Actor } from "./act.js";
import { manifestRoute } from "./manifest.js";
import { checkFunnel, SERVE_PORT, type FunnelVerdict } from "./funnel.js";
import { Setup } from "../tailscale/setup.js";
import { bridgeApi } from "@herdr-remote/protocol";

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
/** How often `keys.json` is looked at (a stat) for an edit; a press also looks first. */
export const KEYS_REFRESH_MS = 5_000;

export interface AppOptions {
  /** The herdr-app home (absolute): data, plugin receipts and feeds are read under it. */
  appHome: string;
  /** The listening link server of the bridge process. The app attaches to it and never closes it. */
  link: LinkServer;
  /** The built PWA (`packages/pwa/dist`); omitted means no static files. */
  staticDir?: string;
  /** Default {@link DEFAULT_API_PORT}; 0 picks a free port (tests). Always bound on 127.0.0.1. */
  port?: number;
  /**
   * The serve name and owner login. Left out (the bridge process), the Tailscale setup (S14) supplies it while
   * the serve port is served exactly as ours, and only `/healthz` answers until then. Given (tests, rigs that
   * stand in for serve), it is used as is and no setup runs.
   */
  serve?: ServeIdentity | null;
  bridgeVersion?: string;
  /** Test seams: the command runner and binaries (fake CLIs). */
  run?: Runner;
  binaries?: Binaries;
  tailscale?: string;
  /** Test seam: how long setup's `tailscale serve` commands may run (default `SERVE_TIMEOUT_MS`). */
  serveTimeoutMs?: number;
  /** For the usage topic's `~` abbreviation, and the fallback dirs binaries are looked for in (`~/.local/bin`). */
  home?: string;
  /** The PATH binaries are looked up on; default the bridge's own (tests). */
  binPath?: string;
  funnelCheckMs?: number;
  /** Extra `act` handlers (later slices: inbox, chat, terminal, push), tried before the built-in ones. */
  actors?: readonly Actor[];
  /** A device asked to pair: the desktop panel and a toast ask "Approve a new phone?" (S13 wires it); the toast carries no device text. */
  onPending?: (d: DeviceView) => void;
  /** Extra Status checks and panel operations (tests and rigs; Tailscale setup is wired in by the app itself). */
  panel?: Pick<import("../panel/driver.js").PanelDriverOptions, "extraChecks" | "extraAct">;
  log?: (e: AppLogEvent) => void;
  /**
   * The chat view's Claude reader child (CV2/CV3): its path and the sha256 it must have (the bundle's injected one,
   * `BUILT_READER_SHA256`). Left out, or with no hash, there is no reader: every Claude chat view is `reader_failed`
   * and the phone shows the text view. `pool` holds test seams.
   */
  claude?: { script: string; sha256: string | null; pool?: Omit<ReaderPoolOptions, "script" | "scriptSha256" | "home"> };
  /** Web Push test seams (S17): the fake push service's transport and endpoint check. */
  push?: Pick<PushOptions, "transport" | "allowEndpoint" | "tickMs" | "rateLimit" | "now">;
}

/** Structured log events. Never carries tokens, cookies, headers or topic contents. */
export type AppLogEvent =
  | { event: "api_listening"; port: number }
  | { event: "funnel"; verdict: FunnelVerdict }
  | { event: "invalid_topic"; topic: string; error: string }
  /** The Activity log could not be written (`ok: false`), or can be again. The panel's Status shows it too. */
  | { event: "audit_health"; ok: boolean; failures: number }
  /** The key menu (S16b) was read: the default, `keys.json`, or a damaged file set aside (never its content). */
  | ({ event: "keys_config" } & KeysLoadState);

export interface App {
  readonly hub: Hub;
  readonly security: Security;
  readonly server: BridgeServer;
  readonly push: PushService;
  /** The bound API port on 127.0.0.1. */
  readonly port: number;
  /** The last Funnel verdict that decided serving; `on` refuses every request. */
  readonly funnel: FunnelVerdict | null;
  /** Re-reads the Funnel state now (also runs every `funnelCheckMs`). */
  checkFunnel(): Promise<FunnelVerdict>;
  /** Only without setup (an explicit `serve` was given); throws while setup owns the identity. */
  setServe(serve: ServeIdentity | null): void;
  /** Tailscale setup and serve control; null when an explicit `serve` was given. Also published as topic `setup`. */
  readonly setup: Setup | null;
  /** Stops the topics and the API listener, after waiting for a setup Start or Stop in flight. Leaves the link server running. */
  stop(): Promise<void>;
}

/**
 * Starts the API side of the bridge. Every request is refused until a Funnel check has said `off`; while
 * Funnel is on (for the serve port, or for any handler that reaches the API port) every request, `/healthz`
 * included, answers `503 funnel` and live sockets are dropped with {@link CLOSE_FUNNEL}.
 */
export async function startApp(o: AppOptions): Promise<App> {
  const run = o.run ?? defaultRun;
  // Resolved to absolute paths (PATH, then ~/.local/bin and the like), and shared: the hc that `plugins` detects is the
  // one chat and the terminal actors run, also when herdr-app was started with a PATH that lacks ~/.local/bin.
  const binaries = o.binaries ?? resolvedBinaries({ ...(o.home !== undefined ? { home: o.home } : {}), ...(o.binPath !== undefined ? { path: o.binPath } : {}) });
  const log = o.log ?? (() => {});
  const invalid = (topic: string) => (error: string) => log({ event: "invalid_topic", topic, error });

  let usage: UsageTopicDriver | undefined = undefined;
  const dataDir = join(o.appHome, "data/herdr-app-remote");
  // The key menu (S16b), from `keys.json` or the default; reported once the hub and security exist (below).
  let onKeysLoad: (l: KeysLoaded) => void = () => {};
  const keysMenu = new KeysMenu(dataDir, (l) => onKeysLoad(l));
  let inboxDriver: InboxTopicDriver | undefined = undefined;
  let push: PushService | undefined = undefined;
  // The actors that press into a terminal (presses.ts): `terminal.send` (S16, `hc send` only), `terminal.keys` (S16b,
  // a menu entry's tokens only), `prompt.answer` (CV7, keys derived from a verified screen) and `agent.stop` (CV8,
  // Esc once). While an answer or a Stop runs in a terminal, the others into it are `busy` (one shared lock).
  const promptSourceRef: { current?: PromptSource } = {};
  const stopSourceRef: { current?: StopSource } = {};
  const presses = pressActors({ run, binaries, menu: keysMenu, promptSource: () => promptSourceRef.current, stopSource: () => stopSourceRef.current });
  const { terminal, keys, prompts, stopper } = presses;
  const actors: Actor[] = [
    ...(o.actors ?? []),
    (_c, kind, args) => usage?.act(kind, args),
    // The inbox verbs (S11): bound to the row the phone was shown; `inbox.answer` capability, audited.
    (_c, kind, args) => inboxDriver?.act(kind, args),
    // `push.subscribe` / `push.unsubscribe` (S17), bound to the device the socket acts as.
    (c, kind, args) => push?.act(c, kind, args),
    terminal,
    keys,
    prompts,
    stopper,
    navigateActor(o.link),
  ];
  // Security's topic cut reaches the hub, which is built after it.
  const hubRef: { current?: Hub } = {};
  // The desktop panel (S13) hears of security changes and new pairing requests through these two.
  const panelRef: { current?: PanelDriver } = {};
  // Tailscale setup (S14); assigned once the API port is known.
  let setup: Setup | null = null;
  const security = new Security({
    dataDir,
    serve: o.serve ?? null,
    inner: routeActs(actors),
    onChange: () => {
      // A revoked device or `push` turned off loses its subscription at once.
      push?.sync();
      panelRef.current?.changed();
      // Step 5 ("Add your phone") follows approvals and revocations.
      setup?.refreshPhone();
    },
    // A device that may no longer type has its `hc send` in flight killed (hc holds one while the desktop is typed on),
    // and its `hc keys` likewise; losing just one of the two capabilities kills just that one.
    onCut: (id, cap) => presses.cut(id ?? undefined, cap),
    onAuditHealth: (h) => log({ event: "audit_health", ok: h.ok, failures: h.failures }),
    // Chat history turned off (CV1): its open `chatview:<t>` / `timeline:<t>` subscriptions end now.
    onTopicsCut: (id) => hubRef.current?.recheck(id),
    onPending: (d) => {
      o.link.notify("info", "Approve a new phone?", "link", "open_panel");
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
    // The topic guard (CV1): `chatview:<t>` and `timeline:<t>` need `transcript.read` on top of `view`.
    mayRead: security.mayRead,
  });
  hubRef.current = hub;

  // The key menu as topic `keys`. An edited keys.json is published within KEYS_REFRESH_MS (or at the next press); a
  // damaged one is set aside and said in Activity and the log, by reason only (never the file's content).
  onKeysLoad = (l) => {
    log({ event: "keys_config", ...l.load });
    if (l.load.state === "damaged") {
      const at = l.load.where ? ` at ${l.load.where}` : "";
      const fate = l.load.setAside ? "set aside as keys.json.damaged" : "ignored";
      security.note({ event: "keys.config", text: `Key menu file is invalid (${l.load.reason}${at}): ${fate}, the default menu is in use`, ok: false, code: l.load.reason });
    }
    hub.publish("keys", l.topic as unknown as Json);
  };
  onKeysLoad(keysMenu.loaded);
  const keysTimer = setInterval(() => keysMenu.refresh(), KEYS_REFRESH_MS);
  keysTimer.unref();

  const host = new HostTopic({ hub, source: new LinkHostSource(o.link, { owned: false }), onInvalid: invalid("host") });
  const plugins = new PluginsTopicDriver({ hub, appHome: o.appHome, run, binaries, onInvalid: invalid("plugins") });
  const panorama = new PanoramaTopicDriver({ hub, appHome: o.appHome, onInvalid: invalid("panorama") });
  const chat = new ChatTopicDriver({ hub, run, binaries });
  const inbox = (inboxDriver = new InboxTopicDriver({ hub, appHome: o.appHome, run, binaries }));
  // The chat view (CV3): a reader only when the bridge knows the hash of the one it was built with.
  const history =
    o.claude && o.claude.sha256 !== null
      ? new ClaudeHistory({
          appHome: o.appHome,
          ...(o.home !== undefined ? { home: o.home } : {}),
          pool: { ...(o.claude.pool ?? {}), script: o.claude.script, scriptSha256: o.claude.sha256, ...(o.home !== undefined ? { home: o.home } : {}) },
        })
      : null;
  const chatview = new ChatviewTopicDriver({
    hub,
    history,
    feed: () => panorama.feedView(),
    onInvalid: (topic, error) => log({ event: "invalid_topic", topic, error }),
    // Native prompt cards (CV7): the screen as the text view reads it, and a per-start key for the cards' `rev`.
    prompts: {
      read: async (t) => {
        if (!bridgeApi.TERMINAL_ID.test(t)) return null;
        const r = await run(binaries.hc, ["read", t, "--lines", String(PROMPT_READ_LINES)], { timeoutMs: CHAT_READ_TIMEOUT_MS });
        return r.code === 0 && !r.error ? r.stdout : null;
      },
      revKey: randomBytes(32),
    },
  });
  promptSourceRef.current = chatview.promptSource;
  stopSourceRef.current = chatview.stopSource;
  // Plugin items inline in the chat view (CV5): inbox rows of the terminal, anchored only on its own transcript.
  const timeline = new TimelineTopicDriver({
    hub,
    holdUsage: () => usage?.hold() ?? (() => {}),
    asks: (t) => chatview.inboxAsks(t),
    toolUseIdOf: (key) => inbox.toolUseIdOf(key),
    onInvalid: (topic, error) => log({ event: "invalid_topic", topic, error }),
  });
  const chatviewPages = chatviewRoute({
    gate: {
      requestDevice: (req, needs) => security.requestDevice(req, needs),
      auditChatPage: (id, t, n) => security.auditChatPage(id, t, n),
      note: (e) => security.note(e),
      deviceName: (id) => security.deviceName(id),
      origin: () => security.origin(),
    },
    page: (t, before, n, rev) => chatview.page(t, before, n, rev),
  });
  usage = new UsageTopicDriver({ hub, run, binaries, appHome: o.appHome, ...(o.home !== undefined ? { home: o.home } : {}) });

  push = new PushService({
    dataDir: join(o.appHome, "data/herdr-app-remote"),
    gate: {
      mayPush: (id) => security.mayPush(id),
      // Push info needs only what holding the socket needs; `allowed` says whether `push` is on.
      requestDevice: (req) => security.requestDevice(req, []),
      device: (id) => security.pushDevice(id),
      note: (e) => security.note(e),
    },
    topics: () => ({ inbox: hub.get("inbox"), panorama: hub.get("panorama"), host: hub.get("host") }),
    serving: () => serving(),
    ...(o.push ?? {}),
  });
  const pushService = push;

  const panel = (panelRef.current = new PanelDriver({
    link: o.link,
    security,
    hub,
    funnel: () => funnel?.state ?? null,
    // The Setup view and its Check now / Start serving / Stop serving (S14b); null with a fixed serve identity.
    setup: () => setup,
    ...(o.panel ?? {}),
  }));

  const guard = (req: IncomingMessage, kind: "http" | "ws"): GuardVerdict => {
    if (funnel === null) return { allow: false, status: 503, reason: "starting" };
    if (funnel.state === "on") return { allow: false, status: 503, reason: "funnel" };
    // The first check could not tell: no proof Funnel is off yet.
    if (funnel.state === "unknown") return { allow: false, status: 503, reason: "funnel_unknown" };
    return security.guard(req, kind);
  };
  // S5b: the manifest names this device's Home Screen transfer code, when it has one.
  const manifest = manifestRoute(o.staticDir, (req) => security.manifestStartUrl(req));
  const server = createBridgeServer({
    hub,
    ...(o.staticDir ? { staticDir: o.staticDir } : {}),
    port: o.port ?? DEFAULT_API_PORT,
    guard,
    routes: async (req, res, path) =>
      (await security.routes(req, res, path)) || (await manifest(req, res, path)) || pushService.routes(req, res, path) || chatviewPages(req, res, path),
    onConnect: security.onConnect,
    hostName: () => hostName(security.serveIdentity),
  });
  const { port } = await server.listen();
  log({ event: "api_listening", port });

  setup =
    o.serve === undefined
      ? new Setup({
          run,
          tailscale: o.tailscale ?? "tailscale",
          apiPort: port,
          port: SERVE_PORT,
          dataDir: join(o.appHome, "data/herdr-app-remote"),
          hasPhone: () => security.devices().some((d) => d.state === "approved"),
          onIdentity: (id) => security.setServe(id),
          onFunnel: () => void recheck(),
          // Every Start and Stop serving lands in Activity, as fixed codes only.
          onAction: (a) => security.auditServe(a),
          ...(o.serveTimeoutMs !== undefined ? { serveTimeoutMs: o.serveTimeoutMs } : {}),
          onState: (st) => {
            const r = bridgeApi.SetupTopic.safeParse(st);
            if (r.success) hub.publish("setup", r.data as Json);
            else log({ event: "invalid_topic", topic: "setup", error: r.error.message });
            panel.changed();
          },
        })
      : null;

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
    if (funnel.state === "on" && before !== "on") {
      hub.closeAll(CLOSE_FUNNEL, "funnel");
      terminal.cancel();
      keys.cancel();
    }
    log({ event: "funnel", verdict: v });
    return v;
  };

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  try {
    await recheck();
    setup?.startTimer();
    await host.start();
    await plugins.start();
    await panorama.start();
    await inbox.start();
    usage.start();
    chat.start();
    chatview.start();
    timeline.start();
    // Last: its first look seeds the triggers from the topics as they are now, so nothing already there is announced.
    pushService.start();
  } catch (e) {
    clearInterval(keysTimer);
    pushService.stop();
    panel.stop();
    // Each stop is safe on a driver that never started.
    await setup?.close();
    timeline.stop();
    chatview.stop();
    history?.close();
    chat.stop();
    usage.stop();
    inbox.stop();
    panorama.stop();
    plugins.stop();
    await host.stop().catch(() => {});
    await server.close().catch(() => {});
    security.close();
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
    push: pushService,
    port,
    get funnel() {
      return funnel;
    },
    checkFunnel: recheck,
    setServe: (s) => {
      // With setup running, it owns the identity (and dedupes against it): a second writer would desync it.
      if (setup) throw new Error("the serve identity comes from Tailscale setup");
      security.setServe(s);
    },
    setup,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(keysTimer);
      panel.stop();
      pushService.stop();
      if (timer) clearTimeout(timer);
      // A Start or Stop in flight finishes first: exiting between a serve change and its record would leave a
      // handler herdr created but no longer knows is its own.
      await setup?.close();
      usage?.stop();
      timeline.stop();
      chatview.stop();
      history?.close();
      chat.stop();
      inbox.stop();
      panorama.stop();
      plugins.stop();
      await host.stop();
      await server.close();
      security.close();
    },
  };
}
