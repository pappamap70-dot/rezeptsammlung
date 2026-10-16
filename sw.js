// Service Worker der Rezeptsammlung: macht die App installierbar und startet sie auch ohne Verbindung zum NAS
const SHELL_CACHE = 'rezepte-shell-v14';
const IMG_CACHE = 'rezepte-img-v1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  const keep = [SHELL_CACHE, IMG_CACHE];
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Daten nie aus dem Speicher: Die App hält ihre Offline-Kopie selbst (IndexedDB) und muss erkennen können,
  // ob das NAS wirklich erreichbar ist.
  if (url.pathname.endsWith('/api.php')) return;

  // Bilder ändern sich nie (eindeutige Dateinamen) → aus dem Speicher
  if (url.pathname.includes('/images/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(IMG_CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // App-Dateien: sofort aus dem Speicher (unterwegs würde die Anfrage ans NAS sonst ins Leere laufen) und nebenbei
  // beim NAS nachfragen. Neue Versionen kommen über einen neuen Service Worker; die App lädt sich dann selbst neu.
  // no-cache: beim NAS nachfragen, ob sich die Datei geändert hat (sonst nimmt der Browser evtl. tagelang die alte)
  const net = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then(c => c.put(req, copy)); }
    return res;
  });
  e.waitUntil(net.catch(() => {}));
  e.respondWith(caches.match(req, { ignoreSearch: true })
    .then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
    .then(r => r || net)
    .catch(() => Response.error()));
});
