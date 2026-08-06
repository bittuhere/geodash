/* ============================================================
   Geometry Dash - Service Worker  (INVISIBLE - no install prompt)
   - Caches the Unity build + audio BY PATH (tunnel-agnostic), so
     they download ONCE and load instantly forever (even offline).
   - The user does nothing; it registers itself automatically.
   ============================================================ */
const ASSET_CACHE = 'gd-assets-v1';
const SHELL_CACHE = 'gd-shell-v2';
const SHELL_ASSETS = ['./', './index.html', './dashboard.html', './game.html', './app.js', './theme.css'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  // precache the small app shell (best-effort, non-atomic)
  e.waitUntil(caches.open(SHELL_CACHE).then(function (c) {
    return Promise.all(SHELL_ASSETS.map(function (a) {
      return fetch(a, { cache: 'no-store' }).then(function (r) { if (r && r.ok) return c.put(a, r); }).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) { if (k !== ASSET_CACHE && k !== SHELL_CACHE) return caches.delete(k); }));
    await self.clients.claim();
  })());
});

function pathOf(url) { try { return new URL(url).pathname; } catch (e) { return url; } }
function sameOrigin(url) { try { return new URL(url).origin === self.location.origin; } catch (e) { return false; } }
function isAsset(p) { return p.indexOf('/Build/') === 0 || p.indexOf('/StreamingAssets/') === 0; }

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never cache POST / API writes
  const p = pathOf(req.url);

  // dynamic data -> straight to network, never cached
  if (p.indexOf('/api/') === 0 || p === '/config.json') return;

  // big game files -> cache-first, keyed by PATH (works across rotating tunnels)
  if (isAsset(p)) {
    e.respondWith((async function () {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(p);
      if (cached) return cached;                          // instant on every load after the first
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(p, res.clone());     // store by path, not host
        return res;
      } catch (err) {
        return cached || Response.error();                // offline fallback
      }
    })());
    return;
  }

  // app shell (same-origin HTML/JS/CSS) -> stale-while-revalidate (instant + fresh)
  if (sameOrigin(req.url) && /\.(?:html?|js|css|svg|png|jpe?g|woff2?|ico)$/.test(p)) {
    e.respondWith((async function () {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(function (res) { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(function () { return cached; });
      return cached || network;
    })());
    return;
  }
  // everything else: normal browser behavior
});
