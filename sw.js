// Minimal app-shell service worker: caches the static files that make the
// UI itself (not the data in it) so the app opens instantly and can
// install as a PWA. /api/* is always fetched live — checklists and tasks
// are shared, so a cached response would show stale/wrong data to other
// people using the app.

const CACHE_NAME = "notice-board-shell-v13";

// Relative to this file's own location, so the same list works whether
// the app is served from a domain root (Cloudflare Pages) or a subfolder
// (e.g. a GitHub Pages project site at yourname.github.io/Notice-Board/).
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "brand/banner.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- Push notifications ----

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* ignore a malformed/empty push payload */
  }
  const title = data.title || "Notice Board";
  const options = {
    body: data.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: data.url || "./" },
  };

  const tasks = [self.registration.showNotification(title, options)];

  // Set the app icon badge right away, straight from the push payload's
  // count (see lib/push.js) — instant, and doesn't need the app to be
  // open. public/app.js's syncBadge() re-derives the true count from the
  // server on every navigation, so this is just for immediacy; if it's
  // ever a little off (e.g. two pushes arrive close together) that resync
  // corrects it the next time the app is opened.
  if (typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
    tasks.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }

  event.waitUntil(Promise.all(tasks.map((p) => Promise.resolve(p).catch(() => {}))));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";
  const fullUrl = new URL(targetUrl, self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          try {
            if ("navigate" in client) await client.navigate(fullUrl);
          } catch {
            /* some browsers restrict navigate() — focusing is still useful */
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(fullUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return; // let the browser handle it normally — always live
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
