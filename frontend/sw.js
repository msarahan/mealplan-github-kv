// Service worker: keeps the app shell available offline.
// Data (plan, recipes, checks) is cached by the page itself in localStorage, so
// API requests pass straight through here.
importScripts('/version.js');

var SHELL_CACHE = 'nourish-shell-' + (self.__VERSION__ || 'dev');
var FONT_CACHE  = 'nourish-fonts';
var SHELL = ['/', '/version.js', '/manifest.json', '/icon.svg'];
var NETWORK_TIMEOUT_MS = 3000;  // on weak signal (e.g. in a store), fall back to cache quickly

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== FONT_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Network first so online users always get the latest deploy; cache if the
// network fails or is too slow. Only plain 200 same-origin responses are cached,
// never Cloudflare Access login redirects.
function networkFirst(request, cacheKey) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    var network = fetch(request).then(function (res) {
      if (res.ok && res.type === 'basic' && !res.redirected) cache.put(cacheKey, res.clone());
      return res;
    });
    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        cache.match(cacheKey).then(function (hit) { if (hit) resolve(hit); });
      }, NETWORK_TIMEOUT_MS);
    });
    var fallback = network.catch(function () {
      return cache.match(cacheKey).then(function (hit) { return hit || Response.error(); });
    });
    return Promise.race([fallback, timeout]);
  });
}

function cacheFirst(request) {
  return caches.open(FONT_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      return hit || fetch(request).then(function (res) {
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Any page load (/, /?family=x&tab=grocery) is the single-page app
  if (req.mode === 'navigate') { event.respondWith(networkFirst(req, '/')); return; }
  if (SHELL.indexOf(url.pathname) >= 0) { event.respondWith(networkFirst(req, url.pathname)); return; }
});
