// Subscribes to the OpenVolley LAN relay and emits the flat live-state that the
// Scoreboard computes (points_a, subs_a, serving_team as 'left'/'right', team
// colours, ...). The relay wraps each update as { type, matchId, data }; we read
// `data.liveState`.
//
// Uses Node's built-in global WebSocket (Node >= 22), so there is no npm
// dependency in production.
//
// Relay protocol (see escoresheet/frontend/server.js):
//   -> { type: 'subscribe-match', matchId }
//   <- { type: 'match-full-data',   matchId, data }   (initial, on subscribe)
//   <- { type: 'match-data-update', matchId, data }   (on every scoreboard sync)
//   <- { type: 'match-deleted',     matchId }
//   keepalive: -> { type: 'ping' }  <- { type: 'pong' }

import { EventEmitter } from 'node:events'
import { log } from './logStore.js'

const PING_MS = 25000
// Silence budget before we assume the socket is half-open. The relay answers every ping with a
// pong, so two ping cycles with nothing arriving at all means the link is gone.
const SILENT_MS = PING_MS * 2.5

// The relay is the one dependency this appliance cannot see or fix from the venue floor, so
// its whole lifecycle is on the record: which URL, which match, every open/close/retry, and
// every message shape that arrived but carried no usable live-state.
const rlog = log.child('relay')

export class RelaySubscriber extends EventEmitter {
  constructor({ url, matchId, reconnectMs = 3000 } = {}) {
    super()
    this.url = url
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.ws = null
    this._closing = false
    this._pingTimer = null
    this._retryTimer = null
    this._lastRx = 0 // when the socket last carried ANY frame — see _hangUp
  }

  start() {
    this._closing = false
    this._open()
  }

  _open() {
    if (this._closing) return // a retry that was already in flight when stop() ran
    rlog.info('connecting', { url: this.url, matchId: this.matchId })
    const ws = new WebSocket(this.url)
    this.ws = ws

    // Every listener below checks `this.ws !== ws` first: a socket we abandoned in _hangUp is
    // still physically open (see there) and can still deliver a stale frame or a very late close,
    // and neither must touch the connection that replaced it.
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      rlog.info('connected', { url: this.url, matchId: this.matchId })
      this._lastRx = Date.now()
      this.emit('open')
      if (this.matchId) this._send({ type: 'subscribe-match', matchId: this.matchId })
      clearInterval(this._pingTimer)
      this._pingTimer = setInterval(() => {
        if (Date.now() - this._lastRx > SILENT_MS) {
          this._hangUp(ws, `nothing from the relay in ${Math.round((Date.now() - this._lastRx) / 1000)}s`)
          return
        }
        this._send({ type: 'ping' })
      }, PING_MS)
    })
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return
      this._lastRx = Date.now()
      this._onMessage(ev.data)
    })
    ws.addEventListener('error', (ev) => {
      if (this.ws !== ws) return
      // Node's WebSocket hands us an ErrorEvent whose `error` is a TypeError with an EMPTY
      // message and no cause — "socket error: " told nobody anything. Name the target instead,
      // which is the fact an operator can actually act on ("is the scoring laptop up?").
      const detail = (ev && ev.error && ev.error.message) || (ev && ev.message) || `cannot reach ${this.url}`
      const err = ev && ev.error && ev.error.message ? ev.error : new Error(detail)
      rlog.error(`socket error: ${detail}`, { url: this.url, matchId: this.matchId })
      this.emit('error', err)
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this._pingTimer)
      const retry = !this._closing && this.reconnectMs > 0
      rlog[retry ? 'warn' : 'info'](retry ? `disconnected — retrying in ${this.reconnectMs}ms` : 'disconnected', {
        url: this.url, matchId: this.matchId, retrying: retry,
      })
      this.emit('close')
      this._scheduleRetry()
    })
  }

  // Abandon a socket that has gone quiet and reconnect. The board's uplink to the scoring laptop
  // is wifi, and when that dies silently (AP roam, laptop asleep, conntrack entry expired) no FIN
  // and no RST ever arrive: readyState stays 1, 'close' never fires, the retry never arms, and the
  // panel sits on a stale score for most of a set while the UI still reports a healthy 'lan' link.
  //
  // Note we do NOT rely on close() to get us out of it. close() only STARTS the closing handshake;
  // on a half-open socket the peer never answers, so readyState sticks at CLOSING and 'close' never
  // fires either (measured: still CLOSING 5s later; the OS gives up ~10-15 min later). So we drop
  // the socket here, drive the reconnect ourselves, and let close() + the kernel clean up whenever
  // they get round to it.
  _hangUp(ws, reason) {
    if (this.ws !== ws) return
    this.ws = null
    clearInterval(this._pingTimer)
    rlog.warn(`${reason} — assuming a half-open socket and reconnecting`, { url: this.url, matchId: this.matchId })
    try { ws.close() } catch { /* ignore */ }
    this.emit('close')
    this._scheduleRetry()
  }

  _scheduleRetry() {
    if (this._closing || !(this.reconnectMs > 0)) return
    clearTimeout(this._retryTimer)
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._open() }, this.reconnectMs)
  }

  _send(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
    } catch { /* ignore transient send errors */ }
  }

  _onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      rlog.warn('unparseable message from the relay', { bytes: String(raw ?? '').length })
      return
    }
    switch (msg.type) {
      case 'connected':
        rlog.info('relay acknowledged the subscription', { matchId: this.matchId })
        this.emit('connected', msg)
        break
      case 'match-full-data':
      case 'match-data-update': {
        if (this.matchId && String(msg.matchId) !== this.matchId) return
        const liveState = msg.data?.liveState
        if (liveState) {
          rlog.debug(`${msg.type} → live-state`, { matchId: msg.matchId })
          this.emit('state', liveState)
        } else {
          // The normal case, not a fault. The relay's `sync-match-data` REPLACES its stored match
          // with one that has no liveState, and the scoring app sends that sync after every action
          // and every 30s — so match-data-update never carries one, and match-full-data only does
          // if a live-state-update landed since the last sync. Logged as a warning, this filled
          // /logs with a false "bridge fault" per point. The one worth recording is the subscribe
          // reply: it tells the operator the panel is waiting for the scorer's next action.
          if (msg.type === 'match-full-data') {
            rlog.info('subscribed — waiting for the scoreboard\'s next live-state', { matchId: msg.matchId })
          } else {
            rlog.debug(`${msg.type} carried no liveState`, { matchId: msg.matchId })
          }
          this.emit('nostate', msg) // raw match sync without the computed live-state
        }
        break
      }
      case 'live-state-update': {
        // Dedicated, fresh live-state push (see server.js). This is the normal path.
        if (this.matchId && String(msg.matchId) !== this.matchId) return
        if (msg.liveState) {
          rlog.debug('live-state-update', { matchId: msg.matchId })
          this.emit('state', msg.liveState)
        }
        break
      }
      case 'match-deleted':
        if (!this.matchId || String(msg.matchId) === this.matchId) {
          rlog.warn('the linked match was deleted on the relay', { matchId: msg.matchId })
          this.emit('match-gone', msg)
        }
        break
      default:
        break // pong and other control messages are ignored
    }
  }

  stop() {
    rlog.info('unsubscribing', { url: this.url, matchId: this.matchId })
    this._closing = true
    clearInterval(this._pingTimer)
    // Without this, a stop() landing inside the reconnect window let the subscriber come back from
    // the dead: 3s later _open() reconnected, re-subscribed to the abandoned match and installed a
    // 25s interval nothing could ever clear, once per source switch during a relay outage.
    clearTimeout(this._retryTimer)
    this._retryTimer = null
    try { this.ws?.close() } catch { /* ignore */ }
  }
}
