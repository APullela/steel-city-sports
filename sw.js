/*
 * Service worker: lets the installed app open even with no connection.
 * The app's own files are fetched fresh from the network when possible
 * (so updates show up straight away) and served from the cache when offline.
 * Sports data is never cached here; the app keeps its own last-good copies.
 */
const CACHE = 'scs-shell-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/api.js', 'js/ui.js', 'js/odds.js', 'js/views-team.js', 'js/views-game.js', 'js/calendar.js', 'js/playoffs.js', 'js/main.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // only the app's own files; API calls and team logos go straight to the network
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
