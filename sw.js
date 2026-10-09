// Service Worker for Dogo POS PWA
const CACHE_NAME = 'dogo-pos-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/dashboard.html',
  '/sell.html',
  '/catalog.html',
  '/purchases.html',
  '/inventory.html',
  '/expenses.html',
  '/reports.html',
  '/settings.html',
  '/restaurant.html',
  '/assets/css/theme.css',
  '/assets/js/dogo-data.js',
  '/assets/js/app-shell.js',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('PWA cache addAll error:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Network first, fallback to cache for offline resilience
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
