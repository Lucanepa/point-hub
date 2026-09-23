// The set-closed guard must never lock the set winner out of scoring.
//
// The guard refuses the winner's + while the board still shows the set's closing score, to stop a
// double-tap from pushing it to 26-10. Refusing on the `setClosed` flag alone went wrong after a
// correction: 25-23 (closed), then the loser's + to 25-24, then the winner's − to 24-24. The set
// stayed counted and every later + from the winner came back 'set-closed', so that team could not
// score until someone used the set-pill trash. Covered for indoor (ManualSource) and beach.

import { ManualSource } from '../src/manualSource.js'
import { BeachSource } from '../src/beachSource.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

function run(name, Source, closeAt) {
  console.log(name)
  const s = new Source()
  const tap = (side, delta) => { s.apply({ type: 'point', side, delta }); return s.lastEvent }
  s.apply({ type: 'point', side: 'left', value: closeAt - 2 })
  s.apply({ type: 'point', side: 'right', value: closeAt - 2 })
  tap('left', 1)
  ok(tap('left', 1) === 'set-end', `${closeAt}-${closeAt - 2} ends the set`)
  ok(tap('left', 1) === 'set-closed', 'the winner\'s second + on the closing score is refused')
  // correction: the loser had that rally
  ok(tap('right', 1) !== 'set-closed' && s.getState().points_b === closeAt - 1, 'the loser\'s + stays open')
  tap('right', -1)
  ok(tap('left', 1) === 'set-closed', 'back on the closing score, the winner\'s + is refused again')
  tap('right', 1) // 25-24
  tap('left', -1) // 24-24
  let st = s.getState()
  ok(st.points_a === closeAt - 1 && st.points_b === closeAt - 1, 'winner − after a loser + gives a tie')
  ok(st.sets_won_a === 0 && st.set_results.length === 0, 'and the set is no longer awarded at a tie')
  ok(tap('left', 1) !== 'set-closed', 'the winner can score again')
  ok(s.getState().points_a === closeAt, 'the winner\'s + counted')
  ok(tap('left', 1) === 'set-end', 'and a real win closes the set again')
  st = s.getState()
  ok(st.sets_won_a === 1 && st.set_results.length === 1, 'exactly one set awarded')

  // Loser pushed past the winner while correcting (25-27): the loser's − must not pop a set the
  // loser never had.
  const t = new Source()
  t.apply({ type: 'point', side: 'left', value: closeAt - 2 })
  t.apply({ type: 'point', side: 'right', value: closeAt - 2 })
  t.apply({ type: 'point', side: 'left', delta: 1 })
  t.apply({ type: 'point', side: 'left', delta: 1 })
  for (let i = 0; i < 4; i++) t.apply({ type: 'point', side: 'right', delta: 1 })
  t.apply({ type: 'point', side: 'right', delta: -1 })
  const u = t.getState()
  ok(u.sets_won_a === 1 && u.sets_won_b === 0 && u.set_results.length === 1, 'loser − past the winner keeps the set with its winner')
}

run('Indoor', ManualSource, 25)
run('Beach', BeachSource, 21)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
