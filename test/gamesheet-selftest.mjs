// The match sheet on the console — gameSheet.js, and POST /api/gamesheet.
//
// The roster holds birthdates (minors included), so what is asserted here is mostly what the board
// must NOT do: show it without the scorer PIN, count a locked tablet's polling as PIN guesses, keep
// it on the card for a game that is no longer on the board, or keep fields it does not show.
//
//   [1] the schedule copy keeps match number, round and referees (the Game info card)
//   [2] toSheet keeps only what the card shows; struck-off players go
//   [3] GameSheet against a fake wiedisync: the bearer token, the copy (0600), refusals in words,
//       nothing before the window, the copy deleted for another game / after the window / with
//       live scoring off — and NOT deleted on a clock that cannot be believed
//   [4] the route on a booted appliance: info without the PIN, roster only with it, a locked tablet
//       never counted as a guess, no PIN on the board = no roster, live scoring off = no roster
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { GameSheet, toSheet } from '../src/gameSheet.js'
import { toSeasonGames } from '../src/seasonSchedule.js'
import { zurichDate, zurichEpoch } from '../src/schedule.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const H = 60 * 60 * 1000

// What GET /kscw/scorer/game/:id/roster answers (scorer-roster.js), trimmed to one of each.
const SHEET = {
  game: { id: 9, home_team: 'KSC Wiedikon H1', away_team: 'VBC Züri Unterland H2', date: '2026-10-10', time: '20:00' },
  access: 'board', can_edit: false, source: 'vm', edited: false, closed_at: '2026-10-10T17:10:00Z',
  roster: [
    { member: 11, number: 7, last_name: 'Muster', first_initial: 'A.', birthdate: '2009-04-01', is_captain: true, is_libero: false, licence: 'A', eligible: true, added: false, dropped: false, rsvp: 'confirmed' },
    { member: 12, number: null, last_name: 'Beispiel', first_initial: 'B.', birthdate: '2001-12-31', is_captain: false, is_libero: true, licence: null, dropped: false, rsvp: 'none' },
    { member: 13, number: 3, last_name: 'Weg', first_initial: 'W.', birthdate: '2000-01-01', dropped: true },
  ],
  coaches: [{ ref: 'm:20', member: 20, last_name: 'Coach', first_initial: 'C.', birthdate: '1980-05-05', role: 'coach' }],
  bench: [],
}

console.log('[1] the schedule copy carries the Game info')
{
  const [g] = toSeasonGames([{ id: 9, game_id: 'vb_406300', date: '2026-10-10', time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'VBC Züri Unterland H2', status: 'scheduled', league: 'Männer 2. Liga', round: 'Runde 3', referees_json: [{ name: 'Anna Ref', id: 4 }, { name: 'Ben Linie' }], kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } }])
  ok(g.number === '406300', `match number without the source prefix (${g.number})`)
  ok(g.round === 'Runde 3' && g.referees.join('|') === 'Anna Ref|Ben Linie', 'round and the referees\' names')
  const [n] = toSeasonGames([{ id: 1, date: '2026-10-10', time: '20:00', home_team: 'KSC Wiedikon H1', away_team: 'X' }])
  ok(n.number === '' && n.round === '' && n.referees.length === 0, 'a row without them: empty, not undefined')
}

console.log('\n[2] toSheet')
{
  const s = toSheet(SHEET)
  ok(s.players.length === 2 && !s.players.some((p) => p.lastName === 'Weg'), 'a struck-off player is not on the card')
  ok(s.players[0].number === 7 && s.players[0].captain === true && s.players[0].birthdate === '2009-04-01' && s.players[1].number === null && s.players[1].libero === true, 'number, C, L, birthdate')
  ok(!JSON.stringify(s).includes('member') && !JSON.stringify(s).includes('rsvp'), 'no member ids, no RSVP answers')
  ok(s.officials.length === 1 && s.officials[0].role === 'coach' && s.source === 'vm', 'officials and the source')
}

// A fake wiedisync whose answer the test switches.
let mode = 'ok'
const seen = []
const fake = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization })
  if (req.url.startsWith('/items/games')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: fakeGames }))
  }
  if (mode === 'window') { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"x","code":"outside_window"}') }
  if (mode === '500') { res.writeHead(500); return res.end('') }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: SHEET }))
})
let fakeGames = []
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${fake.address().port}`

console.log('\n[3] GameSheet')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-sheet-'))
  const file = path.join(tmp, 'gamesheet.json')
  const KICK = zurichEpoch('2026-10-10', '20:00')
  let now = KICK - H
  let trusted = true
  let live = true
  let game = { id: 9, date: '2026-10-10', time: '20:00', kscwIsHome: true }
  const gs = new GameSheet({
    file, env: { DIRECTUS_URL: fakeUrl, LIVE_PUBLISH_TOKEN: 'tok' },
    now: () => now, trusted: () => trusted, enabled: () => live, currentGame: () => game, minRefreshMs: 0,
  })
  seen.length = 0
  let v = await gs.view()
  ok(v.ok === true && v.players.length === 2, 'an hour before kickoff: fetched and shown')
  ok(seen.length === 1 && seen[0].url === '/kscw/scorer/game/9/roster' && seen[0].auth === 'Bearer tok', 'GET /kscw/scorer/game/9/roster with the board token')
  ok(fs.existsSync(file) && (fs.statSync(file).mode & 0o777) === 0o600, 'the copy is on the card, readable by the board user only')

  mode = '500'
  v = await gs.view({ refresh: true })
  ok(v.ok === true && v.players.length === 2 && /HTTP 500/.test(v.warning || ''), 'wiedisync failing: the copy stays the answer, with a warning')
  mode = 'ok'

  trusted = false; now = KICK + 10 * H
  gs.refresh(); await sleep(20)
  ok(gs.copy !== null && fs.existsSync(file), 'on a clock that cannot be believed the copy is NOT deleted after "the window"')
  trusted = true
  v = await gs.view()
  ok(gs.copy === null && !fs.existsSync(file) && v.ok === false, 'past the window on a believed clock: deleted from memory and card')

  now = KICK - 8 * H; seen.length = 0
  v = await gs.view({ refresh: true })
  ok(seen.length === 0 && v.ok === false && /6 hours before/.test(v.error), 'before the window nothing is asked, and it says when')

  now = KICK - H; mode = 'window'
  v = await gs.view({ refresh: true })
  ok(v.ok === false && /6 hours before kickoff/.test(v.error), `wiedisync refusing on its own clock: in words (${JSON.stringify(v)})`)
  mode = 'ok'

  await gs.view({ refresh: true })
  game = { id: 10, date: '2026-10-10', time: '20:00', kscwIsHome: true }
  gs._reconcile()
  ok(gs.copy === null && !fs.existsSync(file), 'another game on the board: the old sheet is deleted')
  await gs.view({ refresh: true })
  live = false
  v = await gs.view()
  ok(gs.copy === null && !fs.existsSync(file) && v.ok === false, 'live scoring turned off: deleted')
  live = true
  game = { ...game, kscwIsHome: false }
  seen.length = 0
  v = await gs.view({ refresh: true })
  ok(seen.length === 0 && v.ok === false, 'an away game (KSCW not home): never asked')

  const reload = new GameSheet({ file, env: {}, currentGame: () => null })
  ok(reload.configured === false && reload.copy === null, 'no token: not configured')
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n[4] POST /api/gamesheet on a booted appliance')
{
  const PIN = '4242'
  const T = zurichDate()
  // Kickoff right now in Zurich, so the window is open whatever time the test runs.
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
  fakeGames = [{ id: 9, game_id: 'vb_406300', date: T, time: hm + ':00', type: 'home', home_team: 'KSC Wiedikon H1', away_team: 'VBC Züri Unterland H2', status: 'scheduled', league: 'Männer 2. Liga', round: 'Runde 3', referees_json: [{ name: 'Anna Ref' }], kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } }]
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-sheet-app-'))
  const writeSettings = (s) => fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ sport: 'volleyball', autoPrepare: false, ...s }))
  const boot = () => startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
    ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
    reconnectMs: 0, mock: false, controlPort: 0, debug: false,
    uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
  })
  const saved = { url: process.env.DIRECTUS_URL, tok: process.env.LIVE_PUBLISH_TOKEN }
  let app = null
  try {
    process.env.DIRECTUS_URL = fakeUrl
    process.env.LIVE_PUBLISH_TOKEN = 'tok'
    writeSettings({ scorerPin: PIN, liveScoring: 'kscw' })
    app = await boot()
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = async (route, body, pin) => {
      const headers = { 'content-type': 'application/json', origin: base }
      if (pin !== undefined) headers['X-Scorer-Pin'] = pin
      const r = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body || {}) })
      return { status: r.status, body: await r.json() }
    }
    await (await fetch(base + '/api/schedule?range=season')).json() // the copy, before the tap

    let r = await post('/api/gamesheet', {}, PIN)
    ok(r.status === 200 && r.body.ok === false && /schedule first/.test(r.body.error), 'no schedule game on the board: says to start one')

    r = await post('/api/game', { choice: 'new', teams: { left: { name: 'KSC Wiedikon H1', short: 'KSCW H1' }, right: { name: 'VBC Züri Unterland H2', short: 'ZU H2' } }, prematch: true, gameId: 9 }, PIN)
    ok(r.status === 200, 'a game started from the schedule')
    const st = await (await fetch(base + '/api/status')).json()
    ok(st.gameId === 9, `GET /api/status names the game (${st.gameId})`)

    // A locked tablet polling the card, more times than the lock-out allows.
    let locked = 0
    for (let i = 0; i < 8; i++) {
      r = await post('/api/gamesheet', {})
      if (r.status === 200 && r.body.roster && r.body.roster.locked === true && !r.body.roster.players) locked++
    }
    ok(locked === 8, 'no PIN: 200, the roster withheld, every time')
    ok(r.body.info && r.body.info.number === '406300' && r.body.info.referees[0] === 'Anna Ref' && r.body.info.round === 'Runde 3', 'but Game info is there (number, round, referee)')
    r = await post('/api/gamesheet', {}, PIN)
    ok(r.body.roster && r.body.roster.ok === true && r.body.roster.players.length === 2 && r.body.roster.players[0].birthdate === '2009-04-01', 'with the PIN: the roster — and the polling above never locked the tablet out')
    ok(fs.existsSync(path.join(stateDir, 'data', 'gamesheet.json')), 'the copy is in data/gamesheet.json')

    r = await post('/api/gamesheet', {}, '0000')
    ok(r.status === 200 && r.body.roster.locked === true && !r.body.roster.players, 'a wrong PIN: withheld')
    await app.close(); app = null

    // The same game after a reboot with live scoring off: no roster, and the copy goes.
    writeSettings({ scorerPin: PIN, liveScoring: 'off' })
    app = await boot()
    const b2 = `http://127.0.0.1:${app.server.address().port}`
    const r2 = await (await fetch(b2 + '/api/gamesheet', { method: 'POST', headers: { 'content-type': 'application/json', origin: b2, 'X-Scorer-Pin': PIN }, body: '{}' })).json()
    ok(r2.ok === false || (r2.roster && r2.roster.ok === false && !r2.roster.players), 'live scoring off: no roster')
    await app.close(); app = null

    writeSettings({ liveScoring: 'kscw' })
    app = await boot()
    const b3 = `http://127.0.0.1:${app.server.address().port}`
    const r3 = await (await fetch(b3 + '/api/gamesheet', { method: 'POST', headers: { 'content-type': 'application/json', origin: b3 }, body: '{}' })).json()
    ok(!(r3.roster && r3.roster.players), 'a board with no PIN set never shows the roster')
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await mock.close()
    for (const [k, v] of [['DIRECTUS_URL', saved.url], ['LIVE_PUBLISH_TOKEN', saved.tok]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

await new Promise((r) => { fake.closeAllConnections?.(); fake.close(r) })
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
