// Today's home games from the club's Directus — GET /api/schedule.
//
// A volunteer starting a match on a phone should pick "20:00 KSCW H1 – KSCW H3" from a list, not
// type two team names. The list comes from the club's public Directus (no token), which the board
// can only reach when the hall gives it an uplink — so every failure has to be an answer the
// console can show as it is, never a 5xx and never a warning-level log line.
//
//   [1] toGames on the exact shape the real endpoint returned on 2026-09-23 (one KSCW-v-KSCW game,
//       listed once per team): home only, deduped, times HH:MM, short names, kscwIsHome
//   [2] the filters: status, sport family (simple → volleyball, beach → volleyball until a beach
//       value exists), SCHEDULE_HALLS
//   [3] short names
//   [4] Schedule against a local fake Directus: the query it sends, the 5-minute cache, ?refresh,
//       a 500, a hang (timeout), nothing listening — each a plain-language { ok:false }
//   [5] the route, end to end on a booted appliance with DIRECTUS_URL pointed at the fake
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Schedule, toGames, shortName, zurichDate, parseHalls } from '../src/schedule.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'
import { log } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// Verbatim from https://directus.kscw.ch/items/games for 2026-09-23 (read-only GET).
const REAL = [
  { id: 409, time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'KSC Wiedikon H3', type: 'away', status: 'scheduled', league: 'Männer 2. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } },
  { id: 408, time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'KSC Wiedikon H3', type: 'home', status: 'scheduled', league: 'Männer 2. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } },
]
const row = (over) => ({ id: 1, time: '18:00:00', home_team: 'KSC Wiedikon D2', away_team: 'VBC Züri Unterland D1', type: 'home', status: 'scheduled', league: 'Frauen 3. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI B' }, ...over })

console.log('[1] the real shape')
{
  const g = toGames(REAL, { sport: 'volleyball' })
  ok(g.length === 1, `one game, not the away-perspective duplicate (${g.length})`)
  const [x] = g
  ok(x.id === 408 && x.time === '20:00' && x.home === 'KSC Wiedikon H1' && x.away === 'KSC Wiedikon H3', `20:00 KSC Wiedikon H1 – KSC Wiedikon H3 (${x.time} ${x.home} – ${x.away})`)
  ok(x.homeShort === 'KSCW H1' && x.awayShort === 'KSCW H3', `short names KSCW H1 / KSCW H3 (${x.homeShort} / ${x.awayShort})`)
  ok(x.league === 'Männer 2. Liga' && x.hall === 'KWI A' && x.kscwIsHome === true, 'league, hall and kscwIsHome')
  ok(Object.keys(x).sort().join() === 'away,awayShort,hall,home,homeShort,id,kscwIsHome,league,time', 'exactly the contract\'s fields')
  // Two KSCW teams, both rows typed home (seen in older data): still one game.
  ok(toGames([REAL[1], { ...REAL[1], id: 999 }]).length === 1, 'the same time + home + away twice is one game')
}

console.log('\n[2] filters')
{
  const rows = [
    row({ id: 1, time: '19:30:00' }),
    row({ id: 2, status: 'cancelled' }),
    row({ id: 3, status: 'postponed' }),
    row({ id: 4, time: '17:00:00', kscw_team: { sport: 'basketball' }, home_team: 'KSC Wiedikon H1', away_team: 'BC Bären Kleinbasel 2', hall: { name: 'KWI C' } }),
    row({ id: 5, type: 'away' }),
    row({ id: 6, kscw_team: null }),
  ]
  const ids = (sport, halls = null) => toGames(rows, { sport, halls }).map((g) => g.id).join()
  ok(ids('volleyball') === '1', `volleyball: home, not cancelled/postponed, volleyball only (${ids('volleyball')})`)
  ok(ids('simple') === '1', 'the simple scoreboard gets the volleyball list')
  ok(ids('basketball') === '4', 'basketball gets basketball')
  ok(ids('beach') === '1', 'beach: no beach value in the data, so every volleyball game')
  const withBeach = [...rows, row({ id: 7, kscw_team: { sport: 'beachvolleyball' } })]
  ok(toGames(withBeach, { sport: 'beach' }).map((g) => g.id).join() === '7', 'beach: only the beach games once one exists')
  ok(toGames(rows, { sport: 'volleyball', halls: parseHalls('KWI A') }).length === 0, 'SCHEDULE_HALLS=KWI A drops a KWI B game')
  ok(toGames(rows, { sport: 'volleyball', halls: parseHalls(' kwi a , KWI B ') }).length === 1, 'hall names are trimmed and case-insensitive')
  ok(parseHalls('') === null && parseHalls(' , ') === null, 'unset or empty means every hall')
  const sorted = toGames([row({ id: 1, time: '20:00:00', away_team: 'X' }), row({ id: 2, time: '18:30:00', away_team: 'Y' })])
  ok(sorted.map((g) => g.time).join() === '18:30,20:00', 'sorted by time')
}

console.log('\n[3] short names')
for (const [full, want] of [
  ['KSC Wiedikon H1', 'KSCW H1'],
  ['KSC Wiedikon D3', 'KSCW D3'],
  ['KSC Wiedikon HU23', 'KSCW HU23'],
  ['VBC Züri Unterland H2', 'ZÜRI H2'],
  ['Volley Näfels D1', 'NÄFELS D1'],
  ['BC Bären Kleinbasel 2', 'BÄREN 2'],
  ['STV St. Gallen H1', 'GALLEN H1'],
  ['VC Kanti Schaffhausen', 'KANTI'],
  ['Volley Amriswil', 'AMRISWIL'],
  ['Volleyballclub Andwil-Arnegg D2', 'ANDWIL D2'],
  ['Basketball-Club Zürich Wildcats', 'ZÜRICH'],
  ['Volley 2', 'VOLLEY 2'],
  ['', ''],
]) {
  const got = shortName(full)
  ok(got === want && got.length <= 10, `${JSON.stringify(full)} → ${JSON.stringify(got)}${got === want ? '' : ` (wanted ${JSON.stringify(want)})`}`)
}

console.log('\n[4] Schedule against a fake Directus')
let mode = 'ok'
const seen = []
const fake = http.createServer((req, res) => {
  seen.push(req.url)
  if (mode === 'hang') return // never answers
  if (mode === '500') { res.writeHead(500); return res.end('{"errors":[]}') }
  if (mode === 'junk') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>') }
  res.writeHead(200, { 'content-type': 'application/json' })
  // The route reads the season copy (seasonSchedule.js), whose query asks for `date` as well.
  const season = /_gte/.test(decodeURIComponent(req.url))
  res.end(JSON.stringify({ data: season ? REAL.map((g) => ({ ...g, date: zurichDate() })) : REAL }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${fake.address().port}`
// What was logged, and at what level: offline is normal, so failures are `info`.
const logged = []
const unsubscribe = log.subscribe((e) => { if (e.scope === 'schedule') logged.push(e) })
try {
  const s = new Schedule({ env: { DIRECTUS_URL: fakeUrl + '/' }, minRefreshMs: 0 })
  const a = await s.today({ sport: 'volleyball' })
  ok(a.ok === true && a.games.length === 1 && a.date === zurichDate(), `ok with one game for ${a.date}`)
  const q = new URL(seen[0], fakeUrl)
  ok(q.pathname === '/items/games', 'asks /items/games (trailing slash on DIRECTUS_URL handled)')
  ok(q.searchParams.get('filter') === JSON.stringify({ date: { _eq: zurichDate() } }), `filters on today in Zurich (${q.searchParams.get('filter')})`)
  ok(q.searchParams.get('fields') === 'id,time,home_team,away_team,type,status,league,kscw_team.sport,hall.name' &&
    q.searchParams.get('sort') === 'time' && q.searchParams.get('limit') === '50', 'with the contract\'s fields, sort and limit')
  await s.today({ sport: 'volleyball' })
  ok(seen.length === 1, 'a second request inside 5 minutes is served from the cache')
  await s.today({ sport: 'volleyball', refresh: true })
  ok(seen.length === 2, 'refresh goes back to Directus')
  const floor = new Schedule({ env: { DIRECTUS_URL: fakeUrl } })
  await floor.today(); await floor.today({ refresh: true })
  ok(seen.length === 3, 'but not more than once per 5 s by default (an open GET must not become a request pump)')
  // Two consoles asking at once share one upstream request.
  const s2 = new Schedule({ env: { DIRECTUS_URL: fakeUrl } })
  await Promise.all([s2.today(), s2.today(), s2.today()])
  ok(seen.length === 4, 'concurrent requests share one fetch')

  mode = '500'
  const b = await s.today({ sport: 'volleyball', refresh: true })
  ok(b.ok === false && Array.isArray(b.games) && b.games.length === 0 && /HTTP 500/.test(b.error), `a 500 is { ok:false } ("${b.error}")`)
  mode = 'junk'
  const j = await s.today({ sport: 'volleyball', refresh: true })
  ok(j.ok === false && /unreadable/.test(j.error), `an HTML page is { ok:false } ("${j.error}")`)
  mode = 'hang'
  const t0 = Date.now()
  const h = await new Schedule({ env: { DIRECTUS_URL: fakeUrl }, timeoutMs: 300 }).today()
  ok(h.ok === false && /did not answer/.test(h.error) && Date.now() - t0 < 2000, `a hang times out ("${h.error}")`)
  const dead = await new Schedule({ env: { DIRECTUS_URL: 'http://127.0.0.1:1' } }).today()
  ok(dead.ok === false && /could not reach/.test(dead.error), `nothing listening ("${dead.error}")`)
  ok(!/HTTP|ECONN|fetch failed/i.test(dead.error), 'in words, not an errno')
  const fails = logged.filter((e) => /unavailable/.test(e.msg))
  ok(fails.length >= 4 && fails.every((e) => e.level === 'info'), `failures logged at info (${fails.map((e) => e.level).join(',')})`)
  ok(new Schedule({ env: {} }).base === 'https://directus.kscw.ch', 'DIRECTUS_URL unset → the club\'s own Directus')
} finally {
  unsubscribe()
}

console.log('\n[5] GET /api/schedule on a booted appliance')
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
const boot = (stateDir) => startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
})
const saved = { url: process.env.DIRECTUS_URL, halls: process.env.SCHEDULE_HALLS, token: process.env.LIVE_PUBLISH_TOKEN }
delete process.env.LIVE_PUBLISH_TOKEN // the schedule must not need it
const dirs = []
let app = null
try {
  mode = 'ok'
  process.env.DIRECTUS_URL = fakeUrl
  process.env.SCHEDULE_HALLS = 'KWI A'
  dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-schedule-')))
  app = await boot(dirs[0])
  const base = `http://127.0.0.1:${app.server.address().port}`
  let res = await fetch(base + '/api/schedule')
  let body = await res.json()
  ok(res.status === 200 && body.ok === true && body.sport === 'volleyball' && body.date === zurichDate(), `200 { ok, date ${body.date}, sport ${body.sport} }`)
  ok(body.games.length === 1 && body.games[0].homeShort === 'KSCW H1' && body.games[0].hall === 'KWI A', 'the KWI A game')
  await app.close(); app = null

  process.env.SCHEDULE_HALLS = 'KWI B'
  dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-schedule-')))
  app = await boot(dirs[1])
  body = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/schedule`)).json()
  ok(body.ok === true && body.games.length === 0, 'SCHEDULE_HALLS=KWI B: an empty list, still ok')
  await app.close(); app = null

  process.env.DIRECTUS_URL = 'http://127.0.0.1:1'
  dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-schedule-')))
  app = await boot(dirs[2])
  res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/schedule?refresh=1`)
  body = await res.json()
  ok(res.status === 200 && body.ok === false && body.games.length === 0 && typeof body.error === 'string' && body.error.length > 0,
    `offline board: 200 { ok:false, error, games:[] } ("${body.error}")`)
} finally {
  if (app) await app.close().catch(() => {})
  await mock.close()
  await new Promise((r) => { fake.closeAllConnections?.(); fake.close(r) })
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  for (const [k, v] of [['DIRECTUS_URL', saved.url], ['SCHEDULE_HALLS', saved.halls], ['LIVE_PUBLISH_TOKEN', saved.token]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}
await sleep(10)

console.log(`\n${fail ? '❌' : '✅'} schedule: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
