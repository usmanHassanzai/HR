// Service worker — cache hashed Vite assets for faster repeat visits.
// HTML and API stay network-first so users always get fresh app shell.
const CACHE = 'scorr-assets-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Only cache fingerprinted build assets (safe to keep for a long time)
  const isHashedAsset =
    url.pathname.startsWith('/assets/') &&
    /\.[a-f0-9]{6,}\.(js|css|woff2?|png|svg|jpg|jpeg|webp)$/i.test(url.pathname);

  if (!isHashedAsset) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        void caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })(),
  );
});
