import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { bridgeApi } from "@herdr-remote/protocol";
import type { ActHandler, ActResult, HubClient } from "../hub.js";
import type { GuardVerdict } from "../server.js";
import { AuditLog, cleanLabel, describeAct, type AuditEntry, type AuditOptions } from "./audit.js";
import { ACTION_CAPS, CAPABILITIES, defaultCaps, hasCap, type Capability } from "./caps.js";
import { DeviceStore, newDeviceId, type Device } from "./devices.js";
import { headerValues, readCookie, singleHeader } from "./headers.js";
import { qrSvg } from "./qr.js";

/** The tailnet name the PWA is served under, and the desktop owner's Tailscale login. */
export interface ServeIdentity {
  /** The `Host` the browser sends, e.g. `desk-1.example-tailnet.ts.net` (with `:port` when not 443). */
  host: string;
  /** The owner's `Tailscale-User-Login`, e.g. `user-1@example`. */
  login: string;
}

export interface SecurityOptions {
  /** `data/herdr-app-remote`: holds `devices.json` and `activity.jsonl`. */
  dataDir: string;
  /** Unset until setup is done (S14); without it everything but `/healthz` is refused. */
  serve?: ServeIdentity | null;
  /** The real action handler (later slices). Only reached after the capability check. */
  inner?: ActHandler;
  now?: () => number;
  /** A device asked to pair: the desktop panel and a toast ask "Approve Phone 1?". */
  onPending?: (d: DeviceView) => void;
  /** Devices, capabilities or pause changed. */
  onChange?: () => void;
  audit?: Omit<AuditOptions, "dir">;
}

/** What the desktop panel sees of a device. Never includes the token hash. */
export interface DeviceView {
  id: string;
  name: string;
  login: string;
  state: "pending" | "approved";
  /** Effective capabilities right now (an expired `terminal.input` reads false). */
  caps: Record<Capability, boolean>;
  terminal_input_until: number | null;
  created_at: number;
  approved_at: number | null;
  last_seen: number | null;
  /** Open WebSocket connections. */
  live: number;
}

export const DEVICE_COOKIE = "__Host-hr-device";
/** 400 days, the longest lifetime browsers keep. Revocation, not expiry, ends a device. */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
export const CODE_TTL_MS = 5 * 60 * 1000;
/** A pairing request not approved within this long is dropped. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING = 3;
/** Failed code redemptions allowed per minute before `/api/v1/pair` answers 429. */
export const PAIR_FAIL_LIMIT = 10;
const BODY_LIMIT = 1024;

/** WebSocket close codes the bridge uses for security drops. */
export const CLOSE_REVOKED = 4001;
export const CLOSE_PAUSED = 4002;
export const CLOSE_NO_VIEW = 4003;
/** How long a dropped client gets to finish the close handshake before it is terminated. */
const KICK_GRACE_MS = 1000;

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256buf = (s: string) => createHash("sha256").update(s).digest();
const sha256 = (s: string) => sha256buf(s).toString("hex");

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type Deny = { allow: false; status: number; reason: string };
const deny = (status: number, reason: string): Deny => ({ allow: false, status, reason });
/** Host, identity and CSRF failures all read the same: no hint about which check failed. */
const FORBIDDEN = deny(403, "forbidden");

/**
 * The bridge's security layer (PLAN §2): request guards, pairing, devices, capabilities,
 * audit and pause. Plug `guard`, `routes` and `onConnect` into `createBridgeServer`, and
 * `act` into the Hub's `onAct`.
 */
export class Security {
  private readonly store: DeviceStore;
  private readonly log: AuditLog;
  private readonly now: () => number;
  private readonly inner: ActHandler | undefined;
  private readonly onPending: ((d: DeviceView) => void) | undefined;
  private readonly onChange: (() => void) | undefined;
  private serve: ServeIdentity | null;
  private code: { hash: Buffer; expires: number } | null = null;
  private pairFailures: number[] = [];
  private readonly live = new Map<string, Set<HubClient>>();
  /**
   * Clients the bridge has dropped. A graceful close leaves the socket readable until the
   * peer answers (or the close times out), so `act` refuses these outright, and the
   * transport is terminated shortly after.
   */
  private readonly dropped = new WeakSet<HubClient>();

  constructor(opts: SecurityOptions) {
    this.store = new DeviceStore(opts.dataDir);
    this.log = new AuditLog({ dir: opts.dataDir, ...opts.audit });
    this.now = opts.now ?? Date.now;
    this.inner = opts.inner;
    this.onPending = opts.onPending;
    this.onChange = opts.onChange;
    this.serve = null;
    this.setServe(opts.serve ?? null);
  }

  // ---- configuration ----

  /**
   * Sets (or clears) the serve name and owner login. A change drops every live socket:
   * devices of another login are no longer valid, and none are reachable without serve.
   */
  setServe(serve: ServeIdentity | null): void {
    const next = serve ? { host: serve.host.toLowerCase(), login: serve.login } : null;
    const same = next !== null && this.serve !== null && next.host === this.serve.host && next.login === this.serve.login;
    this.serve = next;
    if (same) return;
    // A pairing code is tied to the URL it was shown with.
    this.code = null;
    this.closeAll(CLOSE_REVOKED, "serve changed");
  }

  private closeAll(code: number, reason: string): void {
    for (const set of this.live.values()) for (const c of [...set]) this.kick(c, code, reason);
  }

  /** Closes a client for a security reason: refused from now on, terminated soon. */
  private kick(c: HubClient, code: number, reason: string): void {
    this.dropped.add(c);
    c.close(code, reason);
    if (c.terminate) {
      const t = setTimeout(() => c.terminate?.(), KICK_GRACE_MS);
      t.unref();
    }
  }

  get paused(): boolean {
    return this.store.paused;
  }

  /** Refuses everything except `/healthz` and drops every live connection. Persists. */
  pause(): void {
    if (this.store.paused) return;
    // Drop first: if persisting fails, the sockets are already gone and the error
    // reaches the caller (the in-memory flag is set either way).
    this.code = null;
    this.closeAll(CLOSE_PAUSED, "paused");
    this.store.paused = true;
    this.audit({ event: "pause", text: "Remote access paused" });
    this.changed();
  }

  resume(): void {
    if (!this.store.paused) return;
    this.store.paused = false;
    this.audit({ event: "resume", text: "Remote access resumed" });
    this.changed();
  }

  // ---- request guard ----

  /** The `guard` for `createBridgeServer`. */
  readonly guard = (req: IncomingMessage, kind: "http" | "ws"): GuardVerdict => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      return deny(400, "bad request");
    }
    const method = req.method ?? "GET";
    const safe = kind === "http" && (method === "GET" || method === "HEAD");
    if (safe && path === "/healthz") return true;
    if (this.store.paused) return deny(503, "paused");
    const serve = this.serve;
    if (!serve) return FORBIDDEN;
    // DNS-rebinding guard: only the serve name.
    const host = singleHeader(req, "host");
    if (host === undefined || host.toLowerCase() !== serve.host) return FORBIDDEN;
    // A precondition, never the credential: anything local can forge it. Tagged
    // devices send no identity headers at all and stop here.
    const login = singleHeader(req, "tailscale-user-login");
    if (login === undefined || login !== serve.login) return FORBIDDEN;
    if (!safe) {
      // CSRF: the exact origin, plus a marker no cross-site form or simple request can
      // send. Browsers can't set headers on a WS upgrade, so there it is our subprotocol.
      if (singleHeader(req, "origin") !== `https://${serve.host}`) return FORBIDDEN;
      if (kind === "ws" ? !offersProtocol(req) : singleHeader(req, "x-remote-api") !== "1") return FORBIDDEN;
      // Only pairing is reachable without an approved device.
      if (kind === "http" && path === "/api/v1/pair") return true;
      const d = this.deviceFor(req);
      if (!d || d.state !== "approved") return deny(401, "unpaired");
      if (kind === "ws") {
        if (!this.mayView(d)) return FORBIDDEN;
        return { allow: true, principal: { deviceId: d.id } };
      }
    }
    return true;
  };

  /**
   * The device a request's cookie names, if it is current for the owner login. Read-only:
   * an expired pending request reads as unknown here and is removed by `sweep` later.
   */
  private deviceFor(req: IncomingMessage): Device | undefined {
    const token = readCookie(req, DEVICE_COOKIE);
    if (token === undefined || !TOKEN_RE.test(token)) return undefined;
    const d = this.store.byTokenHash(sha256(token));
    if (!d || !this.current(d)) return undefined;
    return d;
  }

  /** Bound to the current owner login, and not an expired pairing request. */
  private current(d: Device): boolean {
    if (!this.serve || d.login !== this.serve.login) return false;
    return d.state === "approved" || this.now() - d.created_at < PENDING_TTL_MS;
  }

  /** Approved, current, not paused, with `view`: may hold a live socket. */
  private mayView(d: Device | undefined): d is Device {
    return !!d && !this.store.paused && d.state === "approved" && this.current(d) && hasCap(d.caps, "view", this.now());
  }

  /** Drops pairing requests that were never approved in time. */
  private sweep(): void {
    const now = this.now();
    const gone = this.store.removeWhere((d) => d.state === "pending" && now - d.created_at >= PENDING_TTL_MS);
    for (const d of gone) this.audit({ event: "pair.expire", device: d.name, text: `${d.name}: pairing request expired` });
    if (gone.length) this.changed();
  }

  // ---- HTTP routes ----

  /** The `routes` for `createBridgeServer`: `POST /api/v1/pair` and `GET /api/v1/me`. */
  readonly routes = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    try {
      if (path === "/api/v1/pair") {
        if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
        await this.pair(req, res);
        return true;
      }
      if (path === "/api/v1/me") {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed");
        const d = this.deviceFor(req);
        if (!d) throw new HttpError(401, "unpaired");
        json(res, 200, { device: this.view(d) });
        return true;
      }
      return false;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      json(res, e.status, { error: e.code });
      return true;
    }
  };

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = this.now();
    this.pairFailures = this.pairFailures.filter((t) => now - t < 60_000);
    if (this.pairFailures.length >= PAIR_FAIL_LIMIT) throw new HttpError(429, "rate_limited");
    const body = await readJson(req);
    const code = typeof body.code === "string" ? body.code : "";
    // Checked before redeeming, so a full queue doesn't burn the code.
    this.sweep();
    if (this.store.all().filter((d) => d.state === "pending").length >= MAX_PENDING) {
      throw new HttpError(429, "too_many_pending");
    }
    if (!this.redeem(code)) {
      this.pairFailures.push(now);
      this.audit({ event: "pair.fail", text: "Pairing refused: invalid or used code", ok: false });
      throw new HttpError(403, "bad_code");
    }
    const token = randomBytes(32).toString("base64url");
    const asked = typeof body.name === "string" ? cleanLabel(body.name, 32) : "";
    const d: Device = {
      id: newDeviceId(),
      name: this.uniqueName(asked || this.defaultName()),
      login: this.serve!.login,
      token_sha256: sha256(token),
      state: "pending",
      caps: { ...defaultCaps(), view: false, "inbox.answer": false },
      created_at: now,
      approved_at: null,
      last_seen: null,
    };
    this.store.add(d);
    // The cookie is set now but grants nothing until the desktop approves the device.
    res.setHeader(
      "Set-Cookie",
      `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`,
    );
    json(res, 202, { device: this.view(d) });
    this.audit({ event: "pair.request", device: d.name, text: `${d.name} asked to pair` });
    this.changed();
    this.onPending?.(this.view(d));
  }

  /** The client's name is a hint: a taken one gets a suffix, so prompts stay unambiguous. */
  private uniqueName(base: string): string {
    const used = new Set(this.store.all().map((d) => d.name));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = ` (${n})`;
      // Stays within the 32-character name the store's schema accepts.
      const candidate = `${[...base].slice(0, 32 - suffix.length).join("")}${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  private defaultName(): string {
    const used = new Set(this.store.all().map((d) => d.name));
    let n = 1;
    while (used.has(`Phone ${n}`)) n++;
    return `Phone ${n}`;
  }

  // ---- pairing codes ----

  /** A fresh single-use code (128-bit, 5 min). It replaces any earlier code. */
  issueCode(): { code: string; url: string; svg: string; expires_at: number } {
    if (!this.serve) throw new Error("serve is not configured");
    if (this.store.paused) throw new Error("remote access is paused");
    const code = randomBytes(16).toString("base64url");
    const expires = this.now() + CODE_TTL_MS;
    this.code = { hash: sha256buf(code), expires };
    const url = `https://${this.serve.host}/pair#c=${code}`;
    this.audit({ event: "pair.code", text: "Pairing code shown" });
    return { code, url, svg: qrSvg(url), expires_at: expires };
  }

  /** Consumes the active code if `code` matches it and it hasn't expired. */
  private redeem(code: string): boolean {
    const active = this.code;
    if (!active || !CODE_RE.test(code)) return false;
    if (this.now() >= active.expires) {
      this.code = null;
      return false;
    }
    const ok = timingSafeEqual(sha256buf(code), active.hash);
    if (ok) this.code = null;
    return ok;
  }

  // ---- devices (desktop-only operations) ----

  devices(): DeviceView[] {
    this.sweep();
    return this.store.all().map((d) => this.view(d));
  }

  private view(d: Device): DeviceView {
    const now = this.now();
    const caps = Object.fromEntries(CAPABILITIES.map((c) => [c, hasCap(d.caps, c, now)])) as Record<Capability, boolean>;
    return {
      id: d.id,
      name: d.name,
      login: d.login,
      state: d.state,
      caps,
      terminal_input_until: d.caps["terminal.input.until"],
      created_at: d.created_at,
      approved_at: d.approved_at,
      last_seen: d.last_seen,
      live: this.live.get(d.id)?.size ?? 0,
    };
  }

  approve(id: string): DeviceView {
    this.sweep();
    const d = this.store.get(id);
    if (!d || d.state !== "pending") throw new Error("no such pending device");
    this.store.update(id, (x) => {
      x.state = "approved";
      x.approved_at = this.now();
      x.caps = defaultCaps();
    });
    this.audit({ event: "device.approve", device: d.name, text: `${d.name} approved` });
    this.changed();
    return this.view(d);
  }

  /** Refuses a pending request or revokes an approved device; live connections drop now. */
  revoke(id: string): void {
    const d = this.store.get(id);
    if (!d) throw new Error("no such device");
    // Drop first, so a failed write (full disk) can't leave a revoked socket streaming.
    // The store removes the device from memory before it writes, so it is denied either way.
    this.drop(id, CLOSE_REVOKED, "revoked");
    this.store.remove(id);
    const text = d.state === "pending" ? `${d.name}: pairing refused` : `${d.name} revoked`;
    this.audit({ event: d.state === "pending" ? "pair.reject" : "device.revoke", device: d.name, text });
    this.changed();
  }

  rename(id: string, name: string): void {
    const clean = cleanLabel(name, 32);
    if (!clean) throw new Error("empty name");
    const d = this.store.get(id);
    if (!d) throw new Error("no such device");
    if (this.store.all().some((x) => x.id !== id && x.name === clean)) throw new Error("name in use");
    const old = d.name;
    this.store.update(id, (x) => (x.name = clean));
    this.audit({ event: "device.rename", device: clean, text: `${old} renamed to ${clean}` });
    this.changed();
  }

  /**
   * Turns a capability on or off. `until` (epoch ms) applies to `terminal.input` only.
   * Turning `view` off drops the device's live connections.
   */
  setCap(id: string, cap: Capability, on: boolean, until: number | null = null): void {
    const d = this.store.get(id);
    if (!d || d.state !== "approved") throw new Error("no such approved device");
    if (until !== null && cap !== "terminal.input") throw new Error("only terminal.input can expire");
    if (until !== null && (!Number.isSafeInteger(until) || until <= this.now())) throw new Error("until must be a future epoch ms");
    // Drop first, as in revoke.
    if (cap === "view" && !on) this.drop(id, CLOSE_NO_VIEW, "view off");
    this.store.update(id, (x) => {
      x.caps[cap] = on;
      if (cap === "terminal.input") x.caps["terminal.input.until"] = on ? until : null;
    });
    this.audit({ event: "device.cap", device: d.name, text: `${d.name}: ${cap} ${on ? "on" : "off"}` });
    this.changed();
  }

  private drop(id: string, code: number, reason: string): void {
    const set = this.live.get(id);
    if (!set) return;
    for (const c of [...set]) this.kick(c, code, reason);
  }

  // ---- live connections ----

  /** The `onConnect` for `createBridgeServer`: tracks live sockets so revoke drops them. */
  readonly onConnect = (client: HubClient): (() => void) => {
    const id = client.principal?.deviceId;
    const d = id !== undefined ? this.store.get(id) : undefined;
    // Checked again here: the guard's verdict may be stale if anything async ever runs
    // between it and the upgrade.
    if (id === undefined || !this.mayView(d)) {
      this.kick(client, this.store.paused ? CLOSE_PAUSED : CLOSE_REVOKED, "not allowed");
      return () => undefined;
    }
    let set = this.live.get(id);
    if (!set) this.live.set(id, (set = new Set()));
    set.add(client);
    this.bestEffort(() => {
      this.store.update(id, (x) => (x.last_seen = this.now()));
      this.audit({ event: "device.connect", device: d.name, text: `${d.name} connected` });
    });
    this.changed();
    return () => {
      set.delete(client);
      if (set.size === 0) this.live.delete(id);
      // Runs inside the socket's close listener: a failed write must not crash the bridge.
      this.bestEffort(() => {
        const cur = this.store.update(id, (x) => (x.last_seen = this.now()));
        if (cur) this.audit({ event: "device.disconnect", device: cur.name, text: `${cur.name} disconnected` });
      });
      this.changed();
    };
  };

  // ---- actions ----

  /** The Hub's `onAct`: capability check, then the real handler, then the audit entry. */
  readonly act: ActHandler = async (client, kind, args): Promise<ActResult> => {
    if (this.store.paused) return { ok: false, code: "paused" };
    const id = client.principal?.deviceId;
    const d = id !== undefined ? this.store.get(id) : undefined;
    // The same test as for holding the socket at all (approved, current login, `view`),
    // plus: a client the bridge already dropped can't act while its close is pending.
    if (this.dropped.has(client) || !this.mayView(d)) {
      if (!this.dropped.has(client)) this.kick(client, CLOSE_REVOKED, "revoked");
      return { ok: false, code: "unpaired" };
    }
    let what = describeAct(kind, args);
    const cap = ACTION_CAPS.get(kind);
    if (cap === undefined || !this.inner) {
      this.audit({ event: "act", device: d.name, text: `${d.name} ${what}: refused`, ok: false, code: "unsupported_action" });
      return { ok: false, code: "unsupported_action" };
    }
    if (!hasCap(d.caps, cap, this.now())) {
      this.audit({ event: "act", device: d.name, text: `${d.name} ${what}: refused`, ok: false, code: "forbidden" });
      return { ok: false, code: "forbidden" };
    }
    let res: ActResult;
    try {
      res = await this.inner(client, kind, args);
    } catch {
      res = { ok: false, code: "internal_error", unknown_effect: true };
    }
    if (res.audit_label !== undefined) what = describeAct(kind, args, res.audit_label);
    const entry: AuditEntry = { ts: this.now(), event: "act", device: d.name, text: `${d.name} ${what}`, ok: res.ok };
    if (!res.ok) {
      entry.code = res.unknown_effect ? "unknown_effect" : (res.code ?? "failed");
      entry.text += res.unknown_effect ? ": result unknown" : ": failed";
    }
    this.bestEffort(() => this.log.record(entry));
    // `audit_label` never reaches the client: the Hub's `toRes` copies only ok, code, unknown_effect, message and closed.
    return res;
  };

  // ---- audit ----

  /** The newest `n` Activity entries, oldest first. */
  activity(n = 100): AuditEntry[] {
    return this.log.tail(n);
  }

  private audit(e: Omit<AuditEntry, "ts">): void {
    this.log.record({ ts: this.now(), ...e });
  }

  /** Bookkeeping that must not turn a done security change (or a close) into a throw. */
  private bestEffort(fn: () => void): void {
    try {
      fn();
    } catch {
      // last_seen and Activity lines are best-effort; the decision already happened.
    }
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      // A listener's failure must not undo a security change.
    }
  }
}

/** The client offered our subprotocol (`Sec-WebSocket-Protocol` is a comma list). */
function offersProtocol(req: IncomingMessage): boolean {
  return headerValues(req, "sec-websocket-protocol")
    .flatMap((v) => v.split(","))
    .some((p) => p.trim() === bridgeApi.WS_PROTOCOL);
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = singleHeader(req, "content-type") ?? "";
  if (!/^application\/json(\s*;.*)?$/i.test(type)) throw new HttpError(415, "json_required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "too_large");
    chunks.push(chunk);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "bad_json");
  return v as Record<string, unknown>;
}
