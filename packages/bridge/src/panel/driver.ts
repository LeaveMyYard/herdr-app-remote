// The desktop Remote panel's side of the bridge (S13): builds the PanelView from the security layer, the
// plugins topic and the link, pushes it to the `panel` copy of the mod, and runs the desktop-only operations
// the panel asks for (approve, revoke, capability toggles, pause, pairing code).
//
// These operations never pass through the phone-facing `act` path: they exist only on the loopback link, for
// the panel copy that authenticated with the runtime token. The allowlist is `modLink.PANEL_ACT_ARGS`.
import { modLink, type bridgeApi } from "@herdr-remote/protocol";
import type { Hub } from "../hub.js";
import type { LinkServer, PanelHandlers } from "../link/server.js";
import { qrMatrix } from "../security/qr.js";
import type { Security } from "../security/security.js";

type Outcome = { ok: true } | { ok: false; code: string };

export interface PanelDriverOptions {
  link: LinkServer;
  security: Security;
  hub: Hub;
  /** The last Funnel verdict state (`on` blocks serving). */
  funnel: () => "on" | "off" | "unknown" | null;
  /** More Status checks (S14: the Tailscale steps). */
  extraChecks?: () => modLink.PanelCheck[];
  /** Handles the kinds this driver does not know (S14: setup.check/start/stop, once added to PANEL_ACT_ARGS). */
  extraAct?: (kind: string, args: Record<string, unknown>) => Promise<Outcome> | Outcome;
  now?: () => number;
  /** How often the view is rebuilt while a panel is linked (activity and live counts change without a security event). Default 2 s. */
  refreshMs?: number;
}

const POWERS: Record<string, { name: string; powers: string }> = {
  panorama: { name: "herdr-panorama", powers: "Agents (rich), Swarm, Peek" },
  inbox: { name: "herdr-inbox", powers: "Inbox" },
  usage: { name: "agent-usage", powers: "Usage" },
  hc: { name: "herdr-core (hc)", powers: "Chat" },
  host: { name: "herdr-app", powers: "Agents (basic)" },
};
const SHOWN_ALWAYS = ["panorama", "inbox", "usage"];

export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

export class PanelDriver {
  private readonly o: PanelDriverOptions;
  private readonly now: () => number;
  private readonly startedAt: number;
  private pairing: { url: string; expires_at: number; qr: string[]; issuedAt: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(o: PanelDriverOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    const handlers: PanelHandlers = { view: () => this.view(), act: (k, a) => this.act(k, a) };
    o.link.setPanel(handlers);
    this.timer = setInterval(() => this.o.link.pushPanel(), o.refreshMs ?? 2_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.o.link.setPanel(null);
  }

  /** Something changed (devices, caps, pause, plugins, funnel): push now. */
  changed(): void {
    this.o.link.pushPanel();
  }

  view(): modLink.PanelView {
    const { security } = this.o;
    const now = this.now();
    const serve = security.serveIdentity;
    const funnel = this.o.funnel();
    const paused = security.paused;
    const devices = security.devices();
    const status: modLink.PanelView["status"] = paused ? "paused" : funnel === "on" ? "blocked" : serve && funnel === "off" ? "serving" : "setup";

    const checks: modLink.PanelCheck[] = [
      { id: "bridge", label: "Bridge running", detail: `up ${duration(now - this.startedAt)}`, state: "ok" },
      this.o.link.connected("link")
        ? { id: "link", label: "Linked to herdr-app", detail: "the Remote layout block is live", state: "ok" }
        : { id: "link", label: "Not linked to herdr-app", detail: "this layout has no Remote block", state: "warn" },
    ];
    checks.push(...(this.o.extraChecks?.() ?? []));
    if (funnel === "on") checks.push({ id: "funnel", label: "Funnel is on", detail: "Access is refused until Funnel is turned off", state: "bad" });
    else if (serve) checks.push({ id: "serve", label: "Serving on the tailnet", detail: serve.host, state: funnel === "off" ? "ok" : "warn" });
    else checks.push({ id: "serve", label: "Not serving yet", detail: "Set up Tailscale to let a phone connect", state: "off" });
    if (paused) checks.push({ id: "paused", label: "Remote access paused", detail: "Every phone is refused until you resume", state: "warn" });

    const topic = this.o.hub.get("plugins") as bridgeApi.PluginsTopic | undefined;
    const plugins: modLink.PanelPlugin[] = [];
    for (const id of Object.keys(POWERS)) {
      const st = topic?.[id as keyof bridgeApi.PluginsTopic];
      if (!st) continue;
      if (st.state === "ready" && !SHOWN_ALWAYS.includes(id)) continue;
      const meta = POWERS[id]!;
      plugins.push({ id, name: meta.name, state: st.state, powers: meta.powers, ...(st.detail ? { detail: st.detail.slice(0, 160) } : {}) });
    }

    const pairing = this.activePairing(devices, now);
    return {
      status,
      url: serve ? `https://${serve.host}` : null,
      checks,
      devices: [...devices]
        .sort((a, b) => Number(b.state === "pending") - Number(a.state === "pending") || b.created_at - a.created_at)
        .map((d) => ({
          id: d.id,
          name: d.name,
          login: d.login,
          state: d.state,
          caps: {
            view: d.caps.view,
            "inbox.answer": d.caps["inbox.answer"],
            navigate: d.caps.navigate,
            "terminal.input": d.caps["terminal.input"],
            push: d.caps.push,
          },
          terminal_input_until: d.terminal_input_until,
          created_at: d.created_at,
          last_seen: d.last_seen,
          live: d.live,
        })),
      plugins,
      activity: security.activity(50).reverse().map((e) => ({ ts: e.ts, text: e.text.slice(0, 200) })),
      pairing: pairing ? { url: pairing.url, expires_at: pairing.expires_at, qr: pairing.qr } : null,
    };
  }

  private activePairing(devices: readonly { created_at: number }[], now: number) {
    const p = this.pairing;
    if (!p) return null;
    // Gone when expired, or when a phone has asked to pair since (the code is single use).
    if (now >= p.expires_at || devices.some((d) => d.created_at >= p.issuedAt) || this.o.security.paused) {
      this.pairing = null;
      return null;
    }
    return p;
  }

  async act(kind: modLink.PanelActName, args: Record<string, unknown>): Promise<Outcome> {
    const { security } = this.o;
    try {
      switch (kind) {
        case "device.approve":
          security.approve(String(args.id));
          return { ok: true };
        case "device.revoke":
          security.revoke(String(args.id));
          return { ok: true };
        case "device.cap": {
          const minutes = typeof args.minutes === "number" ? args.minutes : null;
          const until = minutes === null ? null : this.now() + minutes * 60_000;
          security.setCap(String(args.id), args.cap as modLink.PanelCap, Boolean(args.on), until);
          return { ok: true };
        }
        case "remote.pause":
          this.pairing = null;
          security.pause();
          return { ok: true };
        case "remote.resume":
          security.resume();
          return { ok: true };
        case "pair.code": {
          const c = security.issueCode();
          this.pairing = { url: c.url, expires_at: c.expires_at, qr: qrMatrix(c.url).map((row) => row.map((d) => (d ? "1" : "0")).join("")), issuedAt: this.now() };
          return { ok: true };
        }
        case "pair.hide":
          this.pairing = null;
          return { ok: true };
        default:
          return (await this.o.extraAct?.(kind, args)) ?? { ok: false, code: "unsupported_action" };
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("serve is not configured")) return { ok: false, code: "serve_not_configured" };
      if (msg.includes("paused")) return { ok: false, code: "paused" };
      if (msg.startsWith("no such")) return { ok: false, code: "not_found" };
      return { ok: false, code: "failed" };
    } finally {
      this.changed();
    }
  }
}
