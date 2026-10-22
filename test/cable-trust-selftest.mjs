// Cable trust (src/cableTrust.js): a tablet plugged into the board by cable is never asked for the
// scorer PIN — owner decision 2026-10-22. A request counts as cable-trusted when it ARRIVED on the
// board's cable address and CAME FROM the cable subnet; nothing the client sends has any say.
//
//   [1] the rule, on every address shape a socket reports: the cable, the Wi-Fi AP, a Wi-Fi client
//       addressing the cable IP, loopback, IPv4-mapped IPv6, the board itself, junk
//   [2] the settings: on by default, switchable off, a malformed address/subnet fails CLOSED
//   [3] a running board over HTTP: the cable passes every PIN gate (no PIN, a wrong one, many wrong
//       ones — never a lock-out) and is told it needs none; the Wi-Fi, a Wi-Fi client aimed at the
//       cable address, loopback and every spoofed header are refused exactly as before
//   [4] the same over HTTPS (the TLS listener shares the handler)
//   [5] CABLE_TRUST off: the cable is asked like everyone else
//
// The test machine has no 192.168.5.1, so [3]-[5] configure loopback stand-ins: the "cable" is
// 127.0.5.1 with subnet 127.0.5.0/24, a "Wi-Fi tablet" is 127.0.1.x. Linux routes all of 127/8 to
// loopback, and the server listens on 0.0.0.0, so each connection really arrives on the address it
// was aimed at, from the address it was bound to — the very two facts the rule reads.
//
// Plain node, no framework; exits non-zero on any failure.

import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCableTrusted, makeCableTrust, ipv4ToInt, parseCidr, DEFAULT_CABLE_ADDRESS, DEFAULT_CABLE_SUBNET } from '../src/cableTrust.js'
import { loadConfig } from '../src/config.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── [1] ─────────────────────────────────────────────────────────────────────────────────────
console.log('[1] the rule')
const T = (local, remote, label, want, opts) => ok(isCableTrusted(local, remote, opts) === want, `${want ? 'TRUSTED' : 'not trusted'}: ${label} (${local} <- ${remote})`)
T('192.168.5.1', '192.168.5.60', 'a tablet on the cable (DHCP 192.168.5.50-99)', true)
T('::ffff:192.168.5.1', '::ffff:192.168.5.77', 'the same, as a dual-stack listener reports it (IPv4-mapped)', true)
T('192.168.5.1', '::FFFF:192.168.5.99', 'mixed case and mixed forms', true)
T('192.168.5.1', '192.168.5.2', 'a laptop with a hand-set address on the cable', true)
T('172.24.1.1', '172.24.1.23', "a tablet on the board's own Wi-Fi AP", false)
T('192.168.5.1', '172.24.1.23', 'a Wi-Fi client aiming at the cable address (the kernel accepts it on 192.168.5.1)', false)
T('172.24.1.1', '192.168.5.60', 'a cable address arriving on the Wi-Fi address', false)
T('127.0.0.1', '127.0.0.1', 'loopback (a process on the board, a local proxy)', false)
T('::1', '::1', 'IPv6 loopback', false)
T('192.168.5.1', '192.168.5.1', 'the board talking to its own cable address', false)
T('192.168.5.1', '192.168.6.60', 'the next subnet over', false)
T('10.0.0.5', '192.168.5.60', 'the hall uplink address', false)
T('100.101.102.103', '100.64.0.9', 'the tailnet', false)
T('192.168.5.1', 'fe80::1', 'an IPv6 peer', false)
T('', '', 'no addresses (a destroyed socket)', false)
T(undefined, null, 'undefined / null', false)
T('192.168.5.1', '192.168.5.300', 'an out-of-range octet', false)
T('192.168.5.1', ' 192.168.5.60 ', 'surrounding spaces are not an address the kernel reports, but harmless', true)
T('10.9.9.1', '10.9.9.40', 'a configured cable (10.9.9.1, 10.9.9.0/26)', true, { address: '10.9.9.1', subnet: '10.9.9.0/26' })
T('10.9.9.1', '10.9.9.40', '…but .40 is outside a /29', false, { address: '10.9.9.1', subnet: '10.9.9.0/29' })
T('192.168.5.1', '192.168.5.60', 'a /32 subnet trusts exactly one tablet…', true, { subnet: '192.168.5.60/32' })
T('192.168.5.1', '192.168.5.61', '…and no other', false, { subnet: '192.168.5.60/32' })
ok(ipv4ToInt('255.255.255.255') === 0xffffffff && ipv4ToInt('0.0.0.0') === 0 && ipv4ToInt('1.2.3') === null && ipv4ToInt('a.b.c.d') === null, 'ipv4ToInt: the extremes, and nothing that is not a dotted quad')
ok(parseCidr('192.168.5.0/24').mask === 0xffffff00 && parseCidr('192.168.5.7/24').net === ipv4ToInt('192.168.5.0'), 'parseCidr: a /24, host bits masked off')
ok(parseCidr('0.0.0.0/0').mask === 0 && parseCidr('1.2.3.4').mask === 0xffffffff, 'parseCidr: /0 and a bare address (/32)')
ok([null, '', '192.168.5.0/33', '192.168.5.0/x', '192.168.5.0/24/1', 'nope/24', '192.168.5.0/'].every((c) => parseCidr(c) === null), 'parseCidr: refuses /33, junk bits, two slashes, a non-address, an empty prefix')

// ── [2] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[2] the settings')
const c0 = loadConfig({})
ok(c0.cableTrust === true && c0.cableAddress === DEFAULT_CABLE_ADDRESS && c0.cableSubnet === DEFAULT_CABLE_SUBNET, `on by default: ${c0.cableAddress} from ${c0.cableSubnet}`)
ok(['0', 'false', 'no', 'off', 'OFF'].every((v) => loadConfig({ CABLE_TRUST: v }).cableTrust === false), 'CABLE_TRUST=0/false/no/off switches it off')
ok(['1', 'on', ''].every((v) => loadConfig({ CABLE_TRUST: v }).cableTrust === true), 'CABLE_TRUST=1/on/empty leaves it on')
const c1 = loadConfig({ CABLE_ADDRESS: ' 10.9.9.1 ', CABLE_SUBNET: '10.9.9.0/28' })
ok(c1.cableAddress === '10.9.9.1' && c1.cableSubnet === '10.9.9.0/28', 'CABLE_ADDRESS / CABLE_SUBNET configure it (a DIY board on another cable subnet)')
const sock = (localAddress, remoteAddress) => ({ localAddress, remoteAddress })
const on = makeCableTrust()
ok(on.enabled && on.off === null && on.trusts(sock('192.168.5.1', '192.168.5.60')), 'makeCableTrust(): on, with the defaults')
ok(!on.trusts(null) && !on.trusts({}), 'no socket, or one without addresses: not trusted')
const offT = makeCableTrust({ enabled: false })
ok(!offT.enabled && offT.off === 'disabled' && !offT.trusts(sock('192.168.5.1', '192.168.5.60')), 'switched off: nobody is trusted')
for (const [address, subnet] of [['192.168.5', DEFAULT_CABLE_SUBNET], [DEFAULT_CABLE_ADDRESS, '192.168.5.0/40'], ['fe80::1', DEFAULT_CABLE_SUBNET]]) {
  const bad = makeCableTrust({ address, subnet })
  ok(!bad.enabled && bad.off === 'invalid' && !bad.trusts(sock('192.168.5.1', '192.168.5.60')), `a malformed setting (${address} ${subnet}) fails CLOSED: off, and says why`)
}
const src = fs.readFileSync(path.join(root, 'src', 'cableTrust.js'), 'utf8').replace(/\/\/.*$/gm, '')
ok(!/headers|x-forwarded|forwarded|query|searchParams|req\.url/i.test(src), 'cableTrust.js never reads a header, the URL or a query (only the two socket addresses)')
const cs = fs.readFileSync(path.join(root, 'src', 'controlServer.js'), 'utf8')
ok(/req\._pinTrust = cable\.trusts\(req\.socket\) \? 'cable' : null/.test(cs), 'controlServer asks it with req.socket, nothing else')
ok(/const pinOk = \(req\) => \{[\s\S]{0,300}if \(trustOf\(req\)\) return true/.test(cs), 'and pinOk — every PIN-gated route — lets a cable-trusted request through first')
ok(/else if \(trustOf\(req\)\) roster = await gameSheet\.view/.test(cs), "the match sheet's roster gate too (only the board-level \"no PIN set at all\" rule stays)")

// ── [3]-[5] ─────────────────────────────────────────────────────────────────────────────────
const PIN = '2468'
const CABLE = '127.0.5.1', CABLE_NET = '127.0.5.0/24'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-cable-'))
let openssl = true
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { openssl = false }
let tls = null
if (openssl) {
  const cert = path.join(scratch, 'board.crt'), key = path.join(scratch, 'board.key')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=point-hub-test', '-addext', 'subjectAltName=DNS:board.test'], { stdio: 'ignore' })
  tls = { tlsCert: cert, tlsKey: key, httpsPort: 0 }
}

async function boardWith(name, extra) {
  const stateDir = path.join(scratch, name)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ sport: 'volleyball', scorerPin: PIN }))
  const app = await startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
    ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
    mock: true, controlPort: 0, debug: false,
    uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
    cableAddress: CABLE, cableSubnet: CABLE_NET,
    ...(tls || {}), ...extra,
  })
  await sleep(150)
  return app
}

// One request, from `from` to `to`, over http or https. `headers` adds anything a client might try.
function call(app, { scheme = 'http', to, from, method = 'GET', route, body, pin, headers = {} }) {
  const port = scheme === 'https' ? app.tlsPort : app.server.address().port
  const payload = method === 'GET' ? null : JSON.stringify(body ?? {})
  const h = { ...headers }
  if (payload !== null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload) }
  if (pin !== undefined) h['X-Scorer-Pin'] = pin
  const lib = scheme === 'https' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: to, port, path: route, method, headers: h, localAddress: from, rejectUnauthorized: false, agent: false }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => { let json = null; try { json = JSON.parse(data) } catch {} resolve({ status: res.statusCode, json }) })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

const ACTION = { action: { type: 'point', side: 'left', delta: 1 } }
async function sweep(app, scheme) {
  const tablet = { scheme, to: CABLE, from: '127.0.5.60' }
  console.log(`\n  ${scheme.toUpperCase()} — the cable (${CABLE} <- 127.0.5.60):`)
  const st = await call(app, { ...tablet, route: '/api/status' })
  ok(st.status === 200 && st.json.pinRequired === false && st.json.pinTrust === 'cable' && st.json.pinConfigured === true,
    `GET /api/status: pinRequired false, pinTrust "cable", pinConfigured true (${JSON.stringify({ r: st.json && st.json.pinRequired, t: st.json && st.json.pinTrust })})`)
  const se = await call(app, { ...tablet, route: '/api/settings' })
  ok(se.json && se.json.pinSet === false && se.json.pinConfigured === true && se.json.scorerPin === '',
    'GET /api/settings: pinSet false — the tablet app\'s start-up lock stays down — while pinConfigured says one exists (and the PIN itself is never sent)')
  ok((await call(app, { ...tablet, method: 'POST', route: '/api/clock', body: { epochMs: Date.now() } })).status === 200, 'the app\'s first write at start (the clock offer) passes')
  ok((await call(app, { ...tablet, method: 'POST', route: '/api/action', body: ACTION })).status === 200, 'a point with NO PIN passes')
  ok((await call(app, { ...tablet, method: 'POST', route: '/api/action', body: ACTION, pin: '0000' })).status === 200, 'a point with a WRONG (stale) PIN passes')
  let worst = 0
  for (let i = 0; i < 10; i++) worst = Math.max(worst, (await call(app, { ...tablet, method: 'POST', route: '/api/action', body: ACTION, pin: '9' + i })).status)
  ok(worst === 200, `ten wrong PINs in a row: never a 403 or a 429 (worst ${worst})`)
  ok((await call(app, { ...tablet, method: 'POST', route: '/api/settings', body: { clubName: 'CABLE OK' } })).status === 200, 'a settings save passes')
  const un = await call(app, { ...tablet, method: 'POST', route: '/api/unlock', body: { pin: '1111' } })
  ok(un.status === 200 && un.json.ok === false && un.json.trusted === 'cable', '/api/unlock still answers a wrong PIN truthfully (ok:false, trusted:"cable") — a client must not store a wrong one')
  const un2 = await call(app, { ...tablet, method: 'POST', route: '/api/unlock', body: { pin: PIN } })
  ok(un2.json && un2.json.ok === true, '…and the right one ok:true')
  // A second cabled tablet, and the cable's own address range.
  ok((await call(app, { scheme, to: CABLE, from: '127.0.5.99', method: 'POST', route: '/api/action', body: ACTION })).status === 200, 'another tablet on the cable (.99) passes too')

  console.log(`  ${scheme.toUpperCase()} — not the cable:`)
  const wifi = { scheme, to: '127.0.0.1', from: '127.0.1.23' }
  const ws = await call(app, { ...wifi, route: '/api/status' })
  ok(ws.json && ws.json.pinRequired === true && ws.json.pinTrust === null, `a Wi-Fi tablet: pinRequired true, pinTrust null`)
  const wse = await call(app, { ...wifi, route: '/api/settings' })
  ok(wse.json && wse.json.pinSet === true && wse.json.pinConfigured === true, '  GET /api/settings: pinSet true')
  ok((await call(app, { ...wifi, method: 'POST', route: '/api/action', body: ACTION })).status === 403, '  a point with no PIN: 403')
  ok((await call(app, { ...wifi, method: 'POST', route: '/api/action', body: ACTION, pin: PIN })).status === 200, '  with the PIN: 200')
  ok((await call(app, { scheme, to: CABLE, from: '127.0.1.24', method: 'POST', route: '/api/action', body: ACTION })).status === 403,
    'a Wi-Fi client aiming at the CABLE address (arrives on it, but not from the cable subnet): 403')
  ok((await call(app, { scheme, to: '127.0.0.1', from: '127.0.5.61', method: 'POST', route: '/api/action', body: ACTION })).status === 403,
    'a cable-subnet address arriving on another address: 403')
  ok((await call(app, { scheme, to: '127.0.0.1', from: '127.0.0.1', method: 'POST', route: '/api/action', body: ACTION })).status === 403, 'loopback: 403')
  const SPOOFS = [
    { 'X-Forwarded-For': '127.0.5.60' }, { 'X-Real-IP': '127.0.5.60' }, { Forwarded: 'for=127.0.5.60' },
    { 'X-Forwarded-For': '192.168.5.60' }, { 'X-Cable': '1' }, { 'X-Pin-Trust': 'cable' }, { Host: `${CABLE}:8890` },
  ]
  // Each from its own Wi-Fi address: one source sending all of them would trip the brute-force
  // lock-out (a missing PIN counts as a wrong one) and measure the throttle instead of the trust.
  for (const [i, h] of SPOOFS.entries()) {
    const r = await call(app, { scheme, to: '127.0.0.1', from: `127.0.${scheme === 'https' ? 2 : 1}.${30 + i}`, method: 'POST', route: '/api/action', body: ACTION, headers: h })
    ok(r.status === 403, `a spoofed ${Object.keys(h)[0]}: ${Object.values(h)[0]} from the Wi-Fi: 403 (got ${r.status})`)
  }
  for (const q of ['?cable=1', '?trust=cable', '?pinTrust=cable']) {
    ok((await call(app, { scheme, to: '127.0.0.1', from: `127.0.${scheme === 'https' ? 2 : 1}.${50 + q.length}`, method: 'POST', route: '/api/action' + q, body: ACTION })).status === 403, `a query flag (${q}): 403`)
  }
  const sp = await call(app, { scheme, to: '127.0.0.1', from: '127.0.1.27', route: '/api/status', headers: { 'X-Forwarded-For': '127.0.5.60' } })
  ok(sp.json && sp.json.pinTrust === null && sp.json.pinRequired === true, 'and a spoofed header does not make /api/status say "cable" either')
}

let app = null
try {
  console.log('\n[3]/[4] a running board with a PIN set')
  app = await boardWith('on', {})
  if (tls) app.tlsPort = await tlsPortOf(app)
  await sweep(app, 'http')
  if (tls && app.tlsPort) await sweep(app, 'https')
  else console.log('  ⚠️  HTTPS skipped: no openssl here to make a test certificate')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  if (app) await app.close()
}

let offApp = null
try {
  console.log('\n[5] CABLE_TRUST off')
  offApp = await boardWith('off', { cableTrust: false })
  if (tls) offApp.tlsPort = await tlsPortOf(offApp)
  for (const scheme of tls && offApp.tlsPort ? ['http', 'https'] : ['http']) {
    const st = await call(offApp, { scheme, to: CABLE, from: '127.0.5.60', route: '/api/status' })
    ok(st.json && st.json.pinRequired === true && st.json.pinTrust === null, `${scheme}: the cable is told it needs the PIN`)
    ok((await call(offApp, { scheme, to: CABLE, from: '127.0.5.60', method: 'POST', route: '/api/action', body: ACTION })).status === 403, `${scheme}: and a point without it is 403`)
  }
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  if (offApp) await offApp.close()
}

// The HTTPS listener's port: /api/status names the https origin, port included (board.test:<port>).
async function tlsPortOf(a) {
  const st = await (await fetch(`http://127.0.0.1:${a.server.address().port}/api/status`)).json()
  const m = /^https:\/\/board\.test:(\d+)$/.exec(st.httpsOrigin || '')
  return m ? Number(m[1]) : null
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — cable-trust-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
