// The change of ends: a full-panel announcement instead of a countdown.
//
// A court switch is not a break. It is an instruction to two teams and it lasts as long as they
// take to walk, so counting 3-2-1 at them spends the middle of the panel on a number nobody is
// waiting for — while the words themselves sat in the break screen's 12px `lbl` box. The whole
// panel now says COURT SWITCH in club gold, the ends are swapped behind it, and the board comes
// back on the scoreboard already the right way round.
//
// The interesting part is the line breaking. "COURT SWITCH" is 23px on one line and 28px over two,
// so stacking wins; "TIME OUT" is 38px on one line and would LOSE height by being stacked. The
// rule has to be "whichever is bigger", not "always split".

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toMessageSections, CLUB_GOLD } from '../src/volleyballMapper.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const valOf = (sections, name, attrib) => {
  const hit = sections.find((s) => s.name === name && s.value.attrib === attrib)
  return hit ? hit.value.value : undefined
}
const sizeOf = (sections, name) => Number(valOf(sections, name, 'fontsize'))

console.log('[1] a two-word phrase is stacked, and stacking makes it bigger')
{
  const s = toMessageSections('COURT SWITCH')
  eq(valOf(s, 'msg1', 'text'), 'COURT', 'first line')
  eq(valOf(s, 'msg2', 'text'), 'SWITCH', 'second line')
  eq(valOf(s, 'msgbig', 'text'), '', 'and the single-line slot is blanked, not left holding the last message')
  const single = Number(valOf(toMessageSections('X'), 'msgbig', 'fontsize'))
  ok(sizeOf(s, 'msg1') > 0 && sizeOf(s, 'msg1') === sizeOf(s, 'msg2'),
    `both lines share one size (${sizeOf(s, 'msg1')}) so the phrase reads as one thing`)
  ok(sizeOf(s, 'msg1') > 23,
    `stacked at ${sizeOf(s, 'msg1')}px — bigger than the 23px "COURT SWITCH" manages on one line`)
  ok(single > 0, 'a single line still has a size to compare against')
}

console.log('\n[2] a phrase that is bigger on ONE line is left alone')
{
  // The trap: a rule of "two words -> two lines" would shrink this from 38px to 28px.
  const s = toMessageSections('TIME OUT')
  eq(valOf(s, 'msg1', 'text'), '', 'not stacked')
  eq(valOf(s, 'msg2', 'text'), '', 'neither line')
  eq(valOf(s, 'msgbig', 'text'), 'TIME OUT', 'it goes on the single big line')
  ok(sizeOf(s, 'msgbig') > 28, `and keeps the height stacking would have cost it (${sizeOf(s, 'msgbig')}px)`)
}

console.log('\n[3] the rest of the shape')
{
  const one = toMessageSections('SWITCH')
  eq(valOf(one, 'msgbig', 'text'), 'SWITCH', 'a single word cannot be split')
  eq(valOf(one, 'msg1', 'text'), '', 'and the stacked slots are cleared')

  eq(valOf(toMessageSections('court switch'), 'msg1', 'text'), 'COURT',
    'lower case is upper-cased, like every other name on this panel')

  eq(valOf(one, 'msgbig', 'color'), CLUB_GOLD, 'club gold by default')
  eq(valOf(toMessageSections('SWITCH', { color: '1,2,3' }), 'msgbig', 'color'), '1,2,3', 'overridable')

  // Three words: split at whichever gap balances the two halves best.
  const three = toMessageSections('TECHNICAL TIME OUT')
  eq(valOf(three, 'msg1', 'text'), 'TECHNICAL', 'three words break at the most balanced gap')
  eq(valOf(three, 'msg2', 'text'), 'TIME OUT', 'and the rest goes below')

  // Nothing to say — every slot blank, so the screen cannot show a stale announcement.
  const empty = toMessageSections('')
  ok(['msgbig', 'msg1', 'msg2'].every((n) => valOf(empty, n, 'text') === ''), 'an empty message blanks every slot')
}

console.log('\n[4] end to end: confirm the switch, ends change, board announces then returns')
{
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-message-'))
  let app
  try {
    app = await startAppliance({
      stateDir,
      relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxHost: '127.0.0.1', ledboxPort: addr.port,
      ledboxLayout: 'volleyball_matchscore_02', ledboxAlias: 'test', ledboxApiVersion: 2,
      reconnectMs: 0, mock: false, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (p, body) => fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    await sleep(200)
    await post('/api/manual', {})
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW' } })
    await post('/api/action', { action: { type: 'team', side: 'right', short: 'VOLZ' } })
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    await sleep(200)
    eq(mock.text('team1'), 'KSCW', 'KSCW starts on the left')

    // Exactly what the console posts when the operator confirms "Switch sides?".
    const t0 = Date.now()
    const r = await post('/api/message', { text: 'COURT SWITCH', seconds: 1, swap: true })
    const answeredIn = Date.now() - t0
    eq(r.status, 200, 'POST /api/message -> 200')
    ok(answeredIn < 500,
      `answers in ${answeredIn}ms rather than holding the socket for the whole announcement — a scored point must not queue behind it`)
    const body = await r.json()
    // ManualSource models physical sides, so a swap moves the TEAMS rather than flipping a flag
    // (side_a stays 'left' — see getState).
    ok(body.state && body.state.team_a_short === 'VOLZ',
      'the ends were swapped, and the new state comes straight back so the tablet agrees immediately')

    await sleep(150)
    eq(mock.currentLayout, 'kscw_message', 'the panel is on the announcement screen')
    eq(mock.text('msg1'), 'COURT', 'saying COURT')
    eq(mock.text('msg2'), 'SWITCH', 'over SWITCH')
    eq(mock.color('msg1'), CLUB_GOLD, 'in club gold')

    // ...and it gets out of the way on its own.
    await sleep(1200)
    eq(mock.currentLayout, 'volleyball_matchscore_02', 'it returns to the scoreboard by itself')
    eq(mock.text('team1'), 'VOLZ', 'and repaints with the ends already swapped, not the old arrangement')
    eq(mock.text('msg1'), '', 'the announcement is wiped, so the next one cannot flash this text first')
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close()
    await mock.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
