// Minimal service worker — enables PWA installability ("Add to Home Screen").
// Network-first passthrough; caching strategy can be expanded later (Workbox).
const CACHE = 'walfia-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through; offline shell caching can be added here when needed.
  if (event.request.method !== 'GET') return;
});
