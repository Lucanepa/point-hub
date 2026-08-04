// Maps an OpenVolley `match_live_state` row -> LEDbox layout sections.
//
// Source of truth for the field semantics:
//   Scoreboard.jsx:1958  (how the row is built; serving_team already left/right)
//   LivescoreApp.jsx:143 (getLeftRight: side_a decides left/right; sets vs points)
//
// Target layout = the device's `volleyball_matchscore_02` sections:
//   team1/team2, score1/score2 (big current-set points), set1/set2 (sets won),
//   timeout1/timeout2 (T), sub1/sub2 (S, substitution counts),
//   serve1/serve2 (rectangles lit in the serving team colour).

import { hexToRgb } from './ledboxProtocol.js'

// timeouts_a / subs_a arrive as an array (full detail, for the referee) or a
// plain number depending on the source — count either shape.
function count(t) {
  if (Array.isArray(t)) return t.length
  if (typeof t === 'number') return t
  return 0
}

// The panel speaks in capitals, and that is enforced here rather than asked for at each call site.
//
// This is the one chokepoint every name passes through: all three sports' mappers, every screen
// (match, break, countdown, both idle screens) and the relay path all read left/rightName from
// here. Doing it anywhere else leaves a hole — the console can normalise what the SCORER types,
// but nothing in this repo controls the names an eScoresheet pushes over the LAN relay.
//
// Why coerce at all: the console's name box is styled `text-transform: uppercase`, so a name
// typed in lower case looks CORRECT to the scorer and is wrong only on the panel, twenty metres
// away, where nobody can fix it mid-match. A phone keyboard produces lower case by default, so
// this is the likely input, not the exotic one.
//
// It must also happen BEFORE fitFontSize: capitals run ~15-20% wider than lower case, so sizing
// the typed string and painting a different one is precisely how a name ends up clipped.
const upper = (s) => String(s).toUpperCase()

// Resolve the A/B model to physical left/right using side_a, exactly like getLeftRight.
export function toLeftRight(state) {
  const isALeft = (state.side_a || 'left') === 'left'
  const pick = (a, b) => (isALeft ? a : b)
  return {
    leftName: upper(pick(state.team_a_short || state.team_a_name, state.team_b_short || state.team_b_name) || 'TEAM A'),
    // Full names, for screens with room for them (the crest idle screen auto-fits).
    leftFull: upper(pick(state.team_a_name || state.team_a_short, state.team_b_name || state.team_b_short) || 'TEAM A'),
    rightFull: upper(pick(state.team_b_name || state.team_b_short, state.team_a_name || state.team_a_short) || 'TEAM B'),
    rightName: upper(pick(state.team_b_short || state.team_b_name, state.team_a_short || state.team_a_name) || 'TEAM B'),
    leftColor: hexToRgb(pick(state.team_a_color, state.team_b_color)),
    rightColor: hexToRgb(pick(state.team_b_color, state.team_a_color)),
    leftPoints: pick(state.points_a, state.points_b) || 0,
    rightPoints: pick(state.points_b, state.points_a) || 0,
    leftSets: pick(state.sets_won_a, state.sets_won_b) || 0,
    rightSets: pick(state.sets_won_b, state.sets_won_a) || 0,
    leftTimeouts: count(pick(state.timeouts_a, state.timeouts_b)),
    rightTimeouts: count(pick(state.timeouts_b, state.timeouts_a)),
    leftSubs: count(pick(state.subs_a, state.subs_b)),
    rightSubs: count(pick(state.subs_b, state.subs_a)),
    serving: state.serving_team || null, // already 'left' | 'right'
  }
}

// The LEDbox SetSections WRITE shape is one { name, value: { attrib, value } } entry
// PER attribute — this differs from the GetSections READ shape, which nests attribs
// in an array. To set both text and colour on a section, emit that section name twice.
// (Confirmed against a real Tech4Sport LedBox C0270, firmware 0.551, on 2026-07-30.)
const attr = (name, attrib, value) => ({ name, value: { attrib, value: String(value) } })
const text = (name, value, color) =>
  color ? [attr(name, 'text', value), attr(name, 'color', color)] : [attr(name, 'text', value)]
const rect = (name, color) => [attr(name, 'color', color)]
// The score box: black fill so the big number reads, border in the team colour.
//
// `bordercolor` appears NOWHERE in the vendor app — an exhaustive scan of ledbox.dll found
// no such attribute, and the device returns ok for any name, so it looked like a no-op we
// were fooling ourselves with. It is not: removing it visibly reverted the away box to the
// layout's default red on the hardware. The firmware supports more than the vendor app
// bothers to use, so absence from the APK is not evidence of absence in the device.
const box = (name, color) => [attr(name, 'color', '0,0,0'), attr(name, 'bordercolor', color)]

// Limit colouring for the timeout and substitution counters, so the referee's table can
// read "this team has nothing left" off the board at a glance instead of doing arithmetic.
// FIVB per-set maximums: 2 timeouts (12.1) and 6 substitutions (15.6).
export const NEUTRAL_COUNTER = '200,200,200'
export const WARN_COUNTER = '255,176,0'   // amber: one short of the limit
export const MAXED_COUNTER = '170,0,20'   // dark red: none left
export const TIMEOUT_MAX = 2
export const SUB_WARN = 5
export const SUB_MAX = 6
const limitColor = (n, warnAt, maxAt) =>
  (n >= maxAt ? MAXED_COUNTER : n >= warnAt ? WARN_COUNTER : NEUTRAL_COUNTER)

// Sections for `volleyball_matchscore_timeout_02` — the device's countdown screen.
// It carries its own score1/score2/set1/set2, which are NOT the ones we paint on the match
// layout, so without this the board shows 0-0 during a timeout while the real score sits
// two points away on a screen nobody can see.
// `content` picks what fills the two BIG score boxes and the small set line beside the clock —
// different breaks want different headlines, and an irrelevant number is just noise on an LED:
//   'full' (timeout)      big = points (play resumes here) · small line = the set score
//   'sets' (set interval) big = the SET score (the headline of a set break) · small line hidden
//   'none' (warm-up)      the clock alone; no numbers yet
export function toCountdownSections(state, { timerText, label, content = 'full' } = {}) {
  const v = state ? toLeftRight(state) : null
  const out = []
  if (timerText != null) out.push(attr('timer', 'text', timerText))
  // `lbl` is a narrow box — long labels get clipped rather than shrunk (sections are fixed
  // CSS boxes), so callers should keep this short.
  if (label) out.push(attr('lbl', 'text', String(label).toUpperCase()))

  // big = the two large score boxes; small = the little line above them.
  let bigL = '', bigR = '', smallL = '', smallR = '', sep = ''
  if (v && content === 'full') {
    bigL = v.leftPoints; bigR = v.rightPoints    // timeout: points big, set score small
    smallL = v.leftSets; smallR = v.rightSets; sep = '-'
  } else if (v && content === 'sets') {
    bigL = v.leftSets; bigR = v.rightSets        // interval: set score big, small line blank
  }
  // Blank by writing an empty string: the section keeps its box, it just stops showing a number.
  out.push(...text('score1', bigL, v?.leftColor))
  out.push(...text('score2', bigR, v?.rightColor))
  out.push(...text('set1', smallL, v?.leftColor))
  out.push(...text('set2', smallR, v?.rightColor))
  out.push(attr('sep', 'text', sep))
  // Paint the box borders only when a number sits inside them (timeout + interval).
  if (v && content !== 'none') {
    out.push(...box('bg_score1', v.leftColor))
    out.push(...box('bg_score2', v.rightColor))
  }
  return out
}


// Sections for `kscw_break` — our own break screen, replacing the vendor's countdown
// layout which crams everything into the right third and leaves the left half black.
//
// Shape: the two big bordered score boxes stay left and right (same geometry as the match
// layout, so the eye doesn't have to re-find them), set score in the top corners, and the
// centre column carries the break itself — label, who called it, and the clock.
//
// `content` picks what fills the boxes, as with the vendor screen:
//   'full' (timeout)      big = points (play resumes here) · corners = set score · team shown
//   'sets' (set interval) big = the SET score · corners blank · no team
//   'none' (warm-up)      boxes hidden entirely, just the label and a big clock
//
// The clock's size is fitted to the gap BETWEEN the boxes (x 64..127). At a fixed size a
// long clock ("10:00") runs into them, which is exactly what the vendor screen does.
const BREAK_CLOCK_WIDTH = 58 // the 64px gap between the boxes, less a margin each side
// The team name sits in that same centre column, so it has the same room — a quarter of what the
// scoreboard's 86px name column gives it.
const BREAK_NAME_WIDTH = BREAK_CLOCK_WIDTH

export function toBreakSections(state, {
  timerText, label, content = 'full', team, side = null,
  matchFontMaxLeft = 18, matchFontMaxRight = 18,
} = {}) {
  const v = state ? toLeftRight(state) : null
  const out = []
  const showTeam = content === 'full' && !!team
  const boxes = content !== 'none'

  // Written even when empty. The board keeps every layout's section values, so skipping the
  // write on a blank label does not leave the label blank — it leaves whatever the PREVIOUS
  // break screen put there, and the next countdown inherits it.
  out.push(attr('lbl', 'text', label ? String(label).toUpperCase() : ''))
  const teamText = showTeam ? String(team).toUpperCase() : ''
  out.push(attr('team', 'text', teamText))
  // Sized with the SAME per-side ceiling the operator set for the scoreboard, so a name they made
  // bigger stays bigger when that team calls a timeout instead of snapping back to the 15 baked
  // into the layout XML. Fitted to this screen's own column, though: the ceiling is a ceiling, and
  // the centre column here is 58px against the scoreboard's 86px, so a name that fits at 24 out
  // there can still have to step down in here rather than run into the two score boxes.
  if (teamText) {
    const ceiling = side === 'right' ? matchFontMaxRight : matchFontMaxLeft
    out.push(attr('team', 'fontsize', fitFontSize(teamText, BREAK_NAME_WIDTH, { max: ceiling, min: 8 })))
  }

  // Two clock sections rather than one: with a team name above it the clock sits lower and
  // smaller, without one it moves up and grows. A single section can't be in both places.
  const clock = timerText == null ? '' : String(timerText)
  if (showTeam) {
    out.push(attr('timer', 'text', clock), attr('timerbig', 'text', ''))
    if (clock) out.push(attr('timer', 'fontsize', fitFontSize(clock, BREAK_CLOCK_WIDTH, { max: 26 })))
  } else {
    out.push(attr('timerbig', 'text', clock), attr('timer', 'text', ''))
    if (clock) out.push(attr('timerbig', 'fontsize', fitFontSize(clock, BREAK_CLOCK_WIDTH, { max: 34 })))
  }

  let bigL = '', bigR = '', cornerL = '', cornerR = ''
  if (v && content === 'full') {
    bigL = v.leftPoints; bigR = v.rightPoints
    cornerL = v.leftSets; cornerR = v.rightSets
  } else if (v && content === 'sets') {
    bigL = v.leftSets; bigR = v.rightSets
  }
  out.push(...text('score1', bigL, v?.leftColor))
  out.push(...text('score2', bigR, v?.rightColor))
  out.push(...text('set1', cornerL, v?.leftColor))
  out.push(...text('set2', cornerR, v?.rightColor))
  // Warm-up has no numbers, so the empty boxes would just be two floating rectangles —
  // paint their borders black to hide them rather than leave the panel looking broken.
  const OFF = '0,0,0'
  out.push(...box('bg_score1', boxes && v ? v.leftColor : OFF))
  out.push(...box('bg_score2', boxes && v ? v.rightColor : OFF))
  return out
}

// Pre-match / between-matches screen on the ordinary match layout: the two team names with
// "VS" between them, everything else blanked. No image upload needed — this is the version
// that works today. A logo screen (full-panel image) is the eventual upgrade once the board
// will accept a media upload; until then this replaces the bare "HOME 0 AWAY 0" idle look.
export function toIdleSections(state, { off = '30,30,30' } = {}) {
  const v = state ? toLeftRight(state) : null
  const left = v?.leftName || 'HOME'
  const right = v?.rightName || 'AWAY'
  return [
    ...text('team1', left, v?.leftColor),
    ...text('team2', right, v?.rightColor),
    ...text('score1', '', v?.leftColor),
    ...text('score2', '', v?.rightColor),
    ...text('set1', ''), ...text('set2', ''),
    attr('vs', 'text', 'VS'),
    ...text('timeout1', ''), ...text('timeout2', ''),
    ...text('sub1', ''), ...text('sub2', ''),
    ...rect('serve1', off), ...rect('serve2', off),
  ]
}

const ARIAL_CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00e9\u00e8\u00e0\u00e7\u00f1\u00c9\u00c8\u00c0"
const ARIAL_W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,500,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,556,556,556,667,778,722,556,556,556,500,556,667,667,667]
// The panel's font is fonts/ARIAL.TTF; these are its advance widths per 1000 units, so we
// can size text to fit without guessing. A crude average either overflows (VBC Kuesnacht)
// or wastes half the panel (Volley Zuerich) -- the spread between names is that wide.
function textWidth(str, size) {
  let w = 0
  for (const ch of String(str)) {
    const i = ARIAL_CHARS.indexOf(ch)
    w += i >= 0 ? ARIAL_W[i] : 556 // unknown glyph: assume an average-width one
  }
  return (w * size) / 1000
}

// Largest size at which `str` fits `maxWidth`, clamped. 2px of slack because the advance
// width and the inked width differ slightly, and a clipped club name looks broken.
export function fitFontSize(str, maxWidth, { max = 24, min = 9 } = {}) {
  for (let size = max; size > min; size--) {
    if (textWidth(str, size) <= maxWidth - 2) return size
  }
  return min
}

// Idle screen for the club layout (`kscw_idle`): the KSC Wiedikon crest plus the two team
// names, nothing else. That layout deliberately has no score/set/timeout sections, so this
// must NOT send them — SetSections aborts on the first unknown section name (error 6) and
// the whole paint would be lost, leaving the previous screen up.
// KSC Wiedikon gold (#FFC832). The crest is blue and gold, so the club's own name picks
// up the gold; the opponent keeps its real colour.
export const CLUB_GOLD = '255,200,50'

// Is this name the club whose crest is on the panel? Matched on the name rather than on a
// side, because the club is not always the home/left team — an away fixture would otherwise
// paint the OPPONENT in club colours. Compared loosely so "KSCW", "KSC Wiedikon" and
// "KSC Wiedikon H3" all match a club name of "KSC WIEDIKON".
function isClub(name, clubName) {
  const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const a = norm(name), b = norm(clubName)
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

export function toClubIdleSections(state, { fullNames = true, maxFontSize = 24, clubName = '' } = {}) {
  const v = state ? toLeftRight(state) : null
  // The crest occupies x 3..56, so the name column starts at 67 and runs to the edge.
  const COLUMN = 192 - 67
  const left = (fullNames ? v?.leftFull : v?.leftName) || 'KSCW'
  const right = (fullNames ? v?.rightFull : v?.rightName) || 'GAST'
  // Sized per side, not once for both: "KSC Wiedikon" vs "Zug" want very different sizes,
  // and forcing them to match would shrink the short one for no reason.
  // Match on both the displayed name and the short code, so it works either way round.
  const leftIsClub = isClub(left, clubName) || isClub(v?.leftName, clubName)
  const rightIsClub = isClub(right, clubName) || isClub(v?.rightName, clubName)
  return [
    ...text('team1', left, leftIsClub ? CLUB_GOLD : v?.leftColor),
    attr('team1', 'fontsize', fitFontSize(left, COLUMN, { max: maxFontSize })),
    ...text('team2', right, rightIsClub ? CLUB_GOLD : v?.rightColor),
    attr('team2', 'fontsize', fitFontSize(right, COLUMN, { max: maxFontSize })),
  ]
}

// In-match name column. `team1` sits at x=0 align=left and the set counter starts at x=91;
// `team2` is the mirror (x=192 align=right, set2 ends at ~105). So each name gets ~86px before
// it runs into the centre column. Beach (78) and basketball (62) have their own narrower boxes.
const MATCH_NAME_WIDTH = 86

// End-of-match result screen (`kscw_result`): who won, the set score, and every set played.
// Three centred lines on a 192x64 panel, so this is placement only — the caller decides the
// wording, because what counts as a "set score" differs by sport (sets won for volleyball and
// beach, final points for basketball) and the mapper has no business knowing which is running.
//
// Every line is auto-fitted. A five-set history is nearly three times the width of a three-set
// one, and a club that types its full name instead of a code doubles the winner line — a fixed
// size would clip whichever one the layout was not tuned for.
const RESULT_WIDTH = 188   // 192 less a 2px margin each side

export function toResultSections({ winner = '', score = '', history = '', color = CLUB_GOLD } = {}) {
  return [
    attr('winner', 'text', winner),
    attr('winner', 'color', color),
    attr('winner', 'fontsize', fitFontSize(winner, RESULT_WIDTH, { max: 17, min: 8 })),
    attr('sets', 'text', score),
    attr('sets', 'fontsize', fitFontSize(score, RESULT_WIDTH, { max: 24, min: 10 })),
    attr('history', 'text', history),
    // Allowed smaller than the others: five sets is the longest string the panel ever shows, and
    // shrinking it beats dropping sets off the end.
    attr('history', 'fontsize', fitFontSize(history, RESULT_WIDTH, { max: 11, min: 6 })),
  ]
}

// Full-panel announcement screen (`kscw_message`): one short phrase, as large as it will go,
// in club gold. Built for the change of ends, which needs no clock and no score — it is a single
// instruction to two teams and a hall, and it should read from the back row.
//
// Two text slots rather than one, the same trick the break screen uses for its clock: a phrase
// that splits over two lines gets far more height per line than the same phrase squeezed onto
// one. "COURT SWITCH" is 28px over two lines and 23px on one, and the two-line version is more
// than twice the ink. `msgbig` carries a single unsplittable word; `msg1`/`msg2` carry the pair.
// Whichever is unused is blanked, because the board retains section values between visits.
const MESSAGE_WIDTH = 186   // 192 less a 3px margin each side
const MESSAGE_ONE_MAX = 40  // a lone word can be enormous
const MESSAGE_TWO_MAX = 28  // two lines have to share 64px of panel

// Where to break a phrase so the two lines come out closest in width — a 2-word phrase has one
// candidate, a 3-word phrase two. Returns null when there is nothing to split.
function splitLines(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  let best = null
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    // Compare at a fixed nominal size; only the RATIO between the halves matters here.
    const diff = Math.abs(textWidth(a, 10) - textWidth(b, 10))
    if (!best || diff < best.diff) best = { a, b, diff }
  }
  return best
}

export function toMessageSections(text, { color = CLUB_GOLD } = {}) {
  const phrase = String(text || '').toUpperCase().trim()
  const split = splitLines(phrase)
  // Only split if two lines actually buy size. A short word pair like "TIME OUT" fits one line at
  // 40px and would LOSE height by being stacked at 28.
  const oneSize = fitFontSize(phrase, MESSAGE_WIDTH, { max: MESSAGE_ONE_MAX, min: 8 })
  const twoSize = split
    ? Math.min(
      fitFontSize(split.a, MESSAGE_WIDTH, { max: MESSAGE_TWO_MAX, min: 8 }),
      fitFontSize(split.b, MESSAGE_WIDTH, { max: MESSAGE_TWO_MAX, min: 8 }),
    )
    : 0
  const stacked = !!split && twoSize > oneSize
  const out = []
  const put = (name, value, size) => {
    out.push(attr(name, 'text', value), attr(name, 'color', color))
    if (value) out.push(attr(name, 'fontsize', size))
  }
  put('msgbig', stacked ? '' : phrase, oneSize)
  put('msg1', stacked ? split.a : '', twoSize)
  put('msg2', stacked ? split.b : '', twoSize)
  return out
}

// Returns the `value` array for a `SetSections` command. Each side is painted uniformly
// in its team colour — name, score, set count and score-box border all match — so the
// board never shows one team in three different reds.
//
// `matchFontMaxLeft`/`matchFontMaxRight` are the CEILING for each team name, not a fixed size: a
// short code keeps it, a long one steps down until it fits MATCH_NAME_WIDTH. The default of 18 is
// exactly the value baked into 02_volleyball_matchscore_02.xml, so leaving them alone paints what
// the layout always painted — the only behaviour change is that an over-long name now shrinks
// instead of running into the set counter.
//
// One per side rather than one shared number, because the two names are independent: the fitter
// already shrinks a long name on its own, so a shared ceiling only ever gets in the way of making
// a SHORT name bigger. "KSCW" can be 28 while the opponent sits at 9 to fit.
//
// These are physical sides, and toLeftRight() has already resolved side_a, so left always means
// the left half of the panel whichever team is on it.
export function toSections(state, { off = '30,30,30', totalTimeouts = TIMEOUT_MAX, totalSubs = SUB_MAX, matchFontMaxLeft = 18, matchFontMaxRight = 18 } = {}) {
  const v = toLeftRight(state)
  // Timeouts: red at the total, no amber (there are only a couple). Subs: amber one short,
  // red at the total.
  const toColor = (n) => limitColor(n, totalTimeouts, totalTimeouts)
  const subColor = (n) => limitColor(n, totalSubs - 1, totalSubs)
  return [
    ...text('team1', v.leftName, v.leftColor),
    attr('team1', 'fontsize', fitFontSize(v.leftName, MATCH_NAME_WIDTH, { max: matchFontMaxLeft })),
    ...text('team2', v.rightName, v.rightColor),
    attr('team2', 'fontsize', fitFontSize(v.rightName, MATCH_NAME_WIDTH, { max: matchFontMaxRight })),
    ...text('score1', v.leftPoints, v.leftColor),
    ...text('score2', v.rightPoints, v.rightColor),
    ...box('bg_score1', v.leftColor),
    ...box('bg_score2', v.rightColor),
    ...text('set1', v.leftSets, v.leftColor),
    ...text('set2', v.rightSets, v.rightColor),
    // `vs` is the tiny "-" separator between the two set counts. Always reassert it, so the
    // idle screen (which borrows it for "VS") can never leave a stray label on the scoreboard.
    attr('vs', 'text', '-'),
    ...text('timeout1', v.leftTimeouts, toColor(v.leftTimeouts)),
    ...text('timeout2', v.rightTimeouts, toColor(v.rightTimeouts)),
    ...text('sub1', v.leftSubs, subColor(v.leftSubs)),
    ...text('sub2', v.rightSubs, subColor(v.rightSubs)),
    // Serve indicators: light the serving side's rectangle in its team colour.
    ...rect('serve1', v.serving === 'left' ? v.leftColor : off),
    ...rect('serve2', v.serving === 'right' ? v.rightColor : off),
  ]
}
