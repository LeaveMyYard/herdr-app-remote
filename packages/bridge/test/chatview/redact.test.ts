import { describe, expect, it } from "vitest";
import { HIDDEN, redact } from "../../src/chatview/redact.js";

// Fake secrets of the documented shapes only.
const SAMPLES: [string, string][] = [
  ["Anthropic key", `sk-ant-api03-${"a1B2".repeat(10)}`],
  ["GitHub classic token", `ghp_${"A1b2C3d4".repeat(5)}`],
  ["GitHub app token", `ghs_${"A1b2C3d4".repeat(5)}`],
  ["GitHub fine-grained token", `github_pat_${"11ABCDEFG0".repeat(4)}`],
  ["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
  ["AWS temporary key id", "ASIAABCDEFGHIJKLMNOP"],
  ["Slack bot token", "xoxb-1234567890-abcdefghij"],
  ["Slack user token", "xoxp-1234567890-abcdefghij"],
];

describe("redact (§5.3, best effort)", () => {
  it.each(SAMPLES)("hides a %s", (_name, secret) => {
    expect(redact(`before ${secret} after`)).toBe(`before ${HIDDEN} after`);
  });

  it("hides a PEM private key block whole, and one whose END line is missing", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`key:\n${pem}\ndone`)).toBe(`key:\n${HIDDEN}\ndone`);
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEfake")).toBe(HIDDEN);
    expect(redact("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).toBe(HIDDEN);
    // A public key or certificate is not a secret.
    expect(redact("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toContain("AAAA");
  });

  it("keeps Authorization: Bearer and hides the token", () => {
    expect(redact("curl -H 'Authorization: Bearer abc.def-123'")).toBe(`curl -H 'Authorization: Bearer ${HIDDEN}'`);
    expect(redact('{"authorization": "Bearer abc123"}')).toBe(`{"authorization": "Bearer ${HIDDEN}"}`);
  });

  it("leaves ordinary text alone", () => {
    const t = "Agent 1 read README.md in Project Alpha. sk-ant is a prefix; ghp_ alone too; AKIA short; xoxb-1.";
    expect(redact(t)).toBe(t);
    expect(redact("")).toBe("");
  });
});
