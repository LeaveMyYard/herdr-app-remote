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

// ---- Web Push (S17) ----
// iOS revokes a subscription whose pushes don't show a notification, so every push shows one, even a payload
// this version can't read. Text is shown as the notification's plain title and body, never as markup.

const ROUTE = /^#\/[A-Za-z0-9_.~%:/-]*$/;

function pushPayload(data) {
  let p = null;
  try {
    p = data ? data.json() : null;
  } catch {
    p = null;
  }
  const ok = p && typeof p === "object" && p.v === 1;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    title: (ok && str(p.title, 200)) || "Herdr",
    body: ok ? str(p.body, 40) : "Something needs you",
    tag: ok && typeof p.tag === "string" && /^[a-z0-9-]{1,40}$/.test(p.tag) ? p.tag : "herdr",
    url: ok && typeof p.url === "string" && ROUTE.test(p.url) && p.url.length <= 300 ? p.url : "#/inbox",
  };
}

self.addEventListener("push", (event) => {
  const n = pushPayload(event.data);
  event.waitUntil(self.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: "icons/icon-192.png", data: { url: n.url } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = event.notification.data && typeof event.notification.data.url === "string" && ROUTE.test(event.notification.data.url) ? event.notification.data.url : "#/inbox";
  const target = new URL(route, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const mine = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (mine) return mine.navigate(target).then((c) => (c || mine).focus()).catch(() => mine.focus());
      return self.clients.openWindow(target);
    }),
  );
});
