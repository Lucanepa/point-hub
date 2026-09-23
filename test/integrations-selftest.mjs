// Regressions for the outbound/inbound integrations: the wiedisync /live publisher (retry with
// backoff, archive-once across a change of ends, a linked OpenVolley liveState's side_a, drained
// response bodies), the LAN link's first paint and log level, and the CPU temperature reading.
//
// No network: a stub `fetch` records every request; RelaySubscriber is fed frames directly.

import { createLivePush, toRow } from '../src/livePush.js'
import { ManualSource } from '../src/manualSource.js'
import { SourceManager } from '../src/sourceManager.js'
import { LanSource } from '../src/lanSource.js'
import { RelaySubscriber } from '../src/relaySubscriber.js'
import { parseMilliC } from '../src/systemInfo.js'
import { log as logStore } from '../src/logStore.js'

logStore.configure({ console: false, level: 'debug' })

let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const realFetch = globalThis.fetch
let calls = []
// `handler(call)` returns a response or throws; the default is a plain 200.
function stubFetch(handler) {
  calls = []
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method, body: JSON.parse(init?.body || '{}') }
    calls.push(call)
    return handler ? handler(call) : { ok: true, status: 200 }
  }
}
const hist = () => calls.filter((c) => c.url.includes('live_history'))
const live = () => calls.filter((c) => c.url.includes('live_scores'))

const CFG = { url: 'https://directus.example', token: 'tok', debounceMs: 5, retryBaseMs: 20, retryMaxMs: 40, maxRetries: 3 }

// ── #27 A change of ends after the final is the same match ─────────────────
console.log('\nswap / next-set after the final does not archive again')
{
  stubFetch()
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  src.apply({ type: 'team', side: 'left', short: 'KSCW' })
  src.apply({ type: 'team', side: 'right', short: 'VZH' })
  src.apply({ type: 'point', side: 'left', delta: 1 }); lp.push(src.getState()); await wait(30)
  src.apply({ type: 'set', side: 'left', value: 3 }); lp.push(src.getState()); await wait(30)
  assert(hist().length === 1, `the final is archived once (got ${hist().length})`)
  src.apply({ type: 'swap' }); lp.push(src.getState()); await wait(30)
  src.apply({ type: 'swap' }); lp.push(src.getState()); await wait(30)
  assert(hist().length === 1, `two swaps after the final add no rows (got ${hist().length})`)

  // Renaming a team on the finished board (a typo fixed for the result screen) is still that match.
  src.apply({ type: 'team', side: 'left', short: 'KSC W' }); lp.push(src.getState()); await wait(30)
  assert(hist().length === 1, `a name change on a finished board adds no row (got ${hist().length})`)

  // A genuinely different match still counts, even without passing through 0-0 (LAN link).
  lp.push({ team_a_short: 'AMRI', team_b_short: 'GC', points_a: 8, points_b: 5 }); await wait(30)
  lp.push({ team_a_short: 'AMRI', team_b_short: 'GC', points_a: 25, sets_won_a: 3 }); await wait(30)
  assert(hist().length === 2, `a different fixture is still archived (got ${hist().length})`)
  lp.detach()
}

// ── #28 A failed PATCH is retried, with the latest state, and bounded ───────
console.log('\nretry after a failed publish')
{
  let down = true
  stubFetch(() => { if (down) throw new Error('timeout'); return { ok: true, status: 200 } })
  const lp = createLivePush(CFG)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 24, points_b: 20 }); await wait(10)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 25, points_b: 20, sets_won_a: 3 })
  down = false
  await wait(150)
  const last = live().at(-1)
  assert(live().length >= 2, `the failed write was retried (${live().length} PATCHes)`)
  assert(last.body.points_a === 25 && last.body.status === 'final', 'the retry carries the LATEST state, final')
  assert(hist().length === 1, `the match is archived after the retry (got ${hist().length})`)
  lp.detach()
}
{
  stubFetch(() => { throw new Error('network down') })
  const lp = createLivePush(CFG)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 3 })
  await wait(400)
  const n = calls.length
  assert(n === 1 + CFG.maxRetries, `retries stop after maxRetries (got ${n} attempts, want ${1 + CFG.maxRetries})`)
  await wait(100)
  assert(calls.length === n, 'and nothing keeps polling afterwards')
  lp.detach()
}
{
  stubFetch(() => ({ ok: false, status: 403 }))
  const lp = createLivePush(CFG)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 3 })
  await wait(120)
  assert(calls.length === 1, `a 403 (bad token) is not retried (got ${calls.length})`)
  lp.detach()
}
{
  // The history POST fails once: it must not be marked archived, and must land on the retry.
  let archiveFails = 1
  stubFetch((c) => {
    if (c.url.includes('live_history') && archiveFails-- > 0) return { ok: false, status: 503 }
    return { ok: true, status: 200 }
  })
  const lp = createLivePush(CFG)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 20 }); await wait(10)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 25, sets_won_a: 3 })
  await wait(150)
  const posted = hist()
  assert(posted.length === 2, `a failed archive is retried (got ${posted.length} POSTs)`)
  assert(posted.every((c) => c.body.sets_won_a === 3), 'with the finished result')
  await wait(80)
  assert(hist().length === 2, 'and stops once it succeeded')
  lp.detach()
}
{
  // detach() while a retry is pending must leave nothing running.
  stubFetch(() => { throw new Error('down') })
  const lp = createLivePush(CFG)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 1 }); await wait(10)
  lp.detach()
  const n = calls.length
  await wait(150)
  assert(calls.length === n, 'detach cancels the retry loop')
}
{
  // The scoring path is never touched by any of this.
  globalThis.fetch = async () => { throw new Error('boom') }
  const lp = createLivePush(CFG)
  const src = new ManualSource()
  let threw = false
  try { lp.attach(src); for (let i = 0; i < 5; i++) src.apply({ type: 'point', side: 'left', delta: 1 }); await wait(60) } catch { threw = true }
  assert(!threw && src.getState().points_a === 5, 'retries never reach the scoring path')
  lp.detach()
}

// ── #29 A linked OpenVolley liveState: side_a and current_set ──────────────
console.log('\nOpenVolley liveState (team A on the right)')
{
  const ov = { team_a_short: 'KSCW', team_b_short: 'VZH', side_a: 'right', serving_team: 'left', current_set: 2, sets_won_a: 1, points_a: 3, points_b: 5 }
  const row = toRow(ov, null, 'volleyball')
  assert(row.side_a === 'left', 'the row stays A-left')
  assert(row.serving_team === 'right', 'serve on the LEFT side with A on the right is team B → "right"')
  assert(toRow({ ...ov, serving_team: 'right' }).serving_team === 'left', 'and the other way round')
  assert(toRow({ ...ov, side_a: 'left' }).serving_team === 'left', 'A on the left passes through unchanged')
  assert(row.period === 2, `period follows current_set when set_results is absent (got ${row.period})`)
  const vb = new ManualSource()
  vb.apply({ type: 'serve', side: 'right' })
  assert(toRow(vb.getState()).serving_team === vb.getState().serving_team, 'manual sources are unaffected')
}

// ── #31 Response bodies are consumed so keep-alive sockets are reused ──────
console.log('\nresponse bodies are drained')
{
  let drained = 0
  const res = (status) => ({ ok: status < 400, status, body: {}, arrayBuffer: async () => { drained++; return new ArrayBuffer(0) } })
  let first = true
  stubFetch((c) => {
    if (first && c.method === 'PATCH') { first = false; return res(404) }
    return res(200)
  })
  const lp = createLivePush(CFG)
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 25, sets_won_a: 3 })
  await wait(60)
  assert(calls.length === 3, `PATCH 404 → POST → archive (got ${calls.length})`)
  assert(drained === 3, `every response body was read (got ${drained} of 3)`)
  lp.detach()
}

// ── #26 Linking a LAN match paints neutral, not the previous game ──────────
console.log('\nLAN link: first paint and log level')
{
  const sm = new SourceManager()
  sm.setSource({ on() {}, removeListener() {}, start() {}, stop() {}, getState: () => ({ team_a_short: 'OLD', points_a: 25, sets_won_a: 3 }) }, { mode: 'manual' })
  const painted = []
  sm.on('state', (s) => painted.push(s))
  const lan = new LanSource({ relayUrl: 'ws://127.0.0.1:9', matchId: 'm1', reconnectMs: 0 })
  lan.on('error', () => {})
  sm.setSource(lan, { mode: 'lan', matchId: 'm1' })
  const first = painted[0]
  assert(first && first.team_a_short === '' && first.points_a === 0 && first.sets_won_a === 0,
    'the link paints a neutral board at once instead of leaving the old score up')
  lan.sub._onMessage(JSON.stringify({ type: 'live-state-update', matchId: 'm1', liveState: { team_a_short: 'NEW', points_a: 7 } }))
  assert(painted.at(-1).team_a_short === 'NEW' && lan.getState().points_a === 7, 'the first liveState replaces it')
  sm.stop()
}
{
  const sub = new RelaySubscriber({ url: 'ws://127.0.0.1:9', matchId: 'm1' })
  const since = logStore.entries.length ? logStore.entries.at(-1).id : 0
  let nostate = 0
  sub.on('nostate', () => nostate++)
  sub._onMessage(JSON.stringify({ type: 'match-data-update', matchId: 'm1', data: { match: {}, sets: [] } }))
  sub._onMessage(JSON.stringify({ type: 'match-full-data', matchId: 'm1', data: { match: {} } }))
  const mine = logStore.entries.filter((e) => e.id > since && e.scope === 'relay')
  assert(nostate === 2, 'a sync without liveState is still reported as nostate')
  assert(!mine.some((e) => e.level === 'warn' || e.level === 'error'), 'but is no longer logged as a warning')
}

// ── #33 CPU temperature ────────────────────────────────────────────────────
console.log('\nCPU temperature')
{
  assert(parseMilliC('') === null, 'a missing thermal zone is null, not 0 °C')
  assert(parseMilliC(null) === null, 'so is no value at all')
  assert(parseMilliC('garbage') === null, 'and an unparseable one')
  assert(parseMilliC('48312') === 48.3, 'millidegrees convert to one decimal')
  assert(parseMilliC('0') === 0, 'a real 0 is still 0')
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\n✅ integrations selftest passed' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
