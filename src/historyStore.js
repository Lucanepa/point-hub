// Records completed matches for the History tab + CSV/JSON export (and, later, a
// live-scoring feed for wiedisync). Deliberately isolated: a fault in here must NEVER
// affect scoring, so controlServer wraps record() in try/catch. Persisted to a JSON
// file so the log survives a bridge restart.

import fs from 'node:fs'
import path from 'node:path'
import { log } from './logStore.js'

const hlog = log.child('history')

const MAX_MATCHES = 100 // keep the last N completed matches
const MAX_EVENTS = 4000 // per-match event cap (a long 5-setter is ~250 rallies)

const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

export class HistoryStore {
  constructor({ file } = {}) {
    this.file = file || null
    this.matches = [] // completed matches, oldest-first on disk; API returns newest-first
    this.current = null // in-progress match buffer
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

  _teams(state) {
    return {
      a: state.team_a_short || state.team_a_name || 'A',
      b: state.team_b_short || state.team_b_name || 'B',
    }
  }

  // Feed every applied action + the resulting state + the notable event. `now` is a preformatted
  // timestamp string and `clock` a preformatted HH:MM:SS (both passed in so this module stays
  // deterministic/testable). `now` dates the match; `clock` times each event inside it, because a
  // play-by-play at minute resolution puts a whole rally sequence on one indistinguishable line.
  record(action, state, event, now, clock = '') {
    if (!action || !state) return
    const t = action.type
    // A new match begins on reset, or on the first scoring action when nothing is buffered.
    if (t === 'reset') { this.current = null; return }
    const scoring = t === 'point' || t === 'set' || t === 'timeout' || t === 'sub' || t === 'serve'
    if (!this.current && scoring) {
      const nm = this._teams(state)
      this.current = { date: now, team_a: nm.a, team_b: nm.b, events: [] }
      hlog.info(`match started: ${nm.a} vs ${nm.b}`, { team_a: nm.a, team_b: nm.b, at: now })
    }
    if (!this.current) return
    // Keep names fresh — the operator often types them after the first point.
    const nm = this._teams(state)
    this.current.team_a = nm.a
    this.current.team_b = nm.b

    // The running score and set tally at the moment the action landed, on EVERY event. That is
    // what makes the log answer the question people actually bring to it afterwards — "what was
    // the score when that happened" — without replaying the whole list to find out.
    const at = () => ({
      t: clock || now,
      score: [num(state.points_a), num(state.points_b)],
      sets: [num(state.sets_won_a), num(state.sets_won_b)],
    })
    const side = action.side === 'right' ? 'b' : 'a'

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

    // The set that just closed, in the orientation the board is in NOW (set_results are stored per
    // physical side and travel with the change of ends, exactly as the console renders them).
    const closingSet = () => {
      const r = (state.set_results || []).slice(-1)[0] || { a: num(state.points_a), b: num(state.points_b) }
      return { ...at(), type: 'set-end', set: num(state.sets_won_a) + num(state.sets_won_b),
        score: [num(r.a), num(r.b)] }
    }
    if (event === 'set-end') {
      this._push(closingSet())
    } else if (event === 'switch-due') {
      this._push({ ...at(), type: 'switch-due' })
    } else if (event === 'match-end') {
      // The last point of a match closes a set AND the match, but `lastEvent` can only be one of
      // them — so the deciding set used to have no close at all in the log, and the play-by-play
      // ended mid-set with "Match over". Write both, in the order they happened.
      this._push(closingSet())
      this._push({ ...at(), type: 'match-end' })
      this._finish(state, now)
    }
  }

  _push(ev) {
    if (this.current.events.length < MAX_EVENTS) this.current.events.push(ev)
  }

  _finish(state, now) {
    const sets = (state.set_results || []).map((r) => ({ a: num(r.a), b: num(r.b) }))
    hlog.info(`match finished: ${this.current.team_a} ${num(state.sets_won_a)}-${num(state.sets_won_b)} ${this.current.team_b}`, {
      team_a: this.current.team_a, team_b: this.current.team_b,
      sets_a: num(state.sets_won_a), sets_b: num(state.sets_won_b),
      sets, events: this.current.events.length,
    })
    this.matches.push({
      date: this.current.date || now,
      team_a: this.current.team_a, team_b: this.current.team_b,
      sets_a: num(state.sets_won_a), sets_b: num(state.sets_won_b),
      sets, events: this.current.events,
    })
    if (this.matches.length > MAX_MATCHES) this.matches = this.matches.slice(-MAX_MATCHES)
    this.current = null
    this._save()
  }

  // API view — newest match first.
  list() { return { matches: this.matches.slice().reverse() } }

  clear() { this.matches = []; this.current = null; this._save() }
}
