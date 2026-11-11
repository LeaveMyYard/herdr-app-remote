// Funnel refusal (PLAN §2): the bridge never serves while Tailscale Funnel exposes its port to the internet.
//
// Read-only: this runs `tailscale serve status --json` and never changes serve config (S14 owns that).
import type { Runner } from "../plugins/exec.js";

/** PLAN §7.8: the HTTPS port `tailscale serve` uses for the bridge. */
export const SERVE_PORT = 8443;
export const FUNNEL_TIMEOUT_MS = 5_000;

/**
 * - `off`: Funnel is not on for the serve port or for any handler that reaches the API port, or tailscale is not
 *   installed (nothing can be funneled).
 * - `on`: it is; `where` names the first `host:port` found.
 * - `unknown`: tailscale failed, timed out or printed something unreadable. Before any verdict this refuses; after
 *   one it keeps it (see `startApp`).
 */
export type FunnelVerdict = { state: "off" } | { state: "on"; where: string } | { state: "unknown"; detail: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The local port a serve target (`http://127.0.0.1:3000`, `localhost:3000`, `3000`, `tcp://...`) points at. */
export function targetPort(target: string): number | undefined {
  const t = target.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:[a-z+]+:\/\/)?(?:\[[^\]]*\]|[^/:]*):(\d+)(?:\/.*)?$/i.exec(t);
  return m ? Number(m[1]) : undefined;
}

/** `host:port` → port. */
const hostPortPort = (hp: string): number | undefined => {
  const m = /:(\d+)$/.exec(hp);
  return m ? Number(m[1]) : undefined;
};

/** Every port a serve config's handlers for `hostPort` forward to, web and TCP. */
function forwardedPorts(cfg: Obj, hostPort: string): number[] {
  const out: number[] = [];
  const web = isObj(cfg.Web) ? cfg.Web[hostPort] : undefined;
  if (isObj(web) && isObj(web.Handlers)) {
    for (const h of Object.values(web.Handlers)) {
      if (isObj(h) && typeof h.Proxy === "string") {
        const p = targetPort(h.Proxy);
        if (p !== undefined) out.push(p);
      }
    }
  }
  const port = hostPortPort(hostPort);
  const tcp = isObj(cfg.TCP) && port !== undefined ? cfg.TCP[String(port)] : undefined;
  if (isObj(tcp) && typeof tcp.TCPForward === "string") {
    const p = targetPort(tcp.TCPForward);
    if (p !== undefined) out.push(p);
  }
  return out;
}

/** The serve configs in a status document: the main one and each foreground session's. */
function configs(doc: Obj): Obj[] {
  const out = [doc];
  if (isObj(doc.Foreground)) for (const v of Object.values(doc.Foreground)) if (isObj(v)) out.push(v);
  return out;
}

/**
 * Decides from `tailscale serve status --json` whether Funnel is on for us: for the serve port, or for any
 * `host:port` whose handlers forward to the API port.
 */
export function funnelFromStatus(raw: unknown, apiPort: number, servePort = SERVE_PORT): FunnelVerdict {
  if (!isObj(raw)) return { state: "unknown", detail: "unreadable status" };
  for (const cfg of configs(raw)) {
    if (!isObj(cfg.AllowFunnel)) continue;
    for (const [hostPort, on] of Object.entries(cfg.AllowFunnel)) {
      if (on !== true) continue;
      if (hostPortPort(hostPort) === servePort || forwardedPorts(cfg, hostPort).includes(apiPort)) return { state: "on", where: hostPort };
    }
  }
  return { state: "off" };
}

export async function checkFunnel(opts: { run: Runner; tailscale: string; apiPort: number; servePort?: number; timeoutMs?: number }): Promise<FunnelVerdict> {
  const r = await opts.run(opts.tailscale, ["serve", "status", "--json"], { timeoutMs: opts.timeoutMs ?? FUNNEL_TIMEOUT_MS });
  if (r.error === "ENOENT") return { state: "off" };
  if (r.error || r.code !== 0) return { state: "unknown", detail: "tailscale serve status failed" };
  // An empty config prints nothing (or `{}`): nothing is served, so nothing is funneled.
  if (r.stdout.trim() === "") return { state: "off" };
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { state: "unknown", detail: "unreadable status" };
  }
  return funnelFromStatus(doc, opts.apiPort, opts.servePort);
}
