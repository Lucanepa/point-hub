// Regressions for the /live publisher's two retry edges:
//   - the append-only live_history POST is resent ONLY when it provably never left the board
//     (refused connection, 503), never after an abort or a gateway timeout that may have committed
//     it — a timed-out archive used to be POSTed again up to maxRetries times per round, one
//     permanent duplicate row each;
//   - a new board change during a retry backoff goes out after the normal debounce instead of
//     waiting the backoff out (up to 30 s of a stale /live after Directus came back).
//
// Real sockets, not a stubbed fetch: whether an error counts as "never sent" depends on the exact
// shape undici gives it, and a stub would only test the stub.

import http from 'node:http'
import { createLivePush } from '../src/livePush.js'
import { log as logStore } from '../src/logStore.js'

logStore.configure({ console: false, level: 'debug' })

let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// A tiny Directus: records every request it RECEIVED (i.e. committed), answers per `respond`.
function fakeDirectus(respond) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const call = { method: req.method, url: req.url, body: JSON.parse(body || '{}') }
      seen.push(call)
      respond(call, res)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen, url: `http://127.0.0.1:${server.address().port}`,
    hist: () => seen.filter((c) => c.url.includes('live_history')),
    close: () => { server.closeAllConnections?.(); server.close() },
  })))
}
const ok = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }

const CFG = { token: 'tok', debounceMs: 5, retryBaseMs: 20, retryMaxMs: 40, maxRetries: 3, timeoutMs: 300 }
const FINAL = { team_a_short: 'A', team_b_short: 'B', points_a: 25, sets_won_a: 3 }

console.log('\nan archive that timed out after being received is not POSTed again')
{
  // The server commits the row, then answers too late for the client.
  const d = await fakeDirectus((c, res) => {
    if (c.url.includes('live_history')) setTimeout(() => ok(res), 200)
    else ok(res)
  })
  const lp = createLivePush({ ...CFG, url: d.url, archiveTimeoutMs: 60 })
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 20 }); await wait(30)
  lp.push(FINAL); await wait(400)
  assert(d.hist().length === 1, `one committed history row, not one per retry (got ${d.hist().length})`)
  // Further pushes of the same finished board must not re-queue it either.
  lp.push({ ...FINAL, team_a_short: 'A' }); await wait(300)
  assert(d.hist().length === 1, `a later push of the finished board adds no row (got ${d.hist().length})`)
  lp.detach(); d.close()
}

console.log('\na gateway timeout (504) is treated as possibly committed')
{
  const d = await fakeDirectus((c, res) => {
    if (c.url.includes('live_history')) { res.writeHead(504); res.end() } else ok(res)
  })
  const lp = createLivePush({ ...CFG, url: d.url })
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 20 }); await wait(30)
  lp.push(FINAL); await wait(300)
  assert(d.hist().length === 1, `a 504 archive is not resent (got ${d.hist().length})`)
  lp.detach(); d.close()
}

console.log('\nan archive that provably never left is retried until it lands')
{
  // A 503 (Directus refusing under load) is retried…
  let refuse = 2
  const d = await fakeDirectus((c, res) => {
    if (c.url.includes('live_history') && refuse-- > 0) { res.writeHead(503); res.end(); return }
    ok(res)
  })
  const lp = createLivePush({ ...CFG, url: d.url })
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 20 }); await wait(30)
  lp.push(FINAL); await wait(400)
  const landed = d.hist().length
  assert(landed === 3, `a 503 archive is retried until it lands (got ${landed} POSTs)`)
  lp.detach(); d.close()
}
{
  // …and so is one whose connection was refused outright: nothing reached any server.
  const d = await fakeDirectus(ok)
  const port = new URL(d.url).port
  d.close(); await wait(20) // nothing listens there now
  const lp = createLivePush({ ...CFG, url: `http://127.0.0.1:${port}` })
  let refusals = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    try { return await realFetch(url, init) } catch (e) { if (String(url).includes('live_history')) refusals++; throw e }
  }
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 20 }); await wait(30)
  lp.push(FINAL); await wait(400)
  globalThis.fetch = realFetch
  assert(refusals >= 2, `a refused archive is tried again (got ${refusals} attempts)`)
  lp.detach()
}

console.log('\na board change during a retry backoff is not held back by it')
{
  let down = true
  const d = await fakeDirectus((c, res) => { if (down) { res.writeHead(503); res.end() } else ok(res) })
  // A long backoff, so waiting it out is unmistakable.
  const lp = createLivePush({ ...CFG, url: d.url, retryBaseMs: 5000, retryMaxMs: 5000 })
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 1 }); await wait(60)
  assert(d.seen.length === 1, 'the first write failed and a 5 s backoff is pending')
  down = false
  const t0 = Date.now()
  lp.push({ team_a_short: 'A', team_b_short: 'B', points_a: 2 })
  while (d.seen.length < 2 && Date.now() - t0 < 2000) await wait(5)
  assert(d.seen.length === 2 && Date.now() - t0 < 500, `the new point went out after the debounce (${Date.now() - t0} ms)`)
  assert(d.seen.at(-1)?.body.points_a === 2, 'carrying the newer state')
  await wait(100)
  assert(d.seen.length === 2, 'and the cancelled backoff does not fire an extra write')
  lp.detach(); d.close()
}

console.log(failures === 0 ? '\n✅ archive-once selftest passed' : `\n❌ ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
