// Blink cadence. `send` allows exactly ONE command in flight and waits for the board's ack, so a
// blink driven by a fixed-rate setInterval enqueues toggles faster than they drain as soon as an
// ack is slower than pulseIntervalMs. They pile up behind each other and behind the point's own
// score repaint; the panel shows one long smear instead of a blink, and how bad it looks depends
// on what was already queued — which is why the same blinkMs gave two blinks on one side and a
// single slow one on the other.
//
// The blink is now self-clocked: each toggle waits for its own ack, then schedules the next.
// This test pins that down by making acks SLOWER than the interval — the pathological case.
import { LedboxClient } from '../src/ledboxClient.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const INTERVAL = 20   // requested blink half-period
const ACK = 60        // board takes 3x that to answer — the queue would build under setInterval
const TEAM = '37,99,235'

function client(ack = ACK) {
  const c = new LedboxClient({ hosts: ['127.0.0.1'], pulseIntervalMs: INTERVAL })
  c.ready = true
  c.calls = []
  c.inFlight = 0
  c.maxInFlight = 0
  // Stub the WIRE (_sendNow), not send() — send() is what applies the _sendChain serialization
  // that guarantees one command in flight, and that is precisely the behaviour under test.
  c._sendNow = async (cmd, value) => {
    c.inFlight++
    c.maxInFlight = Math.max(c.maxInFlight, c.inFlight)
    c.calls.push(value[0].value.value)
    await sleep(ack)
    c.inFlight--
    return 'ok'
  }
  return c
}

// What pulse() promises: a fixed number of toggles, then one settling paint. Derived the same way
// the implementation derives it, so the intent is stated once — `ms` buys blinks at the nominal
// interval, and a slow board stretches them rather than losing one.
const expectedPaints = (ms) => Math.max(2, Math.min(8, Math.round(ms / (2 * INTERVAL)))) + 1

console.log(`blink with acks (${ACK}ms) slower than the interval (${INTERVAL}ms):`)
const c = client()
c.pulse('score2', 300, TEAM)
await sleep(900)

ok(c.maxInFlight === 1, `never more than one paint in flight (saw ${c.maxInFlight})`)
// Exact, not a ceiling. A backlogged setInterval would have queued ~15 here; the point of the
// self-clocked loop is that the number is now a property of the code rather than of how busy the
// queue happened to be, so the test asserts the number instead of an upper bound on it.
ok(c.calls.length === expectedPaints(300),
  `deterministic paint count — ${c.calls.length} paints (expected ${expectedPaints(300)})`)
ok(c.calls[0] === '0,0,0', 'starts dark, so the blink is visible immediately')
ok(c.calls[c.calls.length - 1] === TEAM, 'settles on the team colour, never dark')
ok(!c._pulses.has('score2'), 'pulse deregisters itself when finished')

// THE REGRESSION. The reported fault is "left 2x, right 3x" — one side blinking a different
// number of times from the other, with identical settings. The old test compared two clients
// under IDENTICAL ack latency, which is why it passed while the board misbehaved: equal latency
// is the one condition under which a time-bounded loop cannot disagree with itself. The real
// board does not offer that. A point on one side lands behind its own 20-section score repaint
// and acks slowly; the other finds the queue idle. So the sides are compared here under
// DIFFERENT latencies, which is what actually happens in the hall.
console.log('\nboth sides, DIFFERENT ack latency (the reported fault):')
const fast = client(15)    // queue was idle
const slow = client(120)   // queued behind a score repaint — 8x slower to ack
fast.pulse('score1', 300, TEAM)
slow.pulse('score2', 300, TEAM)
await sleep(2200)          // long enough for the slow one to finish all its toggles
ok(fast.calls.length === slow.calls.length,
  `same number of blinks whatever the latency (${fast.calls.length} vs ${slow.calls.length} paints)`)
ok(fast.calls.length === expectedPaints(300),
  `and it is the expected count, not merely equal (${fast.calls.length})`)
ok(slow.calls[slow.calls.length - 1] === TEAM, 'the slow side still settles on the team colour')
// The cost of a fixed count is that a slow board takes longer, which is the right trade: the eye
// counts blinks, it does not measure milliseconds.
ok(!fast._pulses.has('score1') && !slow._pulses.has('score2'), 'both deregister when finished')

// Re-scoring restarts the blink rather than stacking a second timer on the same section.
console.log('\nre-scoring the same section:')
const c2 = client()
c2.pulse('score1', 300, TEAM)
await sleep(30)
c2.pulse('score1', 300, TEAM)
await sleep(900)
ok(c2.maxInFlight === 1, `restart does not stack a second blinker (max in flight ${c2.maxInFlight})`)
ok(c2.calls[c2.calls.length - 1] === TEAM, 'restarted blink still settles on the team colour')

// clearPulses (runs just before every layout switch) must stop it and restore the team colour.
console.log('\nclearPulses during a blink:')
const c3 = client()
c3.pulse('score1', 2000, TEAM)
await sleep(90)
c3.clearPulses()
const afterClear = c3.calls.length
await sleep(300)
ok(c3.calls.length <= afterClear + 1, 'no further toggles after clearPulses')
ok(c3._pulses.size === 0, 'pulse registry emptied')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
