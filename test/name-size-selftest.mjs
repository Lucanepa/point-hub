// Team-name size on the SCOREBOARD (`matchFontMax`) — the Game-tab −/+ control.
//
// Two things need locking down, and they pull in opposite directions:
//
//   1. The default must be INVISIBLE. Volleyball previously sent no `fontsize` at all, so the
//      panel used the 18 baked into 02_volleyball_matchscore_02.xml. If the default we now send
//      is anything other than 18, every board in the hall silently changes size on deploy — the
//      kind of regression nobody reports as a bug, they just say "the board looks off now".
//   2. It has to actually DO something, end to end: settings → client → mapper → SetSections.
//      A control that saves a number the panel never reads is worse than no control, because the
//      operator concludes the board is broken rather than the button.
//
// The old hard-coded `{ max: 18 }` in the beach/basketball mappers is the reason this is a test
// and not a one-line change: three mappers had to start honouring one setting without any of
// them shifting on the default.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toSections, fitFontSize } from '../src/volleyballMapper.js'
import { toBeachSections } from '../src/beachMapper.js'
import { toBasketballSections } from '../src/basketballMapper.js'
import { Settings } from '../src/settings.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

// Pull the fontsize a mapper emitted for a section out of the SetSections WRITE array.
const fontOf = (sections, name) => {
  const hit = sections.find((s) => s.name === name && s.value.attrib === 'fontsize')
  return hit ? Number(hit.value.value) : undefined
}

const SHORT = { side_a: 'left', team_a_short: 'KSCW', team_b_short: 'VZH', points_a: 3, points_b: 1 }
// Real club names, and the reason any of this exists — "Volley Zuerich" at 18px overruns the
// name column and lands on top of the set counter.
const LONG = { side_a: 'left', team_a_short: 'WIEDIKON', team_b_short: 'VOLLEY ZUERICH' }

console.log('[1] the default is exactly what the layout XML already painted')
{
  const s = toSections(SHORT)
  eq(fontOf(s, 'team1'), 18, 'volleyball short name defaults to 18 — the fontsize in 02_volleyball_matchscore_02.xml')
  eq(fontOf(s, 'team2'), 18, 'both sides')
  eq(fontOf(toBeachSections(SHORT), 'team1'), 18, 'beach default unchanged from its old hard-coded 18')
  eq(fontOf(toBasketballSections(SHORT), 'team1'), 18, 'basketball default unchanged from its old hard-coded 18')
}

console.log('\n[2] a long name shrinks instead of running into the set counter')
{
  const s = toSections(LONG)
  const right = fontOf(s, 'team2')
  ok(right < 18, `"VOLLEY ZUERICH" steps down below the ceiling (got ${right})`)
  ok(right >= 9, `but never below the floor fitFontSize enforces (got ${right})`)
  // Sized per side: the short name must NOT be dragged down with the long one.
  ok(fontOf(s, 'team1') > right, `"WIEDIKON" stays larger than "VOLLEY ZUERICH" (${fontOf(s, 'team1')} > ${right})`)
}

console.log('\n[3] the setting is a ceiling, and it moves both ways')
{
  // A name short enough to fit at ANY ceiling, in the narrowest box of the three (basketball's
  // 62px) — only such a name can prove the ceiling is applied verbatim. "KSCW" cannot: at 30px
  // it is 90px wide against an 86px volleyball column, so the fitter legitimately caps it at 28.
  // Asserting 30 there would be asserting that the ceiling overrides the fit, which is the exact
  // bug this whole mechanism exists to avoid.
  const TINY = { side_a: 'left', team_a_short: 'AB', team_b_short: 'CD' }
  eq(fontOf(toSections(TINY, { matchFontMax: 30 }), 'team1'), 30, 'volleyball takes the ceiling verbatim when the name fits')
  eq(fontOf(toBeachSections(TINY, { matchFontMax: 24 }), 'team1'), 24, 'beach honours the setting (was hard-coded 18)')
  eq(fontOf(toBasketballSections(TINY, { matchFontMax: 24 }), 'team1'), 24, 'basketball honours the setting (was hard-coded 18)')
  eq(fontOf(toSections(SHORT, { matchFontMax: 10 }), 'team1'), 10, 'lowering it lowers even a short name')

  // For a name that does NOT fit at the ceiling, the guarantee is monotonicity: raising the
  // setting must never make the name smaller, and must actually move it.
  const at = (n) => fontOf(toSections(SHORT, { matchFontMax: n }), 'team1')
  ok(at(30) >= at(24) && at(24) >= at(18) && at(18) >= at(12), `monotonic in the setting (${at(12)} ≤ ${at(18)} ≤ ${at(24)} ≤ ${at(30)})`)
  ok(at(30) > at(12), 'and the control has a real effect end to end')
  // A ceiling, not a fixed size: a name too wide for the ceiling still shrinks under it.
  ok(fontOf(toSections(LONG, { matchFontMax: 30 }), 'team2') < 30, 'a long name still shrinks under a raised ceiling')
  // The fitter never exceeds what fits, whatever the operator asks for.
  ok(fontOf(toBasketballSections(SHORT, { matchFontMax: 30 }), 'team1') <= 20,
    "basketball's narrower 62px box still caps KSCW regardless of the ceiling")
}

console.log('\n[4] settings: per-sport, defaulted and clamped')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-namesize-'))
  const file = path.join(dir, 'settings.json')
  // An OLD flat settings.json from a board that predates this key — it must gain the default
  // rather than land as undefined and paint NaN.
  fs.writeFileSync(file, JSON.stringify({ sport: 'volleyball', totalTimeouts: 2, brightness: 0 }))
  const s = new Settings(file)
  eq(s.values.matchFontMax, 18, 'a settings.json with no matchFontMax migrates to the default 18')
  eq(s.forSport('beach').matchFontMax, 18, 'beach gets its own copy')

  s.update({ matchFontMax: 99 })
  eq(s.values.matchFontMax, 30, 'clamped to the max')
  s.update({ matchFontMax: 1 })
  eq(s.values.matchFontMax, 10, 'clamped to the min')
  s.update({ matchFontMax: 22 })
  eq(s.values.matchFontMax, 22, 'a sane value is kept')
  // Per-sport, like the rest of the timing/format keys: a beach layout has a narrower name box.
  eq(s.forSport('beach').matchFontMax, 18, 'editing volleyball did not touch beach')
  eq(new Settings(file).values.matchFontMax, 22, 'and it survives a reload')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n[5] end to end: the −/+ control reaches the glass')
// The part that a mapper unit test cannot prove. POST /api/settings is what the Game tab's
// −/+ calls, and the panel has to repaint at the new size WITHOUT anyone scoring a point —
// the operator is staring at the board waiting for it to change.
{
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-namesize-e2e-'))
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
    await sleep(200)
    eq(mock.fontsize('team1'), '18', 'panel paints the default 18 for KSCW')

    const res = await post('/api/settings', { matchFontMax: 26 })
    eq(res.status, 200, 'POST /api/settings {matchFontMax} -> 200')
    await sleep(250)
    // No point was scored in between — setLimits() has to repaint on its own.
    eq(mock.fontsize('team1'), '26', 'panel repainted at 26 with nobody touching the score')

    // And the next point must not undo it (pushState builds its own sections).
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    await sleep(200)
    eq(mock.fontsize('team1'), '26', 'still 26 after the next point lands')
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
