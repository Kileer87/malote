// Service worker do painel do síndico — hoje só cuida de receber e mostrar
// as notificações push do lembrete de agenda (1 dia antes de cada evento).
// Precisa de escopo próprio ('/sindico/') porque o service worker
// compartilhado do portal do morador/colaborador (sw-parceiros.js) só cobre
// '/parceiros/'.
const CACHE = 'malote-sindico-v1';
const ASSETS = [
  '/sindico/painel.html',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); }).catch(function () { /* melhor esforço */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function () { return caches.match('/sindico/painel.html'); })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request).catch(function () { return cached; });
    })
  );
});

self.addEventListener('push', function (event) {
  var dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (e) {
    dados = { title: 'Malote', body: event.data ? event.data.text() : 'Você tem uma novidade.' };
  }

  var titulo = dados.title || 'Malote';
  var opcoes = {
    body: dados.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: dados.url || '/sindico/painel.html' },
  };

  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var destino = (event.notification.data && event.notification.data.url) || '/sindico/painel.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].url.indexOf(destino) !== -1 && 'focus' in lista[i]) return lista[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(destino);
    })
  );
});
