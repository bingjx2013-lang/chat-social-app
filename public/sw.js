/* MicroChat PWA shell cache. Never cache API, auth, uploads, or Socket.IO traffic. */
'use strict';
const CACHE_NAME = 'microchat-shell-v1';
const SHELL = ['/','/index.html','/style.css','/app.js','/countries.js','/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/uploads/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
