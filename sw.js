const CACHE = 'sauvia-shell-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'sst.html', 'sst.js', 'sst.css', 'resp.js', 'resp.css'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

// ---------- Alertes push ----------
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  const urgent = d.kind === 'urgence';
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Sauvia', {
      body: d.body || '', tag: 'alert-' + (d.alert_id || 'x'), renotify: true,
      requireInteraction: urgent, vibrate: urgent ? [600, 200, 600, 200, 600, 200, 600] : [200],
      icon: 'icon.svg', badge: 'icon.svg', data: { alert_id: d.alert_id, kind: d.kind }
    });
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => c.postMessage({ type: 'alert', alert_id: d.alert_id }));
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.alert_id;
  const url = new URL('sst.html' + (id ? '#alert=' + id : ''), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.indexOf('sst.html') > -1);
    if (c) { c.postMessage({ type: 'alert', alert_id: id }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
