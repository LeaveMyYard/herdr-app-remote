// The pairing screen's logic (S5b, board PhonePair), apart from React so it can be tested step by step.
//
// - `/pair#c=<code>`: Safari after scanning the desktop's QR code. Posts the code, waits for the desktop to approve,
//   then opens the app (and asks once to add it to the Home Screen).
// - `/pair#t=<code>`: the Home Screen app's first launch. iOS keeps its cookies apart from Safari's, so it spends
//   the one-time transfer code its manifest carried and gets its own token for the device Safari paired. Every
//   later cold launch opens the same URL with a spent code: it finds itself paired and goes straight in.
//
// The code is taken out of the address bar at once. Nothing here retries a code by itself.

export type PairState = "check" | "wait" | "ok" | "bad" | "first";

export interface PairView {
  state: PairState;
  /** The device's name as the desktop shows it ("Phone 1"), once the bridge said it. */
  name?: string;
  /** `bad` for a transfer code, which needs other steps than a QR code. */
  transfer?: boolean;
}

/** What a request to the bridge came back with; null status is a network failure. */
export interface Reply {
  status: number | null;
  device?: { name: string; state: string } | undefined;
}

export interface PairApi {
  me(): Promise<Reply>;
  pair(code: string): Promise<Reply>;
  transfer(code: string): Promise<Reply>;
}

export const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
/** How often the waiting screen asks whether the desktop approved. */
export const WAIT_POLL_MS = 2000;
/** The approved screen opens the app by itself after this long ("Opening Herdr…"). */
export const OPEN_AFTER_MS = 2500;

/** `#c=<code>` or `#t=<code>` from the URL fragment; anything else is null. */
export function parseFragment(hash: string): { kind: "c" | "t"; code: string } | null {
  const m = /^#([ct])=([^&]*)$/.exec(hash);
  if (!m || !CODE_RE.test(m[2]!)) return null;
  return { kind: m[1] as "c" | "t", code: m[2]! };
}

function deviceOf(body: unknown): Reply["device"] {
  const d = body !== null && typeof body === "object" ? (body as { device?: unknown }).device : undefined;
  if (d === null || typeof d !== "object") return undefined;
  const { name, state } = d as { name?: unknown; state?: unknown };
  return typeof name === "string" && typeof state === "string" ? { name, state } : undefined;
}

async function call(path: string, init?: RequestInit): Promise<Reply> {
  try {
    const r = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, device: deviceOf(body) };
  } catch {
    return { status: null };
  }
}

const post = (path: string, code: string) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Remote-Api": "1" }, body: JSON.stringify({ code }) });

/** The bridge, over fetch. The cookie is HttpOnly: the page never sees a token. */
export const fetchApi: PairApi = {
  me: () => call("/api/v1/me"),
  // No name is sent: the desktop names the phone itself ("Phone 1"), and its toast never shows a phone-chosen name.
  pair: (code) => post("/api/v1/pair", code),
  transfer: (code) => post("/api/v1/pair/transfer", code),
};

export interface FlowEnv {
  api: PairApi;
  /** Shows a state. */
  show(v: PairView): void;
  /** Leaves the pairing screen for the app. */
  open(): void;
  /** Safari only: ask (once) to add the app to the Home Screen. */
  offerHomeScreen(): void;
  sleep(ms: number): Promise<void>;
  /** False once the screen is gone: the flow stops. */
  alive(): boolean;
}

const approved = (r: Reply) => r.status === 200 && r.device?.state === "approved";

/** Runs the flow for a fragment until it settles on `ok`, `bad` or opens the app. */
export async function runPairing(frag: ReturnType<typeof parseFragment>, env: FlowEnv): Promise<void> {
  if (!frag) return env.show({ state: "bad" });
  if (frag.kind === "t") return transferFlow(frag.code, env);
  env.show({ state: "check" });
  // Already paired in this browser (a second scan): don't spend the code on a new device.
  const before = await env.api.me();
  if (!env.alive()) return;
  if (approved(before)) return env.open();
  let name: string;
  if (before.status === 200 && before.device?.state === "pending") {
    name = before.device.name;
  } else {
    const r = await env.api.pair(frag.code);
    if (!env.alive()) return;
    if (r.status !== 202 || !r.device) return env.show({ state: "bad" });
    name = r.device.name;
  }
  env.show({ state: "wait", name });
  for (;;) {
    await env.sleep(WAIT_POLL_MS);
    if (!env.alive()) return;
    const r = await env.api.me();
    if (!env.alive()) return;
    if (approved(r)) break;
    // Refused on the desktop, or the request ran out (10 minutes): the cookie names nothing now.
    if (r.status === 401 || r.status === 403) return env.show({ state: "bad" });
    // Still pending, or a network blip: keep waiting.
  }
  env.offerHomeScreen();
  env.show({ state: "ok", name });
  await env.sleep(OPEN_AFTER_MS);
  if (env.alive()) env.open();
}

async function transferFlow(code: string, env: FlowEnv): Promise<void> {
  env.show({ state: "first" });
  // A later launch of an app that is set up already: its start URL still names the spent code.
  const before = await env.api.me();
  if (!env.alive()) return;
  if (approved(before)) return env.open();
  const r = await env.api.transfer(code);
  if (!env.alive()) return;
  if (r.status === 200) return env.open();
  env.show({ state: "bad", transfer: true });
}

// ---- the Home Screen prompt (Safari only) ----

const PROMPT_KEY = "herdr.homePrompt";

/** Installed to the Home Screen (iOS sets `navigator.standalone`; others match the display mode). */
export function isStandalone(win: Window = window): boolean {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches);
}

/** Whether the prompt should show now: set after pairing in Safari and by the bell, cleared by "Not now". */
export function promptWanted(store: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return store?.getItem(PROMPT_KEY) === "show";
  } catch {
    return false;
  }
}

export function setPromptWanted(on: boolean, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    store?.setItem(PROMPT_KEY, on ? "show" : "dismissed");
  } catch {
    // Private mode or blocked storage: the prompt just doesn't remember.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Makes the browser read the manifest again: the bridge now puts this device's transfer code in its `start_url`.
 * The link asks for credentials, so the request carries the (SameSite=Strict, HttpOnly) device cookie. The `v`
 * query only defeats caches; it is not a secret.
 */
export function refreshManifest(doc: Document = document, now: () => number = Date.now): void {
  const old = doc.querySelector('link[rel="manifest"]');
  const link = doc.createElement("link");
  link.rel = "manifest";
  link.crossOrigin = "use-credentials";
  link.href = `./manifest.webmanifest?v=${now().toString(36)}`;
  if (old) old.replaceWith(link);
  else doc.head.appendChild(link);
}
