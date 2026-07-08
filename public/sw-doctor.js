// ChemoCure Pro (Doctor) — service worker.
// Strategy:
//   - App shell (HTML/JS/icons): cache-first, so the app opens offline.
//   - API calls (/api/*): NEVER cached (PHI must always be fresh + server-authorized).
//   - Everything else (fonts, CDN libs): stale-while-revalidate.

const CACHE = 'chemocure-doctor-v1';
const SHELL = [
  '/',
  '/index.html',
  '/api-client.js',
  '/doctor.webmanifest',
  '/icons/doctor-192.png',
  '/icons/doctor-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('chemocure-doctor-') && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API or auth traffic. Always go to network.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell + same-origin GET: cache-first, fall back to network.
  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached ||
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Cross-origin (fonts, CDN): stale-while-revalidate.
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
