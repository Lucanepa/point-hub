// The season schedule on the board's card — seasonSchedule.js, and GET /api/schedule served from it.
//
// A hall with no uplink is where a volunteer most needs the list, so the board downloads every
// remaining home game whenever it DOES have internet and answers from data/schedule.json after
// that. The clock is not to be believed until NTP or the console has set it (clockSync.js).
//
//   [1] toSeasonGames on the shape the real endpoint returned on 2026-09-23 (?filter date>=today,
//       type=home): every sport kept, KSCW-v-KSCW once, cancelled/postponed kept but flagged
//   [2] the fetch against a fake Directus: the query, the file (write-then-rename), fetchedAt only
//       on a trusted clock, the two-day margin and no pruning on an untrusted one
//   [3] the view: today first, the rest grouped by date, sport family, SCHEDULE_HALLS, cancelled
//       flagged, today's legacy shape unchanged
//   [4] staleness on the monotonic clock; a fetch before the clock synced gets its real time later
//   [5] offline: a copy on disk is served ok:true stale:true; no copy is ok:false in words; the
//       retry backoff; the clock syncing (= an uplink) refreshes at once
//   [6] loading a copy drops past games — only on a trusted clock
//   [7] the routes end to end on a booted appliance, including a reboot with no uplink
//   [8] an unchanged season is not rewritten (SD wear); [9] an untrusted download's time reaches
//       disk when the clock syncs; [10] a copy is served at once while a fetch hangs
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { SeasonSchedule, toSeasonGames, STALE_MS } from '../src/seasonSchedule.js'
import { zurichDate, addDays } from '../src/schedule.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'
import { log } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// Verbatim from https://directus.kscw.ch/items/games?filter={date:{_gte:'2026-09-23'},type:{_eq:'home'}}
// &sort=date,time&limit=-1 (read-only GET, 2026-09-23): 133 rows, season 2026/27, volleyball and
// basketball, halls KWI A/B/C and Döltschi 2. The first and the last row as they came back.
const REAL = [
  { id: 408, date: '2026-09-23', time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'KSC Wiedikon H3', status: 'scheduled', league: 'Männer 2. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } },
  { id: 701, date: '2027-05-04', time: '20:00:00', home_team: 'KSC Wiedikon Lions D1', away_team: 'BC Arlesheim 1LR', status: 'scheduled', league: '1LRAF', kscw_team: { sport: 'basketball' }, hall: { name: 'KWI A' } },
]

// A fixed evening for everything below except [7]: 2026-10-10, 17:00 in Zurich.
const D = '2026-10-10'
const NOW = Date.parse('2026-10-10T15:00:00Z')
const row = (over) => ({ id: 1, date: D, time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'VBC Züri Unterland H2', status: 'scheduled', league: 'Männer 2. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' }, ...over })
const ROWS = [
  row({ id: 1, date: addDays(D, -1), time: '19:00:00' }), // yesterday: a fake Directus ignores the filter
  row({ id: 2 }),
  row({ id: 3, time: '18:30:00', home_team: 'KSC Wiedikon D2', away_team: 'Volley Näfels D1', hall: { name: 'KWI B' } }),
  row({ id: 4, time: '17:00:00', home_team: 'KSC Wiedikon Lions D1', away_team: 'BC Arlesheim 1LR', kscw_team: { sport: 'basketball' }, hall: { name: 'KWI C' } }),
  row({ id: 5, date: addDays(D, 1), status: 'cancelled' }),
  row({ id: 6, date: addDays(D, 1), time: '18:00:00', status: 'postponed', hall: { name: 'KWI B' } }),
  row({ id: 7, date: addDays(D, 30), time: '19:30:00' }),
  row({ id: 8, date: addDays(D, 30), time: '19:30:00' }), // the same match again (KSCW v KSCW style duplicate)
]

console.log('[1] the real shape')
{
  const g = toSeasonGames(REAL)
  ok(g.length === 2 && g[0].id === 408 && g[1].id === 701, 'both rows kept, basketball included (the sport is filtered per request)')
  const [x] = g
  ok(x.date === '2026-09-23' && x.time === '20:00' && x.homeShort === 'KSCW H1' && x.awayShort === 'KSCW H3' && x.hall === 'KWI A' && x.sport === 'volleyball',
    `2026-09-23 20:00 KSCW H1 – KSCW H3, KWI A (${x.date} ${x.time} ${x.homeShort} – ${x.awayShort})`)
  ok(x.status === 'scheduled' && x.cancelled === false && x.kscwIsHome === true, 'status, cancelled:false, kscwIsHome')
  const flagged = toSeasonGames(ROWS)
  ok(flagged.find((y) => y.id === 5).cancelled === true && flagged.find((y) => y.id === 6).cancelled === true, 'cancelled and postponed are kept, flagged')
  ok(!flagged.some((y) => y.id === 8), 'the duplicate row is one game')
  ok(toSeasonGames([row({ date: null }), row({ type: 'away' }), null, 'x']).length === 0, 'no date, an away row or junk: dropped')
  ok(flagged.map((y) => y.id).join() === '1,4,3,2,6,5,7', `sorted by date then time (${flagged.map((y) => y.id).join()})`)
}

// A fake Directus whose answer the test switches.
let mode = 'ok'
let rows = ROWS
const seen = []
const fake = http.createServer((req, res) => {
  seen.push(req.url)
  if (mode === 'hang') return
  if (mode === '500') { res.writeHead(500); return res.end('{"errors":[]}') }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: rows }))
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakeUrl = `http://127.0.0.1:${fake.address().port}`
const dead = 'http://127.0.0.1:1'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-season-'))
const logged = []
const unsubscribe = log.subscribe((e) => { if (e.scope === 'schedule') logged.push(e) })

// A SeasonSchedule on fake clocks. `clock.trusted` and `clock.mono` are changed by the tests.
const clock = { now: NOW, mono: 1000, trusted: true }
const make = (file, over = {}) => new SeasonSchedule({
  file, env: { DIRECTUS_URL: fakeUrl }, now: () => clock.now, mono: () => clock.mono, trusted: () => clock.trusted,
  minRefreshMs: 0, ...over,
})
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

try {
  console.log('\n[2] the fetch')
  {
    const file = path.join(tmp, 'a', 'schedule.json')
    const s = make(file)
    ok(s.games === null, 'no copy before the first fetch')
    const r = await s.refresh()
    ok(r.ok === true, 'fetched')
    const q = new URL(seen.at(-1), fakeUrl)
    ok(q.pathname === '/items/games', '/items/games')
    ok(q.searchParams.get('filter') === JSON.stringify({ date: { _gte: D }, type: { _eq: 'home' } }), `home games from today (${q.searchParams.get('filter')})`)
    ok(q.searchParams.get('sort') === 'date,time' && q.searchParams.get('limit') === '-1', 'sorted by date,time, no limit')
    ok(q.searchParams.get('fields') === 'id,date,time,home_team,away_team,status,league,kscw_team.sport,hall.name', 'the contract\'s fields')
    const disk = read(file)
    ok(disk.fetchedAt === new Date(NOW).toISOString() && disk.clockSynced === true, `on disk with fetchedAt ${disk.fetchedAt}`)
    ok(!disk.games.some((g) => g.id === 1) && disk.games.length === 6, `yesterday's game pruned on a trusted clock (${disk.games.length} kept)`)
    ok(!fs.existsSync(`${file}.tmp`), 'written then renamed (no .tmp left behind)')

    clock.trusted = false
    const u = make(path.join(tmp, 'b', 'schedule.json'))
    await u.refresh()
    const uq = new URL(seen.at(-1), fakeUrl)
    ok(JSON.parse(uq.searchParams.get('filter')).date._gte === addDays(D, -2), `an untrusted clock asks from two days earlier (${JSON.parse(uq.searchParams.get('filter')).date._gte})`)
    const ud = read(path.join(tmp, 'b', 'schedule.json'))
    ok(ud.fetchedAt === null && ud.clockSynced === false && /before the board clock was synced/.test(ud.note), 'fetchedAt null, with the reason written down')
    ok(ud.games.some((g) => g.id === 1), 'and nothing pruned on a clock that may be wrong')

    console.log('\n[4] staleness and a late fetchedAt')
    const v1 = await u.season({ sport: 'volleyball' })
    ok(v1.ok === true && v1.fetchedAt === null && v1.stale === false && v1.clockSynced === false, 'fresh this boot, time unknown')
    clock.mono += 90 * 60 * 1000
    clock.trusted = true
    const v2 = await u.season({ sport: 'volleyball' })
    ok(v2.fetchedAt === new Date(NOW - 90 * 60 * 1000).toISOString(), `the clock synced: the fetch gets its real time from the monotonic age (${v2.fetchedAt})`)
    clock.mono += STALE_MS
    const v3 = await u.season({ sport: 'volleyball' })
    ok(v3.ok === true && v3.stale === true, 'stale after 12 h')
    clock.mono = 1000
  }

  console.log('\n[3] the view')
  {
    const s = make(path.join(tmp, 'c', 'schedule.json'))
    await s.refresh()
    const v = await s.season({ sport: 'volleyball' })
    ok(v.ok && v.date === D && v.fetchedAt === new Date(NOW).toISOString() && v.stale === false, 'ok, fetchedAt, not stale')
    ok(v.today.map((g) => g.id).join() === '3,2', `today: the volleyball games by time (${v.today.map((g) => g.id).join()})`)
    ok(v.upcoming.map((d) => d.date).join() === [addDays(D, 1), addDays(D, 30)].join(), 'upcoming grouped by date, in order')
    const tomorrow = v.upcoming[0].games
    ok(tomorrow.length === 2 && tomorrow.every((g) => g.cancelled === true) && tomorrow.map((g) => g.status).sort().join() === 'cancelled,postponed', 'cancelled and postponed come through, flagged')
    ok(Object.keys(v.today[0]).sort().join() === 'away,awayShort,cancelled,date,hall,home,homeShort,id,kscwIsHome,league,status,time', 'each game: today\'s fields + date, status, cancelled')
    const b = await s.season({ sport: 'basketball' })
    ok(b.today.map((g) => g.id).join() === '4' && b.upcoming.length === 0, 'basketball gets the basketball game')
    ok((await s.season({ sport: 'simple' })).today.length === 2, 'the simple scoreboard gets the volleyball list')
    const t = await s.today({ sport: 'volleyball' })
    ok(t.ok && t.date === D && t.games.map((g) => g.id).join() === '3,2', 'today(): the same two games')
    ok(Object.keys(t.games[0]).sort().join() === 'away,awayShort,hall,home,homeShort,id,kscwIsHome,league,time', 'in exactly the shape GET /api/schedule always had')
    const tc = make(path.join(tmp, 'c2', 'schedule.json'), { now: () => NOW + 86400000 })
    await tc.refresh()
    ok((await tc.today({ sport: 'volleyball' })).games.length === 0, 'today() leaves cancelled games out, as before')
    const hb = make(path.join(tmp, 'd', 'schedule.json'), { env: { DIRECTUS_URL: fakeUrl, SCHEDULE_HALLS: 'kwi b' } })
    await hb.refresh()
    const hv = await hb.season({ sport: 'volleyball' })
    ok(hv.today.map((g) => g.id).join() === '3' && hv.upcoming.length === 1 && hv.upcoming[0].games[0].id === 6, 'SCHEDULE_HALLS=kwi b: only that hall')
  }

  console.log('\n[5] offline')
  {
    const file = path.join(tmp, 'e', 'schedule.json')
    await make(file).refresh()
    const n0 = seen.length
    const off = make(file, { env: { DIRECTUS_URL: dead } })
    ok(off.games && off.games.length === 6, 'a new process loads the copy from disk')
    const v = await off.season({ sport: 'volleyball' })
    ok(v.ok === true && v.stale === true && v.fetchedAt === new Date(NOW).toISOString() && v.today.length === 2, 'served ok:true, stale:true, with the time of the last download')
    ok(seen.length === n0, 'and a copy on disk does not wait on the network')
    const r = await off.season({ sport: 'volleyball', refresh: true })
    ok(r.ok === true && r.stale === true && r.today.length === 2, '?refresh=1 with no uplink still answers from the copy')
    const t = await off.today({ sport: 'volleyball' })
    ok(t.ok === true && t.stale === true && t.games.length === 2, 'today() too')

    const none = make(path.join(tmp, 'f', 'schedule.json'), { env: { DIRECTUS_URL: dead } })
    const nv = await none.season({ sport: 'volleyball' })
    ok(nv.ok === false && nv.today.length === 0 && nv.upcoming.length === 0 && /No schedule yet/.test(nv.error) && !/ECONN|fetch failed/.test(nv.error), `no copy: ok:false in words ("${nv.error}")`)
    const nt = await none.today({ sport: 'volleyball' })
    ok(nt.ok === false && nt.games.length === 0 && nt.error.length > 0, 'today(): ok:false as before')

    // The backoff: 1 → 2 → 4 → 5 min, scaled down here to 40/80/120 ms.
    mode = '500'
    const bf = make(path.join(tmp, 'g', 'schedule.json'), { retryMs: [40, 80, 120], refreshMs: 60_000 })
    const before = seen.length
    bf.start()
    await sleep(400)
    const tries = seen.length - before
    ok(tries >= 3 && tries <= 5, `a failing fetch retries on the backoff (${tries} tries in 400 ms)`)
    ok(bf._failures >= 3, 'counting failures')
    // The uplink comes back AND the clock syncs: a refresh right away, not after the backoff.
    await (bf._inflight || Promise.resolve())
    bf._schedule(60_000) // as if the backoff had reached its minutes-long end
    mode = 'ok'
    const at = seen.length
    bf.onClockTrusted()
    await sleep(100)
    ok(seen.length === at + 1 && bf.games && bf.games.length === 6 && bf._failures === 0, 'the clock syncing refreshes at once')
    bf.stop()
    const quiet = seen.length
    await sleep(150)
    ok(seen.length === quiet, 'stop() leaves nothing running')

    // A hang is aborted by stop() (the appliance's shutdown).
    mode = 'hang'
    const hs = make(path.join(tmp, 'h', 'schedule.json'), { timeoutMs: 60_000 })
    hs.start()
    await sleep(50)
    const t0 = Date.now()
    const pending = hs._inflight
    hs.stop()
    const hr = await pending
    ok(hr.ok === false && Date.now() - t0 < 1000, 'stop() aborts a fetch in flight')
    mode = 'ok'
    ok(logged.filter((e) => /unavailable/.test(e.msg)).every((e) => e.level === 'info'), 'failures are logged at info (offline is normal)')
  }

  console.log('\n[6] past games leave the copy on load — on a trusted clock only')
  {
    const file = path.join(tmp, 'i', 'schedule.json')
    clock.trusted = false
    await make(file).refresh()
    ok(read(file).games.some((g) => g.id === 1), 'the copy has yesterday\'s game (fetched untrusted)')
    const u = make(file, { env: { DIRECTUS_URL: dead } })
    ok(u.games.some((g) => g.id === 1), 'loaded on an untrusted clock: kept')
    ok(!(await u.season({ sport: 'volleyball' })).today.some((g) => g.id === 1), 'but never shown as today')
    clock.trusted = true
    const t = make(file, { env: { DIRECTUS_URL: dead } })
    ok(!t.games.some((g) => g.id === 1) && t.games.length === 6, 'loaded on a trusted clock: dropped')
    // And the untrusted instance prunes (and saves) the moment the clock syncs.
    u.onClockTrusted()
    ok(!u.games.some((g) => g.id === 1) && !read(file).games.some((g) => g.id === 1), 'the clock syncing prunes the copy on disk')
  }

  console.log('\n[8] the SD card: an unchanged season is not rewritten')
  {
    const file = path.join(tmp, 'j', 'schedule.json')
    clock.trusted = true
    const s = make(file)
    await s.refresh()
    const ino = fs.statSync(file).ino
    const later = (ms) => { clock.mono += ms; clock.now += ms }
    later(30 * 60 * 1000)
    await s.refresh()
    later(30 * 60 * 1000)
    await s.refresh()
    ok(fs.statSync(file).ino === ino, 'two identical refreshes: the file is not rewritten (same inode)')
    ok(read(file).fetchedAt === new Date(NOW).toISOString(), 'the time on disk is still the first download')
    ok(s.stale() === false && s.fetchedAt() === new Date(NOW + 60 * 60 * 1000).toISOString(), `but fetchedAt/stale follow the last download (${s.fetchedAt()})`)
    rows = [...ROWS, row({ id: 9, date: addDays(D, 40) })]
    await s.refresh()
    ok(fs.statSync(file).ino !== ino && read(file).games.some((g) => g.id === 9), 'a new game: written')
    rows = ROWS
    await s.refresh()
    const ino2 = fs.statSync(file).ino
    later(7 * 60 * 60 * 1000)
    await s.refresh()
    ok(fs.statSync(file).ino !== ino2, 'unchanged but the time on disk is over 6 h old: rewritten once to refresh it')
    clock.mono = 1000
    clock.now = NOW

    console.log('\n[9] a download before the clock synced gets its time on disk when it syncs')
    const f2 = path.join(tmp, 'k', 'schedule.json')
    clock.trusted = false
    const u = make(f2)
    u._running = true // as after start(), without the timers
    await u.refresh()
    ok(read(f2).fetchedAt === null, 'fetched untrusted: fetchedAt null on disk')
    clock.mono += 60_000
    clock.trusted = true
    const n0 = seen.length
    u.onClockTrusted()
    ok(read(f2).fetchedAt === new Date(NOW - 60_000).toISOString(), `the clock synced: the real download time written (${read(f2).fetchedAt})`)
    ok(seen.length === n0, 'without a second download')
    u.stop()
    clock.mono = 1000

    console.log('\n[10] a copy is served at once, even while a fetch hangs')
    mode = 'hang'
    const h = make(f2, { timeoutMs: 60_000 })
    const pending = h.refresh()
    const t0 = Date.now()
    const v = await h.season({ sport: 'volleyball' })
    ok(v.ok === true && Date.now() - t0 < 500, `answered from the copy in ${Date.now() - t0} ms, not after the fetch`)
    h._running = false
    h.stop()
    await pending
    mode = 'ok'
  }
} finally {
  unsubscribe()
}

console.log('\n[7] the routes on a booted appliance')
{
  const T = zurichDate()
  rows = [
    row({ id: 50, date: T, time: '20:00:00' }),
    row({ id: 51, date: addDays(T, 3), time: '19:00:00', home_team: 'KSC Wiedikon D2', away_team: 'Volley Näfels D1' }),
    row({ id: 52, date: addDays(T, 3), time: '20:45:00', status: 'cancelled' }),
  ]
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-season-app-'))
  const boot = () => startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
    ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
    reconnectMs: 0, mock: false, controlPort: 0, debug: false,
  })
  const saved = process.env.DIRECTUS_URL
  let app = null
  try {
    process.env.DIRECTUS_URL = fakeUrl
    app = await boot()
    const base = `http://127.0.0.1:${app.server.address().port}`
    let body = await (await fetch(base + '/api/schedule?range=season')).json()
    ok(body.ok === true && body.sport === 'volleyball' && body.date === T && body.stale === false, `?range=season: ok, not stale (${body.date})`)
    ok(body.today.length === 1 && body.today[0].id === 50 && body.upcoming.length === 1 && body.upcoming[0].games.length === 2, 'today first, then the day in three with its cancelled game')
    ok(body.upcoming[0].games.find((g) => g.id === 52).cancelled === true, 'the cancelled game is flagged')
    ok(fs.existsSync(path.join(stateDir, 'data', 'schedule.json')), 'the copy is in data/schedule.json')
    body = await (await fetch(base + '/api/schedule')).json()
    ok(body.ok === true && body.date === T && body.games.length === 1 && body.games[0].id === 50 && 'stale' in body, 'GET /api/schedule: today, as before (plus fetchedAt/stale)')
    await app.close(); app = null

    // Reboot in a hall with no uplink.
    process.env.DIRECTUS_URL = dead
    app = await boot()
    const b2 = `http://127.0.0.1:${app.server.address().port}`
    body = await (await fetch(b2 + '/api/schedule?range=season&refresh=1')).json()
    ok(body.ok === true && body.stale === true && body.today.length === 1 && body.upcoming.length === 1, 'no uplink after a reboot: the copy, ok:true, stale:true')
    body = await (await fetch(b2 + '/api/schedule')).json()
    ok(body.ok === true && body.games.length === 1 && body.stale === true, 'and today\'s list still has the 20:00 game')
  } finally {
    if (app) await app.close().catch(() => {})
    await mock.close()
    if (saved === undefined) delete process.env.DIRECTUS_URL; else process.env.DIRECTUS_URL = saved
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

await new Promise((r) => { fake.closeAllConnections?.(); fake.close(r) })
fs.rmSync(tmp, { recursive: true, force: true })
await sleep(10)

console.log(`\n${fail ? '❌' : '✅'} season schedule: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
