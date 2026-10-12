// Service Worker：アプリ本体をキャッシュして、電波が無くても開けるようにする。
// VERSION は index.html のスクリプトの ?v= と同じにする（tests で食い違いを検出）。
// 外部（Wikipedia など）の通信はここでは扱わない。同じオリジンのファイルだけを対象にする。
const VERSION = '0.10.14';
const CACHE = `ai-${VERSION}`;
const FILES = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  ...['normalize', 'db', 'terms', 'chat', 'wiki', 'passages', 'feedback', 'net', 'queue', 'backup', 'store', 'embed', 'llm', 'rag', 'growth', 'sentiment', 'vectors', 'hybrid', 'app'].map(
    (n) => `./js/${n}.js?v=${VERSION}`
  ),
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

// 古い版のキャッシュ（ai-0.7.0 のような名前）だけを消す。意味検索の本体など、他の保存先（ai-lib-1 など）は触らない
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => /^ai-\d+\.\d+\.\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 画面（index.html）：繋がるなら最新を取り、無理ならキャッシュ。更新が届くようにする
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // それ以外（版番号つきのJS・画像など）：キャッシュ優先
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
