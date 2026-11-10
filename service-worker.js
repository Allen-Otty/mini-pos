const CACHE_NAME = "dogo-pos-cache-v64";
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
  "./invoices.html",
  "./invoice.html",
  "./loans.html",
  "./purchases.html",
  "./reports.html",
  "./settings.html",
  "./team.html",
  "./assets/css/theme.css",
  "./assets/js/app-shell.js",
  "./assets/js/dogo-data.js",
  "./assets/js/dogo-helper.js",
  "./assets/js/plan-catalog.js",
  "./assets/js/landing-cms.js",
  "./assets/js/biz-profiles.js",
  "./assets/js/inventory-extras.js",
  "./assets/js/subscription-guard.js",
  "./assets/js/kitchen-store.js",
  "./assets/js/receipt-format.js",
  "./assets/js/hardware.js",
  "./assets/js/invoice-parse.js",
  "./assets/js/invoice-scan.js",
  "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512-any.png",
  "./icons/favicon-32.png",
  "./icons/favicon-48.png",
  "./icons/apple-touch-icon.png",
  "./images/dogo-logo.png",
  "./images/dogo-mark.png",
  "./images/dogo-mark-sm.png",
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

// Speed strategy:
//  - No connection: answer straight from the cache (no waiting on a network that is not there).
//  - Static files (scripts, styles, icons, images, CDN libraries, fonts): cache first, refreshed quietly in the
//    background, so every page opens instantly even on a weak "lie-fi" signal. A new release bumps CACHE_NAME,
//    which re-downloads all of them, so updates still arrive.
//  - Pages (HTML) and everything else: network first so changes show up, but give up after 1.5s and use the cache.
// Supabase calls, backend /api/ endpoints and payment gateways are never intercepted - the app handles those itself.
const NETWORK_TIMEOUT_MS = 1500;
const STATIC_RE = /\/(assets|icons|images)\/|fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|\.(png|jpe?g|svg|webp|ico|woff2?)(\?|$)/i;

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

  const store = (response) => {
    if (response && (response.status === 200 || response.type === "opaque")) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
    }
    return response;
  };

  // 1) Offline: cache straight away.
  if (self.navigator && self.navigator.onLine === false) {
    event.respondWith(fromCache());
    return;
  }

  // 2) Static files: cache first, refresh in the background.
  if (req.mode !== "navigate" && STATIC_RE.test(url)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) => {
        const refresh = fetch(req, { cache: "no-store" }).then(store).catch(() => null);
        if (hit) { event.waitUntil(refresh); return hit; }
        return refresh.then((r) => r || Response.error());
      })
    );
    return;
  }

  // 3) Pages and the rest: network first, fall back to the cache quickly.
  event.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        fromCache().then((hit) => { if (!settled && hit && hit.type !== "error") { settled = true; resolve(hit); } });
      }, NETWORK_TIMEOUT_MS);

      fetch(req, { cache: "no-store" })
        .then((response) => {
          clearTimeout(timer);
          store(response);
          if (!settled) { settled = true; resolve(response); }
        })
        .catch(() => {
          clearTimeout(timer);
          if (!settled) { settled = true; fromCache().then(resolve); }
        });
    })
  );
});
