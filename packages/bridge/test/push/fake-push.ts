// A local stand-in for a browser push service (RFC 8030), plus the phone's side of RFC 8291: it checks the VAPID
// header and decrypts what the bridge sent. No real push endpoint is ever contacted.
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
const expand = (prk: Buffer, info: Buffer, len: number) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

/** A phone's subscription keys: what `PushManager.subscribe` makes. */
export class FakeUa {
  readonly ecdh = createECDH("prime256v1");
  readonly auth = randomBytes(16);
  constructor() {
    this.ecdh.generateKeys();
  }
  get keys() {
    return { p256dh: this.ecdh.getPublicKey().toString("base64url"), auth: this.auth.toString("base64url") };
  }

  /** Decrypts an `aes128gcm` push body (RFC 8291 §3.4, RFC 8188), written independently of the bridge's code. */
  decrypt(body: Buffer): string {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body[20]!;
    const asPublic = body.subarray(21, 21 + idlen);
    const record = body.subarray(21 + idlen);
    if (rs < 18 || record.length > rs) throw new Error("bad record size");
    const shared = this.ecdh.computeSecret(asPublic);
    const prkKey = hmac(this.auth, shared);
    const ikm = expand(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), this.ecdh.getPublicKey(), asPublic]), 32);
    const prk = hmac(salt, ikm);
    const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    // Strip padding: the last non-zero byte must be the 0x02 last-record delimiter.
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (plain[end] !== 2) throw new Error("bad padding delimiter");
    return plain.subarray(0, end).toString("utf8");
  }
}

export interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The VAPID JWT claims, when the signature verified against `k`. */
  claims: { aud: string; exp: number; sub: string } | null;
  vapidKey: string | null;
}

/** Checks `Authorization: vapid t=<jwt>, k=<key>`: ES256 over the JWT, with the key it names. */
export function checkVapid(header: string | undefined): { claims: Received["claims"]; key: string | null } {
  const m = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return { claims: null, key: null };
  const [h, p, s] = m[1]!.split(".") as [string, string, string];
  const raw = Buffer.from(m[2]!, "base64url");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  const header0 = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string };
  const okSig = header0.alg === "ES256" && verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return { claims: okSig ? (JSON.parse(Buffer.from(p, "base64url").toString()) as Received["claims"]) : null, key: m[2]! };
}

export class FakePushService {
  readonly received: Received[] = [];
  /** Status to answer with, per request path; default 201. */
  status = new Map<string, number>();
  /** Answers for a path wait for this promise (to order a race deterministically). */
  hold = new Map<string, Promise<void>>();
  /** Resolves when a request for the path has arrived. */
  private arrivals = new Map<string, () => void>();
  arrived(path: string): Promise<void> {
    return new Promise((r) => this.arrivals.set(path, r));
  }
  private server: Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const auth = req.headers.authorization;
        const v = checkVapid(typeof auth === "string" ? auth : undefined);
        this.received.push({ path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks), claims: v.claims, vapidKey: v.key });
        const path = req.url ?? "/";
        this.arrivals.get(path)?.();
        void (this.hold.get(path) ?? Promise.resolve()).then(() => {
          res.statusCode = this.status.get(path) ?? 201;
          res.end();
        });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  endpoint(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
