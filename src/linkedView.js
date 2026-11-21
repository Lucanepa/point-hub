// What the board shows of a LINKED OpenVolley match, built from the live states the relay sends
// (LanSource feeds every state in order, stale ones already dropped) and from the match summary
// that comes with them. The live state itself is passed through with only these filled in or
// turned round, so every reader downstream (the mappers, livePush, the result screen, the console)
// keeps reading the one shape it already knows:
//
//   side_a / serving_team   mirrored when the hall needs it (`mirror`, from Settings ▸ Scorer sits
//                           behind the board, the default — see LanSource). Both together, so who serves stays
//                           the same team; the time-out, sub and serve indicators follow the sides.
//   subs_a / subs_b         the cloud strips them for a viewer without the match PIN
//                           (OpenVolley LIVE_STATE_PRIVATE_COLUMNS: the keys are simply absent).
//                           Then they are counted here from the public events (countSubs).
//                           Real values always win: subs_count_a/_b (a public count OpenVolley may
//                           add), else subs_a/subs_b whenever the state carries the keys at all —
//                           a PIN-proved or LAN view sends null for "none in this set".
//   set_results             OpenVolley's live state has none (the livescore reads them from the
//                           match row). The board records each finished set itself (the summary's
//                           finished sets where it has them, else the last score it saw in each
//                           set) and fills them in only when it knows EVERY finished set and they
//                           agree with sets_won_a/_b. A set_results the state does carry wins.
//
// And what is NEW in each state, for the substitution notice on the panel (takeNewSubs, read by
// LanSource after every state): the substitutions made since the previous state, with the shirt
// numbers where the state has them.
//
//   home_ab                 'a' | 'b': which of team A / B is the match's home team, once learned
//                           (below). livePush puts home on the left of a finished match's row.
//   game_n                  the match number, from the summary (match.game_n / gameN / gameNumber)
//                           or the Link tab's list when the live state has none, so livePush can
//                           find the game's own row (controlServer liveFixture).
//
// Team A and B are fixed teams in OpenVolley (A = whoever the scorer entered first); events name
// 'home' / 'away'. Which of A and B is home is learned from 'point' events (whose points went up)
// and, before the first one, from the summary's team names.

const MAX_KEYS = 400 // events remembered for the dedupe; a match has a few hundred at most

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const setNo = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const other = (side) => (side === 'right' ? 'left' : side === 'left' ? 'right' : side)
const norm = (s) => String(s ?? '').trim().toLowerCase()
const isCount = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))

// The event a state names, as one key: its type and its own timestamp (the scorer stamps every
// event it pushes; a re-push after a reconnect repeats the stamp). Without a stamp, the state's own
// order stands in. null = nothing to tell it apart by, so it is not counted.
function eventKey(s) {
  const type = String(s.last_event_type || '')
  if (!type) return null
  if (s.last_event_ts) return `${type}|${s.last_event_ts}`
  if (s._session && s._seq != null) return `${type}|#${s._session}:${s._seq}`
  return null
}

// A match number as the board's schedule knows it: digits and letters, nothing else.
export function cleanGameNumber(v) {
  if (v == null) return null
  const s = String(v).trim()
  return /^[\w.-]{1,40}$/.test(s) ? s : null
}

export class LinkedView {
  constructor({ gameNumber = null } = {}) {
    this._home = null        // 'a' | 'b': which of team A / B is OpenVolley's home team
    this._homeBy = null      // 'points' | 'names': how that was learned (points win)
    this._prev = null        // the previous state, for the point learning
    this._keys = new Set()   // events already seen (eventKey)
    this._stack = []         // recent distinct events, newest last, for the undo of a sub
    this._subs = []          // { set, team: 'home'|'away' } counted substitutions
    this._sets = new Map()   // set number -> { a, b }: the last score seen in it
    this._summarySets = new Map() // set number -> { a, b }: finished sets from the summary
    this._summary = null     // { homeNames, sets, gameNumber }
    this._listedGame = cleanGameNumber(gameNumber)
    this._newSubs = []       // substitutions the last state brought (newSubs)
  }

  // --- the summary (match-full-data / match-data-update `data`) -------------------------------
  takeSummary(data) {
    if (!data || typeof data !== 'object') return
    const m = data.match && typeof data.match === 'object' ? data.match : {}
    const team = (t) => (typeof t === 'string' ? [t] : t && typeof t === 'object' ? [t.name, t.shortName, t.short_name] : [])
    const homeNames = [...team(data.homeTeam), m.homeTeamName, m.homeShortName].map(norm).filter(Boolean)
    const awayNames = [...team(data.awayTeam), m.awayTeamName, m.awayShortName].map(norm).filter(Boolean)
    const gameNumber = cleanGameNumber(m.game_n ?? m.gameN ?? m.gameNumber)
    this._summary = { homeNames, awayNames, gameNumber: gameNumber ?? (this._summary && this._summary.gameNumber) ?? null }
    if (Array.isArray(data.sets)) {
      this._summaryRaw = data.sets.filter((s) => s && typeof s === 'object')
      this._applySummarySets()
    }
  }

  // The summary's finished sets, once A/B is known (they are home/away).
  _applySummarySets() {
    if (!this._summaryRaw || !this._home) return
    this._summarySets.clear()
    for (const s of this._summaryRaw) {
      const n = setNo(s.index)
      if (n == null || s.finished !== true) continue
      const home = num(s.homePoints ?? s.home_points), away = num(s.awayPoints ?? s.away_points)
      this._summarySets.set(n, this._home === 'a' ? { a: home, b: away } : { a: away, b: home })
    }
  }

  // --- every live state, in order -----------------------------------------------------------
  take(s) {
    if (!s || typeof s !== 'object') return
    const prev = this._prev
    this._learnHome(s, prev)
    const fresh = this._countEvent(s, prev)
    this._newSubs = this._subsSince(s, prev, fresh)
    // The last score seen in each set. A 0:0 says nothing (the set_end frame already shows the
    // NEXT set at 0:0), so it never overwrites a score.
    const set = setNo(s.current_set)
    const a = num(s.points_a), b = num(s.points_b)
    if (set != null && a + b > 0) this._sets.set(set, { a, b })
    this._prev = s
  }

  _learnHome(s, prev) {
    if (!this._home || this._homeBy !== 'points') {
      const team = s.last_event_team
      if (s.last_event_type === 'point' && (team === 'home' || team === 'away') && prev && setNo(prev.current_set) === setNo(s.current_set)) {
        const dA = num(s.points_a) - num(prev.points_a), dB = num(s.points_b) - num(prev.points_b)
        const scorer = dA === 1 && dB === 0 ? 'a' : dB === 1 && dA === 0 ? 'b' : null
        if (scorer) {
          this._home = (team === 'home') === (scorer === 'a') ? 'a' : 'b'
          this._homeBy = 'points'
          this._applySummarySets()
          return
        }
      }
    }
    if (!this._home && this._summary) {
      const names = (k) => [s[`team_${k}_name`], s[`team_${k}_short`]].map(norm).filter(Boolean)
      const hits = (list, k) => names(k).some((n) => list.includes(n))
      const { homeNames, awayNames } = this._summary
      const aHome = hits(homeNames, 'a') || hits(awayNames, 'b')
      const bHome = hits(homeNames, 'b') || hits(awayNames, 'a')
      if (aHome !== bHome) {
        this._home = aHome ? 'a' : 'b'
        this._homeBy = 'names'
        this._applySummarySets()
      }
    }
  }

  // Substitutions from the public events: each 'substitution' with a team once (by eventKey), in
  // the set it was made in; an 'undo' that takes back a substitution (the newest event still
  // standing, the score unchanged since) takes the count back too. libero_* is not a
  // substitution and is never counted.
  // True when `s` names an event not seen before.
  _countEvent(s, prev) {
    const key = eventKey(s)
    if (!key || this._keys.has(key)) return false
    this._keys.add(key)
    if (this._keys.size > MAX_KEYS) this._keys.delete(this._keys.values().next().value)
    const type = s.last_event_type
    const score = `${setNo(s.current_set)}:${num(s.points_a)}:${num(s.points_b)}`
    if (type === 'undo') {
      // A side-out's 'rotation' push rides along with its point and is not an action of its own.
      while (this._stack.length && this._stack[this._stack.length - 1].type === 'rotation') this._stack.pop()
      const top = this._stack.pop()
      if (top && top.sub && top.score === score) {
        const i = this._subs.indexOf(top.sub)
        if (i >= 0) this._subs.splice(i, 1)
      }
      return true
    }
    const entry = { type, score, sub: null }
    if (type === 'substitution' && (s.last_event_team === 'home' || s.last_event_team === 'away')) {
      entry.sub = { set: setNo(s.current_set), team: s.last_event_team }
      this._subs.push(entry.sub)
    }
    this._stack.push(entry)
    if (this._stack.length > 50) this._stack.shift()
    return true
  }

  // The substitutions `s` brings over `prev`, as [{ team: 'a'|'b'|null, playerOut, playerIn }]
  // (numbers null when the state has none). Never for the first state of a link (what is already on
  // the match is no news) or across a set change.
  //   * The full lists (a LAN relay, or a board that gave the match PIN): subs_a / subs_b carry every
  //     substitution of the set with its numbers (null for none yet). What is new is what the list
  //     has beyond the previous state's — so a double substitution, which OpenVolley sends as ONE
  //     state named after its last event (mergeLiveStatePushes), shows both.
  //   * Stripped (OpenVolley's cloud, no PIN): the public count subs_count_a/_b where both states
  //     carry it, else one per new 'substitution' event. The numbers then come from last_event_data
  //     ({ playerIn, playerOut }), which the cloud strips too: usually none.
  // Libero replacements are never substitutions here (libero_* events, not in subs_a/_b). A sub
  // taken back (undo) shrinks the list and brings nothing.
  _subsSince(s, prev, fresh) {
    if (!prev) return []
    const set = setNo(s.current_set)
    if (set == null || set !== setNo(prev.current_set)) return []
    const home = this._home
    const evTeam = s.last_event_team === 'home' || s.last_event_team === 'away'
      ? (home ? ((s.last_event_team === 'home') === (home === 'a') ? 'a' : 'b') : null)
      : null
    const isSub = fresh && s.last_event_type === 'substitution'
    const list = (st, k) => (k in st ? (Array.isArray(st[k]) ? st[k] : []) : null)
    const now = { a: list(s, 'subs_a'), b: list(s, 'subs_b') }
    if (now.a || now.b) {
      const out = []
      const entry = (t, x) => {
        const o = x && typeof x === 'object' ? x : {}
        out.push({ team: t, playerOut: o.playerOut ?? null, playerIn: o.playerIn ?? null })
      }
      for (const t of ['a', 'b']) {
        const before = list(prev, `subs_${t}`)
        if (!now[t]) continue
        if (before) { for (const x of now[t].slice(before.length)) entry(t, x); continue }
        // The first full state after stripped ones (the PIN accepted mid-match): no list to compare
        // with, so the event says it — its team's newest entry.
        if (isSub && evTeam === t && now[t].length) entry(t, now[t][now[t].length - 1])
      }
      return out
    }
    const data = isSub && s.last_event_data && typeof s.last_event_data === 'object' ? s.last_event_data : {}
    const counted = isCount(s.subs_count_a) && isCount(s.subs_count_b) && isCount(prev.subs_count_a) && isCount(prev.subs_count_b)
    const out = []
    if (counted) {
      for (const t of ['a', 'b']) {
        const d = num(s[`subs_count_${t}`]) - num(prev[`subs_count_${t}`])
        for (let i = 0; i < d && i < 6; i++) out.push({ team: t, playerOut: null, playerIn: null })
      }
      // The numbers, where the event has them, belong to the event's team's last one.
      const mine = evTeam ? out.filter((x) => x.team === evTeam) : []
      if (isSub && mine.length) Object.assign(mine[mine.length - 1], { playerOut: data.playerOut ?? null, playerIn: data.playerIn ?? null })
      return out
    }
    if (isSub && (s.last_event_team === 'home' || s.last_event_team === 'away')) {
      out.push({ team: evTeam, playerOut: data.playerOut ?? null, playerIn: data.playerIn ?? null })
    }
    return out
  }

  // What the last state brought (see _subsSince), handed over once.
  takeNewSubs() {
    const out = this._newSubs
    this._newSubs = []
    return out
  }

  // Counted substitutions of the set `set`, as A/B; null while A/B is not known yet.
  countSubs(set) {
    if (!this._home) return null
    let home = 0, away = 0
    for (const x of this._subs) if (x.set === set) { if (x.team === 'home') home++; else away++ }
    return this._home === 'a' ? { a: home, b: away } : { a: away, b: home }
  }

  // The finished sets in play order, or null when the board does not know every one of them, or
  // what it knows does not add up to the state's own set count.
  setResults(s) {
    const wonA = num(s.sets_won_a), wonB = num(s.sets_won_b)
    const total = wonA + wonB
    if (total === 0) return null
    const current = setNo(s.current_set)
    const over = /^(ended|final|approved|finished|completed)$/i.test(String(s.match_status || ''))
    const known = new Map(this._sets)
    for (const [n, r] of this._summarySets) known.set(n, r)
    const finished = [...known.keys()]
      .filter((n) => current == null || (over ? n <= current : n < current))
      .sort((x, y) => x - y)
      .map((n) => known.get(n))
    if (finished.length !== total) return null
    // A finished set is won by two at least; anything else is a score the board missed the end of.
    if (finished.some((r) => Math.abs(r.a - r.b) < 2)) return null
    const aWins = finished.filter((r) => r.a > r.b).length
    const bWins = finished.filter((r) => r.b > r.a).length
    if (aWins !== wonA || bWins !== wonB) return null
    return finished.map((r) => ({ a: r.a, b: r.b }))
  }

  // The state as the board shows it (see the header). Never mutates `s`.
  view(s, { mirror = false } = {}) {
    if (!s || typeof s !== 'object') return s
    const out = { ...s }
    if (isCount(s.subs_count_a) || isCount(s.subs_count_b)) {
      out.subs_a = num(s.subs_count_a)
      out.subs_b = num(s.subs_count_b)
    } else if (!('subs_a' in s) && !('subs_b' in s)) {
      const c = this.countSubs(setNo(s.current_set))
      out.subs_a = c ? c.a : 0
      out.subs_b = c ? c.b : 0
    }
    if (!(Array.isArray(s.set_results) && s.set_results.length)) {
      const r = this.setResults(s)
      if (r) out.set_results = r
    }
    if (cleanGameNumber(s.game_n) == null) {
      const n = (this._summary && this._summary.gameNumber) || this._listedGame
      if (n) out.game_n = n
    }
    // Which of A / B is OpenVolley's home team, once learned (see the header) — for livePush, which
    // puts home on the left of a FINISHED match's row. Absent while unknown.
    if (this._home) out.home_ab = this._home
    else delete out.home_ab
    if (mirror) {
      out.side_a = other(s.side_a || 'left')
      if (s.serving_team === 'left' || s.serving_team === 'right') out.serving_team = other(s.serving_team)
    }
    return out
  }
}
