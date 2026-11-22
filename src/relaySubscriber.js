// Subscribes to the OpenVolley LAN relay and emits the flat live-state that the
// Scoreboard computes (points_a, subs_a, serving_team as 'left'/'right', team
// colours, ...). The relay wraps each update as { type, matchId, data }; we read
// `data.liveState`.
//
// Uses Node's built-in global WebSocket (Node >= 22), so there is no npm
// dependency in production.
//
// Relay protocol (OpenVolley escoresheet/backend/server.js — the standalone server — and
// escoresheet/frontend/electron/lanRelayCore.cjs, which the desktop app and frontend/server.js
// share; the Tauri relay.rs follows the same rules). Rooms are keyed by the match's SEED KEY (the
// `id` in GET /api/match/list); the scorer's local numeric id is not a room and receives nothing.
// An anonymous subscriber gets the PIN-free summary, which still carries data.liveState, and
// every live-state-update — so the board needs no PIN or token. The cloud relay
// (wss://backend.openvolley.app) strips the line-ups, substitutions and sanctions from what such a
// subscriber gets (LIVE_STATE_PRIVATE_COLUMNS); the match PIN, when the operator offers one, is
// sent with the subscription (the backend's registerRelayAccess) and brings the full state. It is
// held in memory only, never logged, and dropped the moment the relay refuses it (a wrong PIN is
// counted against the board's address; sending it again on every reconnect would lock it out).
//   -> { type: 'subscribe-match', matchId, pin?, device?: 'display', settingsUrl? }
//      device/settingsUrl: the board's announcement (boardAnnounce.js), when the appliance set one: the
//      relay tells the scorer a scoreboard follows and offers this board's Settings in its menu.
//   <- { type: 'match-full-data',   matchId, data }   (initial, on subscribe)
//   <- { type: 'match-data-update', matchId, data }   (on every scoreboard sync)
//   <- { type: 'match-deleted',     matchId }
//   keepalive: -> { type: 'ping' }  <- { type: 'pong' }
//
// Or by a SCOREBOARD CODE instead of a room key (followCode.js, OpenVolley's scoreboard-code-spec.md):
//   -> { type: 'subscribe-match', code, device: 'display', settingsUrl? }   (no matchId, no PIN)
//   <- { type: 'display-code', ok: true, matchId, endsAt }   then the room's messages, as above
//   <- { type: 'display-code', ok: false, reason: 'not-found' | 'rate-limited', retryAfter? }
//   <- { type: 'display-code', ok: false, reason: 'ended' }  the code ended: the relay took us out
// The code is never logged (its `ref` is). What the answers do, without a storm of lookups:
//   ok            the room is followed; `matchId` is now the room key; every reconnect sends the code
//                 again (a relay that restarted learns it back from the scorer within seconds)
//   ended         final: the subscriber stops, and says so ('code' { final: true })
//   not-found     a code never seen on this relay is a typo or the wrong relay: final. One that was
//                 followed before (or restored after a restart, `codeConfirmed`) is the relay or the
//                 scorer reconnecting: asked again after 15, 30, then every 60 s on the open socket,
//                 and given up after CODE_GIVE_UP_MS
//   rate-limited  nothing is sent before `retryAfter` seconds, on this socket or a new one
//   an older relay that knows no codes answers `Match ID required`: final, 'unsupported'
//
// A live state can reach us after a newer one: the relay replays its stored copy to every
// (re)subscribe — after a link drop, that copy is whatever it last kept — and the match-data
// path can carry a copy of its own. The scorer numbers each state it pushes (see liveStateOrder;
// it already drops its own older push when a side-out's 'point' and 'rotation' states race), and
// a state older than the newest one passed on is dropped here, so a stale frame can neither roll
// the score back nor restart a countdown that has ended.

import { EventEmitter } from 'node:events'
import { log } from './logStore.js'
import { announcementFields, DISPLAY_DEVICE } from './boardAnnounce.js'
import { normalizeCode, codeRef } from './followCode.js'

// The scorer's order of a live state, or null when it carries none (an older scorer, a database
// row). OpenVolley's relayPublisher.createLiveStateOrder stamps every relay push with `_seq`,
// counting up from 1, and `_session`, a random id of the scoring page: a reload starts again at 1
// under a new session, so two numbers compare only within one session (as OpenVolley's own
// serverDataSync.newerLiveState does). Never the wall clock: that is the scorer laptop's, and an
// NTP step there would freeze the board.
export function liveStateOrder(state) {
  const seq = Number(state && state._seq)
  const session = state && state._session
  return Number.isFinite(seq) && typeof session === 'string' && session ? { seq, session } : null
}

// Whether `state` is older than the newest state already taken (`last`, a liveStateOrder or null).
// A repeat of the same number is not stale — the relay replays its copy on every subscribe, and
// that copy is exactly as new as what we have. A state of another session (the scorer reloaded)
// or one with no order at all cannot be compared, so it is taken.
export function isStaleLiveState(state, last) {
  const o = liveStateOrder(state)
  return !!(o && last && o.session === last.session && o.seq < last.seq)
}

// The backend's answers to a PIN it will not take (registerRelayAccess / hasRelayAccess).
const PIN_REFUSALS = new Set(['pin-invalid', 'rate-limited', 'access-denied'])
// A match PIN as the relays take it (trimmed, at most 32 characters), or null for none.
export function cleanPin(pin) {
  if (pin == null) return null
  const s = String(pin).trim()
  return s && s.length <= 32 && /^[\x21-\x7e]+$/.test(s) ? s : null
}

const PING_MS = 25000
// Silence budget before we assume the socket is half-open. The relay answers every ping with a
// pong, so two ping cycles with nothing arriving at all means the link is gone.
const SILENT_MS = PING_MS * 2.5

// The relay is the one dependency this appliance cannot see or fix from the venue floor, so
// its whole lifecycle is on the record: which URL, which match, every open/close/retry, and
// every message shape that arrived but carried no usable live-state.
const rlog = log.child('relay')

// Scoreboard codes: the waits after a 'not-found' for a code that was followed before, and how long
// such a code may stay lost before the board gives up on it. The relay's own wait for 'rate-limited'
// is clamped to these bounds.
export const CODE_RETRY_MS = Object.freeze([15000, 30000, 60000])
export const CODE_GIVE_UP_MS = 30 * 60 * 1000
const RATE_WAIT_MIN_S = 5, RATE_WAIT_MAX_S = 3600

export class RelaySubscriber extends EventEmitter {
  // announce: the board's announcement on every subscription (boardAnnounce.js); left out, the one the
  // appliance set, if any.
  // code: follow by a scoreboard code instead of matchId (see the header); codeConfirmed: the code was
  // followed before (a restored one), so a 'not-found' is waited out rather than final. codeRetryMs /
  // codeGiveUpMs: for the tests.
  constructor({ url, matchId, reconnectMs = 3000, pin = null, announce, code = null, codeConfirmed = false, codeRetryMs = CODE_RETRY_MS, codeGiveUpMs = CODE_GIVE_UP_MS } = {}) {
    super()
    this._announce = announce
    this.url = url
    this.matchId = matchId != null ? String(matchId) : null
    this.reconnectMs = reconnectMs
    this.code = normalizeCode(code)
    this.codeRef = this.code ? codeRef(this.code) : null
    this._codeConfirmed = !!(this.code && codeConfirmed)
    this._codeRetryMs = codeRetryMs
    this._codeGiveUpMs = codeGiveUpMs
    this._codeHoldUntil = 0 // nothing is sent before this (rate-limited, or the wait after a not-found)
    this._codeTimer = null
    this._codeMisses = 0
    this._codeMissSince = 0
    this._codeDead = false
    // What became of the code: null (no code) | 'looking' | 'following' | 'lost' (not found right now,
    // asking again) | 'rate-limited' | 'ended' | 'not-found' | 'unsupported'. And when it ends / the next try.
    this.codeState = this.code ? 'looking' : null
    this.codeEndsAt = null
    this.codeRetryAt = null
    // The match PIN offered with the subscription (see the header), or null. `pinState` is what
    // became of it: 'none' | 'offered' | 'accepted' (the relay sent more than the summary) |
    // 'refused' (and it is gone). Never with a code: the relays ignore a PIN next to one.
    this._pin = this.code ? null : cleanPin(pin)
    this.pinState = this._pin ? 'offered' : 'none'
    this.ws = null
    this._closing = false
    this._pingTimer = null
    this._retryTimer = null
    this._lastRx = 0 // when the socket last carried ANY frame — see _hangUp
    // The order of the newest live state passed on (liveStateOrder). Kept across reconnects: the
    // relay's replay after one is exactly the frame a stale check is for.
    this._order = null
  }

  // What every log line names: the relay, the room, and the code by its ref only.
  _ctx() {
    return this.code ? { url: this.url, matchId: this.matchId, ref: this.codeRef } : { url: this.url, matchId: this.matchId }
  }

  start() {
    this._closing = false
    this._open()
  }

  _open() {
    if (this._closing) return // a retry that was already in flight when stop() ran
    rlog.info('connecting', this._ctx())
    const ws = new WebSocket(this.url)
    this.ws = ws

    // Every listener below checks `this.ws !== ws` first: a socket we abandoned in _hangUp is
    // still physically open (see there) and can still deliver a stale frame or a very late close,
    // and neither must touch the connection that replaced it.
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      rlog.info('connected', this._ctx())
      this._lastRx = Date.now()
      this.emit('open')
      this._subscribe()
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
      // stop() closing a socket that was still connecting fires an error AFTER the owner has let
      // go of us — the SourceManager has already removed its 'error' listener, and an unheard
      // 'error' event throws, which took the whole appliance down on an unlink or a shutdown.
      if (this._closing) return
      // Node's WebSocket hands us an ErrorEvent whose `error` is a TypeError with an EMPTY
      // message and no cause — "socket error: " told nobody anything. Name the target instead,
      // which is the fact an operator can actually act on ("is the scoring laptop up?").
      const detail = (ev && ev.error && ev.error.message) || (ev && ev.message) || `cannot reach ${this.url}`
      const err = ev && ev.error && ev.error.message ? ev.error : new Error(detail)
      rlog.error(`socket error: ${detail}`, this._ctx())
      this.emit('error', err)
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this._pingTimer)
      const retry = !this._closing && this.reconnectMs > 0
      rlog[retry ? 'warn' : 'info'](retry ? `disconnected — retrying in ${this.reconnectMs}ms` : 'disconnected', {
        ...this._ctx(), retrying: retry,
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
    rlog.warn(`${reason} — assuming a half-open socket and reconnecting`, this._ctx())
    try { ws.close() } catch { /* ignore */ }
    this.emit('close')
    this._scheduleRetry()
  }

  // The subscribe-match this subscriber sends: the match, its PIN if one is offered, and the board's
  // announcement.
  subscription() {
    if (this.code) return { type: 'subscribe-match', code: this.code, device: DISPLAY_DEVICE, ...announcementFields(this._announce) }
    return { type: 'subscribe-match', matchId: this.matchId, ...(this._pin ? { pin: this._pin } : {}), ...announcementFields(this._announce) }
  }

  _scheduleRetry() {
    if (this._closing || !(this.reconnectMs > 0)) return
    clearTimeout(this._retryTimer)
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._open() }, this.reconnectMs)
  }

  _subscribe() {
    if (this.code) {
      if (this._codeDead || this._closing) return
      const wait = this._codeHoldUntil - Date.now()
      if (wait > 0) { this._codeLater(wait); return }
      this._send(this.subscription())
      return
    }
    if (!this.matchId) return
    this._send(this.subscription())
  }

  // Ask for the code again in `ms`, on whatever socket is open then (a new one subscribes by itself).
  _codeLater(ms) {
    clearTimeout(this._codeTimer)
    this._codeTimer = setTimeout(() => { this._codeTimer = null; this._subscribe() }, ms)
    if (this._codeTimer.unref) this._codeTimer.unref()
  }

  // The relay's answer to the code (see the header).
  _onCode(msg) {
    if (!this.code || this._codeDead) return
    const now = Date.now()
    if (msg.ok === true) {
      const room = msg.matchId != null ? String(msg.matchId).slice(0, 200) : ''
      if (!room) { rlog.warn('the relay took the scoreboard code but named no match', this._ctx()); return }
      if (this.matchId && this.matchId !== room) {
        rlog.warn('the scoreboard code names another match now — following that one', { ...this._ctx(), now: room })
        this._order = null
      }
      const first = this.codeState !== 'following'
      this.matchId = room
      this._codeConfirmed = true
      this._codeMisses = 0
      this._codeMissSince = 0
      this._codeHoldUntil = 0
      this.codeRetryAt = null
      this.codeState = 'following'
      this.codeEndsAt = Number(msg.endsAt) > 0 ? Number(msg.endsAt) : null
      if (first) rlog.info('following the match by its scoreboard code', { ...this._ctx(), endsAt: this.codeEndsAt })
      this.emit('code', { ok: true, matchId: room, endsAt: this.codeEndsAt })
      return
    }
    const reason = String(msg.reason || 'not-found')
    if (reason === 'ended') { this._endCode('ended', 'the scoreboard code ended (a new code, sharing stopped, or the match closed)'); return }
    if (reason === 'rate-limited') {
      const s = Math.min(RATE_WAIT_MAX_S, Math.max(RATE_WAIT_MIN_S, Number(msg.retryAfter) || 60))
      this._codeHoldUntil = now + s * 1000
      this.codeState = 'rate-limited'
      this.codeRetryAt = this._codeHoldUntil
      rlog.warn(`the relay says too many code lookups from this board — asking again in ${s} s`, { ...this._ctx(), retryAfter: s })
      this._codeLater(s * 1000)
      this.emit('code', { ok: false, reason, retryAfter: s, final: false })
      return
    }
    // not-found (or a reason this board does not know)
    if (!this._codeConfirmed) { this._endCode('not-found', 'the relay does not know this scoreboard code (a typo, or the scorer is on another relay)'); return }
    if (!this._codeMissSince) this._codeMissSince = now
    if (now - this._codeMissSince >= this._codeGiveUpMs) { this._endCode('not-found', `the scoreboard code has not been found for ${Math.round((now - this._codeMissSince) / 60000)} min — giving up`); return }
    const steps = this._codeRetryMs
    const wait = steps[Math.min(this._codeMisses, steps.length - 1)]
    this._codeMisses++
    this._codeHoldUntil = now + wait
    this.codeState = 'lost'
    this.codeRetryAt = this._codeHoldUntil
    rlog.warn(`the relay does not know the scoreboard code right now (the scorer reconnecting?) — asking again in ${Math.round(wait / 1000)} s`, { ...this._ctx(), misses: this._codeMisses })
    this._codeLater(wait)
    this.emit('code', { ok: false, reason: 'not-found', retryAfter: Math.round(wait / 1000), final: false })
  }

  // The code is over for this board: no more lookups, no reconnects. The owner unlinks.
  _endCode(reason, why) {
    this._codeDead = true
    clearTimeout(this._codeTimer)
    this._codeTimer = null
    this.codeState = reason
    this.codeRetryAt = null
    rlog[reason === 'ended' ? 'info' : 'warn'](why, { ...this._ctx(), reason })
    this.stop()
    this.emit('code', { ok: false, reason, final: true })
  }

  // Offer a match PIN (or take it back with an empty one) on the running link: the relay is asked
  // again at once, on the same socket (the backend re-registers the access and answers with the
  // match's data again). Returns the new pinState.
  setPin(pin) {
    this._pin = cleanPin(pin)
    this.pinState = this._pin ? 'offered' : 'none'
    rlog.info(this._pin ? 'match PIN offered to the relay' : 'match PIN taken back', { matchId: this.matchId })
    this._subscribe()
    return this.pinState
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
      case 'display-code':
        this._onCode(msg)
        break
      case 'match-full-data':
      case 'match-data-update': {
        // By code, nothing counts before the relay named the room.
        if ((this.matchId || this.code) && String(msg.matchId) !== this.matchId) return
        // What the relay let us see: 'summary' is the PIN-free view; anything else (the scorer's,
        // a referee's) means the PIN was taken. A relay that does not say leaves it as it was.
        if (this._pin && typeof msg.access === 'string') {
          const was = this.pinState
          this.pinState = msg.access === 'summary' ? 'offered' : 'accepted'
          if (was !== this.pinState && this.pinState === 'accepted') rlog.info('the relay took the match PIN: full live state', { matchId: this.matchId })
        }
        // The match itself (number, teams, the sets' scores): the relays send the bundle FLAT on
        // the message (lanRelayCore / backend matchDataMessage), with only the live state under
        // `data`. Before the live state, so whoever builds the board's view from both has the
        // newer summary when the state arrives.
        if (msg.match || Array.isArray(msg.sets) || msg.homeTeam) this.emit('summary', { match: msg.match, homeTeam: msg.homeTeam, awayTeam: msg.awayTeam, sets: msg.sets })
        const liveState = msg.data?.liveState
        if (liveState) {
          rlog.debug(`${msg.type} → live-state`, { matchId: msg.matchId })
          this._take(liveState, msg.type)
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
        if ((this.matchId || this.code) && String(msg.matchId) !== this.matchId) return
        if (msg.liveState) {
          rlog.debug('live-state-update', { matchId: msg.matchId })
          this._take(msg.liveState, msg.type)
        }
        break
      }
      case 'match-deleted':
        if ((!this.matchId && !this.code) || String(msg.matchId) === this.matchId) {
          rlog.warn('the linked match was deleted on the relay', { matchId: msg.matchId })
          this.emit('match-gone', msg)
        }
        break
      case 'error': {
        // The relay refusing something (rate-limited, room-limit, an unknown match). Nothing here
        // can fix it from the board, but it is the answer to "why is the panel not moving?" — so
        // it goes on the record with the relay's own code instead of being dropped like a pong.
        const code = String(msg.code || '').slice(0, 60)
        const text = String(msg.message || msg.error || '').slice(0, 200)
        rlog.warn(`the relay answered with an error${code ? ` (${code})` : ''}${text && text !== code ? `: ${text}` : ''}`, { matchId: this.matchId, code: code || null })
        // A refused PIN is dropped: the link carries on with the PIN-free view, and the next
        // reconnect does not count another wrong PIN against the board.
        if (this._pin && PIN_REFUSALS.has(code) && (!msg.matchId || String(msg.matchId) === this.matchId)) {
          this._pin = null
          this.pinState = 'refused'
          rlog.warn('the match PIN was refused — following without it', { matchId: this.matchId, code })
          this.emit('pin-refused', { code })
        }
        this.emit('relay-error', { code, message: text })
        // A relay from before scoreboard codes reads the subscription as one without a matchId.
        if (this.code && !this.matchId && /match id required/i.test(text)) this._endCode('unsupported', 'this relay does not know scoreboard codes yet (an older OpenVolley)')
        break
      }
      default:
        break // pong and other control messages are ignored
    }
  }

  // Pass a live state on, unless it is older than the newest one already passed on (see the
  // header). Debug, not warn: that is the guard doing its job, not a fault.
  _take(liveState, via) {
    if (isStaleLiveState(liveState, this._order)) {
      const o = liveStateOrder(liveState)
      rlog.debug(`dropped a stale live state (${via}: #${o.seq} after #${this._order.seq})`, { matchId: this.matchId, seq: o.seq, newest: this._order.seq, via })
      return
    }
    const o = liveStateOrder(liveState)
    if (o) this._order = o
    this.emit('state', liveState)
  }

  stop() {
    if (!this._closing) rlog.info('unsubscribing', this._ctx())
    this._closing = true
    clearInterval(this._pingTimer)
    clearTimeout(this._codeTimer)
    this._codeTimer = null
    // Without this, a stop() landing inside the reconnect window let the subscriber come back from
    // the dead: 3s later _open() reconnected, re-subscribed to the abandoned match and installed a
    // 25s interval nothing could ever clear, once per source switch during a relay outage.
    clearTimeout(this._retryTimer)
    this._retryTimer = null
    try { this.ws?.close() } catch { /* ignore */ }
  }
}
