// Where the bridge may POST a push, and the POST itself.
//
// A subscription's endpoint comes from the phone, so it is an outbound request the bridge makes to a URL a client
// chose. To keep that from becoming a way to reach anything else (the tailnet, loopback, a metadata service), only
// HTTPS on port 443 to the known browser push services is accepted, without credentials in the URL, and redirects
// are never followed.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** The push services of Safari/iOS, Chrome, Firefox and Edge. A host matches exactly or as a subdomain of a suffix. */
export const PUSH_HOSTS: readonly string[] = ["fcm.googleapis.com"];
/** `web.push.apple.com` and `updates.push.services.mozilla.com` are covered here. */
export const PUSH_HOST_SUFFIXES: readonly string[] = [".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com"];
export const MAX_ENDPOINT = 1024;

/** The default endpoint check: true only for an HTTPS URL on :443 of a known push service. */
export function knownPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > MAX_ENDPOINT) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "" || u.hash !== "") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Sends one push; resolves with the HTTP status, or null when no answer came (network, timeout). Never throws. */
export type PushTransport = (r: PushRequest) => Promise<number | null>;

export const SEND_TIMEOUT_MS = 10_000;

/**
 * POSTs with node's own client: no redirects are followed, the answer's body is discarded. Plain `http:` exists
 * for the local fake push service in tests only; the endpoint check never lets such a URL through by default.
 */
export function defaultTransport(timeoutMs = SEND_TIMEOUT_MS): PushTransport {
  return (r) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (v: number | null) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      let u: URL;
      try {
        u = new URL(r.endpoint);
      } catch {
        return finish(null);
      }
      const req = (u.protocol === "http:" ? httpRequest : httpsRequest)(
        u,
        { method: "POST", headers: { ...r.headers, "Content-Length": String(r.body.length) }, timeout: timeoutMs },
        (res) => {
          res.resume();
          finish(res.statusCode ?? null);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
      req.on("error", () => finish(null));
      req.end(r.body);
    });
}
