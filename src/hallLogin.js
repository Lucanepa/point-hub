// The hall's internet: is the board's uplink online, and if the hall Wi-Fi is holding it behind a
// login page, log it in.
//
// At the KWI hall the only uplink is the open SSID Free_WLAN_KTZH (NetworkManager connection
// 'hall-uplink' on wlan1, see provisioning/setup-wlan1-client.sh --hall). It is a Swisscom Public
// WLAN: associating is free, but every HTTP request is redirected to login.pwlan.ch until the
// device has done a Free-SMS login — a mobile number, a code by SMS, and with "Automatic login"
// ticked the portal keeps that MAC address logged in for about 24 h. Until then the board has no
// NTP, no season schedule and no live scoring, and nothing on the panel says so.
//
// The board has no screen and no browser, so the portal cannot be reached the normal way: the
// scorer's tablet is on the board's OWN AP (wlan0), not on the hall Wi-Fi, and a login done from
// the tablet would log in the tablet's MAC, not the board's. So the board walks the portal itself,
// exactly as a browser does (the flow below is from a capture of a real login), and the console
// only asks for the number and the code:
//
//   probe (generate_204) ──302──▶ login.pwlan.ch/?sub-id=… ──302──▶ /?…&cookieCheck=true
//        ──302──▶ /Partner ──302──▶ /Partner/FreeSmsEnterMsisdn  (form + anti-forgery token)
//   POST Msisdn, Autologin, AcceptTerms ──302──▶ /Partner/FreeSmsEnterPassword  (new token)
//   POST Password ──302──▶ /Partner/ShowQuota  ("Auto login is valid until DD.MM.YYYY HH:MM")
//
// The phone number is the scorer's, and the scorer changes every match. It is NEVER stored: not on
// disk, not in settings, not in the log (logStore redacts it by key and by shape). It is not even
// kept for the code step — once it has been posted to the portal nothing here needs it again, so
// what the 10-minute login session holds is the portal's cookies and its form token, nothing else.
//
// Zero dependencies: Node's global fetch with redirect:'manual' (each hop is followed by hand so
// the cookie jar sees every Set-Cookie), a tiny cookie jar, and a hard 10 s ceiling per request.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { log } from './logStore.js'
import { zurichEpoch } from './schedule.js'

const ulog = log.child('uplink')

// Android's connectivity check. Plain HTTP on purpose: a captive portal can only redirect what it
// can see, so an HTTPS probe would fail as "offline" instead of showing us the login page.
export const PROBE_URL = 'http://connectivitycheck.gstatic.com/generate_204'
export const PORTAL_URL = 'https://login.pwlan.ch'
// The second look, when the first is neither a 204 nor a bounce to the portal. The capture of the
// hall's login started here, not at the Android probe, so this one is known to be caught by the
// portal; generate_204 only probably is (a portal may let it through, or answer it with a page
// that does not name itself). Plain HTTP, and a site that exists to stay plain HTTP.
export const FALLBACK_PROBE_URL = 'http://neverssl.com/'

const TIMEOUT_MS = 10_000
const SESSION_MS = 10 * 60_000        // how long an SMS code stays usable on our side
const MAX_HOPS = 10                   // the real chain is 4 redirects
const MAX_BODY = 512 * 1024           // a portal page is ~15 KB
const POLL_OFFLINE_MS = 60_000        // not online: look again every minute
const POLL_ONLINE_MS = 10 * 60_000    // online: every ten minutes is plenty to notice a lapse

// The capture was made with desktop Firefox. The portal serves the same form to anything, but
// there is no reason to be the one client that looks different.
const UA = 'Mozilla/5.0 (X11; Linux aarch64; rv:128.0) Gecko/20100101 Firefox/128.0'
// English on purpose: the pages are parsed for their text ("Auto login is valid until"), and the
// portal picks its language from this header on the first visit.
const LANG = 'en-GB,en;q=0.9'

// What the console shows. Plain language, no portal jargon — the person reading it is a volunteer
// scorer with a match about to start.
export const ERR = {
  number: 'The number was refused — use the international format, e.g. +41 79 123 45 67',
  code: 'That code was not accepted — check the SMS and try again',
  codeFormat: 'Type the code from the SMS — digits only',
  expired: 'The login timed out — send a new code',
  noCode: 'Send a code first',
  online: 'The hall internet already works — no login needed',
  offline: 'No internet uplink — the board is not on the hall Wi-Fi',
  unreachable: 'The hall login page did not answer — try again in a moment',
  clock: "The board's clock is wrong, so it cannot trust the hall login page — open the console on a tablet with the right time, unlock it, and try again",
  unexpected: 'The hall login page looked different than expected — try again, or log in from a phone on the hall Wi-Fi',
  notOnline: 'Logged in, but the internet does not answer yet — tap Check again in a minute',
  busy: 'A login is already in progress',
}

// ── phone numbers ─────────────────────────────────────────────────────────────────────────────

// '079 123 45 67' → '+41791234567'. The portal's own placeholder is "+41 7x xxx xx xx" and the
// browser posted exactly that shape (+41, then the 9-digit national number, no spaces), so that is
// what we send whatever the scorer typed. A foreign number is passed through in the same E.164
// shape. null = not a number we would dare send.
export function normalizePhone(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.replace(/\(0\)/g, '')             // "+41 (0)79 …", as printed on business cards
  s = s.replace(/[\s.\-/()]/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  if (/^0\d{9}$/.test(s)) s = `+41${s.slice(1)}`      // 079 123 45 67
  else if (/^7\d{8}$/.test(s)) s = `+41${s}`           // 79 123 45 67
  else if (/^41\d{9}$/.test(s)) s = `+${s}`            // 41 79 123 45 67
  if (!/^\+[1-9]\d{6,14}$/.test(s)) return null
  if (s.startsWith('+41') && !/^\+41[1-9]\d{8}$/.test(s)) return null
  return s
}

// ── cookie jar ────────────────────────────────────────────────────────────────────────────────

// Just enough of RFC 6265 for one portal. Keyed by domain + path + name, so the portal's habit of
// deleting a host-only cookie and setting a domain-wide one of the same name in ONE response (it
// does that with every cookie it owns) leaves exactly the domain one behind.
//
// Deliberately lenient in two places, because this jar only ever talks to the portal it was built
// for: a Domain attribute that does not cover the host is kept as host-only rather than dropped,
// and Secure is not enforced. Both are what let the fake portal in the selftest, on plain
// http://127.0.0.1, serve the real portal's exact Set-Cookie lines.
export class CookieJar {
  constructor(now = () => Date.now()) {
    this.now = now
    this._c = new Map()
  }

  store(url, setCookies) {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    for (const line of setCookies || []) {
      const [pair, ...attrs] = String(line).split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      let domain = null
      let cpath = '/'
      let expires = null
      for (const a of attrs) {
        const i = a.indexOf('=')
        const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase()
        const v = i < 0 ? '' : a.slice(i + 1).trim()
        if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase()
        else if (k === 'path' && v.startsWith('/')) cpath = v
        else if (k === 'max-age' && /^-?\d+$/.test(v)) expires = this.now() + Number(v) * 1000
        else if (k === 'expires' && expires === null) {
          const t = Date.parse(v)
          if (Number.isFinite(t)) expires = t
        }
      }
      const covers = domain && (host === domain || host.endsWith(`.${domain}`))
      const scope = covers ? domain : host
      const key = `${scope}|${cpath}|${name}`
      if (expires !== null && expires <= this.now()) { this._c.delete(key); continue }
      this._c.set(key, { name, value, scope, hostOnly: !covers, path: cpath, expires })
    }
  }

  header(url) {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const t = this.now()
    const out = []
    for (const [key, c] of this._c) {
      if (c.expires !== null && c.expires <= t) { this._c.delete(key); continue }
      const hostOk = c.hostOnly ? host === c.scope : (host === c.scope || host.endsWith(`.${c.scope}`))
      const pathOk = u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)
      if (hostOk && pathOk) out.push(c)
    }
    out.sort((a, b) => b.path.length - a.path.length)
    return out.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  get size() { return this._c.size }
}

// ── page parsing ──────────────────────────────────────────────────────────────────────────────

const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// Visible text of a fragment: scripts and tags out, whitespace collapsed.
const textOf = (html) => decode(String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

// The markup of the <form name="…"> (or id), up to its </form>; the whole page if it has none.
function formHtml(html, name) {
  const re = new RegExp(`<form\\b[^>]*\\b(?:name|id)="${name}"[^>]*>([\\s\\S]*?)</form>`, 'i')
  const m = String(html).match(re)
  return m ? m[1] : null
}

// ASP.NET's anti-forgery token, from the named form (a page can carry more than one).
export function formToken(html, formName) {
  const scope = (formName && formHtml(html, formName)) || String(html)
  for (const tag of scope.match(/<input\b[^>]*>/gi) || []) {
    if (!/\bname="__RequestVerificationToken"/i.test(tag)) continue
    const v = tag.match(/\bvalue="([^"]*)"/i)
    if (v && v[1]) return decode(v[1])
  }
  return null
}

// What the portal says went wrong, if anything. The trap: EVERY portal page carries a hidden
// "Technical fault — The login attempt was unsuccessful" notification (class is-generic-error)
// that its script reveals on an AJAX failure, so finding that text proves nothing. Only an error
// the server actually rendered counts: the #divError block its scripts look for, ASP.NET
// validation output, or a notification-error that is not the generic template.
export function pageError(html) {
  const s = String(html)
  const at = []
  let m
  const re = /<(?:div|span|ul|p)\b[^>]*(?:\bid="divError"|class="[^"]*\b(?:field-validation-error|validation-summary-errors|notification-error)\b[^"]*")[^>]*>/gi
  while ((m = re.exec(s))) {
    if (/is-generic-error/.test(m[0])) continue
    at.push(m.index)
  }
  if (!at.length) return null
  // A short excerpt for the log. Digits are masked: a refusal could quote the number back.
  const text = textOf(s.slice(at[0], at[0] + 1200)).slice(0, 200).replace(/\d/g, '#')
  return text || 'error'
}

// "Auto login is valid until 03.10.2026 18:45" (Zurich wall time) → ISO instant. The label is
// looked for in all four portal languages; failing that, any date-time on the quota page will do,
// since it is the only one there.
export function parseValidUntil(html) {
  const text = textOf(html)
  const stamp = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/
  const label = /(valid until|g[üu]ltig bis|valable jusqu|valido fino)/i
  const li = text.search(label)
  const m = (li >= 0 ? text.slice(li).match(stamp) : null) || text.match(stamp)
  if (!m) return null
  const [, d, mo, y, h, mi] = m
  const date = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  const ms = zurichEpoch(date, `${h.padStart(2, '0')}:${mi}`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// ── the portal client ─────────────────────────────────────────────────────────────────────────

export class HallLogin {
  // `probeUrl` / `portalUrl` are injectable (env UPLINK_PROBE_URL / UPLINK_PORTAL_URL, or a test's
  // fake portal) and default to the real ones. `now` drives the 10-minute session.
  // A test that injects its own probe gets no second look unless it asks for one, so no test
  // ever reaches neverssl.com.
  constructor({ probeUrl, fallbackProbeUrl, portalUrl, now = () => Date.now(), timeoutMs = TIMEOUT_MS, sessionMs = SESSION_MS, fetchImpl = null } = {}) {
    this.probeUrl = probeUrl || PROBE_URL
    this.fallbackProbeUrl = fallbackProbeUrl !== undefined ? (fallbackProbeUrl || null) : (probeUrl ? null : FALLBACK_PROBE_URL)
    this.portalUrl = portalUrl || PORTAL_URL
    this.portalHost = new URL(this.portalUrl).host.toLowerCase()
    this.now = now
    this.timeoutMs = timeoutMs
    this.sessionMs = sessionMs
    this._fetch = fetchImpl || ((...a) => fetch(...a))
    this._session = null // { jar, token, referer, expiresAt }
    this._lapsed = false
  }

  isPortal(url) {
    try { return new URL(url).host.toLowerCase() === this.portalHost } catch { return false }
  }

  // One request, body included, inside one hard deadline. Never follows a redirect by itself.
  async _request(url, { method = 'GET', jar = null, headers = {}, body = null } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    if (timer.unref) timer.unref()
    try {
      const h = { 'User-Agent': UA, 'Accept-Language': LANG, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...headers }
      const cookie = jar ? jar.header(url) : ''
      if (cookie) h.Cookie = cookie
      const res = await this._fetch(url, { method, headers: h, body, redirect: 'manual', signal: ac.signal })
      if (jar) jar.store(url, typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])
      let text = ''
      if (res.body) {
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let size = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_BODY) { try { await reader.cancel() } catch { /* gone */ } break }
          text += dec.decode(value, { stream: true })
        }
      }
      const loc = res.headers.get('location')
      return { status: res.status, location: loc ? new URL(loc, url).href : null, text, url }
    } finally {
      clearTimeout(timer)
    }
  }

  // GET, following redirects by hand so every hop's cookies land in the jar. Each hop must stay on
  // the portal (the first may start at the probe): a redirect anywhere else is not the flow we know.
  async _follow(url, jar, headers = {}) {
    let at = url
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const r = await this._request(at, { jar, headers })
      if (r.status >= 300 && r.status < 400 && r.location) {
        if (!this.isPortal(r.location)) return { ...r, offPortal: true }
        at = r.location
        continue
      }
      return r
    }
    throw new Error('too many redirects')
  }

  // online | portal | offline. `entryUrl` is where the probe was sent — it carries the portal's
  // sub-id for this device, so a login must start from it rather than from the portal's front page.
  async detect() {
    const first = await this._probe(this.probeUrl)
    if (first.status !== 'offline' || !this.fallbackProbeUrl) return first
    // Not online and no portal in sight. Before telling the scorer there is no uplink, ask the way
    // the hall's portal is known to answer. Only a portal counts from this look: "online" stays
    // the 204's call, so a network that mangles the probe is not mistaken for a working one.
    const second = await this._probe(this.fallbackProbeUrl)
    return second.status === 'portal' ? second : first
  }

  async _probe(url) {
    let r
    try {
      r = await this._request(url, { headers: { Accept: '*/*' } })
    } catch {
      return { status: 'offline', portal: null, entryUrl: null }
    }
    if (r.status === 204) return { status: 'online', portal: null, entryUrl: null }
    if (r.status >= 300 && r.status < 400 && r.location && this.isPortal(r.location)) {
      return { status: 'portal', portal: 'pwlan', entryUrl: r.location }
    }
    // Some portals answer the probe 200 with a page that bounces to the login in script or a meta
    // refresh; take the portal URL out of the page when it is there.
    if (r.status === 200) {
      const esc = this.portalUrl.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = r.text.match(new RegExp(`${esc}[^"'\\s<>]*`, 'i'))
      if (m) return { status: 'portal', portal: 'pwlan', entryUrl: decode(m[0]) }
    }
    return { status: 'offline', portal: null, entryUrl: null }
  }

  get session() {
    if (this._session && this._session.expiresAt <= this.now()) {
      this._session = null
      this._lapsed = true // so the next code gets "timed out", not "send a code first"
    }
    return this._session
  }

  sessionExpiresAt() {
    const s = this.session
    return s ? new Date(s.expiresAt).toISOString() : null
  }

  dropSession() { this._session = null }

  // Step 1: open the portal and ask it to text a code to `phone`. { ok:true } or { ok:false, error }.
  async startLogin(phone) {
    this._session = null
    this._lapsed = false
    const msisdn = normalizePhone(phone)
    if (!msisdn) return { ok: false, error: ERR.number }
    try {
      const d = await this.detect()
      if (d.status === 'online') return { ok: false, error: ERR.online, status: 'online' }
      if (d.status !== 'portal') return { ok: false, error: ERR.offline, status: d.status }

      const jar = new CookieJar(this.now)
      const page = await this._follow(d.entryUrl, jar)
      if (page.offPortal || page.status !== 200) return this._unexpected('opening the portal', page)
      const token = formToken(page.text, 'FreeSmsEnterMsisdnForm')
      if (!token) return this._unexpected('number form not found', page)
      const formUrl = page.url

      // Field order exactly as the browser sends it: the two ticked checkboxes' `true`, the token,
      // then ASP.NET's hidden `false` twins of the same checkboxes, which a browser always posts.
      const body = new URLSearchParams()
      body.append('Msisdn', msisdn)
      body.append('Autologin', 'true')
      body.append('AcceptTerms', 'true')
      body.append('__RequestVerificationToken', token)
      body.append('Autologin', 'false')
      body.append('AcceptTerms', 'false')
      const posted = await this._post(new URL('/Partner/FreeSmsEnterMsisdn', formUrl).href, body, jar, formUrl)
      if (!(posted.status >= 300 && posted.status < 400 && /\/Partner\/FreeSmsEnterPassword\b/i.test(posted.location || ''))) {
        // The form came back (a validation message), or anything else: the portal did not take it.
        ulog.warn('the portal refused the number', { status: posted.status, portalSays: pageError(posted.text) })
        return { ok: false, error: ERR.number }
      }
      const pw = await this._request(posted.location, { jar, headers: { ...XHR, Referer: formUrl } })
      const next = formToken(pw.text, 'FreeSmsEnterPasswordForm')
      if (pw.status !== 200 || !next) return this._unexpected('code form not found', pw)
      this._session = { jar, token: next, referer: posted.location, expiresAt: this.now() + this.sessionMs }
      ulog.info('the portal is sending an SMS code', { codeValidUntil: new Date(this._session.expiresAt).toISOString() })
      return { ok: true, step: 'code' }
    } catch (err) {
      return failed('hall login failed', err)
    }
  }

  // Step 2: the SMS code. { ok:true, validUntil } or { ok:false, error }.
  async submitCode(code) {
    const s = this.session
    if (!s) return { ok: false, error: this._lapsed ? ERR.expired : ERR.noCode }
    const pwd = String(code ?? '').replace(/\s+/g, '')
    if (!/^\d{4,10}$/.test(pwd)) return { ok: false, error: ERR.codeFormat }
    try {
      const body = new URLSearchParams()
      body.append('Password', pwd)
      body.append('__RequestVerificationToken', s.token)
      const posted = await this._post(s.referer, body, s.jar, s.referer)
      if (!(posted.status >= 300 && posted.status < 400 && /\/Partner\/ShowQuota\b/i.test(posted.location || ''))) {
        // The code form again, with a fresh token: the code was wrong, and another try is allowed.
        const again = posted.status === 200 ? formToken(posted.text, 'FreeSmsEnterPasswordForm') : null
        ulog.warn('the portal did not accept the code', { status: posted.status, portalSays: pageError(posted.text), canRetry: !!again })
        if (again) { s.token = again; return { ok: false, error: ERR.code } }
        // Sent back to the start: the portal's own session is gone.
        if (posted.status >= 300 && posted.status < 400) { this._session = null; this._lapsed = true; return { ok: false, error: ERR.expired } }
        return { ok: false, error: ERR.code }
      }
      const quota = await this._request(posted.location, { jar: s.jar, headers: { ...XHR, Referer: s.referer } })
      this._session = null
      const validUntil = quota.status === 200 ? parseValidUntil(quota.text) : null
      ulog.info('logged in to the hall Wi-Fi', { validUntil })
      return { ok: true, validUntil }
    } catch (err) {
      return failed('hall login failed at the code', err)
    }
  }

  _post(url, body, jar, referer) {
    return this._request(url, {
      method: 'POST',
      jar,
      body: body.toString(),
      headers: {
        ...XHR,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: new URL(url).origin,
        Referer: referer,
      },
    })
  }

  _unexpected(what, r) {
    ulog.warn(`hall login: ${what}`, { status: r && r.status, url: r && r.url ? new URL(r.url).pathname : null, portalSays: r ? pageError(r.text) : null })
    return { ok: false, error: ERR.unexpected }
  }
}

// Node's fetch says only "fetch failed"; what went wrong (DNS, TLS, a refused connection) is in
// `err.cause`, and that is the line someone reads afterwards to find out what happened at the hall.
// A certificate refused for its dates is the board's clock, not the portal: it has no RTC, and
// the portal's certificate is renewed every few months, so a board whose clock is behind the
// renewal cannot log in until it knows the time. `reason: 'clock'` lets the caller fix the clock
// and try again.
const CLOCK_CERT = new Set(['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_NOT_YET_VALID', 'ERR_TLS_CERT_HAS_EXPIRED'])
function failed(what, err) {
  const cause = err && err.cause
  const code = (cause && cause.code) || (err && err.code) || null
  if (code && CLOCK_CERT.has(code)) {
    ulog.warn(`${what}: the portal's certificate was refused for its dates — the board's clock is probably wrong`, { cause: code, boardTime: new Date().toISOString() })
    return { ok: false, error: ERR.clock, reason: 'clock' }
  }
  const why = err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || String(err)
  ulog.warn(`${what}: ${why}`, { cause: code || (cause && cause.message) || null })
  return { ok: false, error: ERR.unreachable }
}

// The portal's own pages submit these forms over jQuery AJAX, and that is what the capture shows.
const XHR = { Accept: 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }

// ── the uplink state the console shows ────────────────────────────────────────────────────────

// Which hall Wi-Fi wlan1 is on. Best effort: nmcli missing, wlan1 absent or a slow answer all
// mean "not known", never an error. `--rescan no` so asking never costs a scan.
function nmcliSsid() {
  return new Promise((resolve) => {
    execFile('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi', 'list', 'ifname', 'wlan1', '--rescan', 'no'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null)
      const line = String(stdout || '').split('\n').find((l) => l.startsWith('yes:'))
      resolve(line ? line.slice(4).replace(/\\(.)/g, '$1') || null : null)
    })
  })
}

export class Uplink {
  // `file` keeps validUntil / loggedInAt across a restart (and nothing else — never the number).
  // `ssid` and `login` are injectable so a test never runs nmcli or reaches the real portal.
  constructor({ file = null, login = null, probeUrl, portalUrl, ssid = nmcliSsid, now = () => Date.now(), pollOnlineMs = POLL_ONLINE_MS, pollOfflineMs = POLL_OFFLINE_MS, settleMs = 1500 } = {}) {
    this.file = file
    this.now = now
    this.login = login || new HallLogin({ probeUrl, portalUrl, now })
    this._ssid = ssid
    this.pollOnlineMs = pollOnlineMs
    this.pollOfflineMs = pollOfflineMs
    this.settleMs = settleMs
    this.state = { status: 'checking', portal: null, ssid: null, validUntil: null, loggedInAt: null, checkedAt: null }
    this._timer = null
    this._running = false
    this._checking = null
    this._busy = false
    this._load()
  }

  view() {
    const codeExpiresAt = this.login.sessionExpiresAt()
    return { ...this.state, step: codeExpiresAt ? 'code' : 'idle', codeExpiresAt }
  }

  start() {
    this._running = true
    this.check().catch(() => {})
  }

  stop() {
    this._running = false
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
  }

  // Look now. Concurrent callers (the poller and a "Check" tap) share one probe.
  check() {
    if (this._checking) return this._checking
    this._checking = (async () => {
      try {
        const d = await this.login.detect()
        // The Wi-Fi's name only while its login page is in the way — that is when the scorer needs
        // it ("Hall Wi-Fi Free_WLAN_KTZH needs a login"), and a public login page means a public
        // network. A private network the board is simply online through is never named here.
        const ssid = d.status === 'portal' ? await Promise.resolve().then(() => this._ssid()).catch(() => null) : null
        const was = this.state.status
        this.state.status = d.status
        this.state.portal = d.portal
        this.state.ssid = ssid || null
        this.state.checkedAt = new Date(this.now()).toISOString()
        if (was !== d.status) {
          const say = { online: 'online', portal: 'the hall Wi-Fi needs a login — live scoring is paused', offline: 'no internet uplink' }[d.status]
          const line = `uplink ${say}`
          if (d.status === 'online' || was === 'checking') ulog.info(line, { status: d.status, ssid: this.state.ssid })
          else ulog.warn(line, { status: d.status, ssid: this.state.ssid, was })
        }
        return this.view()
      } finally {
        this._checking = null
        this._schedule()
      }
    })()
    return this._checking
  }

  _schedule() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (!this._running) return
    const ms = this.state.status === 'online' ? this.pollOnlineMs : this.pollOfflineMs
    this._timer = setTimeout(() => { this.check().catch(() => {}) }, ms)
    if (this._timer.unref) this._timer.unref()
  }

  // `fixClock` (optional) is asked to adopt the console's time when the portal's certificate was
  // refused for its dates; when it moved the clock, the step is tried once more.
  async _withClock(step, fixClock) {
    const r = await step()
    if (r.ok || r.reason !== 'clock' || typeof fixClock !== 'function') return r
    const fixed = await Promise.resolve().then(fixClock).catch(() => null)
    if (!fixed || !fixed.applied) return r
    ulog.info('the board took the console\'s clock for the hall login — trying again', { offsetMs: fixed.offsetMs })
    return step()
  }

  async sendCode(phone, { fixClock = null } = {}) {
    if (this._busy) return { ok: false, error: ERR.busy }
    this._busy = true
    try {
      const r = await this._withClock(() => this.login.startLogin(phone), fixClock)
      if (r.status) {
        // startLogin probed on the way in; keep what it saw.
        this.state.status = r.status
        if (r.status !== 'portal') this.state.portal = null
      }
      return r.ok ? { ok: true, step: 'code', codeExpiresAt: this.login.sessionExpiresAt() } : { ok: false, error: r.error }
    } finally {
      this._busy = false
    }
  }

  async submitCode(code, { fixClock = null } = {}) {
    if (this._busy) return { ok: false, error: ERR.busy }
    this._busy = true
    try {
      const r = await this._withClock(() => this.login.submitCode(code), fixClock)
      if (!r.ok) return r
      this._record({ validUntil: r.validUntil || null, loggedInAt: new Date(this.now()).toISOString() })
      // The portal lets the device out a moment after the quota page; give it a few looks.
      let v = await this.check()
      for (let i = 0; i < 3 && v.status !== 'online'; i++) {
        await new Promise((res) => { const t = setTimeout(res, this.settleMs); if (t.unref) t.unref() })
        v = await this.check()
      }
      if (v.status !== 'online') return { ok: false, error: ERR.notOnline, validUntil: this.state.validUntil }
      return { ok: true, status: 'online', validUntil: this.state.validUntil }
    } finally {
      this._busy = false
    }
  }

  _load() {
    if (!this.file) return
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)
      this.state.validUntil = iso(doc.validUntil)
      this.state.loggedInAt = iso(doc.loggedInAt)
    } catch { /* none yet, or unreadable: start empty */ }
  }

  // Write-then-rename, and only on a change — the board runs off an SD card.
  _record({ validUntil, loggedInAt }) {
    const same = validUntil === this.state.validUntil && loggedInAt === this.state.loggedInAt
    this.state.validUntil = validUntil
    this.state.loggedInAt = loggedInAt
    if (same || !this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ validUntil, loggedInAt }))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      ulog.warn(`could not save the login time: ${err.message}`, { file: this.file })
    }
  }
}
