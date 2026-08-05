// Host diagnostics — the board's only screen.
//
// The C0270's enclosure exposes a 3.5 mm jack, one USB-A and one micro-USB. There is no
// micro-HDMI cutout, so the Pi's two HDMI ports cannot be reached without opening the box, and
// the serial console on header pins 8/10 needs the lid off too. Until someone does that, the
// tablet running the scoring console is the ONLY way to see what the board thinks is happening —
// which makes /api/system and the Diagnostics tab load-bearing rather than a nicety.
//
// Three things are worth locking down, and they fail in different ways:
//   1. The throttle bitfield. Its sticky bits (16-19) are the only record that a brown-out
//      happened at all, and a wrong shift silently reports a healthy board forever.
//   2. The endpoint's shape and its silence about secrets. It is an OPEN read, by the same rule
//      the rest of the API follows, so what it does NOT contain is part of its contract.
//   3. The console only polls while you are looking at it. A 5 s poll and an SSE socket left
//      running behind the Game tab is battery drain on a tablet that has to last an evening.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemInfo, parseThrottled } from '../src/systemInfo.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

console.log('[1] the throttle bitfield decodes, including the sticky half')
{
  // A healthy board.
  const zero = parseThrottled('0')
  ok(zero.ok, 'all-clear reports ok')
  ok(!zero.underVoltage && !zero.everUnderVoltage, 'and no flags at all')

  // The kernel prints this as bare hex with no 0x, which for anything under 10 is
  // indistinguishable from decimal — and 0 is what a healthy board reports, so the ambiguity is
  // invisible right up until it isn't. 0x50000 = bits 16 and 18 = under-voltage AND throttling
  // have both occurred since boot, with nothing wrong at this instant. That is precisely the
  // reading you get the morning after a brown-out, and the one that must not be lost.
  const sticky = parseThrottled('50000')
  ok(!sticky.ok, 'a sticky-only value is not "ok"')
  ok(!sticky.underVoltage, 'nothing wrong right now…')
  ok(sticky.everUnderVoltage, '…but under-voltage HAS happened since boot')
  ok(sticky.everThrottled, 'and so has throttling')
  ok(!sticky.everFreqCapped, 'while capping has not — the bits are read individually')

  // Live under-voltage: bit 0 plus its sticky twin, which is what the firmware actually sets.
  const now = parseThrottled('0x10001')
  ok(now.underVoltage, 'a live under-voltage is reported as live')
  ok(now.everUnderVoltage, 'and also recorded as having happened')
  ok(parseThrottled('4').throttled, 'bit 2 is "throttled right now"')
  ok(parseThrottled('8').softTempLimit, 'bit 3 is the soft temperature limit')

  // Degradation: on anything that is not a Pi the sysfs file does not exist, and the page must
  // say "unavailable" rather than render a confident all-clear it cannot know.
  eq(parseThrottled(''), null, 'a missing sysfs file yields null, not a false all-clear')
  eq(parseThrottled('nonsense'), null, 'and so does an unparseable one')
}

console.log('\n[2] systemInfo returns something usable on this machine')
{
  const s = await systemInfo()
  ok(s && typeof s === 'object', 'it returns an object')
  ok(Number.isFinite(s.host.uptimeSec) && s.host.uptimeSec > 0, `host uptime is real (${s.host.uptimeSec}s)`)
  ok(Array.isArray(s.cpu.load) && s.cpu.load.length === 3, 'load average has three figures')
  ok(s.mem.totalBytes > 0 && s.mem.availableBytes > 0, 'memory totals are populated')
  ok(s.mem.availableBytes <= s.mem.totalBytes, 'and available never exceeds total')
  // MemAvailable, not MemFree: the latter excludes reclaimable page cache and reads alarmingly
  // low on a perfectly healthy machine, which is exactly the false alarm this page must not raise.
  //
  // Asserted against the SOURCE rather than by comparing the reading to os.freemem(). That
  // comparison is what this test did first, and it failed once and passed on the retry: the two
  // figures are sampled at different instants, and a large `fsck` finishing in the background
  // released enough page cache in between to push freemem() above the earlier MemAvailable. A
  // test that depends on what else the machine is doing is worse than no test — it teaches you
  // to re-run until green.
  const modSrc = fs.readFileSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systemInfo.js'), 'utf8')
  ok(/field\('MemAvailable'\)/.test(modSrc), "memory is read from MemAvailable, not MemFree")
  ok(s.disk && s.disk.totalBytes > 0, 'statfs answered for /')
  ok(s.disk.freeBytes <= s.disk.totalBytes, 'and free never exceeds total')
  ok(Array.isArray(s.net), 'interfaces are a list')
  ok(!s.net.some((n) => n.name === 'lo'), 'loopback is filtered out — it tells nobody anything')
  // Tri-state on purpose. `false` must mean "timesyncd is here and has NOT synced" — a real
  // alarm, and on this board a corrupted-match-history alarm — while `null` means nothing here
  // keeps time with timesyncd at all. The first version returned a plain boolean and painted a
  // red NOT SYNCED card on a perfectly healthy dev machine, which is how a warning light gets
  // ignored on the night it finally means something.
  ok(s.clock.synced === true || s.clock.synced === false || s.clock.synced === null,
    `clock sync is true / false / null (got ${JSON.stringify(s.clock.synced)})`)
  ok(!(s.clock.synced === false && s.clock.lastSyncAt === null),
    'a hard "not synced" is only reported when timesyncd is actually present')
  ok(new Date(s.at).toString() !== 'Invalid Date', 'the reading is timestamped')
}

console.log('\n[3] nothing in the payload is a secret')
{
  const s = await systemInfo()
  const blob = JSON.stringify(s)
  // The board runs its own AP. The passphrase and the SSID live in a 0600 NetworkManager keyfile
  // and in a QR image that is gitignored precisely because the image IS the credential — so an
  // open endpoint that names the network would undo both of those.
  ok(!/ssid/i.test(blob), 'no SSID field')
  ok(!/psk|passphrase|password|wifi_?key/i.test(blob), 'no passphrase-shaped key')
  ok(!/scorerPin|x-scorer-pin/i.test(blob), 'no scorer PIN')
  // Every key is one of the known set. A future `...os.userInfo()` or a whole /proc dump would
  // fail here rather than quietly start publishing usernames and home directories.
  const allowed = new Set(['host', 'cpu', 'mem', 'disk', 'storage', 'net', 'clock', 'at'])
  const extra = Object.keys(s).filter((k) => !allowed.has(k))
  ok(extra.length === 0, `no unexpected top-level keys${extra.length ? ` — found ${extra.join(', ')}` : ''}`)
}

console.log('\n[4] end to end: the appliance serves it, and serves it open')
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-diag-'))
  let app
  try {
    app = await startAppliance({
      stateDir,
      relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
      mock: true, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    await sleep(150)

    // Deliberately NO X-Scorer-Pin header. Reads stay open (docs/logging-DESIGN.md) and
    // /api/logs — which carries client IPs and the board's internals — is already open, so
    // gating a strictly less revealing read would be inconsistent rather than safer.
    const res = await fetch(base + '/api/system')
    eq(res.status, 200, 'GET /api/system with no PIN is answered')
    const body = await res.json()
    ok(body.host && body.cpu && body.clock, 'and carries the diagnostics')
    ok(Number.isFinite(body.host.processUptimeSec), 'including how long the bridge itself has been up')

    // Two readings are what the page turns into a write RATE — the number that actually predicts
    // when this SD card dies, since it is worn out by constant small rewrites rather than by
    // filling up. A cumulative counter that went backwards would produce a negative rate.
    if (body.storage) {
      await sleep(120)
      const second = await (await fetch(base + '/api/system')).json()
      ok(second.storage.bytesWritten >= body.storage.bytesWritten,
        'the write counter is cumulative and never goes backwards')
      ok(new Date(second.at) > new Date(body.at), 'and successive readings are ordered in time')
    } else {
      ok(true, 'no block device counter on this host — skipped (the board has one)')
    }
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('\n[5] the console only works when it is being looked at')
{
  const here = path.dirname(fileURLToPath(import.meta.url))
  const html = fs.readFileSync(path.resolve(here, '..', 'web', 'index.html'), 'utf8')
  const js = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || ''

  ok(/id="tab-diag"/.test(html), 'the Diagnostics tab exists')
  ok(/data-tab="diag"/.test(html), 'and is reachable from the nav')
  ok(/new EventSource\(`\/api\/logs\/stream/.test(js),
    'the log tail uses SSE — the board serves it and it reconnects itself; there is no ws client in production')
  // The failure this prevents: a 5 s poll and an open SSE socket running all evening behind the
  // Game tab, on a tablet that is usually on battery and has to last the whole match.
  ok(/if \(b\.dataset\.tab === "diag"\) startDiag\(\); else stopDiag\(\);/.test(js),
    'leaving the tab stops the poll and closes the socket')
  ok(/if \(document\.hidden\) stopDiag\(\)/.test(js), 'and so does the screen going away')
  ok(/if \(document\.hidden\) return;/.test(js), 'the poll itself also refuses to run while hidden')
  // Log lines carry operator-typed team names straight off the wire. This is the one place in
  // the tab where innerHTML would be reachable by anything a person typed.
  ok(/m\.textContent = \(e\.msg \|\| ""\)/.test(js), 'log messages are set as text, never as markup')
  ok(!/logList[^\n]*innerHTML/.test(js), 'and the list is never built by string concatenation')
  ok(/LOG_MAX_ROWS/.test(js), 'the tail is capped, so an evening of logs cannot grow the DOM without bound')
  // One `error` entry carries a whole stack trace; three fill a tablet screen. The tail stops
  // being scannable exactly when something is going wrong and you most need to scan it.
  ok(/LOG_DATA_MAX/.test(js) && /extra\.slice\(0, LOG_DATA_MAX\)/.test(js),
    'and each row\'s attached object is truncated so one stack trace cannot fill the screen')
  ok(/li\.title = /.test(js), 'with the full object kept on the row for a long-press')
  // The clock card's three states must stay three. Collapsing null back into the false branch is
  // a one-character edit that re-introduces the false alarm.
  ok(/c\.synced === true/.test(js) && /c\.synced === false/.test(js),
    'the clock card distinguishes not-synced from sync-state-unknown')

  // The sport picker opens on load and covers the whole page. If the board is misbehaving, that
  // is the moment you find out — so getting to the log must not require dismissing the dialog
  // and then knowing which tab to hunt for.
  ok(/id="spDiag"/.test(html), 'the sport picker offers a way straight to Diagnostics')
  // Via goToTab, which clicks the real nav button, so startDiag() runs. Toggling .active by hand
  // would show the tab with every card reading "—" and no log, forever.
  ok(/spDiagBtn\.addEventListener\("click", \(\) => \{ closeSportPicker\(\); goToTab\("diag"\); \}\)/.test(js),
    'and it goes through goToTab so the tab actually starts polling')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
