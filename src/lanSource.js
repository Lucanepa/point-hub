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
      // The board's own state first, then the lifecycle edge: whoever reacts to 'match-ended'
      // (the result screen) must find the final score already in place.
      this.emit('state', liveState)
      if (over && !this._over) { this._over = true; this.emit('match-ended', liveState) }
      else if (!over && this._over) { this._over = false; this.emit('match-resumed', liveState) }
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
}
