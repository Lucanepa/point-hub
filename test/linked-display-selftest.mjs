// A linked OpenVolley match as the hall sees it, after the C0270's first real cloud match
// (17.11.2026, wss://backend.openvolley.app, no PIN) and its live hot-fixes:
//   [1] the board's view of the live state (src/linkedView.js): substitutions counted from the
//       public events when the cloud strips subs_a/subs_b, real counts first (subs_count_* from
//       openvolley#241, then subs_a/subs_b), the finished sets recorded (set_results wins when
//       non-empty), the match number from the summary or the list, the mirror
//   [2] a pure black team colour is painted white, for every source; no team colour passes for
//       the panel's own "off" (src/ledColor.js teamRgb)
//   [3] the match PIN offered with the subscription, again on the running link, dropped when refused
//       (src/relaySubscriber.js)
//   [4] a break already running when the link began carries the match's own start (lanSource.js)
//   [5] livePush on a slow uplink: a longer budget, a readable failure, sent again with the latest
//   [6] end to end, the real appliance and a MockLedbox against a fake cloud relay: the default
//       (scorer behind the board) mirrors OpenVolley's sides, the scorer facing the board does not,
//       switched on the console mid-match; hand scoring on the console is not mirrored either way; sub counting, a "bridge restart" in a set break (the interval
//       resumes from its own start, or stays off), the summary's set 1 + the board's own sets 2-3
//       on the result screen, the PIN, the game number, black shirts
// Needs the `ws` devDependency (npm install).

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { LinkedView, cleanGameNumber } from '../src/linkedView.js'
import { LanSource, resultFromLiveState } from '../src/lanSource.js'
import { RelaySubscriber, cleanPin } from '../src/relaySubscriber.js'
import { teamRgb, edgeColor, PANEL_OFF } from '../src/ledColor.js'
import { toLeftRight, toSections } from '../src/volleyballMapper.js'
import { createLivePush } from '../src/livePush.js'
import { log as logStore } from '../src/logStore.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

// A live state as the cloud gives it to a viewer without the PIN: no subs_a/subs_b keys at all.
const BASE = {
  team_a_name: 'KSC Wiedikon', team_a_short: 'KSC', team_a_color: '#2563eb',
  team_b_name: 'OTA Volley', team_b_short: 'OTA', team_b_color: '#000000',
  current_set: 1, points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left',
  timeouts_a: [], timeouts_b: [], timeout_active: false, set_interval_active: false, match_status: 'in_progress',
  last_event_type: 'lineup', last_event_team: null, last_event_ts: '2026-11-17T19:00:00.000Z', game_n: null,
}
let tsN = 0
const ts = () => new Date(Date.UTC(2026, 10, 17, 19, 0, ++tsN)).toISOString()

// ------------------------------------------------------------------------------------------------
console.log('\n[1] the board\'s view of a linked live state')
{
  const v = new LinkedView()
  let cur = { ...BASE }
  const take = (o) => { cur = { ...cur, ...o }; v.take(cur); return v.view(cur) }
  v.take(cur) // the line-up frame before the first rally

  let s = take({ last_event_type: 'point', last_event_team: 'home', last_event_ts: ts(), points_a: 1 })
  eq([s.subs_a, s.subs_b], [0, 0], 'no subs keys and no subs yet: 0 / 0 (not undefined)')
  s = take({ last_event_type: 'substitution', last_event_team: 'home', last_event_ts: ts() })
  eq([s.subs_a, s.subs_b], [1, 0], 'a home substitution: KSC (team A, home — learned from its point) 1')
  v.take(cur); s = v.view(cur)
  eq([s.subs_a, s.subs_b], [1, 0], 'the same frame again (the relay\'s replay): counted once')
  s = take({ last_event_type: 'substitution', last_event_team: 'away', last_event_ts: ts() })
  eq([s.subs_a, s.subs_b], [1, 1], 'an away substitution: OTA 1')
  s = take({ last_event_type: 'undo', last_event_team: null, last_event_ts: ts() })
  eq([s.subs_a, s.subs_b], [1, 0], 'an undo right after it, score unchanged: taken back')
  s = take({ last_event_type: 'libero_entry', last_event_team: 'away', last_event_ts: ts() })
  eq([s.subs_a, s.subs_b], [1, 0], 'a libero replacement is no substitution')
  s = take({ last_event_type: 'point', last_event_team: 'away', last_event_ts: ts(), points_b: 1 })
  s = take({ last_event_type: 'substitution', last_event_team: 'away', last_event_ts: ts() })
  s = take({ last_event_type: 'point', last_event_team: 'home', last_event_ts: ts(), points_a: 2 })
  s = take({ last_event_type: 'undo', last_event_team: null, last_event_ts: ts(), points_a: 1 })
  eq([s.subs_a, s.subs_b], [1, 1], 'an undo of a POINT after a sub leaves the sub alone')
  s = take({ last_event_type: 'set_end', last_event_team: 'home', last_event_ts: ts(), current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, set_interval_active: true })
  eq([s.subs_a, s.subs_b], [0, 0], 'the next set starts at 0 / 0')

  console.log('  — real counts win')
  eq([v.view({ ...cur, subs_count_a: 3, subs_count_b: 4 }).subs_a, v.view({ ...cur, subs_count_a: 3, subs_count_b: 4 }).subs_b], [3, 4], 'subs_count_a/_b (openvolley#241) first')
  eq(v.view({ ...cur, subs_count_a: 0, subs_count_b: 0, subs_a: [{}, {}] }).subs_a, 0, '…even over subs_a')
  const full = v.view({ ...cur, subs_a: [{}, {}], subs_b: null })
  eq([full.subs_a.length, full.subs_b], [2, null], 'subs_a / subs_b present (a PIN-proved or LAN view): passed through as they are')

  console.log('  — home / away from the summary\'s names, before any point')
  const w = new LinkedView()
  w.takeSummary({ match: { game_n: 405974 }, homeTeam: { name: 'OTA Volley' }, awayTeam: 'KSC Wiedikon' })
  const st = { ...BASE, last_event_type: 'substitution', last_event_team: 'home', last_event_ts: ts() }
  w.take(st)
  eq([w.view(st).subs_a, w.view(st).subs_b], [0, 1], 'home is OTA (team B) by name: a home sub is B\'s')
  eq(w.view(st).game_n, '405974', 'game_n from the summary when the live state has none')
  eq(w.view({ ...st, game_n: 4711 }).game_n, 4711, 'the live state\'s own game_n wins')
  eq(new LinkedView({ gameNumber: '777' }).view({ ...BASE }).game_n, '777', 'else the number the Link tab listed it under')
  eq([cleanGameNumber(' 405974 '), cleanGameNumber('<x>'), cleanGameNumber(null)], ['405974', null, null], 'cleanGameNumber')

  console.log('  — the finished sets')
  const r = new LinkedView()
  let m = { ...BASE }
  const play = (o) => { m = { ...m, last_event_ts: ts(), ...o }; r.take(m); return r.view(m) }
  play({ last_event_type: 'point', last_event_team: 'home', points_a: 26, points_b: 25 })
  play({ last_event_type: 'point', last_event_team: 'home', points_a: 27, points_b: 25 })
  let x = play({ last_event_type: 'set_end', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, set_interval_active: true })
  eq(x.set_results, [{ a: 27, b: 25 }], 'set 1 recorded at its last score: 27-25')
  play({ last_event_type: 'reconnect', current_set: 1, points_a: 27, points_b: 25, sets_won_a: 0 })
  play({ last_event_type: 'set_start', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1 })
  play({ last_event_type: 'point', last_event_team: 'home', points_a: 25, points_b: 12 })
  play({ last_event_type: 'set_end', current_set: 3, points_a: 0, points_b: 0, sets_won_a: 2, set_interval_active: true })
  play({ last_event_type: 'point', last_event_team: 'home', points_a: 25, points_b: 16 })
  x = play({ last_event_type: 'match_end', match_status: 'ended', sets_won_a: 3 })
  eq(x.set_results, [{ a: 27, b: 25 }, { a: 25, b: 12 }, { a: 25, b: 16 }], 'three sets at the match end')
  eq(resultFromLiveState(x).history, '27-25  25-12  25-16', 'the result screen\'s line')
  eq(r.view({ ...m, set_results: [{ set: 1, home: 25, away: 20, a: 25, b: 20 }] }).set_results, [{ set: 1, home: 25, away: 20, a: 25, b: 20 }], 'a non-empty set_results in the state (openvolley#241) wins')
  eq(r.view({ ...m, set_results: [] }).set_results.length, 3, 'an empty one does not')
  const late = new LinkedView()
  const mid = { ...BASE, current_set: 3, sets_won_a: 2, points_a: 25, points_b: 16, match_status: 'ended', sets_won_b: 0 }
  late.take(mid)
  eq(late.view({ ...mid, sets_won_a: 3 }).set_results, undefined, 'linked late, sets 1-2 unknown: no history at all (not a wrong one)')
  late.takeSummary({ homeTeam: { name: 'KSC Wiedikon' }, sets: [
    { index: 1, homePoints: 27, awayPoints: 25, finished: true }, { index: 2, homePoints: 25, awayPoints: 12, finished: true },
    { index: 3, homePoints: 25, awayPoints: 16, finished: false }] })
  late.take(mid)
  eq(late.view({ ...mid, sets_won_a: 3 }).set_results, [{ a: 27, b: 25 }, { a: 25, b: 12 }, { a: 25, b: 16 }], '…until the summary\'s finished sets fill them in')
  const odd = new LinkedView()
  odd.take({ ...BASE, current_set: 1, points_a: 24, points_b: 23 })
  eq(odd.view({ ...BASE, current_set: 2, sets_won_a: 1 }).set_results, undefined, 'a set the board missed the end of (24-23): no history')

  console.log('  — the mirror')
  const mv = new LinkedView().view({ ...BASE, side_a: 'left', serving_team: 'left' }, { mirror: true })
  eq([mv.side_a, mv.serving_team], ['right', 'right'], 'side_a and serving_team turned round together')
  eq(toLeftRight(mv).leftName, 'OTA', 'so OTA is on the panel\'s left')
  eq(new LinkedView().view({ ...BASE, serving_team: null }, { mirror: true }).serving_team, null, 'nobody serving stays nobody')
}

// ------------------------------------------------------------------------------------------------
console.log('\n[2] team colours: pure black is white, and never the panel\'s "off"')
{
  eq(teamRgb('#000000'), '255,255,255', '#000000 → white')
  eq(teamRgb('#1e1e1e'), '31,31,31', '#1e1e1e (the serve bar\'s "off" value) moves one step')
  ok(!PANEL_OFF.has(teamRgb('#1e1e1e')) && edgeColor(teamRgb('#1e1e1e'), { brightness: 40 }) !== '31,31,31', '…and gets the dark-colour lift on its border like any dark team')
  eq([teamRgb('#ef4444'), teamRgb(''), teamRgb('rgb(1,2,3)')], ['239,68,68', '255,255,255', '1,2,3'], 'every other colour as hexToRgb has it')
  for (const src of ['linked', 'console', 'schedule']) {
    const secs = toSections({ ...BASE, team_b_color: '#000000', team_a_color: '#2563eb' })
    const box = secs.find((s) => s.name === 'bg_score2' && s.value.attrib === 'bordercolor')
    ok(box && box.value.value === '255,255,255', `${src}: a team in black keeps a white score box (${box && box.value.value})`)
  }
}

// ------------------------------------------------------------------------------------------------
// A cloud relay as OpenVolley's backend runs it, for [3] and [6]: the flat bundle, the PIN-free
// summary for a socket that did not prove the PIN (no subs keys), the full state for one that did.
const PIN = 'ov4821x' // letters too, so the log check below cannot hit a timestamp or an id
const SEED = 'match_1763405974_c0270'
let cur = { ...BASE }
let seq = 0
const session = 'tab-a7'
const summary = { match: { id: SEED, status: 'live', game_n: 405974 }, homeTeam: { name: 'KSC Wiedikon', shortName: 'KSC' }, awayTeam: { name: 'OTA Volley' }, sets: [] }
let stored = null
const subscribes = [] // every subscribe-match the relay got: { pin }
const viewers = new Map() // ws -> { proved }
const cloud = http.createServer((req, res) => {
  if (req.url === '/api/match/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ success: true, matches: [{ id: SEED, gameNumber: 405974, homeTeam: 'KSC', awayTeam: 'OTA', status: 'live' }] }))
  }
  res.writeHead(404); res.end()
})
const wss = new WebSocketServer({ server: cloud })
const publicView = (s) => { const o = { ...s }; delete o.subs_a; delete o.subs_b; delete o.last_event_data; return o }
const shown = (ws, s) => (viewers.get(ws)?.proved ? s : publicView(s))
const fullData = (ws, type = 'match-full-data') => ({
  type, matchId: SEED, access: viewers.get(ws)?.proved ? 'full' : 'summary', ...summary,
  ...(stored ? { data: { liveState: shown(ws, stored) } } : {}),
})
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf))
    if (msg.type !== 'subscribe-match' || msg.matchId !== SEED) return
    subscribes.push({ pin: msg.pin ?? null })
    const v = viewers.get(ws) || { proved: false }
    if (msg.pin != null) {
      if (msg.pin === PIN) v.proved = true
      else { ws.send(JSON.stringify({ type: 'error', code: 'pin-invalid', message: 'Wrong PIN for this match', matchId: SEED })); v.proved = false }
    }
    viewers.set(ws, v)
    ws.send(JSON.stringify(fullData(ws)))
  })
  ws.on('close', () => viewers.delete(ws))
})
await new Promise((r) => cloud.listen(0, '127.0.0.1', r))
const CLOUD = `127.0.0.1:${cloud.address().port}`
const push = (o = {}) => {
  cur = { ...cur, timeout_active: false, set_interval_active: false, ...o }
  if (o.last_event_type && !o.last_event_ts) cur.last_event_ts = ts()
  stored = { ...cur, _seq: ++seq, _session: session }
  for (const ws of viewers.keys()) ws.send(JSON.stringify({ type: 'live-state-update', matchId: SEED, liveState: shown(ws, stored) }))
  return stored
}
const sendSummary = () => { for (const ws of viewers.keys()) ws.send(JSON.stringify(fullData(ws, 'match-data-update'))) }

// ------------------------------------------------------------------------------------------------
console.log('\n[3] the match PIN on the subscription')
{
  eq([cleanPin(' 4821 '), cleanPin(''), cleanPin(null), cleanPin('x'.repeat(33)), cleanPin('12 34')], ['4821', null, null, null, null], 'cleanPin')
  stored = push({ points_a: 3, subs_a: [{}], last_event_type: 'point', last_event_team: 'home' })
  const got = []
  const sub = new RelaySubscriber({ url: `ws://${CLOUD}`, matchId: SEED, reconnectMs: 100, pin: PIN })
  sub.on('state', (s) => got.push(s))
  const summaries = []
  sub.on('summary', (d) => summaries.push(d))
  sub.on('error', () => {})
  subscribes.length = 0
  sub.start(); await sleep(300)
  eq(subscribes, [{ pin: PIN }], 'subscribe-match carries the PIN')
  ok(sub.pinState === 'accepted' && Array.isArray(got.at(-1)?.subs_a), `the relay took it: pinState ${sub.pinState}, the full state (subs_a)`)
  ok(summaries.length === 1 && summaries[0].match.game_n === 405974 && summaries[0].homeTeam.name === 'KSC Wiedikon', 'the flat bundle comes out as a summary (match, teams, sets)')
  subscribes.length = 0
  eq(sub.setPin('0000'), 'offered', 'a new PIN on the running link')
  await sleep(250)
  ok(subscribes.length === 1 && subscribes[0].pin === '0000', 'asked again at once, on the same socket')
  ok(sub.pinState === 'refused', `a wrong one: refused (${sub.pinState})`)
  subscribes.length = 0
  for (const ws of wss.clients) ws.terminate()
  await sleep(400)
  eq(subscribes, [{ pin: null }], 'the reconnect after it sends no PIN (no second wrong PIN counted)')
  sub.stop()
  await sleep(100)
}

// ------------------------------------------------------------------------------------------------
console.log('\n[4] a break already running when the link began carries its own start')
{
  const started = Date.now() - 60000
  const lan = new LanSource({ relayUrl: `ws://127.0.0.1:${await freePort()}`, matchId: 'm', reconnectMs: 0 })
  const seen = []
  lan.on('interval-start', (s, info) => seen.push(['interval-start', info]))
  lan.on('timeout-start', (s, info) => seen.push(['timeout-start', info]))
  lan.on('error', () => {})
  lan.start()
  const feed = (o, type = 'match-full-data') => lan.sub._onMessage(JSON.stringify(type === 'match-full-data' ? { type, matchId: 'm', data: { liveState: o } } : { type, matchId: 'm', liveState: o }))
  feed({ ...BASE, set_interval_active: true, last_event_type: 'set_end', current_set: 2, sets_won_a: 1, set_interval_started_at: new Date(started).toISOString() })
  eq(seen, [['interval-start', { late: true, startedAt: started }]], 'the first frame is a set_end: late, with set_interval_started_at')
  feed({ ...BASE, current_set: 2, sets_won_a: 1, last_event_type: 'set_start' }, 'live-state-update')
  seen.length = 0
  feed({ ...BASE, current_set: 3, sets_won_a: 2, set_interval_active: true, last_event_type: 'set_end', set_interval_started_at: new Date().toISOString() }, 'live-state-update')
  eq(seen.map(([e, i]) => [e, !!i.late]), [['interval-start', false]], 'one seen as it happens: not late (timed from now, as before)')
  const lan2 = new LanSource({ relayUrl: `ws://127.0.0.1:${await freePort()}`, matchId: 'm', reconnectMs: 0 })
  const seen2 = []
  lan2.on('timeout-start', (s, info) => seen2.push(info))
  lan2.on('error', () => {})
  lan2.start()
  lan2.sub._onMessage(JSON.stringify({ type: 'match-full-data', matchId: 'm', data: { liveState: { ...BASE, timeout_active: true, timeouts_a: [{}] } } }))
  eq(seen2, [{ side: null, late: true, startedAt: null }], 'a timeout with no timeout_started_at: late, start unknown')
  lan.stop(); lan2.stop()
}

// ------------------------------------------------------------------------------------------------
console.log('\n[5] livePush on a slow uplink')
{
  ok(createLivePush({}).enabled === false, 'off without a URL (sanity)')
  let n = 0
  const bodies = []
  const slow = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      n++
      bodies.push(JSON.parse(b || '{}'))
      if (n === 1) return // the first write never answers: the timeout's job
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
    })
  })
  await new Promise((r) => slow.listen(0, '127.0.0.1', r))
  const lines = []
  const onEntry = (e) => { if (e && e.scope === 'livePush' && /publish failed/.test(e.msg)) lines.push(e) }
  logStore.on('entry', onEntry)
  const lp = createLivePush({ url: `http://127.0.0.1:${slow.address().port}`, token: 't', timeoutMs: 300, retryBaseMs: 100, debounceMs: 10 })
  lp.push({ ...BASE, points_a: 1 })
  await sleep(150)
  lp.push({ ...BASE, points_a: 2 }) // arrives while the first is still waiting
  await sleep(900)
  ok(n >= 2 && bodies.at(-1).points_a === 2, `the timed-out write is followed by one with the LATEST state (${n} writes, last ${bodies.at(-1)?.points_a})`)
  logStore.off('entry', onEntry)
  const first = lines[0]
  ok(!first || (/no answer within/.test(first.msg || first.message || '') && first.level !== 'warn'),
    `the first failure reads as a timeout, at info (${first ? `${first.level}: ${first.msg || first.message}` : 'not captured'})`)
  ok(!lp.failing(), 'and nothing reads as failing once it went through')
  lp.detach()
  slow.closeAllConnections?.()
  await new Promise((r) => slow.close(r))
}

// ------------------------------------------------------------------------------------------------
console.log('\n[6] end to end: the appliance, a MockLedbox and a fake cloud relay')
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-linkdisplay-'))
const mock = new MockLedbox({ layouts: { kscw_break: sectionsOf('31_kscw_break.xml'), kscw_idle: sectionsOf('30_kscw_idle.xml'), kscw_crest: sectionsOf('32_kscw_crest.xml'), kscw_clock: sectionsOf('33_kscw_clock.xml') } })
const addr = await mock.listen(0, '127.0.0.1')
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '', relayDesktopPort: await freePort(),
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 200, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const get = async (p) => (await fetch(base + p)).json()
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) } }
const t = (n) => mock.text(n)
const cd = async () => (await get('/api/board')).countdown
const IV_S = 120
const MATCH = 'volleyball_matchscore_02'
try {
  await sleep(250)
  await post('/api/clock', { epochMs: Date.now() }) // the board's clock is believed (NTP or the console's)
  eq((await get('/api/settings')).orientation, 'behind', 'a new board: the scorer sits behind the board')
  // Facing the board first: OpenVolley's sides reach the panel as they come, so the checks below
  // read like the scoresheet. The mirror ('behind', the default) is switched to further down.
  await post('/api/settings', { relayAddress: CLOUD, setIntervalSeconds: IV_S, orientation: 'front' })
  cur = { ...BASE }; viewers.clear()
  push({ last_event_type: 'lineup' })
  const listed = await get('/api/matches')
  ok((listed.matches || []).some((m) => m.id === SEED), 'the cloud match is listed')

  console.log('  — no PIN: the cloud strips the substitutions, the board counts them')
  let l = await post('/api/link', { source: 'lan', matchId: SEED })
  await sleep(350)
  ok(l.status === 200 && (await get('/api/status')).linkPin === 'none', `linked, no PIN (${l.status})`)
  push({ last_event_type: 'point', last_event_team: 'home', points_a: 1 }); await sleep(200)
  push({ last_event_type: 'substitution', last_event_team: 'home' }); await sleep(200)
  push({ last_event_type: 'substitution', last_event_team: 'away' }); await sleep(200)
  ok(mock.currentLayout === MATCH && t('team1') === 'KSC' && t('sub1') === '1' && t('sub2') === '1', `KSC left with 1 sub, OTA right with 1 (${t('team1')} ${t('sub1')} | ${t('team2')} ${t('sub2')})`)
  push({ last_event_type: 'undo', last_event_team: null }); await sleep(200)
  ok(t('sub2') === '0' && t('sub1') === '1', `the undo took OTA's back (${t('sub1')} | ${t('sub2')})`)
  push({ last_event_type: 'libero_entry', last_event_team: 'home' }); await sleep(200)
  ok(t('sub1') === '1', `a libero entry is not counted (${t('sub1')})`)
  ok(mock.screen.bg_score2?.bordercolor === '255,255,255', `OTA in black shirts keeps its score box, in white (${mock.screen.bg_score2?.bordercolor})`)
  const st0 = await get('/api/status')
  eq(String(st0.state && st0.state.game_n), '405974', 'the game number from the match summary (the live state has none)')

  console.log('  — the scorer sits behind the board (the default): switched on the console mid-match')
  const serveLit = (n) => mock.color(n) && mock.color(n) !== '30,30,30'
  ok(serveLit('serve1') && !serveLit('serve2'), 'KSC serving, on the left')
  await post('/api/settings', { orientation: 'behind' }); await sleep(300)
  ok(t('team1') === 'OTA' && t('team2') === 'KSC', `behind the board: the scorer's left (KSC) is the panel's right, at once, no rally needed (${t('team1')} | ${t('team2')})`)
  ok(t('score1') === '0' && t('score2') === '1' && t('sub1') === '0' && t('sub2') === '1', `scores and subs went with the teams (${t('score1')}:${t('score2')}, subs ${t('sub1')} | ${t('sub2')})`)
  ok(serveLit('serve2') && !serveLit('serve1'), 'and so did the serve')
  push({ last_event_type: 'point', last_event_team: 'away', points_b: 1, serving_team: 'right' }); await sleep(200)
  ok(t('score1') === '1' && serveLit('serve1'), `the next rally stays mirrored: OTA 1 on the left, serving (${t('score1')})`)
  await post('/api/settings', { orientation: 'front' }); await sleep(300)
  ok(t('team1') === 'KSC' && t('score2') === '1', `facing the board again: as OpenVolley sends them (${t('team1')} ${t('score1')}:${t('score2')})`)

  console.log('  — set 1 ends 27-25; the bridge restarts in the break')
  push({ last_event_type: 'point', last_event_team: 'home', points_a: 27, points_b: 25 }); await sleep(150)
  summary.sets = [{ index: 1, homePoints: 27, awayPoints: 25, finished: true }]
  const began = Date.now() - 60000
  push({ last_event_type: 'set_end', last_event_team: 'home', set_interval_active: true, set_interval_started_at: new Date(began).toISOString(), current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, side_a: 'right', serving_team: 'left' })
  sendSummary(); await sleep(300)
  const c1 = await cd()
  ok(c1 && c1.link === 'interval' && c1.remainingMs > (IV_S - 2) * 1000, `seen live: INTERVAL, the full ${IV_S} s (${c1 && Math.round(c1.remainingMs / 1000)})`)
  // A restart is a new link whose first state is the relay's stored set_end frame.
  await post('/api/countdown/stop', { expired: false })
  l = await post('/api/link', { source: 'lan', matchId: SEED }); await sleep(400)
  const c2 = await cd()
  ok(c2 && c2.link === 'interval' && Math.abs(c2.remainingMs / 1000 - (IV_S - 60)) < 3, `relinked: the interval resumes from its own start, ~${IV_S - 60} s left (${c2 && Math.round(c2.remainingMs / 1000)})`)
  await post('/api/countdown/stop', { expired: false })
  const keep = cur.set_interval_started_at
  push({ set_interval_active: true, set_interval_started_at: null }); await sleep(100)
  l = await post('/api/link', { source: 'lan', matchId: SEED }); await sleep(400)
  ok((await cd()) === null && mock.currentLayout === MATCH, `relinked with no interval start: no countdown at all, not the full 3 minutes again (${mock.currentLayout})`)
  push({ set_interval_active: true, set_interval_started_at: new Date(Date.now() - (IV_S + 30) * 1000).toISOString() }); await sleep(100)
  l = await post('/api/link', { source: 'lan', matchId: SEED }); await sleep(400)
  ok((await cd()) === null, 'relinked after the break ran out by its own start: no countdown')
  cur.set_interval_started_at = keep

  console.log('  — sets 2 and 3, the board\'s own; set 1 from the summary')
  push({ last_event_type: 'set_start', current_set: 2 }); await sleep(150)
  push({ last_event_type: 'point', last_event_team: 'home', points_a: 1 }); await sleep(150)
  push({ last_event_type: 'substitution', last_event_team: 'away' }); await sleep(200)
  ok(t('team2') === 'KSC' && t('sub1') === '1' && t('sub2') === '0', `set 2, ends changed: OTA left with 1 sub (${t('team1')} ${t('sub1')} | ${t('team2')} ${t('sub2')})`)
  push({ last_event_type: 'point', last_event_team: 'home', points_a: 25, points_b: 12 }); await sleep(150)
  push({ last_event_type: 'set_end', set_interval_active: true, current_set: 3, points_a: 0, points_b: 0, sets_won_a: 2, side_a: 'left', set_interval_started_at: new Date().toISOString() }); await sleep(250)
  push({ last_event_type: 'set_start' }); await sleep(150)
  push({ last_event_type: 'point', last_event_team: 'home', points_a: 25, points_b: 16 }); await sleep(150)
  push({ last_event_type: 'match_end', match_status: 'ended', sets_won_a: 3 }); await sleep(500)
  ok(mock.currentLayout === 'kscw_result', `the result screen (${mock.currentLayout})`)
  eq([t('winner'), t('history')], ['KSC WIEDIKON WINS', '27-25  25-12  25-16'], 'winner and every set on it')

  console.log('  — with the PIN: the full live state')
  cur = { ...BASE, current_set: 1, points_a: 4, points_b: 2, subs_a: [{}, {}], subs_b: [{}] }
  push({ last_event_type: 'point', last_event_team: 'home' })
  subscribes.length = 0
  l = await post('/api/link', { source: 'lan', matchId: SEED, pin: PIN }); await sleep(400)
  ok(subscribes.some((x) => x.pin === PIN), 'the PIN went with the subscription')
  eq((await get('/api/status')).linkPin, 'accepted', 'status: accepted (never the PIN itself)')
  ok(t('sub1') === '2' && t('sub2') === '1', `the real subs_a / subs_b (${t('sub1')} | ${t('sub2')})`)
  const bad = await post('/api/link', { source: 'lan', matchId: SEED, pin: 'no spaces allowed' })
  ok(bad.status === 400, `a PIN that cannot be one is refused before it reaches OpenVolley (${bad.status})`)
  const r1 = await post('/api/link/pin', { pin: 'wrong9q' }); await sleep(300)
  ok(r1.status === 200 && (await get('/api/status')).linkPin === 'refused', 'a wrong PIN on the running link: refused, and the link carries on')
  const logs = JSON.stringify(logStore.entries || [])
  ok(!logs.includes(PIN) && !logs.includes('wrong9q'), 'neither PIN is anywhere in the log')

  console.log('  — hand scoring on the console: never mirrored')
  const m = await post('/api/manual', { takeOver: true }); await sleep(200)
  ok(m.status === 200 && (await get('/api/status')).mode === 'manual', `the console scores now (${m.status})`)
  await post('/api/action', { action: { type: 'reset' } }); await sleep(150)
  await post('/api/action', { action: { type: 'team', side: 'left', short: 'HOM' } })
  await post('/api/action', { action: { type: 'team', side: 'right', short: 'GST' } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } }); await sleep(250)
  const panel = () => `${t('team1')} ${t('score1')}:${t('score2')} ${t('team2')}`
  for (const o of ['behind', 'front', 'behind']) {
    await post('/api/settings', { orientation: o }); await sleep(250)
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } }); await sleep(250)
    ok(t('team1') === 'HOM' && t('team2') === 'GST' && Number(t('score1')) > 0 && t('score2') === '0', `${o}: the left team stays on the panel's left (${panel()})`)
  }
} finally {
  await app.close(); await mock.close(); fs.rmSync(stateDir, { recursive: true, force: true })
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  cloud.closeAllConnections?.()
  await new Promise((r) => cloud.close(r))
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — linked-display-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
