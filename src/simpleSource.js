// "Simple scoreboard" — two numbers and nothing else.
//
// The other three sources model a sport: sets, timeouts, substitutions, serve, periods, fouls,
// set-win detection, change-of-ends prompts. This one deliberately models none of it. It exists
// for everything the club puts on that panel which ISN'T one of those three — a training game, a
// tournament format nobody wrote a source for, a school event — where the operator wants a score
// on the wall and no rules engine deciding things behind their back.
//
// The design rule that follows from that: NOTHING here is automatic. No set ends, no side
// switches, no counter maxes out, no horn fires. The number goes up when the operator taps + and
// down when they tap −, and that is the whole contract. A sport source guessing wrong is
// recoverable; this one cannot guess at all, which is the point.
//
// It still speaks the same a/b liveState contract as the rest (see PROTOCOL.md), because
// SourceManager, LedboxClient, the resume store and the console all read that shape. It also
// speaks the same source interface: the undo journal (canUndo / undoLabel / clearUndo /
// lastJournaled — see manualSource.js), and setFormat. There is no set-closed guard because there
// is no set to close; `set-closed` is simply never an event this source produces. The fields
// this sport has no concept of are held at zero/neutral rather than omitted — a missing key would
// read as `undefined` in the mapper, and `undefined` paints as "undefined" on an LED panel.

import { EventEmitter } from 'node:events'
import { UndoJournal, undoLabel } from './manualSource.js'

// Neutral board. Note the EMPTY short names, unlike the other sports' HOME/AWAY: a simple
// scoreboard is frequently wanted with no names at all, and the mapper below prints nothing when
// they are empty rather than falling back to TEAM A / TEAM B.
const NEUTRAL = {
  side_a: 'left',
  team_a_name: '', team_a_short: '', team_a_color: '#ffffff',
  team_b_name: '', team_b_short: '', team_b_color: '#ffffff',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0,
  timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0,
  serving_team: null,
}

const clamp0 = (n) => (n < 0 ? 0 : n)

export class SimpleSource extends EventEmitter {
  // The appliance hands every sport's source `{ bestOf }`; there is no format here, so it is unread.
  constructor() {
    super()
    // Kept for interface parity: the control server reads lastEvent after every apply() and the
    // console reacts to set-end / match-end. This source never produces one, and that is a
    // guarantee rather than an omission — see the header. The only events it does report are the
    // undo ones ('undo' / 'undo-empty'), which are about the operator's taps, not the rules.
    this.lastEvent = null
    this.lastJournaled = false // transient: did the last apply() add an undo step? (see manualSource)
    this.journal = new UndoJournal()
    this._fromLiveState(NEUTRAL)
  }

  // setFormat exists on every source (the settings tab pushes rules on save). There is no format
  // to apply here; accepting and ignoring it keeps the caller free of per-sport branching.
  setFormat() {}

  // Undo — the same journal and the same rules as manualSource (see UndoJournal there). "No rules"
  // is not "no mistakes": a + on the wrong side is exactly as likely on two bare numbers.
  _snap() { return JSON.stringify(this.m) }
  _restore(snap) { this.m = JSON.parse(snap) }
  get canUndo() { return this.journal.canUndo }
  get undoLabel() { return this.journal.label }
  clearUndo() { this.journal.clear() }

  _undo() {
    const step = this.journal.pop()
    this.lastJournaled = false
    if (!step) { this.lastEvent = 'undo-empty'; return }
    this._restore(step.snap)
    this.lastEvent = 'undo'
    this.emit('state', this.getState())
  }

  start() {}
  stop() {}

  _fromLiveState(s = NEUTRAL) {
    const src = s || NEUTRAL
    this.m = {
      leftName: String(src.side_a === 'right' ? src.team_b_short || src.team_b_name : src.team_a_short || src.team_a_name || ''),
      rightName: String(src.side_a === 'right' ? src.team_a_short || src.team_a_name : src.team_b_short || src.team_b_name || ''),
      leftPoints: clamp0(Number(src.side_a === 'right' ? src.points_b : src.points_a) || 0),
      rightPoints: clamp0(Number(src.side_a === 'right' ? src.points_a : src.points_b) || 0),
    }
  }

  // Always projected with side_a='left', so a=left and b=right. Same convention as ManualSource:
  // the model is physical sides, and the a/b projection happens only at the boundary.
  getState() {
    return {
      side_a: 'left',
      team_a_name: '', team_a_short: this.m.leftName, team_a_color: '#ffffff',
      team_b_name: '', team_b_short: this.m.rightName, team_b_color: '#ffffff',
      points_a: this.m.leftPoints, points_b: this.m.rightPoints,
      sets_won_a: 0, sets_won_b: 0,
      timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0,
      serving_team: null,
    }
  }

  apply(action) {
    if (!action || typeof action !== 'object') return
    if (action.type === 'undo') return this._undo()
    this.lastEvent = null
    this.lastJournaled = false
    const m = this.m
    const snap = this._snap()
    const label = undoLabel(action, m)
    switch (action.type) {
      case 'point': {
        const side = action.side === 'right' ? 'right' : 'left'
        // Absolute (a typed correction) vs delta (+/−), exactly like the other sources so the
        // console's tap-to-edit score field works here too with no special case.
        if (action.value != null) m[side + 'Points'] = clamp0(Number(action.value) || 0)
        else m[side + 'Points'] = clamp0(m[side + 'Points'] + (Number(action.delta) || 1))
        break
      }
      case 'team': {
        // Names only. Colour is accepted and dropped: this sport is white by definition, and
        // silently keeping a colour that never reaches the panel would be a lie in /api/status.
        const side = action.side === 'right' ? 'right' : 'left'
        if (action.short != null || action.name != null) {
          // `||`, not `!= null`: cleanTeams always passes a short, and an empty one (a schedule
          // start whose short field was cleared) must fall back to the full name, not blank the side.
          m[side + 'Name'] = String(action.short || action.name || '')
        }
        break
      }
      case 'swap': {
        // Scores follow the teams across, which is the only thing "change ends" can mean when
        // there is nothing else on the board.
        const n = m.leftName, p = m.leftPoints
        m.leftName = m.rightName; m.leftPoints = m.rightPoints
        m.rightName = n; m.rightPoints = p
        break
      }
      case 'reset':
        this._fromLiveState(NEUTRAL)
        break
      case 'set-state':
        this._fromLiveState(action.state || NEUTRAL)
        break
      default:
        // Every other verb (set, timeout, sub, serve, next-set, …) is meaningless here. Ignored
        // rather than rejected: the console hides those controls for this sport, so anything
        // arriving is a stale tab or a replayed resume file, and dropping it is the safe read.
        return
    }
    this.lastJournaled = this.journal.record(snap, this._snap(), label)
    this.emit('state', this.getState())
  }
}
