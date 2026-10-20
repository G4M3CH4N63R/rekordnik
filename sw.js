const CACHE = "rekordnik-v1.5.0";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});
self.addEventListener("message", (e) => { if (e.data === "skip") self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// HTML: nejdřív síť, cache je záloha pro offline. Ostatní vlastní soubory z cache, obnova na pozadí.
// Cizí adresy (server, fonty, knihovna pro Excel) service worker nechává být.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const jeHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (jeHTML) {
    e.respondWith(
      fetch(req).then((res) => {
        const kopie = res.clone();
        caches.open(CACHE).then((c) => c.put("./index.html", kopie)).catch(() => {});
        return res;
      }).catch(() => caches.match("./index.html").then((hit) => hit || caches.match("./")))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const zeSite = fetch(req).then((res) => {
        const kopie = res.clone();
        caches.open(CACHE).then((c) => c.put(req, kopie)).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || zeSite;
    })
  );
});

// Upozornění: zpráva přichází zašifrovaná ze serveru, zobrazí se a klepnutí otevře appku na záložce Rekordy.
self.addEventListener("push", (e) => {
  let z = {};
  try { z = e.data ? e.data.json() : {}; } catch (_) { z = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(z.title || "Rekordník", {
    body: z.body || "", tag: z.tag || undefined, icon: "icon-180.png", badge: "icon-180.png", data: { url: z.url || "./" }
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const cil = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((okna) => {
    for (const o of okna) if ("focus" in o) { o.navigate(cil).catch(() => {}); return o.focus(); }
    return self.clients.openWindow(cil);
  }));
});
