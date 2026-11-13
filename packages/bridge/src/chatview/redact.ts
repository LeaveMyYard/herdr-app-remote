// Best-effort secret redaction for the chat view (docs/chatview.md §5.3). Every string that leaves the bridge in a
// `chatview:<t>` item or page goes through `redact` first. Known secret shapes become `[hidden]`. It is a
// best-effort filter, not a guarantee: a secret in a shape not listed here, or split across two messages, gets
// through. SECURITY.md says so.

export const HIDDEN = "[hidden]";

/**
 * The shapes, in order. Each is global; the PEM block runs to its END line, or to the end of the text when the
 * END line is missing (a block cut by a limit, or pasted half).
 */
const PATTERNS: readonly RegExp[] = [
  // PEM private keys: RSA, EC, OPENSSH, ENCRYPTED, plain PKCS#8.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
  // Anthropic API and admin keys.
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids (long-term and temporary).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-, xoxe-).
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
];

/** `Authorization: Bearer <token>` keeps its header words; only the token is hidden. */
const BEARER = /(\bAuthorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s"'`,;]+/gi;

/** `s` with every known secret shape replaced by {@link HIDDEN}. */
export function redact(s: string): string {
  if (s === "") return s;
  let out = s;
  for (const p of PATTERNS) out = out.replace(p, HIDDEN);
  return out.replace(BEARER, `$1${HIDDEN}`);
}
