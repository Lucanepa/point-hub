// The Point Hub board's hardware in the appliance (src/boardHardware.js and its routes): what each
// reading means to a scorer, the two lights, the per-module self-test, the board following its own
// OpenVolley, and above all that a board without the hardware (the C0270) sees none of it.
//
// A stand-in for pointhubd answers on a real unix socket and writes a real hw.json, so everything from
// that file inward is the production code. The chips themselves are firmware/pointhubd/test_pointhubd.py.

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { evaluateChecks, statusLight, linkLight, analyseSelfTest, contractText, stickChecks, MODULE_NAMES } from '../src/boardHardware.js'
import { toTestSections, toSelfTestSections } from '../src/volleyballMapper.js'
import { spawnSync } from 'node:child_process'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const goodHw = (over = {}) => ({
  ts: Date.now() / 1000,
  bus: 0,
  parts: { mcp23017: true, stusb4500: true, ina_rail: true, ina_input: true, sht40: true, ds3231: true },
  pd: { contract: true, volts: 20, amps: 3.25, watts: 65, source: 'stusb4500' },
  input: { volts: 19.8, amps: 1.2, watts: 23.8 },
  rail: { volts: 5.05, amps: 2.1, watts: 10.6 },
  env: { temp_c: 30, rh: 40 },
  clock_battery_ok: true,
  throttled: { raw: '0', undervoltage_now: false, undervoltage_since_boot: false },
  budget: { ma: 5690, led_w: 28.4, reasons: [], blanked: false },
  lights: { status: 'green', link: 'off' },
  ...over,
})
const panelOk = { connected: true, driverLive: true }
const levelOf = (checks, id) => checks.find((c) => c.id === id)?.level
const textOf = (checks, id) => checks.find((c) => c.id === id)?.text || ''

console.log('[1] what each reading means')
{
  const all = evaluateChecks({ hw: goodHw(), panel: panelOk, cpuTempC: 50, diskFreeBytes: 10e9 })
  ok(all.every((c) => c.level === 'ok'), 'a healthy board: every line is green')
  eq(statusLight(all), 'green', 'STATUS green')
  eq(contractText(goodHw().pd), 'PD 20 V 3.25 A, 65 W', 'the header says the contract the way the guide does')

  const weak = evaluateChecks({ hw: goodHw({ pd: { contract: true, volts: 9, amps: 2, watts: 18, source: 'stusb4500' } }), panel: panelOk })
  eq(levelOf(weak, 'charger'), 'warn', 'an 18 W charger warns')
  ok(/65 W/.test(textOf(weak, 'charger')), '...and says what to use instead')
  eq(statusLight(weak), 'yellow', 'STATUS yellow')

  const sag = evaluateChecks({ hw: goodHw({ input: { volts: 17, amps: 2, watts: 34 } }), panel: panelOk })
  eq(levelOf(sag, 'input'), 'warn', 'input sagging over 10 % warns')

  eq(levelOf(evaluateChecks({ hw: goodHw({ rail: { volts: 4.85, amps: 5 } }), panel: panelOk }), 'rail'), 'warn', '5 V rail under 4.9 V warns')
  eq(levelOf(evaluateChecks({ hw: goodHw({ rail: { volts: 4.7, amps: 5 } }), panel: panelOk }), 'rail'), 'bad', '...under 4.75 V is an error')

  const th = (a, b) => ({ raw: 'x', undervoltage_now: a, undervoltage_since_boot: b })
  eq(levelOf(evaluateChecks({ hw: goodHw({ throttled: th(false, true) }), panel: panelOk }), 'supply'), 'warn', 'under-voltage since boot warns')
  eq(levelOf(evaluateChecks({ hw: goodHw({ throttled: th(true, true) }), panel: panelOk }), 'supply'), 'bad', 'under-voltage now is an error')

  const temp = (t, extra = {}) => levelOf(evaluateChecks({ hw: goodHw({ env: { temp_c: t, rh: 40 }, ...extra }), panel: panelOk }), 'box')
  eq(temp(44), 'ok', '44 °C is fine')
  eq(temp(45), 'warn', '45 °C warns')
  eq(temp(55), 'warn', '55 °C (dimming) warns: the board still works')
  eq(temp(60), 'bad', '60 °C (blanked) is an error')
  eq(levelOf(evaluateChecks({ hw: goodHw({ env: { temp_c: 20, rh: 85 } }), panel: panelOk }), 'box'), 'warn', 'humidity over 80 % warns')

  eq(levelOf(evaluateChecks({ hw: goodHw(), panel: panelOk, cpuTempC: 76 }), 'cpu'), 'warn', 'CPU 75 °C warns')
  eq(levelOf(evaluateChecks({ hw: goodHw(), panel: panelOk, cpuTempC: 81 }), 'cpu'), 'bad', 'CPU 80 °C is an error')
  eq(levelOf(evaluateChecks({ hw: goodHw({ clock_battery_ok: false }), panel: panelOk }), 'clock'), 'warn', 'an empty clock battery warns, nothing more')
  eq(levelOf(evaluateChecks({ hw: goodHw(), panel: panelOk, diskFreeBytes: 1e9 }), 'disk'), 'warn', 'under 2 GB free warns')

  const gone = evaluateChecks({ hw: goodHw({ parts: { ...goodHw().parts, sht40: false, ina_rail: false } }), panel: panelOk })
  eq(levelOf(gone, 'parts'), 'bad', 'a part not answering is an error')
  ok(/temperature sensor/.test(textOf(gone, 'parts')) && /5 V current sensor/.test(textOf(gone, 'parts')), '...named in words')
  eq(levelOf(evaluateChecks({ hw: goodHw({ bus: null }), panel: panelOk }), 'parts'), 'bad', 'no bus at all is an error')
  eq(levelOf(evaluateChecks({ hw: goodHw(), panel: { connected: false } }), 'panel'), 'bad', 'renderer gone is an error')
  eq(levelOf(evaluateChecks({ hw: goodHw(), panel: { connected: true, driverLive: false } }), 'panel'), 'bad', 'driver gone is an error')
  eq(levelOf(evaluateChecks({ hw: goodHw(), panel: panelOk, net: {} }), 'network'), 'ok', 'no network is never a fault: the board scores offline')

  eq(evaluateChecks({ hw: null, panel: panelOk })[0].level, 'bad', 'no hardware report at all is an error')
  eq(evaluateChecks({ hw: goodHw(), stale: true, panel: panelOk })[0].id, 'service', 'a report that stopped updating is that error')
  eq(statusLight([{ level: 'ok' }, { level: 'bad' }, { level: 'warn' }]), 'red_blink', 'the most serious state wins')
  eq(statusLight([{ level: 'bad' }], { starting: true }), 'yellow_blink', 'while starting, STATUS says starting')
}

console.log('[2] LINK, per the guide\'s table')
{
  eq(linkLight({}), 'off', 'nothing connected: off')
  eq(linkLight({ cable: true }), 'blue', 'cable, no internet: blue')
  eq(linkLight({ wifi: true, uplink: 'checking' }), 'yellow_blink', 'connecting: yellow blink')
  eq(linkLight({ wifi: true, uplink: 'portal' }), 'yellow', 'hall login not passed: yellow')
  eq(linkLight({ wifi: true, uplink: 'offline' }), 'yellow', 'Wi-Fi without internet: yellow')
  eq(linkLight({ wifi: true, uplink: 'online' }), 'green', 'online: green')
  eq(linkLight({ cable: true, wifi: true, uplink: 'online' }), 'cyan', 'online and a tablet: cyan')
  eq(linkLight({ cable: true, wifi: true, uplink: 'online', liveFailing: true }), 'red_blink', 'live results failing: red blink')
  eq(linkLight({ cable: true, wifi: true, uplink: 'portal' }), 'blue', 'a tablet with no internet stays blue')
}

console.log('[3] the self-test\'s verdict')
{
  const fine = analyseSelfTest([300, 310, 290, 305, 295, 300, 280, 285])
  ok(fine.ok && fine.failed.length === 0, 'eight modules drawing current pass')
  const one = analyseSelfTest([300, 310, 290, 305, 20, 300, 280, 285])
  eq(one.failed.join(), '5', 'one dead module is named by number')
  eq(analyseSelfTest([300, 310, 290, 305, 295, 300, 280, 3]).failed.join(), 'R', 'a bench module by its fuse-map name')
  ok(analyseSelfTest([0, 1, 0, 2, 0, 1, 0, 0]).error, 'no step anywhere is not eight dead modules: it says to check the sensor')
  eq(analyseSelfTest([0, 1, 0, 2, 0, 1, 0, 0]).failed.length, 0, '...and blames no module')
  eq(MODULE_NAMES.length, 8, 'eight module names')
}

console.log('[3b] the backup stick')
{
  const now = 1_800_000_000_000
  const ts = now / 1000
  eq(stickChecks([], now).length, 0, 'no stick, no line: it is optional')
  eq(stickChecks([{ state: 'ok', files: 12, ts }], now)[0].level, 'ok', 'a stick being copied to is fine')
  ok(/12 files/.test(stickChecks([{ state: 'ok', files: 12, ts }], now)[0].text), '...and says how much is on it')
  ok(/FAT32/.test(stickChecks([{ state: 'format', ts }], now)[0].text), 'a wrong format says what to do')
  eq(stickChecks([{ state: 'copy-failed', ts }], now)[0].level, 'warn', 'a failed copy warns')
  ok(/safe on the board/.test(stickChecks([{ state: 'copy-failed', ts }], now)[0].text), '...and says the match is not at risk')
  ok(/stopped/.test(stickChecks([{ state: 'ok', files: 3, ts: ts - 60 }], now)[0].text), 'a status that stopped updating is not reported as copying')
  ok(statusLight(stickChecks([{ state: 'copy-failed', ts }], now)) === 'yellow', 'a stick problem is yellow, never an error: scoring is not touched')

  // The real script, on plain folders.
  const script = path.join(root, 'provisioning/point-hub/pointhub-backup-stick')
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'point-hub-stick-'))
  const src = path.join(t, 'src'), dst = path.join(t, 'stick', 'OpenVolley')
  fs.mkdirSync(path.join(src, 'match-1'), { recursive: true })
  fs.writeFileSync(path.join(src, 'match-1', 'a.enc'), 'first')
  fs.writeFileSync(path.join(src, '.partial'), 'x')
  const once = () => spawnSync('bash', [script, '--copy-once', src, dst], { encoding: 'utf8' })
  eq(once().status, 0, 'the copy runs')
  eq(fs.readFileSync(path.join(dst, 'match-1', 'a.enc'), 'utf8'), 'first', 'the file is on the stick, in OpenVolley/')
  ok(!fs.existsSync(path.join(dst, '.partial')), 'hidden temp files stay behind')
  fs.writeFileSync(path.join(src, 'match-1', 'a.enc'), 'second, a later rally')
  once()
  eq(fs.readFileSync(path.join(dst, 'match-1', 'a.enc'), 'utf8'), 'second, a later rally', 'a newer backup replaces the old one')
  fs.rmSync(path.join(src, 'match-1'), { recursive: true })
  once()
  ok(fs.existsSync(path.join(dst, 'match-1', 'a.enc')), 'what the app prunes stays on the stick')
  eq(spawnSync('bash', [script, '--copy-once', path.join(t, 'nothing'), path.join(t, 's2')]).status, 0, 'no backups yet is not a failure')
}

console.log('[4] the eight-module test layout and the mapper agree')
{
  const xml = fs.readFileSync(path.join(root, 'firmware/openscore/layout/kscw_test.xml'), 'utf8')
  const inLayout = new Set([...xml.matchAll(/<section name="([^"]+)"/g)].map((m) => m[1]))
  // The board aborts a whole SetSections on the first section its layout lacks.
  const names = (secs) => new Set(secs.map((s) => s.name))
  ok([...names(toTestSections(8))].every((n) => inLayout.has(n)), 'every section the test screen writes exists in the layout')
  ok([...names(toSelfTestSections(0, 8))].every((n) => inLayout.has(n)), 'so does every section of a self-test frame')
  eq(inLayout.size, 8 * 6, 'a frame, a number and four bars per module')
  const white = toSelfTestSections(4, 8).filter((s) => s.value.attrib === 'color' && s.value.value === '255,255,255').map((s) => s.name)
  ok(white.length === 5 && white.every((n) => /^(frame5|bar5[rgbw])$/.test(n)), 'a self-test frame lights exactly the module asked for, all of it')
  eq(toSelfTestSections(null, 8).filter((s) => s.value.value === '255,255,255').length, 0, 'the baseline frame is dark')
  ok(toTestSections().filter((s) => s.name === 'frame4').length === 0, 'the C0270 default stays three modules')
}

// A stand-in for pointhubd: a real socket and a real hw.json. `measure` follows what was asked, with
// module 5's fuse "blown". The steps are scripted per measure call: the baseline, then each module.
function fakeDaemon(dir, { hw = goodHw(), steps = [] } = {}) {
  fs.writeFileSync(path.join(dir, 'hw.json'), JSON.stringify(hw))
  const seen = { lights: [], measures: 0 }
  const refresh = setInterval(() => {
    fs.writeFileSync(path.join(dir, 'hw.json'), JSON.stringify({ ...hw, ts: Date.now() / 1000 }))
  }, 500)
  const server = net.createServer((c) => {
    c.setEncoding('utf8')
    let data = ''
    c.on('data', (d) => {
      data += d
      if (!data.includes('\n')) return
      const msg = JSON.parse(data)
      let reply = { ok: true }
      if (msg.cmd === 'lights') seen.lights.push(`${msg.status}/${msg.link}`)
      if (msg.cmd === 'measure') {
        const amps = steps[seen.measures++] ?? 0.1
        reply = { ok: true, rail: { volts: 5, amps, watts: 5 * amps }, input: null }
      }
      c.end(`${JSON.stringify(reply)}\n`)
    })
  })
  return new Promise((resolve) => {
    server.listen(path.join(dir, 'ctl.sock'), () => resolve({ seen, close: () => { clearInterval(refresh); server.close() } }))
  })
}

const J = (base, p, opts) => fetch(base + p, opts).then((r) => r.json())
const post = (base, p, body = {}) => J(base, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// A mock board that has the eight-module test layout, checked section by section as the real one is:
// a name the layout lacks would fail the whole paint.
const testSections = [...fs.readFileSync(path.join(root, 'firmware/openscore/layout/kscw_test.xml'), 'utf8').matchAll(/<section name="([^"]+)"/g)].map((m) => m[1])

async function boot(extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'point-hub-state-'))
  const mock = new MockLedbox({ layouts: { kscw_test: testSections } })
  const addr = await mock.listen(0, '127.0.0.1')
  const app = await startAppliance({
    mock: false, ledboxHost: '127.0.0.1', ledboxPort: addr.port, controlPort: 0, stateDir, reconnectMs: 100,
    relayUrl: 'ws://127.0.0.1:9', relayDiscovery: false, hardwareBootTestDelayMs: 60_000, ...extra,
  })
  const close = app.close
  app.close = async () => { await close(); await mock.close() }
  const base = `http://127.0.0.1:${app.server.address().port}`
  for (let i = 0; i < 100 && !app.ledbox.ready; i++) await sleep(20)
  return { app, base, stateDir }
}

console.log('[5] the C0270: no hardware, no change')
{
  const { app, base } = await boot()
  const st = await J(base, '/api/status')
  ok(!('hardware' in st), '/api/status has no hardware field')
  eq((await J(base, '/api/hardware')).present, false, '/api/hardware says there is none')
  const r = await post(base, '/api/hardware/selftest')
  eq(r.ok, false, 'a self-test is refused')
  ok(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8').includes('id="dcHardware" hidden'), 'the console card starts hidden')
  eq(app.ledbox.testModules, 3, 'the test screen keeps its three modules')
  await app.close()
}

console.log('[5b] loopback is no trust on a board without the hardware')
{
  const { app, base } = await boot()
  await post(base, '/api/settings', { scorerPin: '1234' })
  eq((await J(base, '/api/status')).pinRequired, true, 'the PIN stays required over loopback')
  await app.close()
}

console.log('[6] with the hardware service')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'point-hub-run-'))
  // Baseline 0.1 A, then eight steps of about 0.3 A except module 5.
  const steps = [0.1, 0.4, 0.41, 0.39, 0.4, 0.12, 0.4, 0.38, 0.39]
  const daemon = await fakeDaemon(dir, { steps })
  const ini = path.join(dir, 'setting.ini')
  fs.copyFileSync(path.join(root, 'firmware/openscore/setting-point-hub.ini'), ini)
  const { app, base, stateDir } = await boot({ hardwareDir: dir, settingIni: ini, hardwareSettleMs: 1 })
  eq(app.ledbox.testModules, 8, 'a 96-row canvas means eight modules')
  const st = await J(base, '/api/status')
  eq(st.hardware.contract, 'PD 20 V 3.25 A, 65 W', '/api/status carries the charger for the header')
  const view = await J(base, '/api/hardware')
  eq(view.present, true, '/api/hardware has the report')
  ok(view.checks.some((c) => c.id === 'charger' && c.level === 'ok'), '...and the checks')
  // The lights go to the daemon by themselves.
  for (let i = 0; i < 50 && !daemon.seen.lights.length; i++) await sleep(20)
  ok(daemon.seen.lights.length > 0, `the appliance sends the lights (${daemon.seen.lights[0]})`)
  ok(fs.existsSync(path.join(stateDir, 'screen-app')), 'the screen choice is written for the path unit')
  eq(fs.readFileSync(path.join(stateDir, 'screen-app'), 'utf8').trim(), 'console', '...by default the console')

  // Self-test: the mock board must have the test layout, as the real openscore will.
  const r = await post(base, '/api/hardware/selftest')
  if (r.error && /test screen/.test(r.error)) {
    ok(false, `the mock board has no test layout: ${r.error}`)
  } else {
    eq((r.failed || []).join(), '5', 'the self-test names the module with no current')
    eq(r.stepsMa.length, 8, 'it measured all eight')
    ok(r.hardware.checks.some((c) => c.id === 'selftest' && c.level === 'bad' && /Module 5 \/ fuse 5/.test(c.text)), 'Diagnostics says "Module 5 / fuse 5: no current"')
    ok(app.ledbox.testView() !== null, 'the numbers and colours stay up for the eye afterwards')
    await post(base, '/api/paneltest', { action: 'stop' })
    eq(app.ledbox.testView(), null, '...and the board goes back')
  }

  // Settings: the screen choice, validated, written through.
  const saved = await post(base, '/api/settings', { screenApp: 'openvolley' })
  eq(saved.screenApp, 'openvolley', 'Settings takes the eScoresheet')
  eq(fs.readFileSync(path.join(stateDir, 'screen-app'), 'utf8').trim(), 'openvolley', '...and writes it for the screen')
  eq((await post(base, '/api/settings', { screenApp: 'doom' })).screenApp, 'openvolley', 'an unknown app is ignored')
  await post(base, '/api/settings', { screenApp: 'console' })

  // The board's own screen is at the board: loopback needs no PIN here. (The C0270 case is section 5b.)
  await post(base, '/api/settings', { scorerPin: '1234' })
  eq((await J(base, '/api/status')).pinRequired, false, 'the touchscreen on loopback is not asked for the PIN')
  await app.close()
  daemon.close()
}

console.log('[7] following the board\'s own OpenVolley')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'point-hub-run-'))
  const daemon = await fakeDaemon(dir)
  let list = []
  const relay = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.startsWith('/api/match/list') ? { matches: list } : {}))
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const port = relay.address().port
  const { app, base, stateDir } = await boot({ hardwareDir: dir, hardwareSettleMs: 1, localRelayUrl: `ws://127.0.0.1:${port}` })

  await app.server.followLocalScorer()
  eq((await J(base, '/api/status')).mode !== 'lan', true, 'with the console on the screen, it follows nothing')
  // The start screen, the new-board default: a choice is not a Settings change.
  await post(base, '/api/settings', { screenApp: 'ask' })
  eq(fs.readFileSync(path.join(stateDir, 'screen-app'), 'utf8').trim(), 'ask', 'Settings takes the start screen')

  list = [{ id: 'm1', status: 'setup' }]
  await app.server.followLocalScorer()
  ok((await J(base, '/api/status')).mode !== 'lan', 'a match not yet live is not followed')

  list = [{ id: 'm1', status: 'live' }, { id: 'm2', status: 'live' }]
  await app.server.followLocalScorer()
  ok((await J(base, '/api/status')).mode !== 'lan', 'two live matches: it does not guess')

  list = [{ id: 'm1', status: 'live' }]
  await app.server.followLocalScorer()
  let st = await J(base, '/api/status')
  eq(st.mode, 'lan', 'one live match: the board follows it')
  eq(st.matchId, 'm1', '...that one')

  list = [{ id: 'm1', status: 'live' }, { id: 'm2', status: 'live' }]
  await app.server.followLocalScorer()
  eq((await J(base, '/api/status')).matchId, 'm1', 'a second one appearing does not take over a match still live')

  list = [{ id: 'm2', status: 'live' }]
  await app.server.followLocalScorer()
  eq((await J(base, '/api/status')).matchId, 'm2', 'the next match takes over once the first has ended')

  // The start screen's choice lasts until the next power-up, and does not touch Settings.
  ok((await fetch(`${base}/choose`)).ok, 'the start screen is served')
  ok((await fetch(`${base}/openvolley_mark.svg`)).ok, '...with the OpenVolley logo')
  const boot_id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  const nowFile = path.join(stateDir, 'screen-now')
  eq((await post(base, '/api/screen', { app: 'openvolley' })).app, 'openvolley', 'the screen chooses OpenVolley')
  eq(fs.readFileSync(nowFile, 'utf8').trim(), `openvolley ${boot_id}`, '...for this boot')
  eq(fs.readFileSync(path.join(stateDir, 'screen-app'), 'utf8').trim(), 'ask', '...Settings still asks at the next power-up')
  const refused = await fetch(`${base}/api/screen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'doom' }) })
  eq(refused.status, 400, 'an unknown app is refused')
  await post(base, '/api/screen', { app: 'console' })
  list = [{ id: 'm3', status: 'live' }]
  await app.server.followLocalScorer()
  eq((await J(base, '/api/status')).matchId, 'm2', 'with Point Hub chosen, it follows nothing new')
  await post(base, '/api/settings', { screenApp: 'console' })
  ok(!fs.existsSync(nowFile), 'a Settings change replaces the choice')

  await app.close()
  relay.close()
  daemon.close()
}

console.log('[7b] the C0270 serving OpenVolley itself (BOARD_OPENVOLLEY=1)')
{
  let list = [{ id: 'm1', status: 'live' }]
  const relay = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url.startsWith('/api/match/list') ? { matches: list } : {}))
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const localRelayUrl = `ws://127.0.0.1:${relay.address().port}`

  // Without the flag the C0270 stays as it was: the console links, nothing follows by itself.
  {
    const { app, base } = await boot({ localRelayUrl })
    await app.server.followLocalScorer()
    ok((await J(base, '/api/status')).mode !== 'lan', 'a plain C0270 follows nothing by itself')
    eq((await J(base, '/api/status')).openvolley, null, '...and has no "Score with OpenVolley" card')
    await app.close()
  }

  const { app, base } = await boot({ localRelayUrl, boardOpenVolley: true })
  await app.server.checkBoardOpenVolley()
  let ov = (await J(base, '/api/status')).openvolley
  ok(ov && ov.running === true && ov.live === 1, `the card: OpenVolley answers, one match live (${JSON.stringify(ov)})`)
  await app.server.followLocalScorer()
  let st = await J(base, '/api/status')
  eq(st.mode, 'lan', 'with OpenVolley on the board, the one live match is followed (Settings still says console)')
  eq(st.matchId, 'm1', '...that one')

  list = [{ id: 'm2', status: 'live' }]
  await app.server.followLocalScorer()
  eq((await J(base, '/api/status')).matchId, 'm2', 'the next match takes over once the first has ended')

  // A game scored on the console is never taken over.
  await post(base, '/api/manual')
  await post(base, '/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  list = [{ id: 'm3', status: 'live' }]
  await app.server.followLocalScorer()
  st = await J(base, '/api/status')
  ok(st.matchId !== 'm3', `a hand-scored game in play is not taken over (mode ${st.mode}, match ${st.matchId})`)

  await new Promise((r) => relay.close(r))
  await app.server.checkBoardOpenVolley()
  ov = (await J(base, '/api/status')).openvolley
  eq(ov && ov.running, false, 'the card says so when OpenVolley on the board stops answering')
  await app.close()
}

console.log('[8] the console')
{
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')
  ok(html.includes('id="hwTag"') && html.includes('renderHardwareBrief(st.hardware)'), 'the header shows the charger')
  ok(html.includes('data-set="screenApp"') && html.includes('id="screenAppSet" hidden'), 'Settings has the screen choice, hidden until there is hardware')
  ok(html.includes('"/api/hardware/selftest"'), 'Run self-test gets the long timeout')
  ok(html.includes('id="ovCard" class="ovcard" hidden') && html.includes('renderBoardOpenVolley(st.openvolley)'), 'Link has the "Score with OpenVolley" card, hidden unless the board serves OpenVolley')
  ok(html.includes('<script src="/qrcode-generator.js"></script>') && fs.existsSync(path.join(root, 'web/qrcode-generator.js')), '...with its QR encoder shipped beside the console')
  ok(/createElementNS\(NS, "path"\)/.test(html) && !/innerHTML\s*=\s*qr\./.test(html), '...drawing the QR as SVG nodes, never as parsed markup')
  ok(!/\.innerHTML\s*=.*hw/i.test(html), 'the checks go in as text, never as markup')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
