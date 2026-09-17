/* 取件助手 · Service Worker：缓存页面壳，支持离线打开 */
var VERSION = '1.2.0';
var CACHE = 'pickup-' + VERSION;
var SHELL = [
  './',
  './index.html',
  './styles.css?v=' + VERSION,
  './app.js?v=' + VERSION,
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function cachePut(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.pathname.indexOf('/api/') === 0) return;
  if (e.request.method !== 'GET') return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(function (res) { return cachePut(e.request, res); })
        .catch(function () { return caches.match('./index.html').then(function (r) { return r || caches.match('./'); }); })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var network = fetch(e.request).then(function (res) { return cachePut(e.request, res); });
      if (cached) { e.waitUntil(network.catch(function () {})); return cached; }
      return network.catch(function () { return cached; });
    })
  );
});
