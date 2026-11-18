// Service worker: only handles push notifications (no offline caching, so updates always show).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let n = { title: 'Secret Santa 🎅', body: 'You have something new! Tap to open.', url: '/#home' };
    try {
      const res = await fetch('/api/notifications/latest', { credentials: 'include', cache: 'no-store' });
      if (res.ok) { const j = await res.json(); if (j && j.title) n = j; }
    } catch (e) { /* show the generic one */ }
    await self.registration.showNotification(n.title, { body: n.body, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: n.url || '/' } });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.navigate(url).catch(() => {}); return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
