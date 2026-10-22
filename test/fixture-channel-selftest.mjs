// The board's live score under its fixture: besides its own channel (team A = LEFT), a match whose
// game the board knows also goes to wiedisync's per-game row `game-<id>` (team A = HOME), which is
// where "Watch live" and the result prefill for Volleymanager read it. See src/liveFixture.js.
//
//   [1] the board's own channel: LIVE_CHANNEL wins; unset, the C0270 (and a generic host name)
//       stays 'kscw' and any other board gets its own; never a game-… channel
//   [2] homeSide / toHomeAway: names decide, ends_swapped only breaks a tie, unrelated names = no row
//   [3] HOME/AWAY projection with home standing on the RIGHT after the change of ends
//   [4] set_results re-sided over a whole 3:1 match, and the history row names its game
//   [5] link mode: an OpenVolley team A that is the AWAY team; one write per row per flush; a match
//       number the season does not know writes no fixture row
//   [6] unscheduled match → the board's channel only; names that are not the fixture's → no row
//   [7] a 0-0 board never reaches the fixture row (pre-match, the reset after the final)
//   [8] Directus refusing the fixture row: left alone for a while, the board row unaffected;
//       live_history refusing game_id: the row is sent again without it
//   [9] KSCW vs KSCW: the season copy holds the home team's row, and only that id is written
//  [10] end to end on a booted appliance: schedule start, change of ends, a hand-typed game, then a
//       linked OpenVolley match — which never borrows the game the board was set up for
// Needs the `ws` devDependency (npm install).

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { createLivePush, livePushFromEnv } from '../src/livePush.js'
import { boardChannel, fixtureOf, homeSide, toHomeAway } from '../src/liveFixture.js'
import { ManualSource } from '../src/manualSource.js'
import { SeasonSchedule, toSeasonGames } from '../src/seasonSchedule.js'
import { zurichDate, shortName } from '../src/schedule.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const HOME = 'KSC Wiedikon H3'
const AWAY = 'VBC Züri Unterland H2'
const GAME = { id: 9, home: HOME, away: AWAY, homeShort: shortName(HOME), awayShort: shortName(AWAY), number: '406300' }
const FIX = fixtureOf(GAME, { homeStartsLeft: true })

// A stub fetch that records every request and answers with `answer(call)` (default 200).
const realFetch = globalThis.fetch
let calls = []
function stubFetch(answer = () => 200) {
  calls = []
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') }
    calls.push(call)
    const status = answer(call)
    return { ok: status >= 200 && status < 300, status }
  }
}
const toChannel = (ch) => calls.filter((c) => c.url.endsWith(`/items/live_scores/${ch}`) || (c.method === 'POST' && c.url.endsWith('/items/live_scores') && c.body.channel === ch))
const lastTo = (ch) => toChannel(ch).at(-1)?.body
const history = () => calls.filter((c) => c.url.includes('live_history'))
const CFG = { url: 'https://directus.example', token: 'tok', channel: 'kscw', debounceMs: 5 }
const settle = () => sleep(40)
// The board shows names in capitals (name-case); the schedule has them as written.
const same = (x, y) => String(x ?? '').toUpperCase() === String(y ?? '').toUpperCase()

// The schedule start: home on the left, the schedule's names in.
function scheduledBoard(opts = {}) {
  const src = new ManualSource(opts)
  src.apply({ type: 'team', side: 'left', name: HOME, short: GAME.homeShort })
  src.apply({ type: 'team', side: 'right', name: AWAY, short: GAME.awayShort })
  return src
}
// Points to the HOME (or away) team, on whichever side it stands now.
const homeSideNow = (src) => (src.getState().ends_swapped ? 'right' : 'left')
const awaySideNow = (src) => (src.getState().ends_swapped ? 'left' : 'right')
const score = (src, side, n = 1) => { for (let i = 0; i < n; i++) src.apply({ type: 'point', side, delta: 1 }) }

console.log('\n[1] the board\'s own channel')
{
  ok(boardChannel({ LIVE_CHANNEL: 'kscw' }, 'ledbox-court2') === 'kscw', 'LIVE_CHANNEL set → that, whatever the host is called')
  ok(boardChannel({ LIVE_CHANNEL: 'court-1' }, 'ledbox-c0270') === 'court-1', 'an explicit channel wins on the C0270 too')
  ok(boardChannel({}, 'ledbox-c0270') === 'kscw' && boardChannel({}, 'ledbox-c0270.tail1234.ts.net') === 'kscw',
    'unset on the C0270 (its tailnet name) → kscw, as today')
  ok(['raspberrypi', 'ledbox', 'localhost', ''].every((h) => boardChannel({}, h) === 'kscw'), 'unset on a generic host name → kscw')
  ok(boardChannel({}, 'ledbox-court2') === 'ledbox-court2', 'unset on another board → its own channel (ledbox-court2)')
  ok(boardChannel({}, 'Court 2 (DIY)') === 'court-2-diy', 'derived from the host name in the characters /live accepts')
  ok(boardChannel({}, 'game-7') === 'board-game-7', 'a host name that looks like a game row is not taken as one')
  let refused = null
  const ch = boardChannel({ LIVE_CHANNEL: 'game-123' }, 'ledbox-c0270', { onRefused: (c) => { refused = c } })
  ok(ch === 'kscw' && refused === 'game-123', 'LIVE_CHANNEL=game-123 is refused (said) and the board keeps its own channel')
  const lp = livePushFromEnv({ DIRECTUS_URL: 'https://d.example', LIVE_PUBLISH_TOKEN: 't' }, 'volleyball', () => false, { hostname: 'ledbox-court2' })
  ok(lp.channel === 'ledbox-court2', `livePushFromEnv publishes to that channel (${lp.channel})`)
}

console.log('\n[2] homeSide / toHomeAway')
{
  const st = (a, b, extra = {}) => ({ team_a_name: a, team_a_short: '', team_b_name: b, team_b_short: '', ...extra })
  ok(homeSide(st(HOME, AWAY), FIX) === 'a', 'home on A')
  ok(homeSide(st(AWAY, HOME), FIX) === 'b', 'home on B')
  ok(homeSide({ team_a_short: 'KSCW H3', team_b_short: 'ZÜRI H2' }, FIX) === 'a', 'the short codes alone are enough')
  ok(homeSide(st('kscw h3', ''), FIX) === 'a', 'case and the club\'s "KSCW" short form do not matter; one side is enough')
  ok(homeSide(st('', 'VBC Zuri Unterland H2'), FIX) === 'a', 'accents do not matter (the away team on B → home on A)')
  ok(homeSide(st('Gäste', 'Heim', { ends_swapped: false }), FIX) === null,
    'names typed over the schedule\'s → null, even where ends_swapped would have an answer')
  ok(homeSide(st('', ''), FIX) === null, 'a blank board → null')
  const tie = { team_a_short: 'KSCW', team_b_short: 'KSCW' }
  const kscwBoth = fixtureOf({ id: 5, home: 'KSC Wiedikon D1', away: 'KSC Wiedikon D2', homeShort: 'KSCW', awayShort: 'KSCW' }, { homeStartsLeft: true })
  ok(homeSide({ ...tie, ends_swapped: false }, kscwBoth) === 'a' && homeSide({ ...tie, ends_swapped: true }, kscwBoth) === 'b',
    'names that fit both ways on a board set up from the game: ends_swapped breaks the tie')
  ok(homeSide({ ...tie, ends_swapped: true }, { ...kscwBoth, homeStartsLeft: false }) === null, '… but not for a linked match, whose A is anybody')

  const row = {
    sport: 'volleyball', status: 'live', side_a: 'left', period: 2,
    team_a_name: AWAY, team_a_short: 'ZÜRI H2', team_a_color: '#ef4444', team_b_name: HOME, team_b_short: 'KSCW H3', team_b_color: '#2563eb',
    points_a: 3, points_b: 5, sets_won_a: 0, sets_won_b: 1, timeouts_a: 1, timeouts_b: 0, subs_a: 2, subs_b: 4, fouls_a: 0, fouls_b: 0,
    serving_team: 'right', set_results: [{ a: 20, b: 25, dur: 1500 }],
  }
  const t = toHomeAway(row, 'b')
  ok(t.team_a_name === HOME && t.team_a_short === 'KSCW H3' && t.team_a_color === '#2563eb' && t.team_b_name === AWAY, 'names, shorts and colours swap')
  ok(t.points_a === 5 && t.points_b === 3 && t.sets_won_a === 1 && t.sets_won_b === 0, 'points and sets swap')
  ok(t.timeouts_a === 0 && t.timeouts_b === 1 && t.subs_a === 4 && t.subs_b === 2, 'timeouts and subs swap')
  ok(t.serving_team === 'left', 'the serve follows the team (B served → home is A now → left)')
  ok(t.set_results[0].a === 25 && t.set_results[0].b === 20 && t.set_results[0].dur === 1500, 'each set swaps and keeps its dur')
  ok(t.side_a === 'left' && t.status === 'live' && t.period === 2, 'the rest is untouched')
  ok(row.team_a_name === AWAY && row.set_results[0].a === 20, 'and the board row itself is not modified')
  ok(JSON.stringify(toHomeAway(row, 'a')) === JSON.stringify(row), "'a' leaves the row as it is")
}

console.log('\n[3] HOME/AWAY with home on the right after the change of ends')
{
  stubFetch()
  const lp = createLivePush({ ...CFG, fixture: () => FIX })
  const src = scheduledBoard()
  score(src, homeSideNow(src), 25) // set 1 to home 25-0
  src.apply({ type: 'next-set' }) // ends change: home is on the RIGHT now
  ok(src.getState().ends_swapped === true && same(src.getState().team_b_name, HOME), 'the board really has home on the right')
  score(src, homeSideNow(src), 5)
  score(src, awaySideNow(src), 3)
  src.apply({ type: 'timeout', side: awaySideNow(src), delta: 1 })
  lp.push(src.getState())
  await settle()
  const board = lastTo('kscw')
  const game = lastTo('game-9')
  ok(board && same(board.team_a_name, AWAY) && board.points_a === 3 && board.points_b === 5, `board row: A = left = away, 3-5 (${board?.team_a_name} ${board?.points_a}-${board?.points_b})`)
  ok(game && same(game.team_a_name, HOME) && same(game.team_b_name, AWAY), `fixture row: A = home (${game?.team_a_name})`)
  ok(game && game.points_a === 5 && game.points_b === 3 && game.sets_won_a === 1 && game.sets_won_b === 0, `fixture row: home 5-3, sets 1-0 (${game?.points_a}-${game?.points_b}, ${game?.sets_won_a}-${game?.sets_won_b})`)
  ok(game && game.timeouts_a === 0 && game.timeouts_b === 1, 'the away team\'s timeout is on B')
  ok(board.set_results[0].a === 0 && board.set_results[0].b === 25 && game.set_results[0].a === 25 && game.set_results[0].b === 0,
    'set 1: the board row has it by side (0-25), the fixture row by team (25-0)')
  const served = src.getState().serving_team === homeSideNow(src) ? 'home' : 'away'
  ok(game.serving_team === (served === 'home' ? 'left' : 'right'), `the serve dot is on the team that serves (${served})`)
  ok(game.game_id === 9 && game.source === 'board:kscw' && game.side_a === 'left', 'the fixture row names its game and the board writing it')
  lp.detach()
}

console.log('\n[4] set_results re-sided over a whole match, and the history row')
{
  stubFetch()
  const lp = createLivePush({ ...CFG, fixture: () => FIX })
  const src = scheduledBoard({ bestOf: 5 })
  const sets = [[25, 20], [18, 25], [25, 22], [25, 23]] // home first
  for (let i = 0; i < sets.length; i++) {
    const [h, a] = sets[i]
    // Interleaved so neither side closes the set early: the loser's points first, then the winner's.
    if (h > a) { score(src, homeSideNow(src), h - 2); score(src, awaySideNow(src), a); score(src, homeSideNow(src), 2) }
    else { score(src, awaySideNow(src), a - 2); score(src, homeSideNow(src), h); score(src, awaySideNow(src), 2) }
    lp.push(src.getState(), src.lastEvent)
    await settle()
    if (i < sets.length - 1) src.apply({ type: 'next-set' })
  }
  const fin = src.getState()
  ok(fin.sets_won_a + fin.sets_won_b === 4, `the board played four sets (${fin.sets_won_a}-${fin.sets_won_b})`)
  const game = lastTo('game-9')
  ok(game && game.status === 'final', 'the fixture row is final')
  ok(game && JSON.stringify(game.set_results.map((r) => [r.a, r.b])) === JSON.stringify(sets),
    `every set home-first on the fixture row (${JSON.stringify(game?.set_results.map((r) => [r.a, r.b]))})`)
  ok(game && game.sets_won_a === 3 && game.sets_won_b === 1, 'home won 3:1 on the fixture row')
  const board = lastTo('kscw')
  ok(board && JSON.stringify(board.set_results.map((r) => [r.a, r.b])) !== JSON.stringify(sets),
    'while the board row keeps them by side — which is why the fixture row must not be the board row')
  const hist = history()
  ok(hist.length === 1, `archived once (${hist.length})`)
  const h = hist[0]?.body
  ok(h && h.channel === 'kscw' && h.game_id === 9, 'the history row stays on the board\'s channel and names its game')
  ok(h && same(h.team_a_name, HOME) && h.sets_won_a === 3 && JSON.stringify(h.set_results.map((r) => [r.a, r.b])) === JSON.stringify(sets),
    'and is home/away like the fixture row')
  lp.detach()
}

console.log('\n[5] link mode')
{
  // An OpenVolley liveState: team A is whoever the scorer entered first (here the AWAY team),
  // `side_a` says where it stands and `serving_team` is PHYSICAL. No set_results.
  const ov = (o = {}) => ({
    team_a_name: AWAY, team_a_short: 'VZU', team_a_color: '#ef4444', team_b_name: HOME, team_b_short: 'KSCW', team_b_color: '#2563eb',
    points_a: 7, points_b: 9, sets_won_a: 0, sets_won_b: 1, side_a: 'right', serving_team: 'left', current_set: 2,
    timeouts_a: [], timeouts_b: [{}], game_n: '406300', match_status: 'in_progress', ...o,
  })
  const linked = fixtureOf(GAME, { homeStartsLeft: false })
  stubFetch()
  const lp = createLivePush({ ...CFG, fixture: (s) => (String(s.game_n) === GAME.number ? linked : null) })
  lp.push(ov())
  await settle()
  const game = lastTo('game-9')
  ok(game && game.team_a_name === HOME && game.points_a === 9 && game.points_b === 7 && game.sets_won_a === 1,
    `OpenVolley's team B (home) is A on the fixture row, 9-7 (${game?.team_a_name} ${game?.points_a}-${game?.points_b})`)
  // Physical left serves; A stands right, so B (home) serves.
  ok(game && game.serving_team === 'left' && game.timeouts_a === 1, 'the serve and the timeouts follow the team')
  ok(game && game.period === 2 && Array.isArray(game.set_results) && game.set_results.length === 0, 'the set from current_set; no set results invented')

  // A burst on the relay → one write per row, never two of the same row in one round.
  stubFetch()
  for (let p = 10; p < 15; p++) lp.push(ov({ points_b: p }))
  await settle()
  ok(toChannel('kscw').length === 1 && toChannel('game-9').length === 1, `5 relay frames → 1 board write + 1 fixture write (${toChannel('kscw').length} + ${toChannel('game-9').length})`)
  ok(lastTo('game-9').points_a === 14, 'carrying the latest frame')
  ok(calls.every((c) => c.url.endsWith('/kscw') || c.url.endsWith('/game-9')), 'and nothing else is written')

  // A linked match the season copy does not know: the board's own channel, as before.
  stubFetch()
  lp.push(ov({ game_n: '999999', points_a: 1, points_b: 0 }))
  await settle()
  ok(toChannel('kscw').length === 1 && !calls.some((c) => c.url.includes('game-')), 'an unknown match number writes no fixture row')
  lp.detach()
}

console.log('\n[6] unscheduled → the board\'s channel only')
{
  stubFetch()
  const lp = createLivePush(CFG) // no fixture at all: a hand-typed game
  const src = new ManualSource()
  src.apply({ type: 'team', side: 'left', name: 'Heim', short: 'HEIM' })
  score(src, 'left', 25); src.apply({ type: 'next-set' })
  score(src, 'right', 25); src.apply({ type: 'next-set' })
  score(src, 'left', 25)
  lp.push(src.getState(), src.lastEvent)
  await settle()
  ok(calls.length >= 2 && calls.every((c) => c.url.endsWith('/items/live_scores/kscw') || c.url.endsWith('/items/live_history')), 'only the board row (and its history)')
  ok(history().length === 1 && !('game_id' in history()[0].body), 'the history row names no game')
  lp.detach()

  // The fixture is known but the board shows other teams (typed over, or already the next game).
  stubFetch()
  const lp2 = createLivePush({ ...CFG, fixture: () => FIX })
  const other = new ManualSource()
  other.apply({ type: 'team', side: 'left', name: 'Damen 1', short: 'D1' })
  other.apply({ type: 'team', side: 'right', name: 'Gäste', short: 'GAST' })
  score(other, 'left', 3)
  lp2.push(other.getState())
  await settle()
  ok(toChannel('kscw').length === 1 && !calls.some((c) => c.url.includes('game-')), 'names that are not the fixture\'s → no fixture row')
  lp2.detach()
}

console.log('\n[7] a 0-0 board never reaches the fixture row')
{
  stubFetch()
  const lp = createLivePush({ ...CFG, fixture: () => FIX })
  const src = scheduledBoard()
  lp.push(src.getState()) // the pre-match: names in, 0-0
  await settle()
  ok(toChannel('kscw').length === 1 && toChannel('game-9').length === 0, 'the pre-match is on the board row, not on the game\'s')
  score(src, 'left', 25); src.apply({ type: 'next-set' }); score(src, homeSideNow(src), 25); src.apply({ type: 'next-set' }); score(src, homeSideNow(src), 25)
  lp.push(src.getState(), src.lastEvent)
  await settle()
  ok(lastTo('game-9')?.status === 'final', 'the final reaches the fixture row')
  const finals = toChannel('game-9').length
  src.apply({ type: 'reset' })
  lp.push(src.getState())
  score(src, 'left', 0)
  src.apply({ type: 'team', side: 'left', name: HOME, short: GAME.homeShort })
  src.apply({ type: 'team', side: 'right', name: AWAY, short: GAME.awayShort })
  lp.push(src.getState()) // the same teams again, at 0-0
  await settle()
  ok(toChannel('game-9').length === finals && lastTo('game-9').status === 'final', 'a reset (and the same names at 0-0) leaves the final result standing')
  lp.detach()
}

console.log('\n[8] refusals')
{
  // Directus has not opened game-* rows to the board's token: PATCH 403 (not there / not visible),
  // POST 403 (create pinned to the board's channel).
  let refuse = true
  stubFetch((c) => (refuse && c.url.includes('game-') ? 403 : refuse && c.body.channel === 'game-9' ? 403 : 200))
  const lp = createLivePush({ ...CFG, fixture: () => FIX, refusedMs: 400 })
  const src = scheduledBoard()
  score(src, 'left', 1); lp.push(src.getState()); await settle()
  const first = toChannel('game-9').map((c) => c.method).join(',')
  ok(first === 'PATCH,POST', `a 403 on the PATCH tries to create the row (${first})`)
  for (let i = 0; i < 4; i++) { score(src, 'left', 1); lp.push(src.getState()); await settle() }
  ok(toChannel('game-9').length === 2, `refused once → left alone for the next points (${toChannel('game-9').length} requests)`)
  ok(toChannel('kscw').length === 5 && lastTo('kscw').points_a === 5, 'while the board row carries every point')
  refuse = false
  await sleep(400)
  score(src, 'left', 1); lp.push(src.getState()); await settle()
  ok(lastTo('game-9')?.points_a === 6, 'after the pause it is tried again — and lands once Directus lets it')
  lp.detach()

  // A row Directus does not have yet is created; afterwards it is PATCHed.
  let exists = false
  stubFetch((c) => {
    if (c.url.endsWith('/game-9')) return exists ? 200 : 403
    if (c.method === 'POST' && c.body.channel === 'game-9') { exists = true; return 200 }
    return 200
  })
  const lp2 = createLivePush({ ...CFG, fixture: () => FIX })
  const s2 = scheduledBoard()
  score(s2, 'left', 1); lp2.push(s2.getState()); await settle()
  score(s2, 'left', 1); lp2.push(s2.getState()); await settle()
  ok(toChannel('game-9').map((c) => c.method).join(',') === 'PATCH,POST,PATCH', 'created on the first point, updated on the next')
  ok(calls.find((c) => c.method === 'POST' && c.body.channel === 'game-9')?.body.game_id === 9, 'the created row carries its channel and game_id')
  lp2.detach()

  // live_history that does not take game_id (yet): the result still lands, once.
  stubFetch((c) => (c.url.includes('live_history') && 'game_id' in c.body ? 400 : 200))
  const lp3 = createLivePush({ ...CFG, fixture: () => FIX })
  const s3 = scheduledBoard()
  score(s3, 'left', 25); s3.apply({ type: 'next-set' }); score(s3, homeSideNow(s3), 25); s3.apply({ type: 'next-set' }); score(s3, homeSideNow(s3), 25)
  lp3.push(s3.getState(), s3.lastEvent)
  await settle()
  const h = history()
  ok(h.length === 2 && 'game_id' in h[0].body && !('game_id' in h[1].body), 'a 400 with game_id → sent once more without it')
  ok(same(h[1].body.team_a_name, HOME) && h[1].body.sets_won_a === 3, 'the same result')
  score(s3, homeSideNow(s3), 1); lp3.push(s3.getState()); await settle()
  ok(history().length === 2, 'and archived for good: nothing more on the next push')
  lp3.detach()
}

console.log('\n[9] KSCW vs KSCW')
{
  const T = zurichDate()
  const derby = { game_id: 'vb_512000', date: T, time: '20:00:00', home_team: 'KSC Wiedikon H1', away_team: 'KSC Wiedikon H3', status: 'scheduled', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } }
  // One row per team; the fetch asks for type 'home', and a stray copy of each kind must not double it.
  const copy = toSeasonGames([{ ...derby, id: 41, type: 'home' }, { ...derby, id: 42, type: 'away' }, { ...derby, id: 43, type: 'home' }])
  ok(copy.length === 1 && copy[0].id === 41, `the season copy holds one game, the home team's row (${copy.map((g) => g.id)})`)
  const season = new SeasonSchedule({ now: () => Date.now() })
  season.games = copy
  ok(season.gameByNumber('512000')?.id === 41 && season.gameByNumber('vb_512000')?.id === 41, 'a linked match maps to it by number, with or without the prefix')
  ok(season.gameByNumber('') === null && season.gameByNumber(null) === null, 'no number, no game')
  const fx = fixtureOf(copy[0], { homeStartsLeft: true })
  stubFetch()
  const lp = createLivePush({ ...CFG, fixture: () => fx })
  const src = new ManualSource()
  src.apply({ type: 'team', side: 'left', name: 'KSC Wiedikon H1', short: copy[0].homeShort })
  src.apply({ type: 'team', side: 'right', name: 'KSC Wiedikon H3', short: copy[0].awayShort })
  score(src, 'left', 25); src.apply({ type: 'next-set' })
  score(src, homeSideNow(src), 2)
  lp.push(src.getState())
  await settle()
  const games = [...new Set(calls.filter((c) => c.url.includes('game-') || c.body.channel?.startsWith?.('game-')).map((c) => c.url.split('/').pop()))]
  ok(games.length === 1 && games[0] === 'game-41', `one fixture row, the home team's (${games})`)
  ok(same(lastTo('game-41')?.team_a_name, 'KSC Wiedikon H1') && lastTo('game-41')?.points_a === 2, 'H1 (home) is A although it stands on the right')
  lp.detach()

  // The window around the board's date, and cancelled games.
  const far = new SeasonSchedule({ now: () => Date.now() })
  far.games = toSeasonGames([
    { ...derby, id: 50, type: 'home', game_id: 'vb_1', date: '2020-01-01' },
    { ...derby, id: 51, type: 'home', game_id: 'vb_2', status: 'cancelled', time: '18:00' },
  ])
  ok(far.gameByNumber('1') === null, 'a game far from the board\'s date is not this match')
  ok(far.gameByNumber('2') === null, 'nor is a cancelled one')
}

console.log('\n[10] end to end on a booted appliance')
{
  globalThis.fetch = realFetch // the appliance talks to the fake Directus below for real
  const T = zurichDate()
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
  const GAMES = [
    { id: 9, game_id: 'vb_406300', date: T, time: hm + ':00', type: 'home', home_team: HOME, away_team: AWAY, status: 'scheduled', league: '2. Liga', kscw_team: { sport: 'volleyball' }, hall: { name: 'KWI A' } },
  ]
  // A fake Directus: the games, and every write recorded. A game row nobody has written answers
  // a PATCH with 403, the way Directus does.
  const rows = new Map()
  const writes = []
  const directus = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (req.url.startsWith('/items/games')) return json(200, { data: GAMES })
      const data = body ? JSON.parse(body) : {}
      const m = /^\/items\/live_scores(?:\/([^?]+))?/.exec(req.url)
      if (m) {
        const ch = m[1] ? decodeURIComponent(m[1]) : data.channel
        writes.push({ method: req.method, channel: ch, body: data })
        if (req.method === 'PATCH' && !rows.has(ch)) return json(ch === 'kscw' ? 404 : 403, { errors: [] })
        rows.set(ch, { ...(rows.get(ch) || {}), ...data })
        return json(200, { data: rows.get(ch) })
      }
      if (req.url.startsWith('/items/live_history')) { writes.push({ method: 'POST', channel: 'history', body: data }); return json(200, { data }) }
      return json(200, { data: {} })
    })
  })
  await new Promise((r) => directus.listen(0, '127.0.0.1', r))

  // An OpenVolley relay (backend/server.js --local shape) for the linked part.
  const SEED = 'match_1760000000000_fx01'
  let lastLive = null
  const relay = http.createServer((req, res) => {
    if (req.url === '/api/match/list') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: true, matches: [{ id: SEED, gameNumber: 406300, status: 'live' }] })) }
    if (req.url === '/api/server/status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'online', mode: 'local', wsPort: relay.address().port })) }
    res.writeHead(404); res.end('')
  })
  const wss = new WebSocketServer({ server: relay })
  const subs = new Set()
  wss.on('connection', (ws) => {
    ws.on('message', (buf) => {
      const msg = JSON.parse(String(buf))
      if (msg.type === 'subscribe-match' && msg.matchId === SEED) {
        subs.add(ws)
        ws.send(JSON.stringify({ type: 'match-full-data', matchId: SEED, access: 'summary', data: lastLive ? { liveState: lastLive } : {} }))
      }
    })
    ws.on('close', () => subs.delete(ws))
  })
  await new Promise((r) => relay.listen(0, '127.0.0.1', r))
  const live = (o) => {
    lastLive = {
      team_a_name: AWAY, team_a_short: 'VZU', team_a_color: '#ef4444', team_b_name: HOME, team_b_short: 'KSCW', team_b_color: '#2563eb',
      points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left', current_set: 1,
      timeouts_a: [], timeouts_b: [], subs_a: null, subs_b: null, match_status: 'in_progress', game_n: '406300', ...o,
    }
    for (const ws of subs) ws.send(JSON.stringify({ type: 'live-state-update', matchId: SEED, liveState: lastLive }))
  }

  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-fixture-'))
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ sport: 'volleyball', autoPrepare: false, liveScoring: 'kscw' }))
  const saved = { url: process.env.DIRECTUS_URL, tok: process.env.LIVE_PUBLISH_TOKEN, ch: process.env.LIVE_CHANNEL }
  let app = null
  try {
    process.env.DIRECTUS_URL = `http://127.0.0.1:${directus.address().port}`
    process.env.LIVE_PUBLISH_TOKEN = 'tok'
    process.env.LIVE_CHANNEL = 'kscw'
    app = await startAppliance({
      stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
      reconnectMs: 200, mock: false, controlPort: 0, debug: false,
      uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = async (route, body) => {
      const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body || {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const act = (action) => post('/api/action', { action })
    const to = (ch) => writes.filter((w) => w.channel === ch)
    const last = (ch) => to(ch).at(-1)?.body
    const wait = () => sleep(400)
    ok(app.livePush.channel === 'kscw', 'the appliance publishes to kscw')
    await (await fetch(base + '/api/schedule?range=season')).json() // the season copy, before the tap

    // The console's schedule tap: home on the left, the game's id along.
    let r = await post('/api/game', { choice: 'new', teams: { left: { name: HOME, short: GAME.homeShort }, right: { name: AWAY, short: GAME.awayShort } }, prematch: true, gameId: 9 })
    ok(r.status === 200 && r.body.gameId === 9, 'a game started from the schedule')
    await wait()
    ok(to('game-9').length === 0, 'the pre-match does not touch the game\'s row')
    await act({ type: 'point', side: 'left', delta: 1 }); await wait()
    ok(to('game-9').map((w) => w.method).join(',') === 'PATCH,POST', `the first point creates game-9 (${to('game-9').map((w) => w.method)})`)
    ok(same(last('game-9')?.team_a_name, HOME) && last('game-9')?.points_a === 1 && last('game-9')?.game_id === 9 && last('game-9')?.source === 'board:kscw', 'home 1-0, game_id 9, from board:kscw')
    ok(last('kscw')?.points_a === 1 && last('kscw')?.game_id === undefined, 'the board row as always — no game_id on it')
    await act({ type: 'swap' }); await act({ type: 'point', side: 'left', delta: 1 }); await act({ type: 'point', side: 'left', delta: 1 }); await wait()
    ok(same(last('kscw')?.team_a_name, AWAY) && last('kscw')?.points_a === 2, 'after the swap the board row has the away team on A (2-1)')
    ok(same(last('game-9')?.team_a_name, HOME) && last('game-9')?.points_a === 1 && last('game-9')?.points_b === 2, 'the game row still has home on A (1-2)')

    // A hand-typed game: the board's channel only.
    const before = to('game-9').length
    r = await post('/api/game', { choice: 'new', teams: { left: { name: 'Heim', short: 'HEIM' }, right: { name: 'Gast', short: 'GAST' } } })
    ok(r.status === 200 && r.body.gameId == null, 'a hand-typed game has no game id')
    await act({ type: 'point', side: 'left', delta: 1 }); await wait()
    ok(same(last('kscw')?.team_a_name, 'Heim') && to('game-9').length === before && !writes.some((w) => /^game-(?!9$)/.test(w.channel || '')), 'unscheduled: kscw only, game-9 untouched')

    // The schedule game again, then a LINKED match that is a different one: the link never borrows it.
    r = await post('/api/game', { choice: 'new', teams: { left: { name: HOME, short: GAME.homeShort }, right: { name: AWAY, short: GAME.awayShort } }, prematch: true, gameId: 9 })
    await post('/api/settings', { relayAddress: `127.0.0.1:${relay.address().port}` })
    live({ game_n: '777777', team_a_name: HOME, team_b_name: AWAY, points_a: 4, points_b: 2 })
    r = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(r.status === 200 && r.body.mode === 'lan', `linked (${r.status} ${r.body?.mode})`)
    await wait()
    live({ game_n: '777777', team_a_name: HOME, team_b_name: AWAY, points_a: 5, points_b: 2 }); await wait()
    ok(last('kscw')?.points_a === 5 && to('game-9').length === before, 'a linked match the season does not know: kscw only — not the game the board was set up for')

    // The linked match IS game 9, with OpenVolley's team A the away team.
    live({ points_a: 3, points_b: 6, sets_won_b: 1, current_set: 2, side_a: 'right', serving_team: 'right' }); await wait()
    ok(last('game-9')?.team_a_name === HOME && last('game-9')?.points_a === 6 && last('game-9')?.points_b === 3 && last('game-9')?.sets_won_a === 1,
      `linked by match number: home on A, 6-3, sets 1-0 (${last('game-9')?.team_a_name} ${last('game-9')?.points_a}-${last('game-9')?.points_b})`)
    ok(last('game-9')?.serving_team === 'right', 'OpenVolley team A (away) serving from the right → the away dot')
    ok(last('kscw')?.team_a_name === AWAY && last('kscw')?.points_a === 3, 'the board row mirrors OpenVolley as before (A = its team A)')
    const perFlush = to('game-9').slice(before)
    ok(perFlush.every((w) => w.method === 'PATCH'), 'one PATCH per change — no second writer, no re-create')
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await mock.close()
    for (const ws of subs) ws.terminate()
    wss.close()
    await new Promise((r) => { relay.closeAllConnections?.(); relay.close(r) })
    await new Promise((r) => { directus.closeAllConnections?.(); directus.close(r) })
    for (const [k, v] of [['DIRECTUS_URL', saved.url], ['LIVE_PUBLISH_TOKEN', saved.tok], ['LIVE_CHANNEL', saved.ch]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

globalThis.fetch = realFetch
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
