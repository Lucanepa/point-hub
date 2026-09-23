// Round-3 verifier findings, each pinned.
//
//   [1] a running countdown no longer beats a forced clock. Its 1 s ticker called pushCountdown,
//       which knocks `_idle` and the clock hold off on every tick — so "Show clock", the game
//       menu's Clock and Delete during a timeout or a warm-up looked like they did nothing, and the
//       countdown's end repainted the MATCH rather than the clock.
//   [2] asking for the clock while the panel is disconnected is remembered: reconnecting shows the
//       clock, not a fresh 0-0 scoreboard.
//   [3] the simple scoreboard falls back to the full name when a schedule start's short is empty.
//   [4] a KSCW schedule name keeps its team number: 'KSC Wiedikon Herren 1' is KSCW H1, not
//       'KSCW HERRE'.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LedboxClient } from '../src/ledboxClient.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { SimpleSource } from '../src/simpleSource.js'
import { shortName } from '../src/schedule.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const MATCH = 'volleyball_matchscore_02'
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-clockcd-'))
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
const mock = new MockLedbox({
  layouts: {
    kscw_idle: sectionsOf('30_kscw_idle.xml'),
    kscw_break: sectionsOf('31_kscw_break.xml'),
    kscw_crest: sectionsOf('32_kscw_crest.xml'),
    kscw_clock: sectionsOf('33_kscw_clock.xml'),
  },
})
const addr = await mock.listen(0, '127.0.0.1')
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const post = async (route, body) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const json = await res.json().catch(() => null)
  await sleep(150)
  return json
}
const get = async (route) => (await fetch(base + route)).json()
try {
  await sleep(300)
  await post('/api/manual')
  await post('/api/action', { action: { type: 'team', side: 'left', name: 'KSC Wiedikon H1', short: 'KSCW H1' } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 3 } })
  ok(mock.currentLayout === MATCH && mock.text('score1') === '3', 'a match at 3-0')

  console.log('\n[1] the clock over a running countdown')
  for (const [how, ask] of [
    ['Show clock (/api/idle)', () => post('/api/idle', { on: true, screen: 'clock' })],
    ["the game menu's Clock", () => post('/api/game', { choice: 'clock' })],
  ]) {
    await post('/api/idle', { on: false })
    await post('/api/countdown', { seconds: 30, label: 'TIMEOUT', side: 'left' })
    ok(mock.currentLayout === 'kscw_break', `${how}: a timeout is running (${mock.currentLayout})`)
    await ask()
    ok(mock.currentLayout === 'kscw_clock', `${how}: the clock goes up (${mock.currentLayout})`)
    await sleep(1400) // more than one countdown tick
    ok(mock.currentLayout === 'kscw_clock', `${how}: and is still up after the countdown would have ticked (${mock.currentLayout})`)
    const st = await get('/api/status')
    ok(st.ledbox.clockHeld === true, `${how}: /api/status still reports the held clock`)
    ok((await get('/api/board')).countdown === null, `${how}: the countdown is over`)
    ok(st.state.points_a === 3, `${how}: the score is untouched`)
  }
  // Delete during a warm-up: the board shows the saved game, so it clears to the clock.
  await post('/api/idle', { on: false })
  await post('/api/countdown', { seconds: 600, label: 'WARM-UP' })
  ok(mock.currentLayout === 'kscw_break', 'Delete: a warm-up is running')
  let r = await post('/api/game', { choice: 'delete' })
  ok(r.cleared === true && mock.currentLayout === 'kscw_clock', `Delete: cleared to the clock (${mock.currentLayout})`)
  await sleep(1400)
  ok(mock.currentLayout === 'kscw_clock', 'Delete: the clock stays')

  // Outside all of this, a countdown still ends the old way: back to the match, horn and all.
  await post('/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
  await post('/api/countdown', { seconds: 1, label: 'TIMEOUT', side: 'right' })
  await sleep(2100)
  ok(mock.currentLayout === MATCH && mock.text('score2') === '1', `an ordinary timeout still returns to the match (${mock.currentLayout})`)
} finally {
  await app.close().catch(() => {})
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log('\n[2] the clock asked for while the panel is down')
{
  const c = new LedboxClient({ hosts: ['127.0.0.1'], layoutSettleMs: 0, idleTickMs: 0 })
  c.on('error', () => {})
  c.ready = false
  c._lastState = { team_a_short: 'KSCW H1', team_b_short: 'KSCW H3', points_a: 0, points_b: 0 }
  const shown = await c.showIdle(true, { screen: 'clock' })
  ok(shown === false, 'nothing painted (no board)')
  ok(c._idle === true && c._clockHeld === true, 'but the intent is kept for the reconnect')
  await c.showIdle(false)
  ok(c._idle === false && c._clockHeld === false, 'and so is taking it back')
}
{
  // End to end: a panel that comes up after the request shows the clock.
  const m2 = new MockLedbox({ layouts: { kscw_clock: sectionsOf('33_kscw_clock.xml'), kscw_crest: sectionsOf('32_kscw_crest.xml'), kscw_idle: sectionsOf('30_kscw_idle.xml') } })
  const a2 = await m2.listen(0, '127.0.0.1')
  const c = new LedboxClient({ hosts: ['127.0.0.1'], port: a2.port, layoutSettleMs: 0, reconnectMs: 0 })
  c.on('error', () => {})
  c._lastState = { team_a_short: 'KSCW H1', team_b_short: 'KSCW H3', team_a_name: 'KSC Wiedikon H1', points_a: 0, points_b: 0 }
  await c.showIdle(true, { screen: 'clock' })
  c.connect()
  await sleep(500)
  ok(m2.currentLayout === 'kscw_clock', `on connect the panel shows the clock (${m2.currentLayout})`)
  c.disconnect()
  await m2.close()
}

console.log('\n[3] the simple scoreboard: an empty short falls back to the name')
{
  const s = new SimpleSource()
  s.apply({ type: 'team', side: 'left', name: 'KSC Wiedikon', short: '' })
  s.apply({ type: 'team', side: 'right', name: 'Volero', short: 'VZH' })
  const st = s.getState()
  const names = JSON.stringify(st)
  ok(names.includes('KSC Wiedikon') && names.includes('VZH'), `left from the name, right from the short (${names.slice(0, 160)})`)
  s.apply({ type: 'team', side: 'left', name: '', short: '' })
  ok(!JSON.stringify(s.getState()).includes('undefined'), 'both empty: an empty name, never "undefined"')
}

console.log('\n[4] a KSCW schedule name keeps its number')
for (const [full, want] of [
  ['KSC Wiedikon Herren 1', 'KSCW H1'],
  ['KSC Wiedikon Damen 2', 'KSCW D2'],
  ['KSC Wiedikon H1', 'KSCW H1'],
  ['KSC Wiedikon HU23', 'KSCW HU23'],
  ['KSC Wiedikon Juniorinnen U17', 'KSCW JU17'],
  ['KSC Wiedikon', 'KSCW'],
]) {
  const got = shortName(full)
  ok(got === want && got.length <= 10, `${JSON.stringify(full)} → ${JSON.stringify(got)}${got === want ? '' : ` (wanted ${JSON.stringify(want)})`}`)
}

console.log(`\n${fail ? '❌' : '✅'} clock-over-countdown: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
