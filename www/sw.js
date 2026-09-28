// 인터넷이 되면 최신 파일을 받고, 안 되면 저장해 둔 파일로 실행합니다
const C = 'att-v2';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'vendor/chart.umd.js', 'icon.svg', 'apple-touch-icon.png', 'icon-512.png', 'manifest.webmanifest'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(C).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
