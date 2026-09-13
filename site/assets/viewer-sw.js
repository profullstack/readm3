/* The build fingerprints the whole shell. A new worker waits for the user so
 * updating never interrupts an editor, and older tabs keep their own version. */
const CACHE = "__CACHE_NAME__";
const ASSETS = __PRECACHE__;
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("readm3-viewer-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("message", (event) => {
  if (event.data === "activate") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.searchParams.has("doc")) return;
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && ["/viewer", "/viewer/"].includes(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) return response;
      } catch { /* Fall back to the complete cached application. */ }
      return await (await caches.open(CACHE)).match("/viewer") || Response.error();
    })());
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => await cache.match(url.pathname) || fetch(event.request)));
  }
});
