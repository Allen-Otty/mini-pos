const CACHE_NAME = "dogo-pos-cache-v15";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./sell.html",
  "./bills.html",
  "./tables.html",
  "./kitchen.html",
  "./orders.html",
  "./catalog.html",
  "./customers.html",
  "./dashboard.html",
  "./equity.html",
  "./expenses.html",
  "./fixedassets.html",
  "./inventory.html",
  "./loans.html",
  "./purchases.html",
  "./reports.html",
  "./settings.html",
  "./team.html",
  "./assets/css/theme.css",
  "./assets/js/app-shell.js",
  "./assets/js/dogo-data.js",
  "./assets/js/plan-catalog.js",
  "./assets/js/biz-profiles.js",
  "./assets/js/kitchen-store.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js",
  "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700;800&display=swap"
];

// Cache each file on its own: one missing/blocked file must not stop the whole offline cache from installing.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS_TO_CACHE.map((u) =>
        cache.add(new Request(u, { cache: "reload" })).catch(() => {})
      ))
    )
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

// Network-first (so updates always arrive when online), falling back to the cache when the
// network fails or is too slow to be useful (flaky "lie-fi"). Supabase calls, backend /api/
// endpoints and payment gateways are never intercepted - the app handles those itself.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = req.url;

  if (
    req.method !== "GET" ||
    url.includes("supabase.co") ||
    url.includes("/api/") ||
    url.includes("safaricom") ||
    url.includes("telegram.org")
  ) {
    return;
  }

  const fromCache = () =>
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === "navigate") return caches.match("./index.html");   // last resort: open the app shell
      return Response.error();
    });

  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        fromCache().then((hit) => { if (!settled && hit && hit.type !== "error") { settled = true; resolve(hit); } });
      }, NETWORK_TIMEOUT_MS);

      fetch(req, { cache: "no-store" })
        .then((response) => {
          clearTimeout(timer);
          if (response && (response.status === 200 || response.type === "opaque")) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          if (!settled) { settled = true; resolve(response); }
        })
        .catch(() => {
          clearTimeout(timer);
          if (!settled) { settled = true; fromCache().then(resolve); }
        });
    })
  );
});
