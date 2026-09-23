// Sport registry — the ONE place the three sports differ. The control API, SourceManager and
// LedboxClient are all sport-agnostic: every sport speaks the same a/b liveState contract and the
// same action verbs (point/set/timeout/sub/serve/swap/team/next-set/…), just with sport-specific
// meaning (basketball: point=+1/+2/+3, sub=team foul, set=period, next-set=end quarter). So a
// sport is fully described by three things: its scoring Source, its board layout names, and the
// state→sections mapper for the match screen (plus that layout's own idle fallback). Everything
// else (crest/countdown/break/result/message) reuses the proven volleyball path, so switching sport
// can't destabilise those screens.
//
// Volleyball is the default and the shape the other rows mirror. To add a sport: add a row here
// and its key to settings.js SPORTS.
//
// Two optional flags let a row opt OUT of what only makes sense for a real match (both default on):
//   history:  false — nothing it scores goes into the match log (History tab / export).
//   livePush: false — never published to the club's /live page, whatever Settings says.

import { ManualSource } from './manualSource.js'
import { BeachSource } from './beachSource.js'
import { BasketballSource } from './basketballSource.js'
import { SimpleSource } from './simpleSource.js'
import * as volley from './volleyballMapper.js'
import { toBeachSections, toBeachIdleSections } from './beachMapper.js'
import { toBasketballSections, toBasketballIdleSections } from './basketballMapper.js'
import { toSimpleSections, toSimpleIdleSections } from './simpleMapper.js'

// The full mapper surface LedboxClient paints through. Beach and basketball differ from volleyball
// in the match screen (toSections) AND in toIdleSections — the pre-match names screen showIdle
// paints onto the MATCH layout when the board has no kscw_idle/kscw_crest. That fallback writes the
// match layout's own sections, and the indoor one names sub1/sub2/set1/… that the beach and
// basketball layouts do not have: the board rejects the whole write on the first unknown section,
// so with the volleyball mapper there the fallback never painted at all. Crest / countdown / break
// / result / message stay the volleyball ones (their layouts are shared, see IDLE_LAYOUTS below).
const volleyMapper = {
  toSections: volley.toSections,
  toCountdownSections: volley.toCountdownSections,
  toIdleSections: volley.toIdleSections,
  toClubIdleSections: volley.toClubIdleSections,
  toBreakSections: volley.toBreakSections,
  toResultSections: volley.toResultSections,
  toMessageSections: volley.toMessageSections,
  toLeftRight: volley.toLeftRight,
}

// The kscw idle + crest layouts are sport-neutral (crest + team names), so every sport uses the
// hardware-proven volleyball idle screens when the board has them. Only the match layout — and the
// idle fallback painted onto it — is sport-specific.
// The result and announcement screens are sport-neutral too — a winner, a score and a list of
// periods reads the same whatever produced them, and a change of ends is a change of ends — so
// they ride along with the idle layouts.
const IDLE_LAYOUTS = {
  idleLayout: 'kscw_idle', crestLayout: 'kscw_crest', clockLayout: 'kscw_clock',
  resultLayout: 'kscw_result', messageLayout: 'kscw_message',
}

export const SPORTS = {
  volleyball: {
    key: 'volleyball',
    label: 'Volleyball',
    Source: ManualSource,
    layouts: { layout: 'volleyball_matchscore_02', ...IDLE_LAYOUTS },
    mapper: volleyMapper,
  },
  beach: {
    key: 'beach',
    label: 'Beach volleyball',
    Source: BeachSource,
    layouts: { layout: 'beach_matchscore', ...IDLE_LAYOUTS },
    mapper: { ...volleyMapper, toSections: toBeachSections, toIdleSections: toBeachIdleSections },
  },
  basketball: {
    key: 'basketball',
    label: 'Basketball',
    Source: BasketballSource,
    layouts: { layout: 'basketball_matchscore', ...IDLE_LAYOUTS },
    mapper: { ...volleyMapper, toSections: toBasketballSections, toIdleSections: toBasketballIdleSections },
  },
  // Not a sport — the fallback for everything that isn't one of the three above. Two numbers, no
  // rules. It borrows volleyball's LAYOUT as well as its idle screens (see simpleMapper.js: the
  // stock layout can express "two numbers" by blanking what it isn't using, and a new layout file
  // would have to be installed on the device by hand before this sport could be used at all).
  // Its own idle fallback, though: the indoor one puts the layout's "T" / "S" captions back, and
  // here they would label two counters this sport does not have.
  //
  // No history and no live publishing. A match log entry is written when a match ENDS, and this
  // one never does — so its points would sit in the history buffer until a Reset threw them away,
  // and meanwhile hold the clock sync off as "a match mid-record" for the rest of the evening. And
  // the /live page only knows sports; two bare numbers would be published there as a volleyball
  // match that never finishes.
  simple: {
    key: 'simple',
    label: 'Simple scoreboard',
    Source: SimpleSource,
    layouts: { layout: 'volleyball_matchscore_02', ...IDLE_LAYOUTS },
    mapper: { ...volleyMapper, toSections: toSimpleSections, toIdleSections: toSimpleIdleSections },
    history: false,
    livePush: false,
  },
}

export const DEFAULT_SPORT = 'volleyball'
export const SPORT_KEYS = Object.keys(SPORTS)
// [{ key, label }] for the control UI's sport picker.
export const SPORT_LIST = SPORT_KEYS.map((k) => ({ key: k, label: SPORTS[k].label }))

// Never return undefined — an unknown/absent key falls back to the default so a bad setting
// can never leave the appliance without a source at boot.
export function getSport(key) {
  return SPORTS[key] || SPORTS[DEFAULT_SPORT]
}
