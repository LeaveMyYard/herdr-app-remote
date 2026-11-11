import type { IncomingMessage } from "node:http";

/**
 * Every value of a header, from the raw header list. Node folds or drops duplicates in
 * `req.headers`, so the guards count raw occurrences: a duplicated security header is
 * refused rather than resolved.
 */
export function headerValues(req: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  }
  return out;
}

/** The single value of a header; undefined when it is absent or sent more than once. */
export function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const v = headerValues(req, name);
  return v.length === 1 ? v[0] : undefined;
}

/**
 * The value of one cookie. Undefined when absent, and also when the name appears more
 * than once (a planted duplicate must not be able to shadow the real cookie).
 */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  let found: string | undefined;
  let count = 0;
  for (const header of headerValues(req, "cookie")) {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== name) continue;
      count += 1;
      found = part.slice(eq + 1).trim();
    }
  }
  return count === 1 ? found : undefined;
}
