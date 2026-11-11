// App-shell service worker. Caches only same-origin static GETs; never /api or websockets.
const SHELL = "herdr-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;

  if (req.mode === "navigate") {
    // Network first so a new build is picked up. Only a plain 200 HTML page becomes the offline
    // shell: an error page, a redirect or an auth refusal must never replace it.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected && isHtml(res)) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("shell", copy));
          }
          return res;
        })
        .catch(() => caches.match("shell").then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed build output only; everything else (manifest, icons, other GETs) goes to the network.
  if (!url.pathname.includes("/assets/")) return;
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
