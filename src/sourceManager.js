// SourceManager owns whichever Source (manual / LAN / cloud) currently drives the
// board. Swapping sources tears down the old one's listeners, caches the last
// liveState so the appliance can repaint or report status, and re-emits every
// source 'state' upward for the appliance to push to the LedBox.

import { EventEmitter } from 'node:events'
import { log } from './logStore.js'

const slog = log.child('source')

export class SourceManager extends EventEmitter {
  constructor() {
    super()
    this.active = null
    this._last = null
    this._meta = { mode: 'idle', matchId: null }
    this._onState = null
    this._onError = null
  }

  setSource(source, meta = {}) {
    // Who is driving the board, and since when. Every mode change (manual ⇄ linked LAN match
    // ⇄ blanked) passes through here, so this is the authoritative record of it.
    slog.info(`source → ${meta.mode ?? 'idle'}`, {
      from: this._meta.mode, to: meta.mode ?? 'idle',
      matchId: meta.matchId ?? null, kind: source?.constructor?.name || 'unknown',
    })
    // Tear down the previous source (stop + drop our listeners).
    if (this.active) {
      try { this.active.stop() } catch { /* ignore */ }
      if (this._onState) this.active.removeListener('state', this._onState)
      if (this._onError) this.active.removeListener('error', this._onError)
    }
    this.active = source
    this._meta = { mode: meta.mode ?? 'idle', matchId: meta.matchId ?? null }

    this._onState = (s) => { this._last = s; this.emit('state', s) }
    // A source that emits 'error' with no listener would crash the process (Node
    // throws on unheard 'error' events); always listen and forward it upward.
    this._onError = (e) => { this.emit('error', e) }
    source.on('state', this._onState)
    source.on('error', this._onError)
    // start() runs AFTER active/_meta have been overwritten, so a source that throws on the way up
    // — LanSource reaches `new WebSocket(url)`, which throws synchronously for a RELAY_URL with no
    // ws:// scheme — would otherwise leave the manager reporting mode 'lan' with a dead source and
    // nothing driving the panel. Better to fall back to idle and say so.
    try {
      source.start()
    } catch (err) {
      slog.error(`source failed to start: ${err.message}`, { mode: this._meta.mode, matchId: this._meta.matchId, error: err.message })
      this.active = null
      this._meta = { mode: 'idle', matchId: null }
      source.removeListener('state', this._onState)
      source.removeListener('error', this._onError)
      throw err // the caller (POST /api/link) still owes the operator a failure, not a silent no-op
    }

    // Some sources (manual) expose a current state synchronously — surface it now.
    if (typeof source.getState === 'function') {
      const s = source.getState()
      if (s != null) { this._last = s; this.emit('state', s) }
    }
  }

  get status() {
    return { mode: this._meta.mode, matchId: this._meta.matchId }
  }

  getState() {
    return this._last ?? null
  }

  stop() {
    if (this.active) {
      try { this.active.stop() } catch { /* ignore */ }
      if (this._onState) this.active.removeListener('state', this._onState)
      if (this._onError) this.active.removeListener('error', this._onError)
    }
  }
}
