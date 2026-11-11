// VAPID (RFC 8292): the bridge's own P-256 key pair, kept in `vapid.json` (0600), and the `Authorization` header it signs.
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "./store.js";

export const VAPID_FILE = "vapid.json";
/** A JWT lives at most 24 h (RFC 8292 §2); 12 h leaves room for clock skew. */
export const JWT_TTL_S = 12 * 60 * 60;
/**
 * The `sub` claim: a contact for the push service operator. A neutral project URL, so no person's address or
 * tailnet name is sent to the push service.
 */
export const DEFAULT_SUBJECT = "https://github.com/LeaveMyYard/herdr-app-remote";

const B64U = z.string().regex(/^[A-Za-z0-9_-]+$/);
const FileSchema = z
  .object({
    v: z.literal(1),
    /** Uncompressed public point, base64url: the PWA's `applicationServerKey`. */
    public_key: B64U.length(87),
    /** The private JWK (P-256). */
    private_jwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: B64U, y: B64U, d: B64U }).strict(),
    created_at: z.number().int(),
  })
  .strict();

export interface Vapid {
  /** base64url of the 65-byte uncompressed public point. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

function rawPublic(jwk: { x: string; y: string }): Buffer {
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
}

/**
 * Loads the key pair, or creates it on first use. A file that fails validation is an error, never silently
 * replaced: a new key would orphan every phone's subscription without saying why.
 */
export function loadVapid(dir: string, now: () => number = Date.now): Vapid {
  const file = join(dir, VAPID_FILE);
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = privateKey.export({ format: "jwk" }) as { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
    const data = {
      v: 1 as const,
      public_key: rawPublic(jwk).toString("base64url"),
      private_jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
      created_at: now(),
    };
    // `wx`: two bridges racing to create it can't both win; the loser reads the winner's file below.
    writeAtomic(dir, file, data, { exclusive: true });
  }
  chmodSync(file, 0o600);
  const parsed = FileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
  const jwk = parsed.data.private_jwk;
  if (rawPublic(jwk).toString("base64url") !== parsed.data.public_key) throw new Error(`${file} is invalid: public key mismatch`);
  return { publicKey: parsed.data.public_key, privateKey: createPrivateKey({ key: jwk, format: "jwk" }) };
}

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** The `Authorization` header value for one push request: `vapid t=<ES256 JWT>, k=<public key>`. */
export function vapidAuthorization(v: Vapid, endpoint: string, subject: string, nowMs: number): string {
  const aud = new URL(endpoint).origin;
  const head = `${b64json({ typ: "JWT", alg: "ES256" })}.${b64json({ aud, exp: Math.floor(nowMs / 1000) + JWT_TTL_S, sub: subject })}`;
  const sig = sign("sha256", Buffer.from(head), { key: v.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${sig.toString("base64url")}, k=${v.publicKey}`;
}
