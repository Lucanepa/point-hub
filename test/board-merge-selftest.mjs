// The work that only ever lived on the board, now that it lives in the repo.
//
// Three files and four edits ran on the hall's LedBox for weeks without being committed: the
// "Simple scoreboard" sport (simpleSource.js + simpleMapper.js), the console handing the board its
// clock (clockSync.js + POST /api/clock), and the Blank button coming out. Merging them onto this
// branch meant teaching the simple scoreboard the things the branch added meanwhile — undo, the
// resume slot, per-sport idle mappers — and deciding where it opts out (history, /live).
//
// It also meant fixing the one thing the board version got wrong. simpleMapper empties the
// volleyball layout's static "T" and "S" captions, and nothing else ever wrote them — the layout
// file set them once — while the firmware keeps section values in memory across layout switches and
// bridge restarts. So an evening on the simple scoreboard left volleyball with two unlabelled
// counters until the panel was power-cycled. The mock keeps its screen across boots the same way,
// which is what lets [4] reproduce that on a laptop.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { getSport, SPORT_KEYS } from '../src/sports.js'
import { SimpleSource } from '../src/simpleSource.js'
import { toSimpleSections, toSimpleIdleSections } from '../src/simpleMapper.js'
import { ClockSync } from '../src/clockSync.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const layoutXml = (file) => fs.readFileSync(path.join(root, 'layouts', file), 'utf8')
// { sectionName: text } for every section of a layout file.
const sectionsOf = (file) => Object.fromEntries(
  [...layoutXml(file).matchAll(/<section name="([^"]+)"[^>]*>([^<]*)<\/section>/g)].map((m) => [m[1], m[2]]))
const textOf = (sections, name) => {
  const hits = sections.filter((s) => s.name === name && s.value.attrib === 'text')
  return hits.length ? hits[hits.length - 1].value.value : undefined
}
const state = {
  side_a: 'left', team_a_short: 'KSCW', team_b_short: 'VBC', team_a_color: '#2563eb', team_b_color: '#ef4444',
  points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0, timeouts_a: 1, timeouts_b: 0, subs_a: 2, subs_b: 0,
  serving_team: 'left', period: 2, over: false,
}

console.log('\n[1] every static caption is re-asserted with the text its layout file gives it')
{
  const LAYOUT_FILE = {
    volleyball: '02_volleyball_matchscore_02.xml',
    beach: '40_beach_matchscore.xml',
    basketball: '41_basketball_matchscore.xml',
    simple: '02_volleyball_matchscore_02.xml',
  }
  ok(SPORT_KEYS.includes('simple') && getSport('simple').label === 'Simple scoreboard', 'the simple scoreboard is a registered sport')
  for (const key of ['volleyball', 'beach', 'basketball']) {
    const xml = sectionsOf(LAYOUT_FILE[key])
    const labels = Object.keys(xml).filter((n) => n.startsWith('lbl_'))
    const secs = getSport(key).mapper.toSections(state)
    ok(labels.length > 0 && labels.every((n) => textOf(secs, n) === xml[n]),
      `${key}: toSections writes ${labels.map((n) => `${n} "${xml[n]}"`).join(', ')}`)
  }
  // The idle fallback on the SAME layout as the simple scoreboard puts them back too, and its own
  // match screen and idle screen both keep them dark.
  const vIdle = getSport('volleyball').mapper.toIdleSections(state)
  ok(textOf(vIdle, 'lbl_to') === 'T' && textOf(vIdle, 'lbl_sub') === 'S', 'volleyball idle fallback: T and S')
  ok(textOf(toSimpleSections(state), 'lbl_to') === '' && textOf(toSimpleSections(state), 'lbl_sub') === '',
    'simple: its match screen empties both (there are no counters to label)')
  ok(getSport('simple').mapper.toIdleSections === toSimpleIdleSections, 'simple: has its own idle fallback')
  ok(textOf(toSimpleIdleSections(state), 'lbl_to') === '' && textOf(toSimpleIdleSections({}), 'team1') === '',
    'which keeps the captions dark and an empty name empty (no HOME / AWAY)')

  // The mock has to know every section any sport writes, or a test on it passes a paint the real
  // board (strict per layout, below) would have refused.
  for (const key of SPORT_KEYS) {
    const m = getSport(key).mapper
    const xml = sectionsOf(LAYOUT_FILE[key])
    for (const [what, secs] of [['toSections', m.toSections(state)], ['toIdleSections', m.toIdleSections(state)]]) {
      let threw = null
      try { new MockLedbox()._applySections(secs) } catch (e) { threw = e.message }
      const stray = [...new Set(secs.map((s) => s.name))].filter((n) => !(n in xml))
      ok(!threw && stray.length === 0, `${key}.${what}: every section is in the mock and in ${LAYOUT_FILE[key]}${threw ? ` (mock: ${threw})` : ''}${stray.length ? ` (not in layout: ${stray.join(', ')})` : ''}`)
    }
  }
}

console.log('\n[2] SimpleSource: two numbers, an undo journal, and nothing automatic')
{
  const s = new SimpleSource({ bestOf: 3 })
  s.apply({ type: 'point', side: 'left', delta: 1 })
  s.apply({ type: 'point', side: 'left', delta: 1 })
  s.apply({ type: 'point', side: 'right', delta: 1 })
  ok(s.getState().points_a === 2 && s.getState().points_b === 1, 'scores 2-1')
  ok(s.canUndo && s.lastJournaled && /^Point/.test(s.undoLabel), `undo is offered ("${s.undoLabel}")`)
  s.apply({ type: 'undo' })
  ok(s.lastEvent === 'undo' && s.getState().points_b === 0, 'undo takes the last point back')
  s.apply({ type: 'timeout', side: 'left', delta: 1 })
  ok(!s.lastJournaled && s.getState().timeouts_a === 0, 'a verb this sport does not have is ignored — and not journaled')
  s.apply({ type: 'point', side: 'left', value: 25 })
  s.apply({ type: 'point', side: 'left', delta: 1 })
  ok(s.getState().points_a === 26 && s.lastEvent === null, 'no set ever closes: 26 is just a number')
  s.clearUndo()
  s.apply({ type: 'undo' })
  ok(s.lastEvent === 'undo-empty', 'clearUndo empties the journal')
}

console.log('\n[3] ClockSync: the gates, with the host clock never touched')
{
  const NOW = Date.UTC(2026, 8, 23, 12)
  const applied = []
  const mk = (probe, busy = false) => new ClockSync({
    now: () => NOW, isBusy: () => busy, probeSync: async () => probe,
    applyTime: async (t) => { applied.push(t); return '' }, persist: async () => '',
  })
  ok((await mk('yes').setFromConsole(NOW + 3600e3)).reason === 'ntp-synced', 'NTP has the clock: left alone')
  ok((await mk('no').setFromConsole(1.78e9)).reason === 'implausible', 'a seconds-for-milliseconds time is refused')
  ok((await mk('no').setFromConsole(NOW + 5000)).reason === 'close-enough', 'a few seconds out is not worth a jump')
  ok((await mk('no', true).setFromConsole(NOW + 3600e3)).reason === 'busy', 'a match or countdown in flight defers it')
  const r = await mk('no').setFromConsole(NOW + 3600e3)
  ok(r.applied && applied.length === 1 && applied[0] === NOW + 3600e3, 'an unsynced board an hour out adopts the console clock')
  ok((await mk('no').setFromConsole('soon')).ok === false, 'a non-number is a 400, not a crash')
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-boardmerge-'))
const settingsFile = path.join(stateDir, 'settings.json')
const sport = (key) => fs.writeFileSync(settingsFile, JSON.stringify({ sport: key }))
// One mock that outlives every boot, like the firmware: sections keep their values across bridge
// restarts, which is exactly the memory the T/S bug lived in.
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
const boot = () => startAppliance({
  stateDir,
  relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port,
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
  mock: false, controlPort: 0, debug: false,
})
const base = (app) => `http://127.0.0.1:${app.server.address().port}`
const post = async (app, route, body) => {
  const res = await fetch(base(app) + route, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base(app) }, body: JSON.stringify(body ?? {}),
  })
  const json = await res.json().catch(() => null)
  await sleep(120)
  return json
}
const get = async (app, route) => (await fetch(base(app) + route)).json()
const started = async (app) => (await get(app, '/api/logs?q=' + encodeURIComponent('match started'))).entries.length
const crash = async (app) => {
  await new Promise((r) => app.server.close(r))
  app.ledbox.disconnect()
  app.livePush.detach()
  app.sourceManager.stop()
}

let app = null
try {
  console.log('\n[4] the simple scoreboard boots and scores through the mock')
  sport('simple')
  app = await boot()
  await sleep(250)
  let st = await get(app, '/api/status')
  ok(st.sport === 'simple', 'booted on the simple scoreboard')
  ok(st.clock && 'synchronized' in st.clock && typeof st.clock.now === 'string', '/api/status carries the clock view the console reads')
  await post(app, '/api/manual')
  const startedBefore = await started(app)
  await post(app, '/api/action', { action: { type: 'team', side: 'left', short: 'Red' } })
  for (let i = 0; i < 3; i++) await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  const last = await post(app, '/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'on the volleyball layout it borrows')
  ok(mock.text('score1') === '3' && mock.text('score2') === '1', `the panel shows 3-1 (${mock.text('score1')}-${mock.text('score2')})`)
  ok(mock.text('team1') === 'RED' && mock.text('team2') === '', 'a typed name in capitals, an empty one left empty')
  ok(mock.text('lbl_to') === '' && mock.text('lbl_sub') === '' && mock.text('set1') === '', 'captions and set score dark')
  ok(last && last.canUndo === true && /^Point/.test(last.undoLabel), `the console is offered Undo ("${last && last.undoLabel}")`)
  await post(app, '/api/action', { action: { type: 'undo' } })
  ok(mock.text('score2') === '0', 'Undo reaches the panel')
  ok((await started(app)) === startedBefore, 'nothing went into the match log (this sport keeps no history)')
  const resume = JSON.parse(fs.readFileSync(path.join(stateDir, 'data', 'resume.json'), 'utf8'))
  ok(resume.games && resume.games.simple && resume.games.simple.state.points_a === 3, 'but the resume slot has it')

  console.log('\n[5] it survives a crash like any other sport')
  await crash(app)
  app = await boot()
  await sleep(600)
  st = await get(app, '/api/status')
  ok(st.state.points_a === 3 && st.state.points_b === 0 && st.state.team_a_short === 'Red', `restored 3-0 for Red (${st.state.points_a}-${st.state.points_b})`)
  await app.close()
  app = null

  console.log('\n[6] switching back to volleyball puts T and S back on the panel')
  ok(mock.text('lbl_to') === '' && mock.text('lbl_sub') === '', 'the board still holds the emptied captions (firmware memory)')
  sport('volleyball')
  app = await boot()
  await sleep(250)
  await post(app, '/api/manual')
  await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  ok(mock.text('lbl_to') === 'T' && mock.text('lbl_sub') === 'S', `volleyball paints "T" and "S" (${JSON.stringify(mock.text('lbl_to'))}, ${JSON.stringify(mock.text('lbl_sub'))})`)
  ok(mock.text('vs') === '-', 'and the set separator, as it always did')
  ok((await started(app)) > 0, 'and volleyball does keep a match log (the check above can see one)')
} finally {
  if (app) await app.close().catch(() => {})
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
