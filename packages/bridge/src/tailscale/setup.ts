// Tailscale setup and serve control (S14, PLAN §2 and §6).
//
// The five setup steps of the DesktopSetup board, checked by reading the CLI (`version`, `status --json`,
// `serve status --json`), and the two commands that change anything:
// - "Start serving": `tailscale serve --bg --https=<port> http://127.0.0.1:<api port>`, only when the port has
//   no handler at all; afterwards the handler must read back exactly as ours, and only then is it recorded as
//   created by us (`serve.json`).
// - "Stop serving": `tailscale serve --https=<port> off`, only when the port holds exactly our handler AND our
//   record says we created it. A config we did not create is never changed, whatever it looks like.
//
// Not atomic: the CLI has no compare-and-set, so a handler mounted between our read and our command (a process
// spawn apart) would be replaced by Start or removed by Stop. Accepted for v1; every other path is checked.
//
// Funnel is never used: no command here enables it, start refuses while it is on for the port, and the bridge
// refuses to serve while it is on (see `app/funnel.ts`).
//
// The bridge's serve identity (Host and owner login, `Security.setServe`) comes from here: it is set while the
// port is served exactly as ours (created by us or not) by a signed-in, untagged node, and cleared when a check
// proves otherwise. A check that can't tell keeps the last identity.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bridgeApi } from "@herdr-remote/protocol";
import { SERVE_PORT } from "../app/funnel.js";
import type { Runner, RunResult } from "../plugins/exec.js";
import type { ServeIdentity } from "../security/security.js";
import {
  classifyTrouble,
  MIN_TAILSCALE,
  OPERATOR_FIX,
  parseServeStatus,
  parseStatus,
  parseVersion,
  portUse,
  serveTarget,
  versionBelow,
  type TailnetStatus,
} from "./cli.js";

type SetupTopic = bridgeApi.SetupTopic;
type SetupStep = bridgeApi.SetupStep;
type SetupProblem = bridgeApi.SetupProblem;
type SetupServing = bridgeApi.SetupServing;
type Code = bridgeApi.SetupProblemCode;

/** PLAN §7.8: the same port the Funnel check watches. */
export const DEFAULT_SERVE_PORT = SERVE_PORT;
export const READ_TIMEOUT_MS = 5_000;
/** `serve --bg` waits for the tailnet when serve is not enabled; it is cut off after this. */
export const SERVE_TIMEOUT_MS = 20_000;
/** While someone is setting up (recently asked), checks run this often (the board: "every 5 s"). */
export const FAST_CHECK_MS = 5_000;
export const SLOW_CHECK_MS = 30_000;
/** How long after the last explicit check, start or stop the fast rate lasts. */
export const FAST_WINDOW_MS = 10 * 60_000;
export const SERVE_RECORD = "serve.json";
const ADMIN_DNS = "https://login.tailscale.com/admin/dns";
const ADMIN = "https://login.tailscale.com/admin";

export interface SetupOptions {
  run: Runner;
  /** The tailscale binary (a fake CLI in tests). */
  tailscale: string;
  /** The bridge's API port on 127.0.0.1: the serve target. */
  apiPort: number;
  /** The HTTPS port on the tailnet. Default {@link DEFAULT_SERVE_PORT}. */
  port?: number;
  /** `data/herdr-app-remote`: holds the record of the handler we created. */
  dataDir: string;
  /** Whether any device is approved (step 5). */
  hasPhone: () => boolean;
  /** Called only when the identity changes (a change drops every live socket). */
  onIdentity: (id: ServeIdentity | null) => void;
  /** Funnel was seen on the serve port: the bridge re-reads its Funnel verdict at once (closing with 4004). */
  onFunnel?: () => void;
  /** Called with every new state. */
  onState?: (s: SetupTopic) => void;
  now?: () => number;
  /** Test seam: how long `serve --bg` / `serve ... off` may run. Default {@link SERVE_TIMEOUT_MS}. */
  serveTimeoutMs?: number;
  /** Called once per finished Start or Stop with its outcome (the audit log; codes only, never CLI output). */
  onAction?: (a: SetupAction) => void;
}

/** One finished Start or Stop: what it was and how it ended, as fixed codes only. */
export interface SetupAction {
  op: "start" | "stop";
  ok: boolean;
  code?: Code;
}

export type SetupResult = { ok: true } | { ok: false; code: Code; problem: SetupProblem };

/** Thrown by an operation asked for after {@link Setup.close}. */
export class SetupClosedError extends Error {
  constructor() {
    super("setup is closed");
  }
}

/** What the five steps were found to be by one round of reads. */
interface Reading {
  version: string | null;
  /** Steps 1–3: the first failing one's problem, or null when all pass. */
  blocker: { step: 0 | 1 | 2; problem: SetupProblem } | null;
  status: TailnetStatus | null;
  serving: SetupServing;
  /** The reads could not tell (a run failed or printed something unreadable): keep the last identity. */
  unsure: boolean;
  /** An exact handler was to be adopted as ours, but writing the record failed. */
  recordFailed?: boolean;
}

interface Record_ {
  v: 1;
  port: number;
  target: string;
  host: string;
  created_at: number;
}

const problem = (code: Code, message: string, extra: { fix?: string; url?: string } = {}): SetupProblem => ({ code, message, ...extra });

const TITLES = ["Tailscale installed", "Signed in to a tailnet", "HTTPS on the tailnet", "Share herdr on the tailnet", "Add your phone"] as const;

export class Setup {
  private readonly o: Required<Pick<SetupOptions, "port">> & SetupOptions;
  private readonly now: () => number;
  private identity: ServeIdentity | null = null;
  private current: SetupTopic;
  private actionProblem: SetupProblem | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Start, Stop and Check calls not yet answered (with their audit report): `close` waits for them. */
  private readonly ops = new Set<Promise<unknown>>();
  private busyCount = 0;
  private poked: number;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private last: Reading | null = null;

  constructor(opts: SetupOptions) {
    this.o = { port: DEFAULT_SERVE_PORT, ...opts };
    this.now = opts.now ?? Date.now;
    this.poked = this.now();
    this.current = this.build(null);
  }

  get state(): SetupTopic {
    return this.current;
  }

  /** The identity given to the bridge, or null. */
  get serve(): ServeIdentity | null {
    return this.identity;
  }

  /** Reads everything again ("Check now"). Rejects with {@link SetupClosedError} once closed. */
  check(): Promise<SetupTopic> {
    this.poked = this.now();
    // Resolves with the state once the check is no longer busy.
    return this.track(this.exclusive(() => this.read()).then(() => this.current));
  }

  /** Step 5 changed (a device was approved or revoked): recomputed without running tailscale. */
  refreshPhone(): void {
    this.publish();
  }

  /** "Start serving". Never changes a port that already has any handler. */
  start(): Promise<SetupResult> {
    this.poked = this.now();
    return this.audited("start", async () => {
      this.actionProblem = null;
      const r = await this.read();
      if (r.blocker) return this.fail(r.blocker.problem, false);
      if (r.serving === "ours" || r.serving === "identical") return { ok: true };
      if (r.serving === "foreign") return this.fail(this.portTaken(), false);
      if (r.serving === "funnel") return this.fail(this.funnelOn(), false);
      if (r.serving === "unknown") return this.fail(problem("unknown", "Could not read Tailscale's serve settings. Nothing was changed."), false);
      // r.serving === "off": the port is empty, so whatever appears there now is the handler we asked for.
      const res = await this.ts(["serve", "--bg", `--https=${this.o.port}`, serveTarget(this.o.apiPort)], this.o.serveTimeoutMs ?? SERVE_TIMEOUT_MS);
      // Adopt the handler only if our command can have made it: it succeeded, or it was cut off (it may have
      // applied the config first). After any other failure an exact handler is someone else's: never ours.
      const mayHaveApplied = (res.code === 0 && !res.error) || res.error === "timeout";
      const after = await this.read({ adoptIfExact: mayHaveApplied });
      if (after.serving === "ours") return { ok: true };
      // Served exactly as ours by our own command, but the record could not be written: it works, yet herdr
      // will never remove it (only a recorded handler is ours). Reported as `failed`, with the command that
      // stops it, so nobody is left with a serve config they think herdr will clean up.
      if (after.serving === "identical" && after.recordFailed)
        return this.fail(
          problem("failed", "herdr is served on the tailnet, but could not record that it set this up, so it will not stop serving by itself. To stop, run this in a terminal.", {
            fix: `tailscale serve --https=${this.o.port} off`,
          }),
          false,
        );
      return this.fail(this.trouble(res, "Tailscale did not serve herdr as expected. Nothing of yours was changed."), true);
    });
  }

  /** "Stop serving". Removes only the handler this bridge created. */
  stop(): Promise<SetupResult> {
    this.poked = this.now();
    return this.audited("stop", async () => {
      this.actionProblem = null;
      const r = await this.read();
      if (r.serving === "off") {
        await this.forget();
        return { ok: true };
      }
      if (r.serving !== "ours") {
        if (r.serving === "unknown") return this.fail(problem("unknown", "Could not read Tailscale's serve settings. Nothing was changed."), false);
        // Funnel on the port means the config was changed outside herdr: it is no longer ours to remove.
        return this.fail(r.serving === "funnel" ? this.funnelChanged() : this.notOurs(), false);
      }
      const res = await this.ts(["serve", `--https=${this.o.port}`, "off"], this.o.serveTimeoutMs ?? SERVE_TIMEOUT_MS);
      const after = await this.read();
      if (after.serving === "off") {
        await this.forget();
        this.publish();
        return { ok: true };
      }
      return this.fail(this.trouble(res, "Tailscale did not stop serving herdr."), true);
    });
  }

  /** Starts the periodic checks (the first one at once). */
  startTimer(): void {
    const tick = () => {
      if (this.closed) return;
      const fast = this.current.step <= 4 && this.now() - this.poked < FAST_WINDOW_MS;
      this.timer = setTimeout(() => void this.background().finally(tick), fast ? FAST_CHECK_MS : SLOW_CHECK_MS);
      this.timer.unref();
    };
    void this.background().finally(tick);
  }

  /** A periodic check: a failure (a throwing callback) must not become an unhandled rejection. */
  private background(): Promise<unknown> {
    return this.exclusive(() => this.read()).catch(() => undefined);
  }

  /**
   * Stops the periodic checks and refuses new operations. Resolves once the operation in flight (a Start or a
   * Stop may be mid-command) has finished, so the bridge never exits between a serve change and its record.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain;
    await Promise.allSettled([...this.ops]);
  }

  // ---- internals ----

  /** A Start or Stop, reported to `onAction` once it has an outcome (a throw counts as `failed`). */
  private track<T>(p: Promise<T>): Promise<T> {
    this.ops.add(p);
    const done = () => void this.ops.delete(p);
    p.then(done, done);
    return p;
  }

  private audited(op: SetupAction["op"], fn: () => Promise<SetupResult>): Promise<SetupResult> {
    return this.track(this.runAudited(op, fn));
  }

  private async runAudited(op: SetupAction["op"], fn: () => Promise<SetupResult>): Promise<SetupResult> {
    let res: SetupResult;
    try {
      res = await this.exclusive(fn);
    } catch (e) {
      if (e instanceof SetupClosedError) throw e; // never ran: nothing to audit
      this.report({ op, ok: false, code: "failed" });
      throw e;
    }
    this.report(res.ok ? { op, ok: true } : { op, ok: false, code: res.code });
    return res;
  }

  private report(a: SetupAction): void {
    try {
      this.o.onAction?.(a);
    } catch {
      // the audit hook must not turn a finished operation into a failure
    }
  }

  /** One operation at a time: a check never interleaves with a start or a stop. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SetupClosedError());
    this.busyCount += 1;
    this.publish();
    const p = this.chain.then(fn, fn);
    this.chain = p.then(
      () => {},
      () => {},
    );
    return p.finally(() => {
      this.busyCount -= 1;
      this.publish();
    });
  }

  private ts(args: string[], timeoutMs: number): Promise<RunResult> {
    return this.o.run(this.o.tailscale, args, { timeoutMs }).catch((): RunResult => ({ code: null, stdout: "", stderr: "", error: "other" }));
  }

  private fail(p: SetupProblem, keep: boolean): SetupResult {
    if (keep || p.code === "port_taken" || p.code === "funnel_on" || p.code === "not_ours") this.actionProblem = p;
    this.publish();
    return { ok: false, code: p.code, problem: p };
  }

  private portTaken = () =>
    problem("port_taken", `Port ${this.o.port} already has a tailscale serve handler that herdr did not create. herdr will not change it.`);
  private funnelOn = () => problem("funnel_on", `Funnel is on for port ${this.o.port}. herdr never serves through Funnel, so it will not start while Funnel is on.`);
  private funnelChanged = () =>
    problem("funnel_on", `Funnel is on for port ${this.o.port}: the handler was changed outside herdr, so herdr will not remove it.`, {
      fix: `tailscale serve --https=${this.o.port} off`,
    });
  private notOurs = () =>
    problem("not_ours", `The handler on port ${this.o.port} was not created by herdr, so herdr will not remove it.`, {
      fix: `tailscale serve --https=${this.o.port} off`,
    });

  private trouble(res: RunResult, otherwise: string): SetupProblem {
    if (res.error === "ENOENT") return problem("not_installed", "Tailscale is not installed on this computer.");
    const t = classifyTrouble(`${res.stdout}\n${res.stderr}`);
    if (t.kind === "operator")
      return problem("operator", "Tailscale lets only its operator change serve settings. Run this once in a terminal, then try again.", { fix: OPERATOR_FIX });
    if (t.kind === "serve_disabled")
      return problem("serve_disabled", "Serve is not enabled for this tailnet. Enable it in the Tailscale admin, then try again.", { url: t.url ?? ADMIN });
    if (t.kind === "https_off") return this.httpsOff();
    if (t.kind === "daemon_down") return problem("daemon_down", "The Tailscale service is not running on this computer.");
    return problem("failed", otherwise);
  }

  private httpsOff = () =>
    problem("https_off", "HTTPS certificates are off for this tailnet. The phone app needs them to install and get notifications.", { url: ADMIN_DNS });

  private async readRecord(): Promise<Record_ | null> {
    try {
      const r = JSON.parse(await readFile(join(this.o.dataDir, SERVE_RECORD), "utf8")) as Partial<Record_>;
      if (r.v === 1 && typeof r.port === "number" && typeof r.target === "string" && typeof r.host === "string") return r as Record_;
    } catch {
      // none, or unreadable: we did not (provably) create anything
    }
    return null;
  }

  private async remember(host: string): Promise<void> {
    await mkdir(this.o.dataDir, { recursive: true, mode: 0o700 });
    const p = join(this.o.dataDir, SERVE_RECORD);
    const tmp = `${p}.${process.pid}.tmp`;
    const rec: Record_ = { v: 1, port: this.o.port, target: serveTarget(this.o.apiPort), host, created_at: this.now() };
    await writeFile(tmp, JSON.stringify(rec) + "\n", { mode: 0o600 });
    await rename(tmp, p);
  }

  private async forget(): Promise<void> {
    await rm(join(this.o.dataDir, SERVE_RECORD), { force: true });
  }

  private hostFor(dns: string): string {
    return this.o.port === 443 ? dns : `${dns}:${this.o.port}`;
  }

  /** One round of reads; updates identity and state. `adoptIfExact` records an exact handler as ours (after start). */
  private async read(opts: { adoptIfExact?: boolean } = {}): Promise<Reading> {
    const r = await this.gather();
    if (r.serving === "identical" && opts.adoptIfExact && r.status?.dnsName) {
      try {
        await this.remember(this.hostFor(r.status.dnsName));
        r.serving = "ours";
      } catch {
        // Not recorded: it stays `identical`, so it is used but never removed by us. The safe direction.
        r.recordFailed = true;
      }
    }
    // Our record means "created by us, unchanged since". Once the port reads empty or different, it means nothing:
    // a handler that later reads exact again was put there by someone else, and is never removed by us.
    if (r.serving === "off" || r.serving === "foreign" || r.serving === "funnel") await this.forget().catch(() => {});
    this.last = r;
    if (r.serving === "ours" || r.serving === "identical") this.actionProblem = null;
    if (r.serving === "funnel") this.o.onFunnel?.();
    this.decideIdentity(r);
    this.publish();
    return r;
  }

  private async gather(): Promise<Reading> {
    const out: Reading = { version: null, blocker: null, status: null, serving: "unknown", unsure: false };
    const v = await this.ts(["version"], READ_TIMEOUT_MS);
    if (v.error === "ENOENT") {
      out.blocker = { step: 0, problem: problem("not_installed", "Tailscale is not installed on this computer.") };
      return out;
    }
    const version = v.code === 0 && !v.error ? parseVersion(v.stdout) : undefined;
    if (!version) {
      out.unsure = true;
      out.blocker = { step: 0, problem: problem("unknown", "Could not run tailscale. Checking again…") };
      return out;
    }
    out.version = version;
    if (versionBelow(version, MIN_TAILSCALE)) {
      out.blocker = { step: 0, problem: problem("too_old", `Tailscale ${version} is too old. Update it to ${MIN_TAILSCALE} or newer.`) };
      return out;
    }

    const s = await this.ts(["status", "--json"], READ_TIMEOUT_MS);
    let status: TailnetStatus | undefined;
    if (s.code === 0 && !s.error) {
      try {
        status = parseStatus(JSON.parse(s.stdout));
      } catch {
        status = undefined;
      }
    }
    if (!status) {
      // `status` exits non-zero when the daemon is down; anything else proves nothing.
      if (!s.error && classifyTrouble(`${s.stdout}\n${s.stderr}`).kind === "daemon_down") {
        out.blocker = { step: 1, problem: problem("daemon_down", "The Tailscale service is not running on this computer.") };
      } else {
        out.unsure = true;
        out.blocker = { step: 1, problem: problem("unknown", "Could not read Tailscale's state. Checking again…") };
      }
      return out;
    }
    out.status = status;
    if (status.backend === "NeedsLogin" || status.backend === "NeedsMachineAuth") {
      out.blocker = { step: 1, problem: problem("needs_login", "This computer is not signed in to Tailscale.", { fix: "tailscale up" }) };
      return out;
    }
    if (status.backend === "Stopped") {
      out.blocker = { step: 1, problem: problem("stopped", "Tailscale is turned off on this computer.", { fix: "tailscale up" }) };
      return out;
    }
    if (status.backend !== "Running") {
      out.unsure = true;
      out.blocker = { step: 1, problem: problem("unknown", "Tailscale is starting. Checking again…") };
      return out;
    }
    if (status.tagged) {
      out.blocker = {
        step: 1,
        problem: problem("tagged", "This computer is a tagged device. Phones pair only with a computer signed in as a person."),
      };
      return out;
    }
    if (!status.login) {
      out.unsure = true;
      out.blocker = { step: 1, problem: problem("unknown", "Could not tell who owns this computer on the tailnet. Checking again…") };
      return out;
    }
    if (!status.magicDns || !status.dnsName) {
      out.blocker = { step: 2, problem: problem("magicdns_off", "MagicDNS is off for this tailnet. Turn on MagicDNS and HTTPS Certificates there.", { url: ADMIN_DNS }) };
      return out;
    }
    if (!status.https) {
      out.blocker = { step: 2, problem: this.httpsOff() };
      return out;
    }

    const ss = await this.ts(["serve", "status", "--json"], READ_TIMEOUT_MS);
    const parsed = ss.code === 0 && !ss.error ? parseServeStatus(ss.stdout) : { ok: false as const };
    const use = parsed.ok ? portUse(parsed.doc, { port: this.o.port, apiPort: this.o.apiPort, dnsName: status.dnsName }) : undefined;
    if (use === undefined) {
      out.unsure = true;
      out.serving = "unknown";
      return out;
    }
    if (use === "exact") {
      const rec = await this.readRecord();
      const mine = rec !== null && rec.port === this.o.port && rec.target === serveTarget(this.o.apiPort) && rec.host === this.hostFor(status.dnsName);
      out.serving = mine ? "ours" : "identical";
    } else out.serving = use;
    return out;
  }

  /**
   * Clearing the identity drops every phone with 4001 and makes `/api/v1/me` answer 403, which the PWA takes as
   * final ("no longer accepts this phone"). So it is cleared only on proof that the phones' access is gone for
   * good: the port is empty or someone else's, the node became tagged, or its owner changed (then replaced).
   * States in which serve can't deliver a request anyway, or that another guard already refuses, keep it:
   * tailscaled down or stopped, signed out, MagicDNS/HTTPS off, and Funnel (the Funnel guard answers 503 and
   * closes with 4004; see `onFunnel`). A read that can't tell keeps it too.
   */
  private decideIdentity(r: Reading): void {
    let next: ServeIdentity | null;
    if (r.unsure) return; // proves nothing: keep what we had
    const login = r.status?.login ?? null;
    if ((r.serving === "ours" || r.serving === "identical") && r.status?.dnsName && login && !r.blocker) {
      next = { host: this.hostFor(r.status.dnsName), login };
    } else if (r.blocker?.problem.code === "tagged") {
      next = null;
    } else if (r.blocker || r.serving === "funnel") {
      // Keep, unless the owner is proven to be someone else now.
      if (!this.identity || !login || login === this.identity.login) return;
      next = null;
    } else next = null; // off or foreign
    const same = next === this.identity || (next !== null && this.identity !== null && next.host === this.identity.host && next.login === this.identity.login);
    if (same) return;
    this.identity = next;
    this.o.onIdentity(next);
  }

  private publish(): void {
    const next = this.build(this.last);
    this.current = next;
    this.o.onState?.(next);
  }

  private build(r: Reading | null): SetupTopic {
    const s = r?.status ?? null;
    const done: boolean[] = [false, false, false, false, false];
    const probs: (SetupProblem | undefined)[] = [undefined, undefined, undefined, undefined, undefined];
    const details: string[] = [
      r?.version ? `Found tailscale ${r.version} on this computer` : "Checks that tailscale is installed on this computer",
      s?.tailnet && s.hostName ? `${s.tailnet} · this computer is ${s.hostName}` : "This computer must be signed in to your tailnet",
      "Needed for the Home Screen app and push",
      "Runs tailscale serve for the bridge. Only devices on your tailnet can reach it.",
      "Install Tailscale on the phone and sign in to the same tailnet, then scan the QR code.",
    ];
    if (r) {
      const b = r.blocker;
      for (let i = 0; i < 3; i++) done[i] = !b || b.step > i;
      if (b) probs[b.step] = b.problem;
      else {
        const serving = r.serving === "ours" || r.serving === "identical";
        done[3] = serving && this.identity !== null;
        if (serving && s?.dnsName) details[3] = `Served at https://${this.hostFor(s.dnsName)}`;
        if (!done[3]) {
          probs[3] =
            this.actionProblem ??
            (r.serving === "foreign"
              ? this.portTaken()
              : r.serving === "funnel"
                ? this.funnelOn()
                : r.serving === "unknown"
                  ? problem("unknown", "Could not read Tailscale's serve settings. Checking again…")
                  : undefined);
        } else if (r.serving === "identical") details[3] += " (set up outside herdr)";
        done[4] = done[3] && this.o.hasPhone();
        if (done[3] && !done[4]) probs[4] = problem("no_device", "No phone is paired yet.");
        if (done[4]) details[4] = "A phone is paired";
      }
    }
    // A step counts as done only after every step before it.
    let first = 5;
    for (let i = 0; i < 5; i++)
      if (!done[i]) {
        first = i;
        break;
      }
    const steps: SetupStep[] = TITLES.map((title, i) => ({
      id: bridgeApi.SETUP_STEPS[i]!,
      state: i < first ? "done" : i === first ? "current" : "todo",
      title,
      detail: details[i]!,
      ...(i === first && probs[i] ? { problem: probs[i] } : {}),
    }));
    const busy = this.busyCount > 0;
    const serving: SetupServing = r ? (r.blocker ? "unknown" : r.serving) : "unknown";
    return {
      step: first + 1,
      steps,
      serving,
      port: this.o.port,
      url: this.identity ? `https://${this.identity.host}/` : null,
      login: this.identity?.login ?? null,
      can_start: !busy && r !== null && !r.blocker && r.serving === "off",
      can_stop: !busy && r !== null && r.serving === "ours",
      busy,
      checked_at: r ? this.now() : null,
    };
  }
}
