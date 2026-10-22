// Team colours as the LEDs show them (src/ledColor.js): the luminance floor between the mappers
// and the panel.
//
//   [1] the panel model is hzeller's own: CIE 1931 at the brightness, 11 bit planes, the low
//       ones cut off by pwm_bits 7 — checked against numbers worked out from the driver source
//   [2] the floor: near-black presets are dark on the glass, every other preset is not
//   [3] text: a dark team goes light grey at every size; small dim text is lifted just enough;
//       big digits and colours that already read are left exactly as sent
//   [4] borders and serve bars keep the hue, scaled up only when dark; the mappers' own "off"
//       values are never lifted
//   [5] whole paints from the real mappers: what changes, what never does, nothing mutated
//   [6] the per-layout text sizes agree with the layout XML in the repo (small stays small)
//   [7] end to end through LedboxClient and the mock board: the panel gets the floor, the
//       mapper output the console mirror is built from does not, a brightness change re-floors,
//       and a blink settles on the floored colour

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cie1931, channelLevel, panelLevels, whiteLevel, darkFloor, isDark, panelLuma, parseRgb,
  textColor, edgeColor, ledSafeSections, sectionPx, LAYOUT_TEXT_PX, SMALL_TEXT_PX,
  SMALL_TEXT_LUMA, DARK_INK,
} from '../src/ledColor.js'
import { hexToRgb } from '../src/ledboxProtocol.js'
import { toSections, toBreakSections, toCountdownSections, toIdleSections, toClubIdleSections } from '../src/volleyballMapper.js'
import { toBeachSections } from '../src/beachMapper.js'
import { toSimpleSections } from '../src/simpleMapper.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PRESETS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#14b8a6',
  '#0ea5e9', '#3b82f6', '#2563eb', '#6366f1', '#a855f7', '#ec4899', '#ffffff', '#111827']
const rgbOf = (hex) => parseRgb(hexToRgb(hex))
const val = (secs, name, attrib) => (secs.find((s) => s.name === name && s.value.attrib === attrib) || { value: {} }).value.value
const B40 = { brightness: 40 }

console.log('\n[1] the panel model matches the driver')
{
  eq(cie1931(255, 40), 230, 'white at brightness 40 drives 230/2047 (about 11 % luminance)')
  eq(whiteLevel(40), 14, 'which is 14 PWM levels with pwm_bits 7')
  eq(panelLevels(rgbOf('#111827'), 40), [0, 0, 0], '#111827 at 40: 0/0/0 — off')
  eq(panelLevels(rgbOf('#111827'), 75), [0, 1, 1], '#111827 at 75: 0/1/1')
  eq(panelLevels(rgbOf('#111827'), 100), [0, 1, 2], '#111827 at 100: 0/1/2')
  eq(panelLevels(rgbOf('#2563eb'), 40), [0, 2, 12], '#2563eb at 40: 0/2/12')
  const firstLit = (b) => { let c = 0; while (channelLevel(c, b) === 0) c++; return c }
  eq([firstLit(20), firstLit(40), firstLit(100)], [88, 44, 18], 'the dimmest channel that lights at all: 88 / 44 / 18 at brightness 20 / 40 / 100')
  eq(panelLevels([255, 69, 0], 20).map((l) => l << 4), [48, 0, 0], 'orange 255,69,0 shows as pure red (48,0,0) at brightness 20')
  eq(panelLevels([255, 69, 0], 40).map((l) => l << 4), [224, 16, 0], '…and as (224,16,0) at 40')
  eq([darkFloor(10), darkFloor(20), darkFloor(40), darkFloor(100)], [1, 1, 3, 3], 'dark = under 3 levels, or under a fifth of white on a dimmer panel')
}

console.log('\n[2] which colours are dark on the glass')
{
  for (const b of [20, 40, 60, 100]) {
    ok(isDark(rgbOf('#111827'), b) && isDark([0, 0, 0], b), `brightness ${b}: #111827 and #000000 are dark`)
    const dark = PRESETS.filter((h) => h !== '#111827' && isDark(rgbOf(h), b))
    eq(dark, [], `brightness ${b}: no other preset is`)
  }
  ok(isDark(rgbOf('#555555'), 40) && !isDark(rgbOf('#808080'), 40), 'a mid grey is the boundary at 40: #555555 dark, #808080 not')
  ok(!isDark(rgbOf('#1e3a8a'), 40), 'navy #1e3a8a lights (0/1/4), so it is dim but not dark')
}

console.log('\n[3] text')
{
  for (const px of [12, 18, 26, 55]) eq(textColor('17,24,39', px, B40), DARK_INK, `#111827 at ${px} px → light grey`)
  eq(textColor('0,0,0', 55, B40), DARK_INK, '#000000 digits → light grey')
  eq(textColor('37,99,235', 55, B40), '37,99,235', 'big #2563eb digits keep the exact colour')
  const small = textColor('37,99,235', 18, B40)
  ok(small !== '37,99,235' && panelLuma(parseRgb(small), 40) >= SMALL_TEXT_LUMA, `small #2563eb is lifted to ${small} (luma ${panelLuma(parseRgb(small), 40).toFixed(2)})`)
  // "Just enough": the step before it would not have read.
  const lifted = parseRgb(small), base = [37, 99, 235]
  const t = (lifted[2] - base[2]) / (255 - base[2])
  const before = base.map((c) => Math.round(c + (255 - c) * (t - 0.05)))
  ok(panelLuma(before, 40) < SMALL_TEXT_LUMA, `and no further than needed (one 5 % step less gives ${panelLuma(before, 40).toFixed(2)})`)
  ok(parseRgb(small)[2] > parseRgb(small)[0] && parseRgb(small)[2] > parseRgb(small)[1], 'it is still blue')
  eq(textColor('37,99,235', SMALL_TEXT_PX + 1, B40), '37,99,235', `${SMALL_TEXT_PX + 1} px is big`)
  ok(textColor('37,99,235', SMALL_TEXT_PX, B40) !== '37,99,235', `${SMALL_TEXT_PX} px is small (the match layout's set count)`)
  const changed = PRESETS.filter((h) => textColor(hexToRgb(h), 18, B40) !== hexToRgb(h))
  eq(changed, ['#2563eb', '#6366f1', '#111827'], 'at 40, small text changes only for #2563eb, #6366f1 and #111827')
  eq(textColor('0,0,255', 18, B40), '89,89,255', 'pure blue small text → 89,89,255')
  eq(textColor('255,0,0', 18, B40), '255,0,0', 'pure red is the yardstick and is left alone')
  eq(textColor('255,200,50', 17, B40), '255,200,50', 'club gold is left alone')
  eq(textColor('red', 18, B40), 'red', 'anything that is not r,g,b passes through')
  eq(textColor('17,24,39', 18, { brightness: 0 }), '17,24,39', 'brightness 0 (panel off): nothing to floor')
}

console.log('\n[4] borders and serve bars')
{
  eq(edgeColor('17,24,39', B40), '70,98,160', '#111827 border keeps its hue, scaled to 70,98,160')
  ok(!isDark([70, 98, 160], 40) && !isDark([70, 98, 160], 20), 'which lights at 20 and 40')
  eq(edgeColor('85,85,85', B40), '160,160,160', 'a dark grey border becomes a lit grey')
  eq(edgeColor('37,99,235', B40), '37,99,235', 'a colour that lights keeps its exact border')
  eq(edgeColor('0,0,0', B40), '0,0,0', "'0,0,0' is the mappers' hidden box, never lifted")
  eq(edgeColor('30,30,30', B40), '30,30,30', "'30,30,30' is the unlit serve bar, never lifted")
}

console.log('\n[5] whole paints from the mappers')
{
  const dark = {
    side_a: 'left', team_a_short: 'NAVY', team_a_color: '#111827', team_b_short: 'WHITE', team_b_color: '#ffffff',
    points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0, timeouts_a: 2, subs_a: 5, serving_team: 'left',
  }
  const raw = toSections(dark)
  const snapshot = JSON.stringify(raw)
  const out = ledSafeSections(raw, { layout: 'volleyball_matchscore_02', brightness: 40 })
  ok(JSON.stringify(raw) === snapshot, 'the mapper output is not mutated (the console mirror is built from it)')
  for (const n of ['team1', 'score1', 'set1']) eq(val(out, n, 'color'), DARK_INK, `${n} of the dark team → light grey`)
  eq(val(out, 'bg_score1', 'bordercolor'), '70,98,160', 'its box border → lifted navy')
  eq(val(out, 'serve1', 'color'), '70,98,160', 'its serve bar → lifted navy')
  eq(val(out, 'bg_score1', 'color'), '0,0,0', 'the box fill stays black')
  for (const n of ['team2', 'score2', 'set2']) eq(val(out, n, 'color'), '255,255,255', `${n} of the white team untouched`)
  eq(val(out, 'serve2', 'color'), '30,30,30', 'the unlit serve bar stays unlit')
  eq(val(out, 'timeout1', 'color'), val(raw, 'timeout1', 'color'), 'counter colours (limit red) untouched')
  eq(val(out, 'sub1', 'color'), val(raw, 'sub1', 'color'), 'sub counter (amber) untouched')
  eq(out.length, raw.length, 'nothing added or dropped')

  const stock = { ...dark, team_a_color: '#ef4444', team_b_color: '#2563eb' }
  const s2 = ledSafeSections(toSections(stock), { layout: 'volleyball_matchscore_02', brightness: 40 })
  eq(val(s2, 'score2', 'color'), '37,99,235', 'blue score digits (55 px) exact')
  eq(val(s2, 'bg_score2', 'bordercolor'), '37,99,235', 'blue border exact')
  ok(val(s2, 'team2', 'color') !== '37,99,235' && val(s2, 'set2', 'color') === val(s2, 'team2', 'color'), `blue name and set count (small) lifted together → ${val(s2, 'team2', 'color')}`)
  eq(['team1', 'score1', 'set1', 'bg_score1'].map((n) => val(s2, n, n === 'bg_score1' ? 'bordercolor' : 'color')), Array(4).fill('239,68,68'), 'red reads at every size and stays exact')
  const allRed = { ...stock, team_b_color: '#ef4444' }
  const same = toSections(allRed)
  ok(ledSafeSections(same, { layout: 'volleyball_matchscore_02', brightness: 40 }) === same, 'nothing to change → the very same array back')

  const big = ledSafeSections(toSections({ ...stock, team_b_short: 'ZUG' }, { matchFontMaxRight: 30 }), { layout: 'volleyball_matchscore_02', brightness: 40 })
  eq(val(big, 'team2', 'fontsize'), '30', 'a short name the operator made big is sent at 30 px')
  eq(val(big, 'team2', 'color'), '37,99,235', '…and, read from that same write, keeps the exact colour')

  const cd = ledSafeSections(toCountdownSections(stock, { timerText: '30', label: 'TO' }), { layout: 'volleyball_matchscore_timeout_02', brightness: 40 })
  ok(val(cd, 'score2', 'color') !== '37,99,235', 'the vendor countdown draws scores at 22 px, so there blue is lifted')
  const br = ledSafeSections(toBreakSections(stock, { timerText: '0:30', label: 'TIME OUT', team: 'X' }), { layout: 'kscw_break', brightness: 40 })
  eq(val(br, 'score2', 'color'), '37,99,235', 'the break screen draws them at 55 px: exact')
  const warm = ledSafeSections(toBreakSections(dark, { timerText: '9:59', label: 'WARM UP', content: 'none' }), { layout: 'kscw_break', brightness: 40 })
  eq([val(warm, 'bg_score1', 'bordercolor'), val(warm, 'bg_score2', 'bordercolor')], ['0,0,0', '0,0,0'], 'warm-up keeps its hidden boxes hidden')

  const idle = ledSafeSections(toIdleSections(dark), { layout: 'volleyball_matchscore_02', brightness: 40 })
  eq(val(idle, 'team1', 'color'), DARK_INK, 'VS screen: the dark name is light grey too')
  const crest = ledSafeSections(toClubIdleSections(dark, { clubName: 'WHITE' }), { layout: 'kscw_idle', brightness: 40 })
  eq([val(crest, 'team1', 'color'), val(crest, 'team2', 'color')], [DARK_INK, '255,200,50'], 'crest idle: dark opponent light grey, club gold untouched')
  const beach = ledSafeSections(toBeachSections({ ...dark, serve_player: 2 }), { layout: 'beach_matchscore', brightness: 40 })
  eq([val(beach, 'serveplr1', 'color'), val(beach, 'score1', 'color')], [DARK_INK, DARK_INK], 'beach: serve-player digit and score of a dark pair light grey')
  const simple = toSimpleSections(dark)
  ok(ledSafeSections(simple, { layout: 'volleyball_matchscore_02', brightness: 40 }) === simple, 'the simple scoreboard (white, hidden boxes) is never touched')
  ok(ledSafeSections(raw, { layout: 'volleyball_matchscore_02', brightness: 0 }) === raw, 'brightness 0: sent as the mapper made it')
}

console.log('\n[6] the size table agrees with the layout XML in the repo')
{
  const dirs = ['layouts', 'firmware/openscore/layout', 'firmware/openscore/layouts-beach', 'firmware/openscore/layouts-basketball']
  const sizes = new Map() // layout name -> Map(section -> px)
  for (const d of dirs) {
    const abs = path.join(root, d)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.xml'))) {
      const xml = fs.readFileSync(path.join(abs, f), 'utf8')
      const name = (xml.match(/<layout\s+name="([^"]+)"/) || [])[1]
      if (!name) continue
      const m = sizes.get(name) || new Map()
      for (const tag of xml.match(/<section\b[^>]*>/g) || []) {
        const a = Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
        if (a.type === 'text' && a.fontsize) m.set(a.name, Number(a.fontsize))
      }
      sizes.set(name, m)
    }
  }
  let checked = 0
  for (const [layout, table] of Object.entries(LAYOUT_TEXT_PX)) {
    const xml = sizes.get(layout)
    if (!xml) continue
    for (const [section, px] of Object.entries(table)) {
      if (!xml.has(section)) { ok(false, `${layout}: ${section} is in the table but not in the XML`); continue }
      const want = xml.get(section) <= SMALL_TEXT_PX
      if ((px <= SMALL_TEXT_PX) !== want) ok(false, `${layout}.${section}: table ${px} px, XML ${xml.get(section)} px — small/big disagree`)
      else checked++
    }
  }
  ok(checked >= 30, `${checked} team-coloured sections: the table and the XML agree on small vs big`)
  eq([sectionPx('volleyball_matchscore_02', 'score1'), sectionPx('volleyball_matchscore_02', 'set1'), sectionPx('nope', 'score1'), sectionPx('nope', 'team1')],
    [55, 26, 55, 18], 'lookups, and the fallback for an unknown layout (scores big, the rest small)')
}

console.log('\n[7] end to end: client → mock board')
{
  const mock = new MockLedbox()
  const { port } = await mock.listen(0)
  const client = new LedboxClient({ host: '127.0.0.1', port, reconnectMs: 0, pulseMs: 400, pulseIntervalMs: 20 })
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))
  const ready = new Promise((r) => client.once('ready', r))
  client.connect()
  await ready; await settle()
  const state = {
    side_a: 'left', team_a_short: 'NAVY', team_a_color: '#111827', team_b_short: 'BLUE', team_b_color: '#2563eb',
    points_a: 3, points_b: 4, sets_won_a: 0, sets_won_b: 1, serving_team: 'left',
  }
  await client.pushState(state); await settle()
  eq(client.brightness, 40, 'the client defaults to the board\'s brightness 40')
  eq([mock.color('team1'), mock.color('score1'), mock.screen.bg_score1.bordercolor], [DARK_INK, DARK_INK, '70,98,160'], 'the board gets the dark team floored')
  eq(mock.color('score2'), '37,99,235', 'and the blue digits exact')
  eq(val(client.mapper.toSections(state), 'score1', 'color'), '17,24,39', 'the mapper (what /api/board and the console mirror read) still says #111827')

  client.setLimits({ brightness: 100 }); await settle()
  eq(client.brightness, 100, 'setLimits takes the brightness')
  const at100 = mock.color('team2')
  ok(at100 !== '37,99,235' && at100 !== textColor('37,99,235', 18, B40), `and the repaint re-floors at it (small blue → ${at100})`)
  client.setLimits({ brightness: 40 }); await settle()

  client.pulse('score1', 400, hexToRgb('#111827'))
  await settle(600)
  eq(mock.color('score1'), DARK_INK, 'a blink in the dark team colour settles on light grey, not back on black')
  client.disconnect()
  await new Promise((r) => mock.server.close(r))
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
