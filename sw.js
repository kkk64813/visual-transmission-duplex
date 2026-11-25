/* 网络优先 + 缓存兜底的 Service Worker
 *
 * 原来那版是「缓存优先」且写死了绝对路径 '/'，改一次文件用户永远看到旧版；
 * 现在改成：先请求线上，成功后顺手更新缓存；断网才回落到缓存。
 * 路径统一用相对写法 './'，这样根域名和 GitHub Pages 子目录两种部署都能用。
 */
var CACHE = 'cimbar-duplex-v5';
var CORE = ['./', './index.html', './duplex.html', './recv.html', './ultra.html', './merge.html', './encoder.html', './ultra-core.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(CORE.map(function (u) {
        return c.add(u).catch(function () { });   // 缺文件也不阻塞安装
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
  if (new URL(req.url).origin !== self.location.origin) return;   // 外域一律不碰

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (r) {
        return r || caches.match('./index.html');
      });
    })
  );
});
