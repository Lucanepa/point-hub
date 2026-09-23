// The pre-match: a game started from the schedule is set up, but the hall keeps the clock.
//
// A volunteer picks "20:00 KSCW H1 – KSCW H3" at 19:30. Painting 0-0 under the two names then
// meant half an hour of a scoreboard nobody was playing on — and a warm-up countdown whose end
// dropped back onto that same idle clock instead of the match. Now the schedule start keeps the
// clock up (state set behind it), and the MATCH goes on the panel when the warm-up ends, is
// skipped, the scorer taps "Start match now", or scores the first point.
//
//   [1] schedule start with prematch:true → 0-0 set up, the clock held, /api/status prematch
//   [2] naming / colouring a team keeps the pre-match and the clock
//   [3] warm-up runs out → the 0-0 scoreboard is painted, prematch cleared
//   [4] warm-up skipped → the same
//   [5] "Start match now" (POST /api/prematch) → the same; no undo back across it
//   [6] a point clears it and shows the scoreboard; undo stops at 0-0 on the scoreboard
//   [7] Show clock over the pre-match warm-up: the clock wins, the pre-match stays
//   [8] a restart (clean, then a crash) comes back to the pre-match on the clock
//   [9] without prematch:true the schedule start paints 0-0 as before
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const MATCH = 'volleyball_matchscore_02'
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-prematch-'))
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
const mock = new MockLedbox({
  layouts: {
    kscw_idle: sectionsOf('30_kscw_idle.xml'),
    kscw_break: sectionsOf('31_kscw_break.xml'),
    kscw_crest: sectionsOf('32_kscw_crest.xml'),
    kscw_clock: sectionsOf('33_kscw_clock.xml'),
  },
})
const addr = await mock.listen(0, '127.0.0.1')
const boot = () => startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
})
let app = null
const base = () => `http://127.0.0.1:${app.server.address().port}`
const post = async (route, body) => {
  const res = await fetch(base() + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const json = await res.json().catch(() => null)
  await sleep(150)
  return json
}
const status = async () => (await fetch(base() + '/api/status')).json()
const TEAMS = {
  left: { name: 'KSC Wiedikon Herren 1', short: 'KSCW H1' },
  right: { name: 'KSC Wiedikon Herren 3', short: 'KSCW H3' },
}
const schedule = (extra = {}) => post('/api/game', { choice: 'new', teams: TEAMS, prematch: true, ...extra })
const onScoreboard = () => mock.currentLayout === MATCH && mock.text('score1') === '0' && mock.text('score2') === '0' &&
  mock.text('team1') === 'KSCW H1' && mock.text('team2') === 'KSCW H3'

try {
  app = await boot()
  await sleep(300)
  // Something on the board first, so "nothing leaks from the old match" means something.
  await post('/api/manual')
  await post('/api/action', { action: { type: 'team', side: 'left', name: 'Old Team', short: 'OLD' } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 7 } })
  ok(mock.currentLayout === MATCH && mock.text('score1') === '7', 'an old match is on the board (7-0)')

  console.log('\n[1] schedule start → the clock, with the game set up behind it')
  let r = await schedule()
  ok(r && r.ok && r.prematch === true, 'POST /api/game answers prematch:true')
  ok(mock.currentLayout === 'kscw_clock', `the panel shows the clock (${mock.currentLayout})`)
  let st = await status()
  ok(st.prematch === true && st.ledbox.clockHeld === true, '/api/status: prematch, clock held')
  ok(st.state.points_a === 0 && st.state.points_b === 0 && st.state.team_a_short === 'KSCW H1' && st.state.team_b_short === 'KSCW H3', 'state: KSCW H1 v KSCW H3 at 0-0')
  ok(st.canUndo === false, 'nothing to undo')
  await sleep(1300) // a real idle tick
  ok(mock.currentLayout === 'kscw_clock', 'still the clock after the idle ticker ran')

  console.log('\n[2] setting the teams up keeps the pre-match')
  await post('/api/action', { action: { type: 'team', side: 'left', color: '#ff0000' } })
  await post('/api/action', { action: { type: 'serve', side: 'right' } })
  st = await status()
  ok(st.prematch === true && mock.currentLayout === 'kscw_clock', 'a colour and a serve change: still pre-match, still the clock')

  console.log('\n[3] the warm-up runs out → the match')
  r = await post('/api/countdown', { seconds: 1, label: 'WARM-UP' })
  ok(mock.currentLayout === 'kscw_break', `the warm-up countdown is on the panel (${mock.currentLayout})`)
  ok((await status()).prematch === true, 'still pre-match during the warm-up')
  await sleep(2200)
  st = await status()
  ok(st.prematch === false, 'warm-up over: prematch cleared')
  ok(onScoreboard(), `0-0 scoreboard painted (${mock.currentLayout} ${mock.text('team1')} ${mock.text('score1')}-${mock.text('score2')} ${mock.text('team2')})`)
  ok(st.ledbox.idle === false, 'and the board is off idle')

  console.log('\n[4] the warm-up skipped → the match')
  await schedule()
  ok(mock.currentLayout === 'kscw_clock' && (await status()).prematch === true, 'pre-match again, on the clock')
  await post('/api/countdown', { seconds: 600, label: 'WARM-UP' })
  ok(mock.currentLayout === 'kscw_break', 'warm-up running')
  await post('/api/countdown/stop', { expired: false })
  await sleep(150)
  st = await status()
  ok(st.prematch === false && onScoreboard(), `skip: scoreboard 0-0, prematch cleared (${mock.currentLayout})`)

  console.log('\n[5] Start match now')
  await schedule()
  await post('/api/action', { action: { type: 'team', side: 'right', color: '#00ff00' } })
  ok((await status()).canUndo === true, 'a pre-match edit is undoable before the start')
  r = await post('/api/prematch', { action: 'start' })
  ok(r && r.ok && r.started === true && r.prematch === false, 'POST /api/prematch {start}: started')
  ok(onScoreboard(), `the 0-0 scoreboard is painted (${mock.currentLayout})`)
  ok(r.canUndo === false, 'starting is not undoable, and undo does not reach back past it')
  r = await post('/api/prematch', { action: 'start' })
  ok(r && r.ok && r.started === false, 'a second tap: 200, started:false')
  r = await fetch(base() + '/api/prematch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"bogus"}' })
  ok(r.status === 400, 'an unknown action is a 400')
  // Start now while the warm-up is still running
  await schedule()
  await post('/api/countdown', { seconds: 600, label: 'WARM-UP' })
  r = await post('/api/prematch', { action: 'start' })
  await sleep(100)
  ok(r.started === true && onScoreboard() && (await status()).prematch === false, 'start now during the warm-up: the countdown ends, the match is up')
  await sleep(1200)
  ok(mock.currentLayout === MATCH, 'and the countdown does not come back')

  console.log('\n[6] a point starts the match')
  await schedule()
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  st = await status()
  ok(st.prematch === false, 'point: prematch cleared')
  ok(mock.currentLayout === MATCH && mock.text('score1') === '1' && mock.text('team1') === 'KSCW H1', `scoreboard shows 1-0 (${mock.currentLayout} ${mock.text('score1')})`)
  ok(st.canUndo === true, 'the point is undoable')
  await post('/api/action', { action: { type: 'undo' } })
  st = await status()
  ok(st.state.points_a === 0 && st.prematch === false && mock.currentLayout === MATCH, 'undo: 0-0 on the scoreboard, not back to the clock')
  ok(st.canUndo === false, 'and nothing before the start to undo')

  console.log('\n[7] Show clock over the pre-match warm-up')
  await schedule()
  await post('/api/countdown', { seconds: 600, label: 'WARM-UP' })
  r = await post('/api/idle', { on: true, screen: 'clock' })
  ok(mock.currentLayout === 'kscw_clock', `the clock is up (${mock.currentLayout})`)
  await sleep(1300)
  ok(mock.currentLayout === 'kscw_clock', 'and stays up — the countdown ticker is gone')
  st = await status()
  ok(st.prematch === true, 'the pre-match is still pending')
  const board = await (await fetch(base() + '/api/board')).json()
  ok(board.countdown === null, 'no countdown left on /api/board')

  console.log('\n[8] a restart comes back to the pre-match')
  await post('/api/action', { action: { type: 'team', side: 'left', color: '#123456' } })
  const summary = await (await fetch(base() + '/api/game')).json()
  ok(summary.saved && summary.saved.prematch === true, 'the resume slot is marked prematch')
  await app.close()
  app = await boot()
  await sleep(900)
  st = await status()
  ok(st.prematch === true, 'clean restart: prematch is back')
  ok(st.state.team_a_short === 'KSCW H1' && st.state.team_a_color === '#123456' && st.state.points_a === 0, 'with the names and the colour, at 0-0')
  ok(mock.currentLayout === 'kscw_clock', `on the clock (${mock.currentLayout})`)
  // A crash: tear down without close(), so the .running marker survives.
  await new Promise((res) => app.server.close(res))
  app.ledbox.disconnect(); app.livePush.detach(); app.sourceManager.stop()
  app = await boot()
  await sleep(900)
  st = await status()
  ok(st.prematch === true && mock.currentLayout === 'kscw_clock', `crash restart: still the pre-match on the clock (${mock.currentLayout})`)
  await post('/api/prematch', { action: 'start' })
  ok(onScoreboard() && (await status()).prematch === false, 'and it starts from there')
  const after = await (await fetch(base() + '/api/game')).json()
  ok(after.saved && after.saved.prematch === false, 'the slot no longer says prematch')

  console.log('\n[9] without prematch:true the schedule start paints 0-0, as before')
  r = await post('/api/game', { choice: 'new', teams: TEAMS })
  ok(r.prematch === false && onScoreboard(), `scoreboard straight away (${mock.currentLayout})`)
  r = await post('/api/game', { choice: 'new' })
  ok(r.prematch === false, 'a plain New has no pre-match')
} finally {
  if (app) await app.close().catch(() => {})
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} prematch: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
