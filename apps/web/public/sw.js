/* global self, caches */
// The buyer site's service worker (PWA level: installable shell + a real offline page; no offline
// browsing of data). Hand-written, no dependency. Tests load this file in a vm sandbox
// (apps/web/test/service-worker.spec.ts); the rules below are the single source.
//
// CACHING RULES
//   precache   /offline (fetched anonymously, without cookies) + the /_next/static/ files it names
//              + the icons. Install fails if any is missing, so a half-saved offline page is never used.
//   navigation network-first. Only when the network fails is the cached /offline served. No other
//              HTML is ever stored.
//   /_next/static/  same-origin GET, cache-first (files are content-hashed), cache name has the version.
//   everything else is not touched (the browser handles it): non-GET, cross-origin (Stripe...),
//              /api/*, requests with an Authorization header, and the account, cart, checkout and
//              payment routes (also never answered from cache even if listed above).
// UPDATE: no skipWaiting. A new version waits until the old tabs close; the version is the build
// id in this script's URL (?v=), so every deploy installs fresh caches and activate deletes the old ones.

const rawVersion = new URL(self.location.href).searchParams.get('v') || '';
// Constant fallback when the build id is missing; bump it by hand if sw.js changes without a deploy id.
const VERSION = /^[A-Za-z0-9._-]{1,64}$/.test(rawVersion) ? rawVersion : 'v1';
const PREFIX = 'mp-web-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const STATIC_CACHE = `${PREFIX}static-${VERSION}`;

const OFFLINE_URL = '/offline';
const PRECACHE_FILES = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
];
const NEVER_PREFIXES = ['/api/', '/account', '/cart', '/checkout', '/payment', '/login', '/sell'];

function isNever(pathname) {
  return NEVER_PREFIXES.some(
    (p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p.endsWith('/') ? p : p + '/'),
  );
}

/** What to do with a request: 'navigate' | 'static' | 'ignore'. */
function decide(request) {
  if (request.method !== 'GET') return 'ignore';
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return 'ignore';
  }
  if (url.origin !== self.location.origin) return 'ignore';
  if (request.headers.has('authorization')) return 'ignore';
  if (request.mode === 'navigate') return 'navigate';
  if (isNever(url.pathname)) return 'ignore';
  if (url.pathname.startsWith('/_next/static/')) return 'static';
  return 'ignore';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // credentials omit: the saved page is the anonymous one, never a signed-in buyer's.
      const page = await fetch(OFFLINE_URL, { credentials: 'omit', cache: 'reload' });
      if (!page.ok) throw new Error('offline page unavailable');
      const html = await page.clone().text();
      const assets = new Set(html.match(/\/_next\/static\/[^"'\s\\)<>]+/g) || []);
      const staticCache = await caches.open(STATIC_CACHE);
      await Promise.all(
        [...assets].map(async (asset) => {
          const response = await fetch(asset, { credentials: 'omit' });
          if (!response.ok) throw new Error('asset unavailable');
          await staticCache.put(asset, response);
        }),
      );
      await Promise.all(
        PRECACHE_FILES.map(async (file) => {
          const response = await fetch(file, { credentials: 'omit' });
          if (!response.ok) throw new Error('icon unavailable');
          await cache.put(file, response);
        }),
      );
      await cache.put(OFFLINE_URL, page);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const action = decide(request);
  if (action === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const saved = await caches.open(SHELL_CACHE).then((c) => c.match(OFFLINE_URL));
        return saved || Response.error();
      }),
    );
  } else if (action === 'static') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        // Only a complete, plain 200 is stored (no opaque, partial or error responses).
        if (response.status === 200 && response.type === 'basic') {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
