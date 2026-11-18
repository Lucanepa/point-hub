// The two short texts the board shows by itself during an indoor volleyball match:
//
//   SATZBALL / MATCHBALL   while a team is one point from winning the set (or the match). Read off
//                          the score of whatever source is on the board — the console's own scoring,
//                          a schedule start, a linked OpenVolley match — so it needs nothing from
//                          the scorer. Painted by ledboxClient (the name slot of that team, taking
//                          turns with the name; on the Point Hub board also on the bench modules).
//   WECHSEL 12 ⇄ 7         for a few seconds after a substitution in a linked OpenVolley match
//                          (controlServer watchLinkedMatch, on the announcement screen kscw_message).
//
// Words in the board's language (Settings ▸ Language): German and Swiss German alike, else English.

import { formatRules } from './settings.js'

// bench*: the same word for the Point Hub board's bench modules, which are 32 px wide: two lines,
// split at the space (openscore.py _bench_picture).
export const BOARD_WORDS = {
  de: { set: 'SATZBALL', match: 'MATCHBALL', sub: 'WECHSEL', benchSet: 'SATZ BALL', benchMatch: 'MATCH BALL' },
  en: { set: 'SET POINT', match: 'MATCH POINT', sub: 'SUBSTITUTION', benchSet: 'SET POINT', benchMatch: 'MATCH POINT' },
}

export function boardWords(language) {
  return String(language || '').toLowerCase().startsWith('de') ? BOARD_WORDS.de : BOARD_WORDS.en
}

// The match format of a state: OpenVolley sends best_of, the board's own sources sets_to_win (2 or
// 3). `fallback` = Settings ▸ Match format, for a state that carries neither.
export function matchBestOf(state, fallback = 5) {
  const bo = Number(state && state.best_of)
  if (bo === 3 || bo === 5) return bo
  const toWin = Number(state && state.sets_to_win)
  if (toWin === 2) return 3
  if (toWin === 3) return 5
  return Number(fallback) === 3 ? 3 : 5
}

const OVER = new Set(['ended', 'final', 'approved', 'finished', 'completed'])
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Set point / match point: one team needs one more point to win the set — 25 in a normal set, 15 in
// the deciding one — AND that point would win it, with the two-point lead. 24:23 is a set point,
// 24:24 is not, 25:24 is again; 14:13 in the deciding set too. A match point is a set point in a set
// that would win that team the match (sets 2:x in best-of-5, 1:x in best-of-3).
//
// null when nobody has one, and whenever the score is not a set in play: a set already won (the
// board's own scoring keeps the final 25:23 up until "next set", with the set already counted, so
// the deciding test is not even about the same set any more), a match decided, OpenVolley's match
// over or its set interval. Never both teams: each would need the lead.
//
// Returns { kind: 'set' | 'match', team: 'a' | 'b', side: 'left' | 'right' } — `side` the panel half
// the team stands on (side_a, as toLeftRight reads it).
export function gamePoint(state, { bestOf = 5 } = {}) {
  if (!state || typeof state !== 'object') return null
  if (OVER.has(String(state.match_status || '').toLowerCase())) return null
  if (state.set_interval_active === true) return null
  const pa = n(state.points_a), pb = n(state.points_b)
  const sa = n(state.sets_won_a), sb = n(state.sets_won_b)
  const { toWin, target } = formatRules(matchBestOf(state, bestOf), sa, sb)
  if (sa >= toWin || sb >= toWin) return null
  const won = (p, q) => p >= target && p - q >= 2
  if (won(pa, pb) || won(pb, pa)) return null
  const atPoint = (p, q) => p + 1 >= target && p + 1 - q >= 2
  const team = atPoint(pa, pb) ? 'a' : atPoint(pb, pa) ? 'b' : null
  if (!team) return null
  const kind = (team === 'a' ? sa : sb) === toWin - 1 ? 'match' : 'set'
  const aLeft = (state.side_a || 'left') !== 'right'
  return { kind, team, side: (team === 'a') === aLeft ? 'left' : 'right' }
}

// A shirt number as the panel shows it: 1-3 digits, nothing else (the relay is not trusted to send
// only numbers). null when there is none.
export function shirtNumber(v) {
  if (v == null) return null
  const s = String(v).trim()
  return /^\d{1,3}$/.test(s) ? String(Number(s)) : null
}

// The exchange sign between the two numbers. ⇄ is in the C0270's ARIAL.TTF; openscore's Liberation
// Sans has no ⇄, and openscore draws ↔ for it (openscore.py GLYPH_FALLBACK).
export const SUB_ARROW = '⇄'

// The two lines of a substitution notice, or null when there is nothing to show:
//   with the numbers    WECHSEL / 12 ⇄ 7     (the player going off first, then the one coming on)
//   without them        WECHSEL / KSCW       (the team's short name) — unless `numbersOnly`
// `sub` = { playerOut, playerIn, name }.
export function subNoticeLines(sub, { language = 'en', numbersOnly = false } = {}) {
  if (!sub) return null
  const word = boardWords(language).sub
  const out = shirtNumber(sub.playerOut), inn = shirtNumber(sub.playerIn)
  if (out && inn) return [word, `${out} ${SUB_ARROW} ${inn}`]
  if (numbersOnly) return null
  const name = String(sub.name || '').replace(/[^\x20-\x7EÀ-ÿ]/g, '').trim().toUpperCase().slice(0, 16)
  return name ? [word, name] : null
}
