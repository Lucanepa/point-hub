// The rest of the season's home games, kept on the board's own card.
//
// schedule.js asks Directus for TODAY only, and only when a console asks — which is useless in the
// halls where it matters most: most give the board no uplink at all, so "today" was an error
// message exactly when a volunteer wanted the list. The fix is to download the whole season
// whenever there IS a connection (at home on the bench, the one evening a dongle is in) and serve
// every later request from the copy on disk.
//
//   boot / every 30 min / clock just synced --fetch--> Directus /items/games (date >= today, home)
//                                            --write-then-rename--> data/schedule.json
//   GET /api/schedule[?range=season] --> view() (from memory; never waits on the network once a copy exists)
//
// Offline is the NORMAL case, so nothing here throws and a failed fetch is logged at info: the
// copy we have is still the answer, marked `stale` so the console can say how old it is. A failure
// retries on a short backoff (1, 2, 4, then every 5 min) rather than the half-hour cadence, so a
// dongle plugged in at 19:40 has the evening's games a minute later.
//
// THE CLOCK. The board has no RTC (see clockSync.js): until NTP or the console has set it, the date
// we believe may be a day and a half behind. So, until `trusted()` says otherwise:
//   - the fetch asks from two days before what we think today is (a wrong "today" costs a few old
//     rows, never a missing evening);
//   - nothing is pruned from the copy on disk (a clock that is AHEAD would drop real games);
//   - `fetchedAt` is written as null — a timestamp from a wrong clock is worse than none. The age
//     of this boot's fetch is tracked on the monotonic clock instead, and turned into a real time
//     the moment the wall clock can be believed.
//
// Optional env: DIRECTUS_URL, SCHEDULE_HALLS — the same two schedule.js reads.

import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { log } from './logStore.js'
import { DEFAULT_DIRECTUS_URL, addDays, familyFilter, parseHalls, shortName, zurichDate } from './schedule.js'

const slog = log.child('schedule')

const TIMEOUT_MS = 10_000 // the whole season is ~30 kB; a slow hall dongle still manages that
const REFRESH_MS = 30 * 60 * 1000
const RETRY_MS = [60_000, 120_000, 240_000, 300_000]
// Older than this (or never fetched by this process) and the console says "offline — last update".
export const STALE_MS = 12 * 60 * 60 * 1000
// An on-demand fetch (a console with no copy yet, or ?refresh=1) at most this often: the route is
// an open GET, and a phone looping it must not become a stream of requests to the club's server.
const MIN_REFRESH_MS = 5000
// An unchanged season is not rewritten (it lives on the board's SD card, and a refresh every 30 min
// would otherwise be ~48 identical rewrites a day). Only the download time on disk goes out of
// date; it is brought up to date at most this often, so an offline boot still says roughly when.
const RESAVE_MS = 6 * 60 * 60 * 1000
// With an untrusted clock, ask from this many days before what we think today is.
const UNTRUSTED_MARGIN_DAYS = 2
const FIELDS = 'id,date,time,home_team,away_team,status,league,kscw_team.sport,hall.name'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const NO_CACHE = 'No schedule yet — the board downloads it as soon as it has internet. Type the team names instead.'

// Directus rows → what the board keeps: every sport, every hall (those are filtered per request,
// so changing SCHEDULE_HALLS or the sport never needs a refetch), cancelled and postponed games
// kept but flagged — the console greys them, because "the 20:00 is off" is itself worth knowing.
export function toSeasonGames(rows) {
  const seen = new Set()
  const games = []
  for (const g of Array.isArray(rows) ? rows : []) {
    if (!g || typeof g !== 'object') continue
    if (g.type != null && g.type !== 'home') continue // the query asks for home; belt and braces
    const date = String(g.date || '').slice(0, 10)
    if (!DATE_RE.test(date)) continue
    const home = String(g.home_team || '').trim()
    const away = String(g.away_team || '').trim()
    const time = String(g.time || '').slice(0, 5)
    // A KSCW-vs-KSCW game is in the table once per team (see schedule.js toGames).
    const key = `${date}|${time}|${home}|${away}`
    if (seen.has(key)) continue
    seen.add(key)
    const status = String(g.status || '').toLowerCase()
    games.push({
      id: g.id, date, time, home, away,
      homeShort: shortName(home), awayShort: shortName(away),
      league: String(g.league || ''), hall: String((g.hall && g.hall.name) || ''),
      kscwIsHome: /^KSC\s*Wiedikon\b/i.test(home),
      sport: String((g.kscw_team && g.kscw_team.sport) || '').toLowerCase(),
      status, cancelled: status === 'cancelled' || status === 'postponed',
    })
  }
  return games.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
}

// The fields today's list has always had — GET /api/schedule without ?range keeps its exact shape.
const TODAY_FIELDS = ['id', 'time', 'home', 'away', 'homeShort', 'awayShort', 'league', 'hall', 'kscwIsHome']
const pick = (g, keys) => Object.fromEntries(keys.map((k) => [k, g[k]]))
const SEASON_FIELDS = [...TODAY_FIELDS, 'date', 'status', 'cancelled']

export class SeasonSchedule {
  // Everything that touches the outside world is injectable, so the selftest runs against a local
  // fake Directus with a fake wall clock, a fake monotonic clock and a switchable "clock synced".
  constructor({
    file, env = process.env, fetchImpl = globalThis.fetch,
    now = () => Date.now(), mono = () => performance.now(), trusted = () => false,
    timeoutMs = TIMEOUT_MS, refreshMs = REFRESH_MS, retryMs = RETRY_MS, minRefreshMs = MIN_REFRESH_MS,
  } = {}) {
    this.file = file || null
    this.base = String(env.DIRECTUS_URL || DEFAULT_DIRECTUS_URL).replace(/\/+$/, '')
    this.halls = parseHalls(env.SCHEDULE_HALLS)
    Object.assign(this, { fetchImpl, now, mono, trusted, timeoutMs, refreshMs, retryMs, minRefreshMs })
    this.games = null // null = no copy at all; [] = a copy that says "no home games left"
    this._storedFetchedAt = null // from disk, as written (null when the clock was not trusted)
    this._diskGames = null // JSON of the games as last written (or loaded) — "did anything change?"
    this._diskFetchedAt = null // the fetchedAt as last written (or loaded)
    this._fetchedMono = null // monotonic time of THIS process's last good fetch
    this._lastAttemptMono = null
    this._lastError = null
    this._failures = 0
    this._inflight = null
    this._abort = null
    this._timer = null
    this._running = false
    this.load()
  }

  load() {
    if (!this.file) return
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      if (err && err.code !== 'ENOENT') slog.warn(`schedule copy unreadable (${err.message}) — starting without one`, { file: this.file })
      return
    }
    const games = Array.isArray(parsed && parsed.games)
      ? parsed.games.filter((g) => g && typeof g === 'object' && DATE_RE.test(String(g.date)))
      : null
    if (!games) return
    this.games = games
    this._storedFetchedAt = typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null
    this._diskGames = JSON.stringify(games)
    this._diskFetchedAt = this._storedFetchedAt
    this.prune()
    slog.info(`schedule copy loaded: ${this.games.length} game(s)`, { file: this.file, games: this.games.length, fetchedAt: this._storedFetchedAt })
  }

  // Past games leave the copy — but only on a clock we believe (see the header). Returns whether
  // anything was dropped.
  prune() {
    if (!this.games || !this.trusted()) return false
    const today = zurichDate(new Date(this.now()))
    const before = this.games.length
    this.games = this.games.filter((g) => g.date >= today)
    return this.games.length !== before
  }

  // Boot: one fetch now, then the timers. Idempotent.
  start() {
    if (this._running) return
    this._running = true
    this.refresh().catch(() => {})
  }

  stop() {
    this._running = false
    clearTimeout(this._timer)
    this._timer = null
    if (this._abort) { try { this._abort.abort() } catch { /* already done */ } }
  }

  // The clock just became trustworthy: that is NTP, which means an uplink. Drop what is now
  // visibly in the past, give this boot's download (made on the untrusted clock, so written with
  // fetchedAt:null) its real time — otherwise the next offline boot cannot say how old the copy
  // is — and if the last fetch failed (or there was none), go now rather than wait out the backoff.
  onClockTrusted() {
    const pruned = this.prune()
    const dated = this._fetchedMono !== null && this._storedFetchedAt === null
    if (dated) this._storedFetchedAt = this.fetchedAt()
    if (pruned) this._save()
    else if (dated) this._saveIfChanged()
    if (this._running && (this._failures > 0 || this._fetchedMono === null)) {
      this._failures = 0
      this.refresh().catch(() => {})
    }
  }

  _schedule(ms) {
    clearTimeout(this._timer)
    if (!this._running) return
    this._timer = setTimeout(() => { this.refresh().catch(() => {}) }, ms)
    if (this._timer.unref) this._timer.unref()
  }

  // Fetch the season. Never throws; resolves to { ok, error? }. Concurrent callers share one
  // request. `force` (the console's refresh) still respects the MIN_REFRESH_MS floor.
  refresh({ force = false } = {}) {
    if (this._inflight) return this._inflight
    if (force && this._lastAttemptMono !== null && this.mono() - this._lastAttemptMono < this.minRefreshMs) {
      return Promise.resolve(this._lastError ? { ok: false, error: this._lastError } : { ok: true })
    }
    this._inflight = this._fetch().finally(() => { this._inflight = null })
    return this._inflight
  }

  async _fetch() {
    this._lastAttemptMono = this.mono()
    const trusted = this.trusted()
    const today = zurichDate(new Date(this.now()))
    const from = trusted ? today : addDays(today, -UNTRUSTED_MARGIN_DAYS)
    const qs = new URLSearchParams({
      filter: JSON.stringify({ date: { _gte: from }, type: { _eq: 'home' } }),
      sort: 'date,time',
      limit: '-1',
      fields: FIELDS,
    })
    const url = `${this.base}/items/games?${qs}`
    this._abort = new AbortController()
    const signal = AbortSignal.any([this._abort.signal, AbortSignal.timeout(this.timeoutMs)])
    try {
      const resp = await this.fetchImpl(url, { signal, headers: { Accept: 'application/json' } })
      if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { plain: `The club's schedule answered with an error (HTTP ${resp.status}).` })
      let body
      try { body = await resp.json() } catch { throw Object.assign(new Error('not JSON'), { plain: "The club's schedule sent something unreadable." }) }
      if (!body || !Array.isArray(body.data)) throw Object.assign(new Error('no data array'), { plain: "The club's schedule sent something unreadable." })
      this.games = toSeasonGames(body.data)
      this.prune()
      this._fetchedMono = this.mono()
      this._storedFetchedAt = trusted ? new Date(this.now()).toISOString() : null
      this._lastError = null
      this._failures = 0
      this._saveIfChanged()
      slog.info(`season schedule updated: ${this.games.length} home game(s) from ${from}`, { from, games: this.games.length, rows: body.data.length, clockTrusted: trusted })
      this._schedule(this.refreshMs)
      return { ok: true }
    } catch (err) {
      const stopped = !this._running && err && err.name === 'AbortError'
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      this._lastError = (err && err.plain) || (timedOut
        ? `The club's schedule did not answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} seconds. The board may have no internet here.`
        : 'The board could not reach the club\'s schedule. It may have no internet here.')
      this._failures++
      const retry = this.retryMs[Math.min(this._failures - 1, this.retryMs.length - 1)]
      if (!stopped) slog.info(`season schedule unavailable (${err && err.message}) — ${this.games ? 'keeping the copy on disk' : 'no copy yet'}, retrying in ${Math.round(retry / 1000)}s`, { url: this.base, error: err && err.message, failures: this._failures, retryMs: retry })
      this._schedule(retry)
      return { ok: false, error: this._lastError }
    } finally {
      this._abort = null
    }
  }

  // After a download: write only when the games differ from the copy on disk, or when the copy's
  // download time is missing or more than RESAVE_MS old. The in-memory _fetchedMono keeps
  // fetchedAt() and stale() right in between.
  _saveIfChanged() {
    if (!this.games) return
    const changed = JSON.stringify(this.games) !== this._diskGames
    const at = this.fetchedAt()
    const disk = this._diskFetchedAt ? Date.parse(this._diskFetchedAt) : NaN
    const dateStale = !!at && (!Number.isFinite(disk) || Date.parse(at) - disk > RESAVE_MS)
    if (changed || dateStale) this._save()
  }

  // Write-then-rename, like every other store here: a power cut mid-write keeps the old copy.
  _save() {
    if (!this.file || !this.games) return
    const trusted = this.trusted()
    const doc = {
      fetchedAt: this.fetchedAt(),
      clockSynced: trusted,
      ...(this.fetchedAt() ? {} : { note: 'fetched before the board clock was synced — the time of the download is unknown' }),
      games: this.games,
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc))
      fs.renameSync(tmp, this.file)
      this._diskGames = JSON.stringify(this.games)
      this._diskFetchedAt = doc.fetchedAt
    } catch (err) {
      slog.error(`could not save the schedule copy: ${err.message}`, { file: this.file, error: err.message })
    }
  }

  // When the copy was downloaded, as ISO, or null when that is unknown. This process's fetch is
  // measured on the monotonic clock, so a fetch made BEFORE the wall clock was set still gets its
  // real time once the clock can be believed.
  fetchedAt() {
    if (this._fetchedMono !== null && this.trusted()) {
      return new Date(this.now() - (this.mono() - this._fetchedMono)).toISOString()
    }
    return this._storedFetchedAt
  }

  stale() {
    return this._fetchedMono === null || this.mono() - this._fetchedMono > STALE_MS
  }

  // A console asking before there is any copy waits for one fetch (shared with the boot fetch if
  // that is still in flight) instead of being told "no schedule" while one is on its way. With a
  // copy it is answered from memory at once, even mid-fetch: on a dead dongle that fetch takes the
  // full timeout. Only an explicit ?refresh=1 waits for the network.
  async _ensure({ refresh = false } = {}) {
    if (refresh) { await this.refresh({ force: true }); return }
    if (this.games !== null) return
    if (this._inflight) { await this._inflight; return }
    await this.refresh({ force: true })
  }

  // This board's games in the copy (sport family + SCHEDULE_HALLS), in date/time order.
  gamesFor(sport) {
    const list = this.games || []
    const wanted = familyFilter(list, sport, (g) => String(g.sport || ''))
    return list.filter((g) => wanted(g) && (!this.halls || this.halls.has(String(g.hall).trim().toLowerCase())))
  }

  // GET /api/schedule — today's playable games in the shape the console has always had.
  async today({ sport = 'volleyball', refresh = false } = {}) {
    await this._ensure({ refresh })
    const date = zurichDate(new Date(this.now()))
    if (this.games === null) return { ok: false, date, sport, error: this._lastError ? `${this._lastError} Type the team names instead.` : NO_CACHE, games: [] }
    const games = this.gamesFor(sport).filter((g) => g.date === date && !g.cancelled).map((g) => pick(g, TODAY_FIELDS))
    return { ok: true, date, sport, games, fetchedAt: this.fetchedAt(), stale: this.stale() }
  }

  // GET /api/schedule?range=season — today, then the rest of the season grouped by date.
  async season({ sport = 'volleyball', refresh = false } = {}) {
    await this._ensure({ refresh })
    const fetchedAt = this.fetchedAt()
    const clockSynced = !!this.trusted()
    if (this.games === null) {
      return { ok: false, error: this._lastError ? `${this._lastError} ${NO_CACHE}` : NO_CACHE, fetchedAt: null, stale: true, clockSynced, today: [], upcoming: [] }
    }
    const date = zurichDate(new Date(this.now()))
    const today = []
    const byDate = new Map()
    for (const g of this.gamesFor(sport)) {
      if (g.date < date) continue
      const row = pick(g, SEASON_FIELDS)
      if (g.date === date) today.push(row)
      else {
        if (!byDate.has(g.date)) byDate.set(g.date, [])
        byDate.get(g.date).push(row)
      }
    }
    const upcoming = [...byDate].map(([d, games]) => ({ date: d, games }))
    return { ok: true, date, fetchedAt, stale: this.stale(), clockSynced, today, upcoming }
  }
}
