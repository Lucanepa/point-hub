// SATZBALL / MATCHBALL on the board (src/boardNotices.js gamePoint, the name-slot callout in
// src/volleyballMapper.js toSections and src/ledboxClient.js _trackCallout):
//   [1] the set point / match point table: 24:23 yes, 24:24 no, 25:24 yes, the deciding set to 15
//       (14:13), best-of-3 against best-of-5, a team already leading in sets, a set already won (the
//       board's own scoring keeps 25:23 up with the set counted), a match over, the mirror
//   [2] the words in the board's language, and the mapper putting the word in the name slot only
//   [3] the client against a C0270-like MockLedbox: the word first, then name and word taking turns,
//       never a write to a section the vendor layout lacks, gone with the next point, off in Settings,
//       not over another screen
//   [4] the Point Hub board (openscore firmware): the bench modules' `callout` line, in its own write,
//       given up for good on a layout without it
//   [5] end to end, hand scoring on the console: the real appliance and a MockLedbox, Settings ▸
//       Language and Settings ▸ Display ▸ SATZBALL / MATCHBALL

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gamePoint, boardWords, matchBestOf } from '../src/boardNotices.js'
import { toSections, fitFontSize } from '../src/volleyballMapper.js'
import { LedboxClient } from '../src/ledboxClient.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'
import { GLOBAL_DEFAULTS, sanitize } from '../src/settings.js'
import { textColor } from '../src/ledColor.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`) } else { fail++; console.log(`  ❌ ${m}`) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const st = (pa, pb, sa = 0, sb = 0, extra = {}) => ({
  team_a_short: 'HOME', team_a_color: '#2563eb', team_b_short: 'AWAY', team_b_color: '#ef4444', side_a: 'left',
  points_a: pa, points_b: pb, sets_won_a: sa, sets_won_b: sb, ...extra,
})
const gp = (s, o) => { const r = gamePoint(s, o); return r ? `${r.kind}:${r.team}:${r.side}` : null }

console.log('\n[1] set point / match point')
{
  const table = [
    // [points a, points b, sets a, sets b, extra, best-of, want, why]
    [24, 23, 0, 0, {}, 5, 'set:a:left', '24:23 — one point from 25 with the lead: set point'],
    [23, 24, 0, 0, {}, 5, 'set:b:right', '23:24 — the other team'],
    [24, 24, 0, 0, {}, 5, null, '24:24 — the next point does not win it'],
    [25, 24, 0, 0, {}, 5, 'set:a:left', '25:24 — set point again'],
    [25, 25, 0, 0, {}, 5, null, '25:25 — no'],
    [31, 30, 1, 1, {}, 5, 'set:a:left', '31:30 — as long as it takes'],
    [24, 10, 0, 0, {}, 5, 'set:a:left', '24:10 — a big lead is a set point too'],
    [23, 22, 0, 0, {}, 5, null, '23:22 — two points short'],
    [0, 0, 0, 0, {}, 5, null, '0:0 — nothing'],
    [14, 13, 2, 2, {}, 5, 'match:a:left', 'deciding set (2:2) 14:13 — to 15: match point'],
    [14, 14, 2, 2, {}, 5, null, 'deciding set 14:14 — no'],
    [16, 15, 2, 2, {}, 5, 'match:a:left', 'deciding set 16:15 — match point again'],
    [13, 12, 2, 2, {}, 5, null, 'deciding set 13:12 — two short of 15'],
    [24, 23, 2, 2, {}, 5, 'match:a:left', 'deciding set 24:23 (still going) — match point'],
    [24, 20, 1, 0, {}, 5, 'set:a:left', 'best-of-5, sets 1:0, 24:20 — set point'],
    [24, 20, 1, 0, {}, 3, 'match:a:left', 'best-of-3 (Settings), sets 1:0, 24:20 — match point'],
    [24, 20, 1, 0, { best_of: 3 }, 5, 'match:a:left', 'best_of 3 from OpenVolley beats the setting'],
    [24, 20, 1, 0, { sets_to_win: 2 }, 5, 'match:a:left', 'sets_to_win 2 from the board\'s own scoring: best-of-3'],
    [24, 20, 1, 0, { best_of: 5 }, 3, 'set:a:left', 'best_of 5 from OpenVolley, the setting says 3: best-of-5'],
    [14, 13, 1, 1, {}, 3, 'match:a:left', 'best-of-3 deciding set (1:1) 14:13 — match point'],
    [14, 13, 1, 1, {}, 5, null, 'best-of-5, sets 1:1, 14:13 — set 3 is to 25'],
    [24, 20, 2, 0, {}, 5, 'match:a:left', 'a team already 2:0 up, 24:20 — match point'],
    [20, 24, 2, 0, {}, 5, 'set:b:right', 'the team 0:2 down at 20:24 — only a set point'],
    [22, 24, 2, 1, {}, 5, 'set:b:right', 'sets 2:1, the trailing team at 22:24 — set point'],
    [24, 22, 1, 2, {}, 5, 'set:a:left', 'sets 1:2, the trailing team at 24:22 — set point'],
    [22, 24, 1, 2, {}, 5, 'match:b:right', 'sets 1:2, the leading team at 22:24 — match point'],
    [24, 23, 0, 0, { side_a: 'right' }, 5, 'set:a:right', 'team A on the right half (side_a): the right side'],
    [25, 23, 1, 0, {}, 5, null, 'the board\'s own scoring after set 1: 25:23 with the set counted — no'],
    [25, 23, 2, 2, {}, 5, null, '…and after set 4 (now 2:2): 25:23 is not a match point in a set to 15'],
    [15, 13, 3, 2, {}, 5, null, 'match decided (3:2)'],
    [24, 23, 1, 0, { match_status: 'ended' }, 5, null, 'OpenVolley says the match is over'],
    [0, 0, 1, 0, { set_interval_active: true }, 5, null, 'OpenVolley\'s set interval'],
  ]
  for (const [pa, pb, sa, sb, extra, bo, want, why] of table) eq(gp(st(pa, pb, sa, sb, extra), { bestOf: bo }), want, why)
  eq(gamePoint(null), null, 'no state: nothing')
  eq([matchBestOf({ best_of: 3 }), matchBestOf({ sets_to_win: 3 }), matchBestOf({}, 3), matchBestOf({}, 'x')], [3, 5, 3, 5], 'the match format of a state')
}

console.log('\n[2] the words, and the name slot')
{
  eq([boardWords('de').set, boardWords('de').match, boardWords('de-CH').set, boardWords('de-CH').match], ['SATZBALL', 'MATCHBALL', 'SATZBALL', 'MATCHBALL'], 'German and Swiss German')
  eq([boardWords('en').set, boardWords('en').match, boardWords('').set, boardWords('fr').match], ['SET POINT', 'MATCH POINT', 'SET POINT', 'MATCH POINT'], 'English, and English for anything else')
  eq([boardWords('de').benchSet, boardWords('de').benchMatch, boardWords('en').benchMatch], ['SATZ BALL', 'MATCH BALL', 'MATCH POINT'], 'the bench modules split them at the space')
  const s = st(24, 23)
  const val = (secs, name, attrib) => (secs.find((x) => x.name === name && x.value.attrib === attrib) || {}).value?.value
  const plain = toSections(s)
  const word = toSections(s, { callout: { side: 'left', text: 'Satzball' } })
  eq([val(word, 'team1', 'text'), val(word, 'team2', 'text')], ['SATZBALL', 'AWAY'], 'the word in the left name slot, in capitals; the right name stays')
  eq(val(word, 'team1', 'color'), val(plain, 'team1', 'color'), 'in the team\'s own colour')
  eq(val(word, 'team1', 'fontsize'), String(fitFontSize('SATZBALL', 86, { max: 18 })), 'fitted to the name column')
  ok(Number(val(toSections(s, { callout: { side: 'right', text: 'MATCH POINT' } }), 'team2', 'fontsize')) < 18, 'MATCH POINT steps down to fit the 86 px')
  const same = (n) => JSON.stringify(word.filter((x) => x.name === n)) === JSON.stringify(plain.filter((x) => x.name === n))
  ok(['score1', 'score2', 'set1', 'set2', 'timeout1', 'timeout2', 'sub1', 'sub2', 'serve1', 'serve2', 'bg_score1'].every(same), 'scores, sets, counters and serve bars exactly as without it')
  eq(word.map((x) => x.name).filter((n, i, a) => a.indexOf(n) === i), plain.map((x) => x.name).filter((n, i, a) => a.indexOf(n) === i), 'no section the layout does not already get')
}

// The client against a board, its writes recorded.
async function board(opts = {}) {
  const mock = new MockLedbox(opts.mock || {})
  const { port } = await mock.listen(0, '127.0.0.1')
  const writes = []
  mock.on('command', (m) => { if (m.cmd === 'SetSections') writes.push(m.value) })
  const client = new LedboxClient({ hosts: ['127.0.0.1'], port, reconnectMs: 0, layoutGuardMs: 0, idleTickMs: 0, calloutMs: 150, gamePointCallout: true, language: 'de', ...(opts.client || {}) })
  const ready = new Promise((r) => client.once('ready', r))
  client.on('error', () => {})
  client.connect()
  await ready
  await sleep(50)
  return { mock, client, writes, close: async () => { client.disconnect(); await sleep(30); await mock.close() } }
}

console.log('\n[3] the C0270 (vendor firmware): the name slot takes turns')
{
  const b = await board()
  const t = (n) => b.mock.text(n)
  try {
    await b.client.pushState(st(23, 23)); await sleep(30)
    eq([t('team1'), t('team2')], ['HOME', 'AWAY'], '23:23 — the names')
    await b.client.pushState(st(24, 23)); await sleep(30)
    eq(t('team1'), 'SATZBALL', '24:23 — SATZBALL at once, in the paint of the point itself')
    eq(t('score1'), '24', 'the score is painted with it')
    await sleep(160)
    eq(t('team1'), 'HOME', 'then the name')
    await sleep(150)
    eq(t('team1'), 'SATZBALL', 'then the word again')
    const turn = b.writes.at(-1)
    eq([...new Set(turn.map((x) => x.name))], ['team1'], 'a turn writes the name slot and nothing else')
    await b.client.pushState(st(24, 24)); await sleep(30)
    eq([t('team1'), t('team2')], ['HOME', 'AWAY'], '24:24 — names back, at once')
    const n = b.writes.length
    await sleep(350)
    eq(b.writes.length, n, '…and no turns any more')
    await b.client.pushState(st(24, 25, 2, 0)); await sleep(30)
    eq(t('team2'), 'SATZBALL', '24:25 with sets 2:0 — the team 0:2 down has a set point (right)')
    await b.client.pushState(st(26, 25, 2, 0)); await sleep(30)
    eq([t('team1'), t('team2')], ['MATCHBALL', 'AWAY'], '26:25 — the team 2:0 up: MATCHBALL, on the left')
    b.client.setLimits({ language: 'en' }); await sleep(40)
    ok(['MATCH POINT', 'HOME'].includes(t('team1')) && t('team1') !== 'MATCHBALL', `Settings ▸ Language English: MATCH POINT (${t('team1')})`)
    b.client.setLimits({ gamePointCallout: false }); await sleep(40)
    eq(t('team1'), 'HOME', 'Settings off: the name, at once')
    const m = b.writes.length
    await sleep(350)
    eq(b.writes.length, m, '…and nothing takes turns')
    b.client.setLimits({ gamePointCallout: true, language: 'de-CH' }); await sleep(40)
    eq(t('team1'), 'MATCHBALL', 'on again, Swiss German: MATCHBALL')
    // Another screen up: no turn writes onto it.
    await b.client.showMessage('COURT SWITCH', { ms: 400 })
    ok(b.mock.currentLayout === 'volleyball_matchscore_02', 'after an announcement the scoreboard is back')
    const during = []
    const onCmd = (msg) => { if (msg.cmd === 'SetSections' && b.mock.currentLayout === 'kscw_message') during.push(...msg.value.map((x) => x.name)) }
    b.mock.on('command', onCmd)
    const shown = b.client.showMessage('COURT SWITCH', { ms: 450 })
    await sleep(100)
    ok(b.mock.currentLayout === 'kscw_message', 'an announcement is up')
    await shown
    b.mock.off('command', onCmd)
    ok(!during.some((n) => /^team/.test(n)), `no name-slot turn was written onto it (${[...new Set(during)].join(',')})`)
    const names = new Set(b.writes.flat().map((x) => x.name))
    ok(!names.has('callout'), 'the vendor firmware is never sent the bench section it does not have')
  } finally { await b.close() }
}

console.log('\n[4] the Point Hub board (openscore): the bench modules too')
{
  const xml = fs.readFileSync(new URL('../firmware/openscore/layout/volleyball_matchscore_02.xml', import.meta.url), 'utf8')
  const sections = [...xml.matchAll(/<section name="([^"]+)"/g)].map((m) => m[1])
  ok(sections.includes('callout'), 'openscore\'s match layout has the hidden `callout` section')
  ok(/name="callout"[^>]*visible="false"/.test(xml), '…not drawn on the front')
  const b = await board({ mock: { firmware: 'openscore-1.0.0', layouts: { volleyball_matchscore_02: sections } } })
  try {
    await b.client.pushState(st(24, 23)); await sleep(40)
    eq([b.mock.text('team1'), b.mock.text('callout'), b.mock.color('callout')], ['SATZBALL', 'SATZ BALL', textColor('37,99,235', 9, { brightness: 40 })], 'front name slot SATZBALL, bench line SATZ BALL in the team\'s colour (as 9 px text lights)')
    await sleep(160)
    eq([b.mock.text('team1'), b.mock.text('callout')], ['HOME', ''], 'the name turn: the bench line empty')
    await sleep(150)
    eq(b.mock.text('callout'), 'SATZ BALL', 'and back')
    ok(b.writes.some((w) => w.length <= 2 && w.every((x) => x.name === 'callout')), 'the bench line goes in a write of its own')
    await b.client.pushState(st(25, 25)); await sleep(40)
    eq(b.mock.text('callout'), '', 'the set point gone: the bench line empty')
  } finally { await b.close() }
  // openscore with an older layout: one refused write, then never again, and the score still paints.
  const old = sections.filter((n) => n !== 'callout')
  const c = await board({ mock: { firmware: 'openscore-1.0.0', layouts: { volleyball_matchscore_02: old } } })
  try {
    await c.client.pushState(st(24, 23)); await sleep(60)
    eq([c.mock.text('team1'), c.mock.text('score1')], ['SATZBALL', '24'], 'an openscore layout without it: the front still paints')
    const tries = () => c.writes.filter((w) => w.some((x) => x.name === 'callout')).length
    const first = tries()
    await sleep(400)
    eq([first, tries()], [1, 1], 'the bench line is tried once and then left alone')
  } finally { await c.close() }
}

console.log('\n[5] end to end: hand scoring on the console')
{
  ok(GLOBAL_DEFAULTS.gamePointCallout === true, 'Settings: on by default')
  eq([sanitize({ gamePointCallout: 0 }).gamePointCallout, sanitize({ gamePointCallout: 'yes' }).gamePointCallout], [false, true], 'a boolean')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-gamepoint-'))
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const app = await startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '', ledboxHost: '127.0.0.1', ledboxPort: addr.port,
    ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 200, mock: false, controlPort: 0, debug: false,
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json().catch(() => null)
  const act = (action) => post('/api/action', { action })
  const t = (n) => mock.text(n)
  try {
    await sleep(300)
    await post('/api/settings', { language: 'de', bestOf: 5 })
    await post('/api/manual', { takeOver: true })
    await act({ type: 'reset' })
    await act({ type: 'team', side: 'left', short: 'HEIM' })
    await act({ type: 'team', side: 'right', short: 'GAST' })
    for (let i = 0; i < 24; i++) await act({ type: 'point', side: 'left', delta: 1 })
    for (let i = 0; i < 23; i++) await act({ type: 'point', side: 'right', delta: 1 })
    await sleep(150)
    ok(['SATZBALL', 'HEIM'].includes(t('team1')) && t('score1') === '24' && t('score2') === '23', `24:23 on the console: the left name slot takes turns with SATZBALL (${t('team1')} ${t('score1')}:${t('score2')})`)
    let seen = false
    for (let i = 0; i < 20 && !seen; i++) { if (t('team1') === 'SATZBALL') seen = true; else await sleep(100) }
    ok(seen, 'SATZBALL on the panel')
    await act({ type: 'point', side: 'right', delta: 1 }); await sleep(150)
    eq([t('team1'), t('team2'), t('score2')], ['HEIM', 'GAST', '24'], '24:24 — both names')
    await post('/api/settings', { gamePointCallout: false })
    await act({ type: 'point', side: 'right', delta: 1 }); await sleep(150)
    let word = false
    for (let i = 0; i < 18; i++) { if (t('team2') !== 'GAST') word = true; await sleep(100) }
    ok(!word && t('score2') === '25', `Settings off: 24:25 shows the name only (${t('team2')})`)
  } finally {
    await app.close(); await mock.close(); fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — game-point-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
