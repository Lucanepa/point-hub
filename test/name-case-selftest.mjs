// Team names on the panel are ALWAYS capitals.
//
// The bug this locks down was invisible from the console by construction. The name box is styled
// `text-transform: uppercase`, so a name typed in lower case renders as capitals to the scorer
// holding the tablet — and goes to the board as the raw lower-case string. The only place the
// truth showed was the LED panel twenty metres away, mid-match, where nobody can fix it. The
// board's own log for 2026-08-04 has `{"short":"kscw h3"}` and `{"short":"kscw h1"}` on it.
//
// A phone keyboard produces lower case by default, so this is the normal input, not the exotic one.
//
// Two properties, and the second is the one that is easy to get wrong:
//   1. Capitals reach the glass, on every screen, in every sport, from either source.
//   2. The name is sized AFTER it is upper-cased. Capitals run ~15-20% wider, so fitting the typed
//      string and painting a different one is exactly how a name ends up clipped by the set
//      counter — a subtler version of the same bug, and one no screenshot would catch.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  toLeftRight, toSections, toIdleSections, toClubIdleSections, toBreakSections, fitFontSize,
} from '../src/volleyballMapper.js'
import { toBeachSections } from '../src/beachMapper.js'
import { toBasketballSections } from '../src/basketballMapper.js'
import { ManualSource } from '../src/manualSource.js'
import { BeachSource } from '../src/beachSource.js'
import { BasketballSource } from '../src/basketballSource.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const textOf = (sections, name) => {
  const hit = sections.find((s) => s.name === name && s.value.attrib === 'text')
  return hit ? hit.value.value : undefined
}
const fontOf = (sections, name) => {
  const hit = sections.find((s) => s.name === name && s.value.attrib === 'fontsize')
  return hit ? Number(hit.value.value) : undefined
}

// Exactly what the operator typed into the tablet on 2026-08-04.
const TYPED = { side_a: 'left', team_a_short: 'kscw h1', team_b_short: 'kscw h3', points_a: 7, points_b: 9 }

console.log('[1] what the operator typed vs what the panel is told')
{
  const v = toLeftRight(TYPED)
  eq(v.leftName, 'KSCW H1', 'left name upper-cased')
  eq(v.rightName, 'KSCW H3', 'right name upper-cased')
  const s = toSections(TYPED)
  eq(textOf(s, 'team1'), 'KSCW H1', 'and it is the upper-cased string that reaches team1')
  // Reported as a one-sided fault ("why is team B lower case"), so assert BOTH sides — a fix
  // applied to one branch of toLeftRight would pass a single-sided test.
  eq(textOf(s, 'team2'), 'KSCW H3', 'and team2 — the side the fault was reported on')
}

console.log('\n[2] it follows the team through a swap')
{
  // The operator's second observation: "switching keeps team B lower case somehow". Of course it
  // does — the case is a property of the string, not of the side. After side_a flips, the same
  // team is painted on the other half and must still be capitals there.
  const swapped = toLeftRight({ ...TYPED, side_a: 'right' })
  eq(swapped.leftName, 'KSCW H3', 'team B, now on the left, is still capitals')
  eq(swapped.rightName, 'KSCW H1', 'and team A on the right')
}

console.log('\n[3] every screen, not just the scoreboard')
{
  eq(textOf(toIdleSections(TYPED), 'team1'), 'KSCW H1', 'the pre-match VS screen')
  eq(textOf(toIdleSections(TYPED), 'team2'), 'KSCW H3', 'both sides of it')
  // The crest screen shows FULL names, which come down a different branch of toLeftRight.
  const crest = toClubIdleSections({ side_a: 'left', team_a_name: 'ksc wiedikon', team_b_name: 'volley zuerich' },
    { fullNames: true, clubName: 'KSC WIEDIKON' })
  eq(textOf(crest, 'team1'), 'KSC WIEDIKON', 'the crest screen full name')
  eq(textOf(crest, 'team2'), 'VOLLEY ZUERICH', 'and the opponent full name')
  // The break screen takes the team as a plain string from the caller (controlServer resolves it
  // through toLeftRight), and upper-cases it itself — belt and braces, both must hold.
  eq(textOf(toBreakSections(TYPED, { timerText: '30', label: 'time out', team: 'kscw h1' }), 'team'), 'KSCW H1',
    'the timeout screen names the team that called it')
}

console.log('\n[4] every sport')
{
  eq(textOf(toBeachSections(TYPED), 'team1'), 'KSCW H1', 'beach (shares toLeftRight)')
  eq(textOf(toBasketballSections(TYPED), 'team1'), 'KSCW H1', 'basketball (shares toLeftRight)')
}

console.log('\n[5] the name is SIZED as capitals, not as typed')
// The subtle half. "kuesnacht" fits the 86px name column at the default ceiling of 18; the
// capitals it is actually painted as do not, and must step down. Sizing the typed string would
// send 18 and let the board clip "KUESNACHT" into the set counter.
{
  const typedFit = fitFontSize('kuesnacht', 86, { max: 18 })
  const paintedFit = fitFontSize('KUESNACHT', 86, { max: 18 })
  // Guard the discriminator itself: if these ever agree, the assertions below prove nothing.
  ok(paintedFit < typedFit, `the test case actually discriminates (lower case ${typedFit} > capitals ${paintedFit})`)
  const s = toSections({ side_a: 'left', team_a_short: 'kuesnacht', team_b_short: 'ab' })
  eq(fontOf(s, 'team1'), paintedFit, 'the size sent is the one the CAPITALS need')
  eq(textOf(s, 'team1'), 'KUESNACHT', 'and it is the capitals that get painted at that size')
}

console.log('\n[6] accents survive, and the panel font knows them')
{
  // Swiss club names carry umlauts. toUpperCase() must not be skipped for them, and the width
  // table has to recognise the capital form or the fitter falls back to an average glyph width.
  const v = toLeftRight({ side_a: 'left', team_a_short: 'zürich', team_b_short: 'genève' })
  eq(v.leftName, 'ZÜRICH', 'ü upper-cases to Ü')
  eq(v.rightName, 'GENÈVE', 'and è to È')
  ok(fitFontSize('ZÜRICH', 86, { max: 18 }) === fitFontSize('ZURICH', 86, { max: 18 }),
    'Ü is in the panel font width table (sizes like its unaccented twin, not an average guess)')
}

console.log('\n[7] the sources store capitals too')
{
  // The mapper is what guarantees the PANEL. The sources are what keep everything DERIVED from
  // state in agreement with it — the end-of-match result lines, the archived match history and the
  // "Add a timeout for X?" prompt are all built in the browser from the stored value.
  for (const [name, Src] of [['manual', ManualSource], ['beach', BeachSource], ['basketball', BasketballSource]]) {
    const s = new Src()
    s.apply({ type: 'team', side: 'left', short: 'kscw h1' })
    s.apply({ type: 'team', side: 'right', short: 'kscw h3' })
    const st = s.getState()
    ok(st.team_a_short === 'KSCW H1' && st.team_b_short === 'KSCW H3', `${name} source stores capitals`)
  }
  const s = new ManualSource()
  s.apply({ type: 'team', side: 'left', name: 'ksc wiedikon' })
  eq(s.getState().team_a_name, 'KSC WIEDIKON', 'the full name too, not only the short code')
}

console.log('\n[8] end to end: typed lower case, painted upper case')
// Everything above is a pure function. This is the path the operator actually drove on
// 2026-08-04: the name box POSTs /api/action {type:'team'}, and the panel has to end up correct.
{
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-namecase-'))
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
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'kscw h1' } })
    await post('/api/action', { action: { type: 'team', side: 'right', short: 'kscw h3' } })
    await sleep(250)
    eq(mock.text('team1'), 'KSCW H1', 'the panel holds capitals for the left team')
    eq(mock.text('team2'), 'KSCW H3', 'and for the right — the side that was reported wrong')

    // A swap repaints from the same state; the case must not come back.
    await post('/api/action', { action: { type: 'swap' } })
    await sleep(250)
    eq(mock.text('team1'), 'KSCW H3', 'still capitals after the sides are switched')

    // And the state the console reads back — which is what builds the result screen and the
    // history — agrees with the panel rather than keeping the original keystrokes.
    const st = await (await fetch(base + '/api/status')).json()
    const shorts = [st.state?.team_a_short, st.state?.team_b_short]
    ok(shorts.every((n) => n === String(n).toUpperCase()), `/api/status reports capitals (${shorts.join(', ')})`)
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
