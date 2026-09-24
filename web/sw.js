// Point Hub's service worker. It caches NOTHING, and that is the point of it.
//
// The installed app knows exactly one address: the https tailnet name it was installed from. On
// the board's own Wi-Fi that name resolves to the board — unless the lookup never reaches the
// board's DNS (Android Private DNS or Chrome's Secure DNS set to a provider, a tablet sending DNS
// over mobile data because the Wi-Fi has no internet, the cable path, the house LAN). Then the app
// used to open on Chrome's "site can't be reached" page, with no way back to the address that
// still works: http://172.24.1.1:8890, the one on the QR and in the hall guide.
//
// So this worker wraps page loads, and only page loads: each goes straight to the network, as if
// the worker were not there; only when that fails does it answer, with a small page pointing at the
// plain address and a button to try again. The console and the API are never cached or even
// touched — /api/status, the probe, the icons all go past it — so the self-update (a new build in
// /api/status, then a reload) sees every deploy exactly as before. There is nothing here to go
// stale except this file, which the browser re-checks against the network on every launch.
//
// What it cannot help with: a certificate error. Chrome shows its warning page itself, before any
// worker runs. The board stops offering the https address once its cert has expired (see
// httpsOriginFromCert), and the hall guide covers the rest.

const FALLBACK = 'http://172.24.1.1:8890/'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  // Everything but a page load is left alone: no respondWith, so the browser fetches it itself.
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE_PAGE, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })))
})

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
<title>Point Hub — board not reached</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#fff;color:#0A0B0D;
    font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;box-sizing:border-box}
  main{max-width:520px;text-align:center}
  h1{font-size:24px;margin:0 0 8px}
  p{margin:0 0 20px;color:#5a606b}
  a,button{width:100%;min-height:52px;margin:0 0 12px;border-radius:12px;font:inherit;font-weight:800;
    box-sizing:border-box;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center}
  a{background:#0A34D6;color:#fff;border:0}
  button{background:transparent;color:#0A0B0D;border:1.5px solid #e3e5ea}
  code{font-size:14px}
</style></head>
<body><main>
  <h1>The board didn't answer here</h1>
  <p>The app couldn't reach the board by its secure address. The plain address still works on the board's
    Wi-Fi — the one on the QR code: <code>172.24.1.1:8890</code>.</p>
  <a href="${FALLBACK}">Open 172.24.1.1:8890</a>
  <button type="button" onclick="location.reload()">Try again</button>
</main></body></html>`
