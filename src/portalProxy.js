// The hall Wi-Fi's own login page, opened on the tablet but walked by the board.
//
//   tablet ──GET /hall-login/…──▶ board ──https──▶ login.pwlan.ch/…
//          ◀── the portal's page, links pointing back at /hall-login ──
//
// The scripted login in hallLogin.js knows the portal's Free-SMS flow exactly, so the first time
// the portal changes a form, or answers slower than the board will wait, the scorer is stuck with
// a board that has no internet and a card that cannot help. This is the way out that does not
// depend on our knowing the flow: the scorer sees the portal's real page and fills it in by hand.
// The REQUESTS still come from the board — the portal unlocks the device that logs in, and that
// has to be the board's MAC, not the tablet's. (The tablet's own browser cannot reach the portal
// at all: the board does not route the AP to its uplink.)
//
// It is an open door into the board's uplink, so it is held narrow:
//   - only the portal's origin, ever: the upstream URL is the portal origin plus the path the
//     tablet asked for. A redirect anywhere else is not followed; the scorer gets a page that says
//     the login looks done, and the uplink is checked.
//   - only for the tablet that asked, for ten minutes: a PIN-checked POST /api/uplink/portal opens
//     it for that address. Every other address gets a page telling it where to start.
//   - the portal's scripts run in a sandbox (CSP `sandbox`, no allow-same-origin). The pages are
//     served from the console's own origin, where the scorer PIN sits in localStorage; an opaque
//     origin means nothing a portal page runs can read it.
//   - the portal's cookies stay on the board, in one jar per opening. The tablet never sees them,
//     and the tablet's own cookies (none, today) never go upstream.
//   - the phone number travels in the POST bodies the page itself sends. Nothing here reads,
//     logs or keeps a body.
//
// When a page is the quota page ("Auto login is valid until …"), its date goes to the uplink
// state the card shows, exactly as after a scripted login.

import { CookieJar, parseValidUntil, PORTAL_URL } from './hallLogin.js'
import { log } from './logStore.js'

const plog = log.child('uplink')

export const PREFIX = '/hall-login'
const OPEN_MS = 10 * 60_000
const TIMEOUT_MS = 25_000
const MAX_BODY = 64 * 1024          // a login form is a few hundred bytes
const MAX_PAGE = 2 * 1024 * 1024    // a portal page is ~15 KB, its scripts a few hundred
const MAX_HOPS = 10
const UA = 'Mozilla/5.0 (X11; Linux aarch64; rv:128.0) Gecko/20100101 Firefox/128.0'
const TEXT = /^(text\/|application\/(javascript|x-javascript|json|xhtml\+xml))/i
// Request headers worth passing on. Everything else (the tablet's cookies, its Origin, Host…) is
// either the board's to set or nobody's business upstream.
const PASS = ['accept', 'accept-language', 'content-type', 'x-requested-with']

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const html = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Point every way a portal page can name the portal back at the proxy: absolute URLs (also
// JSON-escaped ones in inline scripts), and root-relative attributes and CSS urls. Already
// rewritten paths are left alone, so running it twice changes nothing.
export function rewrite(text, portalOrigin, prefix = PREFIX) {
  const host = esc(new URL(portalOrigin).host)
  const p = esc(prefix.slice(1))
  return String(text)
    .replace(new RegExp(`(?:https?:)?//${host}(?![\\w.-])`, 'gi'), prefix)
    .replace(new RegExp(`(?:https?:)?\\\\/\\\\/${host}(?![\\w.-])`, 'gi'), prefix.replace(/\//g, '\\/'))
    .replace(new RegExp(`\\b(href|src|action|formaction|data-url|data-action)(\\s*=\\s*)(["'])/(?!/|${p}(?:[/?#"']|$))`, 'gi'), (m, a, eq, q) => `${a}${eq}${q}${prefix}/`)
    .replace(new RegExp(`url\\(\\s*(["']?)/(?!/|${p}/)`, 'gi'), (m, q) => `url(${q}${prefix}/`)
}

// First thing in every proxied page: root-relative XHR / fetch / form targets set from script go
// through the proxy too, and a bar that leads back to the console.
const shim = (prefix) => `<script>(function(){var P=${JSON.stringify(prefix)};function f(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(P+"/")!==0&&u!==P?P+u:u}var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=f(u);return o.apply(this,arguments)};if(window.fetch){var g=window.fetch;window.fetch=function(u,i){return g.call(this,f(u),i)}}})();</script>`
const BAR = '<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 16px;background:#111827;color:#fff;font:15px/1.3 system-ui,sans-serif;box-shadow:0 -2px 8px rgba(0,0,0,.3)"><span>Hall Wi-Fi login — through the board</span><a href="/#settings" style="color:#fff;font-weight:700;text-decoration:underline">Back to Point Hub</a></div><div style="height:56px"></div>'

function inject(page, prefix) {
  const s = shim(prefix)
  const withShim = /<head[^>]*>/i.test(page) ? page.replace(/<head[^>]*>/i, (m) => m + s) : s + page
  return /<\/body>/i.test(withShim) ? withShim.replace(/<\/body>/i, BAR + '</body>') : withShim + BAR
}

// Our own pages (start, done, refused): plain, readable on a tablet, one way back.
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title>
<style>body{margin:0;font:18px/1.5 system-ui,sans-serif;background:#0f172a;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:560px;padding:24px}h1{font-size:24px;margin:0 0 12px}a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;text-decoration:none}</style>
</head><body><main><h1>${html(title)}</h1>${body}<br><a href="/#settings">Back to Point Hub</a></main></body></html>`
}

export class PortalProxy {
  // `uplink` is the Uplink (hallLogin.js): its detect() says where the portal wants this device to
  // start, and the quota page's date is recorded on it.
  constructor({ uplink, portalUrl, fetchImpl = null, now = () => Date.now(), openMs = OPEN_MS, timeoutMs = TIMEOUT_MS, prefix = PREFIX } = {}) {
    this.uplink = uplink
    portalUrl = portalUrl || PORTAL_URL // '' from an unset option, like hallLogin's
    this.origin = new URL(portalUrl).origin
    this.host = new URL(portalUrl).host.toLowerCase()
    this._fetch = fetchImpl || ((...a) => fetch(...a))
    Object.assign(this, { now, openMs, timeoutMs, prefix })
    this._open = null // { ip, until, jar }
  }

  // PIN already checked by the caller. A new opening is a new jar: nothing of an earlier login
  // (another scorer's half-finished one) carries over.
  open(ip) {
    this._open = { ip, until: this.now() + this.openMs, jar: new CookieJar(this.now) }
    plog.info('hall login page opened through the board', { ip, until: new Date(this._open.until).toISOString() })
    return { url: `${this.prefix}/`, until: new Date(this._open.until).toISOString() }
  }

  allowed(ip) {
    const o = this._open
    return !!(o && o.ip === ip && this.now() < o.until)
  }

  owns(pathname) { return pathname === this.prefix || pathname.startsWith(this.prefix + '/') }

  isPortal(u) {
    try { return new URL(u).host.toLowerCase() === this.host } catch { return false }
  }

  // A page the portal sent the browser to by script (`location = "/Partner/…"`) lands on the
  // console's root, not under the prefix. Sent from a proxied page — the Referer says so — it is
  // the portal's, and goes back where it belongs.
  stray(req, pathname, ip) {
    if (this.owns(pathname) || pathname.startsWith('/api/') || !this.allowed(ip)) return null
    let ref
    try { ref = new URL(String(req.headers.referer || '')) } catch { return null }
    return this.owns(ref.pathname) ? this.prefix + pathname : null
  }

  async handle(req, res, url, ip) {
    if (!this.allowed(ip)) {
      return this._send(res, 403, page('Open this from the console', '<p>The hall Wi-Fi login page opens from Point Hub: <b>Settings ▸ Hall internet ▸ Open the login page</b>. It stays open for ten minutes, for the tablet that opened it.</p>'))
    }
    // The portal's pages run in an opaque origin (the sandbox), so their XHR to us is cross-origin.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors(), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With, Accept', 'Access-Control-Max-Age': '600' })
      return res.end()
    }
    if (req.method !== 'GET' && req.method !== 'POST') return this._send(res, 405, 'method not allowed', 'text/plain; charset=utf-8')
    const rest = url.pathname.slice(this.prefix.length)
    if ((rest === '' || rest === '/') && !url.search) return this._start(res)
    const upstream = this.origin + (rest || '/') + url.search
    let body = null
    if (req.method === 'POST') body = await readRaw(req)
    return this._relay(req, res, upstream, body)
  }

  // Where to begin: wherever the portal sends this device. That carries the portal's sub-id for
  // the board; its front page is the fallback when the probe saw no portal at all.
  async _start(res) {
    let d = null
    try { d = this.uplink && this.uplink.login ? await this.uplink.login.detect() : null } catch { d = null }
    if (d && d.status === 'online') {
      return this._send(res, 200, page('The board is online', '<p>The hall Wi-Fi already lets the board out — there is nothing to log in to.</p>'))
    }
    const entry = d && d.status === 'portal' && d.entryUrl && this.isPortal(d.entryUrl) ? d.entryUrl : this.origin + '/'
    plog.info('hall login page: starting', { from: d && d.status === 'portal' ? 'the portal redirect' : 'the portal front page' })
    return this._redirect(res, this._local(entry))
  }

  _local(u) {
    const x = new URL(u, this.origin)
    return this.prefix + x.pathname + x.search + x.hash
  }

  async _relay(req, res, upstream, body) {
    const jar = this._open.jar
    const h = { 'User-Agent': UA }
    for (const k of PASS) if (req.headers[k]) h[k] = String(req.headers[k])
    if (!h['accept-language']) h['accept-language'] = 'en-GB,en;q=0.9'
    const cookie = jar.header(upstream)
    if (cookie) h.Cookie = cookie
    // The portal checks where a form came from; tell it what a browser on the portal would.
    let ref = null
    try { const r = new URL(String(req.headers.referer || '')); if (this.owns(r.pathname)) ref = this.origin + (r.pathname.slice(this.prefix.length) || '/') + r.search } catch { /* none */ }
    if (ref) h.Referer = ref
    if (req.method === 'POST') h.Origin = this.origin

    let r
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      r = await this._fetch(upstream, { method: req.method, headers: h, body, redirect: 'manual', signal: ac.signal })
      jar.store(upstream, typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [])
      const loc = r.headers.get('location')
      if (r.status >= 300 && r.status < 400 && loc) {
        const abs = new URL(loc, upstream).href
        clearTimeout(timer)
        if (this.isPortal(abs)) return this._redirect(res, this._local(abs))
        // Off the portal: the login let the board go, which is what a portal does once it is done.
        return this._done(res)
      }
      const type = r.headers.get('content-type') || 'application/octet-stream'
      const buf = await readCapped(r, MAX_PAGE)
      clearTimeout(timer)
      if (!TEXT.test(type)) return this._send(res, r.status, buf, type)
      let text = rewrite(buf.toString('utf8'), this.origin, this.prefix)
      const isHtml = /html/i.test(type)
      if (isHtml) {
        text = inject(text, this.prefix)
        if (/\/Partner\/ShowQuota\b/i.test(new URL(upstream).pathname)) this._quota(parseValidUntil(buf.toString('utf8')))
      }
      return this._send(res, r.status, text, type, isHtml)
    } catch (err) {
      clearTimeout(timer)
      const why = err && err.name === 'AbortError' ? `no answer in ${Math.round(this.timeoutMs / 1000)} s` : ((err && err.cause && err.cause.code) || (err && err.message) || String(err))
      plog.warn(`hall login page: the portal did not answer (${why})`, { path: new URL(upstream).pathname })
      return this._send(res, 502, page('The hall login page did not answer', `<p>The board asked the hall Wi-Fi for its login page and got no answer (${html(why)}). Tap back and try again in a moment.</p>`))
    }
  }

  _quota(validUntil) {
    plog.info('hall login page: the portal shows the login as done', { validUntil })
    if (this.uplink && typeof this.uplink.noteLogin === 'function') this.uplink.noteLogin(validUntil).catch(() => {})
  }

  _done(res) {
    if (this.uplink && typeof this.uplink.check === 'function') this.uplink.check().catch(() => {})
    return this._send(res, 200, page('That looks done', '<p>The hall Wi-Fi let the board go on. Back in Point Hub, <b>Hall internet</b> shows whether it is online.</p>'))
  }

  _redirect(res, to) {
    res.writeHead(302, { ...cors(), Location: to, 'Cache-Control': 'no-store' })
    res.end()
  }

  _send(res, status, body, type = 'text/html; charset=utf-8', sandbox = true) {
    const h = { ...cors(), 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' }
    // The opaque origin is what keeps a portal script away from the console's localStorage.
    if (sandbox && /html/i.test(type)) h['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms'
    res.writeHead(status, h)
    res.end(body)
  }
}

// Only the sandboxed pages' own opaque origin ("null") is answered; nothing else needs to read us.
const cors = () => ({ 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' })

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { const e = new Error('request body too large'); e.statusCode = 413; req.destroy(); return reject(e) }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readCapped(r, max) {
  if (!r.body) return Buffer.alloc(0)
  const reader = r.body.getReader()
  const parts = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) { try { await reader.cancel() } catch { /* gone */ } break }
    parts.push(Buffer.from(value))
  }
  return Buffer.concat(parts)
}
