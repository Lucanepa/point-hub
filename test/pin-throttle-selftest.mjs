// Self-test for the scorer-PIN brute-force gate. Pure logic, no server needed — a fake clock
// stands in for time so lockouts can be tested without sleeping.
import { PinGate, safeEqual } from '../src/pinGate.js'

let pass = 0, fail = 0
const ok = (cond, what) => { if (cond) { pass++ } else { fail++; console.error(`  FAIL ${what}`) } }

// ── safeEqual ────────────────────────────────────────────────────────────────────────────────
ok(safeEqual('1234', '1234') === true,  'equal strings match')
ok(safeEqual('1234', '1235') === false, 'different same-length strings do not match')
ok(safeEqual('1234', '12345') === false, 'different-length strings do not match')
ok(safeEqual('', '') === true,           'empty equals empty')
ok(safeEqual(null, '') === true,         'null coerces to empty')
ok(safeEqual('1234', undefined) === false, 'undefined does not match a real pin')
ok(safeEqual(1234, '1234') === true,     'number coerces to string')

// ── the gate ─────────────────────────────────────────────────────────────────────────────────
let clock = 1_000_000
const mk = (o = {}) => new PinGate({ now: () => clock, ...o })

let g = mk()
ok(g.check('a').allowed === true, 'fresh source is allowed')

// Free attempts: maxFails=5 means five failures cost nothing.
for (let i = 0; i < 5; i++) g.fail('a')
ok(g.check('a').allowed === true, 'still allowed after exactly maxFails failures')

// The sixth locks.
let r = g.fail('a')
ok(r.lockedMs === 30_000, 'sixth failure locks for baseLockMs')
ok(g.check('a').allowed === false, 'locked source is refused')
ok(g.check('a').retryAfterMs === 30_000, 'reports how long to wait')

// The lock expires on its own.
clock += 30_001
ok(g.check('a').allowed === true, 'lock expires without intervention')

// Escalation doubles.
r = g.fail('a')
ok(r.lockedMs === 60_000, 'seventh failure doubles to 60s')
clock += 60_001
r = g.fail('a')
ok(r.lockedMs === 120_000, 'eighth doubles again')

// Ceiling: a mistyping scorer must never be locked out indefinitely.
g = mk()
for (let i = 0; i < 40; i++) { g.fail('a'); clock += 10 }
ok(g.state('a').until - clock <= 5 * 60_000, 'lock never exceeds maxLockMs')

// Success clears everything.
g = mk()
for (let i = 0; i < 6; i++) g.fail('b')
ok(g.check('b').allowed === false, 'b is locked')
g.succeed('b')
ok(g.check('b').allowed === true, 'success clears the lock')
ok(g.state('b') === null, 'success forgets the source entirely')

// Isolation between sources — this is the property that stops an attacker locking out the scorer.
g = mk()
for (let i = 0; i < 10; i++) g.fail('attacker')
ok(g.check('attacker').allowed === false, 'attacker is locked')
ok(g.check('scorer-tablet').allowed === true, 'the scorer is unaffected by someone else failing')

// Pruning: quiet sources are forgotten so the map cannot grow forever.
g = mk()
g.fail('old')
ok(g.size === 1, 'source recorded')
clock += 10 * 60_000 + 1
g.fail('new')
ok(g.state('old') === null, 'quiet source pruned after forgetMs')

// A locked source must NOT be pruned just because it went quiet — otherwise going away for
// forgetMs would reset an attacker's escalation.
g = mk({ forgetMs: 1000, baseLockMs: 60_000 })
for (let i = 0; i < 6; i++) g.fail('persistent')
clock += 2000
g.fail('someone-else')
ok(g.state('persistent') !== null, 'a still-locked source survives pruning')

console.log(`\npin-throttle-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
