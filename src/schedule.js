// Today's home games, read from the club's public Directus, so a volunteer can start the right
// match with one tap instead of typing two team names on a phone in a noisy hall.
//
//   console --GET /api/schedule--> controlServer --> Schedule.today() --fetch--> Directus /items/games
//
// Read-only and anonymous: the games collection is public on the club's Directus, so no token is
// sent and none is needed. DIRECTUS_URL is the same base the live push uses (livePush.js); unlike
// the push, the schedule does not need LIVE_PUBLISH_TOKEN, and falls back to the club's own
// instance when the variable is unset.
//
// Offline is the NORMAL case for this appliance — most halls give the board no uplink at all — so
// a failure is an answer ({ ok:false, error }), never a thrown error or a 5xx, and it is logged at
// info, not warn: an evening of "could not reach the schedule" lines would bury the real faults.
//
// Optional env:
//   SCHEDULE_HALLS   comma list of hall names ('KWI A,KWI B'); only games in those halls are shown.

import { log } from './logStore.js'

const slog = log.child('schedule')

export const DEFAULT_DIRECTUS_URL = 'https://directus.kscw.ch'
const TIMEOUT_MS = 5000
const CACHE_MS = 5 * 60 * 1000
// A failure is kept for much less time than an answer: the operator who has just plugged in the
// uplink should not wait five minutes to see the list. Short enough to feel live, long enough that
// a console polling it on a board with no uplink does not spend 5 s per request timing out.
const FAIL_CACHE_MS = 30 * 1000
// ?refresh=1 skips the cache, but not more often than this. The route is an open GET (reads stay
// open — docs/logging-DESIGN.md), and a spectator's phone looping it must not become a stream of
// requests from the board to the club's server.
const MIN_REFRESH_MS = 5000
const TZ = 'Europe/Zurich'

// Which Directus `kscw_team.sport` values belong on this board. The simple scoreboard is used in
// the volleyball halls, so it gets the volleyball list. Beach has no sport value of its own in the
// data today, so it takes a beach-ish value if one ever appears and the volleyball games until then.
export function sportFamily(sportKey) {
  if (sportKey === 'basketball') return 'basketball'
  if (sportKey === 'beach') return 'beach'
  return 'volleyball'
}

// Prefixes that say what kind of club it is, not which one. Dropping them is what leaves the
// word a hall actually recognises: 'VBC Züri Unterland H2' → 'ZÜRI H2'.
// 'Volleyballclub', 'Basketball-Club' and friends are one word in some names, hence the stems.
const CLUB_PREFIX = /^(vbc|vc|bc|bbc|tv|stv|sc|ksc|club|volley[\p{L}-]*|basket[\p{L}-]*)$/iu
// A team designation at the end of a name: H1, D3, U17, HU23, 2, …
const TEAM_NO = /^[A-Za-z]{0,3}\d{1,2}$/
const SHORT_MAX = 10

// A short code for the scoreboard. Deliberately a guess the operator can overwrite — the console
// offers these as editable fields — so it only has to be a good first draft, never right.
export function shortName(full) {
  const name = String(full || '').trim().replace(/\s+/g, ' ')
  if (!name) return ''
  // Our own teams: the club already calls itself KSCW everywhere, so keep the whole designation.
  const own = /^KSC\s*Wiedikon\b\s*(.*)$/i.exec(name)
  if (own) return ownShort(own[1])
  const words = name.split(' ')
  const last = words[words.length - 1]
  const number = words.length > 1 && TEAM_NO.test(last) ? words.pop() : ''
  const clean = (w) => w.replace(/[^\p{L}\p{N}-]/gu, '')
  const rest = words.filter((w) => !CLUB_PREFIX.test(clean(w))).map(clean).filter(Boolean)
  // The first word that is a word: 'STV St. Gallen H1' is GALLEN, not ST. Everything a prefix
  // ('Volley 2')? Keep the name rather than print just a number.
  let word = rest.find((w) => w.replace(/-/g, '').length >= 3) || rest[0] || clean(words[0] || '')
  const room = number ? SHORT_MAX - number.length - 1 : SHORT_MAX
  // A double-barrelled place that does not fit keeps its first half: ANDWIL, not ANDWIL-ARN.
  if (word.length > room && word.includes('-')) word = word.split('-')[0]
  return clampShort(number ? `${word.slice(0, Math.max(3, room))} ${number}` : word)
}

// 'KSC Wiedikon <rest>' → KSCW plus the designation, and the designation is the part that must
// survive: clamping 'KSCW HERREN 1' to ten characters printed 'KSCW HERRE' and dropped the number
// that tells H1 from H3. So a spelled-out 'Herren 1' / 'Damen 2' folds to the league's own H1 / D2,
// and anything else that does not fit shortens the middle word, never the number.
function ownShort(rest) {
  const parts = String(rest || '').split(' ').filter(Boolean)
  const number = parts.length > 1 && TEAM_NO.test(parts[parts.length - 1]) ? parts.pop() : ''
  const mid = parts.join(' ')
  const whole = ['KSCW', mid, number].filter(Boolean).join(' ')
  if (!number || whole.length <= SHORT_MAX) return clampShort(whole)
  const folded = `KSCW ${mid[0]}${number}`
  if (/^\p{L}+$/u.test(mid) && folded.length <= SHORT_MAX) return clampShort(folded)
  const room = SHORT_MAX - 'KSCW '.length - number.length - 1
  return clampShort(room > 0 ? `KSCW ${mid.slice(0, room)} ${number}` : `KSCW ${number}`)
}

const clampShort = (s) => s.toLocaleUpperCase('de-CH').slice(0, SHORT_MAX).trim()

// 'YYYY-MM-DD' for today in the hall's time zone. The board's own TZ may be UTC, and at 00:30 in
// Zurich UTC still says yesterday.
export function zurichDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t) => (parts.find((p) => p.type === t) || {}).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// 'YYYY-MM-DD' plus `days`, as calendar arithmetic (no time zone involved: a date has none).
export function addDays(date, days) {
  const [y, m, d] = String(date).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// How far Zurich's wall clock is ahead of UTC at `epochMs` (+1 h in winter, +2 h in summer).
function zurichOffsetMs(epochMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs))
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(epochMs / 1000) * 1000
}

// The instant a game starts: its Directus date + time are Zurich wall time. Two passes, so a game
// on the Sunday the clocks change still lands on the right hour.
export function zurichEpoch(date, time = '00:00') {
  const [y, m, d] = String(date).split('-').map(Number)
  const [hh, mm] = String(time || '00:00').split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0)
  const first = wall - zurichOffsetMs(wall)
  return wall - zurichOffsetMs(first)
}

// Parse SCHEDULE_HALLS into a lower-cased set, or null for "every hall".
export function parseHalls(raw) {
  const list = String(raw || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  return list.length ? new Set(list) : null
}

const directusSport = (g) => String((g && g.kscw_team && g.kscw_team.sport) || '').toLowerCase()

// The predicate that keeps this board's games out of `list`, given how to read a row's sport.
// Beach is decided over the WHOLE list, not row by row: once any beach game exists, the board
// wants only those; until then it takes the volleyball games (see sportFamily).
export function familyFilter(list, sport, sportOf) {
  const family = sportFamily(sport)
  if (family === 'beach') {
    const beachy = list.some((g) => sportOf(g).includes('beach'))
    return beachy ? (g) => sportOf(g).includes('beach') : (g) => sportOf(g) === 'volleyball'
  }
  return (g) => sportOf(g) === family
}

// Directus rows → the console's list. Pure, so the selftest can feed it the exact shape the
// real endpoint returns.
export function toGames(rows, { sport = 'volleyball', halls = null } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const wanted = familyFilter(list, sport, directusSport)
  const seen = new Set()
  const games = []
  for (const g of list) {
    if (!g || g.type !== 'home') continue
    if (['cancelled', 'postponed'].includes(String(g.status || '').toLowerCase())) continue
    if (!wanted(g)) continue
    const hall = String((g.hall && g.hall.name) || '')
    if (halls && !halls.has(hall.trim().toLowerCase())) continue
    const home = String(g.home_team || '').trim()
    const away = String(g.away_team || '').trim()
    const time = String(g.time || '').slice(0, 5)
    // A KSCW-vs-KSCW game is in the table once per team. Both rows describe the same match.
    const key = `${time}|${home}|${away}`
    if (seen.has(key)) continue
    seen.add(key)
    games.push({
      id: g.id, time, home, away,
      homeShort: shortName(home), awayShort: shortName(away),
      league: String(g.league || ''), hall,
      kscwIsHome: /^KSC\s*Wiedikon\b/i.test(home),
    })
  }
  return games.sort((a, b) => a.time.localeCompare(b.time))
}

export class Schedule {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = TIMEOUT_MS, minRefreshMs = MIN_REFRESH_MS } = {}) {
    this.base = String(env.DIRECTUS_URL || DEFAULT_DIRECTUS_URL).replace(/\/+$/, '')
    this.halls = parseHalls(env.SCHEDULE_HALLS)
    Object.assign(this, { fetchImpl, now, timeoutMs, minRefreshMs })
    this._cache = new Map() // `${date}|${sport}` -> { at, ttl, value }
    this._inflight = new Map()
    this._lastFetchAt = 0
  }

  // Never throws. `refresh` skips the cache (but see MIN_REFRESH_MS).
  async today({ sport = 'volleyball', refresh = false } = {}) {
    const date = zurichDate(this.now())
    const key = `${date}|${sport}`
    const t = Date.now()
    const hit = this._cache.get(key)
    const mayRefresh = t - this._lastFetchAt >= this.minRefreshMs
    if (hit && t - hit.at < hit.ttl && !(refresh && mayRefresh)) return hit.value
    if (this._inflight.has(key)) return this._inflight.get(key)
    const p = this._load(date, sport).then((value) => {
      this._cache.set(key, { at: Date.now(), ttl: value.ok ? CACHE_MS : FAIL_CACHE_MS, value })
      // Only today's entries are ever worth keeping.
      for (const k of this._cache.keys()) if (!k.startsWith(`${date}|`)) this._cache.delete(k)
      return value
    }).finally(() => this._inflight.delete(key))
    this._inflight.set(key, p)
    return p
  }

  async _load(date, sport) {
    this._lastFetchAt = Date.now()
    const qs = new URLSearchParams({
      filter: JSON.stringify({ date: { _eq: date } }),
      sort: 'time',
      fields: 'id,time,home_team,away_team,type,status,league,kscw_team.sport,hall.name',
      limit: '50',
    })
    const url = `${this.base}/items/games?${qs}`
    try {
      const resp = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'application/json' } })
      if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { plain: `The club's schedule answered with an error (HTTP ${resp.status}). Type the team names instead.` })
      let body
      try { body = await resp.json() } catch { throw Object.assign(new Error('not JSON'), { plain: "The club's schedule sent something unreadable. Type the team names instead." }) }
      if (!body || !Array.isArray(body.data)) throw Object.assign(new Error('no data array'), { plain: "The club's schedule sent something unreadable. Type the team names instead." })
      const games = toGames(body.data, { sport, halls: this.halls })
      slog.debug(`schedule for ${date}: ${games.length} game(s)`, { date, sport, games: games.length, rows: body.data.length })
      return { ok: true, date, sport, games }
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      const error = (err && err.plain) || (timedOut
        ? `The club's schedule did not answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} seconds. The board may have no internet here — type the team names instead.`
        : 'The board could not reach the club\'s schedule. It may have no internet here — type the team names instead.')
      slog.info(`schedule unavailable: ${err && err.message}`, { url: this.base, date, sport, error: err && err.message })
      return { ok: false, date, sport, error, games: [] }
    }
  }
}
