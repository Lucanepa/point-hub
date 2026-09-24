// The tablet as the board's own app: installable from the https address, launched straight into a
// full-screen landscape console that keeps the screen on by itself, and a console opened on plain
// http that moves itself to https when it can.
//
//   [1] the manifest is served, with its registered type, and says what an installed app needs
//   [2] the icons it names exist, at the sizes it claims
//   [3] /api/status names the https origin from the loaded certificate (and follows a renewal)
//   [4] the console: app mode skips the gate and holds the screen on; the move to https is probed,
//       quiet-gated and one-shot
//   [5] the service worker caches nothing: it passes page loads through, and only a failed one is
//       answered — with the way back to http://172.24.1.1:8890
//
// Plain node, no framework; exits non-zero on any failure. [3] needs openssl to make a throwaway
// certificate and is skipped, with a note, where there is none.

import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { startAppliance, httpsOriginFromCert, certValidTo } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const web = new URL('../web/', import.meta.url)
const html = fs.readFileSync(new URL('index.html', web), 'utf8')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-pwa-'))
const boot = (stateDir, extra = {}) => startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
  mock: true, controlPort: 0, debug: false, ...extra,
})
const base = (app) => `http://127.0.0.1:${app.server.address().port}`
// A PNG's size is in its IHDR chunk, at a fixed offset; no image library needed.
const pngSize = (buf) => (buf.slice(1, 4).toString() === 'PNG' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null)

let openssl = true
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { openssl = false }
const makeCert = (dir, san) => {
  fs.mkdirSync(dir, { recursive: true })
  const cert = path.join(dir, 'board.crt'), key = path.join(dir, 'board.key')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=point-hub-test', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' })
  return { cert, key }
}

const apps = []
try {
  console.log('\n[1] the manifest')
  const app = await boot(path.join(scratch, 'plain'))
  apps.push(app)
  const res = await fetch(base(app) + '/manifest.webmanifest')
  ok(res.status === 200, `served (${res.status})`)
  ok(/^application\/manifest\+json/.test(res.headers.get('content-type') || ''), `as application/manifest+json (${res.headers.get('content-type')})`)
  let m = null
  try { m = await res.json() } catch {}
  ok(!!m, 'parses as JSON')
  m = m || {}
  ok(m.name === 'Point Hub' && m.short_name === 'Point Hub', 'named Point Hub')
  ok(m.start_url === '/?app=1' && m.scope === '/', 'starts at /?app=1 — how the console knows it is the installed app')
  ok(m.display === 'fullscreen' && JSON.stringify(m.display_override) === '["fullscreen","standalone"]', 'full screen, standalone as the fallback')
  ok(m.orientation === 'landscape', 'landscape')
  ok(/^#[0-9a-f]{6}$/i.test(m.background_color) && /^#[0-9a-f]{6}$/i.test(m.theme_color), 'background and theme colours set')
  ok(/--bg:#ffffff/.test(html) && m.background_color.toLowerCase() === '#ffffff', 'the splash is the console\'s own background, not a flash of another colour')
  ok(/<link rel="manifest" href="\/manifest\.webmanifest">/.test(html), 'the console links it')
  ok(new RegExp(`<meta name="theme-color" content="${m.theme_color}">`).test(html), 'and carries the same theme-color')

  console.log('\n[2] the icons')
  const icons = Array.isArray(m.icons) ? m.icons : []
  for (const want of [['192x192', 'any'], ['512x512', 'any'], ['192x192', 'maskable'], ['512x512', 'maskable']]) {
    const icon = icons.find((i) => i.sizes === want[0] && (i.purpose || 'any').split(' ').includes(want[1]))
    if (!icon) { ok(false, `${want[1]} ${want[0]} listed`); continue }
    const r = await fetch(base(app) + icon.src)
    const buf = Buffer.from(await r.arrayBuffer())
    const size = pngSize(buf)
    ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && size && `${size[0]}x${size[1]}` === want[0],
      `${want[1]} ${want[0]}: ${icon.src} is a ${size ? size.join('x') : 'non-'} PNG`)
  }

  console.log('\n[3] /api/status names the https origin')
  const plain = await (await fetch(base(app) + '/api/status')).json()
  ok('httpsOrigin' in plain && plain.httpsOrigin === null, 'null with no certificate configured')
  if (!openssl) {
    console.log('  ⚠️  skipped: no openssl here to make a test certificate')
  } else {
    const dir = path.join(scratch, 'tls')
    const { cert, key } = makeCert(dir, 'DNS:ledbox-test.example.ts.net,DNS:other.example,IP:127.0.0.1')
    const pem = fs.readFileSync(cert)
    ok(httpsOriginFromCert(pem, 8891) === 'https://ledbox-test.example.ts.net:8891', 'the first DNS name, with the port')
    ok(httpsOriginFromCert(pem, 443) === 'https://ledbox-test.example.ts.net', 'no :443 on the default port')
    ok(httpsOriginFromCert('not a certificate', 8891) === null, 'garbage gives null, not a throw')
    const ipOnly = fs.readFileSync(makeCert(path.join(scratch, 'ip'), 'IP:127.0.0.1').cert)
    ok(httpsOriginFromCert(ipOnly, 8891) === null, 'a cert with no DNS name gives null (nowhere valid to send a tablet)')
    const wild = fs.readFileSync(makeCert(path.join(scratch, 'wild'), 'DNS:*.example.ts.net').cert)
    ok(httpsOriginFromCert(wild, 8891) === null, 'a wildcard is not a host')
    const validTo = certValidTo(pem)
    ok(validTo > Date.now() && validTo < Date.now() + 2 * 86400e3, 'the expiry is read from the cert')
    ok(httpsOriginFromCert(pem, 8891, validTo + 1000) === null, 'an expired cert gives null (Chrome would stop on a warning)')
    ok(httpsOriginFromCert(pem, 8891, Date.now() - 86400e3) === null, 'and so does one not yet valid')

    const tlsApp = await boot(path.join(scratch, 'secure'), { tlsCert: cert, tlsKey: key, httpsPort: 0 })
    apps.push(tlsApp)
    const st = await (await fetch(base(tlsApp) + '/api/status')).json()
    ok(/^https:\/\/ledbox-test\.example\.ts\.net:\d+$/.test(st.httpsOrigin || ''), `set from the loaded cert (${st.httpsOrigin})`)
    // Past the cert's expiry the board stops offering it, even with no renewal to replace it.
    tlsApp.server.setHttpsOrigin('https://lapsed.example.ts.net:8891', Date.now() - 1000)
    ok((await (await fetch(base(tlsApp) + '/api/status')).json()).httpsOrigin === null, 'not offered once the cert has expired')
    tlsApp.server.setHttpsOrigin(st.httpsOrigin, validTo)

    // A renewal re-issued for another name: written beside it and renamed over, as `tailscale cert` does.
    const next = makeCert(path.join(scratch, 'renew'), 'DNS:ledbox-renamed.example.ts.net')
    fs.copyFileSync(next.key, key + '.tmp'); fs.renameSync(key + '.tmp', key)
    fs.copyFileSync(next.cert, cert + '.tmp'); fs.renameSync(cert + '.tmp', cert)
    let after = null
    for (let i = 0; i < 40 && !/renamed/.test(after || ''); i++) {
      await sleep(200)
      after = (await (await fetch(base(tlsApp) + '/api/status')).json()).httpsOrigin
    }
    ok(/^https:\/\/ledbox-renamed\.example\.ts\.net:\d+$/.test(after || ''), `follows a hot-reloaded cert (${after})`)
  }

  console.log('\n[4] the console')
  ok(/const APP_MODE = APP_QUERY\s*\|\|/.test(html) && /display-mode: fullscreen/.test(html) && /display-mode: standalone/.test(html),
    'app mode = ?app=1 or an installed display mode')
  ok(/u\.searchParams\.delete\("app"\);\s*history\.replaceState/.test(html) && /sessionStorage\.setItem\("appMode", "1"\)/.test(html),
    '?app=1 is taken out of the address bar once read ("Open in Chrome" must not carry it), kept for the tab\'s own reloads')
  ok(/const want = APP_MODE \? awakeRefused : canFS && isTouch\(\) && !inFS\(\)/.test(html), 'the installed app skips the full-screen gate unless keep-awake was refused')
  ok(/if \(APP_MODE\) \{\s*lockLandscape\(\);\s*setKeepAwake\(true, \{ quiet: true \}\)/.test(html), 'and switches keep-awake on at launch, landscape-locked, with no tap')
  ok(/awakeRefused = !held;\s*syncGate\(\);/.test(html), 'a refused wake lock brings the gate back for the video fallback\'s tap')
  ok(/if \(APP_MODE && !awakeHeld\(\)\) \{ awakeRefused = true; syncGate\(\); \}/.test(html), 'and is re-taken on every return to the page')
  ok(/if \(st\.httpsOrigin\) \{ if \(secureOk\) goSecure\(\); else noteSecure\(st\.httpsOrigin\); \}/.test(html), 'every status reply is checked for a secure address')
  ok(/location\.protocol !== "http:" \|\| origin === location\.origin/.test(html), 'only a console on plain http, not already there, moves')
  ok(/mode: "no-cors"/.test(html) && /setTimeout\(\(\) => ctl\.abort\(\), 3000\)/.test(html), 'the address is probed first (no-cors, 3 s), so an unreachable one leaves it on http')
  ok(/sessionStorage\.getItem\("secureTried"\) === origin\) return/.test(html) && /sessionStorage\.setItem\("secureTried", SECURE_ORIGIN\)/.test(html), 'once per tab — no redirect loop')
  ok(/if \(!now && !\(quietForReload\(\) && nothingHalfEntered\(\)\)\) \{ \$\("#secureBar"\)\.hidden = false; return; \}/.test(html) && /id="secureBar"[^>]*hidden/.test(html) && /id="secureNow"/.test(html),
    'never mid-match, nor over a half-entered dialog or code: a "Switch" bar instead')
  ok(/new URL\(location\.pathname \+ location\.search \+ location\.hash, SECURE_ORIGIN\)/.test(html) && /if \(APP_QUERY\) to\.searchParams\.set\("app", "1"\)/.test(html) && /location\.replace\(to\.href\)/.test(html),
    'same path and query on the far side, ?app=1 put back')
  ok(/navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/", updateViaCache: "none" \}\)/.test(html) && /window\.isSecureContext && location\.protocol === "https:"/.test(html),
    'the service worker is registered only over https, re-fetched past the HTTP cache')

  console.log('\n[5] the service worker')
  const swRes = await fetch(base(app) + '/sw.js')
  const sw = await swRes.text()
  ok(swRes.status === 200 && /javascript/.test(swRes.headers.get('content-type') || ''), `served as a script (${swRes.headers.get('content-type')})`)
  ok(!/\bcaches\s*\.|\.put\(|indexedDB\./.test(sw), 'no Cache Storage, no IndexedDB: nothing in it can serve an old console')
  // Run it against a stand-in `self` and drive its fetch handler as the browser would.
  const listeners = {}
  let netOk = true
  const ctx = vm.createContext({
    self: { addEventListener: (t, f) => { listeners[t] = f }, skipWaiting: () => {}, clients: { claim: async () => {} } },
    fetch: async (req) => { if (!netOk) throw new TypeError('Failed to fetch'); return new Response('console for ' + req.url) },
    Response,
  })
  vm.runInContext(sw, ctx)
  const drive = async (mode, url) => {
    let answered = null
    listeners.fetch({ request: { mode, url }, respondWith: (p) => { answered = p } })
    return answered && (await answered)
  }
  ok(!(await drive('cors', '/api/status')) && !(await drive('no-cors', '/icon-192.png')),
    'the API and every other request are left to the browser (no respondWith)')
  const live = await drive('navigate', '/')
  ok(live && (await live.text()) === 'console for /', 'a page load with the board reachable is the network\'s answer, untouched')
  netOk = false
  const down = await drive('navigate', '/?app=1')
  const downText = down ? await down.text() : ''
  ok(down && down.status === 503 && /text\/html/.test(down.headers.get('content-type') || ''), 'a failed page load gets a page, not Chrome\'s error screen')
  ok(/href="http:\/\/172\.24\.1\.1:8890\/"/.test(downText) && /location\.reload\(\)/.test(downText), 'which links the plain address, and can try again')
} finally {
  for (const a of apps) await a.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
