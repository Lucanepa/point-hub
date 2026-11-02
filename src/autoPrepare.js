// Tonight's home game, suggested: an hour before, the console ASKS whether to set it up.
//
// The schedule tap (controlServer's startScheduledGame with prematch:true) does the setting up —
// names in, 0-0 behind the held wall clock, the console's "Ready" banner. This module used to do
// that tap itself, an hour before. It now only proposes it (owner, 2026-11-02: "sometimes it
// automatically starts a game — I'd like this step to be semi-automatic", and "if there are several
// games the same day, let me choose"). `suggestion` lists what the console offers: "Tonight's game:
// HOME vs AWAY — Set up / Not now", or, with two or more of the board's games that day, all of
// them to pick from. Nothing goes on the board until someone taps.
//
// It is deliberately timid. It suggests only when ALL of these hold:
//   - the setting `autoPrepare` is on (default on; Settings ▸ "Suggest tonight's home game");
//   - the wall clock is trusted (NTP, or the console's clock adopted — see clockSync.trusted()):
//     on fake-hwclock's replay "an hour before 20:00" could be any time of any day;
//   - a playable home game of this board's sport family (and hall, with SCHEDULE_HALLS) starts in
//     the next LEAD_MS, or started no more than GRACE_MS ago. Cancelled games do not count;
//   - that game has not been set up or dismissed today already. A game set up by hand, or turned
//     down with "Not now", is never suggested again that day;
//   - the board is free for it — the caller's `boardFree` says so. Never over a match in progress,
//     a running countdown, a linked LAN match or another game's pre-match (see controlServer).
//
// The set-up and dismissed ids are kept per Zurich date in data/autoprepare.json, so a restart at
// 19:45 does not bring back a game turned down at 19:30.

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

// More than one playable game in today's list for this board: the suggestion then lists them all
// for the scorer to pick from. Cancelled games do not count.
export function severalToday(games) {
  return (Array.isArray(games) ? games : []).filter((g) => g && !g.cancelled).length > 1
}

// The earliest playable in-window game not already set up or dismissed, or null. `games` is
// today's list for this board, already filtered by sport family and hall.
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
  // trusted()       → may be async; whether the wall clock can be believed
  constructor({
    file = null, now = () => Date.now(), trusted = () => false, enabled = () => true,
    games = () => [], boardFree = () => ({ free: true }), tickMs = TICK_MS,
  } = {}) {
    Object.assign(this, { file, now, trusted, enabled, games, boardFree, tickMs })
    this._date = null
    this._prepared = new Set()
    this._timer = null
    this._busy = null
    // What the console offers right now: [] or today's games to pick from (plain schedule fields).
    this.suggestion = []
    this._said = '' // the suggestion last logged, so a 30 s tick does not repeat it
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

  // Record a game as set up (the scorer tapped it — on the Link tab or in the suggestion). Only
  // meaningful on a trusted clock (the date it is filed under is the clock's). A game picked from
  // the suggestion answers the whole question, so the suggestion goes with it.
  markPrepared(id, nowMs = this.now()) {
    if (id == null || id === '') return
    this._day(zurichDate(new Date(nowMs))).add(String(id))
    this._save()
    if (this.suggestion.some((g) => String(g.id) === String(id))) this._suggest([])
  }

  // "Not now": every game in the suggestion is filed as dismissed for today, so none comes back.
  dismiss(nowMs = this.now()) {
    const ids = this.suggestion.map((g) => String(g.id))
    if (!ids.length) return []
    const day = this._day(zurichDate(new Date(nowMs)))
    for (const id of ids) day.add(id)
    this._save()
    this._suggest([])
    alog.info(`suggestion dismissed: ${ids.join(', ')}`, { gameIds: ids })
    return ids
  }

  _suggest(list) {
    this.suggestion = list
    const sig = list.map((g) => g.id).join(',')
    if (sig && sig !== this._said) {
      const text = list.map((g) => `${g.time} ${g.homeShort || g.home} v ${g.awayShort || g.away}${g.hall ? ` (${g.hall})` : ''}`).join('; ')
      alog.info(list.length > 1
        ? `${list.length} home games today: asking the scorer which one — ${text}`
        : `suggesting tonight's game ${list[0].id}: ${text}`, { gameIds: list.map((g) => g.id) })
    }
    this._said = sig
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

  // One decision. Never throws. Returns { action: 'suggest' | 'skip', reason, gameIds? } so the
  // selftest (and a debug log line) can say why nothing is offered. Serialised.
  tick() {
    if (this._busy) return this._busy
    this._busy = this._tick().catch((err) => {
      alog.error(`auto-prepare failed: ${err && err.message}`, { error: err && err.message })
      return { action: 'skip', reason: 'error' }
    }).finally(() => { this._busy = null })
    return this._busy
  }

  async _tick() {
    const skip = (reason, extra = {}) => { this._suggest([]); return { action: 'skip', reason, ...extra } }
    if (!this.enabled()) return skip('off')
    if ((await this.trusted()) !== true) return skip('clock-unsynced')
    const nowMs = this.now()
    const date = zurichDate(new Date(nowMs))
    const done = this._day(date)
    const open = (Array.isArray(await this.games(date)) ? await this.games(date) : [])
      .filter((g) => g && !g.cancelled && !done.has(String(g.id)))
      .sort((a, b) => zurichEpoch(a.date, a.time) - zurichEpoch(b.date, b.time))
    const due = open.filter((g) => inWindow(g, nowMs))
    if (!due.length) return skip('no-game')
    for (const g of due) {
      const verdict = (await this.boardFree(g)) || {}
      // 'already' = the board is in this game's pre-match (the scorer tapped it): file it as set
      // up, so it is never offered again after a dismissal.
      if (verdict.reason === 'already') { this.markPrepared(g.id, nowMs); return skip('already', { gameIds: [g.id] }) }
      if (!verdict.free) {
        alog.debug(`game ${g.id} is due but the board is busy (${verdict.reason || 'busy'})`, { gameId: g.id, reason: verdict.reason })
        return skip(verdict.reason || 'busy', { gameIds: [g.id] })
      }
    }
    // One game: that one. Several the same day: all of today's open ones, to pick from.
    const list = (severalToday(open) ? open : due).map((g) => ({
      id: g.id, date: g.date, time: g.time, home: g.home, away: g.away,
      homeShort: g.homeShort, awayShort: g.awayShort, hall: g.hall, league: g.league,
    }))
    this._suggest(list)
    return { action: 'suggest', reason: list.length > 1 ? 'several-games' : 'due', gameIds: list.map((g) => g.id) }
  }
}
