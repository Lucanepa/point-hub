// The match history, told by TEAM — across changes of ends, basketball games and taken-back match
// points — and the sources' set-state surviving a malformed set_results.
//
// Four things the history got wrong, each of which only shows up in a real match:
//   1. Every source reports a=left, so after a change of ends "a" is the other team. The log took
//      a/b at face value: a 3-0 won by one team read as 50 points for it and 25 for the side that
//      never scored, and the score column flipped at every set break.
//   2. Basketball ends on 'game-end', which the history never listened for — no basketball game
//      was ever archived, and the buffer ran on into the next game.
//   3. Taking back a mis-tapped match point left the half-match archived, and the real match point
//      archived the tail as a second match.
//   4. (sources) A set-state with a null in set_results threw halfway through loading, leaving the
//      source with the new points and the old set strip.

import { HistoryStore } from '../src/historyStore.js'
import { ManualSource } from '../src/manualSource.js'
import { BeachSource } from '../src/beachSource.js'
import { BasketballSource } from '../src/basketballSource.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const DATE = '2026-09-23 19:00'
// Drive a real source into a real HistoryStore, exactly as controlServer does: apply, then record
// the resulting state and the source's lastEvent.
function rig(Source) {
  const src = new Source()
  const h = new HistoryStore()
  const act = (a) => { src.apply(a); h.record(a, src.getState(), src.lastEvent, DATE, '19:00:00'); return src.lastEvent }
  return { src, h, act }
}
const last = (h) => h.matches.slice(-1)[0]

console.log('[1] indoor: points stay with the team that scored them across changes of ends')
{
  const { h, act } = rig(ManualSource)
  act({ type: 'team', side: 'left', short: 'AAA' })
  act({ type: 'team', side: 'right', short: 'BBB' })
  // AAA wins 25-0 three times; next-set swaps ends after sets 1 and 2, so AAA scores from the left,
  // then the right, then the left again.
  let side = 'left'
  for (let set = 0; set < 3; set++) {
    for (let i = 0; i < 25; i++) act({ type: 'point', side, delta: 1 })
    if (set < 2) { act({ type: 'next-set' }); side = side === 'left' ? 'right' : 'left' }
  }
  const m = last(h)
  ok(m, 'the match is archived')
  eq(m.team_a, 'AAA', 'team_a is the team that started on the left')
  eq(`${m.sets_a}-${m.sets_b}`, '3-0', 'and AAA is credited with the 3-0')
  const pts = m.events.filter((e) => e.type === 'point')
  eq(pts.filter((e) => e.side === 'a').length, 75, 'all 75 points are credited to AAA')
  eq(pts.filter((e) => e.side === 'b').length, 0, 'none to BBB, who scored none')
  ok(pts.every((e, i) => e.score[1] === 0 && e.score[0] === (i % 25) + 1), 'the score column never flips orientation')
  eq(m.events.filter((e) => e.type === 'set-end').map((e) => e.score.join('-')).join(' '), '25-0 25-0 25-0',
    'every set end reads AAA first')
  eq(m.sets.map((s) => `${s.a}-${s.b}`).join(' '), '25-0 25-0 25-0', 'and so does the archived set list')
}

console.log('\n[2] indoor: the explicit court switch in the decider, and a typed name after it')
{
  const { src, h, act } = rig(ManualSource)
  src.apply({ type: 'set-state', state: { side_a: 'left', team_a_short: 'AAA', team_b_short: 'BBB', sets_won_a: 2, sets_won_b: 2 } })
  for (let i = 0; i < 8; i++) act({ type: 'point', side: 'right', delta: 1 }) // BBB to 8 -> switch-due
  act({ type: 'swap' })
  act({ type: 'team', side: 'left', short: 'BBX' }) // BBB, now on the LEFT, renamed
  act({ type: 'timeout', side: 'left', delta: 1 })
  const ev = h.current.events
  const to = ev.find((e) => e.type === 'timeout')
  eq(to.side, 'b', 'a timeout called from the left after the swap belongs to team b')
  eq(to.score.join('-'), '0-8', 'and its score is still read team-a-first')
  eq(h.current.team_b, 'BBX', 'the rename lands on team b, not team a')
  eq(h.current.team_a, 'AAA', 'team a keeps its name')
}

console.log('\n[3] beach: the 7-point court switches do not scramble the log')
{
  const { h, act } = rig(BeachSource)
  act({ type: 'team', side: 'left', short: 'AAA' })
  act({ type: 'team', side: 'right', short: 'BBB' })
  let side = 'left'
  for (let set = 0; set < 2; set++) {
    for (let i = 0; i < 21; i++) {
      const e = act({ type: 'point', side, delta: 1 })
      if (e === 'switch-due' || e === 'tech-timeout') { act({ type: 'swap' }); side = side === 'left' ? 'right' : 'left' }
    }
    if (set < 1) { act({ type: 'next-set' }); side = side === 'left' ? 'right' : 'left' }
  }
  const m = last(h)
  ok(m, 'the beach match is archived')
  eq(`${m.team_a} ${m.sets_a}-${m.sets_b} ${m.team_b}`, 'AAA 2-0 BBB', 'AAA credited with the 2-0')
  eq(m.events.filter((e) => e.type === 'point' && e.side === 'b').length, 0, 'no point credited to BBB')
}

console.log('\n[4] basketball: a finished game is archived')
{
  const { h, act } = rig(BasketballSource)
  act({ type: 'team', side: 'left', short: 'HOM' })
  act({ type: 'team', side: 'right', short: 'GST' })
  let home = 'left', guest = 'right'
  for (let q = 0; q < 4; q++) {
    act({ type: 'point', side: home, delta: 2 })
    act({ type: 'point', side: guest, delta: 3 })
    act({ type: 'point', side: home, delta: 2 })
    if (q === 1) { act({ type: 'swap' }); [home, guest] = [guest, home] } // half-time change of baskets
    act({ type: 'next-set' })
  }
  const m = last(h)
  ok(m, 'the game reached the History tab')
  ok(h.current === null, 'and the buffer is closed, not running on into the next game')
  eq(`${m.team_a} ${m.sets_a}-${m.sets_b} ${m.team_b}`, 'HOM 16-12 GST', 'its headline is the final score, by team')
  eq(m.events.filter((e) => e.type === 'period-end').map((e) => e.period).join(','), '1,2,3,4', 'every period end is on the record')
  eq(m.events.slice(-1)[0].type, 'match-end', 'and it ends with the match end')
  eq(m.sets.map((s) => `${s.a}-${s.b}`).join(' '), '4-3 8-6 12-9 16-12', 'the line score is read by team across the swap')
}

console.log('\n[5] basketball: taking back the game-end reopens the game')
{
  const { h, act } = rig(BasketballSource)
  act({ type: 'point', side: 'left', delta: 2 })
  for (let q = 0; q < 4; q++) act({ type: 'next-set' })
  eq(h.matches.length, 1, 'the game is archived')
  act({ type: 'remove-set' }) // "that wasn't the buzzer"
  eq(h.matches.length, 0, 'removing the final period un-archives it')
  ok(h.current && h.current.events.length > 0, 'and the play-by-play is back in the buffer')
  act({ type: 'point', side: 'right', delta: 2 })
  act({ type: 'next-set' }) // tied -> overtime
  act({ type: 'point', side: 'right', delta: 1 })
  act({ type: 'next-set' }) // decided in OT1
  eq(h.matches.length, 1, 'the real end archives ONE game')
  const pts = last(h).events.filter((e) => e.type === 'point')
  eq(pts.length, 3, 'holding all of it, before and after the undo')
}

console.log('\n[6] indoor: taking back a mis-tapped match point')
{
  const { src, h, act } = rig(ManualSource)
  src.apply({ type: 'set-state', state: { side_a: 'left', team_a_short: 'AAA', team_b_short: 'BBB', sets_won_a: 2, sets_won_b: 2 } })
  for (let i = 0; i < 13; i++) { act({ type: 'point', side: 'left', delta: 1 }); act({ type: 'point', side: 'right', delta: 1 }) }
  act({ type: 'point', side: 'left', delta: 1 }) // 14-13
  eq(act({ type: 'point', side: 'left', delta: 1 }), 'match-end', 'the mis-tap ends the match at 15-13')
  eq(h.matches.length, 1, 'and archives it')
  act({ type: 'point', side: 'left', delta: -1 }) // the correction
  eq(h.matches.length, 0, 'the correction takes the match back out of History')
  ok(h.current && !h.current.events.some((e) => e.type === 'match-end'), 'the buffer is back, without the "Match over"')
  act({ type: 'point', side: 'right', delta: 1 }) // 14-14
  act({ type: 'point', side: 'left', delta: 1 })
  act({ type: 'point', side: 'left', delta: 1 }) // 16-14, the real one
  eq(h.matches.length, 1, 'the real match point archives ONE match, not a second one')
  const m = last(h)
  eq(`${m.sets_a}-${m.sets_b}`, '3-2', 'with the right result')
  eq(m.events.filter((e) => e.type === 'point').length, 32, 'and every rally of the set, the undo included')
  // A correction on the LOSING side does not un-decide anything, so it must not reopen the match.
  act({ type: 'point', side: 'right', delta: -1 })
  eq(h.matches.length, 1, 'a later correction that leaves the match decided does not reopen it')
}

console.log('\n[6b] beach: the same undo in the deciding set')
{
  // The engine half of [6]: once the deciding set is awarded the tally reads 2-1, which is not a
  // deciding set any more — so "−" judged 14-13 against the normal target, never saw the set as
  // won, and could not take it back. Both volleyball sources judge it by the set's own rules now.
  const { src, h, act } = rig(BeachSource)
  src.apply({ type: 'set-state', state: { side_a: 'left', sets_won_a: 1, sets_won_b: 1 } })
  for (let i = 0; i < 13; i++) { act({ type: 'point', side: 'left', delta: 1 }); act({ type: 'point', side: 'right', delta: 1 }) }
  act({ type: 'point', side: 'left', delta: 1 })
  eq(act({ type: 'point', side: 'left', delta: 1 }), 'match-end', 'the mis-tap ends the beach match at 15-13')
  act({ type: 'point', side: 'left', delta: -1 })
  const st = src.getState()
  eq(`${st.sets_won_a}-${st.sets_won_b} ${st.points_a}-${st.points_b}`, '1-1 14-13', 'the "−" takes the deciding set back')
  eq(h.matches.length, 0, 'and the match back out of History')
}

console.log('\n[7] a reset closes the door on reopening')
{
  const { src, h, act } = rig(ManualSource)
  src.apply({ type: 'set-state', state: { side_a: 'left', sets_won_a: 2 } })
  for (let i = 0; i < 25; i++) act({ type: 'point', side: 'left', delta: 1 })
  eq(h.matches.length, 1, 'match archived')
  act({ type: 'reset' })
  act({ type: 'point', side: 'left', delta: -1 })
  eq(h.matches.length, 1, 'after a new match is started, the old one stays archived')
}

console.log('\n[8] ends_swapped round-trips through set-state (the resume slot)')
for (const Source of [ManualSource, BeachSource, BasketballSource]) {
  const a = new Source()
  eq(a.getState().ends_swapped, false, `${Source.name}: a fresh board is not swapped`)
  a.apply({ type: 'swap' })
  eq(a.getState().ends_swapped, true, `${Source.name}: a swap flips it`)
  const b = new Source()
  b.apply({ type: 'set-state', state: a.getState() })
  eq(b.getState().ends_swapped, true, `${Source.name}: and a resume restores it`)
  b.apply({ type: 'set-state', state: { side_a: 'left', points_a: 3 } })
  eq(b.getState().ends_swapped, true, `${Source.name}: a set-state that does not say keeps it`)
  b.apply({ type: 'reset' })
  eq(b.getState().ends_swapped, false, `${Source.name}: a reset clears it`)
}

console.log('\n[9] a null in set_results cannot half-load a source')
for (const Source of [ManualSource, BeachSource, BasketballSource]) {
  const s = new Source()
  let emitted = 0
  s.on('state', () => emitted++)
  let threw = false
  try {
    s.apply({ type: 'set-state', state: { side_a: 'left', points_a: 7, set_results: [null, { a: 25, b: 20 }, 'x', 5] } })
  } catch { threw = true }
  ok(!threw, `${Source.name}: set-state with junk entries does not throw`)
  const st = s.getState()
  eq(st.points_a, 7, `${Source.name}: the points are loaded`)
  eq(JSON.stringify(st.set_results), '[{"a":25,"b":20}]', `${Source.name}: and only the real result is kept`)
  eq(emitted, 1, `${Source.name}: and the state event still fires`)
}

console.log('[10] set durations reach the saved match and its set-end lines, by team')
{
  let t = 0
  const src = new ManualSource({ now: () => t })
  const h = new HistoryStore()
  const act = (a) => { src.apply(a); h.record(a, src.getState(), src.lastEvent, DATE, '19:00:00') }
  act({ type: 'team', side: 'left', short: 'AAA' })
  act({ type: 'team', side: 'right', short: 'BBB' })
  const secs = [1500, 1320, 1410]
  for (let set = 0; set < 3; set++) {
    const side = src.getState().ends_swapped ? 'right' : 'left' // AAA, wherever it stands
    act({ type: 'point', side, delta: 1 }); t += secs[set] * 1000
    for (let i = 1; i < 25; i++) act({ type: 'point', side, delta: 1 })
    if (set < 2) act({ type: 'next-set' })
  }
  const m = last(h)
  eq(m && m.sets.map((r) => `${r.a}-${r.b}/${r.dur}`).join(','), '25-0/1500,25-0/1320,25-0/1410', 'every set keeps its dur, credited to the team that won it')
  eq(m && m.events.filter((e) => e.type === 'set-end').map((e) => e.dur).join(','), '1500,1320,1410', 'the set-end lines carry it too')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
