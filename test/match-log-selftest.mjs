// The match log — what actually happened, not just how it finished.
//
// The history store has always archived a match's final score and set list. What it recorded of
// the match ITSELF was one line per point that went UP, and nothing else: a correction, a timeout,
// a change of ends, a typed-in score were all dropped. So the archived log could not be reconciled
// with the scoresheet, and the entries most likely to be disputed afterwards — "the score was
// wrong after that timeout", "you took a point off us" — were precisely the ones missing.
//
// Two properties worth locking down:
//   1. Every operator action that moves the board is on the record, with its sign.
//   2. Every entry carries the score AND the set tally AT THAT MOMENT. Without them the log has to
//      be replayed from the top to answer the only question anyone brings to it.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/historyStore.js'
import { ManualSource } from '../src/manualSource.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const DATE = '2026-08-04 19:47'
// Drive a source for real rather than hand-building states: the log has to agree with the engine,
// and a fabricated state would let a wrong score pass unnoticed.
function run(actions) {
  const src = new ManualSource()
  const h = new HistoryStore()
  let sec = 0
  for (const a of actions) {
    src.apply(a)
    const clock = `19:47:${String(sec++).padStart(2, '0')}`
    h.record(a, src.getState(), src.lastEvent, DATE, clock)
  }
  return { h, src, events: h.current ? h.current.events : (h.matches.slice(-1)[0] || {}).events || [] }
}

console.log('[1] a correction is recorded, with its sign')
{
  const { events } = run([
    { type: 'team', side: 'left', short: 'KSCW' },
    { type: 'point', side: 'left', delta: 1 },
    { type: 'point', side: 'left', delta: 1 },
    { type: 'point', side: 'left', delta: -1 },   // the one the old log threw away
  ])
  const pts = events.filter((e) => e.type === 'point')
  eq(pts.length, 3, 'all three point actions are on the record, not just the two that went up')
  eq(pts[2].delta, -1, 'and the correction kept its sign')
  ok(pts[2].score[0] === 1, `with the score it left behind (${pts[2].score.join('–')})`)
}

console.log('\n[2] a typed score is not a +1')
{
  // Tapping the number and typing 24 is a different act from pressing +1 twenty-four times, and
  // the log should not claim otherwise.
  const { events } = run([
    { type: 'point', side: 'left', delta: 1 },
    { type: 'point', side: 'right', value: 24 },
  ])
  const typed = events.filter((e) => e.type === 'point').slice(-1)[0]
  eq(typed.value, 24, 'a typed value is recorded as a value')
  ok(typed.delta === undefined, 'and not disguised as a delta')
  ok(typed.score[1] === 24, 'the resulting score is on it too')
}

console.log('\n[3] everything else the operator did')
{
  const { events } = run([
    { type: 'point', side: 'left', delta: 1 },
    { type: 'timeout', side: 'right', delta: 1 },
    { type: 'sub', side: 'left', delta: 1 },
    { type: 'sub', side: 'left', delta: -1 },
    { type: 'serve', side: 'right' },
    { type: 'swap' },
  ])
  const types = events.map((e) => e.type)
  for (const want of ['timeout', 'sub', 'serve', 'swap']) ok(types.includes(want), `${want} is logged`)
  const undone = events.filter((e) => e.type === 'sub')
  eq(undone.length, 2, 'both the substitution and its undo')
  eq(undone[1].delta, -1, 'the undo carrying the negative sign')
  eq(events.find((e) => e.type === 'timeout').side, 'b', 'and the side that called it')
}

console.log('\n[4] every entry knows the score and the sets at that moment')
{
  const { events } = run([
    { type: 'point', side: 'left', delta: 1 },
    { type: 'point', side: 'right', delta: 1 },
    { type: 'timeout', side: 'left', delta: 1 },
  ])
  ok(events.every((e) => Array.isArray(e.score) && e.score.length === 2), 'every entry carries a score')
  ok(events.every((e) => Array.isArray(e.sets) && e.sets.length === 2), 'and the set tally')
  const to = events.find((e) => e.type === 'timeout')
  eq(to.score.join('–'), '1–1', 'the timeout knows it was called at 1–1')
  ok(/^\d\d:\d\d:\d\d$/.test(to.t), `and is timed to the second (${to.t}) — a rally, its undo and a timeout all fit in one minute`)
}

console.log('\n[5] the turning points still land, and the match still archives')
{
  const acts = [{ type: 'team', side: 'left', short: 'KSCW' }, { type: 'team', side: 'right', short: 'VOLZ' }]
  // Three sets straight, 25 points each, no deuces. `next-set` between them is what the interval
  // countdown sends — the set does not roll over on its own. It also CHANGES ENDS, so the winning
  // team is on the other half of the board each set and the points have to follow it; scoring on
  // the same physical side throughout would hand a set to each team in turn.
  let side = 'left'
  for (let set = 0; set < 3; set++) {
    for (let i = 0; i < 25; i++) acts.push({ type: 'point', side, delta: 1 })
    if (set < 2) { acts.push({ type: 'next-set' }); side = side === 'left' ? 'right' : 'left' }
  }
  const { h } = run(acts)
  const m = h.matches.slice(-1)[0]
  ok(m, 'the finished match was archived')
  eq(m.sets_a, 3, 'with the right set score')
  eq(m.team_a, 'KSCW', 'and the team names')
  const types = m.events.map((e) => e.type)
  eq(types.filter((t) => t === 'set-end').length, 3, 'three set ends on the record')
  ok(types.includes('match-end'), 'and the match end')
  // The log records by TEAM, not by physical side (historyStore._view undoes the change of ends),
  // so a team that wins every set reads as the left-hand number in every set end — including the
  // ones it won standing on the right.
  const setEnds = m.events.filter((e) => e.type === 'set-end')
  eq(setEnds[0].score.join('–'), '25–0', "a set end carries THAT SET's final score, not the running one")
  eq(setEnds[1].score.join('–'), '25–0', 'and stays with the team that won it after the ends change')
  ok(m.events.indexOf(setEnds[2]) < m.events.findIndex((e) => e.type === 'match-end'),
    'the deciding set is closed BEFORE the match is — the log does not end mid-set')
}

console.log('\n[6] end to end: the log comes back out of /api/history')
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-matchlog-'))
  let app
  try {
    app = await startAppliance({
      stateDir,
      relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
      mock: true, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (p, body) => fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    await sleep(200)
    await post('/api/manual', {})
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW' } })
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    await post('/api/action', { action: { type: 'point', side: 'left', delta: -1 } })
    await post('/api/action', { action: { type: 'timeout', side: 'left', delta: 1 } })
    // Finish it so the buffer is archived and reachable through the API. Following the winning
    // team across the change of ends, as in [5].
    let side = 'right'
    for (let set = 0; set < 3; set++) {
      for (let i = 0; i < 25; i++) await post('/api/action', { action: { type: 'point', side, delta: 1 } })
      if (set < 2) {
        await post('/api/action', { action: { type: 'next-set' } })
        side = side === 'left' ? 'right' : 'left'
      }
    }
    await sleep(200)

    const hist = await (await fetch(base + '/api/history')).json()
    const m = (hist.matches || [])[0]
    ok(m, 'the match is in /api/history')
    const types = (m.events || []).map((e) => e.type)
    ok(types.includes('timeout'), 'the timeout survived the round trip to disk and back')
    ok((m.events || []).some((e) => e.type === 'point' && e.delta === -1), 'and so did the correction')
    ok((m.events || []).every((e) => e.t), 'every entry has a timestamp')
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
