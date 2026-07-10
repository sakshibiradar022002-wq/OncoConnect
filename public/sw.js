// ChemoCure service worker — served as both /sw-doctor.js and /sw-patient.js.
// Strategy:
//   - App shell (HTML/JS/icons): cache-first, so the app opens offline.
//   - API calls (/api/*): NEVER cached (PHI must always be fresh + server-authorized).
//   - Everything else (fonts, CDN libs): stale-while-revalidate.

const APP = self.location.pathname.includes('doctor') ? 'doctor' : 'patient';
const CACHE = `chemocure-${APP}-v2`;
const SHELL = APP === 'doctor'
  ? ['/', '/index.html', '/sync-client.js', '/doctor.webmanifest', '/icons/doctor-192.png', '/icons/doctor-512.png']
  : ['/patient.html', '/sync-client.js', '/patient.webmanifest', '/icons/patient-192.png', '/icons/patient-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(`chemocure-${APP}-`) && k !== CACHE).map((k) => caches.delete(k)))
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

  if (event.request.method !== 'GET') return;

  // Everything else: stale-while-revalidate — serve cache, refresh in background.
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
});
