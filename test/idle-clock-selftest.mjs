// Idle wall clock: the "no teams known yet" idle screen is the crest with the wall clock.
// The old "Join WiFi" / "Open UI" QR crest (and the "is anyone on the console" check that swapped
// it for the clock) is gone, owner 17.11.2026: the scorer has the tablet.
//
// The clock is deliberately confined to the "no teams known yet" screen: once teams are set,
// kscw_idle already spends that side of the panel on their names.
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

function client(opts = {}) {
  const c = new LedboxClient({ hosts: ['127.0.0.1'], layoutSettleMs: 0, idleTickMs: 0, ...opts })
  c.ready = true
  c.seq = []
  c.sections = {}
  c._sendNow = async (cmd, value) => {
    if (cmd === 'SetLayout') c.seq.push(`layout:${value}`)
    else if (cmd === 'SetSections') {
      for (const s of value || []) {
        c.sections[s.name] = s.value.value
        c.seq.push(`${s.name}:${s.value.value}`)
      }
    }
    return 'ok'
  }
  return c
}

console.log('idle with no teams:')
const a = client()
await a.showIdle(true)
ok(a.currentLayout === 'kscw_clock', 'boots to the clock screen, with nobody on the console')
ok(/^\d\d:\d\d:\d\d$/.test(a.sections.time), `time section is HH:MM:SS (${a.sections.time})`)
ok(/^[A-Z][a-z]{2} \d\d\.\d\d\.\d{4}$/.test(a.sections.date), `date section is Ddd DD.MM.YYYY (${a.sections.date})`)
await a._idleTick()
ok(a.currentLayout === 'kscw_clock' && !a.seq.includes('layout:kscw_crest'), 'the ticker never puts the crest-only screen up')

console.log('\nclock only writes when the displayed text actually changes:')
const c = client()
// Freeze the clock so the assertion can't straddle a real second boundary and flake.
let fake = { time: '12:00:00', date: 'Tue 04.08.2026' }
c.formatClock = () => fake
await c.showIdle(true)
const writes = () => c.seq.filter((s) => s.startsWith('time:')).length
const first = writes()
await c._idleTick()
await c._idleTick()
ok(writes() === first, 'repeated ticks within the same second push nothing')
fake = { time: '12:00:01', date: 'Tue 04.08.2026' }
await c._idleTick()
ok(writes() === first + 1, 'a ticked second pushes exactly once')

console.log('\nteams known — named idle screen keeps its names:')
const d = client()
d._lastState = { leftName: 'KSCW', rightName: 'GAST' }
await d.showIdle(true)
ok(d.currentLayout === 'kscw_idle', 'uses the team-name idle screen, not the clock')
await d._idleTick()
ok(d.currentLayout === 'kscw_idle', 'and the ticker leaves it alone')
d.formatClock = () => fake
fake = { time: '19:42:05', date: 'Fri 06.11.2026' }
await d.showIdle(true)
ok(d.seq.includes('time:19:42:05'), 'the names screen carries the time, with seconds')
const dTimes = () => d.seq.filter((x) => x.startsWith('time:')).length
const dFirst = dTimes()
await d._idleTick()
ok(dTimes() === dFirst, 'no write while the second is the same')
fake = { time: '19:42:06', date: 'Fri 06.11.2026' }
await d._idleTick()
ok(d.seq.includes('time:19:42:06') && dTimes() === dFirst + 1, 'a new second writes once')
// H / T-: the time line counts down to kickoff, and only when there is one.
const realNow = Date.now
Date.now = () => 1_000_000_000_000
d.kickoffAt = () => 1_000_000_000_000 + 125 * 60_000 + 30_000
await d.setTimeMode('countdown')
ok(d.seq.includes('time:T - 125:30'), 'T - mm:ss, minutes past 59')
d.kickoffAt = () => 1_000_000_000_000 - 5000
d._idleTimeText = null
ok(d._timeText() === 'T - 00:00', 'stops at T - 00:00 once the game is due')
d.kickoffAt = () => null
ok(d._timeText() === fake.time, 'no kickoff known: the clock')
await d.setTimeMode('clock')
d.kickoffAt = () => 1_000_000_000_000 + 60_000
ok(d._timeText() === fake.time, 'back to the clock on the button')
Date.now = realNow
const oldLayout = client()
oldLayout._lastState = { leftName: 'KSCW', rightName: 'GAST' }
oldLayout._paintIdleTime = LedboxClient.prototype._paintIdleTime
const send = oldLayout.sendSections.bind(oldLayout)
oldLayout.sendSections = async (sections) => { if (sections.some((x) => x.name === 'time')) throw new Error('code 5'); return send(sections) }
ok(await oldLayout.showIdle(true) === true && oldLayout.currentLayout === 'kscw_idle', 'a board with the old layout keeps the names')
ok(oldLayout._idleTimeRefused === true, 'and is not asked for the time again')

console.log('\nboard without the clock layout falls back:')
const e = client()
e._sendNow = async (cmd, value) => {
  // The board answers code 5 for a layout it does not have.
  if (cmd === 'SetLayout' && value === 'kscw_clock') {
    const err = new Error('SetLayout: layout not present in device (5)'); err.code = 5; throw err
  }
  if (cmd === 'SetLayout') e.seq.push(`layout:${value}`)
  return 'ok'
}
e.on('error', () => {})
await e.showIdle(true)
ok(e.currentLayout === 'kscw_crest', 'falls back to the crest rather than a blank panel')

// A board that never had the KSCW layouts (a stock C0270, or one just reflashed) refuses ALL of
// them. The idle ticker runs every second, so without remembering a code-5 refusal it re-asks
// and re-logs forever — 77 errors in 25s when this was first wired up.
console.log('\nboard with no KSCW layouts at all stops asking:')
const g2 = client()
let setLayoutCalls = 0
g2._sendNow = async (cmd, value) => {
  if (cmd === 'SetLayout') {
    setLayoutCalls++
    if (String(value).startsWith('kscw_')) {
      const err = new Error('SetLayout: layout not present in device (5)'); err.code = 5; throw err
    }
  }
  return 'ok'
}
g2.on('error', () => {})
await g2.showIdle(true)
ok(g2.currentLayout === 'volleyball_matchscore_02', 'settles on the match-layout idle instead')
const afterFirst = setLayoutCalls
for (let i = 0; i < 5; i++) await g2._idleTick()
ok(setLayoutCalls === afterFirst, `five further ticks ask the board nothing (${setLayoutCalls} calls, was ${afterFirst})`)
ok(g2._missingLayouts.has('kscw_clock') && g2._missingLayouts.has('kscw_crest'), 'the refusals are remembered')

// Board that has the clock layout but NOT the crest. The clock attempt used to be nested
// inside the crest's availability check, so the clock was never tried — while _idleTick went on
// wanting it, re-entering showIdle once a second forever. Silently: the layout it wanted was
// never asked for, so nothing errored and nothing was logged.
console.log('\nclock present, crest missing — must not spin:')
const g3 = client()
let showIdleLayouts = []
g3._sendNow = async (cmd, value) => {
  if (cmd === 'SetLayout') {
    showIdleLayouts.push(value)
    if (value === 'kscw_crest' || value === 'kscw_idle') {
      const err = new Error('SetLayout: layout not present in device (5)'); err.code = 5; throw err
    }
  }
  return 'ok'
}
g3.on('error', () => {})
await g3.showIdle(true)
ok(g3.currentLayout === 'kscw_clock', `uses the clock even though the crest is gone (${g3.currentLayout})`)
const callsAfterFirst = showIdleLayouts.length
for (let i = 0; i < 5; i++) await g3._idleTick()
ok(showIdleLayouts.length === callsAfterFirst, `settled — five ticks issue no new SetLayout (${showIdleLayouts.length} vs ${callsAfterFirst})`)

console.log('\na transient failure stays retryable:')
const h = client()
ok(h._layoutAvailable('kscw_clock') === true, 'available before any failure')
h._noteLayoutMissing('kscw_clock', new Error('timeout'))            // no .code
ok(h._layoutAvailable('kscw_clock') === true, 'a timeout does not disqualify the layout')
const perm = new Error('nope'); perm.code = 5
h._noteLayoutMissing('kscw_clock', perm)
ok(h._layoutAvailable('kscw_clock') === false, 'only code 5 does')

console.log('\nformatClock:')
const f = client()
const fixed = f.formatClock(new Date(2026, 7, 4, 9, 5, 7))
ok(fixed.time === '09:05:07', `zero-pads the time (${fixed.time})`)
ok(fixed.date === 'Tue 04.08.2026', `zero-pads the date (${fixed.date})`)
const mid = f.formatClock(new Date(2026, 0, 1, 0, 0, 0))
ok(mid.time === '00:00:00', 'midnight is 00:00:00, not 24:00:00')
// Widest strings the layout must hold, measured against the board's own ARIAL: "23:59:59" is
// 109px at 28pt and the date 95px at 14pt, both inside the 128px column. Fixed widths mean no
// time or date can ever outgrow it.
ok(mid.time.length === 8, 'time string is a fixed 8 characters')
ok(mid.date.length === 14, 'date string is a fixed 14 characters, so it cannot outgrow the column')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
