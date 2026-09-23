// Each sport's idle FALLBACK (the names screen showIdle paints onto the match layout when the board
// has no kscw_idle/kscw_crest) must come from that sport's own mapper. The indoor one writes
// sub1/sub2/set1/… — sections the beach and basketball layouts do not have — and the board rejects
// the whole write on the first unknown one, so with the volleyball mapper wired in, the fallback
// never painted on those sports.

import { getSport } from '../src/sports.js'
import { toBeachIdleSections } from '../src/beachMapper.js'
import { toBasketballIdleSections } from '../src/basketballMapper.js'
import * as volley from '../src/volleyballMapper.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const names = (sections) => new Set(sections.map((s) => s.name || s.section || s.Name).filter(Boolean))
const state = { side_a: 'left', team_a_short: 'KSCW', team_b_short: 'AWAY', team_a_color: '#2563eb', team_b_color: '#ef4444' }

ok(getSport('volleyball').mapper.toIdleSections === volley.toIdleSections, 'volleyball keeps the indoor idle mapper')
ok(getSport('beach').mapper.toIdleSections === toBeachIdleSections, 'beach paints its idle fallback with toBeachIdleSections')
ok(getSport('basketball').mapper.toIdleSections === toBasketballIdleSections, 'basketball paints its idle fallback with toBasketballIdleSections')
for (const key of ['beach', 'basketball']) {
  const idle = names(getSport(key).mapper.toIdleSections(state))
  const match = names(getSport(key).mapper.toSections(state))
  const stray = [...idle].filter((n) => !match.has(n))
  ok(idle.size > 0 && stray.length === 0, `${key}: the idle fallback writes only sections its match layout has${stray.length ? ` (stray: ${stray.join(', ')})` : ''}`)
}
ok(getSport('beach').mapper.toBreakSections === volley.toBreakSections, 'the shared screens (break, result, …) stay the volleyball ones')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
