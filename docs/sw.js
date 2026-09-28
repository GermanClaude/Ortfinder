// Minimal service worker: only there so Ortfinder can show a notification when an analysis finishes
// (Android shows page notifications only through a service worker). It caches nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = windows.find((w) => w.url.includes(self.registration.scope)) || windows[0];
    if (page) return page.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
