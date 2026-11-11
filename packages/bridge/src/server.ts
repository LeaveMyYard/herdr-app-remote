import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import type { Hub, HubClient, Principal } from "./hub.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Strict CSP from the plan: no inline script, self-hosted everything. */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Max inbound WS frame. Client messages are tiny; anything bigger is abuse. */
const MAX_FRAME = 64 * 1024;
/** A client that lets this much pile up unsent is dropped. */
const MAX_BUFFERED = 8 * 1024 * 1024;

export interface ServerOptions {
  hub: Hub;
  /** Directory with the built PWA; omitted means no static files. */
  staticDir?: string;
  port?: number;
  /**
   * Request guard (S5 fills it in: Host, Origin, identity, cookie, pause).
   * Called for every HTTP request and WS upgrade, before anything else. `false` (or a
   * denial) answers with the given status, 403 by default. For an upgrade, an allow may
   * carry the `principal` the connection acts as. `/healthz` is exempt from nothing here:
   * the guard decides.
   */
  guard?: (req: IncomingMessage, kind: "http" | "ws") => GuardVerdict | Promise<GuardVerdict>;
  /**
   * Extra HTTP routes (S5: pairing). Called after the guard allowed the request and
   * before the built-in routes; returns true when it answered the request.
   */
  routes?: (req: IncomingMessage, res: ServerResponse, path: string) => boolean | Promise<boolean>;
  /** Called for each accepted WS connection; the returned function runs when it closes. */
  onConnect?: (client: HubClient) => (() => void) | void;
}

export type GuardVerdict =
  | boolean
  | { allow: true; principal?: Principal }
  | { allow: false; status: number; reason: string };

type Normalized = { allow: true; principal?: Principal } | { allow: false; status: number; reason: string };

function toVerdict(v: GuardVerdict): Normalized {
  if (v === true) return { allow: true };
  if (v === false) return { allow: false, status: 403, reason: "forbidden" };
  return v;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

export interface BridgeServer {
  readonly server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

/** Loopback only. The bridge never binds anything else. */
const BIND_HOST = "127.0.0.1";

export function createBridgeServer(opts: ServerOptions): BridgeServer {
  const { hub } = opts;
  const guard = opts.guard ?? (() => true);
  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : undefined;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const v = toVerdict(await guard(req, "http"));
        if (!v.allow) return end(res, v.status, v.reason);
        await route(req, res);
      } catch {
        if (!res.headersSent) end(res, 500, "internal error");
        else res.destroy();
      }
    })();
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (opts.routes && (await opts.routes(req, res, path))) return;
    if (req.method !== "GET" && req.method !== "HEAD") return end(res, 405, "method not allowed");
    if (path === "/healthz") return end(res, 200, "ok");
    if (path === "/api/v1/meta") {
      const body: bridgeApi.Meta = { api: bridgeApi.API_VERSION, bridge: hub.bridgeVersion };
      return end(res, 200, JSON.stringify(body), MIME[".json"]);
    }
    if (path.startsWith("/api/")) return end(res, 404, "not found");
    if (!staticRoot) return end(res, 404, "not found");
    await serveStatic(staticRoot, path, req, res);
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    // Echo our subprotocol when offered; the guard decides whether it was required.
    handleProtocols: (protocols) => (protocols.has(bridgeApi.WS_PROTOCOL) ? bridgeApi.WS_PROTOCOL : false),
  });

  server.on("upgrade", (req, socket, head) => {
    // Node removes its own socket error handler on upgrade; without one, a client reset
    // while the guard is pending would be an uncaught exception.
    const onSocketError = () => socket.destroy();
    socket.on("error", onSocketError);
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    void (async () => {
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        return reject("400 Bad Request");
      }
      if (path !== "/api/v1/ws") return reject("404 Not Found");
      let v: Normalized;
      try {
        v = toVerdict(await guard(req, "ws"));
      } catch {
        v = { allow: false, status: 403, reason: "forbidden" };
      }
      if (!v.allow) return reject(`${v.status} ${STATUS_TEXT[v.status] ?? "Forbidden"}`);
      if (socket.destroyed) return;
      const principal = v.principal;
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.off("error", onSocketError);
        attach(ws, principal);
      });
    })().catch(() => socket.destroy());
  });

  function attach(ws: WebSocket, principal: Principal | undefined): void {
    const client: HubClient = {
      ...(principal ? { principal } : {}),
      send(msg) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) {
          ws.close(1013, "slow client");
          return;
        }
        ws.send(JSON.stringify(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    const conn = hub.connect(client);
    // Frames are handled strictly in order, so `act` results can't overtake a later `sub`.
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      const raw = data.toString("utf8");
      chain = chain.then(() => hub.handleRaw(conn, raw)).catch(() => ws.close(1011, "internal error"));
    });
    let onClosed: (() => void) | void = undefined;
    try {
      onClosed = opts.onConnect?.(client);
    } catch {
      ws.terminate();
    }
    ws.on("close", () => {
      hub.disconnect(conn);
      onClosed?.();
    });
    ws.on("error", () => ws.terminate());
  }

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port ?? 0, BIND_HOST, () => {
          server.off("error", reject);
          const a = server.address() as AddressInfo;
          resolve({ host: a.address, port: a.port });
        });
      });
    },
    close() {
      hub.closeAll(1001, "shutting down");
      for (const c of wss.clients) c.terminate();
      return new Promise((resolve) => {
        wss.close(() => server.close(() => resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function end(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(root: string, urlPath: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return end(res, 400, "bad request");
  }
  if (decoded.includes("\0")) return end(res, 400, "bad request");
  const rel = normalize(decoded).replace(/^[/\\]+/, "");
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root + sep)) return end(res, 403, "forbidden");
  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    file = join(file, "index.html");
    st = await stat(file).catch(() => null);
  }
  if (!st?.isFile()) {
    // SPA fallback for extensionless routes only; missing assets stay 404.
    if (extname(decoded) !== "") return end(res, 404, "not found");
    file = join(root, "index.html");
    st = await stat(file).catch(() => null);
    if (!st?.isFile()) return end(res, 404, "not found");
  }
  const body = await readFile(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
