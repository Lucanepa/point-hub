// Which `live_scores` rows the board writes, and how a match is turned around for its fixture's row.
//
// The board has always written ONE row, its own channel ('kscw' for the club's first board), with
// team A = whoever stands on the LEFT. That row carries every match, scheduled or not, and stays
// exactly as it was: /live, kscw.ch's "Live now" pill and the recent-matches list all read it.
//
// wiedisync reads a game's live score from a SECOND kind of row, `game-<games.id>`, which phone
// live scoring writes (wiedisync live-scoring.js): the game modal's "Watch live" and the result
// entry's prefill (game-result.js liveOf) look there and nowhere else, so a game scored on the
// board never reached either. When the board knows the fixture it now writes that row too. Its
// contract is the phone's, not the board's: team A = HOME, team B = AWAY, for the whole match —
// game-result.js maps a → home when it prefills the result that goes to Volleymanager. The board
// row's A is the LEFT side and swaps at every change of ends (set_results with it), so the fixture
// row is the board row turned around whenever home stands on the right (toHomeAway). Written as-is
// it would file every even set with home and away swapped.
//
//   board row   channel = boardChannel()     A = left        every match
//   fixture row channel = game-<games.id>    A = home        only while the fixture is known
//
// Who is home is read from the NAMES on the board against the schedule's (homeSide). The schedule
// start puts home on the left and the names in, so they agree unless someone retyped them; a board
// that cannot tell writes no fixture row at all — a missing prefill is a nuisance, a swapped one is
// a wrong result reported to the federation.

import os from 'node:os'

// The club's first board (the Tech4Sport C0270) has always published as 'kscw', and everything
// downstream names it: wiedisync /live, kscw.ch, the publisher policy that pins its token to it.
export const DEFAULT_CHANNEL = 'kscw'
// wiedisync's per-game rows (live-scoring.js channelFor). A board channel may never look like one.
export const FIXTURE_PREFIX = 'game-'

// Host names that say nothing about WHICH board this is (an OS default, the board's old alias): a
// board called that is the club's first board as far as the channel is concerned.
const GENERIC_HOSTS = new Set(['', 'localhost', 'raspberrypi', 'pi', 'ledbox'])
// The C0270's own name on the tailnet is `ledbox-c0270`.
const FIRST_BOARD = /(^|-)c0270$/

/**
 * The board's own channel — the row every match goes to, scheduled or not.
 *
 *   LIVE_CHANNEL set     → that, as before (it is also what the board's token is pinned to).
 *   LIVE_CHANNEL unset   → derived from the host name, so a second board on defaults gets its own
 *                          row instead of overwriting the first one's ('ledbox-court2' →
 *                          'ledbox-court2'). The C0270, and any board still on a generic host name,
 *                          stays 'kscw'.
 *
 * Never a `game-…` channel: that would put a left/right board row where a home/away fixture row
 * belongs. An explicit LIVE_CHANNEL like that is ignored (with `onRefused`), not obeyed.
 */
export function boardChannel(env = process.env, hostname = os.hostname(), { onRefused = null } = {}) {
  const explicit = String(env.LIVE_CHANNEL ?? '').trim()
  if (explicit && !explicit.toLowerCase().startsWith(FIXTURE_PREFIX)) return explicit
  if (explicit && typeof onRefused === 'function') onRefused(explicit)
  const host = String(hostname || '').split('.')[0].trim().toLowerCase()
  if (GENERIC_HOSTS.has(host) || FIRST_BOARD.test(host)) return DEFAULT_CHANNEL
  // The characters kscw.ch's /live accepts in ?channel= (and its 40-character cap).
  const slug = host.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!slug) return DEFAULT_CHANNEL
  return slug.startsWith(FIXTURE_PREFIX) ? `board-${slug}`.slice(0, 40) : slug
}

/** The fixture row's channel, as wiedisync names it (live-scoring.js channelFor). */
export const fixtureChannel = (gameId) => `${FIXTURE_PREFIX}${gameId}`

/**
 * A schedule game (seasonSchedule.js) as the fixture livePush needs: its id and both teams.
 * `homeStartsLeft` = the board was set up from this game, which puts home on the LEFT — so the
 * state's `ends_swapped` says where home is now. False for a linked OpenVolley match, whose team A
 * is whoever the scorer entered first.
 */
export function fixtureOf(game, { homeStartsLeft = false } = {}) {
  const id = Number(game && game.id)
  if (!Number.isInteger(id) || id <= 0) return null
  return {
    id,
    home: String(game.home || ''), away: String(game.away || ''),
    homeShort: String(game.homeShort || ''), awayShort: String(game.awayShort || ''),
    homeStartsLeft: !!homeStartsLeft,
  }
}

// Names compared the way a person would read them: case, accents and spacing do not matter, and the
// club's own "KSCW …" short code is "KSC Wiedikon …" (kscw.ch pending-results.js does the same).
const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim().replace(/^kscw\b/, 'ksc wiedikon')
const names = (...xs) => new Set(xs.map(norm).filter(Boolean))
const meets = (x, y) => [...x].some((n) => y.has(n))

/**
 * Which of the state's two teams is the fixture's HOME team: 'a', 'b', or null when the board
 * cannot tell.
 *
 * The names decide: a side is home when its name or short code is the schedule's home team (or the
 * OTHER side is the away team). When they fit both ways — two sides sharing a short code — a board
 * set up from this game (`homeStartsLeft`) knows home started on the left, and `ends_swapped` (the
 * manual sources keep it) says whether that has flipped since. When they fit NEITHER way the answer
 * is null, ends_swapped or not: those are names typed over the schedule's, or a board that is
 * already showing the next match — exactly when guessing would write one game's score into
 * another's row.
 */
export function homeSide(state, fixture) {
  if (!state || !fixture) return null
  const home = names(fixture.home, fixture.homeShort)
  const away = names(fixture.away, fixture.awayShort)
  const a = names(state.team_a_name, state.team_a_short)
  const b = names(state.team_b_name, state.team_b_short)
  const homeIsA = meets(a, home) || meets(b, away)
  const homeIsB = meets(b, home) || meets(a, away)
  if (homeIsA !== homeIsB) return homeIsA ? 'a' : 'b'
  if (homeIsA && fixture.homeStartsLeft && typeof state.ends_swapped === 'boolean') return state.ends_swapped ? 'b' : 'a'
  return null
}

// Everything in a live row that belongs to one team, as [a, b] column pairs.
const PAIRS = ['name', 'short', 'color'].map((k) => [`team_a_${k}`, `team_b_${k}`])
  .concat(['points', 'sets_won', 'timeouts', 'subs', 'fouls'].map((k) => [`${k}_a`, `${k}_b`]))
const otherSide = (s) => (s === 'left' ? 'right' : s === 'right' ? 'left' : s)

/**
 * A live row (livePush toRow: A = left) turned so that team A is the fixture's HOME team. `side` is
 * homeSide()'s answer: 'a' returns the row as it is, 'b' swaps every team column, the serve (the
 * row's 'left' means team A) and every set result — keeping each set's `dur`.
 */
export function toHomeAway(row, side) {
  if (side !== 'b') return { ...row }
  const out = { ...row }
  for (const [x, y] of PAIRS) { out[x] = row[y]; out[y] = row[x] }
  out.serving_team = otherSide(row.serving_team) ?? null
  out.set_results = (Array.isArray(row.set_results) ? row.set_results : []).map((r) => ({ ...r, a: r.b, b: r.a }))
  return out
}
