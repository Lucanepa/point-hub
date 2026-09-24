// Does the scorer PIN actually gate the API?
//
// Everything else in the suite tests PinGate as a class (test/pin-throttle-selftest.mjs) or the
// scoring engines in isolation. Nothing tested that the gate is WIRED. Deleting any one of the
// pinOk() calls in controlServer.js, or fumbling the header name, left `npm test` completely green
// while the board became scoreable by anyone in RF range — and the board's own AP is not
// rate-limited at the firewall, by design, so "anyone in RF range" is the real threat model.
//
// The important part of this file is ROUTES below: it is checked against the source, so a new
// mutating endpoint added without a decision about authentication fails the build rather than
// shipping open.
//
// /api/shutdown is exercised ONLY in the unauthenticated direction. It runs `sudo systemctl
// poweroff` 700 ms after answering, so a test that sent it a valid PIN would halt the machine
// running the test — and, on the board, the scoreboard mid-match.

import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const PIN = '4242'

// Every mutating route, and what it is supposed to do about the PIN.
//   'pin'    -> must refuse an unauthenticated caller
//   'open'   -> deliberately reachable with no PIN, with a stated reason
//   'unlock' -> the PIN exchange itself; refusing it unauthenticated would be a deadlock
const ROUTES = {
  '/api/manual': { guard: 'pin', body: {} },
  '/api/action': { guard: 'pin', body: { action: { type: 'point', side: 'left', delta: 1 } } },
  '/api/settings': { guard: 'pin', body: { brightness: 50 } },
  '/api/sport': { guard: 'pin', body: { sport: 'volleyball' }, skipAuthed: 'a real switch restarts the appliance' },
  '/api/link': { guard: 'pin', body: { source: 'lan', matchId: 'x' }, skipAuthed: 'reaches for an unreachable relay' },
  '/api/countdown': { guard: 'pin', body: { seconds: 5 } },
  '/api/countdown/stop': { guard: 'pin', body: {} },
  '/api/idle': { guard: 'pin', body: { on: true } },
  // Sets the host clock (`sudo date`). The authed probe offers this machine's OWN time on purpose:
  // that is under clockSync's 30 s "close enough" floor (or NTP already has the clock), so it is
  // answered 200 with applied:false and can never move the clock of the machine running the test.
  '/api/clock': { guard: 'pin', body: { epochMs: Date.now() } },
  '/api/game': { guard: 'pin', body: { choice: 'clock' } },
  // Takes the hall from the pre-match clock to the scoreboard.
  '/api/prematch': { guard: 'pin', body: { action: 'start' } },
  // Writes three operator-supplied lines onto the scoreboard in the hall — the most public
  // surface this appliance has, so it is PIN-gated like any other paint.
  '/api/result': { guard: 'pin', body: { winner: 'X WINS', score: '3 - 0', history: '25-23' } },
  // Writes across the whole panel AND can swap the ends — the most consequential of the paint
  // routes, so it is gated like the rest.
  '/api/message': { guard: 'pin', body: { text: 'COURT SWITCH', seconds: 1 } },
  '/api/history/clear': { guard: 'pin', body: {} },
  '/api/logs/level': { guard: 'pin', body: { level: 'info' } },
  '/api/logs/clear': { guard: 'pin', body: {} },
  '/api/shutdown': { guard: 'pin', body: {}, skipAuthed: 'HALTS THE BOARD — never send this a valid PIN' },
  '/api/reboot': { guard: 'pin', body: {}, skipAuthed: 'REBOOTS THE BOARD — never send this a valid PIN' },
  // The hall Wi-Fi login (hallLogin.js). Gated: it acts on the board's uplink, and /login makes the
  // portal send an SMS to whatever number it is given. The authed probes reach nothing — the probe
  // URL below is a closed loopback port, so they answer 200 with the board "offline".
  '/api/uplink/check': { guard: 'pin', body: {} },
  '/api/uplink/login': { guard: 'pin', body: { phone: '079 000 00 00' } },
  '/api/uplink/code': { guard: 'pin', body: { code: '000000' } },
  '/api/logs': { guard: 'open', body: { msg: 'ui event' }, why: 'the console posts its own errors; a spectator hitting a bug is what we want to see' },
  '/api/unlock': { guard: 'unlock', body: { pin: PIN } },
}

// ── the routes list must match the source ────────────────────────────────────────────────────
// This is what makes an unguarded new endpoint fail the build instead of shipping.
const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controlServer.js'), 'utf8')
const declared = [...src.matchAll(/pathname === '(\/api\/[^']*)' && req\.method === '(?:POST|PUT|DELETE)'/g)]
  .map((m) => m[1])
console.log('mutating routes in controlServer.js vs this test:')
const untested = declared.filter((r) => !ROUTES[r])
const stale = Object.keys(ROUTES).filter((r) => !declared.includes(r))
ok(untested.length === 0, `every mutating route is classified${untested.length ? ` — MISSING: ${untested.join(', ')}` : ''}`)
ok(stale.length === 0, `no stale entries${stale.length ? ` — GONE: ${stale.join(', ')}` : ''}`)
ok(declared.length >= 15, `found ${declared.length} mutating routes (regex still matches the source)`)

// ── boot an appliance with a PIN set, against a disposable state dir ──────────────────────────
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-auth-'))
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ scorerPin: PIN, sport: 'volleyball' }))

const app = await startAppliance({
  stateDir,
  relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
  mock: true, controlPort: 0, debug: false,
  // Never the real connectivity check or portal from a test: port 9 on loopback refuses at once.
  uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
})
const base = `http://127.0.0.1:${app.server.address().port}`
await sleep(200)

// Each phase talks from its OWN source address inside 127.0.0.0/8, which the loopback covers
// wholesale on Linux. That is not a trick to dodge the throttle — it is the property being tested.
// The gate is keyed per source IP precisely so one phone hammering the board cannot lock out the
// scorer's tablet, and without separate addresses a sweep of the unauthenticated routes trips its
// own lockout at route six and every later assertion measures the throttle instead of the guard.
//
// Origin is sent on every call because the server refuses cross-origin mutations outright;
// without it we would be measuring the CORS guard rather than the PIN.
const request = (route, { method = 'POST', body, pin, from } = {}) => new Promise((resolve, reject) => {
  const payload = method === 'GET' ? null : JSON.stringify(body ?? {})
  const headers = { origin: base }
  if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
  if (pin !== undefined) headers['X-Scorer-Pin'] = pin
  const req = http.request(
    { host: '127.0.0.1', port: app.server.address().port, path: route, method, headers, localAddress: from },
    (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })) })
  req.on('error', reject)
  if (payload !== null) req.write(payload)
  req.end()
})
const post = async (route, body, pin, from) => (await request(route, { body, pin, from })).status

try {
  console.log('\nunauthenticated — a PIN-guarded route must refuse:')
  let host = 0
  for (const [route, spec] of Object.entries(ROUTES)) {
    const status = await post(route, spec.body, undefined, `127.0.1.${++host}`)
    if (spec.guard === 'pin') ok(status === 403, `POST ${route} -> 403 (got ${status})`)
    else if (spec.guard === 'open') ok(status < 400, `POST ${route} -> ${status}, open on purpose: ${spec.why}`)
    else ok(status === 200, `POST ${route} -> 200, the PIN exchange itself (got ${status})`)
  }

  console.log('\nreads stay open — a spectator can watch without the PIN:')
  for (const route of ['/api/status', '/api/board', '/api/sport', '/api/settings', '/api/game', '/api/history', '/api/uplink']) {
    const res = await fetch(base + route)
    ok(res.status === 200, `GET ${route} -> 200 (got ${res.status})`)
  }
  const shown = await (await fetch(base + '/api/settings')).json()
  ok(shown.scorerPin === '', 'GET /api/settings does not hand the PIN back out')
  ok(shown.pinSet === true, 'but it does say a PIN is set')

  console.log('\nwith the right PIN — the same routes work:')
  for (const [route, spec] of Object.entries(ROUTES)) {
    if (spec.guard !== 'pin') continue
    if (spec.skipAuthed) { console.log(`  ↷ ${route} skipped: ${spec.skipAuthed}`); continue }
    const status = await post(route, spec.body, PIN, '127.0.2.1')
    ok(status < 400, `POST ${route} with PIN -> ${status}`)
  }

  console.log('\na wrong PIN is refused, and guessing gets throttled:')
  const ATTACKER = '127.0.3.1'
  ok(await post('/api/action', ROUTES['/api/action'].body, '9999', ATTACKER) === 403, 'a wrong PIN is 403, not 200')
  let sawLock = 0
  for (let i = 0; i < 8; i++) if (await post('/api/action', ROUTES['/api/action'].body, '0000', ATTACKER) === 429) sawLock++
  ok(sawLock > 0, `sustained guessing hits 429 (${sawLock} of 8 were locked out)`)
  const locked = await request('/api/action', { body: {}, pin: '0000', from: ATTACKER })
  ok(locked.headers['retry-after'] !== undefined, 'a locked-out response carries Retry-After')
  ok((await request('/api/status', { method: 'GET', from: ATTACKER })).status === 200,
    'and reads still work while locked out')
  // The property the whole per-IP design exists for: an attacker cannot lock out the scorer.
  ok(await post('/api/action', ROUTES['/api/action'].body, PIN, '127.0.4.1') < 400,
    'the scorer still scores while another source is locked out')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  await app.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
