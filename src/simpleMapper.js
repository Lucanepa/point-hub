// "Simple scoreboard" match screen — two white numbers on the volleyball layout.
//
// It targets `volleyball_matchscore_02`, the layout already on every board, rather than a new
// layout file. Custom layouts have to be written onto the device by hand (see STATUS.md), so a new
// one would make this sport undeployable until someone does that; the stock layout can express
// "two numbers" perfectly well by blanking what it is not using.
//
// That blanking is the load-bearing part. Sections are device state, not a paint list: whatever
// was last written to `set1` STAYS on the panel until something overwrites it. So switching from
// volleyball to simple without clearing them would leave the previous match's set score, timeout
// and substitution counts sitting on the board with no way to reach them from this sport's UI.
// Every section the layout owns is therefore written on every paint, even the ones being emptied.
//
// The flip side: the firmware keeps a layout's section values in memory for as long as it runs,
// across layout switches and across a restart of the bridge. The captions this mapper empties are
// ones the other sports never used to write, because the layout file already says "T" and "S" —
// so after an evening on this sport, volleyball came back with its two counters unlabelled until
// the panel itself was power-cycled. Every mapper on a layout with static captions now writes them
// on every paint (LAYOUT_LABELS in volleyballMapper.js, and the beach and basketball equivalents), the same way `vs` always was.
//
// White throughout, by definition of the sport — the operator picks no colours, so nothing here
// reads a team colour.

import { fitFontSize } from './volleyballMapper.js'

const attr = (name, attrib, value) => ({ name, value: { attrib, value: String(value) } })
const text = (name, value, color) =>
  color ? [attr(name, 'text', value), attr(name, 'color', color)] : [attr(name, 'text', value)]

const WHITE = '255,255,255'
// The panel's "off". Not black-as-a-colour: these are the serve rectangles, and this is the value
// the volleyball mapper uses for an unlit one, so an unused indicator looks identically dark
// whichever sport last painted it.
const OFF = '30,30,30'
// bg_score1/2 are the boxes behind the big numbers. Filling AND bordering them black makes them
// disappear, so the panel shows two floating numbers rather than two outlined cells. They still
// have to be written: the layout's own default is a coloured border, and the volleyball mapper
// leaves them in the last match's team colours.
const INVISIBLE_BOX = '0,0,0'

// Same box the volleyball match screen fits names into.
const NAME_WIDTH = 86

const upper = (s) => String(s || '').toUpperCase()

// Names are optional here in a way they are not in the other sports: `toLeftRight` substitutes
// 'TEAM A' / 'TEAM B' for empty names, which is right for a match and wrong for a scoreboard
// someone put up to count two numbers. Empty stays empty, so the operator gets exactly the board
// they asked for — and this is why the mapper reads the state directly instead of reusing it.
export function toSimpleSections(state, { matchFontMaxLeft = 18, matchFontMaxRight = 18 } = {}) {
  const s = state || {}
  const isALeft = (s.side_a || 'left') === 'left'
  const pick = (a, b) => (isALeft ? a : b)
  const leftName = upper(pick(s.team_a_short || s.team_a_name, s.team_b_short || s.team_b_name))
  const rightName = upper(pick(s.team_b_short || s.team_b_name, s.team_a_short || s.team_a_name))
  const leftPoints = Number(pick(s.points_a, s.points_b)) || 0
  const rightPoints = Number(pick(s.points_b, s.points_a)) || 0

  return [
    ...text('team1', leftName, WHITE),
    attr('team1', 'fontsize', fitFontSize(leftName || ' ', NAME_WIDTH, { max: matchFontMaxLeft })),
    ...text('team2', rightName, WHITE),
    attr('team2', 'fontsize', fitFontSize(rightName || ' ', NAME_WIDTH, { max: matchFontMaxRight })),
    ...text('score1', leftPoints, WHITE),
    ...text('score2', rightPoints, WHITE),
    attr('bg_score1', 'color', INVISIBLE_BOX), attr('bg_score1', 'bordercolor', INVISIBLE_BOX),
    attr('bg_score2', 'color', INVISIBLE_BOX), attr('bg_score2', 'bordercolor', INVISIBLE_BOX),
    // Everything below is emptied, not skipped — see the header. `lbl_to` and `lbl_sub` are the
    // layout's own static "T" and "S" captions; left alone they would label two blank counters.
    ...text('set1', '', WHITE),
    ...text('set2', '', WHITE),
    attr('vs', 'text', ''),
    ...text('timeout1', '', WHITE),
    ...text('timeout2', '', WHITE),
    ...text('sub1', '', WHITE),
    ...text('sub2', '', WHITE),
    attr('lbl_to', 'text', ''),
    attr('lbl_sub', 'text', ''),
    attr('serve1', 'color', OFF),
    attr('serve2', 'color', OFF),
  ]
}

// Pre-match screen on the same layout — what showIdle falls back to on a board without the KSCW
// idle layouts. Not the indoor toIdleSections: that one substitutes HOME / AWAY for empty names
// and puts the layout's "T" / "S" captions back, and neither belongs on this sport's board. The
// names (as typed, empty allowed) with "VS" between them when there are two to set apart; every
// number, caption and box dark.
export function toSimpleIdleSections(state) {
  const s = state || {}
  const isALeft = (s.side_a || 'left') === 'left'
  const pick = (a, b) => (isALeft ? a : b)
  const leftName = upper(pick(s.team_a_short || s.team_a_name, s.team_b_short || s.team_b_name))
  const rightName = upper(pick(s.team_b_short || s.team_b_name, s.team_a_short || s.team_a_name))
  return [
    ...text('team1', leftName, WHITE),
    ...text('team2', rightName, WHITE),
    ...text('score1', '', WHITE),
    ...text('score2', '', WHITE),
    attr('bg_score1', 'color', INVISIBLE_BOX), attr('bg_score1', 'bordercolor', INVISIBLE_BOX),
    attr('bg_score2', 'color', INVISIBLE_BOX), attr('bg_score2', 'bordercolor', INVISIBLE_BOX),
    ...text('set1', ''), ...text('set2', ''),
    attr('vs', 'text', leftName && rightName ? 'VS' : ''),
    ...text('timeout1', ''), ...text('timeout2', ''),
    ...text('sub1', ''), ...text('sub2', ''),
    attr('lbl_to', 'text', ''),
    attr('lbl_sub', 'text', ''),
    attr('serve1', 'color', OFF),
    attr('serve2', 'color', OFF),
  ]
}
