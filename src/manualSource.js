// Manual control source for the LedBox appliance. The operator drives the board
// by hand — points, sets, timeouts, subs, serve, team names/colours — with no
// live match behind it. Internally the model is stored as LEFT/RIGHT (physical
// board sides); getState() projects it back to the a/b liveState contract with
// side_a always 'left' (a=left, b=right), which the mapper then resolves.

import { EventEmitter } from 'node:events'
import { formatRules } from './settings.js'

// Neutral starting board (mirrors the appliance's NEUTRAL constant).
const NEUTRAL = {
  side_a: 'left',
  team_a_name: '', team_a_short: 'HOME', team_a_color: '#2563eb',
  team_b_name: '', team_b_short: 'AWAY', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0,
  serving_team: 'left',
  ends_swapped: false,
}

const clamp0 = (n) => (n < 0 ? 0 : n)
const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

// Undo journal — shared by every scoring source (beach and basketball import it from here). A
// bounded stack of whole-model snapshots taken BEFORE each state-changing action, so "Undo last
// action" can take back any mistake — a swap, a serve change, a timeout, a sub, a next set —
// instead of only the ones that have their own "−". Snapshots rather than inverse actions on
// purpose: the rally rules have side effects (serve, set award, first server, beach server flips)
// that an inverse would have to re-derive, and one missed side effect is a board that disagrees
// with the hall after an undo. A snapshot is a few hundred bytes; 30 of them is nothing.
export const UNDO_MAX = 30

export class UndoJournal {
  constructor(max = UNDO_MAX) {
    this.max = max
    this.stack = [] // [{ snap, label }] oldest-first
  }

  // Record `before` as the way back from the action just applied — unless the action changed
  // nothing (a "−" at 0, a next-set on a finished game). A no-op on the stack would make the next
  // undo look like it did nothing, and the scorer would tap it again and lose a real action.
  record(before, after, label) {
    if (before === after) return false
    this.stack.push({ snap: before, label })
    if (this.stack.length > this.max) this.stack.shift()
    return true
  }

  pop() { return this.stack.pop() || null }
  clear() { this.stack = [] }
  get canUndo() { return this.stack.length > 0 }
  get label() { return this.stack.length ? this.stack[this.stack.length - 1].label : '' }
}

// Short human text for what an undo would revert ("Point KSCW", "Switch sides"), shown on the
// console's Undo button so the scorer knows WHAT they are about to take back before they tap it.
// Worded from the model BEFORE the action, so a swap's label still names the team that scored.
// `words` lets a sport rename the verbs it reuses (basketball: sub = foul, set = period).
export function undoLabel(action, m, words = {}) {
  const side = action.side === 'right' ? 'right' : action.side === 'left' ? 'left' : null
  const team = side ? (m[side + 'Short'] || m[side + 'Name'] || side) : ''
  const w = { point: 'Point', set: 'Sets', timeout: 'Timeout', sub: 'Sub', 'next-set': 'Next set', 'remove-set': 'Remove set', ...words }
  const d = Number(action.delta)
  const withTeam = (s) => (team ? `${s} ${team}` : s)
  switch (action.type) {
    case 'point':
      if (action.value != null) return withTeam('Score edit')
      if (d < 0) return withTeam(`${w.point} removed`)
      return d > 1 ? withTeam(`+${d}`) : withTeam(w.point)
    case 'set': return withTeam(w.set)
    case 'timeout': return withTeam(w.timeout)
    case 'sub': return withTeam(w.sub)
    case 'serve': return withTeam('Serve')
    case 'serve-order': return 'Serve order'
    case 'serve-player': return 'Server'
    case 'swap': return 'Switch sides'
    case 'team': return withTeam('Team edit')
    case 'next-set': return w['next-set']
    case 'remove-set': return w['remove-set']
    case 'reset': return 'Reset'
    case 'set-state': return 'Board edit'
    default: return String(action.type || '')
  }
}

// Set durations — shared by the volleyball and beach sources (beach imports these from here). A
// set's `dur` is its playing time in whole seconds, from the first scored rally to the set-winning
// point, read off the MONOTONIC clock: the board has no RTC, so its wall clock can jump by hours
// when NTP finally lands mid-match, and a set that "took" -3 h is worse than one with no time. The
// start (`m.setStart`) lives on the model so the undo journal's snapshots carry it — undoing a set
// point takes the dur off with the result and leaves the set running from the same first rally.
// It is NEVER restored from a saved state: monotonic time does not survive a restart, so a set
// resumed mid-play has no start and records no dur (omitted, not guessed). Sets already finished
// keep the dur they were saved with. (The one exception is this same process reloading the board
// it already holds, unchanged — see keepsSetStart below.)
// By definition the clock starts ON the first point, so the first rally's own playing time is not
// in the dur: a set is short by one rally (typically 20-40 s). The board has no reliable rally-start
// signal (the serve tap is optional and often skipped), and a guessed allowance would be worse.
export const monoNow = () => performance.now()

// A result entry's dur, if it carries a believable one; undefined otherwise (absent, junk, negative).
export function setDur(r) {
  const d = r && r.dur != null ? Number(r.dur) : NaN
  return Number.isFinite(d) && d >= 0 ? Math.round(d) : undefined
}

// `{ dur }` for a result entry or getState(), or nothing — so an untimed set carries no key at all
// rather than a null the app would have to tell apart from 0.
export const durField = (d) => (d != null ? { dur: d } : {})

// Whole seconds from `start` to `now` on the monotonic clock, or undefined when the set had no start.
export const elapsedSecs = (start, now) =>
  (start == null ? undefined : Math.max(0, Math.round((now - start) / 1000)))

// A set-state that reloads the very board this source already holds — same names, same score, same
// finished sets, in the same physical places (the console's Continue after "Just show the clock",
// which never touched the score) — is not a restart: the monotonic start this process took is still
// valid, so the set in play keeps it instead of losing its dur. Anything that differs (a typed
// score, another match) is a board edit and the set goes untimed, as documented above.
export function keepsSetStart(prevM, prevResults, m, results) {
  if (!prevM || prevM.setStart == null) return false
  const same = (k) => prevM[k] === m[k]
  if (!['leftName', 'rightName', 'leftPoints', 'rightPoints', 'leftSets', 'rightSets'].every(same)) return false
  if (prevResults.length !== results.length) return false
  return prevResults.every((r, i) => r.left === results[i].left && r.right === results[i].right)
}

// Indoor volleyball is best-of-5 by default: 3 sets take the match, and the 5th is the deciding
// set. The operator can pick best-of-3 (Settings ▸ Match format), so the numbers are NOT constants
// here — they come from settings.formatRules(), the one place that turns `bestOf` into sets-to-win
// and the deciding set's target. The console header derives "Final" from the same setting, and for
// a while the two disagreed: a best-of-3 read Final at 2 sets while the engine still wanted 3.
const DEFAULT_BEST_OF = 5
// Deciding set only: the first team to reach this many points prompts a change of ends.
const DECIDER_SWITCH_AT = 8

export class ManualSource extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.lastEvent = null // transient: the notable event from the last apply() (set-end / match-end / switch-due / set-closed / undo)
    this.lastJournaled = false // transient: did the last apply() add an undo step? (the history keeps its own in step)
    this.journal = new UndoJournal()
    // The monotonic clock set durations are measured on. Injectable only so the selftests can play
    // a set in no time; the appliance always gets performance.now().
    this._now = typeof opts?.now === 'function' ? opts.now : monoNow
    this.bestOf = DEFAULT_BEST_OF
    this.setFormat(opts)
    this._fromLiveState(NEUTRAL)
  }

  // Set (or change) the match format. Called at construction and again whenever the operator saves
  // Settings, so a format change mid-event takes effect without a restart. Only `bestOf` for now;
  // everything derived from it lives in formatRules().
  setFormat(opts) {
    // `|| {}` rather than a parameter default: a default only covers `undefined`, and the caller
    // that hands us a settings blob can just as easily hand us a null one — which used to throw
    // "Cannot destructure property 'bestOf' of null" out of the constructor.
    const { bestOf } = opts || {}
    if (bestOf != null) this.bestOf = Number(bestOf) === 3 ? 3 : 5
    return this.bestOf
  }

  // The rulebook for the CURRENT set: sets to win, whether this is the deciding set, and its
  // point target. Recomputed per call because it depends on the set score.
  _rules() {
    return formatRules(this.bestOf, this.m.leftSets, this.m.rightSets)
  }

  // The deciding set — both teams one set short of the match (2-2 in best-of-5, 1-1 in best-of-3).
  // Court switches in the deciding set hinge on this rather than on a hardcoded set number.
  get _deciding() {
    return this._rules().deciding
  }

  // The rules the set ON THE BOARD was played under. Normally that is _rules(), but once the set
  // has been awarded the tally already counts it — and after the deciding set that tally (3-2, or
  // 2-1) no longer reads as a deciding set, so the target jumped back to the normal one. The "−"
  // that takes back a mis-tapped match point then saw 14-13 as never having won "to 25", left the
  // set and the match standing, and the only way out was retyping the whole board.
  _boardRules() {
    const last = this.setClosed && this.results[this.results.length - 1]
    if (!last) return this._rules()
    const leftWon = last.left > last.right
    return formatRules(this.bestOf, clamp0(this.m.leftSets - (leftWon ? 1 : 0)), clamp0(this.m.rightSets - (leftWon ? 0 : 1)))
  }

  // Load the internal left/right model from an a/b liveState, honouring side_a.
  _fromLiveState(s) {
    const isALeft = (s.side_a || 'left') === 'left'
    const pick = (a, b) => (isALeft ? a : b)
    // Completed-set final scores, stored per physical side (swapped on _swap()). Built FIRST and
    // from objects only: this used to run after `this.m` was already replaced, so one null entry
    // (a hand-edited resume.json, a malformed direct-entry POST) threw on `r.a` with the new
    // points on the model and the old sets strip still beside them — no state event, a 500, and a
    // source that no longer matched the board until the next action.
    const results = (Array.isArray(s.set_results) ? s.set_results : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ left: num(pick(r.a, r.b)), right: num(pick(r.b, r.a)), ...durField(setDur(r)) }))
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
      leftSub: num(pick(s.subs_a, s.subs_b)),
      rightSub: num(pick(s.subs_b, s.subs_a)),
      serving: s.serving_team ?? null, // already 'left' | 'right' | null
      // Have the teams changed ends an odd number of times since the match began? Physical, like
      // every other field here, so it does not care about side_a. Taken from the state when it
      // carries it (the resume slot does); a state that doesn't say keeps what we had.
      endsSwapped: s.ends_swapped != null ? !!s.ends_swapped : !!(this.m && this.m.endsSwapped),
      // When the set on the board started, on the monotonic clock. Never taken from a state — see
      // setDur above: whatever started before this load was on a clock that may no longer exist.
      setStart: null,
    }
    this.results = results
    this._syncClosed()
    // Who served first in the set now on the board — only knowable at 0-0. Mid-set we cannot tell,
    // so the alternation at the next set break falls back to leaving the arrow where it is.
    this.m.firstServer = (this.m.leftPoints === 0 && this.m.rightPoints === 0) ? this.m.serving : null
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

  // The whole mutable model as one string: what the undo journal stores, and how it tells a real
  // change from a no-op. bestOf is left out on purpose — it is a setting, not match state.
  _snap() {
    return JSON.stringify({ m: this.m, results: this.results, setClosed: this.setClosed })
  }

  _restore(snap) {
    const s = JSON.parse(snap)
    this.m = s.m
    this.results = s.results
    this.setClosed = !!s.setClosed
  }

  get canUndo() { return this.journal.canUndo }
  get undoLabel() { return this.journal.label }
  // A new game, a Continue or a boot-time resume starts a fresh journal: "undo" reaching back
  // across it would resurrect a different match.
  clearUndo() { this.journal.clear() }

  // Take back the last state-changing action. 'undo-empty' (and no state event) when there is
  // nothing left, so the console can say so instead of silently doing nothing.
  _undo() {
    const step = this.journal.pop()
    this.lastJournaled = false
    if (!step) { this.lastEvent = 'undo-empty'; return }
    this._restore(step.snap)
    this.lastEvent = 'undo'
    this.emit('state', this.getState())
  }

  // Is this +1 on the side that already WON the set now showing? The SET ENDED card is not modal
  // and the board holds the final score until the interval starts, so a second tap on the set point
  // (a double-tap, or a scorer who didn't see the first one land) went to 26-10 on the phone AND
  // the wall while the history said 25-10. The loser's + and every − stay open: those are how a
  // mis-scored rally is corrected before the interval.
  _setClosedFor(side) {
    const last = this._closedWinner()
    return !!last && last.side === side &&
      // Only while the board still HOLDS the closing score. A loser's + correction then the
      // winner's − (25-23 → 25-24 → 24-24) left setClosed true, and refusing on the flag alone
      // locked the winner out of scoring for the rest of the set.
      this.m.leftPoints === last.left && this.m.rightPoints === last.right
  }

  // The last recorded set and who won it, while this set is still counted as closed.
  _closedWinner() {
    const last = this.setClosed && this.results[this.results.length - 1]
    if (!last || last.left === last.right) return null
    return { ...last, side: last.left > last.right ? 'left' : 'right' }
  }

  // Project the left/right model back to the a/b liveState contract (a=left).
  getState() {
    const m = this.m
    return {
      side_a: 'left',
      team_a_name: m.leftName, team_a_short: m.leftShort, team_a_color: m.leftColor,
      team_b_name: m.rightName, team_b_short: m.rightShort, team_b_color: m.rightColor,
      points_a: m.leftPoints, points_b: m.rightPoints,
      sets_won_a: m.leftSets, sets_won_b: m.rightSets,
      timeouts_a: m.leftTO, timeouts_b: m.rightTO,
      subs_a: m.leftSub, subs_b: m.rightSub,
      serving_team: m.serving,
      // Every other field says who is on which side NOW; this says whether that is the reverse of
      // where they started. The match history needs it to keep crediting a point to the TEAM that
      // scored it rather than to whoever happens to be standing on the left after a change of ends.
      ends_swapped: m.endsSwapped,
      set_results: this.results.map((r) => ({ a: r.left, b: r.right, ...durField(r.dur) })),
      // The format the operator picked, as sets-to-win. livePush decides 'final' from this; without
      // it a best-of-3 won 2:0 read 'final' only on the push carrying the match-end event, and the
      // next tap (serve, re-attach, restore) published it as 'live' again, in 'Set 3'.
      sets_to_win: formatRules(this.bestOf, 0, 0).toWin,
    }
  }

  apply(action = {}) {
    if (action && action.type === 'undo') return this._undo()
    const m = this.m
    this.lastEvent = null
    this.lastJournaled = false
    const snap = this._snap()
    const label = undoLabel(action, m)
    const key = (base, side) => (side === 'right' ? 'right' : 'left') + base
    switch (action.type) {
      case 'point': {
        const side = action.side === 'right' ? 'right' : 'left'
        const other = side === 'left' ? 'right' : 'left'
        const before = m[side + 'Points']
        // Guarded before anything moves (serve included) and without a state event: the board is
        // already showing the right thing.
        if (action.value == null && Number(action.delta) > 0 && this._setClosedFor(side)) {
          this.lastEvent = 'set-closed'
          return
        }
        // Absolute set (an operator correction typed in) just sets the number — no serve
        // change, no set-win detection. Only a +delta drives the rally rules below. It DOES
        // re-derive setClosed, though: every score on the console is a tap-to-edit field, so
        // typing one after a set end (zeroing the board by hand instead of tapping NEXT SET is a
        // one-tap flow) left setClosed stuck true — and the next genuine set win then fired no
        // set-end at all. No prompt, no interval, no horn, the board playing past 25 forever.
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
        const wasServing = m.serving // who served this rally — the set's first server is read off it
        m[side + 'Points'] = clamp0(before + d)
        const { toWin, deciding, target } = this._boardRules() // deciding = the last set (5th of 5, 3rd of 3)
        // Evaluated against the OTHER side's (unchanged) score, so the same predicate answers both
        // "was the set won before this tap" and "is it won after it" — that symmetry is what makes
        // the minus button able to undo a set instead of only moving the points.
        const won = (p) => p >= target && p - m[other + 'Points'] >= 2
        const wonBefore = won(before)
        const wonNow = won(m[side + 'Points'])
        if (d > 0) {
          // Rally scoring: the side that wins the point serves next.
          m.serving = side
          // Record who opened the set — the next set's first serve alternates off it (FIVB 12.1.2).
          if (m.firstServer == null && m.leftPoints + m.rightPoints === 1) m.firstServer = wasServing
          // The first rally of the set starts its clock. Keyed on the board having been at 0-0, so a
          // set resumed or typed in mid-play never starts one and its dur is left out.
          if (before + m[other + 'Points'] === 0) m.setStart = this._now()
          if (!wonBefore && wonNow && !this.setClosed) {
            // Set win: first to 25 (15 in the deciding set) by >=2, uncapped. Fires once, on the
            // transition — and `setClosed` keeps it to once per set. The SET ENDED prompt is not
            // modal, so after a 25-23 the operator can still push the LOSING side up while
            // correcting; at 25-27 that used to award a second set and the board read 1-1 on a set
            // only one team had won.
            m[side + 'Sets'] = clamp0(m[side + 'Sets'] + 1)
            // setStart stays: a "−" that takes this set back leaves it running from the same rally.
            this.results.push({ left: m.leftPoints, right: m.rightPoints, ...durField(elapsedSecs(m.setStart, this._now())) })
            this.setClosed = true
            this.lastEvent = m[side + 'Sets'] >= toWin ? 'match-end' : 'set-end'
          } else if (deciding && before < DECIDER_SWITCH_AT && m[other + 'Points'] < DECIDER_SWITCH_AT && m[side + 'Points'] >= DECIDER_SWITCH_AT) {
            // Deciding set: the first team to reach 8 flags that a change of ends is DUE. The source
            // does NOT swap — the UI confirms ("Switch sides?"), blinks COURT SWITCH, then sends `swap`.
            this.lastEvent = 'switch-due'
          }
        } else if (d < 0 && !wonNow && this._closedWinner()?.side === side) {
          // Keyed on the recorded WINNER, not on "was a win before this tap": that also catches
          // 25-24 → 24-24 after a loser's correction (the set stayed awarded at a tie), and stops
          // the loser's − at 25-27 → 25-26 popping a set the loser never had.
          // Walking the score back below the winning condition IS the undo of the set that score
          // awarded. Without this the "−" only moved the points: a mis-tapped 25-23 left the set
          // counted and its pill in the strip, and then the REAL 25-23 a rally later counted it a
          // second time — two identical pills and 2-0 in front of the hall on a 1-0 match.
          this.results.pop()
          m[side + 'Sets'] = clamp0(m[side + 'Sets'] - 1)
          this.setClosed = false
        }
        break
      }
      // For set/timeout/sub, action.value sets the number absolutely (a typed correction);
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
      case 'sub':
        m[key('Sub', action.side)] = action.value != null
          ? clamp0(Number(action.value) || 0)
          : clamp0(m[key('Sub', action.side)] + (Number(action.delta) || 0))
        break
      case 'serve':
        m.serving = action.side === 'right' ? 'right' : 'left'
        // At 0-0 the operator is declaring who opens the set, which is what the next set's first
        // serve alternates from — not just correcting the arrow mid-rally.
        if (m.leftPoints === 0 && m.rightPoints === 0) m.firstServer = m.serving
        break
      case 'swap':
        this._swap()
        break
      case 'team': {
        const side = action.side === 'right' ? 'right' : 'left'
        // Stored in capitals, matching what toLeftRight() paints. The mapper is what guarantees
        // the PANEL never shows "volz"; storing it upper-cased is what keeps everything derived
        // from state in agreement with the panel — the end-of-match result lines, the saved match
        // history and the "Add a timeout for X?" prompt are all built in the browser from this
        // value, and would otherwise be the only place the original case survived.
        if (action.name != null) m[side + 'Name'] = String(action.name).toUpperCase()
        if (action.short != null) m[side + 'Short'] = String(action.short).toUpperCase()
        if (action.color != null) m[side + 'Color'] = String(action.color)
        break
      }
      case 'next-set': {
        // Start the next set: clear points AND the per-set counters (timeouts and
        // substitutions reset every set — FIVB), then switch ends. Teams change sides
        // after every set EXCEPT going into the deciding 5th (its sides are the coin toss).
        const { toWin } = this._rules()
        // Going into the deciding set, and only there, BOTH the serve and the sides come from a
        // fresh coin toss instead of from the previous set — one test, used for both, so the two
        // can never drift apart.
        const intoDeciding = m.leftSets + m.rightSets === (toWin - 1) * 2
        m.leftPoints = 0
        m.rightPoints = 0
        m.leftTO = 0
        m.rightTO = 0
        m.leftSub = 0
        m.rightSub = 0
        // FIVB 12.1.2: the team that did NOT serve first in the previous set serves first in this
        // one. Nothing reassigned m.serving here, so the arrow just stayed with whoever took the
        // last rally — wrong at roughly half of all set starts, and the console's serve-order
        // prompt is beach-only, so nothing asked the operator either.
        if (m.firstServer && !intoDeciding) m.serving = m.firstServer === 'left' ? 'right' : 'left'
        if (!intoDeciding) this._swap()
        // Whoever opens the new set is its first server (the swap above has already moved sides).
        m.firstServer = m.serving
        m.setStart = null // its clock starts at its first rally, not at the interval
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
      case 'set-state': {
        const prevM = this.m, prevResults = this.results
        this._fromLiveState(action.state || NEUTRAL)
        if (keepsSetStart(prevM, prevResults, this.m, this.results)) this.m.setStart = prevM.setStart
        break
      }
      default:
        return // unknown action: no-op (server validates before calling)
    }
    this.lastJournaled = this.journal.record(snap, this._snap(), label)
    this.emit('state', this.getState())
  }

  // Swap every left<->right field, including names/colours, and flip serving.
  _swap() {
    const m = this.m
    const pairs = ['Name', 'Short', 'Color', 'Points', 'Sets', 'TO', 'Sub']
    for (const p of pairs) {
      const tmp = m['left' + p]
      m['left' + p] = m['right' + p]
      m['right' + p] = tmp
    }
    if (m.serving === 'left') m.serving = 'right'
    else if (m.serving === 'right') m.serving = 'left'
    // The set's first server is a TEAM, so it travels with that team across the change of ends.
    if (m.firstServer === 'left') m.firstServer = 'right'
    else if (m.firstServer === 'right') m.firstServer = 'left'
    for (const r of this.results) { const t = r.left; r.left = r.right; r.right = t }
    m.endsSwapped = !m.endsSwapped
  }

  start() {} // no-op; present for the uniform Source interface
  stop() {}
}

// --------------------------------------------------------------------------------------
// Tiny self-check (mirrors test/*.mjs and the beach/basketball sources). Runs only when
// executed directly:   node src/manualSource.js
// Proves set-end / match-end fire at the right scores, that the deciding set flags a court
// switch DUE at first-to-8 WITHOUT auto-swapping, that the between-set change of ends
// swaps (except going into the deciding set), that the "−" button takes back a set it just
// awarded (and that the same set can never be awarded twice), that the first serve alternates
// between sets, that a best-of-3 format changes the targets it should, and that a typed score
// correction after a set end still leaves the NEXT set winnable.
// --------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  let pass = 0, fail = 0
  const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
  const mk = () => new ManualSource()
  const pt = (s, side) => { s.apply({ type: 'point', side, delta: 1 }); return s.lastEvent }
  const decider = (over = {}) => {
    const s = mk()
    s.apply({ type: 'set-state', state: { side_a: 'left', team_a_short: 'LLL', team_b_short: 'RRR', sets_won_a: 2, sets_won_b: 2, ...over } })
    return s
  }

  // Set win: first to 25 by >=2 counts a set (not yet the match).
  {
    const s = mk()
    for (let i = 0; i < 24; i++) pt(s, 'left') // 24-0
    ok(pt(s, 'left') === 'set-end', 'set ends at 25-0 (win by >=2)')
    ok(s.getState().sets_won_a === 1, 'the set is counted to the left team')
  }

  // Win-by-2, uncapped: no set at 25-24 or 25-25.
  {
    const s = mk()
    for (let i = 0; i < 24; i++) { pt(s, 'left'); pt(s, 'right') } // 24-24
    ok(pt(s, 'left') !== 'set-end', 'no set win at 25-24 (needs a 2-point margin)')
    ok(pt(s, 'right') !== 'set-end', 'no set win at 25-25')
    pt(s, 'left') // 26-25
    ok(pt(s, 'left') === 'set-end', 'set ends at 27-25 (uncapped, win by 2)')
  }

  // Deciding set (2-2): target 15, and the first team to reach 8 flags switch-due — no auto-swap.
  {
    const s = decider()
    ok(s._deciding === true, 'sets 2-2 is the deciding set')
    for (let i = 0; i < 7; i++) pt(s, 'left') // 7-0
    ok(s.lastEvent !== 'switch-due', 'no switch-due before 8 in the deciding set')
    ok(pt(s, 'left') === 'switch-due', 'switch-due fires when the first team reaches 8 (deciding set)')
    ok(s.getState().team_a_short === 'LLL', 'switch-due does NOT auto-swap (left team unchanged)')
  }

  // Outside the deciding set, reaching 8 flags nothing.
  {
    const s = mk()
    for (let i = 0; i < 8; i++) pt(s, 'left') // 8-0 in set 1
    ok(s.lastEvent !== 'switch-due', 'no switch-due at 8 outside the deciding set')
  }

  // Deciding set win at 15, and match-end at the 3rd set.
  {
    const s = decider()
    let last = null
    for (let i = 0; i < 15; i++) last = pt(s, 'left') // 15-0
    ok(last === 'match-end', 'winning the deciding set (to 15) ends the match')
    ok(s.getState().sets_won_a === 3, 'the winner has 3 sets')
  }

  // Change of ends between sets, but NOT going into the deciding 5th set.
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'AAA' })
    s.apply({ type: 'team', side: 'right', short: 'BBB' })
    s.apply({ type: 'set', side: 'left', delta: 1 }) // sets 1-0
    s.apply({ type: 'next-set' })
    ok(s.getState().team_a_short === 'BBB', 'ends change after a normal set (next-set swaps)')
    const d = decider({ team_a_short: 'AAA', team_b_short: 'BBB' }) // 2-2, deciding next
    d.apply({ type: 'next-set' })
    ok(d.getState().team_a_short === 'AAA', 'ends do NOT auto-swap going into the deciding set')
  }

  // The mis-tap that started all this: 24-23, "+", set awarded — then "−" to correct it. The set
  // must come BACK off the board, and the real 25-23 a rally later must count exactly once.
  {
    const s = mk()
    for (let i = 0; i < 23; i++) pt(s, 'right') // 0-23
    for (let i = 0; i < 24; i++) pt(s, 'left') // 24-23
    ok(pt(s, 'left') === 'set-end', 'the mis-tap closes the set at 25-23')
    ok(s.getState().sets_won_a === 1 && s.getState().set_results.length === 1, 'set counted once')
    s.apply({ type: 'point', side: 'left', delta: -1 }) // the correction
    const c = s.getState()
    ok(c.points_a === 24 && c.points_b === 23, 'the correction walks the score back to 24-23')
    ok(c.sets_won_a === 0, 'the set it awarded is taken back off the board')
    ok(c.set_results.length === 0, 'and its pill is gone from the set strip')
    ok(pt(s, 'left') === 'set-end', 'the real set point still ends the set')
    const f = s.getState()
    ok(f.sets_won_a === 1 && f.set_results.length === 1, 'the set is counted ONCE, not twice')
  }

  // A closed set cannot be won a second time by the other side. After 25-23 the operator pushes
  // the losing side up while correcting; at 25-27 that used to make it 1-1 on one set.
  {
    const s = mk()
    for (let i = 0; i < 25; i++) pt(s, 'left') // 25-0, set to left
    ok(s.getState().sets_won_a === 1, 'left has the set')
    for (let i = 0; i < 27; i++) pt(s, 'right') // right walks up to 27
    const st = s.getState()
    ok(st.sets_won_b === 0, 'the losing side crossing the target does NOT award a second set')
    ok(st.set_results.length === 1, 'still exactly one recorded set')
  }

  // Undo only applies to a set the rally engine actually awarded — a "−" that never crosses the
  // winning score must not touch the set tally.
  {
    const s = mk()
    s.apply({ type: 'set', side: 'left', delta: 1 }) // 1-0 in sets, 0-0 in points
    for (let i = 0; i < 10; i++) pt(s, 'left')
    s.apply({ type: 'point', side: 'left', delta: -1 }) // 9-0
    ok(s.getState().sets_won_a === 1, 'a mid-set correction leaves the set tally alone')
  }

  // First serve alternates between sets (FIVB 12.1.2): the team that opened set 1 receives in set 2.
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'AAA' })
    s.apply({ type: 'team', side: 'right', short: 'BBB' })
    s.apply({ type: 'serve', side: 'left' }) // AAA opens set 1
    for (let i = 0; i < 25; i++) pt(s, 'left') // AAA also takes the last rally
    s.apply({ type: 'next-set' })
    const st = s.getState()
    const servingShort = st.serving_team === 'left' ? st.team_a_short : st.team_b_short
    ok(servingShort === 'BBB', 'the team that did not serve first in set 1 serves first in set 2')
    for (let i = 0; i < 25; i++) pt(s, 'right') // whoever is on the right takes set 2
    s.apply({ type: 'next-set' })
    const st3 = s.getState()
    const serving3 = st3.serving_team === 'left' ? st3.team_a_short : st3.team_b_short
    ok(serving3 === 'AAA', 'and it alternates back for set 3')
  }

  // Best-of-3: 2 sets take the match and the DECIDING set is the 3rd (target 15), all of it read
  // from settings.formatRules() rather than a constant in here.
  {
    const s = mk()
    s.setFormat({ bestOf: 3 })
    s.apply({ type: 'set-state', state: { side_a: 'left', sets_won_a: 1, sets_won_b: 1 } })
    ok(s._deciding === true, 'best-of-3: sets 1-1 is the deciding set')
    let last = null
    for (let i = 0; i < 15; i++) last = pt(s, 'left') // 15-0
    ok(last === 'match-end', 'best-of-3: winning the deciding set (to 15) ends the match')
    ok(s.getState().sets_won_a === 2, 'best-of-3: the winner has 2 sets')
    const t = mk()
    ok(t._deciding === false && t.bestOf === 5, 'the default stays best-of-5 (indoor)')
  }

  // A typed score correction after a set end must NOT swallow the next set win. Every score on the
  // console is a tap-to-edit field, so zeroing the board by hand after a set is a one-tap flow —
  // and it used to leave the set flagged closed forever: the next genuine 25 fired no set-end, no
  // prompt, no interval, no horn, and the board just played on past 25.
  {
    const s = mk()
    for (let i = 0; i < 25; i++) pt(s, 'left') // 25-0, set to left
    ok(s.getState().sets_won_a === 1, 'the first set is awarded')
    s.apply({ type: 'point', side: 'left', value: 0 }) // the typed correction
    ok(s.setClosed === false, 'a typed score that no longer matches the recorded set reopens it')
    let last = null
    for (let i = 0; i < 25; i++) last = pt(s, 'right') // the right team legitimately wins 25-0
    ok(last === 'set-end', 'the next genuine set win still fires set-end')
    const st = s.getState()
    ok(st.sets_won_a === 1 && st.sets_won_b === 1, 'and it is awarded (1-1, not stuck at 1-0)')
    ok(st.set_results.length === 2, 'both sets are in the strip')
  }

  // Typing the score back ONTO the recorded result re-closes the set, so the double-award the
  // minus-button fix was about stays fixed: a losing side pushed up past the target after a
  // 25-23 must never take a second set off the same set.
  {
    const s = mk()
    for (let i = 0; i < 25; i++) pt(s, 'left') // 25-0, set to left
    s.apply({ type: 'point', side: 'right', value: 0 }) // a typed no-op correction: still 25-0
    ok(s.setClosed === true, 'a typed score that still matches the recorded set keeps it closed')
    for (let i = 0; i < 27; i++) pt(s, 'right')
    ok(s.getState().sets_won_b === 0, 'the losing side crossing the target still awards nothing')
  }

  // Two sets ending on the same score is routine, and "do the points match the last pill?" cannot
  // tell "this set just ended" from "an EARLIER set had this score". So a typed value may only
  // reopen a set, never close one: while it could close one, typing the current set to a previous
  // set's score marked it closed, and the very next "−" tap popped that older set off the strip and
  // off the set score — the board going 1-0 → 0-0 mid-match from a single correction tap.
  {
    const s = mk()
    for (let i = 0; i < 25; i++) pt(s, 'left')
    for (let i = 0; i < 23; i++) pt(s, 'right')
    ok(s.getState().set_results.length === 1, 'set 1 recorded')
    s.apply({ type: 'next-set' })
    ok(s.setClosed === false, 'the new set starts open')
    // Type the CURRENT set to exactly the pill the previous set left behind.
    const pill = s.getState().set_results[0]
    s.apply({ type: 'point', side: 'left', value: pill.a })
    s.apply({ type: 'point', side: 'right', value: pill.b })
    ok(s.setClosed === false, 'typing an EARLIER set\'s score does not close the current set')
    s.apply({ type: 'point', side: 'right', delta: -1 })
    ok(s.getState().set_results.length === 1, 'and one "−" tap does not delete the earlier set')
    ok(s.getState().sets_won_a + s.getState().sets_won_b === 1, 'the set score survives it too')
  }

  // An upstream that pushes the in-progress set as a {a:0,b:0} placeholder must not make the set
  // on the board unwinnable — a set that can never end is the one failure the hall actually sees.
  {
    const s = mk()
    s.apply({ type: 'set-state', state: { side_a: 'left', sets_won_a: 1, set_results: [{ a: 25, b: 20 }, { a: 0, b: 0 }] } })
    ok(s.setClosed === false, 'a 0-0 placeholder result does not count as a closed set')
    let last = null
    for (let i = 0; i < 25; i++) last = pt(s, 'left')
    ok(last === 'set-end', 'and the set can still be won')
  }

  // Going into the deciding set BOTH the sides and the first serve come from a fresh coin toss —
  // the ends already skipped the swap there, and the serve has to skip its alternation with them.
  {
    const d = decider({ team_a_short: 'AAA', team_b_short: 'BBB', serving_team: 'left' })
    d.apply({ type: 'next-set' })
    const st = d.getState()
    ok(st.team_a_short === 'AAA', 'ends do NOT swap going into the deciding set')
    ok(st.serving_team === 'left', 'and the serve does NOT alternate into it either (coin toss)')
  }

  // The "−" must take back a mis-tapped MATCH point too. Once the deciding set is awarded the tally
  // reads 3-2 — not a deciding set any more — and the undo used to judge 14-13 against 25.
  {
    const s = decider()
    for (let i = 0; i < 13; i++) { pt(s, 'left'); pt(s, 'right') } // 13-13
    pt(s, 'left') // 14-13
    ok(pt(s, 'left') === 'match-end', 'the mis-tap ends the match at 15-13')
    s.apply({ type: 'point', side: 'left', delta: -1 })
    const st = s.getState()
    ok(st.sets_won_a === 2 && st.set_results.length === 0 && st.points_a === 14, 'the "−" takes the deciding set back')
    ok(pt(s, 'left') === 'match-end', 'and the real match point still ends the match')
  }

  // The double-tap at set point: 24-10, two quick "+" — the second must not make it 26-10.
  {
    const s = mk()
    for (let i = 0; i < 10; i++) pt(s, 'right')
    for (let i = 0; i < 24; i++) pt(s, 'left') // 24-10
    ok(pt(s, 'left') === 'set-end', 'the first tap wins the set 25-10')
    let emitted = 0
    s.on('state', () => { emitted++ })
    ok(pt(s, 'left') === 'set-closed', 'the second tap on the winner is refused as set-closed')
    const st = s.getState()
    ok(st.points_a === 25 && st.sets_won_a === 1 && st.set_results.length === 1, 'the board stays 25-10, one set')
    ok(emitted === 0 && s.lastJournaled === false, 'a refused tap neither repaints nor adds an undo step')
    ok(pt(s, 'right') !== 'set-closed' && s.getState().points_b === 11, "the loser's + is still a correction")
    s.apply({ type: 'point', side: 'left', delta: -1 })
    ok(s.getState().sets_won_a === 0 && s.getState().points_a === 24, "and the winner's − still takes the set back")
  }

  // General undo: every state-changing action is one step back, labelled for the console.
  {
    const s = mk()
    s.apply({ type: 'team', side: 'left', short: 'KSCW' })
    pt(s, 'left')
    ok(s.canUndo && s.undoLabel === 'Point KSCW', 'undo offers the point just scored, by team')
    s.apply({ type: 'swap' })
    ok(s.undoLabel === 'Switch sides', 'a swap is labelled as such')
    s.apply({ type: 'timeout', side: 'right', delta: 1 })
    s.apply({ type: 'undo' })
    ok(s.lastEvent === 'undo' && s.getState().timeouts_b === 0, 'undo takes the timeout back')
    s.apply({ type: 'undo' })
    ok(s.getState().team_a_short === 'KSCW' && s.getState().points_a === 1, 'the next undo reverses the swap')
    s.apply({ type: 'point', side: 'left', delta: -1 }) // 0-0: a real change
    s.apply({ type: 'point', side: 'left', delta: -1 }) // still 0-0: a no-op
    ok(s.lastJournaled === false, 'a no-op action adds no undo step')
    s.apply({ type: 'undo' })
    ok(s.getState().points_a === 1, 'so one undo reverses the last REAL change')
    // Undoing a set win restores the set, its pill and the closed flag exactly.
    const t = mk()
    for (let i = 0; i < 25; i++) pt(t, 'left')
    t.apply({ type: 'next-set' })
    t.apply({ type: 'undo' })
    ok(t.getState().points_a === 25 && t.setClosed === true, 'undoing next-set brings back the finished set, still closed')
    t.apply({ type: 'undo' })
    ok(t.getState().sets_won_a === 0 && t.getState().points_a === 24 && t.setClosed === false, 'and undoing the set point reopens it')
    // Bounded, and empty says so.
    const u = mk()
    for (let i = 0; i < 40; i++) u.apply({ type: 'timeout', side: 'left', delta: 1 })
    ok(u.journal.stack.length === UNDO_MAX, 'the journal is bounded')
    u.clearUndo()
    let emitted = 0
    u.on('state', () => { emitted++ })
    u.apply({ type: 'undo' })
    ok(u.lastEvent === 'undo-empty' && emitted === 0 && !u.canUndo, 'an empty journal answers undo-empty and changes nothing')
    // Reset is undoable too — the most expensive mis-tap of all.
    const r = mk()
    pt(r, 'left'); pt(r, 'left')
    r.apply({ type: 'reset' })
    r.apply({ type: 'undo' })
    ok(r.getState().points_a === 2, 'undo brings a reset match back')
  }

  // Set durations: first rally to set point on the monotonic clock, in whole seconds, on the result.
  {
    let t = 5000 // the monotonic clock's origin is arbitrary; a set is timed from its own first rally
    const s = new ManualSource({ now: () => t })
    t += 60000 // the warm-up, before the first rally, is not part of the set
    pt(s, 'left')
    t += 1499400
    for (let i = 1; i < 24; i++) pt(s, 'left') // 24-0
    t += 600
    ok(pt(s, 'left') === 'set-end' && s.getState().set_results[0].dur === 1500, 'a set records its playing time (25:00 → 1500 s)')
    // Undo of the set point takes the dur off with the result and leaves the set running.
    s.apply({ type: 'undo' })
    ok(s.getState().set_results.length === 0 && s.m.setStart === 65000, 'undoing the set point removes the dur and keeps the running start')
    t += 30000
    pt(s, 'left')
    ok(s.getState().set_results[0].dur === 1530, 'and the real set point is timed from the same first rally')
    // So does the "−" that takes a mis-tapped set back.
    s.apply({ type: 'point', side: 'left', delta: -1 })
    ok(s.getState().set_results.length === 0 && s.m.setStart === 65000, 'the "−" on a set point also keeps the set running')
    pt(s, 'left')
    // The interval between sets is not part of the next one either.
    s.apply({ type: 'next-set' })
    ok(s.m.setStart === null, 'next-set clears the start: the new set has not begun yet')
    t += 180000
    pt(s, 'right')
    t += 900000
    for (let i = 1; i < 25; i++) pt(s, 'right')
    const st = s.getState()
    ok(st.set_results.map((r) => r.dur).join(',') === '1530,900', 'set 2 is timed from its own first rally')
    ok(st.set_results[0].b === 25 && st.set_results[0].dur === 1530, 'the dur travels with its set across the change of ends')
    // Restarted mid-set: finished sets keep their dur, the set in play gets none — never a guess.
    const r = new ManualSource({ now: () => t })
    r.apply({ type: 'set-state', state: { ...st, points_a: 10, points_b: 12, set_results: st.set_results } })
    ok(r.getState().set_results.map((x) => x.dur).join(',') === '1530,900', 'restored sets keep the dur they were saved with')
    t += 5000
    for (let i = 0; i < 15; i++) pt(r, 'left') // 25-12
    ok(r.getState().set_results.length === 3 && !('dur' in r.getState().set_results[2]), 'a set resumed mid-play records no dur')
    // Restored at 0-0 between sets: nothing was missed, so the next set is timed normally.
    const z = new ManualSource({ now: () => t })
    z.apply({ type: 'set-state', state: { ...st, points_a: 0, points_b: 0 } })
    pt(z, 'left'); t += 700000
    for (let i = 1; i < 25; i++) pt(z, 'left')
    ok(z.getState().set_results[2]?.dur === 700, 'a set that starts after the restore is timed')
    // A result typed or pushed without a believable dur carries none.
    const j = mk()
    j.apply({ type: 'set-state', state: { sets_won_a: 1, set_results: [{ a: 25, b: 20, dur: -1 }, { a: 1, b: 2, dur: 'x' }] } })
    ok(j.getState().set_results.every((x) => !('dur' in x)), 'a junk dur in a loaded state is dropped')
    // Same process reloads its own board unchanged (Continue after "Just show the clock"): the set
    // in play keeps its start. A board that differs is an edit and goes untimed.
    const c = new ManualSource({ now: () => t })
    pt(c, 'left'); const began = c.m.setStart
    t += 400000
    for (let i = 0; i < 9; i++) pt(c, 'right') // 1-9
    c.apply({ type: 'set-state', state: c.getState() })
    ok(c.m.setStart === began, 'an unchanged same-process reload keeps the running set start')
    t += 200000
    for (let i = 0; i < 16; i++) pt(c, 'right') // 1-25
    ok(c.getState().set_results[0].dur === 600, 'and the set is timed from its real first rally')
    const e = new ManualSource({ now: () => t })
    pt(e, 'left')
    e.apply({ type: 'set-state', state: { ...e.getState(), points_a: 7 } })
    ok(e.m.setStart === null, 'a reload that changes the score drops the start (board edit)')
  }

  // A null options blob must not take the source down at construction.
  {
    let threw = false
    let s = null
    try { s = new ManualSource(null) } catch { threw = true }
    ok(!threw && s !== null && s.bestOf === 5, 'new ManualSource(null) constructs at the default format')
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
