/*
 * Service worker for the Patient Journey Tracker.
 *
 * Caching strategy is deliberately conservative. A queue position that is two
 * minutes stale is worse than no queue position at all — a patient who reads
 * "you are next" from a cache and misses their turn is exactly the failure this
 * product exists to prevent.
 *
 * So: the app shell is cached so the tracker opens instantly and survives a
 * dropped connection, but everything that carries queue state goes to the
 * network first and falls back to cache only with the page able to say the data
 * is stale.
 */
const VERSION = "qman-tracker-v1";
const SHELL = ["/track.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      // A failed precache must not block activation; the app still works online.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a returning patient gets current markup,
  // cache as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put("/track.html", copy));
          return response;
        })
        .catch(() => caches.match("/track.html").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Static build assets are content-hashed, so cache-first is safe and makes
  // the tracker open instantly on a slow hospital connection.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});

/* Lets the page activate a waiting worker without a manual reload. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
