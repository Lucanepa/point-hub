// Learning the wall clock from the operator's console.
//
// The board has no RTC. `fake-hwclock` only replays its last hourly save at boot, so a board that
// comes up without an uplink believes whatever time it was when that save happened — and because
// the bridge stamps match history from this clock, every row it writes is wrong. Seen once at
// ~36 h behind with the scoreboard working perfectly the whole time, which is exactly what makes
// it dangerous: nothing on the panel looks wrong.
//
// The tablet running the console DOES have a battery-backed RTC, and — the part that makes this
// work at all — it does not need to be online *now* to know the time. It only needed to be online
// at some point in the past. The board needs a live uplink; the tablet needs a memory. So the
// console hands us its clock and we adopt it, with no internet anywhere in the building.
//
// Deliberately a pure fallback. When systemd reports the clock already NTP-synchronized we change
// NOTHING: timesyncd is far more accurate than a browser round-trip, and a tablet left on a stale
// clock must never be able to drag a good board off. With the dongle in, this module is inert.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { log } from './logStore.js'

const cklog = log.child('clock')

// Nothing before this is a real time from a real tablet — it is a broken one. The classic garbage
// values all land below it: 0, a seconds-vs-milliseconds mix-up (1.78e9 ms ≈ Jan 1970), and a
// browser whose clock never initialised. Chosen as "before this project could possibly be asked
// to stamp a match" rather than as a moving target.
const EPOCH_FLOOR_MS = Date.UTC(2026, 0, 1)
// Wide, but it still catches a garbage-large number. Deliberately far enough out that nobody
// inherits a cliff: a board still running in 2050 has bigger problems than this constant.
const EPOCH_CEILING_MS = Date.UTC(2050, 0, 1)

// Below this we leave the clock alone. Transit and the operator's own tap latency put a floor on
// how precise a hint from a browser can be, so correcting a 3-second gap buys nothing real — and
// every correction is a discontinuity for the several places that treat Date.now() as if it were
// monotonic (countdown deadlines, stall detection, orphan TTLs). Not worth it under half a minute.
const MIN_CORRECTION_MS = 30_000

// systemd-timesyncd drops this the moment it first synchronises. Cheap to stat, and it is the
// same signal `timedatectl` reports — but it is timesyncd-specific, so it is the FALLBACK and not
// the primary: a board later moved to chrony would keep this file absent forever and we would
// cheerfully overwrite a perfectly good clock.
const TIMESYNC_STAMP = '/run/systemd/timesync/synchronized'

// `timedatectl` is a subprocess and /api/status is polled every 1.5 s, so the answer is cached.
// 10 s is short enough that "dongle just came back" shows up promptly and long enough that the
// poll loop costs one exec per ten seconds rather than seven.
const SYNC_TTL_MS = 10_000

const run = (cmd, args, timeoutMs = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
    resolve(err ? null : String(stdout || '').trim())
  })
})

export class ClockSync {
  // `isBusy` decides whether the moment is quiet enough to move the clock — see setFromConsole.
  // `applyTime`/`probeSync` are injected so the tests never touch the host clock.
  constructor({
    isBusy = () => false,
    now = () => Date.now(),
    probeSync = null,
    applyTime = null,
    persist = null,
  } = {}) {
    this.isBusy = isBusy
    this.now = now
    this._probeSync = probeSync || (() => run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']))
    // `date -s`, NOT `timedatectl set-time`. timedatectl REFUSES to set the clock while automatic
    // time synchronization is enabled — and timesyncd stays *enabled* even when it has never once
    // *synchronised*, which is precisely and only the situation this whole module exists for. So
    // the obvious call is the one that cannot work here.
    this._applyTime = applyTime || ((epochMs) => run('sudo', ['date', '-s', `@${(epochMs / 1000).toFixed(3)}`]))
    // Without this a reboot in the next hour throws the correction away again: fake-hwclock only
    // writes on its hourly cron and on clean shutdown, so the value it replays would still be the
    // stale one we just fixed. Best-effort — failing to persist is not a reason to reject a clock
    // that is now right.
    this._persist = persist || (() => run('sudo', ['fake-hwclock', 'save']))
    this._syncCache = { at: 0, value: null }
    // Set once the console's clock has been adopted or found to agree with ours — see trusted().
    this._confirmedAt = null
    this._trustedListeners = new Set()
    this._wasTrusted = false
  }

  // Whether the wall clock can be believed for "what day is it, and is a game about to start":
  // NTP has it, or the console's battery-backed clock has been adopted (or already agreed within
  // MIN_CORRECTION_MS). SYNCHRONOUS and cache-only, like viewSync — a caller that needs a fresh
  // answer awaits synchronized() first. Until either happens the clock is fake-hwclock's replay
  // and may be a day and a half behind, so the season schedule and the automatic pre-match treat
  // it as unknown rather than as today.
  trusted() {
    return this._syncCache.value === true || this._confirmedAt !== null
  }

  // Called (with no arguments) each time the clock goes from untrusted to trusted. NTP only syncs
  // with an uplink, so this doubles as "the internet is probably back" for the schedule's refresh.
  // Returns an unsubscribe function. A listener that throws is ignored.
  onTrusted(fn) {
    this._trustedListeners.add(fn)
    return () => this._trustedListeners.delete(fn)
  }

  _noteTrust() {
    const now = this.trusted()
    if (now && !this._wasTrusted) {
      for (const fn of this._trustedListeners) { try { fn() } catch { /* a listener's problem, not the clock's */ } }
    }
    this._wasTrusted = now
  }

  // true = NTP has the clock, false = it does not, null = we could not tell.
  async synchronized({ maxAgeMs = SYNC_TTL_MS } = {}) {
    const age = this.now() - this._syncCache.at
    if (this._syncCache.at && age < maxAgeMs) return this._syncCache.value

    let value = null
    const out = await this._probeSync()
    if (out === 'yes') value = true
    else if (out === 'no') value = false
    else {
      // timedatectl missing or unhappy (a dev laptop, a stripped image). Fall back to the stamp
      // file, which at least answers positively when timesyncd is the one running.
      try { value = fs.existsSync(TIMESYNC_STAMP) ? true : null } catch { value = null }
    }

    this._syncCache = { at: this.now(), value }
    this._noteTrust()
    return value
  }

  // What /api/status reports, so the console knows whether to offer its clock and the System tab
  // can show the operator why the time is what it is.
  //
  // SYNCHRONOUS on purpose: status() is a plain function on a path polled every 1.5 s, and making
  // it async to await a subprocess would ripple through every caller for a field that changes at
  // most once a session. It serves the cached answer and kicks off a refresh in the background, so
  // the very first poll after boot reports `synchronized: null` and the next one has the truth.
  viewSync() {
    if (this.now() - this._syncCache.at >= SYNC_TTL_MS) {
      this.synchronized().catch(() => {}) // fire-and-forget; the next poll reads the result
    }
    return {
      now: new Date(this.now()).toISOString(),
      synchronized: this._syncCache.value,
      // Only meaningful once we have actually moved it; null the rest of the time.
      setFromConsoleAt: this._setAt ? new Date(this._setAt).toISOString() : null,
      lastOffsetMs: this._lastOffsetMs ?? null,
    }
  }

  // The whole decision, in the order the gates were agreed:
  //   NTP wins  ->  plausible?  ->  worth correcting?  ->  quiet enough?  ->  set it.
  // Always resolves; never throws. `applied` says whether the clock actually moved and `reason`
  // says why not, because "nothing happened" is the normal outcome and the operator deserves to
  // be told which flavour of nothing it was.
  //
  // `evenIfBusy` skips gate 4 and nothing else. Only the hall Wi-Fi login asks for it, and only
  // after the portal's certificate was refused as not-yet-valid or expired: a board whose clock is
  // behind a freshly renewed certificate cannot log in at all, and a login is worth one jump of a
  // countdown. NTP, plausibility and "close enough" still decide.
  async setFromConsole(epochMs, { evenIfBusy = false } = {}) {
    const t = Number(epochMs)
    if (!Number.isFinite(t)) {
      return { ok: false, applied: false, reason: 'invalid', error: 'epochMs must be a finite number' }
    }

    // 1. NTP is more authoritative than a browser. If it has the clock, we are done.
    const synced = await this.synchronized()
    if (synced === true) {
      return { ok: true, applied: false, reason: 'ntp-synced', offsetMs: Math.round(t - this.now()) }
    }
    // synced === null means we could not tell. We proceed rather than refuse: on the board
    // timedatectl is always there, and anywhere it is NOT there the machine is almost certainly a
    // dev box whose clock IS synced — in which case `date -s` either fails for want of sudo or
    // sets it to a value it already had. Refusing here would disable the feature on the one
    // device that needs it because of a transient hiccup on a device that does not.

    // 2. Plausibility. A broken clock reports a broken time, and adopting it is worse than
    //    keeping ours — a wildly wrong clock also invalidates the board's TLS cert and locks the
    //    operator out of the HTTPS console.
    if (t < EPOCH_FLOOR_MS || t > EPOCH_CEILING_MS) {
      cklog.warn(`refused an implausible time from the console: ${new Date(t).toISOString()}`, { epochMs: t })
      return { ok: false, applied: false, reason: 'implausible', error: 'time outside the plausible window' }
    }

    const offsetMs = Math.round(t - this.now())

    // 3. Close enough. Leave it alone rather than churn.
    if (Math.abs(offsetMs) < MIN_CORRECTION_MS) {
      this._confirmedAt = this.now()
      this._noteTrust()
      return { ok: true, applied: false, reason: 'close-enough', offsetMs }
    }

    // 4. Quiet enough. Several consumers treat Date.now() as monotonic — a countdown deadline
    //    (controlServer), panel stall detection (ledboxProtocol), relay silence (relaySubscriber),
    //    orphan-command TTLs (ledboxClient). Jumping the clock under a running countdown either
    //    expires it instantly or leaves it running for days. Unlock is normally before the first
    //    whistle, so this gate almost never fires — but "almost never" is not "never".
    if (this.isBusy() && !evenIfBusy) {
      cklog.info(`deferred a ${Math.round(offsetMs / 1000)}s correction — match or countdown in flight`, { offsetMs })
      return { ok: true, applied: false, reason: 'busy', offsetMs }
    }

    // 5. Set it.
    const before = new Date(this.now()).toISOString()
    if (evenIfBusy && this.isBusy()) cklog.warn(`moving the clock ${Math.round(offsetMs / 1000)}s during a match — the hall Wi-Fi login needs it`, { offsetMs })
    const out = await this._applyTime(t)
    if (out === null) {
      cklog.error('could not set the clock — `sudo date -s` failed', { offsetMs })
      return { ok: false, applied: false, reason: 'failed', offsetMs, error: 'setting the clock failed' }
    }
    await this._persist() // best-effort; see constructor

    this._setAt = this.now()
    this._lastOffsetMs = offsetMs
    this._syncCache = { at: 0, value: null } // the world changed; re-probe rather than serve a stale answer
    this._confirmedAt = this._setAt
    this._noteTrust()
    const after = new Date(this.now()).toISOString()
    cklog.warn(`clock set from the console: ${before} -> ${after} (${Math.round(offsetMs / 1000)}s)`, { before, after, offsetMs })
    return { ok: true, applied: true, reason: 'applied', offsetMs, before, after }
  }
}
