// LAN source for the LedBox appliance — a thin adapter over RelaySubscriber that
// mirrors a live OpenVolley match on the local relay. Forwards the relay's
// liveState 'state' events through unchanged, and folds its socket lifecycle
// events into a uniform 'status'/'error' surface for the SourceManager.
//
// It also reports the linked match's own lifecycle, which the control server turns into what the
// hall sees once the score stops moving:
//   'match-ended'   (liveState)  the scorer ended the match (liveState.match_status 'ended')
//   'match-resumed' (liveState)  …and then undid that end: the match is live again
//   'match-gone'    (msg)        the scorer deleted the match, or the relay dropped it
// Without these the panel froze on the last score for the rest of the evening.
//
// And the breaks the scorer runs on the eScoresheet, so the board can run its own countdown for
// them (controlServer watchLinkedMatch) — one scorer at the laptop, and the hall still gets the
// TIME OUT clock and the horn without a second volunteer tapping the console:
//   'timeout-start'  (liveState, { side })  a timeout began; side = the team that called it
//                                            ('left' | 'right'), null when the state cannot tell
//   'timeout-end'    (liveState)            …and is over, ran out or stopped early
//   'interval-start' (liveState)            a set ended and the interval before the next began
//   'interval-end'   (liveState)            …and the scorer says it is over (see INTERVAL_ENDS)
// Edges only, each once: a repeated frame, the relay's replay after a reconnect, or a state older
// than the newest (RelaySubscriber drops those) never starts a break a second time. A match that
// is over emits no break edge at all — 'match-ended' takes the panel, and ends any countdown.

import { EventEmitter } from 'node:events'
import { RelaySubscriber } from './relaySubscriber.js'

// What the panel shows between linking and the first liveState: no names, 0-0. The relay drops the
// stored liveState on every match sync (see RelaySubscriber), so the subscribe reply usually has
// none, and until the scorer's next action nothing else arrives. Without a state of its own, a
// link left the PREVIOUS game on the panel — old teams, old final score — under a UI reporting
// mode 'lan'. Neutral is honest; a stale score is not.
const WAITING = Object.freeze({
  side_a: 'left', team_a_name: '', team_a_short: '', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: '', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0, serving_team: null,
})

// The OpenVolley scoreboard sets match_status 'ended' on the match_end frame (and on the set_end
// frame that decides the match); after the signatures the match record moves on to 'approved',
// and the cloud's word for it is 'final'. Any of them means the score will not move again.
const OVER = new Set(['ended', 'final', 'approved', 'finished', 'completed'])
export function isMatchOver(state) {
  return !!state && OVER.has(String(state.match_status || '').toLowerCase())
}

// How the OpenVolley scoreboard signals a break (Scoreboard.jsx syncLiveStateToSupabase), which is
// not the same for the two:
//   timeout_active       held true on every frame from the scorer's timeout until its clock runs
//                        out or is stopped — that ends it with an 'end_timeout' frame. A level:
//                        the falling edge is the end.
//   set_interval_active  true on the set_end frame ONLY. Every later frame carries false while the
//                        break goes on — the next set's line-ups, entered during the interval, a
//                        re-push after the laptop's network came back. So its falling edge says
//                        nothing, and the interval ends on a frame that says play is back: the
//                        scorer's "End interval" or "Start set", an undo (the set end taken back),
//                        a set reopened, or a rally scored in the set the break leads into. Any
//                        other frame leaves the board's clock running; it ends on its own.
// Neither `*_started_at` is read: those stamps come from the scorer laptop's clock, and the board
// times a break from the moment it sees it.
const INTERVAL_ENDS = new Set(['end_interval', 'set_start', 'undo', 'manual_reopen_set'])

// timeouts_a / points_a arrive as a number or, for timeouts and subs, as the full array.
const tally = (v) => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Number(v) : 0)
const setNo = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)

// Whether this frame ends the set interval that `opened` (the set_end frame's `current_set`, the
// set the break leads into) began. See INTERVAL_ENDS above.
function intervalOver(state, opened) {
  if (state.set_interval_active === true) return false
  if (INTERVAL_ENDS.has(String(state.last_event_type || ''))) return true
  // A set number on both frames must match: the set_end event's own snapshot — which a re-push
  // during the break can carry — is the FINISHED set at its final score, not play resuming.
  const set = setNo(state.current_set)
  const inNextSet = opened.set == null || set == null || set === opened.set
  return inNextSet && tally(state.points_a) + tally(state.points_b) > 0
}

// The result screen's three lines for a finished linked match, worded like the console's own
// (web/index.html resultLines): winner first, sets winner-first. The OpenVolley live state carries
// no per-set scores, so the history line is filled only when a source does send `set_results`.
// null when there is no winner to name (level sets — never a finished volleyball match).
export function resultFromLiveState(state) {
  if (!state) return null
  const a = Number(state.sets_won_a) || 0
  const b = Number(state.sets_won_b) || 0
  if (a === b) return null
  const name = (k) => String(state[`team_${k}_short`] || state[`team_${k}_name`] || (k === 'a' ? 'TEAM A' : 'TEAM B')).toUpperCase()
  const aWon = a > b
  const num = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : '0')
  const history = Array.isArray(state.set_results)
    ? state.set_results.map((r) => (aWon ? `${num(r && r.a)}-${num(r && r.b)}` : `${num(r && r.b)}-${num(r && r.a)}`)).join('  ')
    : ''
  return { winner: `${aWon ? name('a') : name('b')} WINS`, score: `${Math.max(a, b)} - ${Math.min(a, b)}`, history }
}

export class LanSource extends EventEmitter {
  constructor({ relayUrl, matchId, reconnectMs } = {}) {
    super()
    this.relayUrl = relayUrl
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.sub = null
    this._last = null
    this._over = false
    // The breaks as of the last frame (see _breaks). Kept across the subscriber's reconnects —
    // that is what keeps the relay's replay after one from starting a break twice.
    this._timeout = false      // timeout_active on the last frame
    this._intervalFlag = false // set_interval_active on the last frame
    this._interval = null      // { set } from a set_end frame until a frame ends that interval
    this._timeouts = null      // { a, b } timeout counts on the last frame: who called the next one
  }

  // SourceManager paints this right after start(): the latest liveState, or the neutral board
  // until the first one arrives.
  getState() {
    return this._last ?? { ...WAITING }
  }

  // Whether the linked match has been ended by the scorer (see isMatchOver).
  get over() { return this._over }

  start() {
    this.sub = new RelaySubscriber({ url: this.relayUrl, matchId: this.matchId, reconnectMs: this.reconnectMs })
    this.sub.on('state', (liveState) => {
      this._last = liveState
      const over = isMatchOver(liveState)
      const breaks = this._breaks(liveState, over)
      // The board's own state first, then the lifecycle edge: whoever reacts to 'match-ended'
      // (the result screen) must find the final score already in place — and a break countdown
      // reads the score it shows from the same place.
      this.emit('state', liveState)
      if (over && !this._over) { this._over = true; this.emit('match-ended', liveState) }
      else if (!over && this._over) { this._over = false; this.emit('match-resumed', liveState) }
      for (const [event, info] of breaks) this.emit(event, liveState, info)
    })
    this.sub.on('match-gone', (msg) => this.emit('match-gone', msg))
    this.sub.on('open', () => this.emit('status', 'open'))
    this.sub.on('close', () => this.emit('status', 'close'))
    // Only to someone listening: a source the SourceManager has dropped has no 'error' listener
    // left, and an unheard 'error' event throws.
    this.sub.on('error', (err) => { if (this.listenerCount('error')) this.emit('error', err) })
    this.sub.start()
  }

  stop() {
    try { this.sub?.stop() } catch { /* ignore */ }
    this.sub = null
  }

  // The break edges this frame makes, as [event, info] pairs, ends before starts (see the header
  // and INTERVAL_ENDS). Compared with the previous frame only, so the first frame of a link counts
  // against "no break": a board linked during a timeout shows it, ended by the scorer's own end.
  _breaks(state, over) {
    const a = tally(state.timeouts_a), b = tally(state.timeouts_b)
    const was = this._timeouts
    this._timeouts = { a, b }
    if (over) {
      // No countdown over the result; 'match-ended' ends one already running. Forget the breaks,
      // so an undo of the end does not resume one either.
      this._timeout = false
      this._intervalFlag = false
      this._interval = null
      return []
    }
    const ends = [], starts = []

    const flag = state.set_interval_active === true
    if (flag && !this._intervalFlag) {
      this._interval = { set: setNo(state.current_set) }
      starts.push(['interval-start', {}])
    } else if (this._interval && intervalOver(state, this._interval)) {
      this._interval = null
      ends.push(['interval-end', {}])
    }
    this._intervalFlag = flag

    const on = state.timeout_active === true
    // Whose count went up is who called it. A count going up while a timeout is already on is a
    // NEW timeout: the end of the previous one was missed (a link drop across both), and the board
    // must not run the rest of the old clock under the old team's name.
    const upA = !!was && a > was.a, upB = !!was && b > was.b
    if (on && (!this._timeout || upA || upB)) {
      const team = upA && !upB ? 'a' : upB && !upA ? 'b' : null
      const aLeft = state.side_a !== 'right'
      starts.push(['timeout-start', { side: team ? ((team === 'a') === aLeft ? 'left' : 'right') : null }])
    } else if (!on && this._timeout) {
      ends.push(['timeout-end', {}])
    }
    this._timeout = on
    return [...ends, ...starts]
  }
}
