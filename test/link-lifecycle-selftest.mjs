// Link mode against a relay shaped like OpenVolley's standalone server (HTTP and WS on ONE port):
//   - Settings ▸ Scorer laptop address: validated, stored, used for the list AND the link
//   - the match list is found on the relay's own port (it used to be forced to :5173)
//   - a relay that does not answer is named in the error, with every URL tried
//   - a laptop found by the network search is listed and linked with nothing typed
//   - a link goes to the laptop that listed the match (the list is open, the link needs the PIN)
//   - a desktop app (Tauri / Electron reply shapes: `running: true`, WS-only port) is found too
//   - the scorer ending the match puts the result up; undoing the end brings the score back;
//     deleting the match unlinks the board instead of freezing the last score
// Needs the `ws` devDependency (npm install).

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

// --- a relay like backend/server.js --local --------------------------------------------------
const SEED = 'match_1759750000000_ab12cd'
const relay = http.createServer((req, res) => {
  if (req.url === '/api/match/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ success: true, matches: [{ id: SEED, gameNumber: 4711, homeTeam: 'KSC', awayTeam: 'VBC', status: 'live' }] }))
  }
  if (req.url === '/api/server/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ status: 'online', mode: 'local', wsPort: relay.address().port }))
  }
  res.writeHead(404); res.end('not found')
})
const wss = new WebSocketServer({ server: relay })
const subs = new Set()
let lastLive = null
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected' }))
  ws.on('message', (buf) => {
    const msg = JSON.parse(String(buf))
    if (msg.type === 'subscribe-match' && msg.matchId === SEED) {
      subs.add(ws)
      ws.send(JSON.stringify({ type: 'match-full-data', matchId: SEED, access: 'summary', data: lastLive ? { liveState: lastLive } : {} }))
    }
  })
  ws.on('close', () => subs.delete(ws))
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const RELAY_PORT = relay.address().port
const toRoom = (o) => { for (const ws of subs) ws.send(JSON.stringify(o)) }
const live = (o = {}) => {
  lastLive = {
    team_a_name: 'KSC Wiedikon', team_a_short: 'KSC', team_a_color: '#2563eb',
    team_b_name: 'VBC Züri', team_b_short: 'VBC', team_b_color: '#ef4444',
    points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left',
    timeouts_a: [], timeouts_b: [], subs_a: null, subs_b: null, match_status: 'in_progress', ...o,
  }
  toRoom({ type: 'live-state-update', matchId: SEED, liveState: lastLive })
}

// A port with nothing on it, standing in for the desktop relay's :5173 — this machine may well run
// something real there.
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const closedPort = await freePort()
let deadPort = await freePort() // a saved address with nothing behind it
while (deadPort === closedPort) deadPort = await freePort()

// --- the appliance, with the network search replaced by a stand-in -------------------------
let searchFinds = []
let searches = 0
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-link-'))
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  relayDiscover: async () => { searches++; return { found: searchFinds, subnets: ['10.9.8'], ms: 1 } },
  relayDesktopPort: closedPort,
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxLayout: 'volleyball_matchscore_02',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 200, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const get = async (p) => (await fetch(base + p)).json()
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) } }
const t = (n) => mock.text(n)
await sleep(250)

try {
  console.log('\n[1] Settings ▸ Scorer laptop address')
  {
    const bad = await post('/api/settings', { relayAddress: 'scorer laptop!' })
    ok(bad.status === 400 && /host/i.test(bad.json?.error || ''), `a malformed address is refused with the reason (${bad.status} ${bad.json?.error})`)
    const good = await post('/api/settings', { relayAddress: `http://127.0.0.1:${RELAY_PORT}/` })
    ok(good.status === 200 && good.json.relayAddress === `127.0.0.1:${RELAY_PORT}`, `stored as host:port (${good.json?.relayAddress})`)
    ok((await get('/api/settings')).relayAddress === `127.0.0.1:${RELAY_PORT}`, 'read back by the console')
  }

  console.log('\n[2] the match list comes from the relay\'s OWN port')
  {
    const r = await get('/api/matches')
    ok(r.matches.length === 1 && r.matches[0].id === SEED, `listed under the seed key (${JSON.stringify(r.matches)})`)
    ok(r.relay?.ok === true && r.relay.source === 'settings' && r.relay.address === `127.0.0.1:${RELAY_PORT}`, `relay reported: ${JSON.stringify(r.relay)}`)
    ok(r.errors.length === 0, 'no errors')
    ok(searches === 0, 'no network search when the saved address answers')
  }

  console.log('\n[3] linked: the live score reaches the panel')
  {
    live({ points_a: 3, points_b: 1 })
    const l = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(l.status === 200 && l.json.mode === 'lan' && l.json.matchId === SEED, `link -> ${l.status} ${l.json?.mode}`)
    await sleep(300)
    ok(t('team1') === 'KSC' && t('score1') === '3' && t('score2') === '1', `3:1 from the stored live state (${t('score1')}:${t('score2')})`)
    live({ points_a: 5, points_b: 3 }); await sleep(200)
    ok(t('score1') === '5' && t('score2') === '3', `5:3 live (${t('score1')}:${t('score2')})`)
  }

  console.log('\n[4] the scorer ends the match -> the result screen')
  {
    live({ points_a: 25, points_b: 20, sets_won_a: 3, sets_won_b: 1, match_status: 'ended' }); await sleep(400)
    ok(mock.currentLayout === 'kscw_result', `result layout up (${mock.currentLayout})`)
    ok(/KSC WINS/.test(t('winner') || ''), `winner line: ${t('winner')}`)
    ok(/3 - 1/.test(t('sets') || ''), `sets line: ${t('sets')}`)
    const st = await get('/api/status')
    ok(st.mode === 'lan', 'still linked (an undo of the end must still reach the board)')
    live({ points_a: 25, points_b: 20, sets_won_a: 3, sets_won_b: 1, match_status: 'ended' }); await sleep(200)
    ok(mock.currentLayout === 'kscw_result', 'a repeat of the final frame does not paint the score over the result')
  }

  console.log('\n[5] the scorer undoes the end -> the live score is back')
  {
    live({ points_a: 24, points_b: 20, sets_won_a: 2, sets_won_b: 1, match_status: 'in_progress' }); await sleep(400)
    ok(mock.currentLayout === 'volleyball_matchscore_02', `match layout back (${mock.currentLayout})`)
    ok(t('score1') === '24' && t('score2') === '20', `24:20 painted (${t('score1')}:${t('score2')})`)
  }

  console.log('\n[6] ended, then deleted (the usual order): the result stays, the board unlinks')
  {
    live({ points_a: 25, points_b: 20, sets_won_a: 3, sets_won_b: 1, match_status: 'ended' }); await sleep(400)
    toRoom({ type: 'match-deleted', matchId: SEED }); await sleep(300)
    const st = await get('/api/status')
    ok(st.mode === 'idle' && st.matchId == null, `unlinked: mode ${st.mode}`)
    ok(mock.currentLayout === 'kscw_result', 'the result is still on the panel')
    live({ points_a: 1, points_b: 0 }); await sleep(200)
    ok(mock.currentLayout === 'kscw_result', 'nothing from the old room reaches the board any more')
  }

  console.log('\n[7] deleted mid-match: the board leaves the frozen score')
  {
    lastLive = null
    const l = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(l.status === 200 && mock.currentLayout === 'volleyball_matchscore_02', `re-linked; result cleared (${mock.currentLayout})`)
    await sleep(300)
    live({ points_a: 12, points_b: 9 }); await sleep(250)
    ok(t('score1') === '12', 'scoring 12:9')
    toRoom({ type: 'match-deleted', matchId: SEED }); await sleep(400)
    const st = await get('/api/status')
    ok(st.mode === 'idle', `unlinked: mode ${st.mode}`)
    ok(st.ledbox.idle === true && st.ledbox.clockHeld === true, `board on the held clock (idle ${st.ledbox.idle}, clock ${st.ledbox.clockHeld})`)
    ok(t('score1') !== '12', `the 12:9 is gone from the panel (score1 "${t('score1')}")`)
  }

  console.log('\n[8] a saved address that does not answer is NAMED, with every URL tried')
  {
    await post('/api/settings', { relayAddress: `127.0.0.1:${deadPort}` })
    const r = await get('/api/matches')
    const msg = r.errors[0] || ''
    ok(r.matches.length === 0 && r.relay.ok === false, 'no list')
    ok(msg.includes(`127.0.0.1:${deadPort}`), `the error names the address: ${msg}`)
    ok(r.relay.tried.length === 2 && r.relay.tried[0].includes(`127.0.0.1:${deadPort}/api/match/list`) && r.relay.tried[1].includes(`127.0.0.1:${closedPort}/api/match/list`),
      `its own port first, then the desktop port: ${JSON.stringify(r.relay.tried)}`)
    ok(searches === 1 && JSON.stringify(r.relay.searched) === '["10.9.8"]', 'and the network was searched')
    const l = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(l.status === 200, 'a link still goes to the saved address (the operator asked for it)')
  }

  console.log('\n[9] nothing typed: the network search finds the laptop, and the link uses it')
  {
    await post('/api/settings', { relayAddress: '' })
    ok((await get('/api/settings')).relayAddress === '', 'address cleared (automatic)')
    searchFinds = [{ host: '127.0.0.1', wsUrl: `ws://127.0.0.1:${RELAY_PORT}`, httpUrl: `http://127.0.0.1:${RELAY_PORT}` }]
    const r = await get('/api/matches')
    ok(r.matches.length === 1 && r.relay.ok && r.relay.source === 'discovered', `found: ${JSON.stringify(r.relay)}`)
    lastLive = null
    const l = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(l.status === 200 && l.json.mode === 'lan', 'linked to the laptop the search found')
    await sleep(300)
    live({ points_a: 7, points_b: 7 }); await sleep(250)
    ok(t('score1') === '7' && t('score2') === '7', `7:7 through the found relay (${t('score1')}:${t('score2')})`)
    const n = searches
    await get('/api/matches')
    ok(searches === n, 'a found laptop is asked first next time, without another search')
  }

  console.log('\n[9b] the link goes to the laptop that listed the match, not to whatever the open list found last')
  {
    const r = await get('/api/matches')
    ok(r.matches[0]?.relay === `127.0.0.1:${RELAY_PORT}`, `each match names the laptop that listed it (${r.matches[0]?.relay})`)
    const stale = await post('/api/link', { source: 'lan', matchId: SEED, relay: '10.6.6.6:8080' })
    ok(stale.status === 409 && /Refresh/.test(stale.json?.error || ''), `a relay the board does not know is refused (${stale.status} ${stale.json?.error})`)
    const l = await post('/api/link', { source: 'lan', matchId: SEED, relay: r.matches[0].relay })
    ok(l.status === 200 && l.json.relay?.address === `127.0.0.1:${RELAY_PORT}` && l.json.relay.source === 'discovered', `linked where the list came from: ${JSON.stringify(l.json?.relay)}`)

    // The saved laptop is silent and the search finds another one. GET /api/matches needs no PIN,
    // so it must not be able to move a link that does not name the found relay away from the
    // address the operator saved.
    await post('/api/settings', { relayAddress: `127.0.0.1:${deadPort}` })
    const r2 = await get('/api/matches')
    ok(r2.relay.ok && r2.relay.source === 'discovered' && r2.relay.configured?.address === `127.0.0.1:${deadPort}`, `listed from the found laptop, and says the saved one was silent: ${JSON.stringify(r2.relay)}`)
    const plain = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(plain.status === 200 && plain.json.relay?.address === `127.0.0.1:${deadPort}` && plain.json.relay.source === 'settings', `a link without "relay" stays on the saved address (${JSON.stringify(plain.json?.relay)})`)
    const chosen = await post('/api/link', { source: 'lan', matchId: SEED, relay: r2.matches[0].relay })
    ok(chosen.status === 200 && chosen.json.relay?.source === 'discovered', 'the found one only when the operator linked a match it listed')
    const logs = await get('/api/logs?q=not%20the%20saved&limit=20')
    ok((logs.entries || []).some((e) => e.level === 'warn' && /not the saved scorer laptop address/.test(e.msg || e.message || '')), 'and the log warns that the link left the saved address')
    await post('/api/settings', { relayAddress: '' })
  }

  console.log('\n[10] nothing typed and nothing found: a plain note, not a fault')
  {
    searchFinds = []
    relay.closeAllConnections?.()
    await post('/api/settings', { relayAddress: `127.0.0.1:${deadPort}` }) // forget the found one
    await post('/api/settings', { relayAddress: '' })
    const r = await get('/api/matches')
    ok(r.relay.ok === false && /no scorer laptop found on 10\.9\.8\.x/.test(r.errors[0] || ''), `error: ${r.errors[0]}`)
    const l = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(l.status === 409 && /Settings/.test(l.json?.error || ''), `link without any relay -> 409 (${l.json?.error})`)
  }
  console.log('\n[11] a desktop app (Tauri / Electron) — found, listed and linked through its real reply shapes')
  {
    // The Tauri relay (relay.rs) as it answers today: HTTP on one port (status `running: true`,
    // match list with the team NAMES and numeric ids, only the newest refereeable match), and a
    // WS-only port where /api/server/status and /api/match/list are a bare 404.
    const wsOnly = http.createServer((req, res) => { res.writeHead(404, { 'content-length': '0' }); res.end() })
    const desk = new WebSocketServer({ server: wsOnly })
    desk.on('connection', (ws) => ws.on('message', (buf) => {
      const msg = JSON.parse(String(buf))
      if (msg.type === 'subscribe-match') ws.send(JSON.stringify({ type: 'match-full-data', matchId: msg.matchId, access: 'summary', data: { liveState: { team_a_short: 'KSC', team_b_short: 'VBC', points_a: 2, points_b: 2, side_a: 'left', match_status: 'in_progress' } } }))
    }))
    await new Promise((r) => wsOnly.listen(0, '127.0.0.1', r))
    const wsPort = wsOnly.address().port
    const httpSide = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/server/status') return res.end(JSON.stringify({ running: true, mainInstanceId: null, hasMainInstance: false, protocol: 'http', wsProtocol: 'ws', hostname: 'localhost', localIP: '127.0.0.1', port: httpSide.address().port, wsPort, urls: {} }))
      if (req.url === '/api/match/list') return res.end(JSON.stringify({ success: true, matches: [{ id: 42, gameNumber: 4711, homeTeam: 'KSC Wiedikon', awayTeam: 'VBC Züri', scheduledAt: null, status: 'live', refereeConnectionEnabled: true }] }))
      res.writeHead(404); res.end('{}')
    })
    await new Promise((r) => httpSide.listen(0, '127.0.0.1', r))
    const { probeRelay } = await import('../src/relayAddress.js')
    const dDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-link-desk-'))
    const mock2 = new MockLedbox()
    const a2 = await mock2.listen(0, '127.0.0.1')
    const app2 = await startAppliance({
      stateDir: dDir, relayUrl: '', relayHttpUrl: '', matchId: '',
      relayDesktopPort: httpSide.address().port,
      relayDiscover: async () => {
        const f = await probeRelay('127.0.0.1', { relayPort: wsPort, desktopPort: httpSide.address().port })
        return { found: f ? [f] : [], subnets: ['127.0.0'], ms: 0 }
      },
      ledboxHost: '127.0.0.1', ledboxPort: a2.port, ledboxLayout: 'volleyball_matchscore_02',
      ledboxAlias: 'desk', ledboxApiVersion: 2, reconnectMs: 200, mock: false, controlPort: 0, debug: false,
    })
    const b2 = `http://127.0.0.1:${app2.server.address().port}`
    try {
      const r = await (await fetch(b2 + '/api/matches')).json()
      ok(r.relay.ok && r.relay.source === 'discovered' && r.relay.address === `127.0.0.1:${wsPort}`, `nothing typed: the desktop app is found (${JSON.stringify(r.relay)})`)
      ok(r.matches.length === 1 && r.matches[0].id === '42' && r.matches[0].label === '4711 KSC Wiedikon-VBC Züri' && r.matches[0].live, `its match is listed (${JSON.stringify(r.matches)})`)
      await fetch(b2 + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relayAddress: `127.0.0.1:${wsPort}` }) })
      const r2 = await (await fetch(b2 + '/api/matches')).json()
      ok(r2.relay.ok && r2.relay.source === 'settings' && r2.relay.tried.length === 1 && /answered HTTP 404/.test(r2.relay.tried[0]), `typed address: the WS port's 404, then the HTTP port (${JSON.stringify(r2.relay.tried)})`)
      const l = await fetch(b2 + '/api/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'lan', matchId: r2.matches[0].id, relay: r2.matches[0].relay }) })
      ok(l.status === 200, `linked (${l.status})`)
      await sleep(400)
      ok(mock2.text('score1') === '2' && mock2.text('team1') === 'KSC', `the desktop relay's live state is on the panel (${mock2.text('team1')} ${mock2.text('score1')}:${mock2.text('score2')})`)
    } finally {
      await app2.close()
      await mock2.close()
      for (const ws of desk.clients) ws.terminate()
      desk.close()
      wsOnly.closeAllConnections?.(); httpSide.closeAllConnections?.()
      await new Promise((r) => wsOnly.close(r)); await new Promise((r) => httpSide.close(r))
      fs.rmSync(dDir, { recursive: true, force: true })
    }
  }
} finally {
  await app.close()
  for (const ws of wss.clients) ws.terminate()
  wss.close()
  relay.closeAllConnections?.()
  await new Promise((r) => relay.close(r))
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
