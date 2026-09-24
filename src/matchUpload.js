// ─────────────────────────────────────────────────────────────────────────────
// Uploads each finished match's play-by-play to wiedisync (`live_match_logs`), so the club can
// build statistics from it: points won in reception vs on serve, runs, comebacks, rally tempo.
//
//   historyStore (data/history.json) --finished, settled--> matchUpload --POST--> Directus
//                                                                   \--> data/match-uploads.json
//
// STORE-AND-FORWARD, NOT LIVE. livePush's row is lossy by design (debounced, latest-wins), and
// most halls give the board no uplink at all. The history on the card is the complete log, so
// this walks it and sends every match not yet uploaded — right after a match, every few minutes
// after that, and on the evening a dongle is plugged in the whole backlog goes at once.
//
// IDEMPOTENT BY KEY. Each match carries its own id (historyStore sets it at the first rally);
// Directus holds a UNIQUE (channel, match_key). So unlike livePush's archive, an upload whose
// answer was lost is simply sent again: if the first one landed, the retry is refused as a
// duplicate, which is read here as "done". Nothing is ever stored twice or given up on.
//
// Only matches logged since the id existed are sent — an older entry has no key to make a resend
// safe, and the card's backlog from before is mostly test games on the bench.
//
// Best-effort like livePush: nothing here may reach the scoreboard. Every failure is logged and
// swallowed; a match that fails stays on the list for the next round.
//
// Config — the same env as livePush (DIRECTUS_URL, LIVE_PUBLISH_TOKEN, LIVE_CHANNEL), plus
//   LIVE_MATCH_LOG_COLLECTION   Directus collection (default 'live_match_logs')
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { log as logStore } from './logStore.js'

const ulog = logStore.child('matchUpload')

const DEFAULTS = {
  channel: 'kscw', collection: 'live_match_logs',
  timeoutMs: 15000, // a 5-setter's log is ~60 KB; a 4G uplink on armhf needs the room
  intervalMs: 5 * 60 * 1000, // the regular sweep, which is also what picks up a returning uplink
  retryBaseMs: 30 * 1000, retryMaxMs: 5 * 60 * 1000,
  graceMs: 10 * 60 * 1000, // how long a just-finished match stays reopenable (historyStore.isSettled)
  finishDelayMs: 2000, // after a match-end, let the history save first
}

const SPORTS = ['volleyball', 'beach', 'basketball']

// The row as live_match_logs takes it. The history is already by TEAM (a = left at the first
// rally), so nothing is re-sided here.
export function toLogRow(match, channel) {
  const events = Array.isArray(match.events) ? match.events : []
  const gid = Number(match.game_id)
  return {
    channel,
    match_key: String(match.id),
    game_id: Number.isInteger(gid) && gid > 0 ? gid : null,
    sport: SPORTS.includes(match.sport) ? match.sport : 'volleyball',
    team_a: match.team_a ?? null,
    team_b: match.team_b ?? null,
    sets_a: Number(match.sets_a) || 0,
    sets_b: Number(match.sets_b) || 0,
    set_results: Array.isArray(match.sets) ? match.sets : [],
    events,
    event_count: events.length,
    board_date: match.date ? String(match.date).slice(0, 32) : null,
  }
}

// Directus answers a unique violation with 400 + RECORD_NOT_UNIQUE: the match is already there.
async function isDuplicate(res) {
  try {
    const body = await res.json()
    return Array.isArray(body?.errors) && body.errors.some((e) => e?.extensions?.code === 'RECORD_NOT_UNIQUE')
  } catch { return false }
}

export function createMatchUpload(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const base = String(cfg.url || '').replace(/\/$/, '')
  const enabled = !!(base && cfg.token)
  // The operator's "Connect to live scoring" toggle, as for livePush: env = CAN upload, this = MAY.
  const isLive = typeof opts.isLive === 'function' ? opts.isLive : () => true
  const file = cfg.file || null

  let history = null
  let timer = null
  let running = false
  let again = false
  let failures = 0
  let stopped = false
  const done = new Set(load())

  function load() {
    if (!file) return []
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data.keys) ? data.keys.map(String) : []
    } catch { return [] }
  }

  function save() {
    if (!file) return
    try {
      // Only keys still in the history: the card keeps the last 100 matches, so neither grows.
      const live = new Set((history ? history.matches : []).map((m) => m && m.id).filter(Boolean).map(String))
      for (const k of done) if (!live.has(k)) done.delete(k)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ keys: [...done] }))
      fs.renameSync(tmp, file)
    } catch (err) {
      ulog.warn(`could not save the upload list: ${err.message}`, { file, error: err.message })
    }
  }

  // What is waiting: finished matches with a key, not yet uploaded, whose result can no longer be
  // taken back.
  function queue() {
    if (!history) return []
    return history.matches.filter((m) => m && m.id && !done.has(String(m.id)) && history.isSettled(m, cfg.graceMs))
  }

  // Resolves 'ok' | 'dup' | 'fail'. Never throws.
  async function send(match) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
    try {
      const res = await fetch(`${base}/items/${encodeURIComponent(cfg.collection)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(toLogRow(match, cfg.channel)),
        signal: ctrl.signal,
      })
      if (res.ok) {
        try { await res.arrayBuffer() } catch { /* drained */ }
        return 'ok'
      }
      if (res.status === 400 && await isDuplicate(res)) return 'dup'
      ulog.warn(`upload responded ${res.status}`, { status: res.status, collection: cfg.collection, match: match.id })
      return 'fail'
    } catch (err) {
      ulog.info(`upload failed (will retry): ${err && err.message}`, { error: err && err.message, cause: err?.cause?.code, match: match.id })
      return 'fail'
    } finally {
      clearTimeout(t)
    }
  }

  async function sweep() {
    if (stopped || !enabled || !history) return
    if (running) { again = true; return }
    running = true
    let failed = false
    try {
      if (!isLive()) return
      for (const m of queue()) {
        const r = await send(m)
        if (r === 'fail') { failed = true; break } // the uplink is down or Directus is: try the rest later
        done.add(String(m.id))
        ulog.info(r === 'ok' ? 'uploaded match log' : 'match log already uploaded', {
          match: m.id, teams: `${m.team_a}/${m.team_b}`, score: `${m.sets_a}-${m.sets_b}`, events: (m.events || []).length, game: m.game_id ?? null,
        })
        save()
      }
    } finally {
      running = false
      failures = failed ? failures + 1 : 0
      if (again) { again = false; arm(0) } else arm()
    }
  }

  function arm(ms) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    const wait = ms ?? (failures ? Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** (failures - 1)) : cfg.intervalMs)
    timer = setTimeout(() => { timer = null; sweep() }, wait)
    if (timer.unref) timer.unref()
  }

  return {
    enabled,
    /** Start watching a HistoryStore. The first sweep runs shortly after boot. */
    attach(store) {
      history = store
      if (!enabled) return
      stopped = false
      arm(cfg.finishDelayMs)
    },
    /** A match just finished: sweep soon. It goes once it is settled (see historyStore.isSettled). */
    matchFinished() {
      if (enabled && history) arm(cfg.finishDelayMs)
    },
    /** For tests and the status page. */
    pending() { return queue().length },
    sweep,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/** Built from the environment; a disabled no-op when DIRECTUS_URL or LIVE_PUBLISH_TOKEN is unset. */
export function matchUploadFromEnv(env = process.env, { isLive, file } = {}) {
  return createMatchUpload({
    url: env.DIRECTUS_URL,
    token: env.LIVE_PUBLISH_TOKEN,
    channel: env.LIVE_CHANNEL || DEFAULTS.channel,
    collection: env.LIVE_MATCH_LOG_COLLECTION || DEFAULTS.collection,
    isLive,
    file,
  })
}
