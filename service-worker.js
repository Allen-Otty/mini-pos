const CACHE_NAME = "dogo-pos-cache-v1";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell (so updates load immediately when online).
// Falls back to cache when offline - lets the app still open and let a
// teller queue a sale locally even with no internet connection.
// Supabase API calls are left untouched (never intercepted) so live data
// requests always behave exactly as the app's own online/offline logic expects.
self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url.includes("supabase.co")) return; // let these pass straight through

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (event.request.method === "GET" && response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
