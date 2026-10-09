const CACHE_NAME = "dogo-pos-cache-v6";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./dashboard.html",
  "./sell.html",
  "./catalog.html",
  "./purchases.html",
  "./inventory.html",
  "./expenses.html",
  "./reports.html",
  "./settings.html",
  "./restaurant.html",
  "./customers.html",
  "./equity.html",
  "./loans.html",
  "./fixedassets.html",
  "./team.html",
  "./manifest.json",
  "./assets/css/theme.css",
  "./assets/js/dogo-data.js",
  "./assets/js/app-shell.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/dogo-pos.ico",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Add assets individually so one failing URL doesn't abort the entire cache
      for (const asset of ASSETS_TO_CACHE) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn("PWA precache skipped:", asset, err);
        }
      }
    })
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

// Cache strategies:
// - Never intercept Supabase, backend API, M-Pesa, or non-GET calls (managed by offline queue)
// - For HTML navigation requests: Network-first, fallback to cache, fallback to dashboard.html or index.html
// - For CSS/JS/images/fonts: Stale-while-revalidate or Network-first with cache fallback
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = req.url;

  if (
    url.includes("supabase.co") ||
    url.includes("/api/") ||
    url.includes("safaricom") ||
    url.includes("telegram.org") ||
    req.method !== "GET"
  ) {
    return;
  }

  // Handle navigation requests (loading an HTML page)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          // Fallback to dashboard or index
          const dash = await caches.match("./dashboard.html");
          if (dash) return dash;
          const idx = await caches.match("./index.html");
          if (idx) return idx;
          return caches.match("./");
        })
    );
    return;
  }

  // Static assets and script/stylesheet requests
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      // Return cached immediately if available, or wait for network
      return cachedResponse || fetchPromise;
    })
  );
});
