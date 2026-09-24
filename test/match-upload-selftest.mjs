// The match-log upload to wiedisync (live_match_logs) — store-and-forward, idempotent by key.
//
// What must hold:
//   1. A finished match carries what the stats need: its own id, the fixture, the sport, and on
//      every entry the serving team (`srv`) and a monotonic elapsed time (`el`).
//   2. Nothing leaves the board while the match point can still be taken back.
//   3. An upload that fails stays queued and goes on the next sweep; a duplicate answer (the first
//      try landed, its answer was lost) counts as done — the match is never sent twice for real.
//   4. The "Connect to live scoring" toggle off means nothing is sent.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/historyStore.js'
import { ManualSource } from '../src/manualSource.js'
import { createMatchUpload, toLogRow } from '../src/matchUpload.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const DATE = '2026-09-24 19:47'
let monoNow = 1000
const mono = () => monoNow

// A best-of-five that A wins 3-0, 25-0 each set, driven through the real engine. Every rally is
// three seconds on the monotonic clock.
function playMatch(h, { gameId = null } = {}) {
  const src = new ManualSource()
  let sec = 0
  const step = (a) => {
    src.apply(a)
    monoNow += 3000
    h.record(a, src.getState(), src.lastEvent, DATE, `19:${String(47 + Math.floor(sec / 60)).padStart(2, '0')}:${String(sec++ % 60).padStart(2, '0')}`)
    return src.lastEvent
  }
  src.apply({ type: 'reset' })
  h.record({ type: 'reset' }, src.getState(), null, DATE, '19:47:00')
  h.setGame(gameId)
  step({ type: 'team', side: 'left', short: 'KSCW' })
  step({ type: 'team', side: 'right', short: 'OPP' })
  step({ type: 'serve', side: 'right' })
  for (let set = 0; set < 3; set++) {
    let ev = null
    while (ev !== 'set-end' && ev !== 'match-end') {
      // After a change of ends KSCW stands on the other side; score for whoever is KSCW.
      const s = src.getState()
      const kscwSide = (s.team_a_short === 'KSCW') ? 'left' : 'right'
      ev = step({ type: 'point', side: kscwSide, delta: 1 })
    }
    if (ev === 'match-end') break
    step({ type: 'next-set' })
  }
  return src
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'match-upload-'))

console.log('[1] a finished match carries id, fixture, sport, serve and elapsed time')
const h = new HistoryStore({ file: path.join(tmp, 'history.json'), sport: () => 'volleyball', mono })
playMatch(h, { gameId: 4711 })
const m = h.matches.slice(-1)[0]
ok(m && typeof m.id === 'string' && m.id.length >= 32, `the match has its own id (${m && m.id})`)
eq(m.game_id, 4711, 'filed against the fixture it was set up for')
eq(m.sport, 'volleyball', 'and the sport')
eq([m.sets_a, m.sets_b], [3, 0], 'the result is KSCW 3-0')
const pts = m.events.filter((e) => e.type === 'point')
ok(pts.length === 75, `every rally is on the log (${pts.length})`)
ok(pts.every((e) => e.srv === 'a' || e.srv === 'b'), 'every point says who serves next')
eq(pts[0].srv, 'a', 'rally scoring: the team that won the rally serves the next one')
const serve = m.events.find((e) => e.type === 'serve')
eq(serve && serve.srv, 'b', 'the opening serve was the opponent’s — the first point is a sideout')
ok(pts.every((e, i) => i === 0 || e.el > pts[i - 1].el), 'el grows with every rally')
eq(pts[1].el - pts[0].el, 3, 'and measures the rally on the monotonic clock (3 s)')

const row = toLogRow(m, 'kscw')
eq([row.channel, row.match_key, row.game_id, row.sport, row.event_count], ['kscw', m.id, 4711, 'volleyball', m.events.length], 'the upload row')

console.log('\n[2] a hand-started match after a scheduled one is not filed against the fixture')
{
  const h2 = new HistoryStore({ sport: () => 'volleyball', mono })
  h2.setGame(99)
  const src = new ManualSource()
  src.apply({ type: 'reset' })
  h2.record({ type: 'reset' }, src.getState(), null, DATE, '19:00:00') // the operator pressed New
  src.apply({ type: 'point', side: 'left', delta: 1 })
  h2.record({ type: 'point', side: 'left', delta: 1 }, src.getState(), src.lastEvent, DATE, '19:00:01')
  eq(h2.current.game_id, undefined, 'the reset cleared the fixture')
}

console.log('\n[3] basketball logs no serving team')
{
  const hb = new HistoryStore({ sport: () => 'basketball', mono })
  const src = new ManualSource()
  src.apply({ type: 'point', side: 'left', delta: 1 })
  hb.record({ type: 'point', side: 'left', delta: 1 }, src.getState(), src.lastEvent, DATE, '19:00:01')
  eq(hb.current.events[0].srv, undefined, 'its arrow is possession, not a serve')
}

// A stand-in for Directus: records POSTs, enforces UNIQUE (channel, match_key), and can be told
// to fail or to "lose" its answer after committing.
const rows = new Map()
let mode = 'ok' // 'ok' | 'down' | 'lose-answer'
let posts = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    posts++
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(403); return res.end() }
    if (mode === 'down') { res.writeHead(503); return res.end() }
    const r = JSON.parse(body)
    const key = `${r.channel}|${r.match_key}`
    if (rows.has(key)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ errors: [{ message: 'unique', extensions: { code: 'RECORD_NOT_UNIQUE' } }] }))
    }
    rows.set(key, r)
    if (mode === 'lose-answer') { mode = 'ok'; return req.socket.destroy() }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: { id: 'x' } }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`

console.log('\n[4] nothing leaves while the match point can still be taken back')
let live = true
const upFile = path.join(tmp, 'match-uploads.json')
const up = createMatchUpload({ url, token: 'tok', isLive: () => live, file: upFile, graceMs: 60_000, finishDelayMs: 1e9, intervalMs: 1e9 })
up.attach(h)
await up.sweep()
eq(posts, 0, 'no POST inside the grace window')
eq(up.pending(), 0, 'and the match is not even queued yet')

console.log('\n[5] toggle off → nothing is sent')
monoNow += 61_000
live = false
await up.sweep()
eq(posts, 0, 'the operator has not connected the board: no POST')

console.log('\n[6] a failed upload stays queued, and goes on the next sweep')
live = true
mode = 'down'
await up.sweep()
eq([posts, rows.size, up.pending()], [1, 0, 1], 'Directus down: tried once, nothing stored, still queued')
mode = 'ok'
await up.sweep()
eq([rows.size, up.pending()], [1, 0], 'the next sweep uploads it')
const stored = rows.get(`kscw|${m.id}`)
eq(stored && stored.game_id, 4711, 'with the fixture')
ok(stored && stored.events.length === m.events.length, 'and the whole play-by-play')
ok(JSON.parse(fs.readFileSync(upFile, 'utf8')).keys.includes(m.id), 'remembered across a restart')

console.log('\n[7] a lost answer is resent, and the duplicate reads as done')
playMatch(h)
const m2 = h.matches.slice(-1)[0]
monoNow += 61_000
mode = 'lose-answer'
const before = posts
await up.sweep()
eq(up.pending(), 1, 'the answer was lost: still queued, although the row landed')
await up.sweep()
eq([up.pending(), rows.size, posts - before], [0, 2, 2], 'the resend is refused as a duplicate and counted done — one row, not two')
ok(rows.has(`kscw|${m2.id}`), 'the second match is stored once')

console.log('\n[8] after a restart the list survives, and nothing is sent again')
{
  const h3 = new HistoryStore({ file: path.join(tmp, 'history.json'), sport: () => 'volleyball', mono })
  const up3 = createMatchUpload({ url, token: 'tok', file: upFile, finishDelayMs: 1e9, intervalMs: 1e9 })
  up3.attach(h3)
  const p = posts
  await up3.sweep()
  eq([posts - p, up3.pending()], [0, 0], 'both matches were already uploaded')
  up3.stop()
}

console.log('\n[9] a match from before the id existed is never sent')
{
  const h4 = new HistoryStore({ sport: () => 'volleyball', mono })
  h4.matches.push({ date: DATE, team_a: 'A', team_b: 'B', sets_a: 3, sets_b: 1, sets: [], events: [] })
  const up4 = createMatchUpload({ url, token: 'tok', finishDelayMs: 1e9, intervalMs: 1e9 })
  up4.attach(h4)
  eq(up4.pending(), 0, 'no key to make a resend safe → stays on the board')
  up4.stop()
}

up.stop()
server.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
