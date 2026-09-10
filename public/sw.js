// Offline shell only. The API is never cached -- a stale Today page would be
// worse than no page, and the archive is the thing that must stay truthful.
const CACHE = 'neatinfo-shell-v2';

// Only files that exist unconditionally. The React bundle is content-hashed by
// Vite, so its name is not knowable here; it is picked up by the runtime
// stale-while-revalidate below on the first online visit instead.
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not fail the whole install -- that is what the
      // stale list of the pre-React frontend used to do.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      // `not_found_handling = "single-page-application"` means every route is
      // served by the shell at '/', so that is the offline fallback.
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/')))
  );
});
