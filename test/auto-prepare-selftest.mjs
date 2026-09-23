// The automatic pre-match — autoPrepare.js, driven through a booted appliance on a fake clock.
//
// An hour before a home game the board does the schedule tap itself: names in, 0-0 behind the held
// wall clock, the console's "Ready" banner. Timid on purpose — it never touches a match, never
// puts back a game the scorer took down, and does nothing at all on a clock it cannot believe.
//
//   [1] the window: exactly 60 minutes before counts, a millisecond earlier does not; 30 minutes
//       after the start is the last chance; the earliest of two overlapping games; cancelled and
//       already-prepared games are skipped
//   [2] an unsynced clock does nothing; the setting off does nothing
//   [3] at T-60 exactly: the pre-match for the 20:00 game, as the schedule tap sets it up, logged
//       at info with the game id
//   [4] once prepared, never again: a second tick, and after the scorer dismissed it (Delete)
//   [5] a match in progress is never interrupted — nor a running countdown
//   [6] a pre-match the scorer tapped by hand is this game → filed as prepared, not redone
//   [7] SCHEDULE_HALLS picks the hall's game; the prepared ids survive a restart
//   [8] a match begun at 0-0 (warm-up over, "Start match now", typed names) is never replaced
//   [9] a saved match waiting for "Continue" after a clean restart is never cleared
//   [10] a restored pre-match still knows its game id
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { inWindow, pickGame, LEAD_MS, GRACE_MS } from '../src/autoPrepare.js'
import { zurichDate, zurichEpoch, addDays } from '../src/schedule.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'
import { log } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

console.log('[1] the window')
{
  const g = { id: 1, date: '2026-10-10', time: '20:00' }
  const start = zurichEpoch(g.date, g.time)
  ok(start === Date.parse('2026-10-10T18:00:00Z'), '20:00 in Zurich on a summer-time date is 18:00 UTC')
  ok(inWindow(g, start - LEAD_MS) === true, 'exactly 60 minutes before: in')
  ok(inWindow(g, start - LEAD_MS - 1) === false, '60 minutes and 1 ms before: out')
  ok(inWindow(g, start + GRACE_MS) === true && inWindow(g, start + GRACE_MS + 1) === false, '30 minutes after the start is the last moment')
  const games = [
    { id: 2, date: '2026-10-10', time: '20:15', hall: 'KWI B' },
    { id: 1, date: '2026-10-10', time: '20:00', hall: 'KWI A' },
    { id: 3, date: '2026-10-10', time: '19:45', cancelled: true },
  ]
  const at = start - 30 * 60 * 1000
  ok(pickGame(games, at).id === 1, 'two halls, two games: the earliest playable one')
  ok(pickGame(games, at, new Set(['1'])).id === 2, 'an already-prepared game is skipped')
  ok(pickGame(games, start - LEAD_MS - 1) === null, 'nothing due yet: null')
  ok(zurichEpoch('2026-12-01', '20:00') === Date.parse('2026-12-01T19:00:00Z'), 'and winter time is +1')
}

// Today's games on the fake Directus, so the season copy (which the appliance dates by the real
// clock) and the fake clock below agree on the date.
const T = zurichDate()
const row = (over) => ({ id: 1, date: T, time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'VBC Züri Unterland H2', status: 'scheduled', league: 'Männer 2. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' }, ...over })
const ROWS = [
  row({ id: 901 }),
  row({ id: 902, time: '20:15:00', home_team: 'KSC Wiedikon D2', away_team: 'Volley Näfels D1', hall: { name: 'KWI B' } }),
  row({ id: 903, time: '19:30:00', status: 'cancelled' }),
  row({ id: 904, time: '19:45:00', home_team: 'KSC Wiedikon Lions D1', away_team: 'BC Arlesheim 1LR', kscw_team: { sport: 'basketball' }, hall: { name: 'KWI C' } }),
  row({ id: 905, date: addDays(T, 1) }),
]
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: ROWS }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const START = zurichEpoch(T, '20:00')
const clock = { now: START - LEAD_MS, trusted: true }

const MATCH = 'volleyball_matchscore_02'
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
const dirs = []
const newDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-autoprep-')); dirs.push(d); return d }
const boot = (stateDir) => startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
  autoPrepare: { now: () => clock.now, trusted: async () => clock.trusted },
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
const tick = async () => { const r = await app.server.autoPrepareTick(); await sleep(150); return r }
// Boot, then prime the season copy the way a console would (the background download is off in tests).
const start = async (stateDir) => {
  app = await boot(stateDir)
  await sleep(300)
  const s = await (await fetch(base() + '/api/schedule?range=season')).json()
  if (!s.ok) throw new Error('could not prime the schedule')
}
const logged = []
const unsubscribe = log.subscribe((e) => { if (e.scope === 'autoprepare') logged.push(e) })
const saved = { url: process.env.DIRECTUS_URL, halls: process.env.SCHEDULE_HALLS }

try {
  process.env.DIRECTUS_URL = `http://127.0.0.1:${fake.address().port}`
  delete process.env.SCHEDULE_HALLS
  const dirA = newDir()
  await start(dirA)

  console.log('\n[2] an unsynced clock, the setting off')
  clock.trusted = false
  let r = await tick()
  ok(r.action === 'skip' && r.reason === 'clock-unsynced', `unsynced clock: nothing (${r.reason})`)
  let st = await status()
  ok(st.prematch === false && (!st.state || st.state.team_a_short === 'HOME'), 'the board is untouched')
  clock.trusted = true
  await post('/api/settings', { autoPrepare: false })
  r = await tick()
  ok(r.reason === 'off', 'Settings ▸ automatic off: nothing')
  ok((await (await fetch(base() + '/api/settings')).json()).autoPrepare === false, 'the setting reads back off')
  await post('/api/settings', { autoPrepare: true })

  console.log('\n[3] exactly an hour before')
  clock.now = START - LEAD_MS - 1
  r = await tick()
  ok(r.reason === 'no-game', '60 min + 1 ms before: not yet')
  clock.now = START - LEAD_MS
  r = await tick()
  ok(r.action === 'prepared' && r.gameId === 901, `60 min before: the 20:00 game (${r.gameId})`)
  st = await status()
  ok(st.prematch === true && String(st.prematchGameId) === '901', `/api/status: prematch, game ${st.prematchGameId}`)
  ok(st.state.team_a_name.toLowerCase() === 'ksc wiedikon h1' && st.state.team_a_short === 'KSCW H1' && st.state.team_b_short === 'ZÜRI H2', `home on the left, the short names (${st.state.team_a_name} ${st.state.team_a_short} v ${st.state.team_b_short})`)
  ok(st.state.points_a === 0 && st.state.points_b === 0, '0-0')
  ok(mock.currentLayout === 'kscw_clock' && st.ledbox.clockHeld === true, `the panel keeps the clock (${mock.currentLayout})`)
  const line = logged.find((e) => /auto-prepared game 901/.test(e.msg))
  ok(line && line.level === 'info' && line.data && line.data.gameId === 901, 'logged at info with the game id')

  console.log('\n[4] never twice, never after a dismissal')
  r = await tick()
  ok(r.action === 'skip', `the next tick: nothing (${r.reason})`)
  await post('/api/game', { choice: 'delete' })
  st = await status()
  ok(st.prematch === false, 'the scorer deleted it')
  clock.now = START - 10 * 60 * 1000
  r = await tick()
  ok(!(r.action === 'prepared' && r.gameId === 901), `901 is not put back (${r.action} ${r.reason} ${r.gameId ?? ''})`)
  // 902 (20:15, KWI B) is due now too, and nothing has claimed it: that one IS prepared.
  ok(r.action === 'prepared' && r.gameId === 902, 'the other hall\'s 20:15 game is the next candidate')
  await post('/api/game', { choice: 'delete' })

  console.log('\n[5] a match in progress is never interrupted')
  await app.close(); app = null
  const dirB = newDir()
  await start(dirB)
  clock.now = START - 20 * 60 * 1000
  await post('/api/manual')
  await post('/api/action', { action: { type: 'team', side: 'left', name: 'Friendly A', short: 'FRA' } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  await post('/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
  r = await tick()
  ok(r.action === 'skip' && r.reason === 'match-in-progress', `1-1 on the board: nothing (${r.reason})`)
  st = await status()
  ok(st.prematch === false && st.state.points_a === 1 && st.state.points_b === 1 && st.state.team_a_short === 'FRA', 'the match is exactly as it was')
  ok(mock.currentLayout === MATCH, 'still on the scoreboard')
  // A running countdown (a timeout, a warm-up the scorer started) is left alone too.
  await post('/api/game', { choice: 'delete' })
  await post('/api/countdown', { seconds: 30, label: 'WARM-UP' })
  r = await tick()
  ok(r.action === 'skip' && r.reason === 'countdown', `a countdown running: nothing (${r.reason})`)
  await post('/api/countdown/stop', { expired: false })
  r = await tick()
  ok(r.action === 'prepared' && r.gameId === 901, 'once it is over, the game is prepared')
  await post('/api/game', { choice: 'delete' })

  console.log('\n[6] the scorer tapped it first')
  await app.close(); app = null
  const dirC = newDir()
  await start(dirC)
  clock.now = START - 45 * 60 * 1000
  await post('/api/game', {
    choice: 'new', prematch: true,
    teams: { left: { name: 'KSC Wiedikon H1', short: 'KSCW H1' }, right: { name: 'VBC Züri Unterland H2', short: 'ZÜRI H2' } },
  })
  r = await tick()
  ok(r.action === 'skip' && r.reason === 'already', `the board is already in this game's pre-match (${r.reason})`)
  await post('/api/game', { choice: 'delete' })
  r = await tick()
  ok(!(r.action === 'prepared' && r.gameId === 901), 'and after the scorer dismissed it, it stays dismissed')
  // With the console's game id the tap files it at once, whatever the names say.
  await post('/api/game', {
    choice: 'new', prematch: true, gameId: 902,
    teams: { left: { name: 'Typed Over', short: 'TYPED' }, right: { name: 'By Hand', short: 'HAND' } },
  })
  st = await status()
  ok(String(st.prematchGameId) === '902', `the console's gameId is kept with the pre-match (${st.prematchGameId})`)
  await post('/api/game', { choice: 'delete' })
  clock.now = START
  r = await tick()
  ok(r.reason === 'no-game', `neither game is set up again (${r.reason})`)

  console.log('\n[7] SCHEDULE_HALLS, and a restart')
  await app.close(); app = null
  process.env.SCHEDULE_HALLS = 'KWI B'
  const dirD = newDir()
  await start(dirD)
  clock.now = START - 30 * 60 * 1000
  r = await tick()
  ok(r.action === 'prepared' && r.gameId === 902, `SCHEDULE_HALLS=KWI B: the 20:15 in KWI B, not the earlier KWI A game (${r.gameId})`)
  await post('/api/game', { choice: 'delete' })
  await app.close(); app = null
  const onDisk = JSON.parse(fs.readFileSync(path.join(dirD, 'data', 'autoprepare.json'), 'utf8'))
  ok(onDisk.date === T && onDisk.ids.includes('902'), `data/autoprepare.json keeps today's prepared ids (${onDisk.ids})`)
  await start(dirD)
  r = await tick()
  ok(r.action === 'skip' && (await status()).prematch === false, `after a restart the dismissed game stays dismissed (${r.reason})`)
  delete process.env.SCHEDULE_HALLS
  await app.close(); app = null

  console.log('\n[8] a match that has begun at 0-0 is a match')
  const dirE = newDir()
  await start(dirE)
  clock.now = START - 10 * 60 * 1000 // 901 (20:00, KWI A) and 902 (20:15, KWI B) both due
  r = await tick()
  ok(r.action === 'prepared' && r.gameId === 901, 'the 20:00 game is prepared')
  await post('/api/prematch', { action: 'start' })
  st = await status()
  ok(st.prematch === false && st.state.points_a === 0 && st.state.team_a_short === 'KSCW H1', '"Start match now": the match is on, still 0-0')
  r = await tick()
  ok(r.action === 'skip' && r.reason === 'match-in-progress', `the overlapping 20:15 is not set up over it (${r.action} ${r.reason} ${r.gameId ?? ''})`)
  st = await status()
  ok(st.state.team_a_short === 'KSCW H1' && mock.currentLayout === MATCH, 'the board keeps the 20:00 match on the scoreboard')
  // Names typed by hand and New pressed: a match at 0-0 too.
  await post('/api/game', { choice: 'delete' })
  await post('/api/game', { choice: 'new', teams: { left: { name: 'Typed Home', short: 'THOME' }, right: { name: 'Typed Away', short: 'TAWAY' } } })
  r = await tick()
  ok(r.action === 'skip' && r.reason === 'match-in-progress', `a typed match at 0-0 is not replaced (${r.action} ${r.reason})`)
  ok((await status()).state.team_a_short === 'THOME', 'the typed names stay')
  await app.close(); app = null

  console.log('\n[9] a saved match waiting for "Continue" after a restart')
  const dirF = newDir()
  await start(dirF)
  clock.now = START - 3 * 60 * 60 * 1000 // nothing due yet
  await post('/api/game', { choice: 'new', teams: { left: { name: 'Friendly A', short: 'FRA' }, right: { name: 'Friendly B', short: 'FRB' } } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  await app.close(); app = null // a clean restart: the slot waits, the live board comes up blank
  await start(dirF)
  clock.now = START - 30 * 60 * 1000
  r = await tick()
  ok(r.action === 'skip' && r.reason === 'saved-match', `the due game is not set up over the saved match (${r.action} ${r.reason})`)
  const slot = JSON.parse(fs.readFileSync(path.join(dirF, 'data', 'resume.json'), 'utf8')).games.volleyball
  ok(slot && slot.state.points_a === 1 && slot.state.team_a_short === 'FRA', 'data/resume.json still holds the 1-0 match')
  await app.close(); app = null

  console.log('\n[10] the pre-match keeps its game id across a restart')
  const dirG = newDir()
  await start(dirG)
  clock.now = START - 30 * 60 * 1000
  r = await tick()
  ok(r.action === 'prepared' && r.gameId === 901, 'prepared 901')
  await app.close(); app = null
  await start(dirG)
  st = await status()
  ok(st.prematch === true && String(st.prematchGameId) === '901', `restored pre-match: game ${st.prematchGameId}`)
} finally {
  unsubscribe()
  if (app) await app.close().catch(() => {})
  await mock.close()
  await new Promise((r) => { fake.closeAllConnections?.(); fake.close(r) })
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['DIRECTUS_URL', saved.url], ['SCHEDULE_HALLS', saved.halls]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}
await sleep(10)

console.log(`\n${fail ? '❌' : '✅'} auto-prepare: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
