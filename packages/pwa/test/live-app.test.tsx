import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge/client";
import type { TerminalInputView } from "../src/bridge/me";
import { hostNameFrom, LiveApp } from "../src/LiveApp";
import { forgetConfirmations } from "../src/screens/ChatComposer";
import { demoUsage } from "../src/usage-fixtures";
import { FakeSocket } from "./fake-socket";

// Fake data only.
const HOST = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/host/typical.json"), "utf8")) as unknown;
const PLUGINS = {
  panorama: { state: "not_running" },
  inbox: { state: "ready" },
  usage: { state: "ready" },
  hc: { state: "ready" },
  host: { state: "ready" },
};

let sockets: FakeSocket[];
let me: number;
let client: BridgeClient;

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

let terminalInput: TerminalInputView | null;
let meReads: number;
async function mount(hash = "#/agents") {
  window.location.hash = hash;
  client = new BridgeClient({
    url: "wss://desk-1.example-tailnet.ts.net/api/v1/ws",
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    checkMe: async () => me,
  });
  client.start();
  render(
    <LiveApp
      client={client}
      hostName="desk-1"
      readTerminalInput={async () => {
        meReads += 1;
        return terminalInput;
      }}
    />,
  );
  await flush();
}

async function greet(): Promise<FakeSocket> {
  const s = sockets.at(-1)!;
  await act(async () => {
    s.open();
    s.recv({ type: "welcome", api: 1, bridge: "0.0.0", epoch: "e1" });
  });
  return s;
}

const recv = (s: FakeSocket, m: unknown) => act(async () => s.recv(m));
const subs = (s: FakeSocket) => s.ofType("sub").flatMap((m) => m.topics as string[]);

beforeEach(() => {
  sockets = [];
  me = 200;
  terminalInput = { enabled: false, until: null };
  meReads = 0;
  forgetConfirmations();
});
afterEach(() => {
  client.stop();
  window.location.hash = "";
});

describe("LiveApp", () => {
  it("subscribes host, plugins and panorama, and shows connecting until the first host snap", async () => {
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to your computer");
    const s = await greet();
    expect(subs(s)).toEqual(["host", "plugins", "panorama", "inbox"]);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to your computer");
    await recv(s, { type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Agent 1")).toBeInTheDocument();
    expect(screen.getByText("Agent 2")).toBeInTheDocument();
  });

  it("follows patches and shows the host topic's stale reason", async () => {
    await mount();
    const s = await greet();
    await recv(s, { type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
    await recv(s, { type: "patch", topic: "host", seq: 2, ops: [{ op: "replace", path: "/agents/0/name", value: "Agent 9" }] });
    expect(screen.getByText("Agent 9")).toBeInTheDocument();
    await recv(s, { type: "stale", topic: "host", reason: "layout_without_remote" });
    expect(screen.getByRole("status")).toHaveTextContent("Switch to a layout with Remote");
    expect(screen.getByText("Agent 9")).toBeInTheDocument();
  });

  it("says when the phone isn't paired, and opens no socket", async () => {
    me = 401;
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("isn't paired");
    expect(sockets).toEqual([]);
  });

  it("asks for usage only once the Usage tab opens, and changes the filter only when the bridge says so", async () => {
    await mount();
    const s = await greet();
    await recv(s, { type: "snap", topic: "plugins", epoch: "e1", seq: 1, data: PLUGINS });
    expect(subs(s)).not.toContain("usage");
    await act(async () => {
      window.location.hash = "#/usage";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(subs(s)).toContain("usage");
    await recv(s, { type: "snap", topic: "usage", epoch: "e1", seq: 1, data: { ...demoUsage, filter: "open-panes" } });
    const all = screen.getByRole("button", { name: "All" });
    expect(all).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(all);
    expect(s.ofType("act").at(-1)).toMatchObject({ kind: "usage.set_filter", args: { filter: "all" } });
    // No optimistic UI: still Open panes until the patch arrives.
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
    await recv(s, { type: "patch", topic: "usage", seq: 2, ops: [{ op: "replace", path: "/filter", value: "all" }] });
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the Missing screen when the plugins topic says agent-usage is missing", async () => {
    await mount("#/usage");
    const s = await greet();
    await recv(s, { type: "snap", topic: "plugins", epoch: "e1", seq: 1, data: { ...PLUGINS, usage: { state: "missing" } } });
    expect(screen.getAllByText(/agent-usage/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
  });

  it("reads an open chat through chat:<terminal>", async () => {
    await mount();
    const s = await greet();
    await recv(s, { type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
    expect(subs(s).some((t) => t.startsWith("chat:"))).toBe(false);
    await act(async () => {
      window.location.hash = "#/chat/agent-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(subs(s)).toContain("chat:term-2");
  });
});

describe("LiveApp terminal input", () => {
  const openChat = async () => {
    await mount();
    const s = await greet();
    await recv(s, { type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
    await act(async () => {
      window.location.hash = "#/chat/agent-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();
    return s;
  };

  it("reads /api/v1/me only while a chat is open, and stays read-only while terminal.input is off", async () => {
    await mount();
    const s = await greet();
    await recv(s, { type: "snap", topic: "host", epoch: "e1", seq: 1, data: HOST });
    expect(meReads).toBe(0);
    await act(async () => {
      window.location.hash = "#/chat/agent-2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await flush();
    expect(meReads).toBe(1);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("sends terminal.send to the chat's terminal, and reads me again when the bridge says forbidden", async () => {
    terminalInput = { enabled: true, until: null };
    const s = await openChat();
    await userEvent.type(screen.getByRole("textbox", { name: "Message to the agent" }), "run the tests");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const dlg = screen.getByRole("alertdialog");
    await userEvent.click([...dlg.querySelectorAll("button")].find((b) => b.textContent === "Send")!);
    const sent = s.ofType("act").at(-1)!;
    expect(sent).toMatchObject({ kind: "terminal.send", args: { terminal: "term-2", text: "run the tests" } });
    const reads = meReads;
    terminalInput = { enabled: false, until: null };
    await recv(s, { type: "res", id: sent.id, ok: false, code: "forbidden" });
    await flush();
    expect(meReads).toBe(reads + 1);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Read-only here/)).toBeInTheDocument();
  });

  it("an unknown effect re-reads the chat and is not sent again", async () => {
    terminalInput = { enabled: true, until: null };
    const s = await openChat();
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    const dlg = screen.getByRole("alertdialog");
    await userEvent.click([...dlg.querySelectorAll("button")].find((b) => b.textContent === "Send")!);
    const sent = s.ofType("act").at(-1)!;
    const before = subs(s).filter((t) => t === "chat:term-2").length;
    await recv(s, { type: "res", id: sent.id, ok: false, code: "timeout", unknown_effect: true });
    await flush();
    expect(subs(s).filter((t) => t === "chat:term-2").length).toBe(before + 1);
    expect(s.ofType("act").filter((a) => a.kind === "terminal.send")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(/may have been sent/);
  });
});

describe("LiveApp inbox", () => {
  it("subscribes inbox and badges the tab from the topic", async () => {
    const typical = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/bridge-api/inbox/typical.json"), "utf8")) as { waiting: number };
    await mount();
    const s = await greet();
    expect(subs(s)).toContain("inbox");
    await recv(s, { type: "snap", topic: "inbox", epoch: "e1", seq: 1, data: typical });
    expect(screen.getByText(`?${typical.waiting}`)).toBeInTheDocument();
  });

  it("sends inbox acts bound to the row's rev, and reads the inbox again after an unknown effect, never resending", async () => {
    const typical = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/bridge-api/inbox/typical.json"), "utf8")) as { entries: { key: string; rev: string }[] };
    await mount("#/inbox");
    const s = await greet();
    await recv(s, { type: "snap", topic: "inbox", epoch: "e1", seq: 1, data: typical });
    // The inbox's arm delay for a view that just appeared.
    await act(() => new Promise((r) => setTimeout(r, 450)));
    await userEvent.click(screen.getByRole("button", { name: "Seen" }));
    const sent = s.ofType("act").at(-1)!;
    expect(sent).toMatchObject({ kind: "inbox.ack", args: { key: "alert:456", rev: typical.entries.find((e) => e.key === "alert:456")!.rev } });
    const before = subs(s).filter((t) => t === "inbox").length;
    await recv(s, { type: "res", id: sent.id, ok: false, code: "unknown_effect", unknown_effect: true, message: "The result is unknown (x)." });
    await flush();
    expect(subs(s).filter((t) => t === "inbox").length).toBe(before + 1);
    expect(s.ofType("act")).toHaveLength(1);
    expect(screen.getByText("The result is unknown (x).")).toBeInTheDocument();
  });
});

describe("hostNameFrom", () => {
  it("takes the serve name's first label", () => {
    expect(hostNameFrom("desk-1.example-tailnet.ts.net")).toBe("desk-1");
    expect(hostNameFrom("localhost")).toBe("localhost");
  });
});
