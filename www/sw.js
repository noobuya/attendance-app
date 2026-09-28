const C = 'att-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'vendor/chart.umd.js', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(FILES))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));
