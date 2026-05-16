/* Chaptr — V4 polish: PWA service worker.
   Strategy: network-first for navigations + scripts (so updates land
   without refresh tricks), cache-first for static assets like fonts
   and images. Backend calls (Cloudflare Worker) are NEVER cached so
   sync stays correct. */

const CACHE_NAME = 'chaptr-v1';
const APP_SHELL = [
  '/chaptr/',
  '/chaptr/today.html',
  '/chaptr/library.html',
  '/chaptr/shelves.html',
  '/chaptr/profile.html',
  '/chaptr/styles.css',
  '/chaptr/app.js',
  '/chaptr/manifest.json',
  '/chaptr/icon.svg',
];

self.addEventListener('install', (event) => {
  // Fresh install: pre-cache the app shell so first-offline-load works.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch(() => {}) // ignore individual misses
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Drop any stale caches from older SW versions.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache:
  //  - non-GET requests
  //  - cross-origin (Cloudflare Worker, Clerk, OpenLibrary, Anthropic)
  //  - URLs explicitly opted out via ?nocache
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.searchParams.has('nocache')) {
    return; // let browser handle, no caching
  }

  // Network-first for HTML and JS so updates land naturally.
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(req).then((resp) => {
        // Mirror the latest into cache for offline fallback.
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (CSS, fonts, icons).
  event.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return resp;
      })
    )
  );
});
