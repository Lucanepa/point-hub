// Records completed matches for the History tab + CSV/JSON export, and the play-by-play that
// matchUpload.js sends to wiedisync after each match (live_match_logs) for the club's stats. Deliberately isolated: a fault in here must NEVER
// affect scoring, so controlServer wraps record() in try/catch. Persisted to a JSON
// file so the log survives a bridge restart.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { log } from './logStore.js'
import { setDur, durField } from './manualSource.js'

const hlog = log.child('history')

const MAX_MATCHES = 100 // keep the last N completed matches
const MAX_EVENTS = 4000 // per-match event cap (a long 5-setter is ~250 rallies)
const MAX_UNDO = 30 // matches the sources' undo journal (UNDO_MAX in manualSource.js)

const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)
const monotonicMs = () => performance.now()

export class HistoryStore {
  // `sport` names the active sport (the upload files it, and basketball's serving arrow is a
  // possession arrow, not a serve). `mono` is a monotonic ms clock for the `el` stamp; injectable
  // so a test can drive it.
  constructor({ file, sport = () => 'volleyball', mono = monotonicMs } = {}) {
    this.file = file || null
    this.sport = sport
    this.mono = mono
    this._game = null // games.id of the fixture the board was set up for (setGame), until the next reset
    this._finishedAt = new WeakMap() // match -> mono() when it was archived (see isSettled)
    this._elBase = null // mono() at el = 0 for the match in the buffer
    this.matches = [] // completed matches, oldest-first on disk; API returns newest-first
    this.current = null // in-progress match buffer
    this._lastFinished = null // { match, kind } for the match just archived, while its end can still be undone
    // What each recent undoable action did to the log, newest last — so the console's general undo
    // can take exactly that back (see _undoLast). Kept in step with the source's own journal by the
    // server, which passes `undoable` only for actions the source journaled.
    this._journal = []
    this._step = null // the entry being filled while record() runs
    this._load()
  }

  _load() {
    if (!this.file) return
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(data.matches)) this.matches = data.matches
      hlog.debug('loaded', { file: this.file, matches: this.matches.length })
    } catch { /* no file yet / unreadable -> start empty */ }
  }

  _save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Write-then-rename, as settings.js does: writeFileSync truncates in place, so a power cut
      // mid-write leaves a zero-length file and _load() silently starts with no matches at all —
      // losing every archived match, which is the record that settles a score dispute afterwards.
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ matches: this.matches }))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      // Best-effort persistence, but a full card losing the match log should be findable.
      hlog.warn(`could not save: ${err.message}`, { file: this.file, error: err.message })
    }
  }

  // The state as the history sees it: by TEAM, not by side. Every source stores its model by
  // physical side and reports a=left, so after a change of ends "a" is the other team — and a log
  // that took a/b at face value credited every point before the swap to the wrong team and flipped
  // the score column at each set break (a 3-0 by one team read as a 50-25 split). `ends_swapped`
  // says whether the teams stand the reverse of where they started; undoing it here gives an a/b
  // that names the same team from the first rally to the last. A state that doesn't carry the
  // flag (an older source) reads as not swapped, which is exactly the old behaviour.
  _view(state) {
    const sw = !!state.ends_swapped
    const ab = (a, b) => (sw ? [b, a] : [a, b])
    const [nameA, nameB] = ab(state.team_a_short || state.team_a_name, state.team_b_short || state.team_b_name)
    return {
      names: { a: nameA || 'A', b: nameB || 'B' },
      score: ab(num(state.points_a), num(state.points_b)),
      sets: ab(num(state.sets_won_a), num(state.sets_won_b)),
      results: (Array.isArray(state.set_results) ? state.set_results : [])
        .filter((r) => r && typeof r === 'object')
        .map((r) => { const [a, b] = ab(num(r.a), num(r.b)); return { a, b, ...durField(setDur(r)) } }),
      // A physical side ('left'|'right') -> the team standing there right now.
      team: (side) => ((side === 'right') !== sw ? 'b' : 'a'),
    }
  }

  // Feed every applied action + the resulting state + the notable event. `now` is a preformatted
  // timestamp string and `clock` a preformatted HH:MM:SS (both passed in so this module stays
  // deterministic/testable). `now` dates the match; `clock` times each event inside it, because a
  // play-by-play at minute resolution puts a whole rally sequence on one indistinguishable line.
  //
  // `undoable` says the source put this action on its undo journal; the log then remembers what the
  // action did so a later {type:'undo'} can take exactly that back. `label` (on an undo) is the
  // source's words for what was undone, kept on the marker the undo leaves behind.
  record(action, state, event, now, clock = '', { undoable = false, label = '' } = {}) {
    if (!action || !state) return
    const t = action.type
    if (t === 'undo') return this._undoLast(state, now, clock, label)
    this._step = undoable ? { pushed: [], finished: null, reopened: null, started: false, prevCurrent: this.current, prevFinished: this._lastFinished } : null
    try { this._record(action, state, event, now, clock) } finally {
      if (this._step) {
        this._journal.push(this._step)
        if (this._journal.length > MAX_UNDO) this._journal.shift()
      }
      this._step = null
    }
  }

  // A fresh match (New game, Continue, a boot-time resume) starts with nothing to undo — undo
  // reaching across it would edit a different match.
  clearUndo() { this._journal = [] }

  _record(action, state, event, now, clock) {
    const t = action.type
    const v = this._view(state)
    // A new match begins on reset, or on the first scoring action when nothing is buffered.
    if (t === 'reset') {
      if (this._step) this._step.reset = true // prevCurrent/prevFinished already hold the way back
      this.current = null; this._lastFinished = null; this._game = null; return
    }
    // The engines let "−" (or the trash icon) take back the point that ENDED the match — a mis-tap
    // at 24-23 in the decider is as undoable as any other set point. The history used to have no
    // such undo: the match stayed archived, the rest of it went into a second "match" holding only
    // the tail, and the real match point archived that too — two entries for one match, the first
    // one wrong. So while the match just archived is still the last one, an undo that leaves it no
    // longer decided puts it back in the buffer, and the play-by-play carries on where it stopped.
    if (!this.current && this._lastFinished && this._undoesFinish(t, action, state, v)) {
      if (this._step) this._step.reopened = this._lastFinished
      this._reopen()
    }
    const scoring = t === 'point' || t === 'set' || t === 'timeout' || t === 'sub' || t === 'serve'
    if (!this.current && scoring) {
      this.current = {
        id: crypto.randomUUID(), date: now, sport: String(this.sport() || 'volleyball'),
        ...(this._game != null ? { game_id: this._game } : {}),
        team_a: v.names.a, team_b: v.names.b, events: [],
      }
      this._elBase = this.mono()
      if (this._step) this._step.started = true
      this._lastFinished = null // a new match has begun; the previous one is final now
      hlog.info(`match started: ${v.names.a} vs ${v.names.b}`, { team_a: v.names.a, team_b: v.names.b, at: now })
    }
    if (!this.current) return
    // Keep names fresh — the operator often types them after the first point.
    this.current.team_a = v.names.a
    this.current.team_b = v.names.b

    // The running score and set tally at the moment the action landed, on EVERY event. That is
    // what makes the log answer the question people actually bring to it afterwards — "what was
    // the score when that happened" — without replaying the whole list to find out.
    const at = () => ({ t: clock || now, el: this._el(), score: v.score.slice(), sets: v.sets.slice(), ...this._srv(state, v) })
    const side = v.team(action.side)

    // Everything the operator did, not just the points that went up. A correction, a timeout, a
    // change of ends and a typed-in score are exactly the entries a disputed sheet turns on, and
    // they were the ones being dropped: the old log kept `point` with a POSITIVE delta and nothing
    // else, so a mis-scored rally and its undo both vanished and the log quietly disagreed with
    // the scoresheet.
    if (t === 'point' || t === 'timeout' || t === 'sub') {
      const delta = Number(action.delta)
      // A typed value (tap the number, enter it) carries no delta — record it as its own kind of
      // entry, because "set to 24" and "+1" are different acts even when the score ends up equal.
      if (Number.isFinite(delta) && delta !== 0) this._push({ ...at(), type: t, side, delta })
      else if (action.value != null) this._push({ ...at(), type: t, side, value: Number(action.value) })
    } else if (t === 'serve') {
      this._push({ ...at(), type: 'serve', side })
    } else if (t === 'swap') {
      this._push({ ...at(), type: 'swap' })
    } else if (t === 'set') {
      this._push({ ...at(), type: 'set', side, value: Number(action.value) })
    } else if (t === 'remove-set') {
      this._push({ ...at(), type: 'remove-set' })
    }

    // The set that just closed, by team like everything else in the log.
    const closingSet = () => {
      const r = v.results.slice(-1)[0] || { a: v.score[0], b: v.score[1] }
      return { ...at(), type: 'set-end', set: v.sets[0] + v.sets[1], score: [r.a, r.b], ...durField(r.dur) }
    }
    // Basketball's period boundary. `period` is the one just played: a period-end has already
    // moved the board on to the next one, a game-end leaves it where it was.
    const closingPeriod = (ended) => ({ ...at(), type: 'period-end', period: ended })
    const period = Math.max(1, num(state.period))
    if (event === 'set-end') {
      this._push(closingSet())
    } else if (event === 'switch-due') {
      this._push({ ...at(), type: 'switch-due' })
    } else if (event === 'period-end') {
      this._push(closingPeriod(period - 1))
    } else if (event === 'match-end') {
      // The last point of a match closes a set AND the match, but `lastEvent` can only be one of
      // them — so the deciding set used to have no close at all in the log, and the play-by-play
      // ended mid-set with "Match over". Write both, in the order they happened.
      this._push(closingSet())
      this._push({ ...at(), type: 'match-end' })
      this._finish(state, now, 'match-end')
    } else if (event === 'game-end') {
      // Basketball's end of match. It was never listened for, so no basketball game ever reached
      // the History tab or the export, and the buffer ran on into the next game until a reset.
      this._push(closingPeriod(period))
      this._push({ ...at(), type: 'match-end' })
      this._finish(state, now, 'game-end')
    }
  }

  // Did this action take back the result that closed the last archived match? Only an undo counts
  // ("−" on a point, or removing a set/period) — a set-state or a typed tally that happens to lower
  // the numbers is the operator loading a different board, not reopening the old match.
  _undoesFinish(t, action, state, v) {
    const undo = (t === 'point' && Number(action.delta) < 0) || t === 'remove-set'
    if (!undo) return false
    const f = this._lastFinished
    if (this.matches[this.matches.length - 1] !== f.match) return false
    // Basketball has no set tally; the game is decided exactly while the source says it is over.
    if (f.kind === 'game-end') return !state.over
    return v.sets[0] + v.sets[1] < f.match.sets_a + f.match.sets_b
  }

  _reopen() {
    const { match } = this._lastFinished
    this.matches.pop()
    // Drop the "Match over" marker the finish wrote; the closing set-end stays, followed by the
    // correction that undid it — the same trail an undone set leaves in the middle of a match.
    const events = match.events.slice()
    if (events.length && events[events.length - 1].type === 'match-end') events.pop()
    this.current = { ...this._carry(match), events }
    this._lastFinished = null
    hlog.info(`match reopened: ${match.team_a} vs ${match.team_b} (the match point was taken back)`, {
      team_a: match.team_a, team_b: match.team_b, events: events.length,
    })
    this._save()
  }

  // What a match keeps across being archived and reopened: its identity, fixture and sport. A match
  // logged before those existed has none, and stays that way (matchUpload skips it).
  _carry(m) {
    const out = { date: m.date, team_a: m.team_a, team_b: m.team_b }
    for (const k of ['id', 'sport', 'game_id']) if (m[k] != null) out[k] = m[k]
    return out
  }

  // Seconds since the match started, on the monotonic clock: the board has no RTC and NTP can step
  // the wall clock mid-match, which would make `t` lie about how long a rally took. A match reopened
  // after a restart carries on from its last stamp rather than going back to 0.
  _el() {
    if (this._elBase == null) {
      const last = this.current && [...this.current.events].reverse().find((e) => Number.isFinite(e.el))
      this._elBase = this.mono() - (last ? last.el * 1000 : 0)
    }
    return Math.round((this.mono() - this._elBase) / 100) / 10
  }

  // The team serving AFTER the action, by team like everything else. Rally N was served by the
  // `srv` of the entry before it, which is what the stats need (sideout vs break point). Not for
  // basketball: its serving_team is the possession arrow.
  _srv(state, v) {
    if (this.sport() === 'basketball') return {}
    const s = state.serving_team
    return s === 'left' || s === 'right' ? { srv: v.team(s) } : {}
  }

  // The fixture the next match is for — the schedule start calls this right after its reset. Cleared
  // by the next reset, so a hand-started game after it is not filed against the scheduled one.
  setGame(gameId) {
    const n = Number(gameId)
    this._game = Number.isInteger(n) && n > 0 ? n : null
    if (this.current && this._game != null && this.current.game_id == null && !this.current.events.length) this.current.game_id = this._game
  }

  // Whether an archived match can be uploaded: its result can no longer be taken back. While it is
  // the match just finished, a "−" on the match point reopens it (see _reopen); give the scorer
  // `graceMs` to notice before the log leaves the board. A new match (or a restart) settles it.
  isSettled(match, graceMs = 10 * 60 * 1000) {
    if (!this._lastFinished || this._lastFinished.match !== match) return true
    const at = this._finishedAt.get(match)
    return at == null || this.mono() - at >= graceMs
  }

  _push(ev) {
    if (this.current.events.length < MAX_EVENTS) {
      this.current.events.push(ev)
      if (this._step) this._step.pushed.push(ev)
    }
  }

  // The console's general undo. The source has already restored its snapshot; this makes the log
  // agree with it, so an archived match never keeps a point, a set end or a "Match over" that the
  // board took back. The undone action's entries are REMOVED rather than flagged — the History tab,
  // the CSV export and anything reading the JSON count set-ends and points as they find them — and
  // one `undo` marker naming what was taken back stays in their place, so the trail still shows
  // that a correction happened. An undo with nothing journaled (the log was cleared, the bridge
  // restarted) only leaves the marker.
  _undoLast(state, now, clock, label) {
    const e = this._journal.pop()
    if (e && e.reset) {
      // Undoing a reset: the match it closed is the match again.
      this.current = e.prevCurrent
      this._lastFinished = e.prevFinished
    } else if (e) {
      if (e.finished) {
        // The undone action archived the match: take it back off the archive, as _reopen does.
        const i = this.matches.lastIndexOf(e.finished.match)
        if (i !== -1) {
          const m = e.finished.match
          this.matches.splice(i, 1)
          this.current = { ...this._carry(m), events: m.events }
          this._lastFinished = null
          hlog.info(`match reopened: ${m.team_a} vs ${m.team_b} (its last action was undone)`, { team_a: m.team_a, team_b: m.team_b })
        }
      }
      if (this.current && e.pushed.length) {
        const gone = new Set(e.pushed)
        this.current.events = this.current.events.filter((ev) => !gone.has(ev))
      }
      if (e.reopened) {
        // The undone action had reopened an archived match (a "−" on its match point): put the
        // match back exactly as it was archived.
        this.matches.push(e.reopened.match)
        this.current = null
        this._lastFinished = e.reopened
      } else if (e.started && this.current && !this.current.events.length) {
        // The undone action is what opened this match — there is no match left to log.
        this.current = e.prevCurrent
        this._lastFinished = e.prevFinished
      }
      if (e.finished || e.reopened) this._save()
    }
    if (this.current) {
      const v = this._view(state)
      this._push({ t: clock || now, el: this._el(), score: v.score.slice(), sets: v.sets.slice(), ...this._srv(state, v), type: 'undo', ...(label ? { what: String(label) } : {}) })
    }
  }

  _finish(state, now, kind) {
    const v = this._view(state)
    // Basketball has no sets (the source reports 0-0), so its headline result is the final score;
    // `sets` then holds the per-period line score, which is what the source keeps in set_results.
    const [ra, rb] = kind === 'game-end' ? v.score : v.sets
    const sets = v.results
    hlog.info(`match finished: ${this.current.team_a} ${ra}-${rb} ${this.current.team_b}`, {
      team_a: this.current.team_a, team_b: this.current.team_b,
      sets_a: ra, sets_b: rb, sets, events: this.current.events.length,
    })
    const match = {
      ...this._carry(this.current),
      date: this.current.date || now,
      sets_a: ra, sets_b: rb,
      sets, events: this.current.events,
    }
    this.matches.push(match)
    this._finishedAt.set(match, this.mono())
    if (this.matches.length > MAX_MATCHES) this.matches = this.matches.slice(-MAX_MATCHES)
    this.current = null
    this._lastFinished = { match, kind }
    if (this._step) this._step.finished = this._lastFinished
    this._save()
  }

  // API view — newest match first.
  list() { return { matches: this.matches.slice().reverse() } }

  clear() { this.matches = []; this.current = null; this._lastFinished = null; this._journal = []; this._save() }
}
