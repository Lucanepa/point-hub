// "Show clock" means the clock — even with team names on the board.
//
// Before this, POST /api/idle {on:true} (and the game menu's Clock) always went through the usual
// idle choice: names + VS whenever the state carried any names. After a reset the state carries
// HOME / AWAY, so the volunteer who pressed "Show clock" at the end of the evening got
// "HOME VS AWAY" on the wall instead. And had the clock gone up, the idle ticker would have put the
// names screen back a second later, because it too only wanted a clock while no teams were known.
//
//   [1] LedboxClient: screen:'clock' holds kscw_clock with teams set, without a viewer, through
//       idle ticks and internal repaints; with the usual fallbacks clock → crest → named idle
//   [2] it lets go when scoring resumes, idle is turned off, or {on:true} without screen asks again
//   [3] end to end on a mock that has the KSCW layouts: POST /api/idle {on,screen:'clock'},
//       the game menu's Clock, and /api/status reporting it
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LedboxClient } from '../src/ledboxClient.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// A client with the socket stubbed out, as test/idle-clock-selftest.mjs does. `missing` lists
// layouts this "board" refuses with code 5, like a device without the KSCW layouts.
function client({ missing = [], ...opts } = {}) {
  const c = new LedboxClient({ hosts: ['127.0.0.1'], layoutSettleMs: 0, idleTickMs: 0, ...opts })
  c.ready = true
  c.seq = []
  c._sendNow = async (cmd, value) => {
    if (cmd === 'SetLayout') {
      if (missing.includes(value)) { const e = new Error('code 5 - layout not found'); e.code = 5; throw e }
      c.seq.push(`layout:${value}`)
    }
    return 'ok'
  }
  c.on('error', () => {})
  c._lastState = { team_a_short: 'KSCW H1', team_b_short: 'KSCW H3', points_a: 0, points_b: 0 }
  return c
}

console.log('[1] a held clock, with team names set and nobody connected')
{
  const c = client()
  ok(!c.viewerPresent(), 'no viewer (the ordinary clock would not show)')
  await c.showIdle(true)
  ok(c.currentLayout === 'kscw_idle', 'today\'s idle with teams set: the names screen')
  await c.showIdle(true, { screen: 'clock' })
  ok(c.currentLayout === 'kscw_clock', `screen:'clock' puts the clock up anyway (${c.currentLayout})`)
  await c._idleTick()
  await c._idleTick()
  ok(c.currentLayout === 'kscw_clock', 'the idle ticker leaves it there')
  await c.showIdle(true) // what setLimits / a reconnect do
  ok(c.currentLayout === 'kscw_clock', 'so does an internal repaint that names no screen')
  await c.showIdle(true, { screen: 'auto' })
  ok(c.currentLayout === 'kscw_idle', "{on:true} without 'clock' goes back to today's names screen")
  await c._idleTick()
  ok(c.currentLayout === 'kscw_idle', 'and the ticker does not bring the clock back')
}
{
  const c = client({ missing: ['kscw_clock'] })
  await c.showIdle(true, { screen: 'clock' })
  ok(c.currentLayout === 'kscw_crest', `no kscw_clock on the board: the crest (${c.currentLayout})`)
  await c._idleTick()
  ok(c.currentLayout === 'kscw_crest', 'and it stays on the crest, not the names')
}
{
  const c = client({ missing: ['kscw_clock', 'kscw_crest'] })
  await c.showIdle(true, { screen: 'clock' })
  ok(c.currentLayout === 'kscw_idle', `neither: the named idle, as before (${c.currentLayout})`)
}

console.log('\n[2] what lets go of it')
{
  const c = client()
  await c.showIdle(true, { screen: 'clock' })
  await c.showIdle(false)
  ok(c.currentLayout === 'volleyball_matchscore_02' && !c._clockHeld, 'scoring resumes: the match layout, hold released')
  await c.showIdle(true)
  ok(c.currentLayout === 'kscw_idle', 'the next plain idle is the names screen again')
  await c.showIdle(true, { screen: 'clock' })
  await c.pushCountdown(30, 'TIMEOUT')
  ok(!c._clockHeld, 'a countdown (the match is live) releases it too')
}

console.log('\n[2b] scoring while an idle showIdle is still falling back')
{
  // The board refuses the clock's sections once the match layout is up (code 6), which is what
  // a real board does when the operator's showIdle(false) lands between the clock's SetLayout and
  // its paint. The stale call must stop there, not carry on to the crest.
  const c = client()
  c._lastState = null
  c.noteViewer = () => {}
  c._viewerAt = Date.now()
  let board = null
  c._sendNow = async (cmd, value) => {
    if (cmd === 'SetLayout') board = value
    if (cmd === 'SetSections' && board !== 'kscw_clock' && (value || []).some((s) => s.name === 'time')) {
      const e = new Error('code 6 - section not found (6)'); e.code = 6; throw e
    }
    await sleep(5)
    return 'ok'
  }
  const idle = c.showIdle(true)
  await sleep(1)
  const back = c.showIdle(false)
  await Promise.all([idle, back])
  ok(board === 'volleyball_matchscore_02' && c.currentLayout === 'volleyball_matchscore_02',
    `the match layout stays up (board ${board}, client ${c.currentLayout})`)
  ok(c._idle === false, 'and the client still knows it is not idle')
}

console.log('\n[3] end to end through the control server')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-showclock-'))
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
const mock = new MockLedbox({
  layouts: {
    kscw_idle: sectionsOf('30_kscw_idle.xml'),
    kscw_crest: sectionsOf('32_kscw_crest.xml'),
    kscw_clock: sectionsOf('33_kscw_clock.xml'),
  },
})
const addr = await mock.listen(0, '127.0.0.1')
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const post = async (route, body) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const json = await res.json().catch(() => null)
  await sleep(150)
  return json
}
const get = async (route) => (await fetch(base + route)).json()
try {
  await sleep(300)
  await post('/api/manual')
  await post('/api/action', { action: { type: 'team', side: 'left', name: 'KSC Wiedikon H1', short: 'KSCW H1' } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  ok(mock.currentLayout === 'volleyball_matchscore_02' && mock.text('score1') === '1', 'scoring 1-0 on the match layout')

  let r = await post('/api/idle', { on: true })
  ok(r.ok && r.screen === 'auto' && mock.currentLayout === 'kscw_idle', `{on:true}: the names screen, as today (${mock.currentLayout})`)
  r = await post('/api/idle', { on: true, screen: 'clock' })
  ok(r.ok && r.screen === 'clock' && mock.currentLayout === 'kscw_clock', `{on:true, screen:'clock'}: the clock (${mock.currentLayout})`)
  ok(/^\d\d:\d\d:\d\d$/.test(mock.text('time') || ''), `with the time painted (${mock.text('time')})`)
  await sleep(1300) // at least one real idle tick (1 s)
  ok(mock.currentLayout === 'kscw_clock', 'still the clock after the idle ticker has run')
  const st = await get('/api/status')
  ok(st.ledbox.idle === true && st.ledbox.clockHeld === true, '/api/status reports the held clock')

  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  ok(mock.currentLayout === 'volleyball_matchscore_02' && mock.text('score1') === '2', 'scoring resumes: back to the match at 2-0')
  ok((await get('/api/status')).ledbox.clockHeld === false, 'and the hold is gone')

  r = await post('/api/game', { choice: 'clock' })
  ok(r.ok && mock.currentLayout === 'kscw_clock', `the game menu's Clock is the same clock (${mock.currentLayout})`)
  ok(r.state.points_a === 2, 'without touching the score')
  await post('/api/idle', { on: false })
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'idle off: back to the match')
} finally {
  await app.close().catch(() => {})
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} show-clock: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
