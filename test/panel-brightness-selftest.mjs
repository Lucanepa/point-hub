// Self-test for src/panelBrightness.js — which way a console brightness change reaches the panel
// driver (zero deps; reads /proc, so Linux only).
//
// The board runs the OLD flushBuffer2 (brightness only at launch) until someone rebuilds it on site,
// and the new one (brightness live from /run/ledbox-panel/brightness) after that — or the old one
// again after a rollback. So the appliance must decide per change, and get both right. This pins:
//   - no live driver (no control dir, a driver file naming a dead pid, a live pid whose start time
//     does not match, a driver that does not claim brightness) → today's behaviour exactly:
//     setting.ini rewritten and PANEL_RESTART run; 0 raises PANEL_OFF and pkills the driver;
//   - a leftover brightness file from an earlier live driver is kept in step on that path, so the
//     next live driver to start does not come up at an old level;
//   - a live driver → the brightness file is written (atomically, one number), setting.ini still
//     takes the new start value, and NOTHING is restarted or killed; 0 goes dark through the file,
//     keeps the driver, and raises PANEL_OFF for the next boot;
//   - a live driver whose file cannot be written → the restart path, not silence;
//   - off the board (no setting.ini, no control dir) → nothing at all.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyBrightness, liveDriver, PANEL_RESTART } from '../src/panelBrightness.js'
import { log } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

if (process.platform !== 'linux') { console.log('skipped: needs Linux (/proc/<pid>/stat)'); process.exit(0) }
log.configure?.({ console: false })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-brightness-'))
const paths = {
  settingIni: path.join(tmp, 'setting.ini'),
  panelOffFlag: path.join(tmp, 'PANEL_OFF'),
  ctlDir: path.join(tmp, 'run-ledbox-panel'),
}
const INI = '[WIFI]\nssid=ledbox_C0270\n\n[DISPLAY]\nhardware_mapping=applicon\nbrightness=40\nwidth=192\n'
const ini = () => /^brightness=(.*)$/m.exec(fs.readFileSync(paths.settingIni, 'utf8'))?.[1]
const flag = () => fs.existsSync(paths.panelOffFlag)
const bfile = () => { try { return fs.readFileSync(path.join(paths.ctlDir, 'brightness'), 'utf8') } catch { return null } }
let calls = []
const exec = (cmd, args, cb) => { calls.push([cmd, ...args]); if (cb) cb(null) }
const apply = (v) => { calls = []; return applyBrightness(v, { paths, exec }) }

// This very process stands in for a running driver: its pid and its real start time.
const stat = fs.readFileSync('/proc/self/stat', 'utf8')
const ownStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
const writeDriver = ({ pid = process.pid, start = ownStart, control = 'brightness power' } = {}) => {
  fs.mkdirSync(paths.ctlDir, { recursive: true })
  fs.writeFileSync(path.join(paths.ctlDir, 'driver'), `# flushBuffer2 live control\npid=${pid}\nstart=${start}\ncontrol=${control}\n`)
}
const restartCall = (c) => c.length === 1 && c[0][0] === 'bash' && c[0][1] === '-c' && c[0][2] === PANEL_RESTART
const pkillCall = (c) => c.length === 1 && c[0].join(' ') === 'sudo pkill -x flushBuffer2'

try {
  fs.writeFileSync(paths.settingIni, INI)

  console.log('▶ old driver: no control directory at all (the board today)')
  fs.writeFileSync(paths.panelOffFlag, '')
  let r = apply(60)
  ok(r === 'restart', `60 -> restart path (got ${r})`)
  ok(ini() === '60', `setting.ini brightness=60 (got ${ini()})`)
  ok(restartCall(calls), 'PANEL_RESTART run once')
  ok(!flag(), 'PANEL_OFF cleared')
  ok(!fs.existsSync(paths.ctlDir), 'no control directory created (that is the driver\'s job)')
  ok(fs.readFileSync(paths.settingIni, 'utf8') === INI.replace('brightness=40', 'brightness=60'), 'the rest of setting.ini untouched')
  r = apply(0)
  ok(r === 'off' && flag() && pkillCall(calls), `0 -> PANEL_OFF + pkill (got ${r}, calls ${JSON.stringify(calls)})`)
  ok(ini() === '60', 'setting.ini keeps the last level that lit the panel')

  console.log('▶ not a live driver, whatever the driver file says')
  fs.writeFileSync(paths.panelOffFlag, '')
  writeDriver({ pid: 999999999 })
  fs.writeFileSync(path.join(paths.ctlDir, 'brightness'), '0\n')
  ok(liveDriver(paths.ctlDir) === null, 'a dead pid is not a live driver')
  r = apply(70)
  ok(r === 'restart' && restartCall(calls) && ini() === '70', `dead pid -> restart path, setting.ini 70 (got ${r}, ${ini()})`)
  ok(bfile() === '70\n', `a leftover brightness file is kept in step (got ${JSON.stringify(bfile())})`)
  writeDriver({ start: String(Number(ownStart) + 1) })
  ok(liveDriver(paths.ctlDir) === null, 'a live pid with another start time (pid reused) is not a live driver')
  r = apply(71)
  ok(r === 'restart' && restartCall(calls), `pid reused -> restart path (got ${r})`)
  writeDriver({ control: 'power' })
  ok(liveDriver(paths.ctlDir) === null, 'a driver that does not claim brightness is not a live driver')
  ok(apply(72) === 'restart', 'and gets the restart path')
  fs.writeFileSync(path.join(paths.ctlDir, 'driver'), 'garbage\n')
  ok(liveDriver(paths.ctlDir) === null && apply(73) === 'restart', 'a malformed driver file -> restart path')

  console.log('▶ live driver')
  writeDriver()
  const d = liveDriver(paths.ctlDir)
  ok(d && d.pid === process.pid && d.control.has('brightness'), 'pid + matching start time -> live driver')
  fs.writeFileSync(paths.panelOffFlag, '')
  r = apply(80)
  ok(r === 'live', `80 -> live (got ${r})`)
  ok(calls.length === 0, `nothing restarted or killed (calls ${JSON.stringify(calls)})`)
  ok(bfile() === '80\n', `brightness file says 80 (got ${JSON.stringify(bfile())})`)
  ok(ini() === '80', `setting.ini still gets the new start value (got ${ini()})`)
  ok(!flag(), 'PANEL_OFF cleared')
  ok(!fs.readdirSync(paths.ctlDir).some((f) => f.endsWith('.tmp')), 'no temp file left behind')
  r = apply(0)
  ok(r === 'live' && calls.length === 0, `0 -> live, no pkill (got ${r}, calls ${JSON.stringify(calls)})`)
  ok(bfile() === '0\n' && flag(), 'brightness file 0 and PANEL_OFF raised for the next boot')
  ok(ini() === '80', 'setting.ini keeps 80 (hzeller refuses --led-brightness=0)')
  r = apply(50)
  ok(r === 'live' && calls.length === 0 && bfile() === '50\n' && !flag() && ini() === '50', `0 -> 50 live: file 50, flag gone, setting.ini 50 (got ${r})`)

  console.log('▶ live driver, but its brightness file cannot be written')
  fs.rmSync(path.join(paths.ctlDir, 'brightness'))
  fs.mkdirSync(path.join(paths.ctlDir, 'brightness'))   // rename onto a directory fails
  r = apply(65)
  ok(r === 'restart' && restartCall(calls) && ini() === '65', `-> restart path instead (got ${r}, ${ini()})`)
  fs.rmSync(path.join(paths.ctlDir, 'brightness'), { recursive: true })

  console.log('▶ off the board')
  fs.rmSync(paths.settingIni)
  fs.rmSync(paths.ctlDir, { recursive: true })
  r = apply(55)
  ok(r === 'skipped' && calls.length === 0, `no setting.ini, no control dir -> nothing (got ${r}, calls ${JSON.stringify(calls)})`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} panel brightness: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
