// S5b: the pairing screen (board PhonePair), the Home Screen prompt and the transfer flow. Fake data only.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge/client";
import { LiveApp } from "../src/LiveApp";
import {
  OPEN_AFTER_MS,
  parseFragment,
  promptWanted,
  refreshManifest,
  runPairing,
  setPromptWanted,
  WAIT_POLL_MS,
  type FlowEnv,
  type PairApi,
  type PairView,
  type Reply,
} from "../src/pair/flow";
import { PairPage, PairScreen } from "../src/pair/PairScreen";
import { FakeSocket } from "./fake-socket";

const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const pending = (name = "Phone 1"): Reply => ({ status: 200, device: { name, state: "pending" } });
const approvedR = (name = "Phone 1"): Reply => ({ status: 200, device: { name, state: "approved" } });

/** A scripted bridge: each call takes the next reply of its queue (the last one repeats). */
function fakeApi(script: { me?: Reply[]; pair?: Reply[]; transfer?: Reply[] }) {
  const calls: string[] = [];
  const take = (q: Reply[] | undefined, fallback: Reply) => (q && q.length > 1 ? q.shift()! : (q?.[0] ?? fallback));
  const api: PairApi = {
    me: async () => (calls.push("me"), take(script.me, { status: 401 })),
    pair: async (c) => (calls.push(`pair:${c}`), take(script.pair, { status: 403 })),
    transfer: async (c) => (calls.push(`transfer:${c}`), take(script.transfer, { status: 403 })),
  };
  return { api, calls };
}

function env(api: PairApi) {
  const shown: PairView[] = [];
  const e: FlowEnv & { shown: PairView[]; opened: number; offered: number; slept: number[] } = {
    api,
    shown,
    opened: 0,
    offered: 0,
    slept: [],
    show: (v) => shown.push(v),
    open: () => void (e.opened += 1),
    offerHomeScreen: () => void (e.offered += 1),
    sleep: async (ms) => void e.slept.push(ms),
    alive: () => true,
  };
  return e;
}

describe("parseFragment", () => {
  it("reads #c= and #t= with a 22-character code only", () => {
    expect(parseFragment(`#c=${CODE}`)).toEqual({ kind: "c", code: CODE });
    expect(parseFragment(`#t=${CODE}`)).toEqual({ kind: "t", code: CODE });
    for (const bad of ["", "#", `#x=${CODE}`, `#c=${CODE}x`, "#c=short", `#c=${CODE}&t=${CODE}`, `#/agents`, `#c=${"!".repeat(22)}`]) expect(parseFragment(bad)).toBeNull();
  });
});

describe("Safari: /pair#c=<code>", () => {
  it("checks, waits for approval with the desktop's name for it, then shows paired, offers the Home Screen and opens", async () => {
    const { api, calls } = fakeApi({ me: [{ status: 401 }, pending(), pending(), approvedR()], pair: [{ status: 202, device: { name: "Phone 1", state: "pending" } }] });
    const e = env(api);
    await runPairing(parseFragment(`#c=${CODE}`), e);
    expect(e.shown.map((v) => v.state)).toEqual(["check", "wait", "ok"]);
    expect(e.shown[1]).toEqual({ state: "wait", name: "Phone 1" });
    expect(e.shown[2]).toEqual({ state: "ok", name: "Phone 1" });
    expect(calls).toEqual(["me", `pair:${CODE}`, "me", "me", "me"]);
    expect(e.slept).toEqual([WAIT_POLL_MS, WAIT_POLL_MS, WAIT_POLL_MS, OPEN_AFTER_MS]);
    expect(e.offered).toBe(1);
    expect(e.opened).toBe(1);
  });

  it("a code that doesn't work shows the expired state and never opens", async () => {
    for (const r of [{ status: 403 }, { status: 429 }, { status: null }, { status: 202 }] as Reply[]) {
      const { api } = fakeApi({ pair: [r] });
      const e = env(api);
      await runPairing(parseFragment(`#c=${CODE}`), e);
      expect(e.shown.at(-1)).toEqual({ state: "bad" });
      expect(e.opened).toBe(0);
      expect(e.offered).toBe(0);
    }
  });

  it("refused or expired on the desktop while waiting: the expired state", async () => {
    const { api } = fakeApi({ me: [{ status: 401 }, pending(), { status: null }, { status: 401 }], pair: [{ status: 202, device: { name: "Phone 2", state: "pending" } }] });
    const e = env(api);
    await runPairing(parseFragment(`#c=${CODE}`), e);
    expect(e.shown.map((v) => v.state)).toEqual(["check", "wait", "bad"]);
    expect(e.opened).toBe(0);
  });

  it("already approved in this browser: opens the app without spending the code", async () => {
    const { api, calls } = fakeApi({ me: [approvedR()] });
    const e = env(api);
    await runPairing(parseFragment(`#c=${CODE}`), e);
    expect(calls).toEqual(["me"]);
    expect(e.opened).toBe(1);
    expect(e.offered).toBe(0);
  });

  it("a request already pending (a reload): waits again without posting the code", async () => {
    const { api, calls } = fakeApi({ me: [pending("Phone 3"), approvedR("Phone 3")] });
    const e = env(api);
    await runPairing(parseFragment(`#c=${CODE}`), e);
    expect(calls.some((c) => c.startsWith("pair:"))).toBe(false);
    expect(e.shown.map((v) => v.state)).toEqual(["check", "wait", "ok"]);
  });

  it("no code in the URL: the expired state", async () => {
    const { api, calls } = fakeApi({});
    const e = env(api);
    await runPairing(parseFragment(""), e);
    expect(e.shown).toEqual([{ state: "bad" }]);
    expect(calls).toEqual([]);
  });

  it("stops when the screen is gone", async () => {
    const { api, calls } = fakeApi({ me: [{ status: 401 }, pending()], pair: [{ status: 202, device: { name: "Phone 1", state: "pending" } }] });
    const e = env(api);
    let polls = 0;
    e.alive = () => polls < 3;
    e.sleep = async () => void (polls += 1);
    await runPairing(parseFragment(`#c=${CODE}`), e);
    expect(calls.filter((c) => c === "me").length).toBeLessThanOrEqual(3);
    expect(e.opened).toBe(0);
  });
});

describe("Home Screen app: /pair#t=<code>", () => {
  it("first launch: finishing setup, spends the transfer code, opens; never offers the Home Screen", async () => {
    const { api, calls } = fakeApi({ me: [{ status: 401 }], transfer: [approvedR()] });
    const e = env(api);
    await runPairing(parseFragment(`#t=${CODE}`), e);
    expect(e.shown).toEqual([{ state: "first" }]);
    expect(calls).toEqual(["me", `transfer:${CODE}`]);
    expect(e.opened).toBe(1);
    expect(e.offered).toBe(0);
  });

  it("a later launch (the start URL still names the spent code): already paired, nothing is posted", async () => {
    const { api, calls } = fakeApi({ me: [approvedR()] });
    const e = env(api);
    await runPairing(parseFragment(`#t=${CODE}`), e);
    expect(calls).toEqual(["me"]);
    expect(e.opened).toBe(1);
  });

  it("a spent or expired transfer code: the transfer variant of the expired state", async () => {
    const { api } = fakeApi({ me: [{ status: 401 }], transfer: [{ status: 403 }] });
    const e = env(api);
    await runPairing(parseFragment(`#t=${CODE}`), e);
    expect(e.shown.at(-1)).toEqual({ state: "bad", transfer: true });
    expect(e.opened).toBe(0);
  });
});

describe("PairPage (board copy)", () => {
  const host = "desk-1";
  it.each([
    ["check", { state: "check" }, ["Checking the code…", "Pairing this phone with desk-1."]],
    ["wait", { state: "wait", name: "Phone 1" }, ["Approve on your computer", "desk-1 is asking whether to let this phone in. Approve it there to finish.", "Shows as", "Phone 1", "Computer", "Waiting for approval…", "The request ends after 10 minutes if no one approves it."]],
    ["ok", { state: "ok", name: "Phone 1" }, ["Phone 1 is paired", "desk-1 approved this phone. You can remove it any time in Remote on the computer.", "Opening Herdr…", "Continue"]],
    ["bad", { state: "bad" }, ["This code no longer works", "Each code works once, for 5 minutes.", "On desk-1, open Remote › Devices for a fresh code.", "Scan it with the iPhone Camera."]],
    ["first", { state: "first" }, ["Finishing setup on this phone…", "Using the pairing from Safari. No need to approve again."]],
  ] as [string, PairView, string[]][])("%s", (_n, view, texts) => {
    const { container } = render(<PairPage view={view} host={host} />);
    for (const t of texts) expect(container).toHaveTextContent(t);
  });

  it("Continue opens the app", async () => {
    const onContinue = vi.fn();
    render(<PairPage view={{ state: "ok", name: "Phone 1" }} host="desk-1" onContinue={onContinue} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("PairScreen", () => {
  beforeEach(() => window.history.replaceState(null, "", `/pair#c=${CODE}`));
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("takes the code out of the address bar at once and posts it exactly once, even under StrictMode", async () => {
    const { api, calls } = fakeApi({ me: [{ status: 401 }], pair: [{ status: 403 }] });
    render(
      <StrictMode>
        <PairScreen host="desk-1" hash={`#c=${CODE}`} api={api} open={() => undefined} sleep={async () => undefined} standalone={() => false} />
      </StrictMode>,
    );
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/pair");
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(calls.filter((c) => c.startsWith("pair:"))).toEqual([`pair:${CODE}`]);
    expect(await screen.findByText("This code no longer works")).toBeInTheDocument();
  });

  it("asks for the Home Screen prompt after pairing in Safari, not in the installed app", async () => {
    for (const standalone of [false, true]) {
      localStorage.clear();
      const { api } = fakeApi({ me: [{ status: 401 }, approvedR()], pair: [{ status: 202, device: { name: "Phone 1", state: "pending" } }] });
      const open = vi.fn();
      const r = render(<PairScreen host="desk-1" hash={`#c=${CODE}`} api={api} open={open} sleep={async () => undefined} standalone={() => standalone} />);
      await vi.waitFor(() => expect(open).toHaveBeenCalled());
      expect(promptWanted()).toBe(!standalone);
      r.unmount();
    }
  });
});

describe("refreshManifest", () => {
  it("replaces the manifest link with a credentialed one and a cache-busting query", () => {
    document.head.innerHTML = '<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials">';
    refreshManifest(document, () => 123456);
    const links = document.head.querySelectorAll('link[rel="manifest"]');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe(`./manifest.webmanifest?v=${(123456).toString(36)}`);
    expect(links[0]!.getAttribute("crossorigin")).toBe("use-credentials");
  });

  it("index.html asks for the manifest with credentials (the cookie picks this device's manifest)", () => {
    const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");
    expect(html).toMatch(/<link rel="manifest" href="\.\/manifest\.webmanifest" crossorigin="use-credentials" \/>/);
  });
});

// ---- the prompt inside the live app ----

const HOST = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/host/typical.json"), "utf8")) as unknown;

describe("Home Screen prompt in the live app", () => {
  let sockets: FakeSocket[];
  let client: BridgeClient;
  let manifests: number;

  async function mount(standalone = false) {
    sockets = [];
    manifests = 0;
    window.location.hash = "#/agents";
    client = new BridgeClient({
      url: "wss://desk-1.example-tailnet.ts.net/api/v1/ws",
      openSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        sockets.push(s);
        return s;
      },
      checkMe: async () => 200,
    });
    client.start();
    render(<LiveApp client={client} hostName="desk-1" readTerminalInput={async () => null} standalone={standalone} onManifest={() => void (manifests += 1)} />);
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const s = sockets.at(-1)!;
    await act(async () => {
      s.open();
      s.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
      s.recv({ type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
    });
    return s;
  }
  const transfers = (s: FakeSocket) => s.ofType("act").filter((m) => m.kind === "pair.transfer");
  const answer = async (s: FakeSocket, ok = true) => {
    const id = transfers(s).at(-1)!.id;
    await act(async () => s.recv({ type: "res", id, ok, ...(ok ? {} : { code: "forbidden" }) }));
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => client.stop());

  it("shows after pairing in Safari, mints a transfer code over the socket, then has the browser read the manifest again", async () => {
    setPromptWanted(true);
    const s = await mount();
    expect(screen.getByRole("region", { name: "Get notifications" })).toHaveTextContent("Get notifications on this phone");
    expect(transfers(s)).toHaveLength(1);
    expect(transfers(s)[0]!.args).toEqual({});
    expect(manifests).toBe(0);
    await answer(s);
    expect(manifests).toBe(1);
  });

  it("a refused mint leaves the manifest alone", async () => {
    setPromptWanted(true);
    const s = await mount();
    await answer(s, false);
    expect(manifests).toBe(0);
  });

  it("Not now and Close hide it and remember; the bell opens it again and mints a fresh code", async () => {
    setPromptWanted(true);
    const s = await mount();
    await answer(s);
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Get notifications" })).toBeNull();
    expect(promptWanted()).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("region", { name: "Get notifications" })).toBeInTheDocument();
    expect(promptWanted()).toBe(true);
    expect(transfers(s)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Get notifications" })).toBeNull();
  });

  it("not asked for: the bell shows, the prompt doesn't, and nothing is minted", async () => {
    const s = await mount();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Get notifications" })).toBeNull();
    expect(transfers(s)).toHaveLength(0);
  });

  it("in the installed app: no bell, no prompt, no mint", async () => {
    setPromptWanted(true);
    const s = await mount(true);
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Get notifications" })).toBeNull();
    expect(transfers(s)).toHaveLength(0);
  });
});
