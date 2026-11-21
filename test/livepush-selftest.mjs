// Proof for the wiedisync /live publisher: the sport-specific field mapping, the
// debounce/coalesce behaviour, the 404 self-heal, and — most importantly — that a
// broken Directus can never throw into the scoring path.
//
// No network: a stub `fetch` records every request.

import { createLivePush, toRow } from '../src/livePush.js'
import { ManualSource } from '../src/manualSource.js'
import { BeachSource } from '../src/beachSource.js'
import { BasketballSource } from '../src/basketballSource.js'
import { SourceManager } from '../src/sourceManager.js'
import { LinkedView } from '../src/linkedView.js'
import { fixtureOf } from '../src/liveFixture.js'

let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const realFetch = globalThis.fetch
let calls = []
function stubFetch(handler) {
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') })
    return handler ? handler(calls.length) : { ok: true, status: 200, text: async () => '' }
  }
}

const CFG = { url: 'https://directus.example/', token: 'tok', channel: 'kscw', debounceMs: 5 }

// ── 1. toRow: volleyball ─────────────────────────────────────────────────────
console.log('\ntoRow — volleyball')
{
  const vb = new ManualSource()
  vb.apply({ type: 'team', side: 'left', short: 'KSCW' })
  vb.apply({ type: 'point', side: 'left', value: 23 })
  vb.apply({ type: 'sub', side: 'left', value: 3 })
  const row = toRow(vb.getState(), null, 'volleyball')
  assert(row.sport === 'volleyball', 'sport is volleyball')
  assert(row.status === 'live', 'a played board is live')
  assert(row.points_a === 23, 'points carried')
  assert(row.subs_a === 3, 'volleyball keeps subs in subs_a')
  assert(row.fouls_a === 0, 'volleyball reports no fouls')
  assert(row.period === 1, 'period is the set being played')
  assert(row.over === false, 'not over at 0 sets')
}

// ── 1b. a finished match reports the last set played, not a set 4 that never happened ──
console.log('\ntoRow — volleyball final')
{
  const vb = new ManualSource({ bestOf: 5 })
  for (let set = 0; set < 3; set++) {
    // Scored on whichever side team A stands after the change of ends, so this really is 3:0.
    const side = vb.getState().ends_swapped ? 'right' : 'left'
    for (let p = 0; p < 25; p++) vb.apply({ type: 'point', side, delta: 1 })
    if (set < 2) vb.apply({ type: 'next-set' })
  }
  const st = vb.getState()
  const mid = toRow({ ...st, set_results: st.set_results.slice(0, 2), sets_won_a: 2 }, null, 'volleyball')
  assert(mid.period === 3, 'mid-match the set being played is results + 1')
  const row = toRow(st, 'match-end', 'volleyball')
  assert(row.status === 'final' && toRow(st, null, 'volleyball').status === 'final', '3:0 is final (from the state, not only the event)')
  assert(row.period === 3, 'a 3:0 final reports set 3, not set 4')
}

// ── 1b'. 'final' follows the format the operator picked, not a fixed best-of-5 / best-of-3 ──
console.log('\ntoRow — final in the picked format')
{
  // Plays `sets` sets to team A, scoring on whichever side it stands after each change of ends.
  const win = (src, sets, target) => {
    for (let set = 0; set < sets; set++) {
      const side = src.getState().ends_swapped ? 'right' : 'left'
      for (let p = 0; p < target; p++) src.apply({ type: 'point', side, delta: 1 })
      if (set < sets - 1) src.apply({ type: 'next-set' })
    }
    return src.getState()
  }
  const vb3 = win(new ManualSource({ bestOf: 3 }), 2, 25)
  assert(vb3.sets_to_win === 2, 'a best-of-3 indoor board reports sets_to_win 2')
  const later = toRow(vb3, null, 'volleyball')
  assert(toRow(vb3, 'match-end', 'volleyball').status === 'final' && later.status === 'final',
    'best-of-3 indoor won 2:0 stays final on a later emit with no event')
  assert(later.period === 2, 'and reports set 2, not a set 3 that never happened')

  const bh5 = new BeachSource({ bestOf: 5 })
  const two = win(bh5, 2, 21)
  assert(two.sets_to_win === 3 && toRow(two, null, 'beach').status === 'live',
    'a best-of-5 beach board at 2:0 is still live (not final at the beach default of 2)')
  bh5.apply({ type: 'next-set' })
  const side = bh5.getState().ends_swapped ? 'right' : 'left'
  for (let p = 0; p < 21; p++) bh5.apply({ type: 'point', side, delta: 1 })
  const three = bh5.getState()
  assert(three.sets_won_a + three.sets_won_b === 3 && toRow(three, null, 'beach').status === 'final',
    'and final once a pair takes 3 sets')

  assert(toRow({ sets_won_a: 3, set_results: [{ a: 25, b: 1 }, { a: 25, b: 1 }, { a: 25, b: 1 }] }, null, 'volleyball').status === 'final',
    'a state without sets_to_win (linked match) still falls back to the sport default')
}

// ── 1c. set durations ride along in set_results, and only where the board timed the set ──
console.log('\ntoRow — set durations')
{
  let t = 0
  const vb = new ManualSource({ now: () => t })
  // Team A takes every set — scored on whichever side it stands after the change of ends.
  const pointA = (delta = 1) => vb.apply({ type: 'point', side: vb.getState().ends_swapped ? 'right' : 'left', delta })
  const playSet = (secs) => {
    pointA() // the first rally starts the clock
    t += secs * 1000
    for (let p = 1; p < 25; p++) pointA()
  }
  playSet(1500); vb.apply({ type: 'next-set' })
  playSet(1320)
  const mid = toRow(vb.getState(), 'set-end', 'volleyball')
  assert(mid.set_results.length === 2 && mid.set_results[0].dur === 1500 && mid.set_results[1].dur === 1320,
    'each timed set carries its dur in seconds')
  const junk = toRow({ sets_won_a: 1, set_results: [{ a: 25, b: 20, dur: -4 }, { a: 20, b: 25, dur: 'x' }, { a: 25, b: 1 }] }, null, 'volleyball')
  assert(junk.set_results.every((r) => !('dur' in r)), 'a missing, negative or junk dur is left out, not sent as null')
  assert(junk.set_results[0].a === 25 && junk.set_results[0].b === 20, 'and the score is carried regardless')

  // The archive row is the final live row: the durations and the last set played go to history too.
  stubFetch()
  const lp = createLivePush(CFG)
  vb.apply({ type: 'next-set' })
  pointA()
  lp.push(vb.getState()) // the match is live on this publisher before it finishes
  await wait(30)
  pointA(-1)
  playSet(1410)
  lp.push(vb.getState(), vb.lastEvent)
  await wait(40)
  const arch = calls.filter((c) => c.url.includes('live_history'))
  assert(arch.length === 1, 'the finished match is archived')
  assert(arch[0] && arch[0].body.set_results.map((r) => r.dur).join(',') === '1500,1320,1410',
    'the live_history row carries every set\'s dur')
  assert(arch[0] && arch[0].body.period === 3, 'and reports the last set played as its period')
  lp.detach?.()
}

// ── 2. toRow: basketball reuses subs_* for team fouls ────────────────────────
console.log('\ntoRow — basketball (subs_* carries team fouls)')
{
  const bb = new BasketballSource()
  bb.apply({ type: 'point', side: 'left', value: 64 })
  bb.apply({ type: 'sub', side: 'left', value: 5 }) // 'sub' == team foul in basketball
  bb.apply({ type: 'set', side: 'left', value: 3 }) // 'set' == period
  const state = bb.getState()
  const row = toRow(state, null, 'basketball')
  assert(state.subs_a === 5, 'source really does put fouls in subs_a')
  assert(row.fouls_a === 5, 'mapped to fouls_a on the wire')
  assert(row.subs_a === 0, 'and subs_a is zeroed so the payload does not lie')
  assert(row.period === state.period, 'period comes from the source, not the set count')
  assert(row.sport === 'basketball', 'sport is basketball')
}

// ── 3. status: idle / final ──────────────────────────────────────────────────
console.log('\ntoRow — status')
{
  assert(toRow(new ManualSource().getState(), null, 'volleyball').status === 'idle',
    'a neutral board is idle, not a 0:0 live match')

  const vb = new ManualSource()
  vb.apply({ type: 'set', side: 'left', value: 3 })
  const row = toRow(vb.getState(), null, 'volleyball')
  assert(row.status === 'final' && row.over === true,
    'volleyball is final at 3 sets — derived from state, not the transient event')

  const beach = { team_a_name: 'A', sets_won_a: 2, sets_won_b: 0, set_results: [] }
  assert(toRow(beach, null, 'beach').over === true, 'beach is over at 2 sets (BEACH.setsToWin)')
  assert(toRow(beach, null, 'volleyball').over === false, 'the same score is NOT over at volleyball')
}

// ── 4. Debounce coalesces a burst into one write with the latest state ───────
console.log('\ndebounce')
{
  stubFetch()
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  src.apply({ type: 'team', side: 'left', short: 'KSCW' })
  for (let i = 1; i <= 5; i++) { src.apply({ type: 'point', side: 'left', value: i }); lp.push(src.getState()) }
  await wait(40)
  assert(calls.length === 1, `5 rapid changes → 1 write (got ${calls.length})`)
  assert(calls[0].method === 'PATCH', 'writes with PATCH')
  assert(calls[0].url.endsWith('/items/live_scores/kscw'), 'writes the channel row by primary key')
  assert(calls[0].body.points_a === 5, 'carries the LATEST state, not the first')
}

// ── 5. 404 self-heal → POST ──────────────────────────────────────────────────
console.log('\nself-heal')
{
  stubFetch((n) => (n === 1
    ? { ok: false, status: 404, text: async () => '' }
    : { ok: true, status: 200, text: async () => '' }))
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  src.apply({ type: 'point', side: 'left', delta: 1 })
  lp.push(src.getState())
  await wait(40)
  assert(calls.length === 2, 'a 404 triggers a second request')
  assert(calls[1].method === 'POST' && calls[1].url.endsWith('/items/live_scores'),
    'the retry CREATES the row')
  assert(calls[1].body.channel === 'kscw', 'and includes the channel primary key')
}

// ── 5b. A finished match is archived ONCE, on the transition ────────────────
console.log('\nhistory archive')
{
  stubFetch()
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  src.apply({ type: 'team', side: 'left', short: 'KSCW' })
  src.apply({ type: 'point', side: 'left', delta: 1 })
  lp.push(src.getState())
  await wait(30)
  const beforeFinal = calls.length
  assert(!calls.some((c) => c.url.includes('live_history')), 'a live match is not archived')

  // Win the match (3 sets) → one archive.
  src.apply({ type: 'set', side: 'left', value: 3 })
  lp.push(src.getState())
  await wait(40)
  const archives = calls.filter((c) => c.url.includes('live_history'))
  assert(calls.length > beforeFinal, 'the final state was published')
  assert(archives.length === 1, `finishing archives once (got ${archives.length})`)
  assert(archives[0].method === 'POST', 'history is appended with POST')
  assert(archives[0].body.channel === 'kscw' && archives[0].body.sets_won_a === 3,
    'the archived row carries the channel and the result')

  // Fiddling with a finished board must NOT archive again.
  src.apply({ type: 'point', side: 'left', delta: 1 })
  lp.push(src.getState())
  await wait(40)
  assert(calls.filter((c) => c.url.includes('live_history')).length === 1,
    'further pushes on a finished board do not append duplicates')
}

// ── 5c. TWO matches in one evening ──────────────────────────────────────────
// The suite only ever drove a single match through one createLivePush, which is how two separate
// "the second game was never archived" bugs both shipped green. History is append-only — the board
// holds create and nothing else — so each of these must archive EXACTLY once, no more and no less.
console.log('\ntwo matches in one session')
{
  const hist = () => calls.filter((c) => c.url.includes('live_history')).length
  const teams = (a, b) => ({ team_a_name: a, team_b_name: b, team_a_short: a, team_b_short: b })
  const settle = () => wait(40)

  // The club's second basketball game of the evening against the SAME opponent. Basketball never
  // fills set_results, so a content hash of the row keyed both games identically and dropped the
  // second one outright.
  {
    stubFetch()
    const lp = createLivePush({ ...CFG, sport: 'basketball' })
    lp.push({ ...teams('KSCW', 'GAST'), points_a: 61, points_b: 58 }); await settle()
    lp.push({ ...teams('KSCW', 'GAST'), points_a: 61, points_b: 58, over: true }); await settle()
    assert(hist() === 1, `game 1 archived (got ${hist()})`)
    lp.push({ ...teams('KSCW', 'GAST'), points_a: 0, points_b: 0 }); await settle()   // tip-off
    lp.push({ ...teams('KSCW', 'GAST'), points_a: 70, points_b: 66 }); await settle()
    lp.push({ ...teams('KSCW', 'GAST'), points_a: 70, points_b: 66, over: true }); await settle()
    assert(hist() === 2, `the SECOND game against the same opponent is archived too (got ${hist()})`)
  }

  // POST /api/link hands the SourceManager a brand-new LanSource with no neutral state between the
  // two matches, so a LAN match the tablet crew already started arrives mid-score. There is no 0-0
  // anywhere for the instance counter to notice.
  {
    stubFetch()
    const lp = createLivePush(CFG)
    lp.push({ ...teams('KSCW', 'VZH'), points_a: 25, points_b: 20, sets_won_a: 3, set_results: [{ a: 25, b: 20 }] })
    await settle()
    lp.push({ ...teams('KSCW', 'VZH'), points_a: 25, points_b: 20, sets_won_a: 3, set_results: [{ a: 25, b: 20 }], over: true })
    await settle()
    assert(hist() === 1, `the first LAN match archived (got ${hist()})`)
    // Linked straight into a different fixture already at 8-5 — never passes through zero.
    lp.push({ ...teams('KSCW', 'AMRI'), points_a: 8, points_b: 5 }); await settle()
    lp.push({ ...teams('KSCW', 'AMRI'), points_a: 25, points_b: 18, sets_won_a: 3, over: true }); await settle()
    assert(hist() === 2, `a match linked mid-score is archived, not lost (got ${hist()})`)
  }

  // The other direction: correcting a set score AFTER the final is the same match, and history
  // cannot be un-appended, so a duplicate is the worse failure of the two.
  {
    stubFetch()
    const lp = createLivePush(CFG)
    const final = { ...teams('KSCW', 'VZH'), points_a: 25, points_b: 22, sets_won_a: 3,
      set_results: [{ a: 25, b: 20 }, { a: 25, b: 18 }, { a: 25, b: 22 }], over: true }
    lp.push({ ...teams('KSCW', 'VZH'), points_a: 24, points_b: 22 }); await settle()
    lp.push(final); await settle()
    assert(hist() === 1, `the match archived once (got ${hist()})`)
    lp.push({ ...final, set_results: [{ a: 25, b: 20 }, { a: 25, b: 18 }, { a: 25, b: 23 }] }); await settle()
    assert(hist() === 1, `a set-score correction after the final does NOT append a second row (got ${hist()})`)
  }

  // An upstream padding set_results must not hide the start of a match from the counter — toRow
  // filters that array and this used to disagree with it.
  {
    stubFetch()
    const lp = createLivePush(CFG)
    lp.push({ ...teams('KSCW', 'VZH'), points_a: 25, sets_won_a: 3, over: true }); await settle()
    assert(hist() === 1, `first match archived (got ${hist()})`)
    lp.push({ ...teams('KSCW', 'VZH'), points_a: 0, points_b: 0, set_results: [{ a: 0, b: 0 }] }); await settle()
    lp.push({ ...teams('KSCW', 'VZH'), points_a: 25, sets_won_a: 3, over: true }); await settle()
    assert(hist() === 2, `a 0-0 board padded with a placeholder still starts a new match (got ${hist()})`)
  }
}

// ── 5d. The board row is the court as the SCORER sees it (Settings ▸ Scorer sits behind the board) ──
// 20.11.2026, hand-scored on the C0270 with the default 'behind': the panel was right and kscw.ch/live
// showed the teams mirrored — the panel faces the court, the scorer and the spectators sit behind it.
console.log('\nscorer\'s view — the board\'s own sources')
{
  const vb = new ManualSource()
  vb.apply({ type: 'team', side: 'left', name: 'PANEL LEFT', short: 'PL', color: '#111111' })
  vb.apply({ type: 'team', side: 'right', name: 'PANEL RIGHT', short: 'PR', color: '#222222' })
  // Set 1 to the panel's left 25-20, then (after the change of ends) a set in progress.
  for (let p = 0; p < 20; p++) vb.apply({ type: 'point', side: 'right', delta: 1 })
  for (let p = 0; p < 25; p++) vb.apply({ type: 'point', side: 'left', delta: 1 })
  vb.apply({ type: 'next-set' })
  // After the change of ends 'PANEL LEFT' stands on the panel's RIGHT.
  vb.apply({ type: 'point', side: 'right', value: 7 })
  vb.apply({ type: 'point', side: 'left', value: 4 })
  vb.apply({ type: 'timeout', side: 'right', delta: 1 })
  vb.apply({ type: 'sub', side: 'left', value: 2 })
  vb.apply({ type: 'serve', side: 'right' })
  const st = vb.getState()
  assert(st.side_a === 'left' && st.team_a_name === 'PANEL RIGHT' && st.ends_swapped === true, 'the board itself: A = the panel\'s left (after the change of ends, "PANEL RIGHT")')

  const front = toRow(st, null, 'volleyball', { behind: false })
  assert(JSON.stringify(front) === JSON.stringify({ ...toRow(st, null, 'volleyball'), ts: front.ts }), 'front: the row is the one it always was')
  assert(front.team_a_name === 'PANEL RIGHT' && front.points_a === 4 && front.points_b === 7 && front.serving_team === 'right', 'front: A = the panel\'s left, serve on the right')

  const behind = toRow(st, null, 'volleyball', { behind: true })
  assert(behind.team_a_name === 'PANEL LEFT' && behind.team_a_short === 'PL' && behind.team_a_color === '#111111' && behind.team_b_name === 'PANEL RIGHT',
    'behind: names, shorts and colours mirrored — A = the panel\'s RIGHT = the scorer\'s left')
  assert(behind.points_a === 7 && behind.points_b === 4, `behind: points mirrored (${behind.points_a}-${behind.points_b})`)
  assert(behind.timeouts_a === 1 && behind.timeouts_b === 0 && behind.subs_a === 0 && behind.subs_b === 2, 'behind: timeouts and subs mirrored')
  assert(behind.sets_won_a === 1 && behind.sets_won_b === 0, 'behind: sets won mirrored')
  assert(behind.serving_team === 'left', 'behind: the panel\'s right serves = the scorer\'s left')
  // Set 1 went 25-20 to PANEL LEFT; the state carries it by side (20-25, A = PANEL RIGHT now).
  assert(st.set_results[0].a === 20 && behind.set_results.length === 1 && behind.set_results[0].a === 25 && behind.set_results[0].b === 20 && 'dur' in behind.set_results[0] === 'dur' in st.set_results[0],
    `behind: set 1 follows the teams onto the row's A/B, dur kept (${JSON.stringify(behind.set_results)})`)
  assert(behind.side_a === 'left' && behind.period === 2 && behind.status === 'live', 'behind: side_a, period and status are not side-bound')
  assert(st.team_a_name === 'PANEL RIGHT' && st.points_a === 4, 'the state itself is not modified')

  // Basketball: the possession arrow and the team fouls follow the same swap.
  const bb = new BasketballSource()
  bb.apply({ type: 'point', side: 'left', value: 40 })
  bb.apply({ type: 'point', side: 'right', value: 38 })
  bb.apply({ type: 'sub', side: 'left', value: 4 })
  bb.apply({ type: 'serve', side: 'left' })
  const bbs = bb.getState()
  const bbr = toRow(bbs, null, 'basketball', { behind: true })
  assert(bbr.points_a === 38 && bbr.points_b === 40 && bbr.fouls_a === 0 && bbr.fouls_b === 4 && bbr.subs_a === 0,
    `basketball behind: points and team fouls mirrored (${bbr.points_a}-${bbr.points_b}, fouls ${bbr.fouls_a}-${bbr.fouls_b})`)
  assert(bbs.serving_team === 'left' && bbr.serving_team === 'right', 'basketball behind: the possession arrow points the other way')
  assert(bbr.period === bbs.period, 'basketball behind: the period stays')
  assert(toRow(bbs, null, 'basketball', { behind: false }).serving_team === 'left', 'basketball front: unchanged')

  // Beach: the board's own source, the same rule.
  const be = new BeachSource()
  be.apply({ type: 'team', side: 'left', short: 'BL' })
  be.apply({ type: 'team', side: 'right', short: 'BR' })
  be.apply({ type: 'point', side: 'left', value: 5 })
  const ber = toRow(be.getState(), null, 'beach', { behind: true })
  assert(ber.team_a_short === 'BR' && ber.points_b === 5, 'beach behind: mirrored too')
  assert(toRow(be.getState(), null, 'beach').team_a_short === 'BL', 'beach front: unchanged')
}

console.log('\nscorer\'s view — a linked OpenVolley match')
{
  // OpenVolley's liveState: A and B fixed teams, side_a / serving_team the SCORER's sides (the tablet).
  const ov = (o = {}) => ({
    team_a_name: 'OV Team A', team_a_short: 'OVA', team_b_name: 'OV Team B', team_b_short: 'OVB',
    points_a: 10, points_b: 8, sets_won_a: 1, sets_won_b: 0, current_set: 2,
    timeouts_a: [{}], timeouts_b: [], side_a: 'left', serving_team: 'left', match_status: 'in_progress', ...o,
  })
  // What livePush receives: the board's VIEW (lanSource.js), mirrored for the panel when 'behind'.
  const received = (raw, behind) => new LinkedView().view(raw, { mirror: behind })
  for (const behind of [true, false]) {
    const tag = behind ? 'behind' : 'front'
    const left = toRow(received(ov(), behind), null, 'volleyball', { behind })
    assert(left.team_a_name === 'OV Team A' && left.points_a === 10 && left.timeouts_a === 1 && left.serving_team === 'left',
      `${tag}: OpenVolley's A on the scorer's left → row A = OV A, serving on the left (${left.team_a_name}, ${left.serving_team})`)
    const right = toRow(received(ov({ side_a: 'right', serving_team: 'left' }), behind), null, 'volleyball', { behind })
    assert(right.team_a_name === 'OV Team B' && right.points_a === 8 && right.points_b === 10 && right.timeouts_b === 1 && right.sets_won_b === 1,
      `${tag}: OV A on the scorer's right → row A = OV B (${right.team_a_name} ${right.points_a}-${right.points_b})`)
    assert(right.serving_team === 'left', `${tag}: the scorer's left serves → the row's left (OV B)`)
  }
  // And the panel agrees with the console game in the same hall: a hand-scored board and a linked
  // match with the same team on the scorer's left publish the same A.
  const vb = new ManualSource()
  vb.apply({ type: 'team', side: 'right', name: 'OV Team A' }) // the scorer's left, behind the board
  vb.apply({ type: 'team', side: 'left', name: 'OV Team B' })
  const hand = toRow(vb.getState(), null, 'volleyball', { behind: true })
  const linked = toRow(received(ov({ points_a: 0, points_b: 0, sets_won_a: 0 }), true), null, 'volleyball', { behind: true })
  assert(hand.team_a_name === linked.team_a_name.toUpperCase() && hand.team_a_name === 'OV TEAM A', `console and linked games put the same team on A (${hand.team_a_name} / ${linked.team_a_name})`)
}

console.log('\nscorer\'s view — a change of ends mid-match')
{
  // Behind the board, scored by hand. The scorer's left team is the row's A in every set, and the
  // set results stay attached to the right teams as the row turns with the ends.
  stubFetch()
  const lp = createLivePush({ ...CFG, orientation: () => 'behind' })
  const vb = new ManualSource()
  vb.apply({ type: 'team', side: 'left', name: 'HOME' })  // panel left = the scorer's right
  vb.apply({ type: 'team', side: 'right', name: 'AWAY' })
  const rowNow = async () => { lp.push(vb.getState(), vb.lastEvent); await wait(30); return calls.filter((c) => c.url.endsWith('/kscw')).at(-1).body }
  for (let p = 0; p < 18; p++) vb.apply({ type: 'point', side: 'right', delta: 1 })
  for (let p = 0; p < 25; p++) vb.apply({ type: 'point', side: 'left', delta: 1 })
  let r = await rowNow()
  assert(r.team_a_name === 'AWAY' && r.points_a === 18 && r.points_b === 25, `set 1: Away on the scorer's left, 18-25 (${r.team_a_name} ${r.points_a}-${r.points_b})`)
  vb.apply({ type: 'next-set' }) // ends change: Home on the panel's right = the scorer's left
  vb.apply({ type: 'point', side: 'right', delta: 1 })
  r = await rowNow()
  assert(r.team_a_name === 'HOME' && r.points_a === 1 && r.sets_won_a === 1, `set 2: Home on the scorer's left now, 1-0, a set up (${r.team_a_name} ${r.points_a} sets ${r.sets_won_a})`)
  assert(r.set_results[0].a === 25 && r.set_results[0].b === 18, `set 1 follows Home onto A (${JSON.stringify(r.set_results)})`)
  assert((r.serving_team === 'left') === (vb.getState().serving_team === 'right'), 'the serve dot is on the team that serves')

  // Linked: OpenVolley flips side_a at the change of ends; the row follows the scorer's tablet.
  const view = new LinkedView()
  const ov = (o) => ({ team_a_name: 'OV A', team_b_name: 'OV B', points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, current_set: 1, side_a: 'left', serving_team: 'left', ...o })
  const s1 = toRow(view.view(ov({ points_a: 5 }), { mirror: true }), null, 'volleyball', { behind: true })
  const s2 = toRow(view.view(ov({ current_set: 2, sets_won_a: 1, points_b: 3, side_a: 'right', serving_team: 'left' }), { mirror: true }), null, 'volleyball', { behind: true })
  assert(s1.team_a_name === 'OV A' && s2.team_a_name === 'OV B' && s2.points_a === 3 && s2.sets_won_b === 1,
    `linked: set 1 OV A on the left, set 2 OV B on the left (${s1.team_a_name} → ${s2.team_a_name})`)
  lp.detach()
}

console.log('\nscorer\'s view — the mirror never looks like a new match')
{
  const hist = () => calls.filter((c) => c.url.includes('live_history'))
  stubFetch()
  let orientation = 'behind'
  const lp = createLivePush({ ...CFG, orientation: () => orientation })
  const sm = new SourceManager()
  const vb = new ManualSource()
  lp.attach(sm)
  sm.setSource(vb, { mode: 'manual' })
  vb.apply({ type: 'team', side: 'left', name: 'HOME' })
  vb.apply({ type: 'team', side: 'right', name: 'AWAY' })
  vb.apply({ type: 'point', side: 'left', delta: 1 })
  await wait(30)
  // The setting flipped mid-match, twice, and the board republished each time.
  orientation = 'front'; lp.republish(); await wait(30)
  const front = calls.filter((c) => c.url.endsWith('/kscw')).at(-1).body
  orientation = 'behind'; lp.republish(); await wait(30)
  const back = calls.filter((c) => c.url.endsWith('/kscw')).at(-1).body
  assert(front.team_a_name === 'HOME' && back.team_a_name === 'AWAY', `republish turns the row round with the setting (${front.team_a_name} → ${back.team_a_name})`)
  vb.apply({ type: 'set', side: 'left', value: 3 }) // Home wins
  await wait(40)
  assert(hist().length === 1, `the match is archived once (${hist().length})`)
  orientation = 'front'; lp.republish(); await wait(30)
  orientation = 'behind'; lp.republish(); await wait(30)
  vb.apply({ type: 'swap' }); await wait(30)
  assert(hist().length === 1, `flipping the orientation and the ends after the final appends nothing (${hist().length})`)
  lp.detach()
}

console.log('\nfinal — home on the left')
{
  const hist = () => calls.filter((c) => c.url.includes('live_history'))
  const boardRow = () => calls.filter((c) => c.url.endsWith('/kscw')).at(-1)?.body
  const FIX = fixtureOf({ id: 9, home: 'HOME CLUB', away: 'AWAY CLUB', homeShort: 'HOME', awayShort: 'AWAY' }, { homeStartsLeft: true })

  // Scheduled game, behind the board, home starting on the panel's left (= the scorer's right): live
  // in set 3 the row has away on A; once final, home on A — sets, set results and points with it —
  // and still after a swap of ends puts home on the scorer's right.
  stubFetch()
  const lp = createLivePush({ ...CFG, orientation: () => 'behind', fixture: () => FIX })
  const vb = new ManualSource({ bestOf: 5 })
  vb.apply({ type: 'team', side: 'left', name: 'HOME CLUB', short: 'HOME' })
  vb.apply({ type: 'team', side: 'right', name: 'AWAY CLUB', short: 'AWAY' })
  const homeSideNow = () => (vb.getState().ends_swapped ? 'right' : 'left')
  const awaySideNow = () => (homeSideNow() === 'left' ? 'right' : 'left')
  const sets = [[25, 20], [18, 25], [25, 22], [25, 23]] // home first
  for (let i = 0; i < sets.length; i++) {
    const [h, a] = sets[i]
    const win = h > a ? homeSideNow() : awaySideNow(), lose = h > a ? awaySideNow() : homeSideNow()
    for (let p = 0; p < Math.min(h, a); p++) vb.apply({ type: 'point', side: lose, delta: 1 })
    for (let p = 0; p < Math.max(h, a); p++) vb.apply({ type: 'point', side: win, delta: 1 })
    if (i === 2) {
      lp.push(vb.getState(), vb.lastEvent); await wait(30)
      const live = boardRow()
      assert(live.status === 'live' && live.team_a_name === 'AWAY CLUB', `live (set 3 over, home on the panel's left): away on the scorer's left (${live.team_a_name})`)
    }
    if (i < sets.length - 1) vb.apply({ type: 'next-set' })
  }
  assert(homeSideNow() === 'right', 'after four sets home stands on the panel\'s right (the scorer\'s left); the swap below turns it')
  lp.push(vb.getState(), vb.lastEvent); await wait(40)
  let fin = boardRow()
  assert(fin.status === 'final' && fin.team_a_name === 'HOME CLUB' && fin.sets_won_a === 3 && fin.sets_won_b === 1,
    `final: home on A, 3:1 (${fin.team_a_name} ${fin.sets_won_a}:${fin.sets_won_b})`)
  assert(JSON.stringify(fin.set_results.map((r) => [r.a, r.b])) === JSON.stringify(sets), `final: every set home-first (${JSON.stringify(fin.set_results.map((r) => [r.a, r.b]))})`)
  assert(fin.points_a === 25 && fin.points_b === 23, 'final: the last set\'s points home-first')
  assert(hist().length === 1 && hist()[0].body.team_a_name === 'HOME CLUB' && hist()[0].body.game_id === 9, 'archived once, home on A, naming its game')
  // Home on the RIGHT of the scorer at the final: a swap of ends after the final, and the front
  // orientation — still home on A, and not a second archive.
  vb.apply({ type: 'swap' }); lp.push(vb.getState()); await wait(40)
  fin = boardRow()
  assert(homeSideNow() === 'left' && fin.team_a_name === 'HOME CLUB' && fin.sets_won_a === 3, `home on the scorer's right at the final: still home on A (${fin.team_a_name})`)
  assert(hist().length === 1, `the turn to home-left is not a new match (${hist().length})`)
  lp.detach()

  // No fixture, a linked match whose home OpenVolley knows (linkedView home_ab): home on A at the
  // final; while live, the scorer's view.
  const view = new LinkedView()
  view.takeSummary({ homeTeam: { name: 'OV Home' }, awayTeam: { name: 'OV Away' } })
  const ov = (o) => ({ team_a_name: 'OV Away', team_b_name: 'OV Home', points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, current_set: 3, side_a: 'right', serving_team: 'left', match_status: 'in_progress', ...o })
  view.take(ov({}))
  const liveV = view.view(ov({ points_a: 20, points_b: 24, sets_won_b: 2 }), { mirror: true })
  assert(liveV.home_ab === 'b', `the view says OpenVolley's B is home (${liveV.home_ab})`)
  const liveR = toRow(liveV, null, 'volleyball', { behind: true })
  assert(liveR.status === 'live' && liveR.team_a_name === 'OV Home', 'linked live: the scorer\'s view (OV A stands right → OV B left)')
  const finV = view.view(ov({ points_a: 20, points_b: 25, sets_won_b: 3, side_a: 'left', match_status: 'ended' }), { mirror: true })
  const finR = toRow(finV, 'match-end', 'volleyball', { behind: true })
  assert(finR.status === 'final' && finR.team_a_name === 'OV Home' && finR.sets_won_a === 3 && finR.points_a === 25,
    `linked final, home on the scorer's right: home on A (${finR.team_a_name} ${finR.sets_won_a}:${finR.sets_won_b})`)

  // Home unknown: the final keeps the scorer's view.
  const plain = new ManualSource()
  plain.apply({ type: 'team', side: 'left', name: 'LEFT TEAM' })
  plain.apply({ type: 'set', side: 'left', value: 3 })
  const unk = toRow(plain.getState(), null, 'volleyball', { behind: true })
  assert(unk.status === 'final' && unk.team_b_name === 'LEFT TEAM' && unk.sets_won_b === 3, 'home unknown: the final stays in the scorer\'s view')
}

// ── 6. A broken Directus must never reach the scoring path ───────────────────
console.log('\nisolation')
{
  globalThis.fetch = async () => { throw new Error('network down') }
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  let threw = false
  try {
    lp.attach(src)
    for (let i = 0; i < 5; i++) src.apply({ type: 'point', side: 'left', delta: 1 })
    await wait(40)
  } catch { threw = true }
  assert(!threw, 'a thrown fetch does not propagate')
  assert(src.getState().points_a === 5, 'and scoring carried on regardless')
  lp.detach()
}

// ── 7. Disabled stub when the env is unset ───────────────────────────────────
console.log('\ndisabled by default')
{
  stubFetch()
  const lp = createLivePush({ ...CFG, token: '' })
  assert(lp.enabled === false, 'no token → disabled')
  lp.attach(new ManualSource())
  lp.push(new ManualSource().getState())
  await wait(20)
  assert(calls.length === 0, 'and it makes no requests at all')
}

// ── 8. Attaching to a SourceManager covers manual AND linked matches ─────────
console.log('\nSourceManager attach')
{
  stubFetch()
  const lp = createLivePush(CFG)
  const sm = new SourceManager()
  const src = new ManualSource()
  lp.attach(sm)
  sm.setSource(src, { mode: 'manual' })
  src.apply({ type: 'point', side: 'left', delta: 1 })
  await wait(40)
  assert(calls.length >= 1, 'state emitted through the SourceManager is published')
  lp.detach()
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\n✅ livePush selftest passed' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
