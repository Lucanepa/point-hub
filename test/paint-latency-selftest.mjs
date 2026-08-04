// How long the panel holds a bare layout before its data arrives.
//
// The board acks SetLayout before the new layout's sections exist, so a write sent immediately
// after can be refused with "section not found (6)". The old answer was to sleep `layoutSettleMs`
// after EVERY switch. What the hall saw during that sleep was the incoming layout holding whatever
// was last written to it:
//
//   * entering a timeout — the bare break screen, then the score dropping in. Reported by the
//     operator as "first it shows the layout, then it loads the score". pushCountdown made it
//     twice as bad by sleeping a SECOND time on top of setLayoutIfNeeded's own sleep: the settle
//     had been moved into that function and this copy was never removed.
//   * at match end — the PREVIOUS match's winner, announced as this one's. Straight off the
//     board's log for 2026-08-04:
//         19:52:11.613  layout → kscw_result
//         19:52:12.062  result screen: KSCW H3 WINS 3 - 2
//     449 ms of the wrong team's name in front of a full hall. "match end there's a split second
//     the wrong team shown".
//
// So the delay became conditional: write at once, settle and retry ONLY if the board actually
// refuses. This file measures the gap the way the hall experiences it — from the SetLayout landing
// on the device to the first SetSections landing on it — and proves the retry still works when the
// board really is not ready.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// Generous: a local round trip is sub-millisecond, and the value being ruled out is a 400ms or
// 800ms sleep. Anything in between is neither, and would mean something else is blocking.
const MAX_GAP_MS = 150

console.log('[1] a retry replaces the fixed settle — and only fires when the board refuses')
{
  // sendSections in isolation: the first write is refused the way the device refuses one, and the
  // second must succeed without the caller ever seeing an error.
  const c = new LedboxClient({ reconnectMs: 0, layoutSettleMs: 30 })
  let calls = 0
  c.send = async () => {
    calls++
    if (calls === 1) throw new Error('SetSections failed: section team1 not found (6)')
    return true
  }
  const t0 = Date.now()
  const res = await c.sendSections([{ name: 'team1', value: { attrib: 'text', value: 'X' } }])
  ok(res === true, 'a refused write is retried and succeeds')
  ok(calls === 2, `exactly one retry (${calls} writes)`)
  ok(Date.now() - t0 >= 25, 'and it waited the settle before retrying, rather than hammering')

  // The happy path must not pay for the unhappy one.
  const c2 = new LedboxClient({ reconnectMs: 0, layoutSettleMs: 400 })
  let n = 0
  c2.send = async () => { n++; return true }
  const t1 = Date.now()
  await c2.sendSections([])
  ok(n === 1 && Date.now() - t1 < 50, 'a write the board accepts costs one round trip and no sleep')

  // Any OTHER failure still propagates — the retry must not swallow real faults.
  const c3 = new LedboxClient({ reconnectMs: 0, layoutSettleMs: 10 })
  c3.send = async () => { throw new Error('socket closed') }
  let threw = false
  await c3.sendSections([]).catch(() => { threw = true })
  ok(threw, 'an unrelated failure is not retried into silence')
}

console.log('\n[2] end to end: the gap between the layout and its content')
{
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-latency-'))

  // Timestamp every command as the DEVICE sees it, which is the only clock that matches what a
  // person in the hall sees.
  const trace = []
  mock.on('command', (msg) => trace.push({ cmd: msg.cmd, at: Date.now(), value: msg.value }))
  const gapAfterLayout = (layout) => {
    const i = trace.findIndex((e) => e.cmd === 'SetLayout' && (e.value === layout || e.name === layout))
    if (i < 0) return null
    const paint = trace.slice(i + 1).find((e) => e.cmd === 'SetSections')
    return paint ? paint.at - trace[i].at : null
  }

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
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    await sleep(200)

    // --- the match-end screen, the one the board log caught at 449ms ---
    trace.length = 0
    await post('/api/result', { winner: 'KSCW WINS', score: '3 - 0', history: '25-23' })
    await sleep(300)
    const resultGap = gapAfterLayout('kscw_result')
    ok(resultGap !== null, 'the result screen switched layout and painted')
    ok(resultGap !== null && resultGap < MAX_GAP_MS,
      `result screen is populated ${resultGap}ms after the switch (was ~449ms on the board, budget ${MAX_GAP_MS}ms)`)

    // --- the timeout screen, which used to pay the settle TWICE ---
    // The mock deliberately does not carry kscw_break, so this exercises the vendor countdown
    // layout. The double sleep was in the shared path, so it is measured either way.
    trace.length = 0
    await post('/api/countdown', { seconds: 30, label: 'TIME OUT', content: 'full', side: 'left' })
    await sleep(400)
    const breakGap = gapAfterLayout('volleyball_matchscore_timeout_02')
    ok(breakGap !== null, 'the countdown switched layout and painted')
    ok(breakGap !== null && breakGap < MAX_GAP_MS,
      `countdown screen is populated ${breakGap}ms after the switch (was ~800ms, budget ${MAX_GAP_MS}ms)`)
    await post('/api/countdown/stop', { expired: false })
    await sleep(200)
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close()
    await mock.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('\n[3] the result screen is blanked on the way out')
{
  // Cutting the gap is not enough on its own. The board retains each layout's section values, so a
  // result left in place is what the panel shows for the whole of the next gap, however short —
  // and a previous winner is worse than an empty screen.
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-latency2-'))
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
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    await post('/api/result', { winner: 'KSCW WINS', score: '3 - 0', history: '25-23' })
    await sleep(250)
    ok(mock.text('winner') === 'KSCW WINS', 'the result is on the panel')

    await post('/api/game', { choice: 'new' })
    await sleep(300)
    ok(mock.text('winner') === '', `the winner line was wiped on the way out (holds ${JSON.stringify(mock.text('winner'))})`)
    ok(mock.text('sets') === '' && mock.text('history') === '', 'and so were the score and the set history')
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
