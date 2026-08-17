// KidCare 家長專區 Service Worker：接收推播、點擊開啟對應頁
// 不做離線快取（避免舊版頁面殘留），僅為 PWA 安裝與推播用。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'KidCare 托嬰中心', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/family.html' },
    tag: data.tag || 'kidcare'
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/family.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.includes('/family.html') && 'focus' in c) return c.focus();
    }
    return clients.openWindow(url);
  }));
});
