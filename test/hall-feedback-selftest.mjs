// What the first hall game on the deployed console showed (06.11), each pinned.
//
//   [1] a time-out no longer flashes the scoreboard. The console posts the countdown and the action
//       together, so the action's paint could land while the layout was switching, get an error 6
//       back, and put the match layout up again until the next countdown tick.
//   [2] the panel's own self-heal stays: a layout changed behind our back is still put right.
//   [3] a name size stays with its team across a court switch, for a linked match too, and a −/+
//       afterwards changes the team it was tapped on.
//   [4] a name with a team number stays at eight characters.
//   [5] in the tablet app, the end of a match stays on the Game tab, where it is closed, and Match
//       info opens over the Link tab and comes back.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'
import { fitFontSize, teamsCrossed } from '../src/volleyballMapper.js'
import { shortName } from '../src/schedule.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const MATCH = 'volleyball_matchscore_02'
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/<section name="([^"]+)"/g)].map((m) => m[1])
const mock = new MockLedbox({
  layouts: {
    kscw_break: sectionsOf('31_kscw_break.xml'),
    kscw_idle: sectionsOf('30_kscw_idle.xml'),
    kscw_clock: sectionsOf('33_kscw_clock.xml'),
  },
})
const seen = []
let current = mock.currentLayout
const watch = setInterval(() => { if (mock.currentLayout !== current) { current = mock.currentLayout; seen.push(current) } }, 1)
const addr = await mock.listen(0, '127.0.0.1')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-hall-'))
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const rawPost = async (route, body) => (await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json().catch(() => null)
const post = async (route, body) => { const r = await rawPost(route, body); await sleep(150); return r }
const get = async (route) => (await fetch(base + route)).json()
const sizes = async () => (await get('/api/status')).board.fontsize
try {
  await sleep(800)
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  await sleep(400)

  console.log('\n[1] a time-out goes straight to the countdown')
  for (const gap of [0, 0, 0, 15, 60]) {
    seen.length = 0
    current = mock.currentLayout
    const started = rawPost('/api/countdown', { seconds: 30, label: 'TIME OUT', content: 'full', side: 'left' })
    if (gap) await sleep(gap)
    await Promise.all([started, rawPost('/api/action', { action: { type: 'timeout', side: 'left', delta: 1 } })])
    await sleep(1400)
    ok(seen.join() === 'kscw_break', `${gap} ms between them: the panel only ever went to the countdown (${seen.join(' → ')})`)
    await post('/api/countdown/stop', { expired: false })
    await post('/api/action', { action: { type: 'undo' } })
    await sleep(300)
    ok(mock.currentLayout === MATCH, 'and the scoreboard comes back when it stops')
  }

  console.log('\n[2] the self-heal still works')
  mock.currentLayout = 'kscw_idle'
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  await sleep(600)
  ok(mock.currentLayout === MATCH, 'a layout changed behind our back is put right by the next point')

  console.log('\n[3] a name size follows its team')
  await post('/api/settings', { matchFontMaxLeft: 18, matchFontMaxRight: 12 })
  await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW H3' } })
  await post('/api/action', { action: { type: 'team', side: 'right', short: 'KSCW H2' } })
  let s = await sizes()
  ok(s.left === 18 && s.right === 12, `before the switch: left ${s.left}, right ${s.right}`)
  await post('/api/action', { action: { type: 'swap' } })
  s = await sizes()
  ok(s.left === 12 && s.right === 18, `after the switch the small name is on the left at its size: left ${s.left}, right ${s.right}`)
  const st = await get('/api/status')
  ok(st.state.ends_swapped === true && teamsCrossed(st.state), 'the state says the teams are crossed')
  ok(st.board.fontMax.left === 12 && st.board.fontMax.right === 18, 'the status hands the ceilings over per half')
  let view = await get('/api/settings')
  ok(view.matchFontMaxLeft === 12 && view.matchFontMaxRight === 18, 'and so does /api/settings, so an old client keeps working')
  const saved = await post('/api/settings', { matchFontMaxLeft: 11 })
  ok(saved.matchFontMaxLeft === 11 && saved.matchFontMaxRight === 18, 'a −/+ on the left half is answered per half')
  s = await sizes()
  ok(s.left === 11 && s.right === 18, 'and it changes the team on that half, not the other one')
  await post('/api/settings', { matchFontMaxLeft: 12 })
  await post('/api/action', { action: { type: 'swap' } })
  s = await sizes()
  ok(s.left === 18 && s.right === 12, 'switching back takes the sizes back')
  const next = await post('/api/action', { action: { type: 'swap' } })
  ok(next && next.ok, 'one more switch, as at a set end')
  await post('/api/settings', { totalTimeouts: 2 })
  s = await sizes()
  ok(s.left === 12 && s.right === 18, 'an unrelated settings save leaves them where they are')
  await post('/api/action', { action: { type: 'swap' } })

  const linked = (side_a) => teamsCrossed({ side_a })
  ok(linked('right') === true && linked('left') === false, 'a linked match, whose side_a flips, counts as crossed too')
  ok(teamsCrossed({ side_a: 'left', ends_swapped: true }) === true && teamsCrossed(null) === false, 'the board\'s own sources by ends_swapped, no state as not crossed')

  console.log('\n[4] short names with a number')
  ok(shortName('VBC Einsiedeln H2') === 'EINSI H2', `EINSIEDELN H2 → ${shortName('VBC Einsiedeln H2')}`)
  ok(fitFontSize('EINSI H2', 86, { max: 18 }) === 18, 'and that keeps the default size on the panel')
  ok(shortName('Volley Amriswil') === 'AMRISWIL', 'a name without a number is not cut')
  ok(shortName('KSC Wiedikon HU23') === 'KSCW HU23', 'our own teams keep their designation')
} finally {
  clearInterval(watch)
  await app.close()
  await mock.close?.()
}

console.log('\n[5] the tablet app')
{
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const start = html.indexOf('function renderSuggest(st) {')
  let depth = 0, end = start
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++
    if (html[i] === '}' && --depth === 0) { end = i + 1; break }
  }
  const run = (over) => {
    const calls = []
    const f = new Function('$', 'EMBED', 'appCall', 'matchOver', 'fillSuggest', 'let suggestSig = "";' + html.slice(start, end) + '\nreturn renderSuggest;')(
      () => null, true, (...a) => calls.push(a.join(':')), () => over, () => {})
    f({ suggestion: [{ id: 1 }], state: {} })
    return calls
  }
  ok(run(false).join() === 'showTab:link', 'a suggested game still opens the Link tab during the day')
  ok(run(true).length === 0, 'but not at the end of a match: Close match is on the Game tab')
  ok(/anchor === "matchinfo" && name === "link"\) \{ matchInfoFromApp = true; openMatchInfo\(\); \}/.test(html), "the app's Match info opens the page")
  ok(/if \(matchInfoFromApp\) \{ matchInfoFromApp = false; appCall\("showTab", "game"\); \}/.test(html), 'and Back returns to the Game tab')
}

console.log(`\n${fail ? '❌' : '✅'} hall-feedback: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
