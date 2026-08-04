// PROPOSAL — beach volleyball scoring source for the LedBox appliance. Standalone: nothing
// imports this yet (see docs/beach-volley-DESIGN.md for how it plugs in behind a `sport`
// selector without touching the indoor path). It is a beach-rules sibling of
// src/manualSource.js and speaks the SAME a/b liveState contract, so the SourceManager,
// /api/status, the mapper and the web board-mirror all keep working unchanged.
//
// Beach differences modelled here (FIVB Beach Volleyball Rules 2025-2028, confirmed against
// Swiss Volley beach play):
//   * Best-of-3. Sets 1-2 to 21, deciding set 3 to 15 — both win-by-2, NO upper cap.
//   * Teams are PAIRS (2 players). No rotation, no libero, NO substitutions — so there is
//     no `sub` action and subs stay 0 in the projected state (kept only for shape parity).
//   * Court switch every 7 total points in sets 1-2, every 5 in the deciding set — emitted as a
//     'switch-due' event. It does NOT auto-swap: the UI asks the operator "Switch sides?", then
//     blinks "COURT SWITCH" full-panel and sends the `swap` action only on confirmation.
//   * One automatic technical timeout in sets 1-2, when the points sum reaches 21 — emitted as
//     'tech-timeout' (there is none in the deciding set). The UI runs a 1-minute countdown and
//     flips the court (`swap`) when it ends.
//   * One team timeout per team per set (the club default; see settings note in the design).
//
// Internally the model is LEFT/RIGHT (physical board sides); getState() projects it back to
// the a/b liveState with side_a always 'left' (a=left, b=right), exactly like ManualSource,
// so the volleyball mapper's toLeftRight() resolves it identically.

import { EventEmitter } from 'node:events'
import { formatRules } from './settings.js'

// Beach rule constants — the only knobs that differ from the indoor model. bestOf/setsToWin are
// the DEFAULT format only: the operator can pick one in Settings ▸ Match format, so the live
// numbers come from settings.formatRules() (see _rules()) and these two are what it starts from.
export const BEACH = {
  bestOf: 3,
  setsToWin: 2,
  targetNormal: 21, // sets 1-2
  targetDeciding: 15, // set 3
  switchNormal: 7, // court change cadence, sets 1-2 (sum of points)
  switchDeciding: 5, // court change cadence, deciding set
  techTimeoutAt: 21, // automatic technical timeout when the points sum reaches this (sets 1-2)
  teamTimeoutsPerSet: 1, // club default; one 30 s team timeout per team per set
}

// Neutral starting board (a beach pair carries a two-surname name / short code).
// server_a/server_b = which player (1|2) of each pair is up to serve; served_a/served_b =
// has that pair begun a service turn yet this set (governs the first-serve-no-flip rule below).
// Left (a) serves first with player 1 by default, so it starts "served"; the operator re-declares
// the real order via a `serve-order` action.
const NEUTRAL = {
  side_a: 'left',
  team_a_name: '', team_a_short: 'A/A', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: 'B/B', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0, // subs unused in beach; kept for shape parity
  serving_team: 'left',
  server_a: 1, server_b: 1, served_a: true, served_b: false,
}

const clamp0 = (n) => (n < 0 ? 0 : n)
const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)
const player = (v) => (Number(v) === 2 ? 2 : 1) // coerce a serve-player field to 1|2 (default 1)

export class BeachSource extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.lastEvent = null // transient: notable event from the last apply() (set-end / match-end / switch-due / tech-timeout)
    this.bestOf = BEACH.bestOf
    this.setFormat(opts)
    this._fromLiveState(NEUTRAL)
  }

  // Set (or change) the match format. Called at construction and again whenever the operator saves
  // Settings, so a format change mid-event takes effect without a restart. Beach is best-of-3 in
  // practice; the targets (21/15) stay beach's own, only the set count follows the setting.
  setFormat(opts) {
    // `|| {}` rather than a parameter default: a default only covers `undefined`, and the caller
    // that hands us a settings blob can just as easily hand us a null one — which used to throw
    // "Cannot destructure property 'bestOf' of null" out of the constructor.
    const { bestOf } = opts || {}
    if (bestOf != null) this.bestOf = Number(bestOf) === 3 ? 3 : 5
    return this.bestOf
  }

  // The rulebook for the CURRENT set: sets to win, whether this is the deciding set, and its point
  // target — from the same helper the indoor source uses, with beach's targets handed in.
  _rules() {
    return formatRules(this.bestOf, this.m.leftSets, this.m.rightSets, {
      normal: BEACH.targetNormal, deciding: BEACH.targetDeciding,
    })
  }

  // Is this the deciding (3rd) set — sets level at one apiece?
  get _deciding() {
    return this._rules().deciding
  }

  _target() {
    return this._rules().target
  }

  _cadence() {
    return this._deciding ? BEACH.switchDeciding : BEACH.switchNormal
  }

  // Load the internal left/right model from an a/b liveState, honouring side_a.
  _fromLiveState(s) {
    const isALeft = (s.side_a || 'left') === 'left'
    const pick = (a, b) => (isALeft ? a : b)
    this.m = {
      leftName: pick(s.team_a_name, s.team_b_name) ?? '',
      leftShort: pick(s.team_a_short, s.team_b_short) ?? '',
      leftColor: pick(s.team_a_color, s.team_b_color) ?? '#2563eb',
      rightName: pick(s.team_b_name, s.team_a_name) ?? '',
      rightShort: pick(s.team_b_short, s.team_a_short) ?? '',
      rightColor: pick(s.team_b_color, s.team_a_color) ?? '#ef4444',
      leftPoints: num(pick(s.points_a, s.points_b)),
      rightPoints: num(pick(s.points_b, s.points_a)),
      leftSets: num(pick(s.sets_won_a, s.sets_won_b)),
      rightSets: num(pick(s.sets_won_b, s.sets_won_a)),
      leftTO: num(pick(s.timeouts_a, s.timeouts_b)),
      rightTO: num(pick(s.timeouts_b, s.timeouts_a)),
      serving: s.serving_team ?? null, // already 'left' | 'right' | null
      // Serve player (1|2) per pair, honouring side_a like every other field.
      leftServer: player(pick(s.server_a, s.server_b)),
      rightServer: player(pick(s.server_b, s.server_a)),
    }
    // "Has this pair served yet" flags. Use them if the state carried them; otherwise seed from
    // the serving side (so a bare set-state still tracks flips correctly from that point on).
    const servedGiven = s.served_a != null || s.served_b != null
    this.m.leftServed = servedGiven ? !!pick(s.served_a, s.served_b) : this.m.serving === 'left'
    this.m.rightServed = servedGiven ? !!pick(s.served_b, s.served_a) : this.m.serving === 'right'
    // Completed-set final scores, stored per physical side (swapped on _swap()).
    this.results = (Array.isArray(s.set_results) ? s.set_results : []).map((r) => ({
      left: num(pick(r.a, r.b)), right: num(pick(r.b, r.a)),
    }))
    this._syncClosed()
  }

  // Has the set on the board already been awarded? Derived, never assumed: the score now showing
  // being exactly the last recorded result means that set-end is still standing (a resume, or a
  // set-state round-trip while the SET ENDED prompt is up), so the minus button must still be able
  // to take it back — and a second set-end must not fire off the same set. Anything else means the
  // board has moved on and the set is open again. 0-0 never counts as closed: an upstream that
  // pushes the in-progress set as a {a:0,b:0} placeholder would otherwise make a fresh set at 0-0
  // unwinnable, and a set that can never end is the one failure the hall actually sees.
  _syncClosed() {
    const lastSet = this.results[this.results.length - 1]
    this.setClosed = !!lastSet && (lastSet.left > 0 || lastSet.right > 0) &&
      lastSet.left === this.m.leftPoints && lastSet.right === this.m.rightPoints
  }

  // Project the left/right model back to the a/b liveState contract (a=left). subs are
  // always 0 — there are no substitutions in beach, but the field is emitted so the shape
  // matches the indoor liveState the rest of the pipeline expects.
  getState() {
    const m = this.m
    return {
      side_a: 'left',
      team_a_name: m.leftName, team_a_short: m.leftShort, team_a_color: m.leftColor,
      team_b_name: m.rightName, team_b_short: m.rightShort, team_b_color: m.rightColor,
      points_a: m.leftPoints, points_b: m.rightPoints,
      sets_won_a: m.leftSets, sets_won_b: m.rightSets,
      timeouts_a: m.leftTO, timeouts_b: m.rightTO,
      subs_a: 0, subs_b: 0,
      serving_team: m.serving,
      // Beach-only serve-player fields (other sports never set these; the beach mapper + UI are
      // the only readers). server_a/b = each pair's current server; serve_player = the serving
      // pair's number (0 when nobody is serving) — the single digit the board paints.
      server_a: m.leftServer, server_b: m.rightServer,
      served_a: m.leftServed, served_b: m.rightServed,
      serve_player: m.serving === 'left' ? m.leftServer : m.serving === 'right' ? m.rightServer : 0,
      set_results: this.results.map((r) => ({ a: r.left, b: r.right })),
    }
  }

  apply(action = {}) {
    const m = this.m
    this.lastEvent = null
    const key = (base, side) => (side === 'right' ? 'right' : 'left') + base
    switch (action.type) {
      case 'point': {
        const side = action.side === 'right' ? 'right' : 'left'
        const other = side === 'left' ? 'right' : 'left'
        const before = m[side + 'Points']
        // An absolute set (an operator correction typed in) just sets the number — no serve
        // change, no set/switch/tech detection. Only a +delta drives the rally rules below. It DOES
        // re-derive setClosed, though: every score on the console is a tap-to-edit field, so
        // typing one after a set end (zeroing the board by hand instead of tapping NEXT SET is a
        // one-tap flow) left setClosed stuck true — and the next genuine set win then fired no
        // set-end at all. No prompt, no interval, no horn, the board playing past 21 forever.
        if (action.value != null) {
          m[side + 'Points'] = clamp0(Number(action.value) || 0)
          // One-directional on purpose: a typed value may REOPEN a set, never close one. The check
          // is "do the points match the last pill?", which cannot tell "this set just ended" from
          // "an earlier set had the same score" — and two sets ending 25-23 is routine. Left
          // bidirectional, typing the current set to an earlier set's score marked it closed, and
          // the very next "−" tap popped THAT set off the strip and off the set score. The board
          // went 1-0 → 0-0 mid-match from one correction tap.
          if (this.setClosed) this._syncClosed()
          break
        }
        const d = Number(action.delta) || 0
        const wasServing = m.serving // who served this rally — needed to detect a side-out
        m[side + 'Points'] = clamp0(before + d)
        const { toWin, target } = this._rules()
        // Evaluated against the OTHER side's (unchanged) score, so the same predicate answers both
        // "was the set won before this tap" and "is it won after it" — that symmetry is what makes
        // the minus button able to undo a set instead of only moving the points.
        const won = (p) => p >= target && p - m[other + 'Points'] >= 2
        const wonBefore = won(before)
        const wonNow = won(m[side + 'Points'])
        if (d > 0) {
          // Serve-player tracking (beach): a pair keeps the same server while it holds serve, and
          // ALTERNATES its server each time it wins the serve BACK. So on a side-out (the receiver
          // won the rally), the newly-serving pair flips its server — unless this is its very first
          // service turn of the set, which uses the declared first server (served flag still false).
          if (wasServing && wasServing !== side) {
            if (m[side + 'Served']) m[side + 'Server'] = m[side + 'Server'] === 1 ? 2 : 1
            else m[side + 'Served'] = true
          } else {
            m[side + 'Served'] = true // held serve (or first point of a fresh board): mark served
          }
          // Rally scoring: the side that wins the point serves next.
          m.serving = side
          if (!wonBefore && wonNow && !this.setClosed) {
            // Set win: first to 21 (15 in the deciding set) by >=2, uncapped. Fires once, on the
            // transition — and `setClosed` keeps it to once per set. The SET ENDED prompt is not
            // modal, so after a 21-19 the operator can still push the LOSING pair up while
            // correcting; at 21-23 that used to award a second set and the board read 1-1 on a set
            // only one pair had won.
            m[side + 'Sets'] = clamp0(m[side + 'Sets'] + 1)
            this.results.push({ left: m.leftPoints, right: m.rightPoints })
            this.setClosed = true
            this.lastEvent = m[side + 'Sets'] >= toWin ? 'match-end' : 'set-end'
          } else if (!wonNow) {
            // No set won: flag a technical timeout (sets 1-2, sum hits 21) or that a change of
            // ends is DUE (sum crosses the cadence). NEITHER swaps here — the source only flags;
            // the UI gates the swap (a confirm for a switch, a countdown for the TTO). The tech
            // timeout wins the tie at sum 21 (it inherently includes the change of ends), so it
            // is checked first.
            const total = m.leftPoints + m.rightPoints
            const beforeTotal = total - d
            const deciding = this._deciding
            const crossed = (n) => n > 0 && Math.floor(total / n) > Math.floor(beforeTotal / n)
            if (!deciding && beforeTotal < BEACH.techTimeoutAt && total >= BEACH.techTimeoutAt) {
              this.lastEvent = 'tech-timeout'
            } else if (crossed(this._cadence())) {
              this.lastEvent = 'switch-due'
            }
          }
        } else if (d < 0 && this.setClosed && wonBefore && !wonNow) {
          // Walking the score back below the winning condition IS the undo of the set that score
          // awarded. Without this the "−" only moved the points: a mis-tapped 21-19 left the set
          // counted and its pill in the strip, and then the REAL 21-19 a rally later counted it a
          // second time — two identical pills and 2-0 in front of the hall on a 1-0 match.
          this.results.pop()
          m[side + 'Sets'] = clamp0(m[side + 'Sets'] - 1)
          this.setClosed = false
        }
        break
      }
      // For set/timeout, action.value sets the number absolutely (a typed correction);
      // otherwise action.delta adjusts it. Both clamp at 0.
      case 'set':
        m[key('Sets', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('Sets', action.side)] + (Number(action.delta) || 0))
        break
      case 'timeout':
        m[key('TO', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('TO', action.side)] + (Number(action.delta) || 0))
        break
      case 'serve':
        m.serving = action.side === 'right' ? 'right' : 'left'
        break
      case 'serve-order': {
        // Declare the serving order at the start of a set: which side serves first and each pair's
        // first server (1|2). The first-serving pair is mid its opening turn (served=true); the
        // other has yet to serve (served=false), so its opening serve keeps its declared number.
        const first = action.first === 'right' ? 'right' : 'left'
        const other = first === 'left' ? 'right' : 'left'
        m.serving = first
        if (action.leftServer != null) m.leftServer = player(action.leftServer)
        if (action.rightServer != null) m.rightServer = player(action.rightServer)
        m[first + 'Served'] = true
        m[other + 'Served'] = false
        break
      }
      case 'serve-player': {
        // Manual override of a pair's current server. Defaults to the serving side. With a value
        // (1|2) it sets that player; without one it flips the current server. Marks the pair served
        // so automatic tracking picks up cleanly from the operator's correction.
        const side = action.side === 'left' || action.side === 'right' ? action.side : m.serving
        if (side !== 'left' && side !== 'right') break
        const cur = m[side + 'Server'] === 2 ? 2 : 1
        m[side + 'Server'] = action.value != null ? player(action.value) : (cur === 1 ? 2 : 1)
        m[side + 'Served'] = true
        break
      }
      case 'swap':
        this._swap()
        break
      case 'team': {
        const side = action.side === 'right' ? 'right' : 'left'
        // Upper-cased on the way in, as in manualSource — see the note there and in toLeftRight().
        if (action.name != null) m[side + 'Name'] = String(action.name).toUpperCase()
        if (action.short != null) m[side + 'Short'] = String(action.short).toUpperCase()
        if (action.color != null) m[side + 'Color'] = String(action.color)
        break
      }
      case 'next-set': {
        // Start the next set: clear points AND the per-set team timeouts, then switch ends.
        // Pairs change ends after every set EXCEPT going into the deciding 3rd set, whose
        // sides come from a fresh coin toss (mirrors the indoor 5th-set rule).
        const { toWin } = this._rules()
        m.leftPoints = 0
        m.rightPoints = 0
        m.leftTO = 0
        m.rightTO = 0
        if (m.leftSets + m.rightSets !== (toWin - 1) * 2) this._swap()
        // Fresh set: the pair now on serve (carried over / swapped) is mid its opening turn; the
        // other has yet to serve. The operator can re-declare the whole order via `serve-order`.
        m.leftServed = m.serving === 'left'
        m.rightServed = m.serving === 'right'
        this.setClosed = false // a fresh set can be won again
        break
      }
      case 'remove-set': {
        // Undo the last recorded set: drop its result and its set point.
        const last = this.results.pop()
        if (last) {
          const w = last.left > last.right ? 'left' : (last.right > last.left ? 'right' : null)
          if (w) m[w + 'Sets'] = clamp0(m[w + 'Sets'] - 1)
        }
        this.setClosed = false // the set is no longer recorded, so it is no longer closed
        break
      }
      case 'reset':
        this._fromLiveState(NEUTRAL)
        break
      case 'set-state':
        this._fromLiveState(action.state || NEUTRAL)
        break
      default:
        return // unknown action (incl. indoor-only 'sub'): no-op
    }
    this.emit('state', this.getState())
  }

  // Swap every left<->right field, including names/colours, and flip serving. A court switch
  // and the between-sets change of ends both use this — the score follows the pair to its new
  // side (the sum is unchanged, so a switch never re-triggers itself).
  _swap() {
    const m = this.m
    // Server + Served travel with the pair to its new side, so the serve player follows the pair
    // across a change of ends (like the score does) and serve_player recomputes from serving.
    const pairs = ['Name', 'Short', 'Color', 'Points', 'Sets', 'TO', 'Server', 'Served']
    for (const p of pairs) {
      const tmp = m['left' + p]
      m['left' + p] = m['right' + p]
      m['right' + p] = tmp
    }
    if (m.serving === 'left') m.serving = 'right'
    else if (m.serving === 'right') m.serving = 'left'
    for (const r of this.results) { const t = r.left; r.left = r.right; r.right = t }
  }

  start() {} // no-op; present for the uniform Source interface
  stop() {}
}

// --------------------------------------------------------------------------------------
// Tiny self-check (mirrors test/*.mjs). Runs only when executed directly:
//     node src/beachSource.proposal.js
// Proves set-end / match-end / switch-due / technical-timeout fire on the right scores, that a
// switch-due point does NOT auto-swap the sides (the UI does, on operator confirm), and that the
// "−" button takes back a set it just awarded (which the same set can never be awarded twice),
// and that a typed score correction after a set end still leaves the NEXT set winnable.
// --------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
  const mk = () => new BeachSource()
  const pt = (s, side) => { s.apply({ type: 'point', side, delta: 1 }); return s.lastEvent }
  // Drive a sequence of single points ("L"/"R"); return the LAST point's event.
  const run = (s, seq) => { let e = null; for (const c of seq) e = pt(s, c === 'L' ? 'left' : 'right'); return e }

  // Court switch DUE: sets 1-2 change ends every 7 points. 3-3 (sum 6) then a point -> sum 7.
  // The source only FLAGS it (switch-due); it must NOT auto-swap the sides.
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'LLL' })
    s.apply({ type: 'team', side: 'right', short: 'RRR' })
    const e = run(s, 'LLLRRR'.split('')) // 3-3, sum 6, no switch on the 6th
    ok(e !== 'switch-due', 'no switch-due at sum 6 (3-3)')
    ok(pt(s, 'left') === 'switch-due', 'switch-due fires at sum 7 (4-3), sets 1-2')
    ok(s.getState().team_a_short === 'LLL', 'switch-due does NOT auto-swap (left pair unchanged)')
    ok(pt(s, 'right') !== 'switch-due', 'no switch-due at sum 8')
  }

  // Technical timeout: sets 1-2, automatic when the points sum reaches 21. 11-9 (sum 20) -> 11-10.
  {
    const s = mk()
    run(s, 'LLLLLLLLLLL'.split('')) // 11-0
    run(s, 'RRRRRRRRR'.split(''))   // 11-9, sum 20
    ok(pt(s, 'right') === 'tech-timeout', 'technical timeout fires when the sum reaches 21 (11-10)')
  }

  // Set end at 21 by >=2, and win-by-2 with no cap.
  {
    const s = mk()
    run(s, 'RRRRR'.split('')) // 0-5
    let e = null
    for (let i = 0; i < 20; i++) e = pt(s, 'left') // drive left up
    // left is now 20 with right 5 -> next point makes 21-5 (won)
    ok(s.getState().points_a === 20 && s.getState().points_b === 5, 'reached 20-5')
    ok(pt(s, 'left') === 'set-end', 'set ends at 21-5 (win by >=2)')
    ok(s.getState().sets_won_a === 1, 'set counted to the left pair')
  }
  {
    const s = mk()
    for (let i = 0; i < 20; i++) pt(s, 'left')
    for (let i = 0; i < 20; i++) pt(s, 'right') // 20-20
    ok(pt(s, 'left') !== 'set-end', 'no set win at 21-20 (needs a 2-point margin)')
    ok(pt(s, 'right') !== 'set-end', 'no set win at 21-21')
    pt(s, 'left') // 22-21
    ok(pt(s, 'left') === 'set-end', 'set ends at 23-21 (uncapped, win by 2)')
  }

  // Deciding set: target 15, court switch every 5, and a match-end on the 2nd set.
  {
    const s = mk()
    s.apply({ type: 'set-state', state: { ...NEUTRAL, sets_won_a: 1, sets_won_b: 1 } })
    ok(s._deciding === true, 'sets 1-1 is the deciding set')
    const e = run(s, 'LLLRR'.split('')) // 3-2, sum 5
    ok(e === 'switch-due', 'deciding set flags switch-due at sum 5 (3-2)')
    let last = null
    for (let i = 0; i < 12; i++) last = pt(s, 'left') // 15-2 -> set + match won
    ok(last === 'match-end', 'match ends when the 2nd set is won (deciding to 15)')
    ok(s.getState().sets_won_a === 2, 'winner has 2 sets')
  }

  // Best-of-3 match end from 1-0 (a normal 21 set, not the decider).
  {
    const s = mk()
    s.apply({ type: 'set-state', state: { ...NEUTRAL, sets_won_a: 1 } })
    ok(s._deciding === false, 'sets 1-0 is NOT the deciding set (target 21)')
    let last = null
    for (let i = 0; i < 21; i++) last = pt(s, 'left') // 21-0
    ok(last === 'match-end', 'match ends at 2-0 in sets')
  }

  // Change of ends between sets, but NOT before the deciding set.
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'AAA' })
    s.apply({ type: 'team', side: 'right', short: 'BBB' })
    s.apply({ type: 'set', side: 'left', delta: 1 }) // sets 1-0
    s.apply({ type: 'next-set' })
    ok(s.getState().team_a_short === 'BBB', 'ends change after a normal set (next-set swaps)')
    s.apply({ type: 'set', side: 'left', delta: 1 }) // now 1-1 (deciding next)
    s.apply({ type: 'next-set' })
    ok(s.getState().team_a_short === 'BBB', 'ends do NOT auto-swap going into the deciding set')
  }

  // The mis-tap: 20-19, "+", set awarded — then "−" to correct it. The set must come BACK off the
  // board, and the real 21-19 a rally later must count exactly once.
  {
    const s = mk()
    for (let i = 0; i < 19; i++) pt(s, 'right') // 0-19
    for (let i = 0; i < 20; i++) pt(s, 'left') // 20-19
    ok(pt(s, 'left') === 'set-end', 'the mis-tap closes the set at 21-19')
    ok(s.getState().sets_won_a === 1 && s.getState().set_results.length === 1, 'set counted once')
    s.apply({ type: 'point', side: 'left', delta: -1 }) // the correction
    const c = s.getState()
    ok(c.points_a === 20 && c.points_b === 19, 'the correction walks the score back to 20-19')
    ok(c.sets_won_a === 0 && c.set_results.length === 0, 'the set it awarded is taken back off the board')
    ok(pt(s, 'left') === 'set-end', 'the real set point still ends the set')
    ok(s.getState().sets_won_a === 1 && s.getState().set_results.length === 1, 'the set is counted ONCE, not twice')
  }

  // A closed set cannot be won a second time by the other pair (21-19 then pushed to 21-23).
  {
    const s = mk()
    for (let i = 0; i < 21; i++) pt(s, 'left') // 21-0, set to left
    for (let i = 0; i < 23; i++) pt(s, 'right') // right walks up to 23
    const st = s.getState()
    ok(st.sets_won_b === 0, 'the losing pair crossing the target does NOT award a second set')
    ok(st.set_results.length === 1, 'still exactly one recorded set')
  }

  // Serve-player tracking: a pair keeps its server while holding serve and alternates on regain.
  // Declared order L1 / R2, left serving first -> the serving digit walks L1, R2, L2, R1, L1…
  {
    const s = mk()
    const sp = () => s.getState().serve_player
    s.apply({ type: 'serve-order', first: 'left', leftServer: 1, rightServer: 2 })
    ok(sp() === 1, 'left serves first with player 1 (declared)')
    ok(pt(s, 'left') === null && sp() === 1, 'held serve -> same server (L1)')
    pt(s, 'right') // side-out to right, right's first turn -> its declared player 2
    ok(s.getState().serving_team === 'right' && sp() === 2, 'side-out to right -> R2 (first turn, no flip)')
    pt(s, 'right') // right holds
    ok(sp() === 2, 'right holds serve -> still R2')
    pt(s, 'left') // side-out back to left, left's 2nd turn -> flip to player 2
    ok(sp() === 2, 'left regains -> flips to L2')
    pt(s, 'right') // side-out to right, right's 2nd turn -> flip to player 1
    ok(sp() === 1, 'right regains -> flips to R1')
    pt(s, 'left') // left's 3rd turn -> flip back to 1
    ok(sp() === 1, 'left regains again -> back to L1')
  }

  // Manual override: set the serving pair's player, and flip with a bare serve-player.
  {
    const s = mk()
    const sp = () => s.getState().serve_player
    s.apply({ type: 'serve-order', first: 'left', leftServer: 1, rightServer: 1 })
    s.apply({ type: 'serve-player', value: 2 })
    ok(sp() === 2 && s.getState().server_a === 2, 'override sets the left serving pair to player 2')
    s.apply({ type: 'serve-player' }) // no value -> flip
    ok(sp() === 1, 'bare serve-player flips 2 -> 1')
    s.apply({ type: 'serve-player', side: 'right', value: 2 }) // override the non-serving pair
    ok(s.getState().server_b === 2 && sp() === 1, 'override targets a named side without touching the server digit')
  }

  // The serve player follows its pair across a change of ends, and survives a state round-trip.
  {
    const s = mk()
    s.apply({ type: 'serve-order', first: 'left', leftServer: 2, rightServer: 1 })
    s.apply({ type: 'swap' })
    ok(s.getState().server_b === 2, 'swap moves the left pair (server 2) to the right')
    ok(s.getState().serving_team === 'right' && s.getState().serve_player === 2, 'serving digit follows the pair after a swap')
    const s2 = mk()
    s2.apply({ type: 'set-state', state: s.getState() })
    ok(s2.getState().server_b === 2 && s2.getState().served_b === true, 'server + served survive a set-state round-trip')
  }

  // A typed score correction after a set end must NOT swallow the next set win. Every score on the
  // console is a tap-to-edit field, so zeroing the board by hand after a set is a one-tap flow —
  // and it used to leave the set flagged closed forever: the next genuine 21 fired no set-end, no
  // prompt, no interval, no horn, and the board just played on past 21.
  {
    const s = mk()
    for (let i = 0; i < 21; i++) pt(s, 'left') // 21-0, set to left
    ok(s.getState().sets_won_a === 1, 'the first set is awarded')
    s.apply({ type: 'point', side: 'left', value: 0 }) // the typed correction
    ok(s.setClosed === false, 'a typed score that no longer matches the recorded set reopens it')
    let last = null
    for (let i = 0; i < 21; i++) last = pt(s, 'right') // the right pair legitimately wins 21-0
    ok(last === 'set-end', 'the next genuine set win still fires set-end')
    const st = s.getState()
    ok(st.sets_won_a === 1 && st.sets_won_b === 1, 'and it is awarded (1-1, not stuck at 1-0)')
    ok(st.set_results.length === 2, 'both sets are in the strip')
  }

  // Typing the score back ONTO the recorded result re-closes the set, so the double-award the
  // minus-button fix was about stays fixed: a losing pair pushed up past the target after a
  // 21-19 must never take a second set off the same set.
  {
    const s = mk()
    for (let i = 0; i < 21; i++) pt(s, 'left') // 21-0, set to left
    s.apply({ type: 'point', side: 'right', value: 0 }) // a typed no-op correction: still 21-0
    ok(s.setClosed === true, 'a typed score that still matches the recorded set keeps it closed')
    for (let i = 0; i < 23; i++) pt(s, 'right')
    ok(s.getState().sets_won_b === 0, 'the losing pair crossing the target still awards nothing')
  }

  // A typed value may only REOPEN a set, never close one. "Do the points match the last pill?"
  // cannot tell "this set just ended" from "an EARLIER set had this score", and two sets ending
  // 21-19 is routine — so while typing could close a set, nudging the board to a previous set's
  // score and then tapping "−" once popped THAT set off the strip and off the set score.
  {
    const s = mk()
    s.apply({ type: 'set-state', state: { side_a: 'left', sets_won_a: 1, set_results: [{ a: 21, b: 19 }] } })
    ok(s.getState().set_results.length === 1, 'set 1 on the strip')
    s.apply({ type: 'point', side: 'left', value: 21 })
    s.apply({ type: 'point', side: 'right', value: 19 })
    ok(s.setClosed === false, 'typing an EARLIER set\'s score does not close the current set')
    s.apply({ type: 'point', side: 'right', delta: -1 })
    ok(s.getState().set_results.length === 1, 'and one "−" tap does not delete the earlier set')
    ok(s.getState().sets_won_a === 1, 'the set score survives it too')
  }

  // An upstream that pushes the in-progress set as a {a:0,b:0} placeholder must not make the set
  // on the board unwinnable — a set that can never end is the one failure the hall actually sees.
  {
    const s = mk()
    s.apply({ type: 'set-state', state: { side_a: 'left', sets_won_b: 1, set_results: [{ a: 18, b: 21 }, { a: 0, b: 0 }] } })
    ok(s.setClosed === false, 'a 0-0 placeholder result does not count as a closed set')
    let last = null
    for (let i = 0; i < 21; i++) last = pt(s, 'left')
    ok(last === 'set-end', 'and the set can still be won')
  }

  // A null options blob must not take the source down at construction.
  {
    let threw = false
    let s = null
    try { s = new BeachSource(null) } catch { threw = true }
    ok(!threw && s !== null && s.bestOf === 3, 'new BeachSource(null) constructs at the beach default (best-of-3)')
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
