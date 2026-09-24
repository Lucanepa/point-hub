// The hall Wi-Fi login — hallLogin.js against a hand-written fake of the Swisscom Public WLAN portal.
//
// The fake reproduces what a capture of a real Free-SMS login at the hall showed, with every value
// made up: the probe's 302 to the portal with a sub-id, the cookieCheck bounce, /Partner, the
// number form with its anti-forgery cookie and token, the hidden "login attempt was unsuccessful"
// template EVERY page carries, the delete-then-set pairs of Set-Cookie lines, the code form, and
// the quota page with "Auto login is valid until". It enforces what the real one would: cookies,
// tokens, the AJAX header, the field order with ASP.NET's duplicate hidden `false` fields.
//
//   [1] phone numbers, the cookie jar, and reading the portal's pages
//   [2] detect: online, behind the portal, and offline (nothing answering, or a stranger's page)
//   [3] a full login: the number posted in the portal's shape and field order, a wrong code, then
//       the right one — validUntil parsed from Zurich time, and the probe online afterwards
//   [4] a refused number, locally and by the portal
//   [5] the code session lapses after 10 minutes
//   [6] the uplink state: persisted only on change, polled faster while not online
//   [7] through the appliance: PIN gating, /api/uplink, /api/status — and the number never lands
//       on disk or in the log
//   [8] when things go wrong at the hall: a probe the portal lets through (the second look), a
//       certificate refused for its dates (the board's clock — fixed from the console's, even
//       mid-match, and tried again), and a failure's real cause in the log
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { HallLogin, Uplink, CookieJar, normalizePhone, formToken, pageError, parseValidUntil, ERR } from '../src/hallLogin.js'
import { startAppliance } from '../src/appliance.js'
import { log } from '../src/logStore.js'
import { ClockSync } from '../src/clockSync.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// Made-up values only. The number is the kind printed in Swiss documentation examples.
const PHONE_TYPED = '079 123 45 67'
const PHONE_SENT = '+41791234567'
const CODE = '482913'
const QUOTA_STAMP = '03.10.2026 18:45'            // Zurich, summer time
const QUOTA_ISO = '2026-10-03T16:45:00.000Z'

// ── the fake portal ─────────────────────────────────────────────────────────────────────────────
const portal = {
  loggedIn: false,
  probeMode: 'portal',   // 'portal' | 'stranger' (200, someone else's page) | 'hang'
  expireOnCode: false,   // the portal's own session gone by the time the code arrives
  sessions: new Map(),   // session cookie -> { token, msisdnOk }
  posts: [],             // every POST: { path, raw, headers }
  hits: { probe: 0 },
  seq: 0,
}
const fakeToken = () => `CfDJ8FAKE${++portal.seq}${'x'.repeat(40)}`
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => {
  const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]
}))
// The real portal's pattern: expire the host-only cookie, then set the domain-wide one.
const reset = (name, value, extra = '') => [
  `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`,
  `${name}=${value}; expires=Wed, 22 Sep 2027 22:00:00 GMT; domain=pwlan.ch; path=/; secure; samesite=none; httponly${extra}`,
]
const TS = 'TS0fake=01fakecookie; Path=/'

const GENERIC = `<div class="notification notification-error is-generic-error">
    <div class="notification--inner"><div class="notification--message">
            <div style="font-weight: bold">Technical fault</div>
            The login attempt was unsuccessful.<br/>Repeat the login and contact the hotline, if the problem persists.
    </div></div></div>`
const page = (inner) => `<!DOCTYPE html><html class="no-js" lang="en"><head><title>Swisscom Public Wireless LAN</title></head>
<body class="is-dark_theme is-b2b js-b2b"><div id="body"><div class="l-gap-above l-gap-large">
${GENERIC}
<div class="js-site-content--inner">
<form action="/Partner/Home/SelectLoginType" method="get"><input checked name="loginType" type="radio" value="SPEC_FREE_SMS"></form>
${inner}
</div></div></div></body></html>`
const msisdnPage = (token, error = '') => page(`<div class="b2b_login--option is-active">
<form action="/Partner/FreeSmsEnterMsisdn" id="FreeSmsEnterMsisdnForm" method="post" name="FreeSmsEnterMsisdnForm">
  <input class="input_text--field" id="input_text-u2" name="Msisdn" placeholder="Example Switzerland (CH): &#x2B;41 7x xxx xx xx" type="tel" value="" />
  ${error ? `<span class="field-validation-error" data-valmsg-for="Msisdn">${error}</span>` : ''}
  <input class="input_checkbox--field" id="input_checkbox-u4" name="Autologin" type="checkbox" value="true" />
  <input class="input_checkbox--field" id="input_checkbox-u5" name="AcceptTerms" type="checkbox" value="true" />
  <button type="submit" name="next">Continue</button>
<input name="__RequestVerificationToken" type="hidden" value="${token}" /><input name="Autologin" type="hidden" value="false" /><input name="AcceptTerms" type="hidden" value="false" /></form>
</div><script>var valid = false; if (!$('#divError').length) {}</script>`)
const passwordPage = (token, error = '') => page(`${error ? `<div id="divError" class="notification notification-error"><div class="notification--message">${error}</div></div>` : ''}
<div class="b2b_login--option is-active">
<form action="/Partner/FreeSmsEnterPassword" method="post" name="FreeSmsEnterPasswordForm">
  <input autocomplete="one-time-code" inputmode="numeric" name="Password" pattern="[0-9]*" type="password" />
  <button type="submit" name="next">Continue</button>
<input name="__RequestVerificationToken" type="hidden" value="${token}" /></form></div>`)
const quotaPage = (token) => page(`<form action="/Partner/ShowQuota" method="post" name="logout">
  <div class="b2b_remaining_time--inner">
    <div class="l-gap">Duration of session<div><strong class="strong t-big">
                0 minutes
            </strong></div></div>
    <div class="l-gap">
        Auto login is valid until
        <div>
            <strong class="strong t-big">
                ${QUOTA_STAMP}
            </strong>
        </div>
    </div>
  </div>
<input name="__RequestVerificationToken" type="hidden" value="${token}" /></form>`)

let portalBase = ''
const send = (res, status, { headers = {}, cookies: set = [], body = '' } = {}) => {
  const h = { 'Content-Type': 'text/html; charset=utf-8', Server: 'Kestrel', ...headers }
  if (set.length) h['Set-Cookie'] = [...set, TS]
  res.writeHead(status, h)
  res.end(body)
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => r(b)) })

const portalServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  const c = cookies(req)
  const sess = portal.sessions.get(c.PwlanX_ASPNET_SessionId)
  if (req.method === 'GET' && u.pathname === '/' && u.searchParams.has('sub-id') && !u.searchParams.has('cookieCheck')) {
    return send(res, 302, { headers: { Location: `/?sub-id=${u.searchParams.get('sub-id')}&cookieCheck=true` }, cookies: reset('PwlanX_CookieCheck', 'True') })
  }
  if (req.method === 'GET' && u.pathname === '/' && u.searchParams.get('cookieCheck') === 'true') {
    if (c.PwlanX_CookieCheck !== 'True') return send(res, 200, { body: page('<p>Please enable cookies.</p>') })
    const id = `fake-session-${++portal.seq}`
    portal.sessions.set(id, { token: null, msisdnOk: false })
    return send(res, 302, { headers: { Location: `${portalBase}/Partner` }, cookies: [...reset('PwlanX_ASPNET_SessionId', id), ...reset('PwlanX_Language', 'en')] })
  }
  if (!sess) return send(res, 302, { headers: { Location: '/' } }) // no session: back to the start
  if (req.method === 'GET' && u.pathname === '/Partner') {
    return send(res, 302, { headers: { Location: '/Partner/FreeSmsEnterMsisdn' }, cookies: reset('PwlanX_ChoosedLoginType', 'SPEC_FREE_SMS') })
  }
  if (req.method === 'GET' && u.pathname === '/Partner/FreeSmsEnterMsisdn') {
    sess.token = fakeToken()
    return send(res, 200, { headers: { 'Cache-Control': 'no-cache, no-store' }, cookies: ['.PwlanPortal.AntiForgery=CfDJ8FAKEAF; path=/; secure; samesite=lax; httponly'], body: msisdnPage(sess.token) })
  }
  if (req.method === 'POST') {
    const raw = await readBody(req)
    portal.posts.push({ path: u.pathname, raw, headers: req.headers })
    const f = new URLSearchParams(raw)
    const forged = f.get('__RequestVerificationToken') !== sess.token || c['.PwlanPortal.AntiForgery'] !== 'CfDJ8FAKEAF'
      || req.headers['x-requested-with'] !== 'XMLHttpRequest' || !/^application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')
    if (forged) return send(res, 400, { body: 'Bad Request' })
    if (u.pathname === '/Partner/FreeSmsEnterMsisdn') {
      const good = /^\+417[5-9]\d{7}$/.test(f.get('Msisdn') || '') && f.getAll('AcceptTerms').includes('true')
      if (!good) {
        sess.token = fakeToken()
        return send(res, 200, { body: msisdnPage(sess.token, 'The entered number is wrong. Please check your entry.') })
      }
      sess.msisdnOk = true
      return send(res, 302, { headers: { Location: '/Partner/FreeSmsEnterPassword' }, cookies: [...reset('PwlanX_AcceptUseConditions', 'True'), ...reset('PwlanX_AcceptAutoRelogin', 'True')] })
    }
    if (u.pathname === '/Partner/FreeSmsEnterPassword') {
      if (portal.expireOnCode) { portal.sessions.delete(c.PwlanX_ASPNET_SessionId); return send(res, 302, { headers: { Location: '/' } }) }
      if (f.get('Password') !== CODE) {
        sess.token = fakeToken()
        return send(res, 200, { body: passwordPage(sess.token, 'The password is incorrect.') })
      }
      portal.loggedIn = true
      return send(res, 302, { headers: { Location: '/Partner/ShowQuota' }, cookies: reset('PwlanX_LastLoginType', 'SPEC_FREE_SMS') })
    }
  }
  if (req.method === 'GET' && u.pathname === '/Partner/FreeSmsEnterPassword') {
    if (!sess.msisdnOk || req.headers['x-requested-with'] !== 'XMLHttpRequest') return send(res, 302, { headers: { Location: '/' } })
    sess.token = fakeToken()
    return send(res, 200, { body: passwordPage(sess.token) })
  }
  if (req.method === 'GET' && u.pathname === '/Partner/ShowQuota') {
    return send(res, 200, { body: quotaPage(fakeToken()) })
  }
  return send(res, 404, { body: 'not found' })
})

const probeServer = http.createServer((req, res) => {
  portal.hits.probe++
  if (portal.probeMode === 'hang') return // never answers: the client's own timeout has to fire
  if (portal.loggedIn) { res.writeHead(204); return res.end() }
  // 'stranger' lets the Android probe through to a page that is not the portal; the second look
  // (/neverssl) is still caught, as it was in the capture.
  if (portal.probeMode === 'stranger' && !req.url.startsWith('/neverssl')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Hotel lobby — accept our terms</html>') }
  res.writeHead(302, { Location: `${portalBase}?sub-id=FAKE-SUB-0001;ZID00000` })
  res.end()
})

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
portalBase = `http://127.0.0.1:${await listen(portalServer)}`
const probeUrl = `http://127.0.0.1:${await listen(probeServer)}/generate_204`
const deadProbe = 'http://127.0.0.1:9/generate_204'

let app = null
let stateDir = null
try {
  console.log('[1] phone numbers, the cookie jar, the pages')
  {
    for (const typed of ['079 123 45 67', '0791234567', '+41 79 123 45 67', '0041 79 123 45 67', '+41 (0)79 123 45 67', '79 123 45 67', '079-123.45/67']) {
      ok(normalizePhone(typed) === PHONE_SENT, `'${typed}' → ${PHONE_SENT}`)
    }
    ok(normalizePhone('+49 151 2345678') === '+491512345678', 'a foreign number keeps its country code')
    for (const bad of ['', '12345', '+41 79 123 45', 'call me', '+00 41 79 123 45 67']) ok(normalizePhone(bad) === null, `'${bad}' is refused`)

    let t = 1_000_000
    const jar = new CookieJar(() => t)
    const url = 'https://login.example.ch/'
    jar.store(url, ['A=old; path=/', 'A=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/', 'A=new; domain=example.ch; path=/; secure', 'B=1; max-age=60; path=/Partner'])
    ok(jar.header(url) === 'A=new', 'a host-only cookie deleted and a domain one set in one response leaves the domain one')
    ok(jar.header('https://other.example.ch/x') === 'A=new', 'a domain cookie covers the sibling host')
    ok(jar.header('https://login.example.ch/Partner/X') === 'B=1; A=new', 'a path cookie reaches its subtree, longest path first')
    t += 61_000
    ok(jar.header('https://login.example.ch/Partner') === 'A=new', 'max-age expires')

    const pg = msisdnPage('TOKEN-ONE')
    ok(formToken(pg, 'FreeSmsEnterMsisdnForm') === 'TOKEN-ONE', 'the anti-forgery token is read from the named form')
    ok(pageError(pg) === null, 'the hidden "login attempt was unsuccessful" template on every page is NOT an error')
    ok(pageError(msisdnPage('T', 'The entered number is wrong.')) !== null, 'a validation message is')
    ok(pageError(passwordPage('T', 'The password is incorrect.')) !== null, 'and so is a rendered #divError')
    ok(parseValidUntil(quotaPage('T')) === QUOTA_ISO, `"valid until ${QUOTA_STAMP}" (Zurich, summer) → ${QUOTA_ISO}`)
    ok(parseValidUntil('Auto login is valid until <strong>05.12.2026 09:05</strong>') === '2026-12-05T08:05:00.000Z', 'winter time is an hour off UTC')
  }

  console.log('\n[2] detect')
  {
    const hl = new HallLogin({ probeUrl, portalUrl: portalBase })
    const d = await hl.detect()
    ok(d.status === 'portal' && d.portal === 'pwlan', 'behind the portal: the probe is redirected to it → portal "pwlan"')
    ok(d.entryUrl && d.entryUrl.startsWith(portalBase) && d.entryUrl.includes('sub-id='), 'and the entry URL keeps the sub-id')
    ok((await new HallLogin({ probeUrl: deadProbe, portalUrl: portalBase }).detect()).status === 'offline', 'nothing answering → offline')
    portal.probeMode = 'stranger'
    ok((await hl.detect()).status === 'offline', 'a 200 page that is not this portal → offline')
    portal.probeMode = 'hang'
    const t0 = Date.now()
    ok((await new HallLogin({ probeUrl, portalUrl: portalBase, timeoutMs: 300 }).detect()).status === 'offline' && Date.now() - t0 < 2000, 'a probe that never answers times out → offline')
    portal.probeMode = 'portal'
    portal.loggedIn = true
    ok((await hl.detect()).status === 'online', '204 → online')
    portal.loggedIn = false
  }

  console.log('\n[3] a full login')
  {
    const hl = new HallLogin({ probeUrl, portalUrl: portalBase })
    portal.posts = []
    const r = await hl.startLogin(PHONE_TYPED)
    ok(r.ok === true && r.step === 'code', `the number is accepted → step 'code' (${JSON.stringify(r)})`)
    const post = portal.posts.find((p) => p.path === '/Partner/FreeSmsEnterMsisdn')
    const fields = post ? [...new URLSearchParams(post.raw)] : []
    ok(fields.map(([k]) => k).join(',') === 'Msisdn,Autologin,AcceptTerms,__RequestVerificationToken,Autologin,AcceptTerms', 'fields in the browser\'s order, with the hidden false twins')
    ok(fields.map(([, v]) => v).slice(1, 3).join() === 'true,true' && fields.map(([, v]) => v).slice(4).join() === 'false,false', 'Autologin and AcceptTerms ticked, then the hidden false values')
    ok(fields[0] && fields[0][1] === PHONE_SENT && post.raw.startsWith('Msisdn=%2B41'), 'the number is sent as +41… (url-encoded %2B41)')
    ok(post && /^application\/x-www-form-urlencoded/.test(post.headers['content-type']) && post.headers['x-requested-with'] === 'XMLHttpRequest', 'form-encoded, as the portal\'s own AJAX')
    ok(post && /PwlanX_ASPNET_SessionId=fake-session-/.test(post.headers.cookie) && /\.PwlanPortal\.AntiForgery=/.test(post.headers.cookie), 'the session and anti-forgery cookies ride along')
    ok(hl.session && !JSON.stringify({ ...hl.session, jar: [...hl.session.jar._c.values()] }).includes('791234567'), 'the login session holds cookies and a token — not the number')

    const wrong = await hl.submitCode('111111')
    ok(wrong.ok === false && wrong.error === ERR.code, `a wrong code → "${ERR.code}"`)
    ok(!!hl.session, 'and the session stays open for another try')
    const right = await hl.submitCode(' 482 913 ')
    ok(right.ok === true && right.validUntil === QUOTA_ISO, `the right code → online until ${right.validUntil}`)
    const codePost = portal.posts.filter((p) => p.path === '/Partner/FreeSmsEnterPassword').pop()
    ok(codePost && [...new URLSearchParams(codePost.raw)].map(([k]) => k).join() === 'Password,__RequestVerificationToken', 'the code is posted as Password + token')
    ok((await hl.detect()).status === 'online', 'and the probe answers 204 afterwards')
    ok((await hl.startLogin(PHONE_TYPED)).error === ERR.online, 'asking again while online says so, and sends nothing')
    portal.loggedIn = false
  }

  console.log('\n[4] a refused number')
  {
    const hl = new HallLogin({ probeUrl, portalUrl: portalBase })
    ok((await hl.startLogin('12345')).error === ERR.number, 'nonsense is refused before the portal is asked')
    const before = portal.posts.length
    const r = await hl.startLogin('044 123 45 67') // a landline: well-formed, but the portal wants a mobile
    ok(r.ok === false && r.error === ERR.number, `the portal re-shows the form with a message → "${ERR.number}"`)
    ok(portal.posts.length === before + 1, 'after exactly one post')
    ok(!hl.session, 'and no code step is opened')
    ok((await hl.submitCode(CODE)).error === ERR.noCode, 'a code with no login under way → "send a code first"')
    ok((await new HallLogin({ probeUrl: deadProbe, portalUrl: portalBase }).startLogin(PHONE_TYPED)).error === ERR.offline, 'no uplink at all → says so')
  }

  console.log('\n[5] the code session lapses after 10 minutes')
  {
    let t = Date.now()
    const hl = new HallLogin({ probeUrl, portalUrl: portalBase, now: () => t })
    ok((await hl.startLogin(PHONE_TYPED)).ok === true, 'a code is sent')
    t += 10 * 60_000 - 1
    ok(!!hl.session, 'still open at 9:59.999')
    t += 1
    ok(hl.session === null && hl.sessionExpiresAt() === null, 'dropped at 10:00')
    const posts = portal.posts.length
    const r = await hl.submitCode(CODE)
    ok(r.ok === false && r.error === ERR.expired, `a code after that → "${ERR.expired}"`)
    ok(portal.posts.length === posts && portal.loggedIn === false, 'and nothing was posted to the portal')
    t = Date.now()
    ok((await hl.startLogin(PHONE_TYPED)).ok === true, 'a new code can be requested')
    portal.expireOnCode = true
    ok((await hl.submitCode(CODE)).error === ERR.expired, 'the PORTAL\'s session gone (sent back to the start) → timed out too')
    portal.expireOnCode = false
  }

  console.log('\n[6] the uplink state')
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-uplink-'))
    const file = path.join(dir, 'uplink.json')
    const up = new Uplink({ file, probeUrl, portalUrl: portalBase, ssid: async () => 'Free_WLAN_KTZH', pollOfflineMs: 40, pollOnlineMs: 60_000, settleMs: 10 })
    ok(up.view().status === 'checking' && up.view().step === 'idle', 'starts as checking, step idle')
    const hits = portal.hits.probe
    up.start()
    await sleep(250)
    ok(up.view().status === 'portal' && up.view().ssid === 'Free_WLAN_KTZH', 'the poller finds the portal and the hall SSID')
    ok(portal.hits.probe - hits >= 3, `polls every minute (40 ms here) while not online (${portal.hits.probe - hits} probes)`)
    ok((await up.sendCode(PHONE_TYPED)).ok === true && up.view().step === 'code', 'sendCode → step code')
    const r = await up.submitCode(CODE)
    ok(r.ok === true && r.status === 'online' && r.validUntil === QUOTA_ISO, 'submitCode → online, with validUntil')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    ok(saved.validUntil === QUOTA_ISO && Number.isFinite(Date.parse(saved.loggedInAt)) && Object.keys(saved).length === 2, 'uplink.json holds validUntil and loggedInAt, nothing else')
    const settled = portal.hits.probe
    await sleep(200)
    ok(portal.hits.probe === settled, 'online: no probe for the next ten minutes')
    fs.rmSync(file)
    up._record({ validUntil: saved.validUntil, loggedInAt: saved.loggedInAt })
    ok(!fs.existsSync(file), 'written only on a change')
    up.stop()
    fs.writeFileSync(file, JSON.stringify({ validUntil: QUOTA_ISO, loggedInAt: QUOTA_ISO }))
    ok(new Uplink({ file, probeUrl, portalUrl: portalBase }).view().validUntil === QUOTA_ISO, 'and read back at boot')
    fs.rmSync(dir, { recursive: true, force: true })
    portal.loggedIn = false
  }

  console.log('\n[7] through the appliance')
  {
    const PIN = '5151'
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-hall-'))
    fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ scorerPin: PIN, sport: 'volleyball' }))
    app = await startAppliance({
      stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0, mock: true, controlPort: 0, debug: false,
      uplinkProbeUrl: probeUrl, uplinkPortalUrl: portalBase,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const call = async (p, body, pin) => {
      const headers = { 'content-type': 'application/json', origin: base }
      if (pin) headers['X-Scorer-Pin'] = pin
      const res = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) })
      return { status: res.status, json: await res.json().catch(() => null) }
    }
    ok((await call('/api/uplink/login', { phone: PHONE_TYPED })).status === 403, 'POST /api/uplink/login without the PIN → 403')
    ok((await call('/api/uplink/code', { code: CODE })).status === 403, 'POST /api/uplink/code without the PIN → 403')
    ok((await call('/api/uplink/check', {})).status === 403, 'POST /api/uplink/check without the PIN → 403')
    ok(portal.loggedIn === false, 'and nothing reached the portal')

    const chk = await call('/api/uplink/check', {}, PIN)
    ok(chk.status === 200 && chk.json.status === 'portal' && chk.json.portal === 'pwlan', 'check → portal')
    const st0 = await (await fetch(`${base}/api/status`)).json()
    ok(st0.uplink && st0.uplink.status === 'portal' && st0.uplink.validUntil === null, '/api/status carries uplink { status, validUntil } for the header')
    const login = await call('/api/uplink/login', { phone: PHONE_TYPED }, PIN)
    ok(login.status === 200 && login.json.ok === true && login.json.step === 'code', 'login → { ok, step: code }')
    const view = await (await fetch(`${base}/api/uplink`)).json()
    ok(view.step === 'code' && view.status === 'portal' && !JSON.stringify(view).includes('791234567'), 'GET /api/uplink: step code — and no number in it')
    const bad = await call('/api/uplink/code', { code: '000000' }, PIN)
    ok(bad.status === 200 && bad.json.ok === false && bad.json.error === ERR.code, 'a wrong code → { ok:false, error } in plain words')
    const good = await call('/api/uplink/code', { code: CODE }, PIN)
    ok(good.status === 200 && good.json.ok === true && good.json.status === 'online' && good.json.validUntil === QUOTA_ISO, 'the right code → { ok, status: online, validUntil }')
    const st1 = await (await fetch(`${base}/api/status`)).json()
    ok(st1.uplink.status === 'online' && st1.uplink.validUntil === QUOTA_ISO, '/api/status now says online until then')

    // The number, in every shape it could have been written in.
    log.info('uplink', 'a careless caller', { phone: PHONE_TYPED, note: `number ${PHONE_SENT}` })
    log.flush()
    const shapes = ['791234567', '79 123 45 67', '123 45 67']
    const leaks = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else { const txt = fs.readFileSync(p, 'utf8'); for (const s of shapes) if (txt.includes(s)) leaks.push(`${path.relative(stateDir, p)}: ${s}`) }
      }
    }
    walk(stateDir)
    ok(fs.readFileSync(path.join(stateDir, 'data', 'logs', 'appliance.jsonl'), 'utf8').includes('a careless caller'), '(the log file was written, so the scan saw it)')
    ok(leaks.length === 0, `the number is nowhere under the state dir — settings, uplink.json, logs${leaks.length ? ` — FOUND ${leaks.join('; ')}` : ''}`)
    ok(fs.existsSync(path.join(stateDir, 'data', 'uplink.json')), '(uplink.json was written, so the scan saw it)')
    ok(log.query({ q: '791234567' }).length === 0 && log.query({ q: '123 45 67' }).length === 0, 'nor anywhere in the log ring')
    ok(log.query({ q: 'a careless caller' })[0]?.data?.phone === '[redacted]', 'a `phone` key is redacted')
    const logs = await (await fetch(`${base}/api/logs?limit=2000`)).text()
    ok(!logs.includes('791234567'), 'nor in GET /api/logs')
  }

  console.log('\n[8] when things go wrong at the hall')
  {
    portal.loggedIn = false // [7] left the board logged in
    // The Android probe let through untouched (answered 200 by something that is not the portal),
    // while the second look is caught: that is still the portal, and the login starts from it.
    const fallbackProbe = probeUrl.replace('/generate_204', '/neverssl')
    portal.probeMode = 'stranger'
    const two = new HallLogin({ probeUrl, fallbackProbeUrl: fallbackProbe, portalUrl: portalBase })
    const d = await two.detect()
    ok(d.status === 'portal' && d.entryUrl.includes('sub-id='), 'generate_204 not caught, the second look is → portal, with its sub-id')
    ok((await new HallLogin({ probeUrl: deadProbe, fallbackProbeUrl: deadProbe, portalUrl: portalBase }).detect()).status === 'offline', 'neither answering → offline')
    ok(new HallLogin({ probeUrl, portalUrl: portalBase }).fallbackProbeUrl === null && new HallLogin().fallbackProbeUrl === 'http://neverssl.com/', 'the second look is on by default, and off for an injected probe unless asked')
    portal.probeMode = 'portal'

    // A board whose clock is behind the portal's (renewed) certificate. Node's fetch throws
    // "fetch failed" with the TLS reason in `cause`; the fake throws exactly that for the portal.
    const certErr = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('certificate is not yet valid'), { code }) })
    let clockOk = false
    const tlsFetch = (url, opts) => (url.startsWith(portalBase) && !clockOk ? Promise.reject(certErr('CERT_NOT_YET_VALID')) : fetch(url, opts))
    const hl = new HallLogin({ probeUrl, portalUrl: portalBase, fetchImpl: tlsFetch })
    const r = await hl.startLogin(PHONE_TYPED)
    ok(r.ok === false && r.error === ERR.clock && r.reason === 'clock', `a not-yet-valid certificate → "${ERR.clock}"`)
    const expired = new HallLogin({ probeUrl, portalUrl: portalBase, fetchImpl: (u, o) => (u.startsWith(portalBase) ? Promise.reject(certErr('CERT_HAS_EXPIRED')) : fetch(u, o)) })
    ok((await expired.startLogin(PHONE_TYPED)).reason === 'clock', 'an expired one too')
    const refused = new HallLogin({ probeUrl, portalUrl: portalBase, fetchImpl: (u, o) => (u.startsWith(portalBase) ? Promise.reject(certErr('ECONNREFUSED')) : fetch(u, o)) })
    ok((await refused.startLogin(PHONE_TYPED)).error === ERR.unreachable, 'anything else → "did not answer"')
    const lines = log.query({ q: 'hall login failed' })
    ok(lines.some((e) => e.data && e.data.cause === 'ECONNREFUSED'), 'and the log keeps the real cause, not just "fetch failed"')
    ok(lines.some((e) => e.data && e.data.cause === 'CERT_NOT_YET_VALID'), 'the clock one too')

    // Through Uplink: the console's clock is adopted — even mid-match — and the step tried again.
    let t = Date.now() - 200 * 86_400_000 // fake-hwclock's replay, months behind
    const applied = []
    const cs = new ClockSync({
      isBusy: () => true, now: () => t, probeSync: async () => 'no', persist: async () => '',
      applyTime: async (ms) => { applied.push(ms); t = ms; clockOk = true; return '' },
    })
    ok((await cs.setFromConsole(Date.now())).reason === 'busy', '(an ordinary console clock is still deferred mid-match)')
    const up = new Uplink({ login: new HallLogin({ probeUrl, portalUrl: portalBase, fetchImpl: tlsFetch }), ssid: async () => null, settleMs: 10 })
    const sent = await up.sendCode(PHONE_TYPED, { fixClock: () => cs.setFromConsole(Date.now(), { evenIfBusy: true }) })
    ok(applied.length === 1 && sent.ok === true && sent.step === 'code', 'the certificate refused → the console\'s clock adopted mid-match → the code is sent')
    const again = await up.submitCode(CODE, { fixClock: () => cs.setFromConsole(Date.now(), { evenIfBusy: true }) })
    ok(again.ok === true && applied.length === 1, 'and the code goes through without touching the clock again')
    portal.loggedIn = false
    clockOk = false
    const ntp = new ClockSync({ isBusy: () => true, probeSync: async () => 'yes', applyTime: async () => { throw new Error('must not set') } })
    const noFix = await new Uplink({ login: new HallLogin({ probeUrl, portalUrl: portalBase, fetchImpl: tlsFetch }), ssid: async () => null })
      .sendCode(PHONE_TYPED, { fixClock: () => ntp.setFromConsole(Date.now(), { evenIfBusy: true }) })
    ok(noFix.ok === false && noFix.error === ERR.clock, 'an NTP-synced clock is never moved: the scorer is told the clock is the problem')
  }
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  if (app) await app.close()
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true })
  portalServer.closeAllConnections(); probeServer.closeAllConnections()
  await Promise.all([new Promise((r) => portalServer.close(r)), new Promise((r) => probeServer.close(r))])
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
