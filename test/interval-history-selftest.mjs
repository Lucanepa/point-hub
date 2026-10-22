// The finished sets on the set-interval screen (Settings ▸ Display ▸ Finished sets on the interval
// screen, off by default).
//
// Per-set scores used to appear only on the final result screen; the interval showed the set score
// and the clock. Now, when switched on, two short lines under the interval clock carry every
// finished set, the left team's score first. A static line on purpose — not a rotating carousel:
// the hall and the referees read the interval clock, and frames changing under it are motion for
// the camera.
//
// What is locked down here:
//   [1] the lines: two sets to a line, panel order (side_a respected), the last four sets at most,
//       junk dropped, fitted to the 64-pixel centre column;
//   [2] the layout: hist1/hist2 sit in kscw_break's centre column below the clock, and the mapper
//       writes exactly those two sections;
//   [3] end to end: off by default and then the board hears nothing new; on, the interval shows the
//       sets in the order the boxes below them are in (after the change of ends), a timeout blanks
//       them;
//   [4] a board whose kscw_break predates the two sections: the interval screen still paints, the
//       refusal is asked once per connection, not once a second;
//   [5] the console and the README.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { breakHistoryLines, toBreakHistorySections, fitFontSize } from '../src/volleyballMapper.js'
import { GLOBAL_DEFAULTS } from '../src/settings.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BREAK_FILE = '31_kscw_break.xml'
const sectionsOf = (file) => [...fs.readFileSync(path.join(root, 'layouts', file), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
const valOf = (secs, name, attrib) => {
  const hits = secs.filter((s) => s.name === name && s.value.attrib === attrib)
  return hits.length ? hits[hits.length - 1].value.value : undefined
}
const set = (a, b) => ({ a, b })

console.log('[1] the lines')
{
  eq(JSON.stringify(breakHistoryLines({ set_results: [] })), '["",""]', 'no finished set: both lines blank')
  eq(JSON.stringify(breakHistoryLines(null)), '["",""]', 'no state at all: blank too')
  eq(JSON.stringify(breakHistoryLines({ set_results: [set(25, 21)] })), '["25-21",""]', 'one set')
  eq(JSON.stringify(breakHistoryLines({ set_results: [set(25, 21), set(23, 25), set(25, 19)] })), '["25-21  23-25","25-19"]', 'two sets to a line')
  eq(JSON.stringify(breakHistoryLines({ set_results: [set(25, 21), set(23, 25), set(25, 19), set(21, 25)] })), '["25-21  23-25","25-19  21-25"]',
    'four sets — the most an interval ever has (it comes before set 5 at the latest)')
  eq(JSON.stringify(breakHistoryLines({ set_results: [set(1, 0), set(25, 21), set(23, 25), set(25, 19), set(21, 25)] })), '["25-21  23-25","25-19  21-25"]',
    'anything older than four sets is left off, not squeezed in')
  eq(breakHistoryLines({ side_a: 'right', set_results: [set(25, 21)] })[0], '21-25', 'team A on the right: the left team\'s score still comes first')
  eq(breakHistoryLines({ set_results: [null, set('x', 25), 'junk', set(25.4, -3)] })[0], '0-25  25-0', 'junk entries dropped, junk numbers made harmless')
  const wide = toBreakHistorySections({ set_results: [set(31, 29), set(29, 31), set(30, 28), set(28, 30)] })
  const size = Number(valOf(wide, 'hist1', 'fontsize'))
  ok(size >= 6 && size <= 9, `the widest likely lines get one size, ${size}px`)
  ok(fitFontSize('31-29  29-31', 62, { max: 9, min: 6 }) === size, 'which fits them in the 64px centre column')
  eq(valOf(wide, 'hist1', 'fontsize'), valOf(wide, 'hist2', 'fontsize'), 'both lines at the same size')
}

console.log('\n[2] the layout and what is written to it')
{
  const xml = fs.readFileSync(path.join(root, 'layouts', BREAK_FILE), 'utf8')
  const sec = (name) => {
    const m = new RegExp(`<section name="${name}"([^>]*)>`).exec(xml)
    return m ? Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]])) : null
  }
  for (const n of ['hist1', 'hist2']) {
    const s = sec(n)
    ok(s && s.type === 'text' && s.align === 'center' && Number(s.x) === 96, `${n} is centred on the centre column (x 96)`)
    ok(s && Number(s.y) >= 44 && Number(s.y) + 9 <= 64, `${n} sits below the clock and on the panel (y ${s && s.y})`)
  }
  ok(Number(sec('hist2').y) - Number(sec('hist1').y) >= 9, 'the two lines do not overlap')
  ok(xml.indexOf('name="hist1"') > xml.indexOf('name="timerbig"'), 'drawn after the clock')
  const names = new Set(toBreakHistorySections({ set_results: [set(25, 21)] }).map((s) => s.name))
  eq([...names].sort().join(','), 'hist1,hist2', 'the mapper writes those two sections and nothing else')
  eq(valOf(toBreakHistorySections(null), 'hist2', 'text'), '', 'and writes them blank rather than leaving the last match there')
}

console.log('\n[3] end to end: off by default, on in panel order, blank on a timeout')
{
  eq(GLOBAL_DEFAULTS.intervalHistory, false, 'off by default')
  const mock = new MockLedbox({ layouts: { kscw_break: sectionsOf(BREAK_FILE) } })
  const histWrites = []
  mock.on('command', (m) => {
    if (m.cmd === 'SetSections' && Array.isArray(m.value) && m.value.some((s) => s.name === 'hist1')) histWrites.push(m.value)
  })
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-interval-'))
  let app
  try {
    app = await startAppliance({
      stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxHost: '127.0.0.1', ledboxPort: addr.port,
      ledboxLayout: 'volleyball_matchscore_02', ledboxAlias: 'test', ledboxApiVersion: 2,
      reconnectMs: 0, mock: false, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const winSet = async (side) => { for (let i = 0; i < 25; i++) await post('/api/action', { action: { type: 'point', side, delta: 1 } }) }
    const interval = () => post('/api/countdown', { seconds: 180, label: 'INTERVAL', content: 'sets', swapFirst: true })
    await sleep(200)
    await post('/api/manual', {})
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW' } })
    await post('/api/action', { action: { type: 'team', side: 'right', short: 'VOLZ' } })

    // Set 1 to KSCW (left), 25-0. Off: the interval is the interval as it always was.
    await winSet('left')
    await interval()
    await sleep(1300)
    eq(mock.currentLayout, 'kscw_break', 'the set interval is on the panel')
    eq(mock.text('lbl'), 'INTERVAL', 'labelled INTERVAL')
    eq(histWrites.length, 0, 'switched off, the board is never sent the history lines')
    await post('/api/countdown/stop', { expired: false })
    await sleep(150)

    // On. Set 2 goes to VOLZ — on the LEFT now, after the change of ends.
    const r = await post('/api/settings', { intervalHistory: true })
    eq((await r.json()).intervalHistory, true, 'Settings ▸ Finished sets on the interval screen: on')
    await winSet('left')
    await interval()
    await sleep(400)
    eq(mock.currentLayout, 'kscw_break', 'the second interval is up')
    // After this interval's change of ends KSCW is on the left again: set 1 KSCW 25-0, set 2 KSCW 0-25.
    eq(mock.text('hist1'), '25-0  0-25', 'the finished sets, the left team\'s score first — the order of the boxes below')
    eq(mock.text('hist2'), '', 'one line is enough for two sets')
    eq(mock.text('timerbig'), '3:00', 'under the interval clock')
    const n = histWrites.length
    await sleep(1200)
    eq(histWrites.length, n, 'written once, not on every tick of the clock')
    await post('/api/countdown/stop', { expired: false })
    await sleep(150)

    // A timeout: no finished sets under its clock.
    await post('/api/countdown', { seconds: 30, label: 'TIME OUT', content: 'full', side: 'left' })
    await sleep(300)
    eq(mock.currentLayout, 'kscw_break', 'a timeout on the break screen')
    eq(mock.text('hist1'), '', 'shows no finished sets')
    await post('/api/countdown/stop', { expired: false })
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close()
    await mock.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('\n[4] a board whose kscw_break predates the two lines')
{
  const old = sectionsOf(BREAK_FILE).filter((n) => !n.startsWith('hist'))
  const mock = new MockLedbox({ layouts: { kscw_break: old } })
  let tries = 0
  mock.on('command', (m) => { if (m.cmd === 'SetSections' && Array.isArray(m.value) && m.value.some((s) => s.name === 'hist1')) tries++ })
  const addr = await mock.listen(0, '127.0.0.1')
  const client = new LedboxClient({ hosts: ['127.0.0.1'], port: addr.port, reconnectMs: 0, layoutGuardMs: 0, idleTickMs: 0, intervalHistory: true })
  client.on('error', () => {})
  try {
    await new Promise((res) => { client.once('ready', res); client.connect() })
    await client.pushState({ side_a: 'left', team_a_short: 'KSCW', team_b_short: 'VOLZ', sets_won_a: 1, sets_won_b: 0, set_results: [set(25, 21)] })
    for (let s = 180; s > 176; s--) await client.pushCountdown(s, 'INTERVAL', { content: 'sets' })
    eq(mock.currentLayout, 'kscw_break', 'the interval screen is up')
    eq(mock.text('lbl'), 'INTERVAL', 'and painted, label…')
    eq(mock.text('timerbig'), '2:57', '…and clock, tick after tick')
    eq(mock.text('score1'), '1', '…and the set score')
    eq(tries, 1, 'the refused lines were asked for once, not once a second')
    client.disconnect()
    await sleep(50)
    tries = 0
    await new Promise((res) => { client.once('ready', res); client.connect() })
    await client.pushCountdown(170, 'INTERVAL', { content: 'sets' })
    eq(tries, 1, 'and once again on the next connection (the panel may have been restarted with the new layout)')
  } finally {
    client.disconnect()
    await mock.close()
  }
}

console.log('\n[5] the console and the README')
{
  const index = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
  const settingsTab = (index.match(/<section id="tab-settings"[\s\S]*?<\/section>/) || [''])[0]
  ok(/<input type="checkbox" data-set="intervalHistory">/.test(settingsTab), 'Settings has the switch')
  ok(/Finished sets on the interval screen/.test(settingsTab), 'named for what the hall will see')
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  ok(/Finished sets on the interval/.test(readme) && /hist1/.test(readme), 'README documents it')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — interval-history-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
