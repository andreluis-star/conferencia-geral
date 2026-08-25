// ============================================================
//  CONFERÊNCIA GERAL — Service Worker
//  Estratégia: NETWORK-FIRST para HTML e JS (sempre pega a
//  versão mais nova quando há internet; cache só como reserva
//  offline). Cache-first apenas para imagens/manifest.
//
//  >>> A CADA DEPLOY, incremente SW_VERSION abaixo. <<<
//  Isso garante que o app detecte "nova atualização" e limpe
//  os caches antigos.
// ============================================================
const SW_VERSION  = '2026.08.25-4';
const CACHE_NAME  = 'conferencia-' + SW_VERSION;

// Recursos "pesados" que quase não mudam — seguro manter em cache
const CORE_ASSETS = [
  'manifest.json',
  'logo%20portoex.png',
  'icon-192.png',
  'icon-512.png',
  'icon-180.png',
  'icon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS).catch(e => {
      console.warn('[SW] Cache parcial dos assets:', e);
    }))
  );
  // NÃO ativa sozinho — espera o usuário confirmar (botão "Atualizar")
  // ou o comando SKIP_WAITING enviado pela página.
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A página pode mandar o SW assumir imediatamente (ao tocar em "Atualizar")
self.addEventListener('message', event => {
  const d = event.data;
  if (d === 'SKIP_WAITING' || (d && d.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // Sempre online — não intercepta Firebase / Google / planilhas
  if (url.includes('firebaseapp.com') || url.includes('googleapis.com') ||
      url.includes('gstatic.com')     || url.includes('firebaseio.com') ||
      url.includes('docs.google.com') || url.includes('google.com/spreadsheets')) {
    return;
  }

  const ehConteudoApp = req.mode === 'navigate' ||
                        url.endsWith('.html') || url.endsWith('.js');

  if (ehConteudoApp) {
    // NETWORK-FIRST: tenta a rede, atualiza o cache, e usa o cache só se estiver offline
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('conferente.html')))
    );
    return;
  }

  // CACHE-FIRST para o restante (imagens, manifest, ícones)
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }))
  );
});
