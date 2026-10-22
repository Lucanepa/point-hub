// The mandatory scorer PIN, as the people at the board meet it on the day it ships (system-12).
//
// The C0270 runs with no PIN. After the deploy that makes one mandatory, the first operator must be
// able to set one and score — from the tablet app that is ALREADY installed (1.1.x, which knows
// nothing about any of this) and from a browser — and nobody may be trapped behind a screen that
// asks for a PIN that does not exist. This replays, request by request, what those clients send:
//
//   [1] the tablet app 1.1.x on the board's Wi-Fi (GameController.kt: bootLock → offerClock, the
//       status poll, a refused +1, its PIN pad, the embedded console's save, the next +1)
//   [2] a second device afterwards: the board asks it for the PIN like any locked board
//   [3] a tablet on the CABLE during the setup: never blocked, only reminded
//   [4] a board that already has a PIN: nothing changes for it
//   [5] a hand-built (non-mandatory) config keeps the old open no-PIN board
//
// The console's own screens are asserted in test/embed-mode-selftest.mjs [10].
// Plain node, no framework; exits non-zero on any failure.

import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAppliance } from '../src/appliance.js'
import { PIN_SETUP_MSG } from '../src/controlServer.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

// The app's own test for "is this refusal about the PIN?" (GameController.kt `pinWords`): it decides
// whether its PIN pad shows the board's words or "Couldn't reach the board".
const pinWords = (msg) => /pin/i.test(String(msg || ''))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-pinsetup-'))
async function board(name, settings, extra = {}) {
  const stateDir = path.join(scratch, name)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ sport: 'volleyball', ...settings }))
  const app = await startAppliance({
    stateDir, pinMandatory: true,
    relayUrl: '', relayHttpUrl: '', matchId: '',
    ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
    mock: true, controlPort: 0, debug: false,
    uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
    // Loopback stand-ins for the cable (see test/cable-trust-selftest.mjs).
    cableAddress: '127.0.5.1', cableSubnet: '127.0.5.0/24',
    ...extra,
  })
  await sleep(150)
  return { app, stateDir }
}
// A client as BoardApi.kt is one: JSON in, X-Scorer-Pin on every write (even ""), no Origin.
const client = (app, { to = '127.0.0.1', from = '127.0.1.10' } = {}) => {
  const port = app.server.address().port
  const go = (method, route, body, pin) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const headers = { accept: 'application/json' }
    if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); headers['X-Scorer-Pin'] = pin ?? '' }
    const req = http.request({ host: to, port, path: route, method, headers, localAddress: from }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c })
      res.on('end', () => { let json = null; try { json = JSON.parse(d) } catch {} resolve({ status: res.statusCode, json }) })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
  return { get: (r) => go('GET', r), post: (r, b, pin) => go('POST', r, b ?? {}, pin) }
}
const POINT = { action: { type: 'point', side: 'left', delta: 1 } }

const apps = []
try {
  // ── [1] ───────────────────────────────────────────────────────────────────────────────────
  console.log('[1] the tablet app 1.1.x on the Wi-Fi, first open after the deploy')
  const { app, stateDir } = await board('c0270', {})
  apps.push(app)
  const tab = client(app, { from: '127.0.1.10' })
  let appPin = '' // what the app holds (Prefs.scorerPin)
  // bootLock(): GET /api/settings; pinSet false → no lock screen; offerClock().
  const s0 = (await tab.get('/api/settings')).json
  ok(s0.pinSet === false, 'start-up: /api/settings pinSet false — the app\'s full-screen "Scoreboard locked" gate (no way past it but a PIN) stays DOWN')
  ok(s0.pinSetup === true && s0.pinMandatory === true, '  (the new fields say a PIN must be set first)')
  const clock = await tab.post('/api/clock', { epochMs: Date.now() }, appPin)
  ok(clock.status === 200, 'start-up: the clock offer passes — no 403, so no PIN pad pops up unasked')
  // The poll.
  const st = (await tab.get('/api/status')).json
  ok(st.pinRequired === true, 'the status poll: pinRequired true — the app shows its gold padlock and dims the scoring controls')
  // The operator taps +1.
  const p1 = await tab.post('/api/action', POINT, appPin)
  ok(p1.status === 403, 'a +1 is refused with 403 — the app opens its (cancellable) PIN pad')
  ok(p1.json.error === PIN_SETUP_MSG && /Settings/.test(p1.json.error), `…and toasts the board's words: "${p1.json.error}"`)
  ok(p1.json.pinSetup === true, '  (flagged pinSetup, for the console)')
  // They type something into the pad.
  const pad = await tab.post('/api/unlock', { pin: '1234' }, appPin)
  ok(pad.status === 409 && pad.json.ok === false, 'whatever is typed into the pad: 409, not "Wrong PIN" (ok:false would read as a wrong guess)')
  ok(pinWords(pad.json.error) && pad.json.error === PIN_SETUP_MSG, '…and the pad shows the board\'s words (they contain "PIN", which is how the app decides to show them)')
  // The embedded console (Settings tab / its setup screen) sets the PIN — posted with the app's "".
  const save = await tab.post('/api/settings', { scorerPin: '2580' }, appPin)
  ok(save.status === 200 && save.json.pinSet === true && save.json.pinSetup === false, 'the console\'s "Set a scorer PIN" save needs no PIN and sets it')
  appPin = '2580' // the console hands it to the app: setScorerPin("2580")
  ok((await tab.post('/api/action', POINT, appPin)).status === 200, 'the next +1 from the same tablet scores')
  const st2 = (await tab.get('/api/status')).json
  ok(st2.pinRequired === true && st2.pinSetup === false && st2.pinConfigured === true, 'status: a board with a PIN now (the padlock opens, since the app holds it)')
  ok(JSON.parse(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8')).scorerPin === '2580', 'the PIN is on disk — it survives the night')

  // ── [2] ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n[2] a second device afterwards')
  const other = client(app, { from: '127.0.1.11' })
  const o0 = (await other.get('/api/settings')).json
  ok(o0.pinSet === true, 'its start-up sees pinSet true → the usual "Scoreboard locked" screen')
  ok((await other.post('/api/unlock', { pin: '1111' })).json.ok === false, 'a wrong PIN: "Wrong PIN"')
  ok((await other.post('/api/unlock', { pin: '2580' })).json.ok === true, 'the right one unlocks')
  ok((await other.post('/api/action', POINT, '2580')).status === 200, 'and it scores')

  // ── [3] ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n[3] a tablet on the CABLE during the setup')
  const { app: app3 } = await board('cable', {})
  apps.push(app3)
  const cab = client(app3, { to: '127.0.5.1', from: '127.0.5.60' })
  const c0 = (await cab.get('/api/settings')).json
  ok(c0.pinSet === false && c0.pinTrust === 'cable', 'start-up: no lock screen')
  const cs = (await cab.get('/api/status')).json
  ok(cs.pinRequired === false && cs.pinTrust === 'cable', 'status: pinRequired false — no padlock, nothing dimmed')
  ok(cs.pinSetup === true, 'but pinSetup true: the console shows a reminder that Wi-Fi tablets still need a PIN')
  ok((await cab.post('/api/clock', { epochMs: Date.now() })).status === 200 && (await cab.post('/api/action', POINT)).status === 200, 'it scores with no PIN at all')
  ok((await cab.post('/api/game', { choice: 'new' })).status === 200 && (await cab.post('/api/idle', { on: true })).status === 200, 'and starts games, shows the clock — every write')
  const wifi3 = client(app3, { from: '127.0.1.12' })
  ok((await wifi3.post('/api/action', POINT)).status === 403, 'while a Wi-Fi tablet on the same board is still refused')
  ok((await cab.post('/api/settings', { scorerPin: '7777' })).status === 200 && (await wifi3.post('/api/action', POINT, '7777')).status === 200, 'the PIN can be set from the cable too, and then the Wi-Fi uses it')
  ok((await cab.post('/api/action', POINT)).status === 200, 'and the cable still needs none')

  // ── [4] ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n[4] a board that already has a PIN')
  const { app: app4 } = await board('haspin', { scorerPin: '4242' })
  apps.push(app4)
  const t4 = client(app4, { from: '127.0.1.13' })
  const s4 = (await t4.get('/api/settings')).json
  const st4 = (await t4.get('/api/status')).json
  ok(s4.pinSet === true && s4.pinSetup === false && st4.pinRequired === true && st4.pinSetup === false, 'pinSet / pinRequired true, pinSetup false — exactly the board it was')
  const r4 = await t4.post('/api/action', POINT)
  ok(r4.status === 403 && r4.json.error === 'scorer PIN required' && !r4.json.pinSetup, 'a write without the PIN gets the same 403 as before')
  ok((await t4.post('/api/action', POINT, '4242')).status === 200 && (await t4.post('/api/clock', { epochMs: Date.now() })).status === 403, 'with it: 200; the clock offer is gated as before')
  ok((await t4.post('/api/unlock', { pin: '0000' })).status === 200, '/api/unlock answers 200 ok:false as before')

  // ── [5] ───────────────────────────────────────────────────────────────────────────────────
  console.log('\n[5] a hand-built (non-mandatory) config')
  const { app: app5 } = await board('open', {}, { pinMandatory: false })
  apps.push(app5)
  const t5 = client(app5, { from: '127.0.1.14' })
  const st5 = (await t5.get('/api/status')).json
  ok(st5.pinRequired === false && st5.pinSetup === false && st5.pinMandatory === false, 'no PIN, not mandatory: open, as the tests and the bench always had it')
  ok((await t5.post('/api/action', POINT)).status === 200, 'and scores')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  for (const a of apps) await a.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — pin-setup-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
