const CACHE = 'malote-leitor-v28';
const ASSETS = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './parceiros/assets/supabase-client.js', './parceiros/assets/supabase-js-2.119.2.js'];
// Bibliotecas externas que o app precisa pra abrir SEM internet (versões fixas na URL,
// então é seguro guardar). Se algum falhar na instalação, o resto continua.
const CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/7.0.0/tesseract.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS).then(function () {
        var baixando = Promise.all(CDN_PRECACHE.map(function (url) {
          return fetch(new Request(url, { mode: 'no-cors' })).then(function (res) { return cache.put(url, res); }).catch(function () { /* melhor esforço */ });
        }));
        // não deixa uma biblioteca lenta atrasar a instalação do app
        return Promise.race([baixando, new Promise(function (resolve) { setTimeout(resolve, 8000); })]);
      });
    })
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

// Rede primeiro (uma versão nova do site nunca fica escondida); se estiver sem
// internet — ou a rede demorar demais (Wi-Fi sem sinal) — usa a cópia guardada.
function redePrimeiro(req, espera, ignorarBusca) {
  return caches.open(CACHE).then(function (cache) {
    var rede = fetch(req).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    var limite = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, espera); });
    return Promise.race([rede.catch(function () { return null; }), limite]).then(function (res) {
      if (res) return res;
      return cache.match(req, { ignoreSearch: !!ignorarBusca }).then(function (c) {
        if (c) return c;
        if (ignorarBusca) return cache.match('./index.html');
        return rede;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var mesmaOrigem = url.origin === self.location.origin;
  // Supabase, Mercado Pago etc.: nunca mexe (sempre direto na rede).
  if (!mesmaOrigem && CDN_HOSTS.indexOf(url.hostname) < 0) return;

  if (mesmaOrigem && (req.mode === 'navigate' || url.pathname.endsWith('/index.html'))) {
    event.respondWith(redePrimeiro(req, 6000, true));
    return;
  }
  if (mesmaOrigem) {
    event.respondWith(redePrimeiro(req, 4000, false));
    return;
  }
  // Bibliotecas e fontes externas: cópia guardada primeiro, rede se ainda não tiver.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        var copia = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copia); });
        return res;
      });
    })
  );
});
