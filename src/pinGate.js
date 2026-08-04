import { timingSafeEqual } from 'node:crypto'

// Brute-force protection for the scorer PIN.
//
// POST /api/unlock answers "is this PIN correct?" to anyone who asks, and mutating requests carry
// the PIN in a header. With no throttle that is an oracle: a 4-digit PIN is 10 000 guesses, which
// over LAN HTTP falls in seconds. This gates both paths through one counter.
//
// Tuned for a live match, not for a bank. A scorer who mistypes gets several free attempts and
// then a short pause; the lock doubles from there, so an attacker's 10 000 guesses turn into days
// while a fat-fingered scorer waits half a minute. Keyed per source IP so one phone poking at the
// board can never lock out the scorer's tablet, and cleared completely on success.

export function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8')
  const B = Buffer.from(String(b ?? ''), 'utf8')
  // timingSafeEqual throws on length mismatch, and the lengths themselves leak — compare against
  // a same-length buffer so a wrong-length guess costs the same as a wrong-value one.
  if (A.length !== B.length) { timingSafeEqual(A, A); return false }
  return timingSafeEqual(A, B)
}

export class PinGate {
  constructor({
    maxFails = 5,              // free attempts before the first lock
    baseLockMs = 30_000,       // first lock
    maxLockMs = 5 * 60_000,    // ceiling, so a mistyping scorer is never locked out for long
    forgetMs = 10 * 60_000,    // quiet period after which a source is forgotten entirely
    now = () => Date.now(),
  } = {}) {
    Object.assign(this, { maxFails, baseLockMs, maxLockMs, forgetMs, now })
    this._byIp = new Map() // ip -> { fails, until, seen }
  }

  _entry(ip) {
    const k = String(ip || 'unknown')
    let e = this._byIp.get(k)
    if (!e) { e = { fails: 0, until: 0, seen: this.now() }; this._byIp.set(k, e) }
    return e
  }

  // Drop sources that have been quiet, so the map cannot grow without bound on a long-running board.
  _prune() {
    const cutoff = this.now() - this.forgetMs
    for (const [k, e] of this._byIp) if (e.seen < cutoff && e.until < this.now()) this._byIp.delete(k)
  }

  // Called BEFORE checking the PIN. { allowed, retryAfterMs }
  // Deliberately a pure lookup: an earlier version used _entry() here, which created a record for
  // every caller — so a source that had just succeeded was immediately resurrected, and merely
  // asking the question grew the map.
  check(ip) {
    const e = this._byIp.get(String(ip || 'unknown'))
    if (!e) return { allowed: true, retryAfterMs: 0 }
    const t = this.now()
    if (e.until > t) return { allowed: false, retryAfterMs: e.until - t }
    return { allowed: true, retryAfterMs: 0 }
  }

  fail(ip) {
    const e = this._entry(ip)
    e.seen = this.now()
    e.fails += 1
    if (e.fails > this.maxFails) {
      const over = e.fails - this.maxFails            // 1, 2, 3, ...
      const lock = Math.min(this.baseLockMs * 2 ** (over - 1), this.maxLockMs)
      e.until = this.now() + lock
    }
    this._prune()
    return { fails: e.fails, lockedMs: Math.max(0, e.until - this.now()) }
  }

  succeed(ip) {
    this._byIp.delete(String(ip || 'unknown'))
    this._prune()
  }

  // Test/introspection helper.
  state(ip) { return this._byIp.get(String(ip || 'unknown')) || null }
  get size() { return this._byIp.size }
}
