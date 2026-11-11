import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptPayload, validUaKeys } from "../../src/push/encrypt.js";
import { knownPushEndpoint } from "../../src/push/send.js";
import { DEFAULT_SUBJECT, JWT_TTL_S, loadVapid, vapidAuthorization, VAPID_FILE } from "../../src/push/vapid.js";
import { checkVapid, FakeUa } from "./fake-push.js";

const b = (s: string) => Buffer.from(s, "base64url");

describe("RFC 8291 encryption", () => {
  it("reproduces the RFC 8291 Appendix A example byte for byte", () => {
    const out = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      { p256dh: b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), auth: b("BTBZMqHH6r4Tts7J_aSIgg") },
      { salt: b("DGv6ra1nlYgDCS1FRnbzlw"), asPrivate: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
    );
    expect(out.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips through an independent decryptor, with a fresh key and salt each time", () => {
    const ua = new FakeUa();
    const keys = { p256dh: b(ua.keys.p256dh), auth: b(ua.keys.auth) };
    const one = encryptPayload(Buffer.from('{"title":"Agent 1: Question Title 123"}'), keys);
    const two = encryptPayload(Buffer.from('{"title":"Agent 1: Question Title 123"}'), keys);
    expect(ua.decrypt(one)).toBe('{"title":"Agent 1: Question Title 123"}');
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false);
  });

  it("refuses a payload that would not fit one 4096-byte body", () => {
    const ua = new FakeUa();
    expect(() => encryptPayload(Buffer.alloc(4000), { p256dh: b(ua.keys.p256dh), auth: b(ua.keys.auth) })).toThrow(/too large/);
  });

  it("accepts only a real P-256 point and a 16-byte auth secret", () => {
    const ua = new FakeUa();
    expect(validUaKeys({ p256dh: b(ua.keys.p256dh), auth: b(ua.keys.auth) })).toBe(true);
    expect(validUaKeys({ p256dh: b(ua.keys.p256dh), auth: Buffer.alloc(15) })).toBe(false);
    const offCurve = Buffer.from(b(ua.keys.p256dh));
    offCurve[64] = offCurve[64]! ^ 1;
    expect(validUaKeys({ p256dh: offCurve, auth: b(ua.keys.auth) })).toBe(false);
    expect(validUaKeys({ p256dh: Buffer.alloc(65), auth: b(ua.keys.auth) })).toBe(false);
  });
});

describe("VAPID", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-vapid-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the key pair once, 0600, and loads the same one again", () => {
    const a = loadVapid(dir);
    expect(statSync(join(dir, VAPID_FILE)).mode & 0o777).toBe(0o600);
    expect(b(a.publicKey)).toHaveLength(65);
    expect(loadVapid(dir).publicKey).toBe(a.publicKey);
  });

  it("refuses a damaged key file instead of replacing it", () => {
    loadVapid(dir);
    const f = join(dir, VAPID_FILE);
    const doc = JSON.parse(readFileSync(f, "utf8")) as { public_key: string };
    // Change the last character for sure: it carries only 4 bits, so a fixed "A" was already there 1 time in 16.
    const last = doc.public_key.at(-1) === "A" ? "E" : "A";
    doc.public_key = `B${doc.public_key.slice(1, 86)}${last}`;
    writeFileSync(f, JSON.stringify(doc));
    expect(() => loadVapid(dir)).toThrow(/invalid/);
    writeFileSync(f, "{}");
    expect(() => loadVapid(dir)).toThrow(/invalid/);
  });

  it("a key file that is not JSON is refused without quoting it (no key bytes in logs)", () => {
    writeFileSync(join(dir, VAPID_FILE), "SECRETkeybytes", { mode: 0o600 });
    let msg = "";
    try {
      loadVapid(dir);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/invalid: not JSON/);
    expect(msg).not.toContain("SECRET");
  });

  it("signs an ES256 JWT for the endpoint's origin, valid under 24 h, with a neutral subject", () => {
    const v = loadVapid(dir);
    const now = 1_800_000_000_000;
    const { claims, key } = checkVapid(vapidAuthorization(v, "https://web.push.apple.com/QGuLm0abc?x=1", DEFAULT_SUBJECT, now));
    expect(key).toBe(v.publicKey);
    expect(claims).toEqual({ aud: "https://web.push.apple.com", exp: now / 1000 + JWT_TTL_S, sub: DEFAULT_SUBJECT });
    expect(JWT_TTL_S).toBeLessThanOrEqual(24 * 3600);
  });
});

describe("push endpoints", () => {
  it.each([
    "https://web.push.apple.com/QGuLm0abc",
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://api.push.apple.com/abc",
  ])("accepts %s", (u) => expect(knownPushEndpoint(u)).toBe(true));

  it.each([
    "http://web.push.apple.com/abc",
    "https://web.push.apple.com:8443/abc",
    "https://user:pw@web.push.apple.com/abc",
    "https://web.push.apple.com/abc#frag",
    "https://web.push.apple.com.example.com/abc",
    "https://evilpush.apple.com/abc",
    "https://push.apple.com/abc",
    "https://127.0.0.1/abc",
    "https://localhost/abc",
    "https://desk-1.example-tailnet.ts.net/api/v1/pair",
    "https://[::1]/abc",
    "https://169.254.169.254/latest",
    "file:///etc/passwd",
    "not a url",
    `https://web.push.apple.com/${"a".repeat(1100)}`,
  ])("refuses %s", (u) => expect(knownPushEndpoint(u)).toBe(false));
});
