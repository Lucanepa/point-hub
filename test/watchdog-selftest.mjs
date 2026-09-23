// Self-test for firmware/ledbox-watchdog.sh (zero deps; needs bash, flock, pgrep — i.e. Linux).
//
// The watchdog is plain bash with its board paths hardcoded, so this takes the function block
// (everything before the boot `sleep 90`), points /home/pi/ledbox* at a scratch dir, stubs
// `startled` with a slow launcher and `flushBuffer2` with a named sleeper, and drives the
// functions directly. It pins the three behaviours that went wrong on paper:
//   - two concurrent start_panel calls start ONE driver (the lock covers startled's slow start),
//     and the lock is free again once the driver is up (not inherited for the driver's life);
//   - the driver is launched as its own transient unit (systemd-run, so restarting the watchdog
//     unit does not take the panel down with it), and a refused systemd-run still lights the panel
//     through the old launch. `systemd-run` is stubbed on PATH: the test never touches real systemd;
//   - app_running() sees openscore as well as the vendor ledbox.py;
//   - a PANEL_OFF left behind while settings.json says brightness > 0 is cleared, and one that
//     matches brightness 0 (or can't be checked) is kept.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

if (process.platform !== 'linux') { console.log('skipped: needs Linux (flock, pgrep, /proc)'); process.exit(0) }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(repo, 'firmware', 'ledbox-watchdog.sh'), 'utf8')
const cut = src.indexOf('\nsleep 90')
if (cut < 0) { console.log('  ❌ could not find the boot `sleep 90` in the watchdog'); process.exit(1) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-watchdog-'))
// A name unique to this run so we never count (or kill) a real driver or another run's stub.
const DRIVER = `fb2t${process.pid}`.slice(0, 15)
const lib = src.slice(0, cut)
  .replaceAll('/home/pi/ledbox-bridge', path.join(tmp, 'bridge'))
  .replaceAll('/home/pi/ledbox', path.join(tmp, 'ledbox'))
  .replaceAll('flushBuffer2', DRIVER)
  .replace(/^log\(\) \{.*$/m, 'log() { echo "LOG: $1"; }')
fs.mkdirSync(path.join(tmp, 'ledbox', 'bin'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'bridge'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'path'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'lib.sh'), lib)
// startled stand-in: slow like the real one (ini parse + cp + sudo) before the driver exists. It
// cds to its own dir like the real one does, since a systemd unit starts in /.
fs.writeFileSync(path.join(tmp, 'ledbox', 'bin', 'startled'), `#!/bin/bash\ncd "$(dirname "$0")"\nsleep 0.8\nexec ./${DRIVER}\n`, { mode: 0o755 })
// systemd-run stand-in: records its arguments, then runs the command detached in its own session
// (what "systemd is the parent" amounts to here). SDRUN_REFUSE makes it fail like a missing or
// refused systemd-run, so the fallback launch has to light the panel.
const SDLOG = path.join(tmp, 'systemd-run.log')
const REFUSE = path.join(tmp, 'SDRUN_REFUSE')
fs.writeFileSync(path.join(tmp, 'path', 'systemd-run'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(SDLOG)}
[ -f ${JSON.stringify(REFUSE)} ] && exit 1
while [ "\${1#--}" != "$1" ]; do shift; done
setsid "$@" </dev/null >/dev/null 2>&1 &
exit 0
`, { mode: 0o755 })
fs.writeFileSync(path.join(tmp, 'ledbox', 'bin', DRIVER), '#!/bin/bash\nwhile :; do sleep 1; done\n', { mode: 0o755 })

const env = { ...process.env, PATH: `${path.join(tmp, 'path')}:${process.env.PATH}` }
const sh = (body, timeout = 60000) => execFileSync('bash', ['-c', `source ${JSON.stringify(path.join(tmp, 'lib.sh'))}\n${body}`],
  { encoding: 'utf8', timeout, killSignal: 'SIGKILL', env })
const drivers = () => { try { return execFileSync('pgrep', ['-x', DRIVER], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length } catch { return 0 } }
const killDrivers = () => { try { execFileSync('pkill', ['-x', DRIVER]) } catch { /* none */ } }

try {
  console.log('▶ start_panel: one driver, however the starts overlap')
  // Output to /dev/null: a starter that leaks its stdout to the backgrounded driver would
  // otherwise hang this pipe for the driver's life instead of failing the count below.
  // A hang IS the failure: a starter whose lock is inherited by the driver blocks the second
  // start_panel for the driver's whole life (the watchdog loop would stop dead).
  let hung = false
  try { sh('start_panel >/dev/null 2>&1 & start_panel >/dev/null 2>&1 & wait; sleep 1.5', 30000) } catch { hung = true }
  ok(!hung, 'two concurrent start_panel calls both return (neither blocks on a lock the driver holds)')
  ok(drivers() === 1, `two concurrent start_panel calls -> ${drivers()} driver(s), want 1`)
  const lockFree = sh(`flock -n ${JSON.stringify(path.join(tmp, 'ledbox', 'panel.lock'))} true && echo free || echo held`).trim()
  ok(lockFree === 'free', `panel.lock is free while the driver runs (got ${lockFree})`)
  let hung2 = false
  try { sh('start_panel >/dev/null 2>&1; sleep 1.5', 30000) } catch { hung2 = true }
  ok(!hung2 && drivers() === 1, 'start_panel with a driver already running returns and starts nothing')
  killDrivers()

  console.log('▶ start_panel: the driver gets its own transient unit')
  const block = src.slice(src.indexOf('start_panel() {'), src.indexOf('\n}', src.indexOf('start_panel() {')))
  ok(/systemd-run --quiet --collect --unit=ledbox-panel-\$\$ \/home\/pi\/ledbox\/bin\/startled/.test(block),
    'start_panel launches startled via `systemd-run --quiet --collect --unit=ledbox-panel-$$`')
  ok(!/sudo/.test(block), 'no sudo in start_panel (the watchdog already runs as root)')
  const calls = fs.existsSync(SDLOG) ? fs.readFileSync(SDLOG, 'utf8').trim().split('\n').filter(Boolean) : []
  ok(calls.length === 1 && /--collect/.test(calls[0]) && /--unit=ledbox-panel-\d+/.test(calls[0]),
    `the one real start went through systemd-run with a per-start unit name (calls: ${JSON.stringify(calls)})`)
  fs.writeFileSync(REFUSE, '')
  let hung3 = false
  try { sh('start_panel >/dev/null 2>&1; sleep 1.5', 30000) } catch { hung3 = true }
  ok(!hung3 && drivers() === 1, `systemd-run refused -> the fallback launch still starts one driver (got ${drivers()})`)
  const lockFree2 = sh(`flock -n ${JSON.stringify(path.join(tmp, 'ledbox', 'panel.lock'))} true && echo free || echo held`).trim()
  ok(lockFree2 === 'free', `and the fallback driver does not hold panel.lock either (got ${lockFree2})`)
  fs.rmSync(REFUSE, { force: true })
  killDrivers()

  console.log('▶ app_running: vendor ledbox.py AND openscore')
  for (const name of ['ledbox.py', 'openscore.py']) {
    fs.writeFileSync(path.join(tmp, name), 'import time\ntime.sleep(30)\n')
    const p = spawn('python3', ['-u', name], { cwd: tmp, stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 300))
    const seen = sh('app_running && echo yes || echo no').trim()
    p.kill()
    ok(seen === 'yes', `app_running sees "python3 -u ${name}" (got ${seen})`)
  }

  console.log('▶ PANEL_OFF reconciliation')
  const flag = path.join(tmp, 'ledbox', 'PANEL_OFF')
  const settings = path.join(tmp, 'bridge', 'settings.json')
  const check = () => sh('panel_off_requested && echo off || echo on').trim().split('\n').pop()
  const cases = [
    ['brightness 40 -> stale flag cleared', { brightness: 40 }, 'on', false],
    ['brightness 0 -> flag honoured', { brightness: 0 }, 'off', true],
    ['no brightness key -> flag kept (unknown)', { sport: 'volleyball' }, 'off', true],
    ['no settings.json -> flag kept (unknown)', null, 'off', true],
  ]
  for (const [label, body, want, flagStays] of cases) {
    fs.writeFileSync(flag, '')
    fs.rmSync(settings, { force: true })
    if (body) fs.writeFileSync(settings, JSON.stringify(body))
    const got = check()
    ok(got === want && fs.existsSync(flag) === flagStays, `${label} (got ${got}, flag ${fs.existsSync(flag) ? 'present' : 'gone'})`)
  }
  fs.rmSync(flag, { force: true })
  ok(check() === 'on', 'no flag -> panel on')
} finally {
  killDrivers()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} watchdog: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
