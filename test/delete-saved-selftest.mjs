// Deleting the saved game clears the board it is showing; New can start with both names set.
//
// "Delete saved game" used to be housekeeping only: the resume slot went, and the panel went on
// showing the deleted match — names, score and all — which a volunteer reads as "Delete did
// nothing". Now, when the board is showing the saved game (or nothing has been done since boot or
// Continue), it is reset to a fresh 0-0 with no names and the wall clock held on the panel.
// A board showing anything else is left alone.
//
// And New from today's schedule: POST /api/game {choice:'new', teams} sets both teams before the
// first paint, so the hall goes straight from the clock to "KSCW H1 0 : 0 KSCW H3" — never
// through HOME / AWAY.
//
//   [1] New with teams: names on the panel, no HOME/AWAY painted on the way, persisted
//   [2] delete while showing the saved game: slot gone, 0-0, no names, clock on the panel
//   [3] after the delete, the first point brings the scoreboard back
//   [4] delete after a finished match (slot already gone): the board is left alone
//   [5] fresh boot with a saved slot nobody continued: delete clears (nothing touched)
//   [6] Continue, then delete at once: clears
//   [7] New without teams is unchanged
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-delete-'))
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
const mock = new MockLedbox({
  layouts: {
    kscw_idle: sectionsOf('30_kscw_idle.xml'),
    kscw_crest: sectionsOf('32_kscw_crest.xml'),
    kscw_clock: sectionsOf('33_kscw_clock.xml'),
  },
})
const addr = await mock.listen(0, '127.0.0.1')
// Every team-name text the panel was sent, in order.
const painted = []
mock.on('command', (m) => {
  if (m.cmd !== 'SetSections') return
  for (const s of [].concat(m.value || [])) if ((s.name === 'team1' || s.name === 'team2') && s.value && s.value.attrib === 'text') painted.push(s.value.value)
})
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
const get = async (route) => (await fetch(base() + route)).json()
const slot = () => {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'data', 'resume.json'), 'utf8')).games.volleyball || null } catch { return null }
}
const point = (side) => post('/api/action', { action: { type: 'point', side, delta: 1 } })
const TEAMS = { left: { name: 'KSC Wiedikon H1', short: 'KSCW H1' }, right: { name: 'KSC Wiedikon H3', short: 'KSCW H3' } }

try {
  app = await boot()
  await sleep(300)

  console.log('[1] New with both teams, from the schedule')
  painted.length = 0
  let r = await post('/api/game', { choice: 'new', teams: TEAMS })
  ok(r && r.ok === true, 'accepted')
  ok(r.state.team_a_short === 'KSCW H1' && r.state.team_b_short === 'KSCW H3', `home on the left (${r.state.team_a_short} v ${r.state.team_b_short})`)
  ok(r.state.team_a_name === 'KSC WIEDIKON H1' && r.state.team_b_name === 'KSC WIEDIKON H3', 'full names stored (in capitals, like a typed edit)')
  ok(r.state.points_a === 0 && r.state.points_b === 0, 'at 0-0')
  ok(mock.currentLayout === 'volleyball_matchscore_02' && mock.text('team1') === 'KSCW H1' && mock.text('team2') === 'KSCW H3', `the panel shows them (${mock.text('team1')} / ${mock.text('team2')})`)
  ok(!painted.some((t) => /HOME|AWAY/.test(t)), `no HOME / AWAY painted on the way (${painted.join(', ')})`)
  ok(slot() && slot().state.team_a_short === 'KSCW H1', 'persisted in the resume slot like any action')
  ok(r.canUndo === false, 'nothing to undo: the names are the start of the match, not a step in it')
  r = await post('/api/game', { choice: 'new', teams: { left: { name: '<b>\u0007x', short: 'A'.repeat(40) }, right: { name: 'Gäste', short: '' } } })
  ok(r.state.team_a_short.length <= 12 && !/\u0007/.test(r.state.team_a_name), 'names are clamped like any operator text for the panel')
  // Again from the scoreboard itself (the first New came off the boot crest, where idle holds
  // every paint anyway): the reset in between must not reach the panel either.
  await point('left')
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'on the scoreboard mid-match')
  painted.length = 0
  r = await post('/api/game', { choice: 'new', teams: TEAMS })
  ok(!painted.some((t) => /HOME|AWAY|AAAA/.test(t)) && mock.text('team1') === 'KSCW H1', `straight from the old names to the new ones (${painted.join(', ')})`)

  console.log('\n[2] delete while the board shows the saved game')
  await point('left'); await point('left'); await point('right')
  ok(slot() && slot().state.points_a === 2, 'the match is saved at 2-1')
  r = await post('/api/game', { choice: 'delete' })
  ok(r.ok === true && r.saved === null && r.cleared === true, 'deleted, and the response says the board was cleared')
  ok(slot() === null, 'the slot is gone')
  ok(r.state.points_a === 0 && r.state.points_b === 0 && !r.state.team_a_name && !r.state.team_b_name, `the response carries the new state: 0-0, no names (${r.state.team_a_short}/${r.state.team_b_short})`)
  ok(mock.currentLayout === 'kscw_clock', `the panel is on the clock, not HOME VS AWAY (${mock.currentLayout})`)
  ok(r.ledbox.clockHeld === true, 'held, as with Show clock')
  await sleep(1300)
  ok(mock.currentLayout === 'kscw_clock', 'and still after an idle tick')
  ok((await get('/api/game')).saved === null, 'GET /api/game: nothing to continue')

  console.log('\n[3] the next point brings the scoreboard back')
  await point('right')
  ok(mock.currentLayout === 'volleyball_matchscore_02' && mock.text('score2') === '1' && mock.text('score1') === '0', 'scoreboard at 0-1')

  console.log('\n[4] delete after a finished match leaves the board alone')
  await post('/api/action', { action: { type: 'set-state', state: { team_a_short: 'WIN', team_b_short: 'LOSE', sets_won_a: 2, sets_won_b: 0, points_a: 24, points_b: 3 } } })
  const end = await point('left')
  ok(end.event === 'match-end' && slot() === null, `the match ended and dropped its own slot (${end.event})`)
  r = await post('/api/game', { choice: 'delete' })
  ok(r.cleared === false && r.state.sets_won_a === 3 && r.state.team_a_short === 'WIN', 'nothing to delete, and the finished match stays on the board')
  ok(mock.currentLayout !== 'kscw_clock', `no clock forced over it (${mock.currentLayout})`)

  console.log('\n[5] fresh boot with a saved game nobody continued')
  await post('/api/game', { choice: 'new', teams: TEAMS })
  await point('left')
  ok(slot() && slot().state.points_a === 1, 'saved at 1-0')
  await app.close() // a clean shutdown: no automatic restore on the next boot
  app = await boot()
  await sleep(400)
  let st = await get('/api/status')
  ok(!(st.state && st.state.points_a) && (await get('/api/game')).saved, 'the new boot shows a blank board and offers the saved game')
  r = await post('/api/game', { choice: 'delete' })
  ok(r.cleared === true && slot() === null && mock.currentLayout === 'kscw_clock', 'delete: slot gone, board cleared to the clock')

  console.log('\n[6] Continue, then delete straight away')
  await post('/api/game', { choice: 'new', teams: TEAMS })
  await point('left'); await point('left')
  await app.close()
  app = await boot()
  await sleep(400)
  r = await post('/api/game', { choice: 'continue' })
  ok(r.state.points_a === 2 && r.state.team_a_short === 'KSCW H1', 'continued at 2-0')
  r = await post('/api/game', { choice: 'delete' })
  ok(r.cleared === true && r.state.points_a === 0 && !r.state.team_a_name && mock.currentLayout === 'kscw_clock', 'delete clears it off the panel')

  console.log('\n[7] New without teams is unchanged')
  r = await post('/api/game', { choice: 'new' })
  ok(r.ok && r.state.team_a_short === 'HOME' && r.state.team_b_short === 'AWAY' && r.state.points_a === 0, 'the neutral HOME / AWAY board')
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'on the scoreboard')
  st = await get('/api/status')
  ok(st.ledbox.clockHeld === false, 'the clock hold was released')
} finally {
  if (app) await app.close().catch(() => {})
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} delete-saved: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
