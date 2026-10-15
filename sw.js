'use strict';

/**
 * PWA 离线缓存:核心资源 cache-first,更新靠版本号(改代码时手动 +1)。
 */

const VERSION = 'wordmate-v12';
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/srs.js',
  'js/base-map.js',
  'js/store.js',
  'js/app.js',
  'js/study.js',
  'js/views/library.js',
  'js/views/learn.js',
  'js/views/quiz.js',
  'js/views/stats.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/cfb-1442.txt',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        // 运行时缓存同源 GET,保证添加到主屏幕后离线全可用
        if (res.ok && new URL(e.request.url).origin === self.location.origin) {
          const clone = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('index.html'));
    }),
  );
});
