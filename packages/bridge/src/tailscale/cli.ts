// Reading the Tailscale CLI (S14): `tailscale version`, `tailscale status --json`, `tailscale serve status --json`,
// and the error text of `tailscale serve`. Pure functions over captured output: nothing here runs a command.
//
// Nothing a parser returns carries CLI output verbatim, except the fields the setup screen shows by design
// (tailnet name, host name, DNS name, owner login) and an enable URL that is checked to be a Tailscale admin link.

import { configs, hostPortPort } from "../app/funnel.js";

/** `tailscale serve --bg --https=<port> <target>` exists since 1.52 (serve v2). */
export const MIN_TAILSCALE = "1.52.0";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `1.76.1` from the first line of `tailscale version` (`1.76.1-t1234abcd-g5678` too). */
export function parseVersion(stdout: string): string | undefined {
  const first = stdout.split("\n", 1)[0]?.trim() ?? "";
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+.\s]|$)/.exec(first);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/** a < b for dotted numeric versions. */
export function versionBelow(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** What setup needs from `tailscale status --json`. */
export interface TailnetStatus {
  /** `Running`, `NeedsLogin`, `NeedsMachineAuth`, `Stopped`, `Starting`, `NoState`. */
  backend: string;
  /** This computer's short host name. */
  hostName: string | null;
  /** The MagicDNS name, without the trailing dot (`desk-1.example-tailnet.ts.net`). */
  dnsName: string | null;
  tailnet: string | null;
  magicDns: boolean;
  /** HTTPS certificates are on for this node's name. */
  https: boolean;
  /** The node is tagged: it has no owner user, and its requests carry no identity. */
  tagged: boolean;
  /** The LoginName of the node's owner. */
  login: string | null;
}

export function parseStatus(raw: unknown): TailnetStatus | undefined {
  if (!isObj(raw)) return undefined;
  const backend = str(raw.BackendState);
  if (!backend) return undefined;
  const self = isObj(raw.Self) ? raw.Self : {};
  const dns = str(self.DNSName)?.replace(/\.$/, "").toLowerCase() || null;
  const tags = Array.isArray(self.Tags) ? self.Tags.filter((t) => typeof t === "string") : [];
  const tn = isObj(raw.CurrentTailnet) ? raw.CurrentTailnet : {};
  const certs = Array.isArray(raw.CertDomains) ? raw.CertDomains.filter((d): d is string => typeof d === "string") : [];
  let login: string | null = null;
  const uid = self.UserID;
  if (!tags.length && (typeof uid === "number" || typeof uid === "string") && isObj(raw.User)) {
    const u = raw.User[String(uid)];
    if (isObj(u)) login = str(u.LoginName) || null;
  }
  return {
    backend,
    hostName: str(self.HostName) || null,
    dnsName: dns,
    tailnet: str(tn.Name) || null,
    magicDns: tn.MagicDNSEnabled === true,
    https: dns !== null && certs.some((d) => d.replace(/\.$/, "").toLowerCase() === dns),
    tagged: tags.length > 0,
    login,
  };
}

/** The target we serve: the bridge's API listener (always 127.0.0.1). */
export const serveTarget = (apiPort: number) => `http://127.0.0.1:${apiPort}`;

/**
 * How a serve config uses `port`.
 * - `off`: nothing on it.
 * - `exact`: exactly our handler: TCP `{HTTPS: true}`, one web entry `<dnsName>:<port>` whose only handler is
 *   `/` → `http://127.0.0.1:<apiPort>`, no Funnel, no foreground session on it.
 * - `funnel`: Funnel is allowed on it (for any host).
 * - `foreign`: anything else.
 */
export type PortUse = "off" | "exact" | "funnel" | "foreign";

// The main config first, then each foreground session's (shared with the Funnel check).
const portOf = hostPortPort;

/** Everything a single config holds for `port`. */
function onPort(cfg: Obj, port: number): { tcp: unknown; web: [string, unknown][]; funnel: boolean } {
  const tcp = isObj(cfg.TCP) ? cfg.TCP[String(port)] : undefined;
  const web = isObj(cfg.Web) ? Object.entries(cfg.Web).filter(([hp]) => portOf(hp) === port) : [];
  const funnel = isObj(cfg.AllowFunnel) && Object.entries(cfg.AllowFunnel).some(([hp, on]) => on === true && portOf(hp) === port);
  return { tcp, web, funnel };
}

const keysExactly = (o: Obj, keys: string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

export function portUse(raw: unknown, o: { port: number; apiPort: number; dnsName: string }): PortUse | undefined {
  if (raw === null || raw === undefined) return "off";
  if (!isObj(raw)) return undefined;
  const all = configs(raw).map((c) => onPort(c, o.port));
  if (all.some((u) => u.funnel)) return "funnel";
  const [main, ...fg] = all as [ReturnType<typeof onPort>, ...ReturnType<typeof onPort>[]];
  const fgUsed = fg.some((u) => u.tcp !== undefined || u.web.length > 0);
  if (main.tcp === undefined && main.web.length === 0) return fgUsed ? "foreign" : "off";
  if (fgUsed) return "foreign";
  const tcpOk = isObj(main.tcp) && keysExactly(main.tcp, ["HTTPS"]) && main.tcp.HTTPS === true;
  if (!tcpOk || main.web.length !== 1) return "foreign";
  const [hostPort, entry] = main.web[0]!;
  if (hostPort.toLowerCase() !== `${o.dnsName}:${o.port}`) return "foreign";
  if (!isObj(entry) || !keysExactly(entry, ["Handlers"]) || !isObj(entry.Handlers)) return "foreign";
  if (!keysExactly(entry.Handlers, ["/"])) return "foreign";
  const h = entry.Handlers["/"];
  if (!isObj(h) || !keysExactly(h, ["Proxy"]) || h.Proxy !== serveTarget(o.apiPort)) return "foreign";
  return "exact";
}

/** `tailscale serve status --json` output → document; empty output is an empty config. */
export function parseServeStatus(stdout: string): { ok: true; doc: unknown } | { ok: false } {
  if (stdout.trim() === "") return { ok: true, doc: null };
  try {
    return { ok: true, doc: JSON.parse(stdout) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Classifies a failed or stuck `tailscale serve` / `status` run by its output. */
export type CliTrouble =
  | { kind: "operator" }
  | { kind: "serve_disabled"; url: string | null }
  | { kind: "https_off" }
  | { kind: "daemon_down" }
  | { kind: "other" };

const ENABLE_URL = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9/?=&._~%-]{1,250}/;

export function classifyTrouble(text: string): CliTrouble {
  // The Linux operator case: a non-root user who is not the tailscale operator may not change serve config.
  if (/access denied|permission denied|--operator|not permitted|operator=/i.test(text)) return { kind: "operator" };
  if (/serve is not enabled|funnel is not enabled|to enable, visit/i.test(text)) {
    const m = ENABLE_URL.exec(text);
    return { kind: "serve_disabled", url: m ? m[0] : null };
  }
  if (/https.{0,40}(not enabled|disabled|are off)|enable https|certificates?.{0,20}(not enabled|disabled)/i.test(text)) return { kind: "https_off" };
  if (/failed to connect to local tailscale|doesn't appear to be running|is tailscaled running|connection refused/i.test(text)) return { kind: "daemon_down" };
  return { kind: "other" };
}

/** The fix for the operator case. Shown to the person; the bridge never runs it. */
export const OPERATOR_FIX = "sudo tailscale set --operator=$USER";
