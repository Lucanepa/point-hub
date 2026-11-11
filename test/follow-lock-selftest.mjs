// While the board follows the OpenVolley eScoresheet, scoring on the board is off: a + there as well
// would count the rally twice, and a tap used to drop the link without a word. The way out is an
// explicit take-over that keeps the score the board shows.
//
// A real relay (ws) and the real appliance in Link mode, a MockLedbox for the panel.

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const SEED = 'match_1760000000000_lock01'
const relay = http.createServer((req, res) => {
  if (req.url.startsWith('/api/match/list')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ matches: [{ id: SEED, homeTeam: 'MUST', awayTeam: 'VBC', status: 'live' }] }))
  }
  res.writeHead(404); res.end()
})
const wss = new WebSocketServer({ server: relay })
const LIVE = {
  team_a_name: 'VBC Musterdorf', team_a_short: 'MUST', team_a_color: '#2563eb',
  team_b_name: 'Volley Testteam', team_b_short: 'TEST', team_b_color: '#ef4444',
  points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0, side_a: 'left', serving_team: 'left',
  timeouts_a: [{}], timeouts_b: [], subs_a: [{}, {}], subs_b: [], match_status: 'in_progress',
}
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf))
    if (msg.type === 'subscribe-match' && msg.matchId === SEED) {
      ws.send(JSON.stringify({ type: 'match-full-data', matchId: SEED, data: { liveState: LIVE } }))
    }
  })
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const RELAY = `127.0.0.1:${relay.address().port}`

const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-lock-'))
const app = await startAppliance({
  stateDir, relayUrl: `ws://${RELAY}`, relayDiscovery: false,
  mock: false, ledboxHost: '127.0.0.1', ledboxPort: addr.port, controlPort: 0, reconnectMs: 100,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const J = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json().catch(() => null) } }
const post = (p, body = {}) => J(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const status = async () => (await J('/api/status')).body

try {
  for (let i = 0; i < 100 && !app.ledbox.ready; i++) await sleep(20)
  const linked = await post('/api/link', { source: 'lan', matchId: SEED, relay: RELAY })
  ok(linked.status === 200, `linked to the scoresheet (${linked.status})`)
  let st
  for (let i = 0; i < 100; i++) { st = await status(); if (st.state && st.state.points_a === 12) break; await sleep(30) }
  ok(st.mode === 'lan' && st.state.points_a === 12, `the board shows the scoresheet's 12:9 (mode ${st.mode})`)

  console.log('\n[1] a tap on the board is refused while it follows')
  const tap = await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  ok(tap.status === 409 && tap.body.reason === 'following', `+1 → 409 following (${tap.status})`)
  ok(/OpenVolley eScoresheet/.test(tap.body.error || '') && /Stop following/.test(tap.body.error || ''), '...saying why and how to score here')
  st = await status()
  ok(st.mode === 'lan' && st.matchId === SEED, 'the link is still there')
  ok(st.state.points_a === 12, 'and the score did not move')
  const rename = await post('/api/action', { action: { type: 'team', side: 'left', short: 'XXX' } })
  ok(rename.status === 409, 'a name change is refused too: the scoresheet owns the names')

  console.log('\n[2] "Stop following and score here" keeps the score the board shows')
  const take = await post('/api/manual', { takeOver: true })
  ok(take.status === 200 && take.body.mode === 'manual', `take-over → manual (${take.status}, ${take.body && take.body.mode})`)
  const s = take.body.state || {}
  ok(s.points_a === 12 && s.points_b === 9 && s.sets_won_a === 1, `12:9, sets 1:0 carried over (${s.points_a}:${s.points_b}, ${s.sets_won_a}:${s.sets_won_b})`)
  const next = await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  ok(next.status === 200 && next.body.state.points_a === 13, `then a tap scores here: 13:9 (${next.body && next.body.state && next.body.state.points_a})`)

  console.log('\n[3] a plain tap when not following is unchanged')
  const plain = await post('/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
  ok(plain.status === 200 && plain.body.state.points_b === 10, 'manual scoring as before')

  console.log('\n[4] the console says so')
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  ok(html.includes('id="followBar"') && html.includes('$("#followBar").hidden = !linked'), 'a banner while the board follows')
  ok(/body\.following \.board, body\.following #undoBtn\{opacity:\.4;pointer-events:none\}/.test(html), 'the scoring controls are faded and take no taps')
  ok(html.includes('postJSON("/api/manual", { takeOver: true })') && html.includes('askConfirm("Stop following'), 'Stop following asks first, then takes over')
} finally {
  await app.close()
  await mock.close()
  relay.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} follow-lock: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
