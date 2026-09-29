const CACHE_PREFIX = 'nexapos-web-';
const CACHE_NAME = CACHE_PREFIX + '7139059020987f48899b';
const PRECACHE_URLS = ["./assets/AssetManifest.bin","./assets/AssetManifest.bin.json","./assets/FontManifest.json","./assets/NOTICES","./assets/fonts/MaterialIcons-Regular.otf","./assets/packages/cupertino_icons/assets/CupertinoIcons.ttf","./assets/packages/esc_pos_utils_plus/resources/capabilities.json","./assets/packages/material_ui/shaders/ink_sparkle.frag","./assets/shaders/ink_sparkle.frag","./assets/shaders/stretch_effect.frag","./canvaskit/canvaskit.js","./canvaskit/canvaskit.wasm","./canvaskit/chromium/canvaskit.js","./canvaskit/chromium/canvaskit.wasm","./drift_worker.js","./favicon.png","./flutter.js","./flutter_bootstrap.js","./icons/Icon-192.png","./icons/Icon-512.png","./icons/Icon-maskable-192.png","./icons/Icon-maskable-512.png","./index.html","./main.dart.js","./manifest-ios.json","./manifest.json","./sqlite3mc.wasm","./version.json"];
const INDEX_URL = new URL('index.html', self.registration.scope).toString();

// index.html registers this worker as nexapos_service_worker.js?canvaskit=chromium (or =plain)
// after seeing which CanvasKit build this browser actually loaded. The other build is ~5-7 MB
// this browser will never use, so it is not downloaded. With no hint, both are cached.
const CANVASKIT_BUILD = new URL(self.location.href).searchParams.get('canvaskit');
const PRECACHE_FOR_THIS_BROWSER = PRECACHE_URLS.filter((url) => {
  if (CANVASKIT_BUILD === 'chromium') return !url.startsWith('./canvaskit/canvaskit.');
  if (CANVASKIT_BUILD === 'plain') return !url.startsWith('./canvaskit/chromium/');
  return true;
});

async function precacheApplication() {
  const cache = await caches.open(CACHE_NAME);
  // WebKit can abort one request in an otherwise healthy batch. Cache each
  // file independently and retry transient failures, preserving every file
  // that already succeeded instead of rolling the whole batch back.
  for (const url of PRECACHE_FOR_THIS_BROWSER) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const request = new Request(url, { cache: 'no-cache' });
        const response = await fetch(request);
        if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
        await cache.put(request, response);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 350));
        }
      }
    }
    if (lastError) throw lastError;
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
      fetch(request, { cache: 'no-store' }),
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
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
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

// Refresh only application assets. IndexedDB/OPFS (shop data), preferences and
// credentials are never touched. Stage all downloads before replacing the cache
// so a failed/offline update leaves the existing offline application usable.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'NEXAPOS_REFRESH') return;
  event.waitUntil((async () => {
    try {
      const entries = [];
      for (const path of PRECACHE_FOR_THIS_BROWSER) {
        const request = new Request(new URL(path, self.registration.scope));
        const response = await fetch(request, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        entries.push([request, response]);
      }
      const cache = await caches.open(CACHE_NAME);
      for (const [request, response] of entries) await cache.put(request, response);
      event.ports[0]?.postMessage({ ok: true });
    } catch (error) {
      event.ports[0]?.postMessage({ ok: false, error: String(error) });
    }
  })());
});
