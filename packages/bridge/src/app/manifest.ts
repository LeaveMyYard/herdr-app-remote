// `GET /manifest.webmanifest`, per device (S5b). The PWA's own manifest from the built static files, with one change
// for a device that just asked for a Home Screen transfer code: `start_url` becomes `./pair#t=<code>`, so the Home
// Screen app iOS creates from it opens there on its first launch and pairs itself. Everyone else gets the file as
// built. Only the one-time code ever goes into the URL, never the cookie token.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

export const MANIFEST_PATH = "/manifest.webmanifest";

const HEADERS = {
  "Content-Security-Policy": "default-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Per device and per moment: never cached, by the browser or by the service worker.
  "Cache-Control": "no-store",
  Vary: "Cookie",
  "Content-Type": "application/manifest+json; charset=utf-8",
};

/**
 * A `routes` handler for the manifest. `startUrlFor` is `Security.manifestStartUrl`. Without a static dir (or a
 * manifest in it) the request falls through to the server's 404.
 */
export function manifestRoute(staticDir: string | undefined, startUrlFor: (req: IncomingMessage) => string | null) {
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (path !== MANIFEST_PATH || !staticDir) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let manifest: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(await readFile(join(staticDir, "manifest.webmanifest"), "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
      manifest = raw as Record<string, unknown>;
    } catch {
      return false;
    }
    const start = startUrlFor(req);
    // `id` stays as built, so the app's identity doesn't change with its start URL.
    const body = JSON.stringify(start === null ? manifest : { ...manifest, start_url: start });
    res.writeHead(200, { ...HEADERS, "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}
