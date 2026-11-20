// Saves a copy of the app on the phone so it opens without internet.
// Online: always fetch the newest files and refresh the saved copy. Offline: use the saved copy.
const CACHE = 'piano-man-v2';
const FILES = ['./', 'index.html', 'app.js', 'songs.js', 'parsers.js', 'fingering.js', 'manifest.json', 'icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // 'no-cache' makes the browser check with the server each time, so one file can never be newer than another.
    fetch(e.request.url, { cache: 'no-cache' }).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
