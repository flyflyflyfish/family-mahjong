/* 果果麻将 · 推送 Service Worker (房间邀请离线提醒) */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { try { d = { body: e.data.text() }; } catch (_2) {} }
  e.waitUntil(self.registration.showNotification(d.title || '果果麻将', {
    body: d.body || '',
    tag: 'mj-invite',              // 同类邀请只保留最新一条
    renotify: true,                // 新邀请到来时重新提醒
    requireInteraction: false,
    badge: '/favicon.ico',
    data: { url: '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = (e.notification.data && e.notification.data.url) || '/';
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) { await c.focus(); return c.navigate(url).catch(() => c); }
    }
    return self.clients.openWindow(url);
  })());
});
