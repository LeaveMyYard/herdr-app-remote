import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridgeApi } from "@herdr-remote/protocol";
import { InboxTopicDriver } from "../../src/inbox/topic.js";
import { run } from "../../src/plugins/exec.js";
import { Security } from "../../src/security/index.js";
import { createBridgeServer, type BridgeServer } from "../../src/server.js";
import { newHub } from "../helpers.js";
import { alertEntry, feedDoc, group, inboxHome, NOW, question } from "./helpers.js";

/**
 * The whole answer path over a real socket, as a phone drives it: pairing, the guards, the capability check,
 * the inbox driver and its fake launcher, and the audit entry. Fake identity and data only.
 */
const SERVE = "desk-1.example-tailnet.ts.net";
const OWNER = "user-1@example";
const ORIGIN = `https://${SERVE}`;

let srv: BridgeServer | undefined;
let driver: InboxTopicDriver | undefined;
let dir: string | undefined;
afterEach(async () => {
  driver?.stop();
  await srv?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function post(port: number, path: string, body: unknown): Promise<{ status: number; cookie: string; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(
      { host: "127.0.0.1", port, method: "POST", path, setHost: false, headers: { Host: SERVE, "Tailscale-User-Login": OWNER, Origin: ORIGIN, "X-Remote-Api": "1", "Content-Type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode ?? 0, cookie: ((Array.isArray(sc) ? sc[0] : sc) ?? "").split(";")[0] ?? "", body: b });
        });
      },
    );
    r.on("error", reject);
    r.end(JSON.stringify(body));
  });
}

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "s11-e2e-"));
  const lone = group(127, {
    questions: [question(127, { options: [{ label: "Option A", description: null, preview: null }, { label: "Option B", description: null, preview: null }] })],
  });
  const h = inboxHome({ feed: feedDoc({ entries: [alertEntry(456), lone] }) });
  const ref: { d?: InboxTopicDriver } = {};
  const sec = new Security({
    dataDir: join(dir, "data"),
    serve: { host: SERVE, login: OWNER },
    now: () => NOW,
    inner: async (_c, kind, args) => (await ref.d?.act(kind, args)) ?? { ok: false, code: "unsupported_action" },
  });
  const hub = newHub({ onAct: sec.act });
  const d = (ref.d = driver = new InboxTopicDriver({ hub, appHome: h.home, run, now: () => NOW, intervalMs: 3_600_000 }));
  await d.start();
  srv = createBridgeServer({ hub, guard: sec.guard, routes: sec.routes, onConnect: sec.onConnect });
  const { port } = await srv.listen();
  const { code } = sec.issueCode();
  const paired = await post(port, "/api/v1/pair", { code, name: "Phone 1" });
  const id = (JSON.parse(paired.body) as { device: { id: string } }).device.id;
  sec.approve(id);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, [bridgeApi.WS_PROTOCOL], { headers: { Host: SERVE, "Tailscale-User-Login": OWNER, Origin: ORIGIN, Cookie: paired.cookie } });
  const msgs: bridgeApi.ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (m) => {
    msgs.push(JSON.parse(m.toString()) as bridgeApi.ServerMessage);
    for (const w of waiters) w();
  });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const until = (pred: () => boolean) =>
    new Promise<void>((res) => {
      const check = () => pred() && res();
      waiters.push(check);
      check();
    });
  ws.send(JSON.stringify({ type: "hello", api: 1 }));
  ws.send(JSON.stringify({ type: "sub", topics: ["inbox"] }));
  await until(() => msgs.some((m) => m.type === "snap" && m.topic === "inbox"));
  const snap = msgs.find((m) => m.type === "snap" && m.topic === "inbox") as Extract<bridgeApi.ServerMessage, { type: "snap" }>;
  const inbox = bridgeApi.InboxTopic.parse(snap.data);
  let n = 0;
  const act = async (kind: string, args: Record<string, unknown>) => {
    const aid = `act-${++n}`;
    ws.send(JSON.stringify({ type: "act", id: aid, kind, args }));
    await until(() => msgs.some((m) => m.type === "res" && m.id === aid));
    return msgs.find((m) => m.type === "res" && m.id === aid) as bridgeApi.Res;
  };
  const activity = async () => readFile(join(dir as string, "data", "activity.jsonl"), "utf8");
  return { h, sec, id, inbox, act, activity, msgs, ws };
}

describe("inbox answer, end to end over the socket", () => {
  it("answers through the launcher, keeps the token and label on the bridge, and audits the bridge's label", async () => {
    const s = await setup();
    const row = s.inbox.entries.find((e) => e.key === "group:127");
    expect(JSON.stringify(s.inbox)).not.toContain("tok-");
    s.h.reply("answer", { v: 1, ok: true, verb: "answer", entry: "@ENTRY@", token: null, done: [127], skipped: [], delivery: "queued" });
    const res = await s.act("inbox.answer", { key: "group:127", rev: row?.rev, question: 127, detail: { choices: [1], notes: { "1": "secret note words" }, text: null } });
    expect(res).toEqual({ type: "res", id: "act-1", ok: true, message: "Sending Q127 in the background.", closed: "answered" });
    expect(s.h.verbCalls()).toHaveLength(1);
    expect(s.h.verbCalls()[0]).toContain("--token tok-group-127 ");
    // No token reached the phone, in any frame.
    expect(JSON.stringify(s.msgs)).not.toContain("tok-");
    const log = await s.activity();
    expect(log).toContain("Phone 1 answered Q127 (Option B)");
    expect(log).not.toContain("secret note");
    s.ws.close();
  });

  it("free text is logged by length only; with inbox.answer off nothing runs", async () => {
    const s = await setup();
    const row = s.inbox.entries.find((e) => e.key === "group:127");
    const res = await s.act("inbox.answer", { key: "group:127", rev: row?.rev, question: 127, detail: { choices: [], notes: {}, text: "secret free text" } });
    expect(res.ok).toBe(true);
    s.sec.setCap(s.id, "inbox.answer", false);
    const alert = s.inbox.entries.find((e) => e.key === "alert:456");
    expect(await s.act("inbox.ack", { key: "alert:456", rev: alert?.rev })).toMatchObject({ ok: false, code: "forbidden" });
    expect(s.h.verbCalls()).toHaveLength(1);
    const log = await s.activity();
    expect(log).toContain("Phone 1 answered Q127 (16 chars)");
    expect(log).toContain("Phone 1 acknowledged A456: refused");
    expect(log).not.toContain("secret free text");
    s.ws.close();
  });

  it("an unknown effect reaches the phone as such, is audited, and is not repeated", async () => {
    const s = await setup();
    const alert = s.inbox.entries.find((e) => e.key === "alert:456");
    s.h.reply("ack", "not a result", 0);
    const res = await s.act("inbox.ack", { key: "alert:456", rev: alert?.rev });
    expect(res).toMatchObject({ ok: false, code: "unknown_effect", unknown_effect: true });
    expect(s.h.verbCalls()).toHaveLength(1);
    expect(await s.activity()).toContain("Phone 1 acknowledged A456: result unknown");
    s.ws.close();
  });
});
