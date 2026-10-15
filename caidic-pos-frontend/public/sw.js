// sw.js — keeps the app itself loadable with the internet down. The data is
// already offline-first (IndexedDB and the outbox); this does the same for the
// page and its files, now that they come from GitHub Pages instead of this
// computer. Network first: online, every load gets the latest published
// version, and the saved copy is only used when the network fails. Calls to
// Supabase are another site's, so they're never touched.

const CACHE = 'rrc-pos-app';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fromNetwork(request).catch(() => fromCache(request)));
});

async function fromNetwork(request) {
  const response = await fetch(request);
  // A redirected page can't be replayed for a later visit, so it isn't kept.
  if (response.ok && !response.redirected) {
    try {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    } catch { /* out of space: still answer from the network */ }
  }
  return response;
}

async function fromCache(request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request, { ignoreSearch: true });
  if (saved) return saved;
  // Any page address in the app falls back to the app's page.
  if (request.mode === 'navigate') {
    const page = await cache.match(self.registration.scope);
    if (page) return page;
  }
  return Response.error();
}
