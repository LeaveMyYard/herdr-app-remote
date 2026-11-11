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
import { RateLimiter, type Limit } from "./rate.js";

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
  /** A device asked to pair: the desktop panel and a toast ask "Approve a new phone?". */
  onPending?: (d: DeviceView) => void;
  /** Devices, capabilities or pause changed. */
  onChange?: () => void;
  audit?: Omit<AuditOptions, "dir">;
  /**
   * A device (or, with null, every device) just lost the right to type: revoked, paused, `terminal.input` or `view`
   * turned off or expired, or the serve identity changed. The app kills that device's `hc send` in flight.
   */
  onCut?: (deviceId: string | null) => void;
  /** An Activity line could not be written (`ok: false`), or could again after failing (`ok: true`). */
  onAuditHealth?: (h: AuditHealth) => void;
}

/** Whether the Activity log is being written. A failed write is flagged here and in the desktop panel. */
export interface AuditHealth {
  ok: boolean;
  /** Epoch ms of the first failed write since the last good one; null while ok. */
  since: number | null;
  /** Failed writes since the last good one. */
  failures: number;
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
/**
 * Home Screen transfer (S5b): how long a transfer code works. It covers "Share, Add to Home Screen, open it" with
 * room to spare, and no more.
 */
export const TRANSFER_TTL_MS = 10 * 60 * 1000;
/** Live transfer codes one device may hold; minting another drops the oldest. */
export const TRANSFER_PER_DEVICE = 3;
/** Failed transfer redemptions allowed per minute before `/api/v1/pair/transfer` answers 429. */
export const TRANSFER_FAIL_LIMIT = 10;
export const PAIR_PATH = "/api/v1/pair";
export const TRANSFER_PATH = "/api/v1/pair/transfer";
const BODY_LIMIT = 1024;

/** WebSocket upgrades one approved device may make per minute; past it the upgrade answers 429 (a reconnect loop). */
export const CONNECT_LIMIT: Limit = { max: 20, windowMs: 60_000 };
/** `act`s one device may send per 10 s, of any kind and outcome (refused ones count: they are audited too). */
export const ACT_LIMIT: Limit = { max: 30, windowMs: 10_000 };
/** Tighter limits for single kinds, on top of {@link ACT_LIMIT}. A person sends a few messages, not a stream. */
export const KIND_LIMITS: ReadonlyMap<string, Limit> = new Map([["terminal.send", { max: 6, windowMs: 10_000 }]]);
/** Kinds that must not run while the Activity log can't be written: their whole safeguard is the audit line. */
const NEEDS_AUDIT: ReadonlySet<string> = new Set(["terminal.send"]);
/** Kinds the security layer answers itself, never handed to the inner handler. */
const LOCAL_KINDS: ReadonlySet<string> = new Set(["pair.transfer"]);
/** setTimeout's ceiling (about 24.8 days); a later expiry is re-armed when this fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** WebSocket close codes the bridge uses for security drops. */
export const CLOSE_REVOKED = 4001;
export const CLOSE_PAUSED = 4002;
export const CLOSE_NO_VIEW = 4003;
/** How long a dropped client gets to finish the close handshake before it is terminated. */
const KICK_GRACE_MS = 1000;

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A Home Screen transfer code (S5b). The plaintext stays in memory only, to be put in this device's manifest. */
interface Transfer {
  hash: Buffer;
  code: string;
  expires: number;
}

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
  /** Live Home Screen transfer codes by device id, oldest first. Memory only: a restart voids them. */
  private readonly transfers = new Map<string, Transfer[]>();
  private transferFailures: number[] = [];
  private readonly live = new Map<string, Set<HubClient>>();
  /**
   * Clients the bridge has dropped. A graceful close leaves the socket readable until the
   * peer answers (or the close times out), so `act` refuses these outright, and the
   * transport is terminated shortly after.
   */
  private readonly dropped = new WeakSet<HubClient>();
  private readonly connectLimit: RateLimiter;
  private readonly actLimit: RateLimiter;
  private readonly kindLimits = new Map<string, RateLimiter>();
  private readonly onAuditHealth: ((h: AuditHealth) => void) | undefined;
  private readonly onCut: ((deviceId: string | null) => void) | undefined;
  private health: AuditHealth = { ok: true, since: null, failures: 0 };
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(opts: SecurityOptions) {
    this.store = new DeviceStore(opts.dataDir);
    this.log = new AuditLog({ dir: opts.dataDir, ...opts.audit });
    this.now = opts.now ?? Date.now;
    this.inner = opts.inner;
    this.onPending = opts.onPending;
    this.onChange = opts.onChange;
    this.onAuditHealth = opts.onAuditHealth;
    this.onCut = opts.onCut;
    this.connectLimit = new RateLimiter(CONNECT_LIMIT, this.now);
    this.actLimit = new RateLimiter(ACT_LIMIT, this.now);
    for (const [kind, limit] of KIND_LIMITS) this.kindLimits.set(kind, new RateLimiter(limit, this.now));
    this.serve = null;
    this.setServe(opts.serve ?? null);
    // A `terminal.input` that ran out while the bridge was down is turned off now.
    this.scheduleExpiry();
  }

  /** Stops the expiry timer. The store and the log need no closing. */
  close(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
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
    // A pairing code is tied to the URL it was shown with; transfer codes to the identity that minted them.
    this.code = null;
    this.transfers.clear();
    this.closeAll(CLOSE_REVOKED, "serve changed");
    this.cut(null);
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

  /** The serve name and owner login now in force, or null before setup. */
  get serveIdentity(): ServeIdentity | null {
    return this.serve ? { ...this.serve } : null;
  }

  /** Refuses everything except `/healthz` and drops every live connection. Persists. */
  pause(): void {
    if (this.store.paused) return;
    // Drop first: if persisting fails, the sockets are already gone and the error
    // reaches the caller (the in-memory flag is set either way).
    this.code = null;
    this.transfers.clear();
    this.closeAll(CLOSE_PAUSED, "paused");
    this.cut(null);
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

  /**
   * A Tailscale "Start serving" or "Stop serving" finished (S14b). The line is built from the operation and a
   * fixed problem code only: never CLI output, a host name or anything else free-form.
   */
  auditServe(a: { op: "start" | "stop"; ok: boolean; code?: string }): void {
    const code = a.code !== undefined && /^[a-z_]{1,32}$/.test(a.code) ? a.code : "failed";
    const text = a.ok
      ? a.op === "start"
        ? "Started serving on the tailnet"
        : "Stopped serving on the tailnet"
      : `${a.op === "start" ? "Start" : "Stop"} serving failed (${code})`;
    this.bestEffort(() => this.audit({ event: `serve.${a.op}`, text, ...(a.ok ? { ok: true } : { ok: false, code }) }));
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
      // Only pairing and the Home Screen transfer are reachable without an approved device.
      if (kind === "http" && (path === PAIR_PATH || path === TRANSFER_PATH)) return true;
      const d = this.deviceFor(req);
      if (!d || d.state !== "approved") return deny(401, "unpaired");
      if (kind === "ws") {
        if (!this.mayView(d)) return FORBIDDEN;
        // Counted only for upgrades that would be allowed, so a refused stranger can't use up a device's window.
        const v = this.connectLimit.take(d.id);
        if (!v.ok) {
          if (v.firstRefusal) this.bestEffort(() => this.audit({ event: "device.rate_limit", device: d.name, text: `${d.name} reconnected too often: refused for a minute`, ok: false, code: "rate_limited" }));
          // A browser can't see an upgrade's status, and /api/v1/me still answers 200, so the PWA shows this as
          // offline and keeps retrying with backoff until the window frees (at most a minute). Acceptable for a loop.
          return deny(429, "rate_limited");
        }
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

  /** The `routes` for `createBridgeServer`: `POST /api/v1/pair`, `POST /api/v1/pair/transfer` and `GET /api/v1/me`. */
  readonly routes = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    try {
      if (path === PAIR_PATH) {
        if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
        await this.pair(req, res);
        return true;
      }
      if (path === TRANSFER_PATH) {
        if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
        await this.redeemTransfer(req, res);
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
    // A name in the body is ignored: pending rows, toasts and audit lines only ever show a bridge-made "Phone N".
    const d: Device = {
      id: newDeviceId(),
      name: this.defaultName(),
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

  // ---- Home Screen transfer (S5b) ----
  //
  // iOS gives a Home Screen web app its own cookie jar, apart from Safari's, so the device paired in Safari is not
  // paired in the Home Screen app. The transfer moves that approved device into the app's storage without a second
  // approval and without putting the cookie token in any URL:
  //   1. Safari (approved, over its own socket) sends `act pair.transfer`: the bridge mints a 128-bit, single-use
  //      code bound to that device, valid for TRANSFER_TTL_MS, and keeps its plaintext in memory only.
  //   2. That device's own manifest (`GET /manifest.webmanifest` with its cookie) carries the code in `start_url`
  //      (`./pair#t=<code>`). A request without that cookie gets the plain manifest.
  //   3. The Home Screen app opens `/pair#t=<code>` and posts it to `POST /api/v1/pair/transfer`: the code is spent
  //      (with every other code of that device), and the app gets its own token for the same device.

  /** Unexpired transfer codes of a device, oldest first; expired ones are forgotten. */
  private liveTransfers(id: string): Transfer[] {
    const now = this.now();
    const list = (this.transfers.get(id) ?? []).filter((t) => now < t.expires);
    if (list.length) this.transfers.set(id, list);
    else this.transfers.delete(id);
    return list;
  }

  /** `act pair.transfer`: a fresh transfer code for the acting (approved, `view`) device. The code itself is not returned. */
  private mintTransfer(d: Device): ActResult {
    const code = randomBytes(16).toString("base64url");
    const t: Transfer = { hash: sha256buf(code), code, expires: this.now() + TRANSFER_TTL_MS };
    this.transfers.set(d.id, [...this.liveTransfers(d.id), t].slice(-TRANSFER_PER_DEVICE));
    return { ok: true };
  }

  /**
   * The manifest `start_url` for the request's device: `./pair#t=<code>` with its newest live transfer code, or null
   * (no cookie, a device that may not view, or no live code). Read-only: GETs have no side effects.
   */
  manifestStartUrl(req: IncomingMessage): string | null {
    const d = this.deviceFor(req);
    if (!this.mayView(d)) return null;
    const newest = this.liveTransfers(d.id).at(-1);
    return newest ? `./pair#t=${newest.code}` : null;
  }

  /** Spends the transfer code matching `code` (and every other code of its device). Returns that device id. */
  private takeTransfer(code: string): string | null {
    if (!CODE_RE.test(code)) return null;
    const hash = sha256buf(code);
    for (const [id, list] of this.transfers) {
      const match = list.find((t) => timingSafeEqual(hash, t.hash));
      if (!match) continue;
      // Single use, for the whole device: whatever happens next, none of its codes works again.
      this.transfers.delete(id);
      return this.now() < match.expires ? id : null;
    }
    return null;
  }

  private async redeemTransfer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = this.now();
    this.transferFailures = this.transferFailures.filter((t) => now - t < 60_000);
    if (this.transferFailures.length >= TRANSFER_FAIL_LIMIT) throw new HttpError(429, "rate_limited");
    const body = await readJson(req);
    const id = this.takeTransfer(typeof body.code === "string" ? body.code : "");
    const d = id !== null ? this.store.get(id) : undefined;
    // A request that already carries another device's cookie must not end up as this device.
    const holder = this.deviceFor(req);
    if (!this.mayView(d) || (holder !== undefined && holder.id !== d.id)) {
      this.transferFailures.push(now);
      this.audit({ event: "pair.transfer_fail", text: "Home Screen setup refused: invalid or used code", ok: false });
      throw new HttpError(403, "bad_code");
    }
    // This browser already is the device (storage shared with Safari): the code is spent, nothing else changes.
    if (holder !== undefined) {
      json(res, 200, { device: this.view(d) });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    // One Home Screen token per device: a new one replaces the last (a re-added app), Safari's stays.
    this.store.update(d.id, (x) => {
      x.home_token_sha256 = sha256(token);
    });
    res.setHeader("Set-Cookie", `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`);
    json(res, 200, { device: this.view(d) });
    this.bestEffort(() => this.audit({ event: "pair.transfer", device: d.name, text: `${d.name} set up on the Home Screen` }));
    this.changed();
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
    this.cut(id);
    this.transfers.delete(id);
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
    if (cap === "view" && !on) {
      this.drop(id, CLOSE_NO_VIEW, "view off");
      this.transfers.delete(id);
    }
    if (!on && (cap === "view" || cap === "terminal.input")) this.cut(id);
    this.store.update(id, (x) => {
      x.caps[cap] = on;
      if (cap === "terminal.input") x.caps["terminal.input.until"] = on ? until : null;
    });
    this.scheduleExpiry();
    const limit = cap === "terminal.input" && on && until !== null ? ` until ${new Date(until).toISOString().slice(0, 16)}Z` : "";
    this.audit({ event: "device.cap", device: d.name, text: `${d.name}: ${cap} ${on ? "on" : "off"}${limit}` });
    this.changed();
  }

  // ---- terminal.input expiry ----

  /**
   * Turns off every `terminal.input` whose time is up, and arms a timer for the next one. `hasCap` already reads an
   * expired grant as off at every check; this makes it off in `devices.json`, says so in Activity and tells the
   * panel, so nothing shows a grant that no longer works.
   */
  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const now = this.now();
    let next = Infinity;
    let expired = false;
    for (const d of this.store.all()) {
      const until = d.caps["terminal.input.until"];
      if (!d.caps["terminal.input"] || until === null) continue;
      if (until > now) {
        next = Math.min(next, until);
        continue;
      }
      expired = true;
      this.cut(d.id);
      this.bestEffort(() => {
        this.store.update(d.id, (x) => {
          x.caps["terminal.input"] = false;
          x.caps["terminal.input.until"] = null;
        });
      });
      this.bestEffort(() => this.audit({ event: "device.cap", device: d.name, text: `${d.name}: terminal.input expired` }));
    }
    if (expired) this.changed();
    if (next !== Infinity) {
      this.expiryTimer = setTimeout(() => this.scheduleExpiry(), Math.max(1, Math.min(next - now, MAX_TIMER_MS)));
      this.expiryTimer.unref();
    }
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
    // Before anything else, so a loop of refused or unknown acts can't flood Activity either.
    const lim = this.actLimit.take(d.id);
    if (!lim.ok) {
      if (lim.firstRefusal) this.bestEffort(() => this.audit({ event: "act", device: d.name, text: `${d.name} sent actions too fast: refused`, ok: false, code: "rate_limited" }));
      return { ok: false, code: "rate_limited" };
    }
    const cap = ACTION_CAPS.get(kind);
    const local = LOCAL_KINDS.has(kind);
    if (cap === undefined || (!this.inner && !local)) {
      this.bestEffort(() => this.audit({ event: "act", device: d.name, text: `${d.name} ${what}: refused`, ok: false, code: "unsupported_action" }));
      return { ok: false, code: "unsupported_action" };
    }
    if (!hasCap(d.caps, cap, this.now())) {
      this.bestEffort(() => this.audit({ event: "act", device: d.name, text: `${d.name} ${what}: refused`, ok: false, code: "forbidden" }));
      return { ok: false, code: "forbidden" };
    }
    const kindLim = this.kindLimits.get(kind)?.take(d.id);
    if (kindLim && !kindLim.ok) {
      if (kindLim.firstRefusal) this.bestEffort(() => this.audit({ event: "act", device: d.name, text: `${d.name} ${kind}: too fast, refused`, ok: false, code: "rate_limited" }));
      return { ok: false, code: "rate_limited" };
    }
    if (NEEDS_AUDIT.has(kind) && !this.health.ok) {
      // Writing the refusal is also the probe: once a line goes through, the flag clears and the next send runs.
      this.bestEffort(() => this.audit({ event: "act", device: d.name, text: `${d.name} ${what}: refused, Activity can't be written`, ok: false, code: "audit_unavailable" }));
      return { ok: false, code: "audit_unavailable" };
    }
    let res: ActResult;
    try {
      res = local ? this.mintTransfer(d) : await this.inner!(client, kind, args);
    } catch {
      res = { ok: false, code: "internal_error", unknown_effect: true };
    }
    if (res.audit_label !== undefined) what = describeAct(kind, args, res.audit_label);
    const entry: AuditEntry = { ts: this.now(), event: "act", device: d.name, text: `${d.name} ${what}`, ok: res.ok };
    if (!res.ok) {
      entry.code = res.unknown_effect ? "unknown_effect" : (res.code ?? "failed");
      entry.text += res.unknown_effect ? ": result unknown" : ": failed";
    }
    this.bestEffort(() => this.record(entry));
    // `audit_label` never reaches the client: the Hub's `toRes` copies only ok, code, unknown_effect, message and closed.
    return res;
  };

  // ---- push (S17) ----

  /** Approved, current, not paused, with `view` and `push` in effect now: may be sent a push. */
  mayPush(id: string): boolean {
    const d = this.store.get(id);
    return this.mayView(d) && hasCap(d.caps, "push", this.now());
  }

  /** The device a request's cookie names, when it may hold a socket (approved, current, `view`, not paused). */
  requestDevice(req: IncomingMessage): { id: string } | undefined {
    const d = this.deviceFor(req);
    return this.mayView(d) ? { id: d.id } : undefined;
  }

  /** A known device's name, and whether it is approved with `push` on as stored. */
  pushDevice(id: string): { name: string; push: boolean } | undefined {
    const d = this.store.get(id);
    return d ? { name: d.name, push: d.state === "approved" && d.caps.push } : undefined;
  }

  /** An Activity entry from another part of the bridge (push). Identifiers only; never throws. */
  note(e: Omit<AuditEntry, "ts">): void {
    this.bestEffort(() => this.audit(e));
  }

  // ---- audit ----

  /** The newest `n` Activity entries, oldest first. */
  activity(n = 100): AuditEntry[] {
    return this.log.tail(n);
  }

  /** Whether Activity is being written; a failing log is flagged in the desktop panel. */
  get auditHealth(): AuditHealth {
    return { ...this.health };
  }

  private audit(e: Omit<AuditEntry, "ts">): void {
    this.record({ ts: this.now(), ...e });
  }

  /** Every Activity write goes through here, so a failure is flagged (and still thrown to the caller). */
  private record(entry: AuditEntry): void {
    try {
      this.log.record(entry);
    } catch (e) {
      const first = this.health.ok;
      this.health = { ok: false, since: this.health.since ?? this.now(), failures: this.health.failures + 1 };
      if (first) this.healthChanged();
      throw e;
    }
    if (!this.health.ok) {
      this.health = { ok: true, since: null, failures: 0 };
      this.healthChanged();
    }
  }

  private healthChanged(): void {
    try {
      this.onAuditHealth?.(this.auditHealth);
    } catch {
      // A listener's failure must not hide the audit failure itself.
    }
    this.changed();
  }

  /** Bookkeeping that must not turn a done security change (or a close) into a throw. */
  private bestEffort(fn: () => void): void {
    try {
      fn();
    } catch {
      // last_seen and Activity lines are best-effort; the decision already happened.
    }
  }

  /** Kills sends in flight for a device that may no longer type. Runs before anything is written, like the drops. */
  private cut(deviceId: string | null): void {
    try {
      this.onCut?.(deviceId);
    } catch {
      // A listener's failure must not undo a security change.
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
