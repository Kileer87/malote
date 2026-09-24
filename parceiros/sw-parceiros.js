// Service worker compartilhado do portal do morador e do portal do
// colaborador — cuida do cache básico (pra poder instalar como app) e,
// principalmente, de receber e mostrar as notificações push de "chegou
// encomenda". Antes existiam dois arquivos separados (sw-morador.js e
// sw-colaborador.js), mas os dois registravam no mesmo escopo
// ('/parceiros/', que é o máximo permitido já que os dois HTMLs vivem na
// mesma pasta) — então só o registrado por último de fato controlava a
// pasta inteira, o outro ficava "pisado". Unificar num script só resolve
// isso de vez: os dois portais registram este mesmo arquivo.
const CACHE = 'malote-parceiros-v1';
const ASSETS = [
  '/parceiros/portal-morador.html',
  '/parceiros/portal-colaborador.html',
  '/parceiros/manifest-morador.json',
  '/parceiros/manifest-colaborador.json',
  '/parceiros/assets/estilo.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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

  // Navegação: rede primeiro (pra nunca mostrar uma versão velha da tela).
  // Se estiver offline, cai pro portal certo — morador ou colaborador,
  // conforme a própria URL que a pessoa tentou abrir.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(function () {
        var destino = event.request.url.indexOf('portal-colaborador.html') !== -1
          ? '/parceiros/portal-colaborador.html'
          : '/parceiros/portal-morador.html';
        return caches.match(destino);
      })
    );
    return;
  }

  // Estáticos: cache primeiro, rede como reforço.
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
    // a URL de destino sempre vem no próprio aviso (definida no servidor,
    // em push-notificar-novo, conforme é morador ou colaborador) — o
    // service worker nunca precisa "adivinhar" qual portal é.
    data: { url: dados.url || '/parceiros/portal-morador.html' },
  };
  // foto da etiqueta, quando quem recebeu tirou uma — Android mostra a
  // imagem grande na notificação; iOS ignora esse campo silenciosamente.
  if (dados.image) opcoes.image = dados.image;

  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var destino = (event.notification.data && event.notification.data.url) || '/parceiros/portal-morador.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if (lista[i].url.indexOf(destino) !== -1 && 'focus' in lista[i]) return lista[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(destino);
    })
  );
});
