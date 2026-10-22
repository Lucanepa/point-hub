// The panel test: Diagnostics ▸ Panel test, the volunteer's self-check of the LED hardware.
//
// A dead module, a swapped ribbon or a missing colour line on a HUB75 panel is otherwise found
// mid-match, by the spectators. The test screen numbers the C0270's three 64x64 modules 1 | 2 | 3
// from the left, frames each one in white and puts red, green, blue and white bars under each
// number; a "Test horn" button sounds the horn once, unless Settings has it off.
//
// What is locked down here:
//   [1] the layout file: it ships with the deploy (*_kscw_*.xml) and its geometry really is three
//       64-pixel modules, each with its own frame, number and four bars inside it;
//   [2] the mapper writes exactly that layout's sections — the board aborts a whole SetSections on
//       the first section its layout lacks, so one stray name would paint nothing at all;
//   [3] end to end: the test goes back to exactly the screen it replaced (the held clock, the
//       scoreboard), by its timer, by "Back to normal now", and by anything else taking the panel;
//       it is refused during a match or a countdown; the horn honours its setting; the PIN gates it;
//   [4] it cannot strand the panel: a reconnect, a test layout left up with no test running (on the
//       scoreboard and on idle), the idle ticker not fighting a running test, a board without the
//       layout;
//   [5] the console card, the hall guide and the README.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'
import { toTestSections, TEST_BARS, TEST_MODULES } from '../src/volleyballMapper.js'
import { SPORTS } from '../src/sports.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_FILE = '36_kscw_test.xml'
const xml = fs.readFileSync(path.join(root, 'layouts', TEST_FILE), 'utf8')
const sectionsOf = (file) => [...fs.readFileSync(path.join(root, 'layouts', file), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)
// Every section of the test layout with its attributes, numbers as numbers.
const sections = [...xml.matchAll(/<section ([^>]*)>([^<]*)<\/section>/g)].map((m) => {
  const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
  for (const k of ['x', 'y', 'width', 'height', 'fontsize']) if (k in a) a[k] = Number(a[k])
  return { ...a, text: m[2] }
})
const byName = Object.fromEntries(sections.map((s) => [s.name, s]))
const rgb = (s) => String(s).replace(/\s+/g, '')
const valOf = (secs, name, attrib) => {
  const hits = secs.filter((s) => s.name === name && s.value.attrib === attrib)
  return hits.length ? hits[hits.length - 1].value.value : undefined
}

console.log('[1] the layout: three 64-pixel modules, each framed, numbered and barred, and it ships')
{
  ok(/^\d+_kscw_[\w-]+\.xml$/.test(TEST_FILE), `${TEST_FILE} is a *_kscw_*.xml file`)
  const deploy = fs.readFileSync(path.join(root, 'deploy-board.sh'), 'utf8')
  ok(deploy.includes('"$REPO"/layouts/*_kscw_*.xml'), 'which is the glob deploy-board.sh copies to the panel\'s layout folder')
  ok(/<layout name="kscw_test"/.test(xml), 'its layout is named kscw_test')
  for (const key of Object.keys(SPORTS)) {
    eq(SPORTS[key].layouts.testLayout, 'kscw_test', `${key} uses it (the test is about the hardware, not the sport)`)
    ok(typeof SPORTS[key].mapper.toTestSections === 'function', `${key}'s mapper can paint it`)
  }
  ok(sections.every((s) => s.x >= 0 && s.y >= 0 && s.x <= 192 && s.y <= 64), 'every section sits on the 192x64 panel')
  for (let m = 1; m <= TEST_MODULES; m++) {
    const x0 = (m - 1) * 64
    const f = byName[`frame${m}`]
    ok(f && f.type === 'rectangle' && f.x === x0 && f.y === 0 && f.width === 64 && f.height === 64,
      `frame${m} is module ${m}'s own 64x64 square at x ${x0}`)
    ok(f && rgb(f.bordercolor) === '255,255,255' && rgb(f.color) === '0,0,0', `frame${m} is a white border on black`)
    const n = byName[`mod${m}`]
    ok(n && n.type === 'text' && n.text === String(m) && n.align === 'center' && n.x === x0 + 32,
      `mod${m} reads "${m}", centred on module ${m} (x ${x0 + 32})`)
    const bars = ['r', 'g', 'b', 'w'].map((c) => byName[`bar${m}${c}`])
    ok(bars.every(Boolean), `module ${m} has its four bars`)
    ok(bars.every((b) => b && b.x > x0 && b.x + b.width <= x0 + 63 && b.y > 0 && b.y + b.height <= 63),
      `module ${m}'s bars are inside its frame, clear of the border`)
    ok(bars.every((b, i) => i === 0 || (bars[i - 1] && b.x >= bars[i - 1].x + bars[i - 1].width)), `and do not overlap each other`)
    ok(bars.every((b) => b && b.y >= 30), 'and sit below the number')
    ok(['r', 'g', 'b', 'w'].every((c) => rgb(byName[`bar${m}${c}`].color) === TEST_BARS[c]), 'their colours in the file match the mapper\'s')
  }
  // Drawing order: the black-filled frames first, so they cannot paint over a number or a bar.
  const idx = (n) => sections.findIndex((s) => s.name === n)
  ok(['frame1', 'frame2', 'frame3'].every((f) => sections.every((s, i) => s.name.startsWith('frame') || i > idx(f))),
    'the frames come first in the file, so nothing is drawn under their black fill')
}

console.log('\n[2] the mapper writes that layout, all of it and nothing else')
{
  const secs = toTestSections()
  const names = new Set(secs.map((s) => s.name))
  const inFile = new Set(sectionsOf(TEST_FILE))
  const stray = [...names].filter((n) => !inFile.has(n))
  ok(stray.length === 0, `every section it writes is in the layout${stray.length ? ` — not ${stray.join(', ')}` : ''}`)
  const missed = [...inFile].filter((n) => !names.has(n))
  ok(missed.length === 0, `and every section of the layout is written (the board keeps old values)${missed.length ? ` — missed ${missed.join(', ')}` : ''}`)
  eq([1, 2, 3].map((m) => valOf(secs, `mod${m}`, 'text')).join(' | '), '1 | 2 | 3', 'the modules are numbered left to right')
  eq(valOf(secs, 'bar2b', 'color'), TEST_BARS.b, 'module 2\'s blue bar is blue')
  eq(valOf(secs, 'frame3', 'bordercolor'), '255,255,255', 'module 3\'s frame is white')
  ok(secs.every((s) => !Array.isArray(s.value)), 'in the board\'s one-attribute-per-entry WRITE shape')
  // The white bar is the one block of all three channels; it stays at half drive.
  ok(TEST_BARS.w.split(',').every((v) => Number(v) <= 128), `the white bar is at half drive or less (${TEST_BARS.w})`)
}

console.log('\n[3] end to end: back to exactly what was there, refused mid-match, horn and PIN')
{
  const mock = new MockLedbox({
    layouts: {
      kscw_test: sectionsOf(TEST_FILE),
      kscw_clock: sectionsOf('33_kscw_clock.xml'),
      kscw_crest: sectionsOf('32_kscw_crest.xml'),
      kscw_idle: sectionsOf('30_kscw_idle.xml'),
    },
  })
  const commands = []
  mock.on('command', (m) => commands.push(m))
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-paneltest-'))
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
    let pin = ''
    const post = (p, body, headers = {}) => fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(pin ? { 'x-scorer-pin': pin } : {}), ...headers }, body: JSON.stringify(body || {}),
    })
    const status = async () => (await fetch(base + '/api/status')).json()
    await sleep(300)

    // a) From the held clock, and back to it by the timer.
    await post('/api/game', { choice: 'clock' })
    await sleep(150)
    eq(mock.currentLayout, 'kscw_clock', 'the board starts on the held clock')
    let r = await post('/api/paneltest', { action: 'start', seconds: 1 })
    let body = await r.json()
    eq(r.status, 200, 'POST /api/paneltest {start} -> 200')
    ok(body.ok === true && Number.isFinite(body.endsAt), 'and says when it ends')
    await sleep(100)
    eq(mock.currentLayout, 'kscw_test', 'the panel is on the test screen')
    eq([1, 2, 3].map((m) => mock.text(`mod${m}`)).join(' | '), '1 | 2 | 3', 'numbering the modules 1 | 2 | 3')
    eq(mock.color('bar1r'), TEST_BARS.r, 'with its colour bars painted')
    let st = await status()
    ok(st.ledbox.test && st.ledbox.test.remainingMs > 0 && st.ledbox.test.remainingMs <= 1000, `/api/status says a test is up (${st.ledbox.test && st.ledbox.test.remainingMs} ms left)`)
    ok(st.ledbox.idle === true && st.ledbox.clockHeld === true, 'and the held clock is still what the board means to show')
    await sleep(1300)
    eq(mock.currentLayout, 'kscw_clock', 'time up: back on the clock by itself')
    st = await status()
    eq(st.ledbox.test, null, 'and /api/status says the test is over')
    ok(st.ledbox.clockHeld === true, 'the clock is still held — the test never touched it')

    // b) A second start while one runs keeps "back to" (never the test screen itself).
    await post('/api/paneltest', { action: 'start', seconds: 1 })
    await sleep(300)
    await post('/api/paneltest', { action: 'start', seconds: 1 })
    await sleep(1400)
    eq(mock.currentLayout, 'kscw_clock', 'restarted mid-test, it still goes back to the clock, not to the test screen')

    // c) From the scoreboard at 0-0, back by "Back to normal now".
    await post('/api/manual', {})
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW' } })
    await post('/api/action', { action: { type: 'team', side: 'right', short: 'VOLZ' } })
    await sleep(200)
    eq(mock.currentLayout, 'volleyball_matchscore_02', 'the scoreboard is up at 0-0 with names')
    r = await post('/api/paneltest', { action: 'start' })
    body = await r.json()
    ok(r.status === 200 && body.ok && body.seconds === 20, 'a fresh 0-0 is not a match in play: allowed, for the default 20 s')
    await sleep(100)
    eq(mock.currentLayout, 'kscw_test', 'test screen up')
    // A settings save repaints idle and the scoreboard; it must not end the test.
    await post('/api/settings', { totalSubs: 6 })
    await sleep(150)
    eq(mock.currentLayout, 'kscw_test', 'a settings save does not take the test down')
    r = await post('/api/paneltest', { action: 'stop' })
    body = await r.json()
    ok(r.status === 200 && body.stopped === true, '"Back to normal now" -> 200, stopped')
    await sleep(150)
    eq(mock.currentLayout, 'volleyball_matchscore_02', 'the scoreboard is back')
    eq(mock.text('team1'), 'KSCW', 'with its names repainted')
    r = await post('/api/paneltest', { action: 'stop' })
    body = await r.json()
    ok(r.status === 200 && body.stopped === false, 'a second "back" is not an error (another tablet may have tapped it)')

    // d) Anything that paints the panel ends the test first: a point is on the glass at once.
    await post('/api/paneltest', { action: 'start' })
    await sleep(100)
    eq(mock.currentLayout, 'kscw_test', 'test screen up again')
    r = await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    eq(r.status, 200, 'a point scored during the test -> 200')
    await sleep(200)
    eq(mock.currentLayout, 'volleyball_matchscore_02', 'the point took the panel back to the scoreboard')
    eq(mock.text('score1'), '1', 'and it shows 1-0 now, not 20 s later')
    eq((await status()).ledbox.test, null, 'the test is over')

    // e) Refused while a match is being played.
    r = await post('/api/paneltest', { action: 'start' })
    body = await r.json()
    eq(r.status, 409, 'at 1-0 the test is refused (409)')
    ok(/match is being played/i.test(body.error || ''), `in words: "${body.error}"`)
    r = await post('/api/paneltest', { action: 'horn' })
    eq(r.status, 409, 'and so is the horn — a horn stops play')
    await sleep(100)
    eq(mock.currentLayout, 'volleyball_matchscore_02', 'the scoreboard never left')

    // f) Refused while a countdown runs.
    await post('/api/countdown', { seconds: 30, label: 'TIME OUT', content: 'full', side: 'left' })
    await sleep(150)
    r = await post('/api/paneltest', { action: 'start' })
    body = await r.json()
    ok(r.status === 409 && /countdown/i.test(body.error || ''), `during a countdown: 409, "${body.error}"`)
    await post('/api/countdown/stop', { expired: false })
    await sleep(150)

    // g) The horn, between matches: once, honouring the setting.
    await post('/api/game', { choice: 'clock' })
    await sleep(150)
    const hornsBefore = mock.horns || 0
    r = await post('/api/paneltest', { action: 'horn' })
    body = await r.json()
    ok(r.status === 200 && body.ok === true && body.horn === 'sounded', 'with the clock up the horn test sounds')
    await sleep(100)
    eq((mock.horns || 0) - hornsBefore, 1, 'the board got exactly one Horn command')
    const horn = commands.filter((c) => c.cmd === 'Horn').pop()
    eq(horn && horn.value && horn.value.times, 1, 'for one blast')
    await post('/api/settings', { hornOnCountdownEnd: false })
    r = await post('/api/paneltest', { action: 'horn' })
    body = await r.json()
    ok(r.status === 200 && body.ok === false && body.horn === 'off', 'with the horn switched off in Settings it does not sound')
    ok(/Settings/.test(body.error || ''), `and says where to switch it on: "${body.error}"`)
    await sleep(100)
    eq((mock.horns || 0) - hornsBefore, 1, 'no second Horn command reached the board')
    await post('/api/settings', { hornOnCountdownEnd: true })

    // h) The scorer PIN gates it like every write — "back to normal" included.
    await post('/api/settings', { scorerPin: '2468' })
    r = await post('/api/paneltest', { action: 'start' })
    eq(r.status, 403, 'with a PIN set, no PIN -> 403')
    pin = '2468'
    r = await post('/api/paneltest', { action: 'start', seconds: 20 })
    eq(r.status, 200, 'with the PIN -> 200')
    await sleep(100)
    pin = ''
    r = await post('/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
    eq(r.status, 403, 'a refused write (no PIN) is refused…')
    await sleep(100)
    eq(mock.currentLayout, 'kscw_test', '…and does not cut the test short either')
    pin = '2468'
    r = await post('/api/paneltest', { action: 'stop' })
    eq(r.status, 200, 'back to normal with the PIN')
    await sleep(150)
    eq(mock.currentLayout, 'kscw_clock', 'and the clock is back')

    // i) Bad input.
    r = await post('/api/paneltest', { action: 'explode' })
    eq(r.status, 400, 'an unknown action -> 400')
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close()
    await mock.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('\n[4] it cannot strand the panel')
{
  const STATE = {
    side_a: 'left', team_a_short: 'KSCW', team_b_short: 'VOLZ', team_a_color: '#2563eb', team_b_color: '#ef4444',
    points_a: 3, points_b: 2, sets_won_a: 0, sets_won_b: 0, serving_team: 'left',
  }
  const KSCW = {
    kscw_test: sectionsOf(TEST_FILE),
    kscw_clock: sectionsOf('33_kscw_clock.xml'),
    kscw_crest: sectionsOf('32_kscw_crest.xml'),
    kscw_idle: sectionsOf('30_kscw_idle.xml'),
  }
  const rig = async (clientOpts = {}) => {
    const mock = new MockLedbox({ layouts: KSCW })
    const addr = await mock.listen(0, '127.0.0.1')
    const client = new LedboxClient({ hosts: ['127.0.0.1'], port: addr.port, reconnectMs: 0, layoutGuardMs: 0, idleTickMs: 0, ...clientOpts })
    client.on('error', () => {})
    await new Promise((res) => { client.once('ready', res); client.connect() })
    await sleep(50)
    return { mock, client, done: async () => { client.disconnect(); await mock.close() } }
  }

  // a) The board drops the connection mid-test: the reconnect's own screen is the way back.
  {
    const { mock, client, done } = await rig({ reconnectMs: 100 })
    try {
      await client.showIdle(false)
      await client.pushState(STATE)
      const r = await client.showTest({ ms: 10000 })
      ok(r.ok && mock.currentLayout === 'kscw_test', 'test screen up on the scoreboard')
      client.socket.destroy()
      await sleep(500)
      ok(client.ready, 'the client reconnected')
      eq(client.testView(), null, 'the test did not survive the dropped connection')
      eq(mock.currentLayout, 'volleyball_matchscore_02', 'the reconnect put the scoreboard back')
      eq(mock.text('score1'), '3', 'with the score repainted')
    } finally { await done() }
  }

  // b) The test layout left up with no test running (on the scoreboard): the layout guard takes it down.
  {
    const { mock, client, done } = await rig({ layoutGuardMs: 100 })
    try {
      await client.showIdle(false)
      await client.pushState(STATE)
      // Nothing in this codebase does this; it stands in for whatever might.
      await client.setLayoutIfNeeded('kscw_test')
      eq(mock.currentLayout, 'kscw_test', 'a stray test screen on the panel')
      await sleep(400)
      eq(mock.currentLayout, 'volleyball_matchscore_02', 'the layout guard replaced it with the scoreboard')
    } finally { await done() }
  }

  // c) …and on idle: the idle ticker does.
  {
    const { mock, client, done } = await rig({ idleTickMs: 50 })
    try {
      await client.showIdle(true, { screen: 'clock' })
      eq(mock.currentLayout, 'kscw_clock', 'on the held clock')
      await client.setLayoutIfNeeded('kscw_test')
      await sleep(300)
      eq(mock.currentLayout, 'kscw_clock', 'a stray test screen over idle is replaced by the idle ticker')
    } finally { await done() }
  }

  // d) The idle ticker does not fight a test that IS running, with an operator watching.
  {
    const { mock, client, done } = await rig({ idleTickMs: 50 })
    try {
      client.noteViewer()
      await client.showIdle(true)
      await sleep(100)
      eq(mock.currentLayout, 'kscw_clock', 'idle with a viewer: the clock')
      await client.showTest({ ms: 700 })
      await sleep(400)
      eq(mock.currentLayout, 'kscw_test', 'the ticker leaves a running test alone')
      client.noteViewer()
      await sleep(600)
      eq(mock.currentLayout, 'kscw_clock', 'and the test then goes back to the clock by itself')
    } finally { await done() }
  }

  // e) A board without the layout: refused, nothing changes, nothing left running.
  {
    const { mock, client, done } = await rig({ testLayout: 'kscw_test_absent' })
    try {
      await client.showIdle(false)
      await client.pushState(STATE)
      const r = await client.showTest({ ms: 5000 })
      ok(!r.ok && r.reason === 'missing', `a board without the layout says so (${r.reason})`)
      eq(client.testView(), null, 'no test is left running')
      await sleep(100)
      eq(mock.currentLayout, 'volleyball_matchscore_02', 'and the scoreboard stays up')
      const again = await client.showTest({ ms: 5000 })
      ok(!again.ok && again.reason === 'missing', 'asked again, it answers from memory instead of asking the board every time')
    } finally { await done() }
  }

  // f) Another screen taking the panel cancels the test without its restore painting over it.
  {
    const { mock, client, done } = await rig()
    try {
      await client.showIdle(false)
      await client.pushState(STATE)
      await client.showTest({ ms: 400 })
      await client.showResult({ winner: 'KSCW WINS', score: '3 - 1', history: '' })
      eq(client.testView(), null, 'the result screen cancelled the test')
      await sleep(600)
      eq(mock.currentLayout, 'kscw_result', 'and the test\'s timer, had it survived, did not take the result down')
    } finally { await done() }
  }
}

console.log('\n[5] the console, the hall guide and the README')
{
  const index = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
  const diag = (index.match(/<section id="tab-diag"[\s\S]*?<\/section>/) || [''])[0]
  ok(/id="dcPanel"/.test(diag), 'Diagnostics has a Panel test card')
  ok(/id="ptStart"/.test(diag) && /id="ptHorn"/.test(diag), 'with "Show test screen" and "Test horn"')
  ok(/id="ptBack"[^>]*hidden/.test(diag), 'and "Back to normal now", hidden until a test is up')
  ok(/1 \| 2 \| 3/.test(diag), 'the card tells the volunteer what the numbers mean')
  ok(/20 seconds/.test(diag), 'and that it goes back by itself')
  const js = (index.match(/<script>([\s\S]*?)<\/script>/) || ['', ''])[1]
  for (const a of ['start', 'stop', 'horn']) ok(new RegExp(`panelTest\\("${a}"`).test(js), `the card posts ${a}`)
  ok(/postJSON\("\/api\/paneltest"/.test(js), 'to /api/paneltest, with the PIN like every write')
  ok(/test\.remainingMs/.test(js) && !/test\.endsAt/.test(js), 'the countdown on the card uses remainingMs — the board has no battery clock')
  ok(/renderPanelTest\(st\.ledbox\.test\)/.test(js), 'the card follows /api/status, so a test from another tablet shows too')
  const guide = fs.readFileSync(path.join(root, 'docs', 'hall-guide.template.html'), 'utf8')
  ok(/Panel test/.test(guide) && /1 \| 2 \| 3/.test(guide), 'the hall guide\'s troubleshooting points at it')
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  ok(/\/api\/paneltest/.test(readme), 'README documents /api/paneltest')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — panel-test-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
