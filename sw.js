/*
 * Service worker: makes the app open instantly, offline, and without
 * re-downloading itself.
 * - The app's own files and fonts are served from the cache. The browser
 *   checks this file for changes when the app opens; changing VERSION below
 *   makes it fetch the new files once, in the background.
 * - Team logos and player photos from ESPN are kept too (up to MAX_IMAGES),
 *   so each one downloads only once.
 * - Sports data isn't handled here; the app keeps its own saved copies.
 * - Every download is reported to the page for the "data used" meter.
 */
const VERSION = 'v4';
const SHELL_CACHE = `scs-shell-${VERSION}`;
const IMG_CACHE = 'scs-img';
const MAX_IMAGES = 160; // about 0.6 MB
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/api.js', 'js/ui.js', 'js/odds.js', 'js/views-team.js', 'js/views-game.js', 'js/calendar.js', 'js/playoffs.js', 'js/main.js',
  'fonts/big-shoulders.woff2', 'fonts/barlow-400.woff2', 'fonts/barlow-600.woff2',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

async function report(res) {
  const bytes = +res.headers.get('Content-Length') || 0;
  if (!bytes) return;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ bytes }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map(async (path) => {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      report(res.clone());
      await cache.put(path, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('scs-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function fromNetwork(req, cacheName) {
  const res = await fetch(req);
  report(res.clone());
  if (res.ok && res.type !== 'opaque') {
    const cache = await caches.open(cacheName);
    await cache.put(req, res.clone());
    if (cacheName === IMG_CACHE) {
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMAGES)).map((k) => cache.delete(k)));
    }
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ESPN images (resized, CORS): cache first
  if (url.hostname === 'a.espncdn.com' && req.mode === 'cors') {
    event.respondWith(caches.open(IMG_CACHE).then((c) => c.match(req)).then((hit) => hit || fromNetwork(req, IMG_CACHE)));
    return;
  }
  // the app's own files: cache first (they change only with VERSION); sports data passes through
  if (url.origin !== self.location.origin || url.pathname.includes('/api')) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
    if (hit) return hit;
    try { return await fromNetwork(req, SHELL_CACHE); } catch (e) { return cache.match('index.html'); }
  })());
});
