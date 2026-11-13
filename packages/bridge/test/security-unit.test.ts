import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import jsQRModule from "jsqr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog, describeAct, cleanLabel } from "../src/security/audit.js";
import { ACTION_CAPS, defaultCaps, hasCap, topicCaps } from "../src/security/caps.js";
import { DeviceStore, newDeviceId } from "../src/security/devices.js";
import { readCookie, singleHeader } from "../src/security/headers.js";
import { qrMatrix, qrSvg } from "../src/security/qr.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-sec-unit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// jsqr is CommonJS with an ES-style default export: unwrap whichever shape loads.
type JsQR = (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const jsQR: JsQR = ((jsQRModule as unknown as { default?: JsQR }).default ?? jsQRModule) as unknown as JsQR;

const fakeReq = (raw: string[]) => ({ rawHeaders: raw }) as unknown as IncomingMessage;

describe("headers", () => {
  it("refuses duplicated security headers", () => {
    expect(singleHeader(fakeReq(["Host", "a"]), "host")).toBe("a");
    expect(singleHeader(fakeReq(["Host", "a", "host", "b"]), "host")).toBeUndefined();
    expect(singleHeader(fakeReq([]), "host")).toBeUndefined();
  });

  it("reads one cookie and refuses a duplicated name", () => {
    expect(readCookie(fakeReq(["Cookie", "a=1; __Host-x=tok; b=2"]), "__Host-x")).toBe("tok");
    expect(readCookie(fakeReq(["Cookie", "__Host-x=one; __Host-x=two"]), "__Host-x")).toBeUndefined();
    expect(readCookie(fakeReq(["Cookie", "__Host-x=one", "Cookie", "__Host-x=two"]), "__Host-x")).toBeUndefined();
    expect(readCookie(fakeReq(["Cookie", "x__Host-x=one"]), "__Host-x")).toBeUndefined();
  });
});

describe("capabilities", () => {
  it("defaults: view and inbox.answer on, the rest off", () => {
    const c = defaultCaps();
    expect([c.view, c["inbox.answer"], c.navigate, c["terminal.input"], c.push]).toEqual([true, true, false, false, false]);
    // CV1: chat history is off for every device until the desktop turns it on.
    expect(c["transcript.read"]).toBe(false);
  });

  it("transcript.read (CV1) has no expiry and is needed by the transcript topics only", () => {
    expect(hasCap({ ...defaultCaps(), "transcript.read": true }, "transcript.read", 1e15)).toBe(true);
    expect(hasCap(defaultCaps(), "transcript.read", 0)).toBe(false);
    expect(topicCaps("chatview:t3")).toEqual(["transcript.read"]);
    expect(topicCaps("timeline:vps/t7")).toEqual(["transcript.read"]);
    for (const t of ["host", "chat:t3", "inbox", "keys", "chat:chatview:t3"]) expect(topicCaps(t), t).toEqual([]);
  });

  it("terminal.keys expires on its own clock (S16b), whatever terminal.input says", () => {
    const c = { ...defaultCaps(), "terminal.keys": true, "terminal.keys.until": 1000, "terminal.input": true, "terminal.input.until": null };
    expect(hasCap(c, "terminal.keys", 999)).toBe(true);
    expect(hasCap(c, "terminal.keys", 1000)).toBe(false);
    expect(hasCap({ ...c, "terminal.keys.until": null }, "terminal.keys", 1e15)).toBe(true);
    expect(hasCap({ ...c, "terminal.keys": false, "terminal.keys.until": null }, "terminal.keys", 0)).toBe(false);
  });

  it("prompt.answer (CV7) is off by default, expires on its own clock, and is the one cap prompt.answer needs", () => {
    expect(defaultCaps()["prompt.answer"]).toBe(false);
    expect(hasCap(defaultCaps(), "prompt.answer", 0)).toBe(false);
    const c = { ...defaultCaps(), "prompt.answer": true, "prompt.answer.until": 1000, "terminal.keys": true, "terminal.keys.until": null };
    expect(hasCap(c, "prompt.answer", 999)).toBe(true);
    expect(hasCap(c, "prompt.answer", 1000)).toBe(false);
    expect(hasCap({ ...c, "prompt.answer.until": null }, "prompt.answer", 1e15)).toBe(true);
    expect(ACTION_CAPS.get("prompt.answer")).toBe("prompt.answer");
    // Neither typing nor the key menu implies it.
    expect([...ACTION_CAPS.entries()].filter(([, cap]) => cap === "prompt.answer").map(([k]) => k)).toEqual(["prompt.answer"]);
  });

  it("terminal.input expires", () => {
    const c = { ...defaultCaps(), "terminal.input": true, "terminal.input.until": 1000 };
    expect(hasCap(c, "terminal.input", 999)).toBe(true);
    expect(hasCap(c, "terminal.input", 1000)).toBe(false);
    expect(hasCap({ ...c, "terminal.input.until": null }, "terminal.input", 1e15)).toBe(true);
  });

  it("the allowlist has no generic run, exec or do, and no prototype keys", () => {
    for (const k of ["run", "exec", "do", "app.do", "hc.send", "__proto__", "constructor", "toString", "tab.new"]) {
      expect(ACTION_CAPS.has(k)).toBe(false);
    }
    expect([...ACTION_CAPS.entries()].filter(([, c]) => c === "navigate").map(([k]) => k).sort()).toEqual(
      ["agent.focus", "pane.focus", "space.select", "tab.select"],
    );
  });
});

describe("audit redaction", () => {
  const SECRET = "rm -rf secret-input-123";

  it("terminal input is logged as a length only", () => {
    const t = describeAct("terminal.send", { terminal: "t3", text: "hello world!" });
    expect(t).toBe("sent 12 chars to t3");
    expect(describeAct("terminal.send", { terminal: "t3", text: SECRET })).not.toContain("secret");
  });

  it("a key press names only the entry the bridge resolved, never the client's id", () => {
    expect(describeAct("terminal.keys", { terminal: "t3", key: "ctrl-c", rev: "0123456789abcdef" }, "ctrl-c (1 key)")).toBe("pressed ctrl-c (1 key) in t3");
    expect(describeAct("terminal.keys", { terminal: "t3", key: "secretword", rev: "x" })).toBe("pressed a key in t3");
    expect(describeAct("terminal.keys", { terminal: SECRET, key: SECRET })).toBe("pressed a key in a terminal");
  });

  it("a prompt answer logs only the bridge's words, never the choice, Other text or the command", () => {
    expect(describeAct("prompt.answer", { terminal: "t3", choice: { option: 0 } }, "a permission prompt\noption 1 of 3 (Yes)")).toBe("answered a permission prompt in t3: option 1 of 3 (Yes)");
    expect(describeAct("prompt.answer", { terminal: "t3", choice: { other: SECRET } }, "a question\nown answer (23 chars)")).toBe("answered a question in t3: own answer (23 chars)");
    expect(describeAct("prompt.answer", { terminal: "t3", choice: { other: SECRET } })).toBe("answered a prompt in t3");
    expect(describeAct("prompt.answer", { terminal: SECRET, prompt_id: SECRET })).toBe("answered a prompt in a terminal");
  });

  it("inbox answers log the bridge-resolved option label, never client text", () => {
    expect(describeAct("inbox.answer", { key: "group:119", question: 119 }, "Option B")).toBe("answered Q119 (Option B)");
    // A label in the client's args is client text: ignored.
    expect(describeAct("inbox.answer", { key: "group:119", question: 119, label: SECRET })).toBe("answered Q119");
    const free = describeAct("inbox.answer", { key: "group:119", question: 119, detail: { choices: [], notes: {}, text: SECRET } });
    expect(free).toBe("answered Q119 (23 chars)");
    expect(describeAct("inbox.answer", { key: "group:123", questions: [123, 124] }, "Q123: Option A")).toBe("answered Q123, Q124 (Q123: Option A)");
    expect(describeAct("inbox.draft", { key: "group:1", question: 1, detail: { choices: [], notes: { 0: SECRET }, text: SECRET } })).not.toContain("secret");
    expect(describeAct("inbox.draft", { key: "group:1", question: 1, clear: true })).toBe("cleared the draft of Q1");
    expect(describeAct("inbox.ack", { key: "alert:456" })).toBe("acknowledged A456");
    expect(describeAct("inbox.dismiss", { key: "group:123" })).toBe("dismissed group 123");
    expect(describeAct("inbox.retry", { key: "failed:119" })).toBe("asked to resend the answer to Q119");
    expect(describeAct("inbox.stop_showing", { key: "failed:119" })).toBe("stopped showing the answer to Q119");
  });

  it("ids that aren't ids, and unknown kinds that aren't names, are not logged", () => {
    expect(describeAct("terminal.send", { terminal: SECRET, text: "x" })).toBe("sent 1 chars to a terminal");
    expect(describeAct("inbox.dismiss", { key: SECRET, question: SECRET })).toBe("dismissed a question");
    expect(describeAct("inbox.dismiss", { key: "group:01", question: 1.5 })).toBe("dismissed a question");
    expect(describeAct(SECRET, {})).toBe("tried an unknown action");
    expect(describeAct("exec", { cmd: SECRET })).toBe("tried exec");
  });

  it("labels lose control characters and are capped", () => {
    expect(cleanLabel("a\nb\u0007c")).toBe("a b c");
    expect(cleanLabel("x".repeat(100)).length).toBe(40);
  });

  it("writes 0600 JSONL, rotates by size, and tails across the rotation", async () => {
    const log = new AuditLog({ dir, maxBytes: 300, keep: 2 });
    for (let i = 0; i < 12; i++) log.record({ ts: i, event: "act", text: `entry ${i}` });
    expect((await stat(log.path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${log.path}.1`)).mode & 0o777).toBe(0o600);
    await expect(stat(`${log.path}.3`)).rejects.toThrow();
    const tail = log.tail(4);
    expect(tail.map((e) => e.text)).toEqual(["entry 8", "entry 9", "entry 10", "entry 11"]);
    for (const l of (await readFile(log.path, "utf8")).trim().split("\n")) expect(() => JSON.parse(l) as unknown).not.toThrow();
  });
});

describe("device store", () => {
  const dev = () => ({
    id: newDeviceId(),
    name: "Phone 1",
    login: "user-1@example",
    token_sha256: "a".repeat(64),
    state: "approved" as const,
    caps: defaultCaps(),
    created_at: 1,
    approved_at: 2,
    last_seen: null,
  });

  it("persists atomically with 0600 file and 0700 directory", async () => {
    const sub = join(dir, "data");
    const s = new DeviceStore(sub);
    const d = dev();
    s.add(d);
    s.paused = true;
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
    const again = new DeviceStore(sub);
    expect(again.get(d.id)?.name).toBe("Phone 1");
    expect(again.paused).toBe(true);
  });

  it("fails closed on an invalid file instead of forgetting devices", async () => {
    await writeFile(join(dir, "devices.json"), JSON.stringify({ v: 1, paused: false, devices: [{ id: "x" }] }));
    expect(() => new DeviceStore(dir)).toThrow(/invalid/);
    await writeFile(join(dir, "devices.json"), "{not json");
    expect(() => new DeviceStore(dir)).toThrow();
  });

  it("transcript.read (CV1): a file without it reads as off; a non-boolean or an unknown cap is refused", async () => {
    const d = dev();
    const caps = { ...d.caps } as Record<string, unknown>;
    delete caps["transcript.read"];
    await writeFile(join(dir, "devices.json"), JSON.stringify({ v: 1, paused: false, devices: [{ ...d, caps }] }));
    expect(new DeviceStore(dir).get(d.id)?.caps["transcript.read"]).toBe(false);
    for (const bad of [{ ...caps, "transcript.read": "yes" }, { ...caps, "transcript.read": 1 }, { ...caps, "transcript.read.until": null }, { ...caps, "transcript.write": true }]) {
      await writeFile(join(dir, "devices.json"), JSON.stringify({ v: 1, paused: false, devices: [{ ...d, caps: bad }] }));
      expect(() => new DeviceStore(dir), JSON.stringify(bad)).toThrow(/invalid/);
    }
    await writeFile(join(dir, "devices.json"), JSON.stringify({ v: 1, paused: false, devices: [{ ...d, caps: { ...caps, "transcript.read": true } }] }));
    expect(new DeviceStore(dir).get(d.id)?.caps["transcript.read"]).toBe(true);
  });

  it("tightens a too-open existing file to 0600", async () => {
    await writeFile(join(dir, "devices.json"), JSON.stringify({ v: 1, paused: false, devices: [] }), { mode: 0o644 });
    new DeviceStore(dir);
    expect((await stat(join(dir, "devices.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("qr", () => {
  it("encodes the pairing URL so a decoder reads it back", () => {
    const url = "https://desk-1.example-tailnet.ts.net/pair#c=AAAAAAAAAAAAAAAAAAAAAA";
    const m = qrMatrix(url);
    const scale = 4;
    const n = m.length * scale;
    const px = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = m[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
        px.set([v, v, v, 255], (y * n + x) * 4);
      }
    expect(jsQR(px, n, n)?.data).toBe(url);
  });

  it("the SVG is static markup without the code in it", () => {
    const svg = qrSvg("https://desk-1.example-tailnet.ts.net/pair#c=SECRETSECRETSECRETSECR");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).not.toMatch(/script|href|SECRET|on[a-z]+=/i);
  });
});
