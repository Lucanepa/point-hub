// Live end-to-end test against the CURRENT OpenVolley relay — manual, not part of `npm test`,
// because it needs an OpenVolley checkout with its backend dependencies installed.
//
//   OpenVolley backend/server.js --local      the standalone relay (HTTP and WS on one port)
//     <- a scorer socket, sending what App.jsx / Scoreboard.jsx send today: sync-match-data with
//        the seed key and game PIN, then live-state-update under the seed key
//     -> the REAL point-hub appliance in Link mode: Settings ▸ Scorer laptop address, GET
//        /api/matches, POST /api/link — the path an operator takes on the tablet
//     -> a MockLedbox speaking the real C0270 protocol (API version 2, volleyball_matchscore_02)
//
// Every step is ASSERTED against the panel, and any failure exits 1. The old version of this file
// printed "END-TO-END OK" unconditionally — it kept doing so after the repo split broke its path
// and after the LedBox started refusing its handshake, while the panel stayed blank.
//
// Run:  npm run test:e2e
//       OPENVOLLEY_DIR=/path/to/openvolley/escoresheet npm run test:e2e
// Default OPENVOLLEY_DIR: ../openvolley/escoresheet next to this repo.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { RelaySubscriber } from '../src/relaySubscriber.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OV = path.resolve(process.env.OPENVOLLEY_DIR || path.join(REPO, '..', 'openvolley', 'escoresheet'))
const BACKEND = path.join(OV, 'backend')

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log(`  ✅ ${l}`) } else { fail++; console.log(`  ❌ ${l}`) } }

if (!fs.existsSync(path.join(BACKEND, 'server.js')) || !fs.existsSync(path.join(BACKEND, 'node_modules'))) {
  console.error(`✗ OpenVolley backend not found (or not installed) at ${BACKEND}`)
  console.error('  Set OPENVOLLEY_DIR to an openvolley/escoresheet checkout and run npm install in its backend/.')
  process.exit(1)
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

// --- the relay ------------------------------------------------------------------------------
const PORT = await freePort()
const env = { ...process.env, PORT: String(PORT) }
delete env.DATABASE_URL // --local: no database, the LAN relay only
const relayProc = spawn(process.execPath, ['server.js', '--local'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
let relayLog = ''
relayProc.stdout.on('data', (d) => { relayLog += d })
relayProc.stderr.on('data', (d) => { relayLog += d })
const HTTP = `http://127.0.0.1:${PORT}`, WS = `ws://127.0.0.1:${PORT}`

let mock, app, sc, stateDir
const cleanup = async () => {
  try { sc?.ws.close() } catch {}
  try { await app?.close() } catch {}
  try { await mock?.close() } catch {}
  relayProc.kill('SIGTERM')
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true })
}

try {
  let up = false
  for (let i = 0; i < 150 && !up; i++) {
    try { up = (await fetch(`${HTTP}/api/server/status`)).ok } catch { /* not yet */ }
    if (!up) await sleep(100)
  }
  if (!up) throw new Error(`the relay did not come up on ${HTTP}\n${relayLog.slice(-2000)}`)
  console.log(`▶ OpenVolley relay (backend --local) on ${HTTP}`)

  // --- the board and the appliance ------------------------------------------------------------
  mock = new MockLedbox()
  const lb = await mock.listen(0, '127.0.0.1')
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-e2e-'))
  app = await startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
    // :5173 is the desktop relay's HTTP port; this machine may run something else there.
    relayDesktopPort: await freePort(),
    ledboxHost: '127.0.0.1', ledboxPort: lb.port, ledboxLayout: 'volleyball_matchscore_02',
    ledboxAlias: 'e2e', ledboxApiVersion: 2, reconnectMs: 500, mock: false, controlPort: 0, debug: false,
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const get = async (p) => (await fetch(base + p)).json()
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) } }
  const t = (n) => mock.text(n)
  const panel = () => `${t('team1')} ${t('score1')}:${t('score2')} ${t('team2')} | sets ${t('set1')}-${t('set2')} | T ${t('timeout1')}/${t('timeout2')} S ${t('sub1')}/${t('sub2')} | ${mock.currentLayout}`
  await sleep(400)

  console.log('\n[1] the LedBox handshake (API version 2) succeeds')
  {
    const st = await get('/api/status')
    ok(st.ledbox.connected === true, `board connected (layout ${st.ledbox.layout})`)
  }

  console.log('\n[2] Settings ▸ Scorer laptop address')
  {
    const r = await post('/api/settings', { relayAddress: `127.0.0.1:${PORT}` })
    ok(r.status === 200 && r.json.relayAddress === `127.0.0.1:${PORT}`, `saved (${r.json?.relayAddress})`)
  }

  // --- the scorer, as the OpenVolley app talks to the relay today -------------------------------
  const SEED = `match_${Date.now()}_e2e${Math.random().toString(36).slice(2, 6)}`
  sc = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    const inbox = []
    ws.addEventListener('message', (e) => { try { inbox.push(JSON.parse(e.data)) } catch {} })
    ws.addEventListener('open', () => resolve({ ws, inbox, send: (o) => ws.send(JSON.stringify(o)) }))
    ws.addEventListener('error', () => reject(new Error('scorer socket failed')))
  })
  const sync = () => sc.send({
    type: 'sync-match-data', matchId: SEED,
    match: {
      id: 1, seed_key: SEED, gameN: 4711, status: 'live', scheduledAt: new Date().toISOString(),
      homeShortName: 'KSC', awayShortName: 'VBC', gamePin: '123456', refereePin: '111111',
      homeTeamPin: '222222', awayTeamPin: '333333',
      // Today's relays list a match only with the referee connection on. A later OpenVolley may list
      // every match; this test works either way.
      refereeConnectionEnabled: true,
    },
    homeTeam: { name: 'KSC Wiedikon', shortName: 'KSC' }, awayTeam: { name: 'VBC Züri', shortName: 'VBC' },
    homePlayers: [], awayPlayers: [], sets: [{ index: 1, homePoints: 0, awayPoints: 0 }], events: [], _timestamp: Date.now(),
  })
  let seq = 0
  const live = (o) => ({
    match_id: null, current_set: 1, team_a_name: 'KSC Wiedikon', team_a_short: 'KSC', team_a_color: '#2563eb',
    team_b_name: 'VBC Züri', team_b_short: 'VBC', team_b_color: '#ef4444', best_of: 5,
    sets_won_a: 0, sets_won_b: 0, points_a: 0, points_b: 0, side_a: 'left', lineup_a: null, lineup_b: null,
    timeouts_a: [], timeouts_b: [], subs_a: null, subs_b: null, sanctions_a: null, sanctions_b: null,
    serving_team: 'left', last_event_type: 'point', last_event_team: 'home', last_event_data: null,
    last_event_ts: new Date().toISOString(), timeout_active: false, timeout_started_at: null,
    set_interval_active: false, set_interval_started_at: null, match_status: 'in_progress',
    game_n: 4711, updated_at: new Date().toISOString(), sport_type: 'indoor', _seq: ++seq, _session: 'e2e', ...o,
  })
  const push = (o) => sc.send({ type: 'live-state-update', matchId: SEED, liveState: live(o) })

  console.log('\n[3] the scorer opens the match; the Link tab lists it from the relay\'s own port')
  sync(); await sleep(300)
  ok(!sc.inbox.some((m) => m.type === 'error'), `the relay accepted the scorer (${JSON.stringify(sc.inbox.filter((m) => m.type === 'error'))})`)
  const list = await get('/api/matches')
  const row = list.matches.find((m) => m.id === SEED)
  ok(!!row, `listed under the seed key (${list.matches.length} listed; errors ${JSON.stringify(list.errors)})`)
  ok(list.relay && list.relay.ok && list.relay.source === 'settings', `relay ${JSON.stringify(list.relay)}`)

  console.log('\n[4] linked, with a score already on the relay')
  push({ points_a: 3, points_b: 1 }); await sleep(200)
  const link = await post('/api/link', { source: 'lan', matchId: row ? row.id : SEED })
  ok(link.status === 200 && link.json?.mode === 'lan', `link -> ${link.status} ${link.json?.mode}`)
  await sleep(700)
  console.log(`   panel: ${panel()}`)
  // The assertion the old harness never made: the panel is NOT blank.
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'match layout on the panel')
  ok(t('team1') === 'KSC' && t('team2') === 'VBC', 'team names painted')
  ok(t('score1') === '3' && t('score2') === '1', `3:1 painted (${t('score1')}:${t('score2')})`)

  console.log('\n[5] the live stream')
  push({ points_a: 5, points_b: 3 }); await sleep(300)
  ok(t('score1') === '5' && t('score2') === '3', `5:3 (${t('score1')}:${t('score2')})`)
  ok(mock.screen.serve1?.color && mock.screen.serve1.color !== '30,30,30', 'serve on the left')
  push({ points_a: 5, points_b: 4, serving_team: 'right', timeouts_a: [{ team: 'home' }] }); await sleep(300)
  ok(t('timeout1') === '1', `timeout A 1 (${t('timeout1')})`)
  ok(mock.screen.serve2?.color && mock.screen.serve2.color !== '30,30,30', 'serve moved right')
  push({ points_a: 5, points_b: 6, serving_team: 'right', timeouts_a: [{}], subs_b: [{ in: 7, out: 9 }, { in: 3, out: 4 }] }); await sleep(300)
  ok(t('sub2') === '2', `subs B 2 (${t('sub2')})`)
  sync(); await sleep(300)
  ok(t('score2') === '6', 'a scorer sync after the push does not blank the board')
  push({ current_set: 2, sets_won_a: 1, points_a: 0, points_b: 0, side_a: 'right', serving_team: 'left', timeouts_a: [], subs_b: null }); await sleep(300)
  console.log(`   panel: ${panel()}`)
  ok(t('team1') === 'VBC' && t('team2') === 'KSC' && t('set2') === '1' && t('set1') === '0', 'set end: sides swap, sets 0-1')

  console.log('\n[6] MATCH_ID for the headless bridge is the seed key')
  {
    const sub = new RelaySubscriber({ url: WS, matchId: SEED, reconnectMs: 0 })
    let got = 0
    sub.on('state', () => got++); sub.on('error', () => {})
    sub.start(); await sleep(300)
    push({ current_set: 2, sets_won_a: 1, points_a: 1, side_a: 'right' }); await sleep(300)
    sub.stop()
    ok(got >= 1, `a subscriber on the seed key gets live state (${got} frames)`)
  }

  console.log('\n[7] the scorer ends the match -> the result screen')
  push({ current_set: 4, sets_won_a: 3, sets_won_b: 1, points_a: 25, points_b: 21, side_a: 'right', match_status: 'ended', last_event_type: 'match_end' }); await sleep(500)
  console.log(`   panel: ${t('winner')} | ${t('sets')} | ${mock.currentLayout}`)
  ok(mock.currentLayout === 'kscw_result' && /KSC WINS/.test(t('winner') || ''), 'result screen with the winner')

  console.log('\n[8] the scorer undoes the end -> the live score again')
  push({ current_set: 4, sets_won_a: 2, sets_won_b: 1, points_a: 24, points_b: 21, side_a: 'right', match_status: 'in_progress' }); await sleep(500)
  ok(mock.currentLayout === 'volleyball_matchscore_02' && t('score2') === '24', `back to the score (${panel()})`)

  console.log('\n[9] the scorer deletes the match -> the board unlinks and leaves the score')
  sc.send({ type: 'delete-match', matchId: SEED }); await sleep(500)
  const st = await get('/api/status')
  ok(st.mode === 'idle', `mode ${st.mode}`)
  ok(st.ledbox.idle === true && t('score2') !== '24', `the 21:24 is off the panel (${panel()})`)
} catch (err) {
  fail++
  console.log(`  ❌ ${err.stack || err.message}`)
} finally {
  await cleanup()
}

console.log(`\n${fail === 0 ? '✅ END-TO-END PASS' : '❌ END-TO-END FAIL'} — ${pass} passed, ${fail} failed`)
if (fail && process.env.SHOW_RELAY_LOG) console.log(relayLog.slice(-4000))
process.exit(fail === 0 ? 0 : 1)
