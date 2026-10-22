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
// The second half does the same for a board that MUST have a PIN and has none yet (the mandatory
// PIN, system-12): every guarded route refuses with the setup message, the save that sets the first
// PIN is the one write that needs none, and nothing is counted towards a lock-out until a PIN exists.
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
  // During the setup only a save that SETS the first PIN gets through (asserted separately below).
  '/api/settings': { guard: 'pin', body: { brightness: 50 } },
  '/api/sport': { guard: 'pin', body: { sport: 'volleyball' }, skipAuthed: 'a real switch restarts the appliance' },
  '/api/link': { guard: 'pin', body: { source: 'lan', matchId: 'x' }, skipAuthed: 'reaches for an unreachable relay' },
  '/api/countdown': { guard: 'pin', body: { seconds: 5 } },
  '/api/countdown/stop': { guard: 'pin', body: {} },
  '/api/idle': { guard: 'pin', body: { on: true } },
  // Sets the host clock (`sudo date`). The authed probe offers this machine's OWN time on purpose:
  // that is under clockSync's 30 s "close enough" floor (or NTP already has the clock), so it is
  // answered 200 with applied:false and can never move the clock of the machine running the test.
  // During the PIN setup it is let through (the tablet app offers it at start-up; see /api/clock).
  '/api/clock': { guard: 'pin', body: { epochMs: Date.now() }, setup: 'open' },
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
  '/api/uplink/portal': { guard: 'pin', body: {} },
  // Game info is the public schedule; the roster inside the answer is PIN-gated in the body, and a
  // missing PIN must NOT count as a guess (a locked tablet polls it) — test/gamesheet-selftest.mjs.
  '/api/gamesheet': { guard: 'open', body: {}, why: 'game info is public; the roster in it needs the PIN (gamesheet-selftest)' },
  '/api/logs': { guard: 'open', body: { msg: 'ui event' }, why: 'the console posts its own errors; a spectator hitting a bug is what we want to see' },
  '/api/unlock': { guard: 'unlock', body: { pin: PIN } },
}
// What each route does during the setup, unauthenticated, when it differs from its guard:
//   'setup'  (the default for a 'pin' route) -> 403 { pinSetup: true, error: names Settings }
//   'open'   -> through
//   'unlock' -> 409 { pinSetup: true } — there is no PIN to check a guess against

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

// ── the mandatory PIN: a board that must have one and has none yet ──────────────────────────
const setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-auth-setup-'))
fs.writeFileSync(path.join(setupDir, 'settings.json'), JSON.stringify({ sport: 'volleyball' }))
const setupApp = await startAppliance({
  stateDir: setupDir, pinMandatory: true,
  relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
  mock: true, controlPort: 0, debug: false,
  uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
})
const sbase = `http://127.0.0.1:${setupApp.server.address().port}`
await sleep(200)
const sreq = (route, { method = 'POST', body, pin, from } = {}) => new Promise((resolve, reject) => {
  const payload = method === 'GET' ? null : JSON.stringify(body ?? {})
  const headers = { origin: sbase }
  if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
  if (pin !== undefined) headers['X-Scorer-Pin'] = pin
  const req = http.request(
    { host: '127.0.0.1', port: setupApp.server.address().port, path: route, method, headers, localAddress: from },
    (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c }); res.on('end', () => { let json = null; try { json = JSON.parse(d) } catch {} resolve({ status: res.statusCode, json }) }) })
  req.on('error', reject)
  if (payload !== null) req.write(payload)
  req.end()
})
try {
  console.log('\nmandatory PIN, none set yet — every guarded route refuses with the way out:')
  let host = 0
  for (const [route, spec] of Object.entries(ROUTES)) {
    // Never sent here, not even unauthenticated: a bug that let them through during the setup would
    // halt or reboot the machine running the test. They go through the same pinOk as every route
    // swept here, and their refusal with a PIN set is asserted above.
    if (route === '/api/shutdown' || route === '/api/reboot') { console.log(`  ↷ ${route} not sent: ${spec.skipAuthed}`); continue }
    const want = spec.setup || (spec.guard === 'pin' ? 'setup' : spec.guard)
    const r = await sreq(route, { body: spec.body, from: `127.0.5.${++host}` })
    if (want === 'setup') ok(r.status === 403 && r.json && r.json.pinSetup === true && /Settings/.test(r.json.error) && /PIN/.test(r.json.error), `POST ${route} -> 403 pinSetup (got ${r.status})`)
    else if (want === 'open') ok(r.status < 400, `POST ${route} -> ${r.status}, open${spec.why ? `: ${spec.why}` : ' during the setup'}`)
    else ok(r.status === 409 && r.json && r.json.pinSetup === true && r.json.ok === false, `POST ${route} -> 409 pinSetup, no PIN to check (got ${r.status})`)
  }
  const st = await (await fetch(sbase + '/api/status')).json()
  ok(st.pinRequired === true && st.pinSetup === true && st.pinMandatory === true && st.pinConfigured === false, '/api/status: pinRequired, pinSetup, pinMandatory true; pinConfigured false')
  const se = await (await fetch(sbase + '/api/settings')).json()
  ok(se.pinSet === false && se.pinSetup === true, '/api/settings: pinSet false (no PIN anyone could type), pinSetup true')
  for (const route of ['/api/status', '/api/board', '/api/sport', '/api/settings', '/api/game', '/api/history', '/api/uplink']) {
    ok((await fetch(sbase + route)).status === 200, `GET ${route} still open`)
  }

  console.log('\nduring the setup nothing is counted — there is no PIN to guess:')
  let worst = 0
  for (let i = 0; i < 10; i++) worst = Math.max(worst, (await sreq('/api/action', { body: ROUTES['/api/action'].body, pin: String(1000 + i), from: '127.0.6.1' })).status)
  ok(worst === 403, `ten writes with made-up PINs from one address: 403 every time, never 429 (worst ${worst})`)
  for (let i = 0; i < 8; i++) await sreq('/api/unlock', { body: { pin: String(2000 + i) }, from: '127.0.6.1' })

  console.log('\nsetting the first PIN — the one write that needs none:')
  ok((await sreq('/api/settings', { body: { brightness: 50 }, from: '127.0.6.2' })).status === 403, 'a save WITHOUT a PIN in it is still refused')
  ok((await sreq('/api/settings', { body: { scorerPin: '12ab' }, from: '127.0.6.2' })).status === 400, 'a malformed PIN is refused with its reason (400), not as a missing PIN')
  ok((await sreq('/api/settings', { body: { clearPin: true }, from: '127.0.6.2' })).status === 403, 'clearPin is no way in')
  const set = await sreq('/api/settings', { body: { scorerPin: PIN, clubName: 'SETUP TEST' }, from: '127.0.6.1' })
  ok(set.status === 200 && set.json.pinSet === true && set.json.pinSetup === false, `a save with a valid PIN sets it (200, pinSet true, pinSetup false) — from the address that just made 18 refused attempts`)
  ok(set.json.clubName === 'SETUP TEST', 'and the rest of that save is applied with it')
  ok(JSON.parse(fs.readFileSync(path.join(setupDir, 'settings.json'), 'utf8')).scorerPin === PIN, 'persisted')
  ok((await sreq('/api/settings', { body: { scorerPin: '9999' }, from: '127.0.6.3' })).status === 403, 'once set, a second "first PIN" is a PIN change and needs the PIN')

  console.log('\nafter the setup — the board behaves like any board with a PIN:')
  ok((await sreq('/api/action', { body: ROUTES['/api/action'].body, from: '127.0.6.4' })).status === 403, 'no PIN: 403')
  ok((await sreq('/api/action', { body: ROUTES['/api/action'].body, pin: PIN, from: '127.0.6.4' })).status === 200, 'the PIN: 200')
  const un = await sreq('/api/unlock', { body: { pin: PIN }, from: '127.0.6.4' })
  ok(un.status === 200 && un.json.ok === true, '/api/unlock with it: ok')
  let locked = 0
  for (let i = 0; i < 8; i++) if ((await sreq('/api/action', { body: ROUTES['/api/action'].body, pin: '0000', from: '127.0.6.5' })).status === 429) locked++
  ok(locked > 0, `and guessing is throttled again (${locked} of 8 locked out)`)
  const rm = await sreq('/api/settings', { body: { clearPin: true }, pin: PIN, from: '127.0.6.6' })
  ok(rm.status === 400 && /can't be removed/.test(rm.json.error), 'the PIN cannot be removed on this board (400, with the reason)')
  ok(JSON.parse(fs.readFileSync(path.join(setupDir, 'settings.json'), 'utf8')).scorerPin === PIN, 'and stays')
  const ch = await sreq('/api/settings', { body: { scorerPin: '5678' }, pin: PIN, from: '127.0.6.6' })
  ok(ch.status === 200 && (await sreq('/api/action', { body: ROUTES['/api/action'].body, pin: '5678', from: '127.0.6.6' })).status === 200, 'it can be changed, with the current one')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  await setupApp.close()
  fs.rmSync(setupDir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
