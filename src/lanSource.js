// LAN source for the LedBox appliance — a thin adapter over RelaySubscriber that
// mirrors a live OpenVolley match on the local relay. Forwards the relay's
// liveState 'state' events through unchanged, and folds its socket lifecycle
// events into a uniform 'status'/'error' surface for the SourceManager.

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

export class LanSource extends EventEmitter {
  constructor({ relayUrl, matchId, reconnectMs } = {}) {
    super()
    this.relayUrl = relayUrl
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.sub = null
    this._last = null
  }

  // SourceManager paints this right after start(): the latest liveState, or the neutral board
  // until the first one arrives.
  getState() {
    return this._last ?? { ...WAITING }
  }

  start() {
    this.sub = new RelaySubscriber({ url: this.relayUrl, matchId: this.matchId, reconnectMs: this.reconnectMs })
    this.sub.on('state', (liveState) => { this._last = liveState; this.emit('state', liveState) })
    this.sub.on('open', () => this.emit('status', 'open'))
    this.sub.on('close', () => this.emit('status', 'close'))
    this.sub.on('error', (err) => this.emit('error', err))
    this.sub.start()
  }

  stop() {
    try { this.sub?.stop() } catch { /* ignore */ }
    this.sub = null
  }
}
