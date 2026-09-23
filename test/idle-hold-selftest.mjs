// What the panel does in the seconds around a (re)connect, against a board that behaves like the
// real one: silent on a SetLayout for the layout already up (`noresend`), and strict about which
// sections each layout carries. Four things the lenient mock could not see:
//
//   [1] the sport-switch confirmation stays up its full hold — the idle ticker used to put the
//       crest back over it within a second, because `_idle` stays true underneath it;
//   [2] and if the operator starts scoring during that hold, it does not drop the crest over them;
//   [3] reconnecting to a board already on the crest does not stack silent SetLayouts, each one
//       holding the serialized send queue for its 5 s timeout (~25 s of it, first paint ~8 s late);
//   [4] a board without kscw_break is asked for it once per connection, not once per countdown tick;
//   [5] the idle fallback on beach/basketball's own match layout actually paints — it used to write
//       volleyball-only sections, which the board rejects wholesale (code 6).
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'
import { getSport } from '../src/sports.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// Section names straight out of the layout XML the deploy ships, so the mock is exactly as strict
// as the board running that layout.
const sectionsOf = (file) => {
  const names = [...readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf-8').matchAll(/name="([^"]+)"/g)].map((m) => m[1])
  return names.slice(1) // the first name= is the layout's own
}
const KSCW = {
  kscw_crest: [], // image only
  kscw_break: sectionsOf('31_kscw_break.xml'),
}

let port = 18960
async function rig({ mockOpts = {}, boardOn = 'waiting', clientOpts = {} } = {}) {
  const mock = new MockLedbox({ noresend: true, ...mockOpts })
  mock.currentLayout = boardOn
  await mock.listen(++port)
  const t0 = Date.now()
  const log = []
  mock.on('command', (m) => { if (m.cmd === 'SetLayout') log.push({ at: Date.now() - t0, layout: m.value }) })
  const client = new LedboxClient({ host: '127.0.0.1', port, reconnectMs: 0, layoutSettleMs: 0, ...clientOpts })
  const errors = []
  client.on('error', (e) => errors.push(e.message))
  client.connect()
  await once(client, 'ready')
  return { mock, client, log, errors, t0, done: async () => { client.disconnect(); await sleep(30); await mock.close() } }
}

console.log('[1] sport-switch confirmation holds for its full time')
{
  const r = await rig({
    mockOpts: { layouts: KSCW },
    clientOpts: { defaultIdle: true, bootMessage: 'Beach volleyball', idleTickMs: 50 },
  })
  await sleep(2600)
  const breakAt = r.log.find((l) => l.layout === 'kscw_break')?.at
  const crestAfter = r.log.find((l) => l.layout === 'kscw_crest' && l.at > (breakAt ?? Infinity))
  ok(breakAt != null, 'the break screen went up')
  ok(!crestAfter, `nothing replaced it 2.6 s in (SetLayouts: ${r.log.map((l) => `${l.layout}@${l.at}`).join(', ')})`)
  ok(r.mock.text('lbl') === 'BEACH VOLLEYBALL', 'the sport name is still on the panel')
  await sleep(800)
  ok(r.mock.currentLayout === 'kscw_crest', 'then it settled back to the crest')
  ok(r.mock.text('lbl') === '', 'with the label blanked on the way out')
  await r.done()
}

console.log('\n[2] the operator scores during the confirmation')
{
  const r = await rig({
    mockOpts: { layouts: KSCW },
    clientOpts: { defaultIdle: true, bootMessage: 'Volleyball', idleTickMs: 50 },
  })
  await sleep(500)
  // What controlServer does on a score while idle: lift idle, then paint.
  await r.client.showIdle(false)
  await r.client.pushState({ team_a_short: 'KSCW', team_b_short: 'VBC', points_a: 1, points_b: 0 })
  await sleep(3000)
  ok(r.mock.currentLayout === 'volleyball_matchscore_02', 'the match layout is still up after the hold ends')
  ok(r.mock.text('score1') === '1', 'with the score on it')
  await r.done()
}

console.log('\n[3] reconnect to a board already showing the crest')
{
  const r = await rig({ mockOpts: { layouts: KSCW }, boardOn: 'kscw_crest', clientOpts: { defaultIdle: true, idleTickMs: 50 } })
  await sleep(300)
  const silent = r.log.filter((l) => l.layout === 'kscw_crest').length
  ok(silent === 0, `no SetLayout for the layout it reported in Init (sent ${silent})`)
  // The operator starts at once; the paint must not wait behind anything.
  const t = Date.now()
  await r.client.showIdle(false)
  await r.client.pushState({ team_a_short: 'KSCW', team_b_short: 'VBC', points_a: 3, points_b: 2 })
  ok(Date.now() - t < 1000 && r.mock.text('score1') === '3', `first paint landed in ${Date.now() - t} ms`)
  await r.done()
}

console.log('\n[3b] …and when the layout is unknown, ticks do not pile up behind a silent SetLayout')
{
  const r = await rig({ mockOpts: { layouts: KSCW }, boardOn: 'kscw_crest', clientOpts: { idleTickMs: 50 } })
  await sleep(100) // let connect() finish putting the match layout up
  r.mock.currentLayout = 'kscw_crest' // the board is on the crest…
  r.client.currentLayout = null // …and we do not know it (Init without current_layout)
  // Count what gets QUEUED, not what reaches the board: the send chain is serialized, so the pile
  // sits client-side behind the one silent SetLayout and the mock only ever sees the first.
  let queued = 0
  const setLayout = r.client.setLayout.bind(r.client)
  r.client.setLayout = (name) => { if (name === 'kscw_crest') queued++; return setLayout(name) }
  r.client.showIdle(true).catch(() => {}) // waits out the board's silence (5 s)
  await sleep(1200) // ~24 ticks
  ok(queued === 1, `one SetLayout queued, not one per tick (queued ${queued})`)
  await r.done()
}

console.log('\n[4] a board without kscw_break')
{
  const r = await rig({ clientOpts: { idleTickMs: 0 } }) // default mock: no kscw_break
  for (let s = 30; s > 25; s--) await r.client.pushCountdown(s, 'TIMEOUT')
  const asked = r.log.filter((l) => l.layout === 'kscw_break').length
  ok(asked === 1, `asked for it once, not per tick (asked ${asked})`)
  ok(r.errors.filter((e) => /break layout unavailable/.test(e)).length === 1, 'and reported it once')
  ok(r.mock.currentLayout === 'volleyball_matchscore_timeout_02' && r.mock.text('timer') === '26', 'the vendor countdown is running')
  await r.done()
}

console.log('\n[5] idle fallback on the sport\'s own match layout (no KSCW idle layouts)')
for (const [key, file] of [['basketball', '41_basketball_matchscore.xml'], ['beach', '40_beach_matchscore.xml']]) {
  const sport = getSport(key)
  const r = await rig({
    mockOpts: { layouts: { [sport.layouts.layout]: sectionsOf(file) } },
    clientOpts: { ...sport.layouts, mapper: sport.mapper, idleTickMs: 0 },
  })
  await r.client.pushState({ team_a_short: 'KSCW', team_b_short: 'VBC', points_a: 12, points_b: 9 })
  ok(r.mock.text('score1') === '12', `${key}: match screen painted`)
  const shown = await r.client.showIdle(true)
  ok(shown === true, `${key}: showIdle succeeded`)
  ok(r.mock.text('team1') === 'KSCW' && r.mock.text('score1') === '', `${key}: names up, score blanked`)
  await r.done()
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
