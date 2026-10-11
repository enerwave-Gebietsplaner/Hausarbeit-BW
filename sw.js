// Hauskarte BW – Offline-Speicher (Service Worker)
const APP = 'hauskarte-app-v22';
const TILES = 'hauskarte-tiles-v1';
const MAX_TILES = 3000;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
const LIBS = [];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    await c.addAll(SHELL);
    await Promise.all(LIBS.map(u => fetch(u, { mode: 'cors' }).then(r => r.ok && c.put(u, r)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

let puts = 0;
async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App selbst: zuerst Netz (damit Updates sofort ankommen), offline aus dem Speicher
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) { const c = await caches.open(APP); c.put(req, res.clone()); }
        return res;
      } catch (err) {
        return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
      }
    })());
    return;
  }

  // Kartenbibliothek: aus dem Speicher
  if (LIBS.includes(req.url)) {
    e.respondWith(caches.match(req.url).then(r => r || fetch(req).then(res => {
      if (res.ok) caches.open(APP).then(c => c.put(req.url, res.clone()));
      return res;
    })));
    return;
  }

  // Kartenkacheln: bis 14 Tage aus dem Speicher, sonst Netz; offline immer aus dem Speicher
  if (TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      const age = hit ? Date.now() - Date.parse(hit.headers.get('date') || 0) : Infinity;
      if (hit && age < 14 * 864e5) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type !== 'opaque') {
          c.put(req, res.clone());
          if (++puts % 100 === 0) trimTiles();
        }
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
  }
});
