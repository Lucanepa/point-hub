// Panel brightness: how a console change reaches the LED panel driver (flushBuffer2).
//
// Two drivers can be on the board, and this has to work with both:
//
//   LIVE     A flushBuffer2 built from the current firmware/flushbuffer/flushbuffer.cc reads its
//            brightness from a one-line file on tmpfs (/run/ledbox-panel/brightness) every few
//            frames and applies it with no restart. 0 draws black and keeps the driver running.
//   RESTART  The binary on the board until someone rebuilds it on site (firmware/flushbuffer/
//            build.sh) reads brightness only at launch. `startled` takes it from setting.ini, so
//            the level is written there and the driver is bounced (PANEL_RESTART below); 0 stops
//            the driver and raises PANEL_OFF so the watchdog keeps it dark.
//
// Which one is running is decided per change, not once at boot: the driver may be rebuilt, rolled
// back or restarted under the appliance at any time. A live driver announces itself in
// /run/ledbox-panel/driver with its pid and its start time (field 22 of /proc/<pid>/stat); that
// pair names one run of one process for the whole boot, so a file left behind by a killed driver
// — or a pid since reused by something else — never passes for a live one. Anything short of a
// clean match takes the restart path, which is exactly what the board did before.
//
// setting.ini stays the persisted START value either way: the live path writes the new level there
// too (no restart), so the next driver launch — a boot, a watchdog recovery — comes up at it. A
// live 0 is the exception, as it always was: setting.ini keeps the last level that lit the panel
// (hzeller refuses --led-brightness=0), and PANEL_OFF carries "off" across a reboot.
//
// Best-effort throughout: a failure is logged, never thrown, and off the board (dev, the tests:
// no setting.ini, no /run/ledbox-panel) it simply no-ops.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { log } from './logStore.js'

const plog = log.child('control')

export const PANEL_PATHS = Object.freeze({
  // [DISPLAY] brightness, read by startled and passed to the driver as --led-brightness. The
  // bridge runs as pi (passwordless sudo); setting.ini is world-writable.
  settingIni: '/home/pi/ledbox/setting.ini',
  // Brightness 0 = panel off. This flag file (checked by the board watchdog) is what keeps the
  // panel dark: without it the watchdog would relight the driver within 30s. Removing it lets the
  // watchdog keep the panel alive again.
  panelOffFlag: '/home/pi/ledbox/PANEL_OFF',
  // The live driver's control directory (flushbuffer.cc creates it, world-writable, on tmpfs).
  ctlDir: '/run/ledbox-panel',
})

// Restart the panel driver at the current setting.ini brightness. Everything happens under the
// lock the watchdog's start_panel shares (firmware/ledbox-watchdog.sh): SIGTERM the running driver,
// WAIT for it to actually exit, start exactly one, and keep holding the lock until the new
// flushBuffer2 is really there. Each part closes a race:
//   * the kill is INSIDE the lock — outside it, the watchdog could see "no driver" in the gap and
//     start one at the OLD brightness, which ours would then either skip or fight;
//   * flushBuffer2 can take ~1s to release the GPIO on SIGTERM, so starting on a fixed timer would
//     be skipped (the guard still sees the dying process) or spawn a second driver beside it —
//     vertical flicker on the panel. If it will not die within ~5s we start nothing: a panel at the
//     old brightness is better than two drivers;
//   * the lock is held until pgrep sees the new driver (~10s max). startled takes a moment to exec
//     flushBuffer2, and releasing the lock the instant it was launched let the watchdog take it,
//     see no driver yet, and start a second one;
//   * `flock -o` closes the lock fd in the command it runs, so the driver we launch (and systemd-run's
//     helpers) never inherit it — an inherited fd would hold the lock for the driver's whole life
//     and lock the watchdog out of every restart after this one.
// Process match is `-x flushBuffer2` (exact comm) so the transient `sudo` wrapper never counts as a
// live driver. Exit codes (logged by applyBrightness): 3 = no driver within 10s, 4 = the old one
// would not exit, 1 = the lock stayed busy for 20s.
//
// The driver is launched as its OWN transient systemd unit, not as a child of this process. A
// backgrounded `( ./startled & )` only leaves the shell, not the cgroup: sudo on this board opens
// no new session scope, so flushBuffer2 stayed a member of ledbox-bridge.service, and the unit's
// default KillMode=control-group took the panel down with the bridge on every deploy, sport switch
// or crash restart after any brightness change — dark until the watchdog noticed (~40s), or for
// good while the watchdog is disabled. systemd-run makes systemd the parent, so the driver outlives
// us exactly as the one rc.local started does. Same user as before (id -un), so buffer.png keeps
// its owner. The unit name carries $$ so a previous launch still being reaped can't collide with
// it; --collect drops it once the driver exits. `sudo -n` never prompts, and should systemd-run be
// refused for any reason the old in-cgroup launch still lights the panel — dark is the worse fault.
//
// Only the RESTART path uses these two; test/panel-restart-selftest.mjs runs PANEL_RESTART itself.
const PANEL_START =
  'sudo -n systemd-run --quiet --collect --unit=ledbox-panel-$$ --uid=$(id -un) /home/pi/ledbox/bin/startled >/dev/null 2>&1 || ' +
  '( cd /home/pi/ledbox/bin && ./startled >/dev/null 2>&1 & )'
export const PANEL_RESTART =
  "flock -o -w 20 /home/pi/ledbox/panel.lock -c '" +
  'sudo -n pkill -x flushBuffer2; ' +
  'for i in $(seq 25); do pgrep -x flushBuffer2 >/dev/null 2>&1 || break; sleep 0.2; done; ' +
  'pgrep -x flushBuffer2 >/dev/null 2>&1 && exit 4; ' +
  `{ ${PANEL_START}; }; ` +
  'for i in $(seq 50); do pgrep -x flushBuffer2 >/dev/null 2>&1 && exit 0; sleep 0.2; done; ' +
  "exit 3'"

// Push a new brightness (0-100) to the panel. Returns which path it took, for the log and the
// selftest: 'live' (the running driver took it), 'restart' (setting.ini rewritten, driver
// bounced), 'off' (driver stopped, PANEL_OFF raised) or 'skipped' (no setting.ini: not a board).
// `paths` and `exec` exist for test/panel-brightness-selftest.mjs; the appliance passes neither.
export function applyBrightness(value, { paths = PANEL_PATHS, exec = execFile } = {}) {
  const { settingIni, panelOffFlag, ctlDir } = paths
  const driver = liveDriver(ctlDir)
  if (driver) {
    // The watchdog stops a driver running under PANEL_OFF unless its brightness file says 0, so the
    // flag and the file change in the order that never shows it "off requested, panel lit": on, the
    // flag goes before the file says >0; off, the file says 0 before the flag goes up.
    if (value > 0) clearFlag(panelOffFlag)
    if (writeBrightnessFile(ctlDir, value)) {
      if (value <= 0) {
        // Dark at once, driver still running. The flag carries "off" across a reboot, when /run is
        // empty again and rc.local relights the panel at setting.ini's level; the watchdog leaves a
        // live driver that is showing 0 alone, and stops one that is not.
        writeFlag(panelOffFlag)
        plog.info('panel dark (brightness 0); the driver keeps running', { brightness: 0, path: 'live', pid: driver.pid })
        return 'live'
      }
      // The start value for the next launch. No restart: the driver already has it.
      const persisted = writeIniBrightness(settingIni, value)
      plog.info(`panel brightness ${value}, applied live`, { brightness: value, path: 'live', pid: driver.pid, persisted })
      return 'live'
    }
    plog.warn(`could not write ${path.join(ctlDir, 'brightness')} — restarting the driver instead`, { brightness: value })
  }

  // RESTART path: the driver reads brightness only at launch. If a live driver ran earlier in this
  // boot its brightness file is still there, and the next one to start would honour it over
  // setting.ini — so it is kept in step (or, failing that, removed) whatever happens below.
  syncStaleBrightnessFile(ctlDir, value)

  if (value <= 0) {
    // Off: raise the flag first (so the watchdog leaves it dark), then stop the driver. The
    // scoreboard app keeps running, so the controller UI stays reachable to switch it back on.
    writeFlag(panelOffFlag)
    plog.info('panel driver stopped (brightness 0)', { brightness: 0, path: 'off' })
    exec('sudo', ['pkill', '-x', 'flushBuffer2'], (err) => {
      if (err) plog.warn(`pkill flushBuffer2 failed: ${err.message}`, { error: err.message })
    })
    return 'off'
  }
  // On (or level change): clear the off-flag so the watchdog keeps the panel alive.
  clearFlag(panelOffFlag)
  if (!writeIniBrightness(settingIni, value)) return 'skipped'
  // setting.ini now holds the new level, so whichever starter wins the lock launches at it.
  plog.info(`restarting the panel driver at brightness ${value}`, { brightness: value, path: 'restart' })
  exec('bash', ['-c', PANEL_RESTART], (err) => {
    if (!err) return
    const why = { 1: 'panel.lock stayed busy for 20s, restart skipped', 3: 'no flushBuffer2 appeared within 10s of startled', 4: 'the old flushBuffer2 did not exit, so no second driver was started' }[err.code]
    plog.warn(`panel driver restart: ${why || err.message}`, { code: err.code, error: err.message })
  })
  return 'restart'
}

// The running driver, if it takes brightness live; null otherwise. See the header for why the
// start time is compared and not just the pid. The same check, in bash, is live_driver() in
// firmware/ledbox-watchdog.sh.
export function liveDriver(ctlDir = PANEL_PATHS.ctlDir) {
  let text
  try { text = fs.readFileSync(path.join(ctlDir, 'driver'), 'utf8') } catch { return null }
  const kv = {}
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]] = m[2].trim()
  }
  if (!/^\d+$/.test(kv.pid || '') || !/^\d+$/.test(kv.start || '')) return null
  const control = new Set(String(kv.control || '').split(/\s+/).filter(Boolean))
  if (!control.has('brightness')) return null
  let stat
  try { stat = fs.readFileSync(`/proc/${kv.pid}/stat`, 'utf8') } catch { return null }
  // Fields after the ")" that closes the command name: [0] is field 3 (state), so field 22 is [19].
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  if (fields[19] !== kv.start) return null
  return { pid: Number(kv.pid), control }
}

// Temp file + rename in the same directory, so the driver never reads half a number. False if the
// directory is not there (no live driver has run this boot) or will not take the file.
function writeBrightnessFile(ctlDir, value) {
  const file = path.join(ctlDir, 'brightness')
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, `${value}\n`, { mode: 0o644 })
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    if (err.code !== 'ENOENT') plog.debug(`brightness file write failed: ${err.message}`, { file, error: err.message })
    return false
  }
}

function syncStaleBrightnessFile(ctlDir, value) {
  const file = path.join(ctlDir, 'brightness')
  if (!fs.existsSync(file)) return
  if (writeBrightnessFile(ctlDir, value)) return
  try { fs.rmSync(file, { force: true }) } catch (err) {
    plog.warn(`stale ${file} could not be updated or removed: the next live driver may start at an old level`, { file, error: err.message })
  }
}

// Rewrite [DISPLAY] brightness in setting.ini. False when there is no setting.ini (off the board,
// the expected path in dev and the tests, not a fault).
function writeIniBrightness(settingIni, value) {
  try {
    let ini = fs.readFileSync(settingIni, 'utf8')
    ini = /^brightness=.*$/m.test(ini)
      ? ini.replace(/^brightness=.*$/m, `brightness=${value}`)
      : ini.replace(/^\[DISPLAY\][^\n]*$/m, (m) => `${m}\nbrightness=${value}`)
    try {
      const tmp = `${settingIni}.tmp`
      fs.writeFileSync(tmp, ini)
      fs.renameSync(tmp, settingIni)
    } catch {
      fs.writeFileSync(settingIni, ini) // world-writable file; write in place if staging a tmp fails
    }
    return true
  } catch (err) {
    plog.debug(`setting.ini update skipped: ${err.message}`, { file: settingIni, error: err.message })
    return false
  }
}

function writeFlag(flag) {
  try { fs.writeFileSync(flag, '') } catch (err) { plog.error(`brightness off-flag write failed: ${err.message}`, { file: flag, error: err.message }) }
}

function clearFlag(flag) {
  try { fs.rmSync(flag, { force: true }) } catch { /* not off, nothing to clear */ }
}
