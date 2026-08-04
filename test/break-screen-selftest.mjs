// The break screen (warm-up / set interval / timeout) and what it leaves behind.
//
// The reported fault: "I gave a T/O after a warm-up, and first the warm-up countdown flashed,
// then it went to TO."
//
// The board keeps every layout's section values. Leaving the break screen without clearing it
// means re-entering shows the PREVIOUS countdown until the new SetSections lands — and the layout
// switch has a deliberate settle delay in front of it, so that stale frame is on the panel for
// long enough to read. There was already a blank-on-exit for exactly this reason; it cleared
// `lbl` and `timer` and missed `timerbig`.
//
// `timerbig` exists because the break screen has TWO clock sections: with a team name above it
// the clock sits lower and smaller (`timer`), without one it moves up and grows (`timerbig`).
// A warm-up has no team, so it writes `timerbig` — precisely the one the blank missed. A timeout
// has a team, so it writes `timer`. Warm-up → timeout is therefore the exact pair of countdowns
// that reproduces it, and the one the operator hit.
//
// None of this was covered because MockLedbox does not model the break layout at all — it rejects
// `timerbig` and `team` as unknown sections — so these tests drive the client through a stubbed
// wire and assert on what it actually puts on the line.

import { LedboxClient } from '../src/ledboxClient.js'
import { toBreakSections } from '../src/volleyballMapper.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

// Value written for `section`.`attrib` in a SetSections payload, or undefined if not written at
// all. "Not written" is the interesting case here: it is how stale content survives.
const wrote = (sections, name, attrib = 'text') => {
  const hit = (sections || []).find((s) => s.name === name && s.value.attrib === attrib)
  return hit ? hit.value.value : undefined
}

const STATE = { side_a: 'left', team_a_short: 'KSCW', team_b_short: 'VZH', points_a: 5, points_b: 3 }

console.log('[1] the two clock sections are mutually exclusive')
{
  // Warm-up: no team above the clock, so the big one carries it and the small one is cleared.
  const warmup = toBreakSections(null, { timerText: '10:00', label: 'WARM-UP', content: 'none' })
  eq(wrote(warmup, 'timerbig'), '10:00', 'warm-up writes the BIG clock')
  eq(wrote(warmup, 'timer'), '', 'and blanks the small one')

  // Timeout: a team name sits above the clock, so they swap roles.
  const to = toBreakSections(STATE, { timerText: '30', label: 'TIMEOUT', content: 'full', team: 'KSCW' })
  eq(wrote(to, 'timer'), '30', 'a timeout writes the SMALL clock')
  eq(wrote(to, 'timerbig'), '', 'and blanks the big one')
  eq(wrote(to, 'team'), 'KSCW', 'with the team above it')
}

console.log('\n[2] the blank-on-exit clears EVERY text section, not just two')
{
  const blank = toBreakSections(null, { timerText: null, label: '', content: 'none' })
  // Each of these is a way for a previous countdown to survive onto the next one.
  eq(wrote(blank, 'timerbig'), '', 'timerbig cleared — the one the old blank missed')
  eq(wrote(blank, 'timer'), '', 'timer cleared')
  eq(wrote(blank, 'team'), '', 'team cleared')
  eq(wrote(blank, 'lbl'), '', 'lbl cleared')
  // An empty label used to skip the write entirely, which does not blank the label — it leaves
  // whatever the last break screen put there.
  ok(wrote(blank, 'lbl') !== undefined, 'and lbl is actually WRITTEN, not skipped because it is empty')
}

console.log('\n[3] end to end: warm-up then timeout, the reported sequence')
{
  // Stub the wire so the real pushCountdown/setLayoutIfNeeded logic runs and every command is
  // recorded. layoutSettleMs is dropped to keep the test quick; it does not change the ordering.
  const c = new LedboxClient({ hosts: ['127.0.0.1'], layoutSettleMs: 0, pulseIntervalMs: 5 })
  c.ready = true
  c.sent = []
  c._sendNow = async (cmd, value) => { c.sent.push({ cmd, value }); return 'ok' }
  c._lastState = STATE
  c.currentLayout = c.layout

  const sectionsSent = () => c.sent.filter((s) => s.cmd === 'SetSections').map((s) => s.value)
  const layoutsSent = () => c.sent.filter((s) => s.cmd === 'SetLayout').map((s) => s.value ?? s.name)

  // 1. Warm-up runs on the break screen.
  await c.pushCountdown(600, 'WARM-UP', { content: 'none' })
  const warm = sectionsSent().at(-1)
  eq(wrote(warm, 'timerbig'), '10:00', 'warm-up put 10:00 in the big clock')
  ok(layoutsSent().includes(c.breakLayout), 'and switched to the break layout')

  // 2. Warm-up ends — back to the match.
  c.sent = []
  await c.pushCountdown(null)
  const onExit = sectionsSent()[0]
  eq(wrote(onExit, 'timerbig'), '',
    'leaving the countdown blanks the BIG clock — without this the warm-up time is still on the board')
  eq(wrote(onExit, 'lbl'), '', 'and the label')
  ok(layoutsSent().includes(c.layout), 'then returns to the match layout')

  // 3. The timeout the operator then called. Nothing from the warm-up may be left to flash.
  c.sent = []
  await c.pushCountdown(30, 'TIMEOUT', { content: 'full', team: 'KSCW' })
  const to = sectionsSent().at(-1)
  eq(wrote(to, 'timer'), '30', 'the timeout paints 30 in the small clock')
  eq(wrote(to, 'timerbig'), '', 'and the big clock stays blank')
  eq(wrote(to, 'lbl'), 'TIMEOUT', 'labelled TIMEOUT, not WARM-UP')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
