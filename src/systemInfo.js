// Host diagnostics — what a monitor and keyboard plugged into the board would have told you.
//
// The C0270's enclosure exposes a 3.5 mm jack, one USB-A and one micro-USB. There is no
// micro-HDMI cutout, so the Pi's two HDMI ports are unreachable without opening the box: the
// only screen this appliance will ever realistically have is the tablet already running the
// scoring console. This module is what that screen shows instead.
//
// Two rules shaped everything below.
//
// **No subprocess.** `vcgencmd`, `systemctl` and `timedatectl` would each answer part of this in
// one line, and every one of them is a fork+exec on a machine whose other job is bit-banging
// HUB75 over GPIO with `--led-slowdown-gpio=5`. A diagnostics page that is polled every few
// seconds must not spawn anything. Everything here is a file read or a `node:` builtin.
//
// **No secrets.** This is served by an OPEN route, following the rule the rest of the API already
// follows (docs/logging-DESIGN.md: reads stay open, writes need the PIN) — and /api/logs, which is
// open, already carries more about the board's internals than anything here. So the bar is not
// "who can read it" but "what must never be in it": interface names, state and addresses, never
// the SSID or the passphrase; free space, never a file listing.

import fs from 'node:fs/promises'
import os from 'node:os'

const read = async (p) => { try { return (await fs.readFile(p, 'utf8')).trim() } catch { return '' } }
const exists = async (p) => { try { await fs.stat(p); return true } catch { return false } }
const mtime = async (p) => { try { return (await fs.stat(p)).mtime.toISOString() } catch { return null } }
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : null)

// `get_throttled` is a bitfield the firmware maintains. The low nibble is what is wrong RIGHT
// NOW; bits 16+ are sticky and record that it happened at some point since boot — which is the
// half that matters after the fact, because a brown-out during a match is long over by the time
// anyone looks. Under-voltage is the single most common cause of a Pi behaving strangely, and on
// this board the panel PSU and the Pi share a supply.
const THROTTLE_BITS = [
  ['underVoltage', 0, 'under-voltage right now'],
  ['freqCapped', 1, 'ARM frequency capped right now'],
  ['throttled', 2, 'throttled right now'],
  ['softTempLimit', 3, 'soft temperature limit active'],
  ['everUnderVoltage', 16, 'under-voltage has occurred since boot'],
  ['everFreqCapped', 17, 'frequency capping has occurred since boot'],
  ['everThrottled', 18, 'throttling has occurred since boot'],
  ['everSoftTempLimit', 19, 'soft temperature limit has been hit since boot'],
]

// The kernel's raspberrypi-firmware driver prints this value as bare hex with no `0x`, which is
// indistinguishable from decimal for anything under 10 — and `0` is what a healthy board reports,
// so the ambiguity is invisible until the day it finally isn't. Parsed as hex either way, and the
// raw string is passed through untouched so the page can show exactly what the file said.
export function parseThrottled(raw) {
  if (!raw) return null
  const v = parseInt(String(raw).replace(/^0x/i, ''), 16)
  if (!Number.isFinite(v)) return null
  const flags = {}
  for (const [name, bit] of THROTTLE_BITS) flags[name] = (v & (1 << bit)) !== 0
  return { raw: String(raw), value: v, ok: v === 0, ...flags }
}

// The thermal zone reports millidegrees. read() turns a missing or unreadable file into '', and
// Number('') is 0 — finite — so a board that cannot report its temperature showed a healthy 0 °C.
// No reading is null, never a number.
export function parseMilliC(raw) {
  if (raw == null || String(raw).trim() === '') return null
  const milli = Number(raw)
  return Number.isFinite(milli) ? Math.round(milli / 100) / 10 : null
}

async function cpu() {
  return {
    tempC: parseMilliC(await read('/sys/class/thermal/thermal_zone0/temp')),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cores: os.cpus().length,
    throttle: parseThrottled(await read('/sys/devices/platform/soc/soc:firmware/get_throttled')),
  }
}

// os.freemem() is not the number anyone wants — it excludes the page cache, which the kernel will
// hand back on demand, so it reads alarmingly low on a healthy machine. MemAvailable is the
// kernel's own estimate of what a new allocation could actually get.
async function mem() {
  const meminfo = await read('/proc/meminfo')
  const field = (k) => {
    const m = meminfo.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'))
    return m ? Number(m[1]) * 1024 : null
  }
  const total = field('MemTotal') ?? os.totalmem()
  const available = field('MemAvailable') ?? os.freemem()
  return { totalBytes: total, availableBytes: available, usedPct: pct(total - available, total) }
}

async function disk() {
  try {
    const s = await fs.statfs('/')
    const total = s.blocks * s.bsize
    // bavail, not bfree: bfree counts the root-reserved blocks that an unprivileged writer — which
    // is what the bridge is — can never actually use.
    const free = s.bavail * s.bsize
    return { totalBytes: total, freeBytes: free, usedPct: pct(total - free, total) }
  } catch {
    return null
  }
}

// Cumulative sectors written since boot, straight out of /proc/diskstats field 7. Deliberately
// NOT a rate: computing one here would mean holding state and sampling on a timer, and the page
// polls anyway — two readings and their timestamps give it a rate for free, and a more honest one
// than any window this module could pick on its own.
//
// It matters on this board specifically. The vendor's ledbox.py rewrites www/buffer.png and
// www/buffer_compressed.png onto the SD card several times a second, which measured ~6.4 GB/day
// on an SD16G Phison card dated 10/2019. Small rewrite-in-place files are the worst shape of
// workload for SD flash, and this counter is how you watch it.
async function storage() {
  const stats = await read('/proc/diskstats')
  const line = stats.split('\n').find((l) => /\s(mmcblk0|sda|nvme0n1)\s/.test(l))
  if (!line) return null
  const f = line.trim().split(/\s+/)
  const sectors = Number(f[9])
  if (!Number.isFinite(sectors)) return null
  // 512 is the kernel's fixed unit for this field, regardless of the device's real sector size.
  return { device: f[2], sectorsWritten: sectors, bytesWritten: sectors * 512 }
}

// Interface names and state only. The SSID the board is joined to is deliberately absent: this
// endpoint is reachable by anyone holding the scorer PIN on an open AP, and the hall's network
// name is not theirs to collect.
async function net() {
  const addrs = os.networkInterfaces()
  const names = await fs.readdir('/sys/class/net').catch(() => [])
  const out = []
  for (const name of names.sort()) {
    if (name === 'lo') continue
    out.push({
      name,
      state: (await read(`/sys/class/net/${name}/operstate`)) || 'unknown',
      addresses: (addrs[name] || []).filter((a) => !a.internal).map((a) => a.address),
    })
  }
  return out
}

// The board has no RTC. fake-hwclock only replays the last known time at boot, so if NTP cannot be
// reached the clock silently drifts — and because the bridge runs ON the board, every match-history
// entry is stamped with whatever it believes. This has already bitten once, ~36 h out, with the
// scoreboard working perfectly the whole time. Hence: sync state is a first-class reading here,
// not a footnote.
async function clock() {
  // systemd-timesyncd drops this the moment it accepts a server's answer, and /run is tmpfs, so
  // its presence means "synced during THIS boot" rather than "synced once, long ago".
  const marker = await exists('/run/systemd/timesync/synchronized')
  // Survives reboots — timesyncd touches it on every successful sync, so its mtime is the last
  // time this machine actually knew what time it was. Also serves as the "is timesyncd even the
  // thing keeping time here?" probe below.
  const lastSyncAt = await mtime('/var/lib/systemd/timesync/clock')

  // Tri-state, deliberately. Reading a missing marker as "NOT SYNCED" conflates two very
  // different situations: timesyncd running and failing (a real alarm, and on this board a
  // corrupted-history alarm) versus timesyncd not being the time source at all (nothing wrong).
  // The first version did conflate them and painted a red NOT SYNCED card on a perfectly healthy
  // machine — which is exactly how a warning light gets ignored on the night it means something.
  const synced = marker ? true : (lastSyncAt === null ? null : false)

  return {
    now: new Date().toISOString(),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    synced,
    lastSyncAt,
  }
}

export async function systemInfo() {
  const [c, m, d, s, n, k] = await Promise.all([cpu(), mem(), disk(), storage(), net(), clock()])
  return {
    host: {
      hostname: os.hostname(),
      kernel: os.release(),
      arch: process.arch,          // 'arm' here: armhf userland on an arm64 kernel
      node: process.version,
      uptimeSec: Math.round(os.uptime()),
      processUptimeSec: Math.round(process.uptime()),
    },
    cpu: c,
    mem: m,
    disk: d,
    storage: s,
    net: n,
    clock: k,
    at: new Date().toISOString(),
  }
}
