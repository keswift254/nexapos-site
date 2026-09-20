const CACHE_PREFIX = 'nexapos-web-';
const CACHE_NAME = CACHE_PREFIX + 'a5bff66a4b07e6e3b491';
const PRECACHE_URLS = ["./.last_build_id","./assets/AssetManifest.bin","./assets/AssetManifest.bin.json","./assets/FontManifest.json","./assets/fonts/MaterialIcons-Regular.otf","./assets/NOTICES","./assets/packages/cupertino_icons/assets/CupertinoIcons.ttf","./assets/packages/esc_pos_utils_plus/resources/capabilities.json","./assets/packages/material_ui/shaders/ink_sparkle.frag","./assets/shaders/ink_sparkle.frag","./assets/shaders/stretch_effect.frag","./canvaskit/canvaskit.js","./canvaskit/canvaskit.wasm","./canvaskit/chromium/canvaskit.js","./canvaskit/chromium/canvaskit.wasm","./drift_worker.js","./favicon.png","./flutter.js","./flutter_bootstrap.js","./icons/Icon-192.png","./icons/Icon-512.png","./icons/Icon-maskable-192.png","./icons/Icon-maskable-512.png","./index.html","./main.dart.js","./manifest.json","./sqlite3mc.wasm","./version.json"];
const INDEX_URL = new URL('index.html', self.registration.scope).toString();

async function precacheApplication() {
  const cache = await caches.open(CACHE_NAME);
  // Avoid asking mobile Safari to fetch the entire application concurrently.
  for (let index = 0; index < PRECACHE_URLS.length; index += 20) {
    // cache: 'reload' bypasses the browser's own HTTP cache. GitHub Pages lets files be
    // cached for 10 minutes, so without this a visitor who loaded the OLD version a few
    // minutes before a deployment would have the old files copied into the NEW cache
    // version and stay on stale code until the next release.
    await cache.addAll(
      PRECACHE_URLS.slice(index, index + 20).map((url) => new Request(url, { cache: 'reload' })),
    );
  }
  await self.skipWaiting();
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheApplication());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function fetchNavigation(request) {
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('offline')), 3000)),
    ]);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(INDEX_URL, { ignoreSearch: true });
    if (cached) return cached;
    throw _;
  }
}

async function fetchApplicationFile(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    event.request.mode === 'navigate'
      ? fetchNavigation(event.request)
      : fetchApplicationFile(event.request),
  );
});
