// The substitution notice of a linked OpenVolley match: WECHSEL 12 ⇄ 7 on the announcement screen
// for a few seconds (src/linkedView.js takeNewSubs → src/lanSource.js 'substitution' →
// src/controlServer.js watchLinkedMatch → ledboxClient.showMessage, src/boardNotices.js the words).
//   [1] what is new in each state: the full lists (a LAN relay, or the match PIN) with the numbers,
//       a double substitution sent as ONE state, the relay's replay, an undo, a set change, the first
//       state of a link; the cloud's stripped view (no numbers: the team, from the event or the
//       public count); libero replacements never
//   [2] the two lines in the board's language, with and without numbers, and the message screen
//   [3] end to end, the real appliance and a MockLedbox against a fake relay: the notice, one screen
//       per substitution, back to the score; no numbers → the team's name, or nothing on 'numbers';
//       off; English; not over a countdown; not for a libero
// Needs the `ws` devDependency (npm install).

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { LinkedView } from '../src/linkedView.js'
import { subNoticeLines, shirtNumber, SUB_ARROW } from '../src/boardNotices.js'
import { toMessageSections } from '../src/volleyballMapper.js'
import { GLOBAL_DEFAULTS, sanitize } from '../src/settings.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`) } else { fail++; console.log(`  ❌ ${m}`) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

let tsN = 0
const ts = () => new Date(Date.UTC(2026, 10, 18, 19, 0, ++tsN)).toISOString()
const BASE = {
  team_a_name: 'Volley Nord', team_a_short: 'NORD', team_a_color: '#2563eb',
  team_b_name: 'Volley Sued', team_b_short: 'SUED', team_b_color: '#ef4444',
  current_set: 1, points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left',
  timeouts_a: [], timeouts_b: [], timeout_active: false, set_interval_active: false, match_status: 'in_progress',
  last_event_type: 'lineup', last_event_team: null, last_event_ts: '2026-11-18T19:00:00.000Z', best_of: 5,
}
const strip = (s) => { const o = { ...s }; delete o.subs_a; delete o.subs_b; delete o.last_event_data; return o }
const sub = (playerOut, playerIn, extra = {}) => ({ playerOut, playerIn, position: 'II', exceptional: false, ts: ts(), ...extra })

console.log('\n[1] what each state brings')
{
  console.log('  — the full lists (LAN relay, or the match PIN)')
  const v = new LinkedView()
  let cur = { ...BASE, subs_a: null, subs_b: null }
  const take = (o) => { cur = { ...cur, ...o }; v.take(cur); return v.takeNewSubs() }
  eq(take({}), [], 'the first state of the link: nothing is news')
  eq(take({ last_event_type: 'point', last_event_team: 'home', last_event_ts: ts(), points_a: 1 }), [], 'a point: nothing')
  eq(take({ last_event_type: 'substitution', last_event_team: 'home', last_event_ts: ts(), last_event_data: { playerIn: 7, playerOut: 12 }, subs_a: [sub(12, 7)] }),
    [{ team: 'a', playerOut: 12, playerIn: 7 }], 'a substitution: team A, 12 off, 7 on')
  v.take(cur)
  eq(v.takeNewSubs(), [], 'the same state again (the relay\'s replay): nothing')
  eq(take({ last_event_type: 'substitution', last_event_team: 'away', last_event_ts: ts(), last_event_data: { playerIn: 9, playerOut: 4 }, subs_b: [sub(3, 11), sub(4, 9)] }),
    [{ team: 'b', playerOut: 3, playerIn: 11 }, { team: 'b', playerOut: 4, playerIn: 9 }], 'a double substitution in ONE state (OpenVolley merges the pushes): both, in order')
  eq(take({ last_event_type: 'libero_entry', last_event_team: 'home', last_event_ts: ts(), last_event_data: { liberoIn: 1, playerOut: 7 } }), [], 'a libero replacement: nothing')
  eq(take({ last_event_type: 'undo', last_event_team: null, last_event_ts: ts(), subs_b: [sub(3, 11)] }), [], 'an undo of a substitution: nothing')
  eq(take({ last_event_type: 'substitution', last_event_team: 'home', last_event_ts: ts(), subs_a: [sub(12, 7), sub(5, 15, { exceptional: true })] }),
    [{ team: 'a', playerOut: 5, playerIn: 15 }], 'an exceptional substitution is shown like any other')
  eq(take({ last_event_type: 'set_end', last_event_ts: ts(), current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, subs_a: null, subs_b: null, set_interval_active: true }), [], 'the set ends: nothing')
  eq(take({ last_event_type: 'substitution', last_event_team: 'away', last_event_ts: ts(), set_interval_active: false, subs_b: [sub(8, 2)] }),
    [{ team: 'b', playerOut: 8, playerIn: 2 }], 'set 2 counts from its own empty list')

  console.log('  — the cloud\'s view without the PIN (subs_a / subs_b and last_event_data stripped)')
  const c = new LinkedView()
  let pub = { ...BASE }
  const takeP = (o) => { pub = { ...pub, ...o }; c.take(strip(pub)); return c.takeNewSubs() }
  takeP({})
  takeP({ last_event_type: 'point', last_event_team: 'home', last_event_ts: ts(), points_a: 1 }) // learns NORD (A) = home
  eq(takeP({ last_event_type: 'substitution', last_event_team: 'home', last_event_ts: ts() }), [{ team: 'a', playerOut: null, playerIn: null }], 'a home substitution: team A, no numbers')
  c.take(strip(pub))
  eq(c.takeNewSubs(), [], 'the replay: nothing')
  eq(takeP({ last_event_type: 'libero_exit', last_event_team: 'away', last_event_ts: ts() }), [], 'a libero exit: nothing')
  eq(takeP({ last_event_type: 'substitution', last_event_team: 'away', last_event_ts: ts() }), [{ team: 'b', playerOut: null, playerIn: null }], 'an away substitution: team B')
  eq(takeP({ last_event_type: 'undo', last_event_team: null, last_event_ts: ts() }), [], 'its undo: nothing')
  // A view that keeps last_event_data (a LAN relay of a version that sends no lists): the numbers.
  c.take({ ...strip(pub), last_event_type: 'substitution', last_event_team: 'home', last_event_ts: ts(), last_event_data: { playerIn: '14', playerOut: '6' } })
  eq(c.takeNewSubs(), [{ team: 'a', playerOut: '6', playerIn: '14' }], 'no lists but last_event_data: the numbers from the event')

  console.log('  — the public count (subs_count_a/_b, openvolley#241)')
  const k = new LinkedView()
  let cnt = { ...BASE, subs_count_a: 0, subs_count_b: 0 }
  const takeK = (o) => { cnt = { ...cnt, ...o }; k.take(strip(cnt)); return k.takeNewSubs() }
  takeK({})
  eq(takeK({ last_event_type: 'substitution', last_event_team: 'away', last_event_ts: ts(), subs_count_b: 2 }),
    [{ team: 'b', playerOut: null, playerIn: null }, { team: 'b', playerOut: null, playerIn: null }], 'the count went up by 2 in one state: two, team B — known from the count, before any point')
  eq(takeK({ last_event_type: 'libero_entry', last_event_team: 'away', last_event_ts: ts() }), [], 'a libero entry: the count stays, nothing')
}

console.log('\n[2] the lines')
{
  eq(subNoticeLines({ playerOut: 12, playerIn: 7, name: 'NORD' }, { language: 'de' }), ['WECHSEL', `12 ${SUB_ARROW} 7`], 'German: WECHSEL / 12 ⇄ 7 (off first, then on)')
  eq(subNoticeLines({ playerOut: '04', playerIn: '9' }, { language: 'de-CH' }), ['WECHSEL', '4 ⇄ 9'], 'Swiss German the same; numbers as numbers')
  eq(subNoticeLines({ playerOut: 12, playerIn: 7 }, { language: 'en' }), ['SUBSTITUTION', '12 ⇄ 7'], 'English: SUBSTITUTION')
  eq(subNoticeLines({ playerOut: null, playerIn: null, name: 'Nord' }, { language: 'de' }), ['WECHSEL', 'NORD'], 'no numbers: the team\'s short name')
  eq(subNoticeLines({ playerOut: null, playerIn: null, name: 'Nord' }, { language: 'de', numbersOnly: true }), null, '…or nothing, on "numbers only"')
  eq(subNoticeLines({ playerOut: null, playerIn: null, name: '' }, { language: 'de' }), null, 'no numbers and no team: nothing')
  eq([shirtNumber('<b>'), shirtNumber('1234'), shirtNumber(' 7 '), shirtNumber(null)], [null, null, '7', null], 'only 1-3 digits are a shirt number')
  const secs = toMessageSections('', { lines: ['WECHSEL', '12 ⇄ 7'], color: '37,99,235' })
  const v = (n, a = 'text') => (secs.find((x) => x.name === n && x.value.attrib === a) || {}).value?.value
  eq([v('msgbig'), v('msg1'), v('msg2'), v('msg1', 'color')], ['', 'WECHSEL', '12 ⇄ 7', '37,99,235'], 'the message screen: two lines exactly, in the team\'s colour')
  const long = toMessageSections('', { lines: ['WECHSEL', 'VBC KUESNACHT'] })
  eq([(long.find((x) => x.name === 'msg1' && x.value.attrib === 'text') || {}).value?.value, (long.find((x) => x.name === 'msg2' && x.value.attrib === 'text') || {}).value?.value], ['WECHSEL', 'VBC KUESNACHT'], 'a two-word team name is never split across the lines')
  ok(GLOBAL_DEFAULTS.subNotice === 'all', 'Settings: on by default (numbers, else the team)')
  eq(['all', 'numbers', 'off', 'nope'].map((x) => sanitize({ subNotice: x }).subNotice), ['all', 'numbers', 'off', 'all'], 'all | numbers | off, nothing else')
}

console.log('\n[3] end to end: the appliance, a MockLedbox and a fake relay')
const SEED = 'match_1763492400_subs'
let cur = { ...BASE }
let seq = 0
let full = true // what the relay sends: the full state (LAN) or the cloud's public view
const viewers = new Set()
const relay = http.createServer((req, res) => {
  if (req.url === '/api/match/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ success: true, matches: [{ id: SEED, homeTeam: 'NORD', awayTeam: 'SUED', status: 'live' }] }))
  }
  res.writeHead(404); res.end()
})
const wss = new WebSocketServer({ server: relay })
let stored = null
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf))
    if (msg.type !== 'subscribe-match' || msg.matchId !== SEED) return
    viewers.add(ws)
    ws.send(JSON.stringify({ type: 'match-full-data', matchId: SEED, match: { id: SEED, status: 'live' }, homeTeam: { name: 'Volley Nord', shortName: 'NORD' }, awayTeam: { name: 'Volley Sued', shortName: 'SUED' }, sets: [], ...(stored ? { data: { liveState: stored } } : {}) }))
  })
  ws.on('close', () => viewers.delete(ws))
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const push = (o = {}) => {
  cur = { ...cur, ...o }
  if (o.last_event_type && !o.last_event_ts) cur.last_event_ts = ts()
  stored = { ...(full ? cur : strip(cur)), _seq: ++seq, _session: 'tab-s1' }
  for (const ws of viewers) ws.send(JSON.stringify({ type: 'live-state-update', matchId: SEED, liveState: stored }))
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-subnotice-'))
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
// Every announcement the panel got: its two lines and colour, in order.
const shown = []
mock.on('command', (m) => {
  if (m.cmd !== 'SetSections' || mock.currentLayout !== 'kscw_message') return
  const get = (n, a = 'text') => (m.value.find((x) => x.name === n && x.value.attrib === a) || {}).value?.value
  if (get('msg1')) shown.push({ l1: get('msg1'), l2: get('msg2'), color: get('msg1', 'color') })
})
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '', ledboxHost: '127.0.0.1', ledboxPort: addr.port,
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 200, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const get = async (p) => (await fetch(base + p)).json()
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) } }
const t = (n) => mock.text(n)
const MATCH = 'volleyball_matchscore_02'
const backToScore = async (max = 8000) => { const t0 = Date.now(); while (mock.currentLayout !== MATCH && Date.now() - t0 < max) await sleep(100); return mock.currentLayout === MATCH }
try {
  await sleep(250)
  await post('/api/settings', { relayAddress: `127.0.0.1:${relay.address().port}`, orientation: 'front', language: 'de' })
  push({ last_event_type: 'lineup', subs_a: null, subs_b: null })
  await get('/api/matches')
  const l = await post('/api/link', { source: 'lan', matchId: SEED })
  await sleep(400)
  ok(l.status === 200 && (await get('/api/status')).mode === 'lan', `linked (${l.status})`)
  push({ last_event_type: 'point', last_event_team: 'home', points_a: 1 }); await sleep(250)
  eq(shown.length, 0, 'no notice for the first state or a point')

  console.log('  — the full state: the numbers')
  push({ last_event_type: 'substitution', last_event_team: 'home', last_event_data: { playerIn: 7, playerOut: 12 }, subs_a: [sub(12, 7)] }); await sleep(300)
  ok(mock.currentLayout === 'kscw_message', `the announcement screen is up (${mock.currentLayout})`)
  eq([t('msg1'), t('msg2')], ['WECHSEL', '12 ⇄ 7'], 'WECHSEL / 12 ⇄ 7')
  eq(shown.at(-1)?.color, '37,99,235', 'in the colour of the team that substituted')
  const t0 = Date.now()
  ok(await backToScore(), 'then back to the score')
  const took = Date.now() - t0 + 300
  ok(took >= 2500 && took <= 4500, `after about 3 s (${took} ms)`)
  eq([t('team1'), t('sub1'), t('score1')], ['NORD', '1', '1'], 'the scoreboard with the substitution counted')

  console.log('  — a double substitution, one state')
  shown.length = 0
  push({ last_event_type: 'substitution', last_event_team: 'away', last_event_data: { playerIn: 9, playerOut: 4 }, subs_b: [sub(3, 11), sub(4, 9)] }); await sleep(300)
  eq(shown.map((x) => x.l2), ['3 ⇄ 11'], 'the first one first')
  await sleep(3000)
  eq(shown.map((x) => x.l2), ['3 ⇄ 11', '4 ⇄ 9'], 'then the second')
  ok(await backToScore(), 'then the score')
  eq(t('sub2'), '2', 'both counted')

  console.log('  — no libero, nothing during a countdown')
  shown.length = 0
  push({ last_event_type: 'libero_entry', last_event_team: 'home', last_event_data: { liberoIn: 1, playerOut: 7 } }); await sleep(600)
  eq(shown.length, 0, 'a libero replacement: no notice')
  push({ last_event_type: 'timeout', last_event_team: 'home', timeout_active: true, timeouts_a: [{}] }); await sleep(300)
  ok(!!(await get('/api/board')).countdown, 'a time-out countdown is up')
  push({ last_event_type: 'substitution', last_event_team: 'home', last_event_data: { playerIn: 3, playerOut: 8 }, subs_a: [sub(12, 7), sub(8, 3)] }); await sleep(500)
  eq(shown.length, 0, 'a substitution during it: no notice over the clock')
  push({ last_event_type: 'end_timeout', timeout_active: false }); await sleep(300)
  await post('/api/countdown/stop', { expired: false }); await sleep(300)
  ok(await backToScore(), 'the score after the time-out')

  console.log('  — the cloud without the PIN: no numbers')
  full = false
  shown.length = 0
  push({ last_event_type: 'point', last_event_team: 'away', points_b: 1 }); await sleep(200)
  push({ last_event_type: 'substitution', last_event_team: 'away' }); await sleep(300)
  eq([t('msg1'), t('msg2')], ['WECHSEL', 'SUED'], 'WECHSEL / the team\'s short name')
  ok(await backToScore(), 'back to the score')
  await post('/api/settings', { subNotice: 'numbers' })
  shown.length = 0
  push({ last_event_type: 'substitution', last_event_team: 'home' }); await sleep(600)
  eq(shown.length, 0, 'Settings "only with the numbers": nothing')
  full = true
  await post('/api/settings', { subNotice: 'numbers', language: 'en' })
  push({ last_event_type: 'substitution', last_event_team: 'home', last_event_data: { playerIn: 10, playerOut: 2 }, subs_a: [...(cur.subs_a || []), sub(2, 10)] }); await sleep(300)
  eq([t('msg1'), t('msg2')], ['SUBSTITUTION', '2 ⇄ 10'], '…with the numbers it shows, in English')
  ok(await backToScore(), 'back to the score')
  await post('/api/settings', { subNotice: 'off', language: 'de' })
  shown.length = 0
  push({ last_event_type: 'substitution', last_event_team: 'away', last_event_data: { playerIn: 5, playerOut: 6 }, subs_b: [...(cur.subs_b || []), sub(6, 5)] }); await sleep(600)
  eq(shown.length, 0, 'Settings off: nothing')
  ok(mock.currentLayout === MATCH, 'the scoreboard stays')
} finally {
  await app.close(); await mock.close(); fs.rmSync(stateDir, { recursive: true, force: true })
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  relay.closeAllConnections?.()
  await new Promise((r) => relay.close(r))
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — sub-notice-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
