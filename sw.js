/*
 * Scroll & Stitch service worker: makes the app work offline after the
 * first visit. The build fills in VERSION and PRECACHE (every file the app
 * needs; see vite.config.ts). Nothing the user picks ever passes through
 * here: videos and images are read straight from the device.
 *
 * - Install: cache the whole app.
 * - Pages: network first (so updates arrive), cached copy when offline.
 * - Everything else from this site: cache first (file names are hashed).
 */
const VERSION = "9ae8c85cb7d6";
const PRECACHE = [
  "./",
  "assets/element-BuKW98lC.js",
  "assets/harness-DMquivni.css",
  "assets/harness-DSaDvaDx.js",
  "assets/lab-B6EqpPSV.js",
  "assets/lab-C5tXtkUf.css",
  "assets/main-CgvTwc1n.css",
  "assets/main-ChpSz_yS.js",
  "assets/seek-source-DBj1FIN_.js",
  "assets/stitch.worker-Baps1D1k.js",
  "assets/synthetic-CD0bQSeT.js",
  "assets/webcodecs-source-ir0Vp6Nf.js",
  "assets/webcodecs-zJ7HkTke.js",
  "harness.html",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "index.html",
  "lab.html",
  "manifest.webmanifest"
];
const CACHE = `sas-${VERSION}`;
// Files are content-hashed and never change, so ignore Vary headers (a
// server's "Vary: Origin" or "Accept-Encoding" must not cause a miss offline).
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sas-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Share target (Phase 3): files shared to the installed app from another
// app (Android, some desktop browsers; not iOS Safari) arrive here as a POST.
// They are kept briefly in a cache on this device, then the app opens and
// picks them up. Nothing leaves the device.
const SHARE = 'sas-share';
async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => typeof f === 'object' && 'name' in f);
  await caches.delete(SHARE);
  const cache = await caches.open(SHARE);
  await Promise.all(
    files.map((f, i) =>
      cache.put(`./shared/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name), 'x-modified': String(f.lastModified || Date.now()) } })),
    ),
  );
  return Response.redirect(`./?shared=${files.length}`, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req).catch(() => Response.redirect('./?shared=0', 303)));
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Bundled test videos stay network-only: they are large and debug-only.
  if (url.pathname.includes('/samples/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put(url.pathname, copy));
          return res;
        })
        .catch(async () => (await caches.match(url.pathname, MATCH)) ?? (await caches.match('./', MATCH)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(req, MATCH).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
