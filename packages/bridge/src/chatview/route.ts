// `GET /api/v1/chatview/<t>?before=<id>&n=<1..50>[&rev=<rev>]`: older items of an open chat view (CV3, §5.3, §7).
// Read-only. Behind the same guards as every request (the server's guard checked Host and the owner login before
// this runs), plus here: the device cookie, the capabilities the `chatview:<t>` topic needs (`view` and
// `transcript.read`), the `X-Remote-Api: 1` marker and, when the browser sends one, the exact Origin. At most 20
// per 10 s per device. Activity records each page by count only, never text; a page Activity can't record is
// refused (`audit_unavailable`), as a chat open is.
import type { IncomingMessage, ServerResponse } from "node:http";
import { bridgeApi } from "@herdr-remote/protocol";
import { topicCaps, type Capability } from "../security/caps.js";
import { singleHeader } from "../security/headers.js";
import { RateLimiter, type Limit } from "../security/rate.js";
import type { AuditEntry } from "../security/audit.js";
import type { PageResult } from "./topic.js";

export const CHATVIEW_PATH = "/api/v1/chatview/";
export const PAGE_LIMIT: Limit = { max: 20, windowMs: 10_000 };
const REV = /^[0-9a-f]{1,64}$/;

export interface ChatviewRouteGate {
  requestDevice(req: IncomingMessage, needs: readonly Capability[]): { id: string } | undefined;
  /** False when Activity could not record the page. */
  auditChatPage(deviceId: string, terminal: string, count: number): boolean;
  note(e: Omit<AuditEntry, "ts">): void;
  /** A device's name for an Activity line, if it is known. */
  deviceName(id: string): string | undefined;
  /** `https://<serve name>`, or null while there is none (then every request was already refused by the guard). */
  origin(): string | null;
}

export interface ChatviewRouteOptions {
  gate: ChatviewRouteGate;
  page: (terminal: string, before: string, n: number, rev?: string) => PageResult;
  now?: () => number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Security-Policy": "default-src 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(s),
  });
  res.end(s);
}

/** The route handler, for `createBridgeServer`'s `routes` chain. True when it answered the request. */
export function chatviewRoute(o: ChatviewRouteOptions): (req: IncomingMessage, res: ServerResponse, path: string) => boolean {
  const limit = new RateLimiter(PAGE_LIMIT, o.now ?? Date.now);
  return (req, res, path) => {
    if (!path.startsWith(CHATVIEW_PATH)) return false;
    if (req.method !== "GET") {
      json(res, 405, { error: "method_not_allowed" });
      return true;
    }
    // CSRF on a read of history: a marker no cross-site simple request can send (it forces a preflight the bridge
    // never answers), and the exact Origin when the browser sends one.
    const origin = singleHeader(req, "origin");
    if (singleHeader(req, "x-remote-api") !== "1" || (origin !== undefined && origin !== o.gate.origin())) {
      json(res, 403, { error: "forbidden" });
      return true;
    }
    const device = o.gate.requestDevice(req, []);
    if (!device) {
      json(res, 401, { error: "unpaired" });
      return true;
    }
    let terminal: string;
    try {
      terminal = decodeURIComponent(path.slice(CHATVIEW_PATH.length));
    } catch {
      terminal = "";
    }
    // Exactly what the topic needs: `view` and `transcript.read` (CV1's topicCaps), so a page never reads more.
    if (!o.gate.requestDevice(req, topicCaps(`${bridgeApi.CHATVIEW_PREFIX}${terminal}`))) {
      json(res, 403, { error: "forbidden" });
      return true;
    }
    const v = limit.take(device.id);
    if (!v.ok) {
      if (v.firstRefusal) {
        const name = o.gate.deviceName(device.id) ?? "A phone";
        o.gate.note({ event: "chatview.page", device: name, text: `${name} loaded earlier messages too fast: refused`, ok: false, code: "rate_limited" });
      }
      json(res, 429, { error: "rate_limited" });
      return true;
    }
    if (!bridgeApi.TERMINAL_ID.test(terminal)) {
      json(res, 400, { error: "bad_terminal" });
      return true;
    }
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const before = q.get("before") ?? "";
    const nRaw = q.get("n");
    const n = nRaw === null ? bridgeApi.CHATVIEW_PAGE_MAX : /^[1-9][0-9]?$/.test(nRaw) ? Number(nRaw) : NaN;
    const rev = q.get("rev") ?? undefined;
    if (!bridgeApi.ChatItemId.safeParse(before).success || !(n >= 1 && n <= bridgeApi.CHATVIEW_PAGE_MAX) || (rev !== undefined && !REV.test(rev))) {
      json(res, 400, { error: "bad_request" });
      return true;
    }
    const r = o.page(terminal, before, n, rev);
    if (!r.ok) {
      json(res, r.status, { error: r.code });
      return true;
    }
    if (!o.gate.auditChatPage(device.id, terminal, r.page.items.length)) {
      json(res, 503, { error: "audit_unavailable" });
      return true;
    }
    json(res, 200, r.page);
    return true;
  };
}
