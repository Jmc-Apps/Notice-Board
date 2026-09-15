// Minimal app-shell service worker: caches the static files that make the
// UI itself (not the data in it) so the app opens instantly and can
// install as a PWA. /api/* is always fetched live — checklists and tasks
// are shared, so a cached response would show stale/wrong data to other
// people using the app.

const CACHE_NAME = "notice-board-shell-v2";

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
