// Automatic pre-match: an hour before a home game, the board sets it up on its own.
//
// The schedule tap (controlServer's startScheduledGame with prematch:true) already does the right
// thing — names in, 0-0 behind the held wall clock, the console's "Ready" banner. It still needed a
// volunteer to remember to tap it. This does the tap for them, from the season copy on disk
// (seasonSchedule.js), so a board switched on at 19:00 with no uplink and nobody at the tablet is
// ready for the 20:00 game when the scorer sits down.
//
// It is deliberately timid. It acts only when ALL of these hold:
//   - the setting `autoPrepare` is on (default on; Settings ▸ "Prepare home games automatically");
//   - the wall clock is trusted (NTP, or the console's clock adopted — see clockSync.trusted()):
//     on fake-hwclock's replay "an hour before 20:00" could be any time of any day;
//   - a playable home game of this board's sport family (and hall, with SCHEDULE_HALLS) starts in
//     the next LEAD_MS, or started no more than GRACE_MS ago — the earliest one when two overlap;
//   - that game has not been prepared today already, automatically or by hand. Once prepared it is
//     never prepared again, which is what makes a scorer's dismissal (Delete, New, typing other
//     names) final: the board does not keep putting back a game someone took down;
//   - the board is free for it — the caller's `boardFree` says so. Never a match in progress, a
//     running countdown or a linked LAN match (see controlServer).
//
// The prepared ids are kept per Zurich date in data/autoprepare.json, so a restart at 19:45 does
// not undo a dismissal at 19:30.

import fs from 'node:fs'
import path from 'node:path'
import { log } from './logStore.js'
import { zurichDate, zurichEpoch } from './schedule.js'

const alog = log.child('autoprepare')

export const LEAD_MS = 60 * 60 * 1000
export const GRACE_MS = 30 * 60 * 1000
const TICK_MS = 30_000

// Is `game` inside the window at `nowMs`? Both ends inclusive: exactly 60 minutes before counts.
export function inWindow(game, nowMs) {
  if (!game || !game.date || !game.time) return false
  const start = zurichEpoch(game.date, game.time)
  const until = start - nowMs
  return until <= LEAD_MS && until >= -GRACE_MS
}

// The game to prepare now, or null: the earliest playable in-window game not already prepared.
// `games` is today's list for this board, already filtered by sport family and hall.
export function pickGame(games, nowMs, prepared = new Set()) {
  let best = null
  let bestStart = Infinity
  for (const g of Array.isArray(games) ? games : []) {
    if (!g || g.cancelled || prepared.has(String(g.id))) continue
    if (!inWindow(g, nowMs)) continue
    const start = zurichEpoch(g.date, g.time)
    if (start < bestStart) { best = g; bestStart = start }
  }
  return best
}

export class AutoPrepare {
  // games(date)     → today's games for this board (seasonSchedule.gamesFor, filtered to `date`)
  // boardFree(game) → { free, reason } — may the board be taken over for this game right now?
  // prepare(game)   → sets it up exactly as the schedule tap does; resolves when done
  // trusted()       → may be async; whether the wall clock can be believed
  constructor({
    file = null, now = () => Date.now(), trusted = () => false, enabled = () => true,
    games = () => [], boardFree = () => ({ free: true }), prepare = async () => {}, tickMs = TICK_MS,
  } = {}) {
    Object.assign(this, { file, now, trusted, enabled, games, boardFree, prepare, tickMs })
    this._date = null
    this._prepared = new Set()
    this._timer = null
    this._busy = null
    this._load()
  }

  _load() {
    if (!this.file) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw.date === 'string' && Array.isArray(raw.ids)) {
        this._date = raw.date
        this._prepared = new Set(raw.ids.map(String))
      }
    } catch { /* missing or unreadable: nothing prepared yet, which is the safe direction */ }
  }

  _save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ date: this._date, ids: [...this._prepared] }))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      alog.error(`could not save the prepared games: ${err.message}`, { file: this.file, error: err.message })
    }
  }

  // The set for `date`, emptied when the day has moved on.
  _day(date) {
    if (this._date !== date) { this._date = date; this._prepared = new Set() }
    return this._prepared
  }

  // Record a game as prepared — by this module, or by the scorer tapping it in the console. Only
  // meaningful on a trusted clock (the date it is filed under is the clock's).
  markPrepared(id, nowMs = this.now()) {
    if (id == null || id === '') return
    this._day(zurichDate(new Date(nowMs))).add(String(id))
    this._save()
  }

  isPrepared(id, nowMs = this.now()) {
    return this._date === zurichDate(new Date(nowMs)) && this._prepared.has(String(id))
  }

  start() {
    if (this._timer) return
    this._timer = setInterval(() => { this.tick().catch(() => {}) }, this.tickMs)
    if (this._timer.unref) this._timer.unref()
  }

  stop() {
    clearInterval(this._timer)
    this._timer = null
  }

  // One decision. Never throws. Returns { action: 'prepared' | 'skip', reason, gameId? } so the
  // selftest (and a debug log line) can say why nothing happened. Serialised: a slow prepare can
  // never overlap the next tick into a second one.
  tick() {
    if (this._busy) return this._busy
    this._busy = this._tick().catch((err) => {
      alog.error(`auto-prepare failed: ${err && err.message}`, { error: err && err.message })
      return { action: 'skip', reason: 'error' }
    }).finally(() => { this._busy = null })
    return this._busy
  }

  async _tick() {
    if (!this.enabled()) return { action: 'skip', reason: 'off' }
    if ((await this.trusted()) !== true) return { action: 'skip', reason: 'clock-unsynced' }
    const nowMs = this.now()
    const date = zurichDate(new Date(nowMs))
    const game = pickGame(await this.games(date), nowMs, this._day(date))
    if (!game) return { action: 'skip', reason: 'no-game' }
    const verdict = (await this.boardFree(game)) || {}
    if (!verdict.free) {
      // 'already' = the board is in this game's pre-match already (the scorer tapped it first):
      // file it as prepared so it is never redone after a dismissal.
      if (verdict.reason === 'already') this.markPrepared(game.id, nowMs)
      alog.debug(`game ${game.id} is due but the board is busy (${verdict.reason || 'busy'})`, { gameId: game.id, reason: verdict.reason })
      return { action: 'skip', reason: verdict.reason || 'busy', gameId: game.id }
    }
    // Filed BEFORE the attempt: a prepare that fails half-way must not be retried every 30 s.
    this.markPrepared(game.id, nowMs)
    alog.info(`auto-prepared game ${game.id}: ${game.time} ${game.homeShort || game.home} v ${game.awayShort || game.away}${game.hall ? ` (${game.hall})` : ''}`, {
      gameId: game.id, date: game.date, time: game.time, home: game.home, away: game.away, hall: game.hall,
    })
    await this.prepare(game)
    return { action: 'prepared', reason: 'due', gameId: game.id }
  }
}
