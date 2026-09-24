// ─────────────────────────────────────────────────────────────────────────────
// Publishes the board to wiedisync so club members (and anyone they send the link
// to) can follow the match live at https://wiedisync.kscw.ch/live.
//
// The target is the club's EXISTING Directus, not a bespoke service: one row in
// `live_scores`, keyed by channel, that this board keeps overwriting. No history,
// no fan-out — the app polls that row every ~3s. (This replaced an earlier
// Cloudflare Durable-Object relay design, which needed a PAID Workers plan.)
//
//   Manual/Beach/Basketball Source --state--> SourceManager --> livePush --PATCH--> Directus
//
// Collection, permissions and token: wiedisync/src/modules/live/DIRECTUS-SETUP.md
//
// ── Config — env vars ────────────────────────────────────────────────────────
//     DIRECTUS_URL         https base of the club's Directus
//                          (https://directus.kscw.ch — dev: directus-dev.kscw.ch)
//     LIVE_PUBLISH_TOKEN   static token of the `ledbox-board@kscw.ch` user, whose
//                          "KSCW LedBox Publisher" policy grants create+read+update
//                          on `live_scores` ONLY. Prod and dev tokens differ.
//     LIVE_CHANNEL         the row's primary key (default 'kscw' — one board, one row)
//     LIVE_COLLECTION      Directus collection (default 'live_scores')
//
// DISTINCT from the LAN relay vars (RELAY_URL / RELAY_HTTP_URL, the OpenVolley
// eScoresheet server this board SUBSCRIBES to). This is an outbound push to a
// different host and can never clobber the LAN config.
//
// Everything here is best-effort: a Directus outage, a slow network or a bad token
// must NEVER affect the physical scoreboard, so every failure is swallowed (logged
// only when debug is on), exactly like historyStore is isolated today.
// ─────────────────────────────────────────────────────────────────────────────

import { BEACH } from './beachSource.js'
import { setDur, durField } from './manualSource.js'
import { BASKETBALL } from './basketballSource.js'
import { log as logStore } from './logStore.js'

// Publishing used to be visible only under DEBUG=1, on stdout. It now always goes to the log
// store, which owns the level — so "is /live stale?" is answerable from the /logs page instead
// of from a restart with a different env var. The token is redacted there by key name.
const plog = logStore.child('livePush')

const DEFAULTS = {
  channel: 'kscw', collection: 'live_scores', historyCollection: 'live_history', sport: 'volleyball',
  timeoutMs: 2000, debounceMs: 150,
  // The history POST gets far longer than the live PATCH. A live write that times out is simply
  // sent again (it overwrites one row), but an archive that times out may already be committed and
  // is NOT sent again (see archive()) — so every abort there is a history row possibly lost, and a
  // slow hall uplink or a 4G TLS handshake on armhf routinely needs more than 2 s. Above undici's
  // own 10 s connect timeout on purpose: a connect that never completes then fails as a connect
  // error, which IS known to be safe to repeat, instead of as our ambiguous abort.
  archiveTimeoutMs: 12000,
  // A failed write is retried with the LATEST state, doubling from retryBaseMs up to retryMaxMs,
  // at most maxRetries times in a row; the next board change then starts a fresh round. Bounded
  // so a dead Directus costs a handful of requests per rally, not a request loop. A board change
  // during a backoff does not wait it out — it goes after the normal debounce (see push()).
  retryBaseMs: 1000, retryMaxMs: 30000, maxRetries: 8,
  debug: false,
}

const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

// How many sets win the match, per sport. Read from the sources' own rule
// constants so this can never drift from what the board actually scores.
// Basketball has no set tally at all — it publishes its own `over` flag instead.
const SETS_TO_WIN = { volleyball: 3, beach: BEACH.setsToWin }

// Is the match on this board finished? From MATCH STATE only — see toRow() for why not the event.
// The manual and beach sources report the format the operator actually picked (`sets_to_win`); the
// constant is only the fallback for a state that doesn't carry it (a linked OpenVolley match).
function isOver(state, sport) {
  if (sport === 'basketball') return !!state.over
  const reported = Number(state.sets_to_win)
  const toWin = Number.isInteger(reported) && reported > 0 ? reported : SETS_TO_WIN[sport]
  return num(state.sets_won_a) >= toWin || num(state.sets_won_b) >= toWin
}

const otherSide = (s) => (s === 'left' ? 'right' : s === 'right' ? 'left' : s)

// A neutral board (no names, no points, no completed sets) reads as 'idle' so the
// app shows its empty state instead of a blank 0:0 scoreboard.
function isBlank(s) {
  return (
    !s.team_a_name && !s.team_b_name &&
    !num(s.points_a) && !num(s.points_b) &&
    !num(s.sets_won_a) && !num(s.sets_won_b) &&
    (!Array.isArray(s.set_results) || s.set_results.length === 0)
  )
}

/**
 * Map a source's getState() (+ the transient lastEvent) onto a flat `live_scores`
 * row for `sport`.
 *
 * ⚠ The three sources share ONE a/b liveState shape and reuse fields differently —
 * BasketballSource carries **team fouls in `subs_a`/`subs_b`** and always reports
 * `sets_won_* = 0`. That reuse is an internal board convention; the wire format is
 * explicit (`fouls_a`/`fouls_b`), so the translation happens exactly here. Sending
 * fouls in a field called `subs` would make the payload lie to every reader.
 *
 * `over` is derived from MATCH STATE, not from the transient `match-end` event:
 * lastEvent is cleared on the very next apply(), so an event-derived flag would
 * show "Final" for one push and then fall back to "live" while the board still
 * sits on a finished match.
 */
export function toRow(state, event, sport = DEFAULTS.sport) {
  const isBasketball = sport === 'basketball'
  // Filtered, not just type-checked: a relay-supplied liveState can carry a null in here, and the
  // map() at the bottom used to throw on it — one level up that throw wedged publishing for the
  // rest of the process (see flush()).
  const setResults = (Array.isArray(state.set_results) ? state.set_results : [])
    .filter((r) => r && typeof r === 'object')
  const over = isOver(state, sport)
  // The board's own sources always report team A on the left, but a LINKED OpenVolley liveState
  // keeps A as a fixed team and says where it stands in `side_a` ('right' in sets 2 and 4), with
  // `serving_team` as the PHYSICAL side. The row below is always A-left (the app reads 'left' as
  // team A), so serve/possession has to be re-projected onto A/B or the dot sits on the wrong team
  // for every rally of an even set.
  const aOnRight = state.side_a === 'right'
  const status = over || event === 'match-end' ? 'final' : isBlank(state) ? 'idle' : 'live'

  return {
    sport,
    status,
    event: event ?? null,
    ts: Date.now(),
    over,
    // Basketball publishes the real period (1..4 = Q1..Q4, 5+ = overtime). For
    // volleyball/beach the app shows the set being played — counted from set_results where the
    // source keeps them, else OpenVolley's 1-based `current_set` (a relay liveState carries no
    // set_results at all, so counting alone pinned every linked match at "Set 1").
    // Once the match is final there is no next set: report the last one played, or /live shows
    // "Set 4" under a 3:0 result.
    period: isBasketball ? num(state.period)
      : setResults.length ? setResults.length + (status === 'final' ? 0 : 1)
      : num(state.current_set) || 1,
    side_a: 'left',
    team_a_name: state.team_a_name ?? '',
    team_a_short: state.team_a_short ?? '',
    team_a_color: state.team_a_color ?? '',
    team_b_name: state.team_b_name ?? '',
    team_b_short: state.team_b_short ?? '',
    team_b_color: state.team_b_color ?? '',
    points_a: num(state.points_a),
    points_b: num(state.points_b),
    sets_won_a: num(state.sets_won_a),
    sets_won_b: num(state.sets_won_b),
    timeouts_a: num(state.timeouts_a),
    timeouts_b: num(state.timeouts_b),
    // See the note above: subs and fouls occupy the same source field.
    subs_a: isBasketball ? 0 : num(state.subs_a),
    subs_b: isBasketball ? 0 : num(state.subs_b),
    fouls_a: isBasketball ? num(state.subs_a) : 0,
    fouls_b: isBasketball ? num(state.subs_b) : 0,
    // Volleyball/beach: who serves. Basketball: the possession arrow — the board
    // uses the same left/right field, and so does the app.
    serving_team: (aOnRight ? otherSide(state.serving_team) : state.serving_team) ?? null,
    // `dur` (the set's playing time in whole seconds, see manualSource) rides along where the source
    // timed the set, and is simply absent where it didn't — a set resumed mid-play after a restart,
    // a linked OpenVolley match, a hand-typed result. The app sums them into the match time only
    // when every set has one, so a guessed value here would be worse than none.
    set_results: setResults.map((r) => ({ a: num(r.a), b: num(r.b), ...durField(setDur(r)) })),
  }
}

// Nothing has been scored yet: no points, no sets, no recorded set results. Names may already be
// typed in (they usually are before the first whistle), so this is a superset of isBlank() — and
// unlike isBlank() it is the state EVERY match passes through on its way up, whatever the sport.
// It is the one signal that separates "a new match began" from "the scorer corrected the last one",
// which no property of the finished row itself can do (see the counter below).
function isFresh(s) {
  // Points and sets alone. `set_results` is deliberately NOT consulted: toRow() filters junk out of
  // it and this did not, so the two disagreed — a state published as a completely empty 0-0 board
  // was classified as "not fresh" here because the array held a null or an upstream's {a:0,b:0}
  // placeholder for the in-progress set, and the next match then never started a new instance and
  // was dropped from history. A board at 0-0 with no sets IS the start of a match, whatever an
  // upstream chose to pad that array with.
  return !num(s.points_a) && !num(s.points_b) && !num(s.sets_won_a) && !num(s.sets_won_b)
}

// Who is playing. Not a match identity on its own — a club plays the same opponent twice in an
// evening — but a CHANGE in it is proof the match changed, which is what the counter needs for the
// flows that never pass through 0-0.
// Order-independent on purpose: the manual sources report team A as whoever is on the LEFT, so a
// change of ends (the Swap button, or next-set) exchanges team_a and team_b. Read in order, that
// looked like two new teams, and a swap after the final started a new instance of the very match
// that was just archived — one more permanent live_history row per press.
function whoIsPlaying(s) {
  return [s.team_a_name || s.team_a_short || '', s.team_b_name || s.team_b_short || '']
    .map(String).sort().join('|')
}

export function createLivePush(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const base = String(cfg.url || '').replace(/\/$/, '')
  const enabled = !!(base && cfg.token)
  // Runtime on/off, distinct from `enabled` (the env capability): the operator's
  // "Connect to live scoring" toggle. env present = the board CAN publish; isLive() = it MAY
  // right now. Defaults to always-on so createLivePush stays drop-in (e.g. for the selftest).
  const isLive = typeof opts.isLive === 'function' ? opts.isLive : () => true
  // The sport is fixed at boot (changing it restarts the appliance), so it is a
  // constructor option rather than something read per push. An unknown key falls
  // back to the default, mirroring sports.js getSport().
  const KNOWN = ['volleyball', 'beach', 'basketball']
  const sport = KNOWN.includes(cfg.sport) ? cfg.sport : DEFAULTS.sport

  let pending = null // latest { state, event } waiting to be flushed
  let timer = null
  let backingOff = false // `timer` is a retry backoff, not the debounce of a new change
  let attached = null // { source, handler } when attach() is active
  let inFlight = false // a flush is running — never overlap writes to one row
  // Which match is on the board, as a plain counter bumped on every fresh→scored edge, and which
  // one has already been archived. Deliberately NOT a key hashed out of the row: nothing in a row
  // says WHICH match it is, so two different games hash the same (measured: the club's second
  // basketball game of the evening against the same opponent keyed identically to the first, down
  // to the quarter line scores, and was never archived), while the ONE match the row does identify
  // changes its own hash the moment the scorer corrects a set score after the final. Content
  // identity therefore loses matches AND duplicates them; a counter does neither.
  let matchInstance = 0
  let atMatchStart = true // the board is at 0 and the next point starts a NEW match
  // Instances already written to history. A set rather than "the last one" because a backlog can
  // land out of order; pruned, since instances only grow and nothing old is ever asked about again.
  const archived = new Set()
  let playing = null // who was on the board last time, so a change of teams can start an instance
  // Finished matches whose history row has not been written yet, by instance — the LATEST final
  // row of each. Separate from `pending` because a failed archive must survive the next match's
  // first point replacing the live payload. Bounded: a history POST that keeps failing drops the
  // oldest entry rather than growing without end.
  const unarchived = new Map()
  let failures = 0 // consecutive failed flushes, for the retry backoff
  let generation = 0 // bumped by detach() so a flush already in flight does not re-arm afterwards

  // Kept for the incidental call sites; the interesting ones log structured data directly.
  function log(...a) { plog.debug(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }

  function markArchived(match) {
    archived.add(match)
    for (const m of archived) if (m < match - 50) archived.delete(m)
  }

  // Coalesce a burst of rapid changes (typed corrections, next-set, a swap) into
  // ONE write carrying the LATEST state — the app only ever wants "now".
  function push(state, event = null) {
    // Stamped here, ahead of every guard and every drop, because push() is the only place that
    // sees EVERY state: flush() sees the last one of a burst, so a reset followed inside 150ms by
    // the next match's team names never shows it a board at 0, and an operator who flips "Connect
    // to live scoring" off between two games hides the whole first half of the second one.
    if (state) {
      // Passing through 0-0 is the signal every match started ON this board gives. It is not the
      // only way a match can arrive, though: POST /api/link hands the SourceManager a brand-new
      // LanSource with no neutral state in between, so linking a LAN match the tablet crew already
      // started puts a mid-match board up with no zero anywhere — and the previous match's
      // instance would still be current, so the linked one was never archived. A change of teams
      // cannot happen inside a match, so it is safe proof that this is a different one.
      //
      // Known gap, deliberately not guessed at: resuming a saved match of the SAME fixture after
      // another match of that fixture already finished this session reuses the instance and is not
      // archived. Distinguishing it from a post-final score correction needs a real match id in
      // liveState, which no source sets today; inventing a heuristic here would trade a rare lost
      // row for a common duplicate one, and history is append-only so a duplicate cannot be undone.
      const who = whoIsPlaying(state)
      if (isFresh(state)) atMatchStart = true
      else if (atMatchStart) { matchInstance++; atMatchStart = false }
      // Never on a board that already reads as finished: whatever changes there (a name typo fixed
      // for the result screen, a late swap) is still the match that just ended — and was archived.
      else if (playing !== null && who !== playing && !isOver(state, sport)) matchInstance++
      playing = who
    }
    if (!enabled || !isLive() || !state) {
      // Silently doing nothing is the correct behaviour AND the most confusing one ("why is
      // /live not updating?"), so say which of the two switches is off.
      plog.debug('push skipped', { configured: enabled, publishing: enabled && isLive(), hasState: !!state })
      return
    }
    pending = { state, event, match: matchInstance }
    if (inFlight) return // settle() sends it when the running flush ends
    // A newer state cuts a retry backoff short. The backoff exists to stop hammering a Directus
    // that keeps failing with the SAME payload; a new point is new information, and waiting out up
    // to retryMaxMs for it left /live half a minute behind a board whose uplink had long recovered.
    // `failures` is kept, so if this attempt fails too the next backoff is longer, not reset.
    if (timer && !backingOff) return
    if (timer) clearTimeout(timer)
    backingOff = false
    timer = arm()
  }

  function arm(ms = cfg.debounceMs) {
    const t = setTimeout(flush, ms)
    if (t.unref) t.unref() // never hold the process open for a score ping
    return t
  }

  // Worth trying again: the network, a timeout, or Directus itself having a bad moment. A 4xx is
  // the request's own fault (bad token, missing permission, schema drift) and would fail the same
  // way forever, so it is logged and dropped instead.
  const retryable = (status) => status === 0 || status >= 500 || status === 408 || status === 429

  // Read the response to the end. undici only returns a keep-alive socket to its pool once the
  // body is consumed (or collected), so an unread body meant a fresh TLS handshake to Directus on
  // nearly every point — from an armhf board, on hall Wi-Fi, inside a 2 s budget.
  async function drain(res) {
    try { if (res && res.body && typeof res.arrayBuffer === 'function') await res.arrayBuffer() } catch { /* ignore */ }
  }

  async function flush() {
    timer = null
    backingOff = false
    const payload = pending
    pending = null
    if (!payload) return

    inFlight = true
    const gen = generation
    let retry = false // did this flush fail in a way that is worth sending again?
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    try {
      // toRow() belongs INSIDE the try: it used to run just above it, so a throw there skipped the
      // finally that resets inFlight, and every later push() then returned at the overlap guard —
      // /live froze on the last published score for the rest of the process, with nothing said.
      // A throw here is a bug in the state, not the network, so it is never retried.
      const row = toRow(payload.state, payload.event, sport)

      // Queued BEFORE the live write and independently of it: whether the result reaches history
      // must not depend on whether one PATCH got through. The latest final row of the instance
      // wins, so a set-score correction made while the archive is still failing is what lands.
      if (row.status === 'final' && !archived.has(payload.match)) {
        unarchived.set(payload.match, row)
        if (unarchived.size > 5) unarchived.delete(unarchived.keys().next().value)
      } else if (row.status !== 'final') {
        // A correction took the match back out of 'final' (remove-set) before its archive got
        // through: that result no longer stands, and the match re-queues when it ends again.
        unarchived.delete(payload.match)
      }

      try {
        // The row's primary key IS the channel, so PATCH the known item. If it was
        // never seeded, Directus 404s → create it (POST) so the board self-heals.
        // update+create is exactly what the publisher policy grants.
        const coll = encodeURIComponent(cfg.collection)
        let res = await fetch(`${base}/items/${coll}/${encodeURIComponent(cfg.channel)}`, {
          method: 'PATCH', headers, body: JSON.stringify(row), signal: ctrl.signal,
        })
        if (res.status === 404) {
          await drain(res)
          plog.info('row missing — creating the channel', { channel: cfg.channel, collection: cfg.collection })
          res = await fetch(`${base}/items/${coll}`, {
            method: 'POST', headers, body: JSON.stringify({ channel: cfg.channel, ...row }), signal: ctrl.signal,
          })
        }
        await drain(res)
        if (!res.ok) {
          plog.warn(`directus responded ${res.status}`, { status: res.status, channel: cfg.channel, collection: cfg.collection })
          if (retryable(res.status)) retry = true
        } else {
          plog.debug(`published ${row.points_a}-${row.points_b}`, {
            sport, status: row.status, score: `${row.points_a}-${row.points_b}`,
            sets: `${row.sets_won_a}-${row.sets_won_b}`, event: row.event,
          })
        }
      } catch (err) {
        // Swallowed — scoring must not care — but no longer invisible, and sent again: the last
        // point of a match is followed by silence, so nothing else would ever correct the row.
        plog.warn(`publish failed: ${err && err.message}`, { error: err && err.message, channel: cfg.channel })
        retry = true
      }

      // Archive the result the FIRST time a match reads as finished, so /live can
      // show recent matches once this row is overwritten by the next game. History is
      // append-only (the board has create and nothing else, so it cannot clean up
      // after itself), so this must fire exactly once per match — no more, and no less.
      // Keyed on the match INSTANCE, not on the live→final edge and not on the row's
      // contents. The edge fired again whenever a set correction after the final
      // republished 'live' and then 'final' (a remove-set, or a set −1 and back), and
      // appended a second row for the same match; the contents change on that same
      // correction, and cannot tell two back-to-back games apart at all.
      // Marked done once Directus has CONFIRMED the row, and retried only while the POST provably
      // never landed: a refused connection, a failed DNS lookup, a 503. A POST whose outcome is
      // unknown — aborted after it was sent, a socket reset mid-response, a gateway timeout — may
      // well be committed, and resending it is how one match became up to nine identical rows the
      // board has no right to delete. Those are given up on instead, like a 4xx: a possibly lost
      // row, logged, over a possibly duplicated one.
      // ⚠ The counter is in memory: restarting the appliance while a finished match is
      // still on the board can archive it a second time.
      for (const [match, finalRow] of [...unarchived]) {
        const status = await archive(finalRow)
        if (status >= 200 && status < 300) { unarchived.delete(match); markArchived(match) }
        else if (archiveRetryable(status)) retry = true
        else {
          unarchived.delete(match) // logged by archive()
          // Not re-queued by the next push of this still-finished board either.
          if (mayHaveLanded(status)) markArchived(match)
        }
      }
    } catch (err) {
      plog.warn(`publish failed: ${err && err.message}`, { error: err && err.message, channel: cfg.channel })
    } finally {
      clearTimeout(t)
      inFlight = false
      if (gen === generation) settle(payload, retry)
    }
  }

  // After a flush: send what is waiting — a change that landed mid-flight, or, after a failure,
  // this payload again. A retry always carries the LATEST state: a newer push() already in
  // `pending` wins over the one that failed, and every retry is a full overwrite of the one row.
  function settle(payload, retry) {
    if (!retry) {
      failures = 0
      if (pending && !timer) timer = arm()
      return
    }
    failures++
    if (failures > cfg.maxRetries) {
      plog.warn(`giving up after ${cfg.maxRetries} retries — the next board change will try again`, { channel: cfg.channel })
      failures = 0
      if (pending && !timer) timer = arm()
      return
    }
    if (!pending) pending = payload
    const delay = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** (failures - 1))
    plog.debug(`retrying in ${delay}ms`, { attempt: failures, delay })
    if (timer) clearTimeout(timer)
    timer = arm(delay)
    backingOff = true
  }

  // archive()'s answer when the POST may or may not have been committed. Never retried.
  const OUTCOME_UNKNOWN = -1
  // retryable() minus everything that can mean "the server got it and the answer was lost": 504
  // and Cloudflare's 524 are a proxy giving up on an origin that HAD the request.
  const mayHaveLanded = (status) => status === OUTCOME_UNKNOWN || status === 504 || status === 524
  const archiveRetryable = (status) => !mayHaveLanded(status) && retryable(status)

  // Errors raised before a single byte of the request left the board — the only failures of a
  // non-idempotent POST that are safe to repeat. undici wraps them as TypeError('fetch failed')
  // with the system error in `cause` (an AggregateError of per-address errors when happy-eyeballs
  // tried several). An AbortError, a reset socket or anything unrecognised is NOT in here: it
  // can happen after the body was sent, so it has to be treated as possibly delivered.
  const PRE_SEND = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
    'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
  ])
  // A TLS handshake that failed on the certificate never got as far as sending the request either.
  const TLS_REJECT = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/
  function neverSent(err) {
    for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
      if (e.name === 'AbortError') return false
      const codes = [e.code, ...(Array.isArray(e.errors) ? e.errors.map((x) => x && x.code) : [])]
      if (codes.some((c) => c && (PRE_SEND.has(c) || TLS_REJECT.test(c)))) return true
    }
    return false
  }

  /**
   * Append one finished match to `live_history`. Best-effort like everything else:
   * a failure here loses a history row, never a point on the board. Separate from
   * the live row on purpose — `live_scores` is one mutable row per board, this is
   * the append-only log behind /live's "recent matches". Resolves to the HTTP status, 0 when
   * the request provably never left the board, OUTCOME_UNKNOWN when it may have landed with the
   * answer lost — never throws.
   */
  async function archive(row) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), cfg.archiveTimeoutMs)
    try {
      const res = await fetch(`${base}/items/${encodeURIComponent(cfg.historyCollection)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({
          channel: cfg.channel,
          sport: row.sport,
          team_a_name: row.team_a_name, team_a_short: row.team_a_short, team_a_color: row.team_a_color,
          team_b_name: row.team_b_name, team_b_short: row.team_b_short, team_b_color: row.team_b_color,
          points_a: row.points_a, points_b: row.points_b,
          sets_won_a: row.sets_won_a, sets_won_b: row.sets_won_b,
          period: row.period,
          set_results: row.set_results,
          ts: row.ts,
        }),
        signal: ctrl.signal,
      })
      await drain(res)
      if (res.ok) plog.info('archived finished match', { channel: cfg.channel, score: `${row.sets_won_a}-${row.sets_won_b}`, teams: `${row.team_a_short}/${row.team_b_short}` })
      else plog.warn(`archive responded ${res.status}`, { status: res.status, collection: cfg.historyCollection })
      // A stub or proxy that says ok without a number is still a success.
      return res.ok ? (res.status || 200) : (res.status || 0)
    } catch (err) {
      if (neverSent(err)) {
        plog.warn(`archive failed: ${err && err.message}`, { error: err && err.message, cause: err?.cause?.code }) // swallow
        return 0
      }
      // Said loudly: this is the one path where a finished match can go missing from /live's
      // history, and "why is Saturday's game not listed?" should be answerable from /logs.
      plog.warn(`archive outcome unknown, not resent: ${err && err.message}`, {
        error: err && err.message, cause: err?.cause?.code,
        teams: `${row.team_a_short}/${row.team_b_short}`, score: `${row.sets_won_a}-${row.sets_won_b}`,
      })
      return OUTCOME_UNKNOWN
    } finally {
      clearTimeout(t)
    }
  }

  // `lastEvent` is set by the source's apply() BEFORE it emits 'state', so reading
  // it inside the handler is correct. A LAN source doesn't have one.
  const readEvent = (source) => source?.active?.lastEvent ?? source?.lastEvent ?? null

  /**
   * Subscribe to a SourceManager (preferred — covers BOTH the hand-driven board
   * and a linked LAN match) or to a bare scoring Source. Either works: the event
   * lookup above degrades to null.
   */
  function attach(source) {
    if (!enabled || !source || attached) return
    const handler = (state) => push(state, readEvent(source))
    source.on('state', handler)
    attached = { source, handler }
    // Publish the current board immediately so the page isn't stale until the
    // next point. SourceManager exposes getState() too, so this covers both.
    if (typeof source.getState === 'function') {
      const s = source.getState()
      if (s) push(s, readEvent(source))
    }
    plog.info(`attached — ${base}/items/${cfg.collection}/${cfg.channel} (${sport})`, {
      target: `${base}/items/${cfg.collection}/${cfg.channel}`, sport, publishing: isLive(),
    })
  }

  function detach() {
    if (attached) { attached.source.off('state', attached.handler); attached = null }
    if (timer) { clearTimeout(timer); timer = null }
    backingOff = false
    pending = null
    failures = 0
    generation++ // a flush still in flight must not re-arm a retry for a detached publisher
  }

  return { enabled, sport, push, attach, detach, isLive }
}

/**
 * Build from the environment. Returns a disabled stub (all no-ops) when
 * DIRECTUS_URL or LIVE_PUBLISH_TOKEN is unset, so wiring it in is always safe —
 * a board with no cloud config behaves exactly as it does today.
 */
export function livePushFromEnv(env = process.env, sport = DEFAULTS.sport, isLive) {
  return createLivePush({
    url: env.DIRECTUS_URL,
    token: env.LIVE_PUBLISH_TOKEN,
    channel: env.LIVE_CHANNEL || DEFAULTS.channel,
    collection: env.LIVE_COLLECTION || DEFAULTS.collection,
    historyCollection: env.LIVE_HISTORY_COLLECTION || DEFAULTS.historyCollection,
    sport,
    isLive,
    debug: /^(1|true|yes|on)$/i.test(String(env.DEBUG || '')),
  })
}
