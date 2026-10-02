// The KSCW match sheet for the game on the board — so the scorer can copy it into the eScoresheet.
//
//   board's current game (a schedule start) --GET /kscw/scorer/game/:id/roster--> wiedisync
//                                           --write-then-rename--> data/gamesheet.json
//   POST /api/gamesheet (scorer PIN) --> view()
//
// It is the same sheet the assigned scorer sees in wiedisync: jersey number, last name, initial,
// date of birth, licence, captain / libero, and the team's officials. Birthdates include minors,
// which is why every part of this is narrower than the rest of the board:
//   - wiedisync answers only the board's own service user, only for a HOME game, and only from
//     kickoff −6 h to +3 h (the `board` audience in scorer-roster.js); every read is logged there;
//   - the console route needs the scorer PIN, and refuses outright on a board with no PIN set —
//     an open board would show it to anyone on the hall Wi-Fi;
//   - only while Settings ▸ Connect to live scoring is on (that is the board being "connected");
//   - the copy on the card is kept for ONE game and deleted once that game is no longer on the
//     board or its window is over. Most halls give the board no uplink, so the copy is what makes
//     a fetch at home, or a minute of dongle earlier in the evening, still useful at the table.
//
// Best-effort like livePush: nothing here may reach the scoreboard. Every failure is logged and
// swallowed; the copy we have stays the answer.
//
// Config — the same env as livePush: DIRECTUS_URL (defaults to the club's), LIVE_PUBLISH_TOKEN.

import fs from 'node:fs'
import path from 'node:path'
import { log } from './logStore.js'
import { DEFAULT_DIRECTUS_URL, zurichEpoch } from './schedule.js'

const glog = log.child('gameSheet')

const TIMEOUT_MS = 15_000
const REFRESH_MS = 5 * 60 * 1000 // the coach may still correct the sheet until kickoff
const MIN_REFRESH_MS = 20_000 // the console's ↻, at most this often
// wiedisync's board window (scorer-roster.js COACH_WINDOW_*). Outside it the server says no, so
// there is no point asking; after it, the copy is deleted.
const WINDOW_BEFORE_MS = 6 * 60 * 60 * 1000
const WINDOW_AFTER_MS = 3 * 60 * 60 * 1000

const str = (v) => (v == null ? '' : String(v).trim())

// wiedisync's sheet → what the board keeps: nothing it does not show. Member ids and the RSVP
// cross-check are wiedisync's business; struck-off players are dropped here.
export function toSheet(data) {
  const d = data && typeof data === 'object' ? data : {}
  const players = (Array.isArray(d.roster) ? d.roster : [])
    .filter((p) => p && typeof p === 'object' && !p.dropped)
    .map((p) => ({
      number: Number.isInteger(Number(p.number)) && p.number != null ? Number(p.number) : null,
      lastName: str(p.last_name), initial: str(p.first_initial),
      birthdate: str(p.birthdate).slice(0, 10) || null,
      licence: str(p.licence) || null,
      captain: p.is_captain === true, libero: p.is_libero === true,
    }))
    // Jersey order, as the scorer reads them off the sheet; unnumbered last.
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
  const officials = (Array.isArray(d.coaches) ? d.coaches : [])
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ role: str(c.role) || null, lastName: str(c.last_name), initial: str(c.first_initial), birthdate: str(c.birthdate).slice(0, 10) || null }))
  return { source: str(d.source) || null, edited: d.edited === true, closedAt: d.closed_at || null, players, officials }
}

// wiedisync's refusals, in the scorer's words.
function plainError(status, code) {
  if (status === 401) return 'The board is not signed in to wiedisync (check LIVE_PUBLISH_TOKEN).'
  if (code === 'outside_window') return 'The roster opens 6 hours before kickoff.'
  if (code === 'not_home') return 'There is only a roster for KSCW home games.'
  if (code === 'not_scorer') return 'wiedisync does not let this board read rosters yet.'
  if (status === 404) return 'wiedisync does not know this game.'
  return `wiedisync answered with an error (HTTP ${status}).`
}

export class GameSheet {
  // `currentGame()` → the board's game as the schedule has it ({ id, date, time, kscwIsHome }) or
  // null; `enabled()` → live scoring is on. Both read fresh every time.
  constructor({
    file, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), trusted = () => true,
    currentGame = () => null, enabled = () => false,
    timeoutMs = TIMEOUT_MS, refreshMs = REFRESH_MS, minRefreshMs = MIN_REFRESH_MS,
  } = {}) {
    this.file = file || null
    this.base = String(env.DIRECTUS_URL || DEFAULT_DIRECTUS_URL).replace(/\/+$/, '')
    this.token = str(env.LIVE_PUBLISH_TOKEN)
    Object.assign(this, { fetchImpl, now, trusted, currentGame, enabled, timeoutMs, refreshMs, minRefreshMs })
    this.copy = null // { gameId, fetchedAt, sheet }
    this._lastError = null
    this._lastAttempt = null
    this._inflight = null
    this._timer = null
    this.load()
  }

  get configured() { return !!this.token }

  load() {
    if (!this.file) return
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (doc && Number.isInteger(doc.gameId) && doc.sheet) this.copy = doc
    } catch (err) {
      if (err && err.code !== 'ENOENT') glog.warn(`match sheet copy unreadable (${err.message}) — dropping it`, { file: this.file })
    }
  }

  _save() {
    if (!this.file || !this.copy) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.copy), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch (err) {
      glog.error(`could not save the match sheet: ${err.message}`, { file: this.file })
    }
  }

  _drop(why) {
    if (!this.copy) return
    glog.info(`match sheet copy deleted (${why})`, { gameId: this.copy.gameId })
    this.copy = null
    this._lastError = null
    if (this.file) { try { fs.rmSync(this.file, { force: true }) } catch { /* gone already */ } }
  }

  // Kickoff of a schedule game as epoch ms, or null.
  static kickoff(game) {
    if (!game || !game.date || !game.time) return null
    const t = zurichEpoch(game.date, String(game.time).slice(0, 5))
    return Number.isFinite(t) ? t : null
  }

  // Where `game` stands against the board window: 'before' | 'open' | 'over' | null (unknown). The
  // board has no RTC (clockSync.js): until its clock can be believed the answer is null, so we
  // neither skip a fetch nor delete a copy on a guess — wiedisync's own clock decides.
  _phase(game) {
    if (!this.trusted()) return null
    const k = GameSheet.kickoff(game)
    if (k == null) return null
    const t = this.now()
    if (t < k - WINDOW_BEFORE_MS) return 'before'
    if (t > k + WINDOW_AFTER_MS) return 'over'
    return 'open'
  }

  // Bring the copy in line with the board: delete one that belongs to another game or whose
  // window is over. Returns the current game when it is one a sheet can exist for.
  _reconcile() {
    const g = this.currentGame()
    const usable = g && g.kscwIsHome !== false && this.enabled()
    if (this.copy && (!usable || Number(g.id) !== this.copy.gameId)) this._drop(usable ? 'another game is on the board' : 'no KSCW home game on the board')
    if (usable && this.copy && this._phase(g) === 'over') this._drop('the game is over')
    return usable ? g : null
  }

  // Ask wiedisync. Never throws; concurrent callers share one request.
  refresh({ force = false } = {}) {
    if (this._inflight) return this._inflight
    const g = this._reconcile()
    if (!g || !this.configured) return Promise.resolve()
    if (this._phase(g) !== 'open' && this._phase(g) !== null) return Promise.resolve()
    // A clock that jumped back (the console setting a board with no RTC) is not "just asked".
    const since = this._lastAttempt == null ? Infinity : this.now() - this._lastAttempt
    if (force && since >= 0 && since < this.minRefreshMs) return Promise.resolve()
    this._inflight = this._fetch(g).finally(() => { this._inflight = null })
    return this._inflight
  }

  async _fetch(g) {
    this._lastAttempt = this.now()
    const id = Number(g.id)
    const url = `${this.base}/kscw/scorer/game/${id}/roster`
    try {
      const resp = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
      })
      let body = null
      try { body = await resp.json() } catch { /* not JSON */ }
      if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { plain: plainError(resp.status, body && body.code) })
      if (!body || !body.data || !Array.isArray(body.data.roster)) throw Object.assign(new Error('no roster'), { plain: 'wiedisync sent something unreadable.' })
      // The game may have changed on the board while we waited.
      const cur = this.currentGame()
      if (!cur || Number(cur.id) !== id) return
      this.copy = { gameId: id, fetchedAt: new Date(this.now()).toISOString(), sheet: toSheet(body.data) }
      this._lastError = null
      this._save()
      glog.info(`match sheet loaded: ${this.copy.sheet.players.length} player(s) for game ${id}`, { gameId: id, source: this.copy.sheet.source, players: this.copy.sheet.players.length })
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      this._lastError = (err && err.plain) || (timedOut ? "wiedisync did not answer in time. The board may have no internet here." : "The board could not reach wiedisync. It may have no internet here.")
      glog.info(`match sheet unavailable (${err && err.message}) — ${this.copy ? 'keeping the copy' : 'no copy'}`, { gameId: id, error: err && err.message })
    }
  }

  start() {
    if (this._timer) return
    this._timer = setInterval(() => { this.refresh().catch(() => {}) }, this.refreshMs)
    if (this._timer.unref) this._timer.unref()
    this.refresh().catch(() => {})
  }

  stop() { clearInterval(this._timer); this._timer = null }

  // The roster half of POST /api/gamesheet.
  async view({ refresh = false } = {}) {
    if (refresh) await this.refresh({ force: true })
    const g = this._reconcile()
    if (!g) return { ok: false, error: 'No KSCW home game is on the board.' }
    if (!this.configured && !this.copy) return { ok: false, error: 'This board has no wiedisync token (LIVE_PUBLISH_TOKEN), so it cannot fetch rosters.' }
    const phase = this._phase(g)
    if (this.copy && this.copy.gameId === Number(g.id)) {
      return { ok: true, fetchedAt: this.copy.fetchedAt, ...this.copy.sheet, ...(this._lastError ? { warning: this._lastError } : {}) }
    }
    if (phase === 'before') return { ok: false, error: 'The roster opens 6 hours before kickoff — the board fetches it by itself then, whenever it has internet.' }
    if (!this._lastAttempt && !this._inflight) await this.refresh()
    if (this._inflight) await this._inflight
    if (this.copy && this.copy.gameId === Number(g.id)) return { ok: true, fetchedAt: this.copy.fetchedAt, ...this.copy.sheet }
    return { ok: false, error: this._lastError || 'No roster yet.' }
  }
}
