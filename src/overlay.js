// The livestream scorebug, served by the board: the data behind /overlay (an OBS browser source),
// GET /api/overlay.json (a vMix Data Source, or any graphics tool that reads JSON) and the
// /api/overlay/stream that pushes it.
//
//   SourceManager state + the countdown --toOverlay--> one flat object --> /api/overlay.json
//                                                                     \--> /api/overlay/stream --> /overlay
//
// Built on livePush's toRow, the row the club's public /live page already shows — so the overlay
// can never carry more than that page does: team names, colours and the score. No player, no
// referee, no roster, no serving player's number, nothing from the match log. On top of the row it
// adds only the countdown the hall can already read off the panel (a timeout, the set interval, the
// warm-up).
//
// FLAT on purpose. vMix maps one JSON object to one row of named columns, and a nested array (the
// set results) is awkward to bind a title to — so the sets are spelled out as set1_a … set5_b and as
// one ready-made string. EVERY key is present in every answer, blank when it does not apply, so a
// title bound to a column never shows a missing-field error between matches.
//
// Teams are A and B as the row has them. On the board's own sources team A is whoever is on the
// LEFT of the panel (a change of ends swaps them, as on the panel); a linked OpenVolley match keeps
// A fixed. Either way the overlay agrees with /live.

import { toRow } from './livePush.js'

const HEX = /^#[0-9a-fA-F]{6}$/
// The board's own neutral colours (lanSource WAITING), for a team with none or a malformed one.
const DEFAULT_COLOR = { a: '#2563eb', b: '#ef4444' }
// Sets spelled out as columns: volleyball's five covers every sport this board plays by sets.
export const OVERLAY_SETS = 5
// Clamps for anything typed by a person — this lands on a broadcast.
const NAME_MAX = 40
const SHORT_MAX = 12
const LABEL_MAX = 24

// Every key, in the order a vMix column list shows them. The selftest holds the answer to exactly
// this set, which is what keeps "no personal data" true as the live row grows.
export const OVERLAY_KEYS = [
  'v', 'sport', 'status', 'period', 'period_label',
  'team_a', 'team_a_name', 'team_a_color', 'team_b', 'team_b_name', 'team_b_color',
  'points_a', 'points_b', 'sets_a', 'sets_b', 'timeouts_a', 'timeouts_b', 'fouls_a', 'fouls_b',
  'serving', 'set_scores',
  ...Array.from({ length: OVERLAY_SETS }, (_, i) => [`set${i + 1}_a`, `set${i + 1}_b`]).flat(),
  'break', 'break_team', 'break_seconds', 'break_clock',
]

// Printable text only (a control character becomes a space, so a pasted line break still separates
// two words), whitespace collapsed, clamped.
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const color = (v, side) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : DEFAULT_COLOR[side])
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function periodLabel(sport, status, period) {
  if (status === 'idle' || !period) return ''
  if (sport === 'basketball') return period <= 4 ? `Q${period}` : `OT${period - 4}`
  if (sport === 'volleyball' || sport === 'beach') return `SET ${period}`
  return '' // the simple scoreboard has no sets
}

// `countdown` = { label, team, remainingMs } while one runs on the panel (controlServer's), else null.
export function toOverlay(state, { sport = 'volleyball', countdown = null } = {}) {
  const row = state ? toRow(state, null, sport) : null
  const out = {
    v: 1,
    sport: String(sport),
    status: row ? row.status : 'idle',
    period: row ? row.period : 0,
    period_label: '',
    team_a: '', team_a_name: '', team_a_color: DEFAULT_COLOR.a,
    team_b: '', team_b_name: '', team_b_color: DEFAULT_COLOR.b,
    points_a: 0, points_b: 0, sets_a: 0, sets_b: 0, timeouts_a: 0, timeouts_b: 0, fouls_a: 0, fouls_b: 0,
    serving: '',
    set_scores: '',
  }
  for (let i = 1; i <= OVERLAY_SETS; i++) { out[`set${i}_a`] = ''; out[`set${i}_b`] = '' }
  Object.assign(out, { break: '', break_team: '', break_seconds: 0, break_clock: '' })

  if (row) {
    out.period_label = periodLabel(sport, row.status, row.period)
    for (const k of ['a', 'b']) {
      const name = clean(row[`team_${k}_name`], NAME_MAX)
      const short = clean(row[`team_${k}_short`], SHORT_MAX)
      // The short code where there is one, as the panel shows it (capitals, see volleyballMapper).
      out[`team_${k}`] = (short || name).toUpperCase()
      out[`team_${k}_name`] = name || short
      out[`team_${k}_color`] = color(row[`team_${k}_color`], k)
      out[`points_${k}`] = row[`points_${k}`]
      out[`sets_${k}`] = row[`sets_won_${k}`]
      out[`timeouts_${k}`] = row[`timeouts_${k}`]
      out[`fouls_${k}`] = row[`fouls_${k}`]
    }
    // The row has already put serve (or basketball's possession) onto A/B as 'left'|'right'.
    out.serving = row.serving_team === 'left' ? 'a' : row.serving_team === 'right' ? 'b' : ''
    const sets = row.set_results || []
    out.set_scores = sets.map((r) => `${r.a}-${r.b}`).join('  ')
    sets.slice(0, OVERLAY_SETS).forEach((r, i) => { out[`set${i + 1}_a`] = r.a; out[`set${i + 1}_b`] = r.b })
  }

  if (countdown && countdown.remainingMs > 0) {
    const s = Math.ceil(countdown.remainingMs / 1000)
    out.break = clean(countdown.label, LABEL_MAX).toUpperCase()
    // The name the panel's break screen shows for a timeout (a short code, or the name if none).
    out.break_team = clean(countdown.team, LABEL_MAX).toUpperCase()
    out.break_seconds = s
    out.break_clock = mmss(s)
  }
  return out
}
