// The Point Hub board's hardware, as the appliance sees it: pointhubd (firmware/pointhubd) owns the
// I2C bus and writes /run/pointhub/hw.json; this reads it, turns it into checks a scorer can act on,
// decides what the STATUS and LINK lights show, and runs the per-module self-test.
//
// The C0270 has no pointhubd, so it never has that file, and `present` stays false: no route shows
// anything, no timer does anything and no socket is opened on that board. Nothing on the C0270 path
// changes with this module.
//
// The split with pointhubd is deliberate. The thermal cut-off and the power budget stay in the
// daemon, working with this process dead. What lives here is what needs the rest of the appliance:
// words, the network state and the panel. "No subprocess" (systemInfo.js) holds here too: a file
// read, a /sys read and a unix socket.

import fs from 'node:fs'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

export const HW_DIR = '/run/pointhub'
// hw.json is rewritten every second; this old means the daemon has stopped.
const STALE_MS = 15_000
const TICK_MS = 2_000

// The fuse map's names for the eight modules (BUILD.md section 5.4): plugs 1-6, L and R.
export const MODULE_NAMES = ['1', '2', '3', '4', '5', '6', 'L', 'R']

const LEVELS = { ok: 0, warn: 1, bad: 2 }

const row = (id, label, level, text) => ({ id, label, level, text })

// The lines of the Diagnostics page (BUILD.md section 6). Pure, so every threshold is tested without
// a board. `hw` is hw.json or null; `stale` says the daemon stopped. `net` and `panel` come from the
// appliance. Each line says what is wrong in words a scorer can act on, not what chip reported it.
export function evaluateChecks({ hw, stale = false, panel = {}, net: netState = {}, cpuTempC = null, diskFreeBytes = null }) {
  const out = []
  if (!hw || stale) {
    out.push(row('service', 'Hardware service', 'bad', hw
      ? 'The hardware service stopped reporting. The power budget stays at its last value: restart the board between sets.'
      : 'The hardware service is not running: no charger, temperature or current readings.'))
    return out
  }

  // Charger and contract.
  const pd = hw.pd || {}
  if (pd.source === 'bench') {
    out.push(row('charger', 'Charger', 'warn', `Bench supply set to ${pd.watts} W: no charger is being read.`))
  } else if (!pd.contract) {
    out.push(row('charger', 'Charger', 'warn', 'Cannot read the charger. The picture stays dim to be safe.'))
  } else if (!pd.watts) {
    out.push(row('charger', 'Charger', 'warn', 'Charger connected, but the input voltage cannot be read. The picture stays dim to be safe.'))
  } else if (pd.watts < 45) {
    out.push(row('charger', 'Charger', 'warn', `Weak charger (${pd.watts} W): the picture is dimmed. Use 65 W or more for full brightness.`))
  } else {
    out.push(row('charger', 'Charger', 'ok', contractText(pd)))
  }
  const input = hw.input
  if (input && pd.volts && input.volts < pd.volts * 0.9) {
    out.push(row('input', 'Charger under load', 'warn', `The charger sags to ${input.volts.toFixed(1)} V under load. Try a stronger charger or a better cable.`))
  }

  // Supply.
  const th = hw.throttled
  if (th && th.undervoltage_now) {
    out.push(row('supply', 'Power supply', 'bad', 'Too little power right now. Use a stronger charger; the picture is being dimmed.'))
  } else if (th && th.undervoltage_since_boot) {
    out.push(row('supply', 'Power supply', 'warn', 'The power dipped since the board started. Check the charger and the cable.'))
  } else if (th) {
    out.push(row('supply', 'Power supply', 'ok', 'Steady.'))
  }

  // The 5 V rail.
  const rail = hw.rail
  if (rail) {
    const level = rail.volts < 4.75 ? 'bad' : rail.volts < 4.9 ? 'warn' : 'ok'
    out.push(row('rail', '5 V rail', level, level === 'ok'
      ? `${rail.volts.toFixed(2)} V, ${rail.amps.toFixed(1)} A`
      : `Only ${rail.volts.toFixed(2)} V at ${rail.amps.toFixed(1)} A. Check the converter's wires and the input fuse.`))
  }

  // Box temperature. 45 C warns and dimming starts at 50 C; the board only blanks at 60 C.
  const env = hw.env
  if (env) {
    const hot = hw.budget && hw.budget.blanked
    let level = 'ok'
    let text = `${env.temp_c.toFixed(0)} °C, humidity ${env.rh.toFixed(0)} %`
    if (hot || env.temp_c >= 60) { level = 'bad'; text = `${env.temp_c.toFixed(0)} °C: too hot, the panel is off. Let the box cool down.` }
    else if (env.temp_c >= 50) { level = 'warn'; text = `${env.temp_c.toFixed(0)} °C: hot, the picture is being dimmed. Open the back panel between sets.` }
    else if (env.temp_c >= 45) { level = 'warn'; text = `${env.temp_c.toFixed(0)} °C: getting hot.` }
    else if (env.rh > 80) { level = 'warn'; text = `Humidity ${env.rh.toFixed(0)} %: dry the box before using it.` }
    out.push(row('box', 'Box temperature', level, text))
  }

  // CPU.
  if (Number.isFinite(cpuTempC)) {
    const level = cpuTempC >= 80 ? 'bad' : cpuTempC >= 75 ? 'warn' : 'ok'
    out.push(row('cpu', 'Computer temperature', level, level === 'ok' ? `${cpuTempC.toFixed(0)} °C` : `${cpuTempC.toFixed(0)} °C: hot. Check that the fan runs.`))
  }

  // The clock battery. A warning: the board keeps scoring, only its time can be wrong after a restart.
  if (hw.clock_battery_ok === false) {
    out.push(row('clock', 'Clock battery', 'warn', 'Clock battery empty or missing. The time is wrong until the board is online.'))
  }

  // Parts on the bus.
  const parts = hw.parts || {}
  const names = {
    stusb4500: 'charger chip (STUSB4500)', sht40: 'temperature sensor (SHT40)', ds3231: 'clock (DS3231)',
    mcp23017: 'horn and light switch (MCP23017)', ina_rail: '5 V current sensor (INA226)', ina_input: 'input current sensor (INA226)',
  }
  const missing = Object.keys(names).filter((k) => parts[k] === false)
  if (hw.bus == null) {
    out.push(row('parts', 'Small boards', 'bad', 'No small board answers at all. Check the wires to pins 27 and 28.'))
  } else if (missing.length) {
    out.push(row('parts', 'Small boards', 'bad', `Not answering: ${missing.map((k) => names[k]).join(', ')}. Check its wires.`))
  } else {
    out.push(row('parts', 'Small boards', 'ok', 'All answering.'))
  }
  if (hw.power_file_error) {
    out.push(row('governor', 'Power limit', 'bad', 'The power limit cannot reach the panel driver. Keep the brightness low and restart the board.'))
  }

  // Panel driver.
  if (panel.connected === false) {
    out.push(row('panel', 'LED panel', 'bad', 'The panel software is not running. It restarts by itself; if this stays, restart the board.'))
  } else if (panel.driverLive === false) {
    out.push(row('panel', 'LED panel', 'bad', 'The panel driver stopped. It restarts by itself; if this stays, restart the board.'))
  } else if (panel.connected) {
    out.push(row('panel', 'LED panel', 'ok', 'Painting.'))
  }

  // Self-test: a fuse or module that failed the last run stays a warning until it passes.
  const st = panel.selfTest
  if (st && st.failed && st.failed.length) {
    out.push(row('selftest', 'Self-test', 'bad', st.failed.map((m) => `Module ${m} / fuse ${m}: no current`).join('; ') + '. Check the fuse and the module\'s power lead.'))
  } else if (st && st.error) {
    out.push(row('selftest', 'Self-test', 'warn', st.error))
  } else if (st && st.ok) {
    out.push(row('selftest', 'Self-test', 'ok', 'Every module draws current.'))
  }

  // Disk.
  if (Number.isFinite(diskFreeBytes) && diskFreeBytes < 2e9) {
    out.push(row('disk', 'SD card', 'warn', `Only ${(diskFreeBytes / 1e9).toFixed(1)} GB free.`))
  }

  // Network is information: the board scores fully offline, so nothing here is ever a fault of the board.
  out.push(row('network', 'Connections', 'ok', networkText(netState)))
  return out
}

// The backup copy on a stick (provisioning/point-hub/pointhub-backup-stick writes one status file per
// stick). No stick is not a fault and no line: it is optional. One whose status stopped updating is
// gone, or its copy job died, so it says so instead of claiming a copy that is not happening.
export function stickChecks(sticks, nowMs = Date.now()) {
  return (sticks || []).map((s) => {
    const age = nowMs - (s.ts || 0) * 1000
    if (s.state === 'format') return row('stick', 'Backup stick', 'warn', 'This stick cannot be used. Format it as FAT32 or exFAT on a computer.')
    if (s.state === 'mount-failed') return row('stick', 'Backup stick', 'warn', 'This stick cannot be read. Try another one.')
    if (age > 30_000) return row('stick', 'Backup stick', 'warn', 'The copy to the stick has stopped. Take it out and plug it in again.')
    if (s.state !== 'ok') return row('stick', 'Backup stick', 'warn', 'Copying to the stick failed: it may be full. The match is safe on the board.')
    return row('stick', 'Backup stick', 'ok', `Copying: ${s.files} ${s.files === 1 ? 'file' : 'files'} on the stick.`)
  })
}

export function contractText(pd) {
  if (!pd || !pd.watts) return ''
  if (pd.source === 'bench') return `Bench ${pd.watts} W`
  return `PD ${pd.volts} V ${pd.amps} A, ${Math.round(pd.watts)} W`
}

function networkText({ cable, wifi, uplink } = {}) {
  const bits = []
  bits.push(cable ? 'Tablet cable connected' : 'No tablet cable')
  if (uplink === 'online') bits.push('online')
  else if (uplink === 'portal') bits.push('Wi-Fi needs the hall login')
  else if (wifi) bits.push('Wi-Fi without internet')
  else bits.push('no Wi-Fi')
  return bits.join(', ')
}

// What STATUS shows (BUILD.md section 6). The most serious state wins.
export function statusLight(checks, { starting = false } = {}) {
  if (starting) return 'yellow_blink'
  const worst = (checks || []).reduce((w, c) => Math.max(w, LEVELS[c.level] ?? 0), 0)
  return worst === LEVELS.bad ? 'red_blink' : worst === LEVELS.warn ? 'yellow' : 'green'
}

// What LINK shows (BUILD.md section 6).
export function linkLight({ cable = false, wifi = false, uplink = 'offline', liveFailing = false } = {}) {
  if (uplink === 'online') {
    if (liveFailing) return 'red_blink'
    return cable ? 'cyan' : 'green'
  }
  if (cable) return 'blue'
  if (uplink === 'checking' && wifi) return 'yellow_blink'
  if (uplink === 'portal' || wifi) return 'yellow'
  return 'off'
}

// One module's current step against the others. HUB75 gives no feedback, but every module has its
// own fuse, so a module whose step is far below the rest is a blown fuse, a loose lead or a dead
// module. A third of the median, as in BUILD.md section 6. `stepsMa` lists the modules in order.
export function analyseSelfTest(stepsMa, names = MODULE_NAMES) {
  const sorted = [...stepsMa].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  // No step anywhere is not eight blown fuses: it is the sensor, the input fuse or a dark panel.
  if (median < 15) {
    return { ok: false, median, failed: [], error: 'No module changed the current. Check the panel brightness and the 5 V current sensor.' }
  }
  const failed = stepsMa.flatMap((ma, i) => (ma < median / 3 ? [names[i] ?? String(i + 1)] : []))
  return { ok: failed.length === 0, median, failed, error: null }
}

export class BoardHardware {
  constructor({ dir = HW_DIR, socketPath = null, sysNet = '/sys/class/net', log = null, sleepFn = sleep, now = () => Date.now(), settleMs = 350 } = {}) {
    this.dir = dir
    this.socketPath = socketPath || `${dir}/ctl.sock`
    this.sysNet = sysNet
    this.log = log
    this.sleep = sleepFn
    this.now = now
    this.settleMs = settleMs
    this.timer = null
    this.inputs = null
    this.selfTestResult = null
    this.selfTesting = false
    this.startedAt = now()
    this.lastLights = null
  }

  // Whether this board has the hardware at all. hw.json appears within a second of pointhubd
  // starting, and /run is empty again after every boot, so the file itself is the answer.
  get present() {
    try { return fs.existsSync(`${this.dir}/hw.json`) } catch { return false }
  }

  read() {
    try {
      const hw = JSON.parse(fs.readFileSync(`${this.dir}/hw.json`, 'utf8'))
      const stale = !Number.isFinite(hw.ts) || this.now() - hw.ts * 1000 > STALE_MS
      return { hw, stale }
    } catch {
      return { hw: null, stale: true }
    }
  }

  // Ask pointhubd. Never throws: a dead daemon is a state the caller reports, not an exception.
  ask(msg, timeoutMs = 2000) {
    return new Promise((resolve) => {
      let data = ''
      let done = false
      const finish = (reply) => {
        if (done) return
        done = true
        clearTimeout(timer)
        sock.destroy()
        resolve(reply)
      }
      const sock = net.createConnection(this.socketPath)
      const timer = setTimeout(() => finish({ ok: false, error: 'the hardware service did not answer' }), timeoutMs)
      sock.setEncoding('utf8')
      sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`))
      sock.on('data', (d) => {
        data += d
        if (!data.includes('\n')) return
        try { finish(JSON.parse(data)) } catch { finish({ ok: false, error: 'the hardware service answered nonsense' }) }
      })
      sock.on('error', (err) => finish({ ok: false, error: `the hardware service is not running (${err.code || err.message})` }))
      sock.on('close', () => finish({ ok: false, error: 'the hardware service hung up' }))
    })
  }

  _carrier(ifc) {
    try { return fs.readFileSync(`${this.sysNet}/${ifc}/carrier`, 'utf8').trim() === '1' } catch { return false }
  }

  _readSticks() {
    let names = []
    try { names = fs.readdirSync(this.dir).filter((f) => /^stick-.*\.json$/.test(f)) } catch { return [] }
    return names.flatMap((f) => {
      try { return [JSON.parse(fs.readFileSync(`${this.dir}/${f}`, 'utf8'))] } catch { return [] }
    })
  }

  _linkInputs() {
    const inputs = this.inputs ? this.inputs() : {}
    return {
      cable: this._carrier('eth0'),
      wifi: this._carrier('wlan1') || this._carrier('wlan0'),
      uplink: inputs.uplink || 'offline',
      liveFailing: !!inputs.liveFailing,
    }
  }

  view() {
    if (!this.present) return { present: false }
    const { hw, stale } = this.read()
    const inputs = this.inputs ? this.inputs() : {}
    const net = this._linkInputs()
    const panel = { connected: inputs.panelConnected, driverLive: inputs.driverLive, selfTest: this.selfTestResult }
    const checks = [
      ...evaluateChecks({ hw, stale, panel, net, cpuTempC: inputs.cpuTempC ?? null, diskFreeBytes: inputs.diskFreeBytes ?? null }),
      ...stickChecks(this._readSticks(), this.now()),
    ]
    return {
      present: true,
      stale,
      contract: hw ? contractText(hw.pd) : '',
      budget: hw && hw.budget ? { ma: hw.budget.ma, reasons: hw.budget.reasons, blanked: hw.budget.blanked } : null,
      rail: hw ? hw.rail : null,
      input: hw ? hw.input : null,
      env: hw ? hw.env : null,
      lights: hw ? hw.lights : null,
      selfTesting: this.selfTesting,
      selfTest: this.selfTestResult,
      checks,
    }
  }

  // The short form for /api/status and the console's header. Absent on a board without the hardware,
  // so nothing the C0270's console reads changes.
  brief() {
    if (!this.present) return null
    const v = this.view()
    const worst = v.checks.reduce((w, c) => Math.max(w, LEVELS[c.level] ?? 0), 0)
    return { contract: v.contract, dimmed: !!(v.budget && v.budget.reasons && v.budget.reasons.length), level: ['ok', 'warn', 'bad'][worst] }
  }

  // Keep the lights in step. `inputs()` supplies what only the appliance knows; called every tick so
  // the daemon's "console stopped talking" timer (LIGHTS_STALE_S) only runs out if this process dies.
  start(inputs) {
    this.inputs = inputs
    const tick = () => { this.updateLights().catch(() => {}) }
    this.timer = setInterval(tick, TICK_MS)
    if (this.timer.unref) this.timer.unref()
    tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async updateLights() {
    if (!this.present) return null
    const v = this.view()
    const net = this._linkInputs()
    const inputs = this.inputs ? this.inputs() : {}
    const starting = this.selfTesting || inputs.panelConnected !== true
    const lights = { status: statusLight(v.checks, { starting: starting && this.now() - this.startedAt < 120_000 }), link: linkLight(net) }
    const reply = await this.ask({ cmd: 'lights', ...lights })
    if (reply.ok) this.lastLights = lights
    return lights
  }

  async horn(ms) {
    return this.ask({ cmd: 'horn', ms })
  }

  // The power-on self-test (BUILD.md section 6): every module dark for a baseline, then each module
  // alone in white at the brightness already set, while the 5 V INA226 reads the step.
  //
  // `panel` supplies paint(moduleIndex|null) and modules (how many). Nothing here touches brightness:
  // white at the console's level is enough for the sensor (1.25 mA per count against hundreds of mA)
  // and it stays under the governor like every other frame.
  async runSelfTest(panel) {
    if (this.selfTesting) return { ok: false, error: 'A self-test is already running.' }
    this.selfTesting = true
    const finish = (result) => {
      const stamped = { ...result, at: new Date(this.now()).toISOString() }
      this.selfTestResult = stamped
      return stamped
    }
    try {
      const measure = async () => {
        await this.sleep(this.settleMs)
        const r = await this.ask({ cmd: 'measure' })
        return r.ok && r.rail ? r.rail.amps * 1000 : null
      }
      await panel.paint(null)
      const baseline = await measure()
      if (baseline == null) return finish({ ok: false, failed: [], stepsMa: [], error: 'The 5 V current sensor does not answer, so the modules could not be checked.' })
      const steps = []
      for (let i = 0; i < panel.modules; i++) {
        await panel.paint(i)
        const ma = await measure()
        if (ma == null) return finish({ ok: false, failed: [], stepsMa: steps, error: 'The 5 V current sensor stopped answering during the self-test.' })
        steps.push(Math.round(ma - baseline))
      }
      const verdict = analyseSelfTest(steps)
      return finish({ ...verdict, stepsMa: steps, baselineMa: Math.round(baseline) })
    } catch (err) {
      return finish({ ok: false, failed: [], stepsMa: [], error: `The self-test could not paint the panel: ${err.message}` })
    } finally {
      this.selfTesting = false
    }
  }
}
