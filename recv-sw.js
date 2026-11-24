/* 接收端 Service Worker：网络优先，断网回缓存（保证离线也能收文件）
 * 编解码资源体积大，装一次就预缓存，避免手机每次冷启动重拉 wasm。
 */
var CACHE = 'cimbar-recv-v2';
var CORE = [
  './recv.html',
  './cimbar_js.2026-01-20T0312.js',
  './cimbar_js.2026-01-20T0312.wasm',
  './recv.2026-01-20T0312.js',
  './recv-worker.2026-01-20T0312.js',
  './zstd.2026-01-20T0312.js',
  './main.2026-01-20T0312.js',
  './duplex.js',
  './duplex-tx.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(CORE.map(function (u) {
        return c.add(u).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        return n === CACHE ? null : caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req);
    })
  );
});
