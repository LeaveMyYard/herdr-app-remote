// Web Push message encryption (RFC 8291) with the `aes128gcm` content coding (RFC 8188), on node:crypto only.
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

/** The record size written into the header. One record holds the whole message. */
export const RECORD_SIZE = 4096;
/** Header (salt 16, rs 4, idlen 1, keyid 65) plus the GCM tag and the padding delimiter. */
const OVERHEAD = 16 + 4 + 1 + 65 + 16 + 1;
/** The largest body this module writes (push services must accept 4096). */
export const MAX_BODY = 4096;

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();
/** HKDF-Expand for one block (every length here is at most 32 bytes). */
const expand = (prk: Buffer, info: Buffer, len: number): Buffer => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

export interface UaKeys {
  /** The subscription's `p256dh`: an uncompressed P-256 point (65 bytes). */
  p256dh: Buffer;
  /** The subscription's `auth` secret (16 bytes). */
  auth: Buffer;
}

/** Test seams only: fixed values make the RFC 8291 example reproducible. Never set them in production. */
export interface EncryptSeams {
  salt?: Buffer;
  /** The application server's ephemeral private key (32 bytes). */
  asPrivate?: Buffer;
}

/** True when `p256dh` is a point on P-256 and `auth` is 16 bytes: what a subscription needs to be usable. */
export function validUaKeys(k: UaKeys): boolean {
  if (k.auth.length !== 16 || k.p256dh.length !== 65 || k.p256dh[0] !== 0x04) return false;
  try {
    const e = createECDH("prime256v1");
    e.generateKeys();
    e.computeSecret(k.p256dh);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypts one push message for a subscription. Returns the request body (header and the single record).
 * A fresh ephemeral key and salt are drawn for every message.
 */
export function encryptPayload(plaintext: Buffer, ua: UaKeys, seams: EncryptSeams = {}): Buffer {
  if (plaintext.length + OVERHEAD > MAX_BODY) throw new Error("push payload too large");
  const ecdh = createECDH("prime256v1");
  if (seams.asPrivate) ecdh.setPrivateKey(seams.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua.p256dh);
  const salt = seams.salt ?? randomBytes(16);

  // RFC 8291 §3.4: the auth secret mixes into the shared secret, bound to both public keys.
  const prkKey = hmac(ua.auth, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), ua.p256dh, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  // RFC 8188 §2.2.
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last (and only) record ends with the 0x02 delimiter and no further padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}
