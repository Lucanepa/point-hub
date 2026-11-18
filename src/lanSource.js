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
//   'substitution'   (liveState, { subs })  substitutions the state brought (linkedView.js
//                                            takeNewSubs): [{ side, name, color, playerOut, playerIn }],
//                                            side = the panel half of that team, numbers null when
//                                            the state has none. Never for a match that is over.
// Edges only, each once: a repeated frame, the relay's replay after a reconnect, or a state older
// than the newest (RelaySubscriber drops those) never starts a break a second time. A match that
// is over emits no break edge at all — 'match-ended' takes the panel, and ends any countdown.
//
// What it passes on is not the relay's state as it came but the board's VIEW of it (linkedView.js):
// the sides mirrored when the hall needs it, the substitutions counted when the cloud stripped them,
// the finished sets recorded when the state has none, the match number from the summary. Every
// listener — the panel, livePush, the result screen, the break edges above — gets that view.
//
// Mirror (`mirror`, asked on every state, so the console can switch it mid-match): OpenVolley's
// side_a / serving_team are the SCORER's sides, as their tablet shows the court. When the scorer
// sits BEHIND the board (Settings ▸ Scorer sits behind the board on, orientation 'behind', the
// default: the usual table, facing the court with the board at their back) their left is the
// panel's right, so the panel turns them round. When the scorer FACES the board (that box off,
// orientation 'front') the sides are 1:1 and pass through as they come. Confirmed by the owner on
// 17.11.2026: he sat behind the C0270 and the panel had to be mirrored. The console's own team
// cards use the same rule (web/index.html applyOrientation): behind the board they show the
// scorer's sides, so the console's cards and OpenVolley's tablet agree, and the panel shows the
// court's view.

import { EventEmitter } from 'node:events'
import { RelaySubscriber } from './relaySubscriber.js'
import { LinkedView } from './linkedView.js'

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
// A break the board sees begin is timed from that moment: the stamps come from the scorer device's
// clock, and a live frame is about a second old. Only a break that was ALREADY running when the
// link began (its very first state — a bridge restart in a set break, a link made mid-timeout)
// carries the match's own start, `set_interval_started_at` / `timeout_started_at`, as `startedAt`
// (ms, or null when the state has none), with `late: true`: the control server resumes the
// countdown from it, or leaves the break off the panel when it cannot tell (watchLinkedMatch).
// Before this a restart during a set interval put the full 3 minutes up again.
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
// no per-set scores; the board's view fills `set_results` from the sets it recorded itself
// (linkedView.js), so the history line ("27-25  25-12  25-16") is there whenever the board knows
// every set, and empty when it does not. null when there is no winner to name (level sets —
// never a finished volleyball match).
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

// The match's own start of a break, as epoch ms, or null.
const stamp = (v) => {
  if (v == null || v === '') return null
  const t = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(t) && t > 0 ? t : null
}

export class LanSource extends EventEmitter {
  // mirror: boolean or () => boolean, asked per state (see the header). pin: the match PIN to offer
  // the relay (relaySubscriber.js), or null. gameNumber: the match number the Link tab listed it
  // under, for a live state that carries none.
  constructor({ relayUrl, matchId, reconnectMs, mirror = false, pin = null, gameNumber = null } = {}) {
    super()
    this.relayUrl = relayUrl
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.sub = null
    this._mirror = typeof mirror === 'function' ? mirror : () => !!mirror
    this._pin = pin
    this._view = new LinkedView({ gameNumber })
    this._raw = null // the newest live state as the relay sent it
    this._last = null // …and as the board shows it (_present)
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

  // The match PIN: what became of it ('none' | 'offered' | 'accepted' | 'refused'), and offering
  // one (or none) on the running link.
  get pinState() { return this.sub ? this.sub.pinState : (this._pin ? 'offered' : 'none') }
  setPin(pin) {
    this._pin = pin
    return this.sub ? this.sub.setPin(pin) : this.pinState
  }

  // The board's view of the newest state (see the header). Mirror is asked now, every time.
  _present() {
    let mirror = false
    try { mirror = !!this._mirror() } catch { mirror = false }
    return this._view.view(this._raw, { mirror })
  }

  // Pass the newest state on again, rebuilt — after the console flipped the orientation, or when the
  // summary told the view something new. No break edges: nothing about the match changed.
  // `onlyIfChanged`: only when the view is not what the board already has.
  refresh({ onlyIfChanged = false } = {}) {
    if (!this._raw) return false
    const state = this._present()
    if (onlyIfChanged && JSON.stringify(state) === JSON.stringify(this._last)) return false
    this._last = state
    this.emit('state', state)
    return true
  }

  start() {
    this.sub = new RelaySubscriber({ url: this.relayUrl, matchId: this.matchId, reconnectMs: this.reconnectMs, pin: this._pin })
    this.sub.on('summary', (data) => {
      this._view.takeSummary(data)
      this.refresh({ onlyIfChanged: true })
    })
    this.sub.on('pin-refused', (info) => this.emit('pin-refused', info))
    this.sub.on('state', (raw) => {
      const first = this._raw === null
      this._raw = raw
      this._view.take(raw)
      const liveState = this._present()
      this._last = liveState
      const over = isMatchOver(liveState)
      const breaks = this._breaks(liveState, over, first)
      // The board's own state first, then the lifecycle edge: whoever reacts to 'match-ended'
      // (the result screen) must find the final score already in place — and a break countdown
      // reads the score it shows from the same place.
      this.emit('state', liveState)
      if (over && !this._over) { this._over = true; this.emit('match-ended', liveState) }
      else if (!over && this._over) { this._over = false; this.emit('match-resumed', liveState) }
      for (const [event, info] of breaks) this.emit(event, liveState, info)
      const subs = this._view.takeNewSubs()
      if (subs.length && !over) this.emit('substitution', liveState, { subs: subs.map((x) => this._subOnPanel(liveState, x)) })
    })
    this.sub.on('match-gone', (msg) => this.emit('match-gone', msg))
    this.sub.on('open', () => this.emit('status', 'open'))
    this.sub.on('close', () => this.emit('status', 'close'))
    // Only to someone listening: a source the SourceManager has dropped has no 'error' listener
    // left, and an unheard 'error' event throws.
    this.sub.on('error', (err) => { if (this.listenerCount('error')) this.emit('error', err) })
    this.sub.start()
  }

  // A substitution as the panel names it: the team's half (after the mirror), short name, colour.
  _subOnPanel(state, x) {
    const t = x.team === 'a' || x.team === 'b' ? x.team : null
    const aLeft = (state.side_a || 'left') !== 'right'
    return {
      side: t ? ((t === 'a') === aLeft ? 'left' : 'right') : null,
      name: t ? String(state[`team_${t}_short`] || state[`team_${t}_name`] || '') : '',
      color: t ? state[`team_${t}_color`] || null : null,
      playerOut: x.playerOut, playerIn: x.playerIn,
    }
  }

  stop() {
    try { this.sub?.stop() } catch { /* ignore */ }
    this.sub = null
  }

  // The break edges this frame makes, as [event, info] pairs, ends before starts (see the header
  // and INTERVAL_ENDS). Compared with the previous frame only, so the first frame of a link counts
  // against "no break": a board linked during a timeout shows it, ended by the scorer's own end.
  _breaks(state, over, first = false) {
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
      starts.push(['interval-start', first ? { late: true, startedAt: stamp(state.set_interval_started_at) } : {}])
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
      const side = team ? ((team === 'a') === aLeft ? 'left' : 'right') : null
      starts.push(['timeout-start', first && !this._timeout ? { side, late: true, startedAt: stamp(state.timeout_started_at) } : { side }])
    } else if (!on && this._timeout) {
      ends.push(['timeout-end', {}])
    }
    this._timeout = on
    return [...ends, ...starts]
  }
}
