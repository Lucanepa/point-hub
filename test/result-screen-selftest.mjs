// The end-of-match result screen, on the panel.
//
// The console summary and the board have to agree, and the board is the one the hall reads. Two
// things make this worth a test rather than a glance:
//
//   1. WINNER-FIRST ordering. The panel has no room to label which column is which, so the three
//      lines are only unambiguous if the winner's number is always on the left — including inside
//      every set of the history. Get that wrong and a 3-0 win reads as a 0-3 loss to anyone in the
//      hall, which is the single worst thing this screen could do.
//   2. It has to SURVIVE. The result is the last thing shown after a match, and the appliance is
//      still polling and still pushing state; a repaint would drop the scoreboard back over it.
//      Nothing sets the idle flag here, so the protection comes from the layout check inside
//      pushState — a property that is easy to break from a long way away.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toResultSections } from '../src/volleyballMapper.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const valOf = (sections, name, attrib = 'text') => {
  const hit = sections.find((s) => s.name === name && s.value.attrib === attrib)
  return hit ? hit.value.value : undefined
}

console.log('[1] the mapper places three fitted lines')
{
  const s = toResultSections({ winner: 'KSCW WINS', score: '3 - 0', history: '25-23  25-19  26-24', color: '255,200,50' })
  eq(valOf(s, 'winner'), 'KSCW WINS', 'winner line')
  eq(valOf(s, 'winner', 'color'), '255,200,50', 'painted in the winner colour')
  eq(valOf(s, 'sets'), '3 - 0', 'set score line')
  eq(valOf(s, 'history'), '25-23  25-19  26-24', 'set history line')
  ok(Number(valOf(s, 'winner', 'fontsize')) === 17, 'a short winner line keeps the full size')

  // A full five-set history is the longest string this screen shows in practice, and it fits at
  // the layout's own size (~165px of the 186 available) — worth pinning, because it means the
  // common case is never rendered small for no reason.
  const five = toResultSections({ winner: 'VOLZ WINS', score: '3 - 2', history: '25-23  19-25  26-24  22-25  15-13' })
  eq(valOf(five, 'history', 'fontsize'), '11', 'a realistic five-set history still fits at full size')

  // Past that, it must SHRINK rather than clip: dropping sets off the end would silently rewrite
  // the match. Three-digit scores are the realistic way to get here (a long deciding set).
  const huge = toResultSections({ winner: 'X', score: '3 - 2', history: '125-123  119-125  126-124  122-125  115-113' })
  ok(Number(valOf(huge, 'history', 'fontsize')) < 11, 'an over-long history shrinks instead of clipping')

  // A club that types its full name instead of a code is the same problem on the winner line.
  const longName = toResultSections({ winner: 'VOLLEY ZUERICH VOLLEYBALL WINS', score: '3 - 2', history: '' })
  ok(Number(valOf(longName, 'winner', 'fontsize')) < 17, 'and a long club name shrinks too')
}

console.log('\n[2] end to end: the finished match lands on the panel, winner first')
{
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-result-'))
  let app
  try {
    app = await startAppliance({
      stateDir,
      relayUrl: '', relayHttpUrl: 'http://127.0.0.1:1', matchId: '',
      ledboxHost: '127.0.0.1', ledboxPort: addr.port,
      ledboxLayout: 'volleyball_matchscore_02', ledboxAlias: 'test', ledboxApiVersion: 2,
      reconnectMs: 0, mock: false, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = async (p, body) => {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    }
    await sleep(200)
    await post('/api/manual', {})
    // B wins 3-1. Deliberately NOT the left/home side, because winner-first ordering is only
    // actually tested when the winner is the one that would otherwise print second.
    await post('/api/action', { action: { type: 'set-state', state: {
      side_a: 'left', team_a_short: 'KSCW', team_a_color: '#f5b301',
      team_b_short: 'VOLZ', team_b_color: '#2563eb',
      points_a: 22, points_b: 25, sets_won_a: 1, sets_won_b: 3,
      set_results: [{ a: 25, b: 23 }, { a: 19, b: 25 }, { a: 21, b: 25 }, { a: 22, b: 25 }],
    } } })
    await sleep(200)

    // Exactly what the console posts once "End match?" is confirmed.
    const r = await post('/api/result', {
      winner: 'VOLZ WINS', score: '3 - 1', history: '23-25  25-19  25-21  25-22', color: '#2563eb',
    })
    eq(r.status, 200, 'POST /api/result -> 200')
    ok(r.json && r.json.ok === true, 'and the board accepted it')
    await sleep(200)

    eq(mock.currentLayout, 'kscw_result', 'the panel switched to the result layout')
    eq(mock.text('winner'), 'VOLZ WINS', 'winner named on the panel')
    eq(mock.text('sets'), '3 - 1', "set score is the WINNER's first — not 1 - 3")
    eq(mock.text('history'), '23-25  25-19  25-21  25-22', 'every set, winner-first in each')
    eq(mock.color('winner'), '37,99,235', 'winner line in the winning team colour (hex converted)')

    console.log('\n[3] it survives the appliance still running')
    // A point arriving from anywhere (a poll, another tablet, a source) must not drop the
    // scoreboard back over the result.
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    await sleep(250)
    eq(mock.currentLayout, 'kscw_result', 'still on the result layout after a state push')
    eq(mock.text('winner'), 'VOLZ WINS', 'and the result is still the thing on the panel')

    console.log('\n[4] starting the next game takes the board back to the scoreboard')
    // The bug this guards: the old lift-the-screen check tested the idle flag only, and the result
    // screen does not use it — so "New game" left the finished match on the wall.
    const ng = await post('/api/game', { choice: 'new' })
    eq(ng.status, 200, 'POST /api/game {new} -> 200')
    await sleep(300)
    eq(mock.currentLayout, 'volleyball_matchscore_02', 'panel is back on the scoreboard')
    eq(mock.text('score1'), '0', 'and it has been repainted at 0-0, not left stale')
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
