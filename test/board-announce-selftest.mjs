// The board announces itself to the OpenVolley relay it follows (src/boardAnnounce.js,
// docs/board-settings-from-openvolley.md): subscribe-match carries device 'display' and the console's
// Settings page, so the scorer's OpenVolley menu offers "Scoreboard settings".
//
//   1. the announcement: the console's AP address by default, BOARD_SETTINGS_URL, "off"
//   2. RelaySubscriber against a mock relay: nothing extra until the appliance sets an announcement,
//      then on every (re)subscribe; an explicit `announce` wins
//   3. with OPENVOLLEY_DIR (an OpenVolley checkout that has display-presence, installed): the REAL
//      relay (frontend/server.js) — a scorer syncs, the board's subscriber follows, and the scorer is
//      told the board's page, and that it left. Skipped without OPENVOLLEY_DIR.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { RelaySubscriber } from '../src/relaySubscriber.js'
import { boardSettingsUrl, boardAnnouncementFromEnv, setBoardAnnouncement, announcementFields, DISPLAY_DEVICE } from '../src/boardAnnounce.js'

let failures = 0
const assert = (cond, label) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (!cond) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await wait(25) }
  return false
}

console.log('board announcement')
assert(boardSettingsUrl() === 'http://172.24.1.1:8890/#settings', 'the console\'s Settings on the board\'s Wi-Fi')
assert(boardSettingsUrl({ port: 9000 }) === 'http://172.24.1.1:9000/#settings', 'on the console\'s port')
assert(boardAnnouncementFromEnv({}, { controlPort: 8890 }).settingsUrl === 'http://172.24.1.1:8890/#settings', 'default from the control port')
assert(boardAnnouncementFromEnv({ BOARD_SETTINGS_URL: 'http://192.168.5.1:8890/#settings' }).settingsUrl === 'http://192.168.5.1:8890/#settings', 'BOARD_SETTINGS_URL overrides it')
assert(boardAnnouncementFromEnv({ BOARD_SETTINGS_URL: 'off' }).settingsUrl === null, '"off": a display with no page')
assert(JSON.stringify(announcementFields(null)) === '{}', 'no announcement: no fields')
assert(JSON.stringify(announcementFields({ settingsUrl: null })) === JSON.stringify({ device: DISPLAY_DEVICE }), 'no page: the device label only')

// --- 2. a mock relay ----------------------------------------------------------------------------
console.log('RelaySubscriber → mock relay')
const seen = []
const wss = new WebSocketServer({ port: 0 })
await new Promise((r) => wss.on('listening', r))
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected' }))
  ws.on('message', (buf) => { const m = JSON.parse(buf.toString()); if (m.type === 'subscribe-match') seen.push(m) })
})
const url = `ws://127.0.0.1:${wss.address().port}`
const follow = async (opts) => {
  const before = seen.length
  const sub = new RelaySubscriber({ url, matchId: 'seed-1', reconnectMs: 0, ...opts })
  sub.on('error', () => {})
  sub.start()
  await until(() => seen.length > before)
  sub.stop()
  return seen[seen.length - 1]
}
let m = await follow()
assert(m && m.matchId === 'seed-1' && !('device' in m) && !('settingsUrl' in m), 'not configured: the plain subscription, as before')
setBoardAnnouncement(boardAnnouncementFromEnv({}, { controlPort: 8890 }))
m = await follow()
assert(m && m.device === 'display' && m.settingsUrl === 'http://172.24.1.1:8890/#settings', 'configured: device display + the Settings page')
m = await follow({ announce: null })
assert(m && !('device' in m), 'announce: null subscribes plainly')
m = await follow({ announce: { settingsUrl: 'http://192.168.5.1:8890/#settings' } })
assert(m && m.settingsUrl === 'http://192.168.5.1:8890/#settings', 'an explicit announce wins')
// every resubscribe (the relay replays its copy; a reconnect subscribes again) carries it too
const sub = new RelaySubscriber({ url, matchId: 'seed-2', reconnectMs: 100 })
sub.on('error', () => {})
sub.start()
await until(() => seen.some((x) => x.matchId === 'seed-2'))
for (const c of wss.clients) c.terminate()
await until(() => seen.filter((x) => x.matchId === 'seed-2').length >= 2)
sub.stop()
const again = seen.filter((x) => x.matchId === 'seed-2')
assert(again.length >= 2 && again.every((x) => x.device === 'display' && x.settingsUrl), 'a reconnect announces again')
await new Promise((r) => wss.close(r))

// --- 3. the real OpenVolley relay ---------------------------------------------------------------
const OV = process.env.OPENVOLLEY_DIR ? path.resolve(process.env.OPENVOLLEY_DIR) : ''
if (!OV) {
  console.log('  –  real OpenVolley relay: skipped (set OPENVOLLEY_DIR to an OpenVolley escoresheet/ with display-presence)')
} else {
  console.log(`real OpenVolley relay (${path.join(OV, 'frontend', 'server.js')})`)
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
  const httpPort = await freePort(), wsPort = await freePort()
  const env = { ...process.env, PORT: String(httpPort), WS_PORT: String(wsPort), HTTPS: 'false', HOSTNAME: '127.0.0.1' }
  delete env.NODE_ENV; delete env.USE_HTTPS
  const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(OV, 'frontend'), env, stdio: 'ignore' })
  try {
    let up = false
    for (let i = 0; i < 150 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${httpPort}/api/server/status`)).ok } catch { await wait(100) }
    }
    assert(up, 'the relay is up')
    const scorer = new WebSocket(`ws://127.0.0.1:${wsPort}`)
    const told = []
    scorer.on('message', (b) => { const x = JSON.parse(b.toString()); if (x.type === 'display-presence') told.push(x) })
    await new Promise((r) => scorer.once('open', r))
    const seed = `board-announce-${Date.now().toString(36)}`
    scorer.send(JSON.stringify({
      type: 'sync-match-data', matchId: 1,
      match: { id: 1, seed_key: seed, status: 'live', gameNumber: 4711, gamePin: '246810', refereeConnectionEnabled: false },
      homeTeam: { id: 1, name: 'Home VC' }, awayTeam: { id: 2, name: 'Away VC' }, homePlayers: [], awayPlayers: [],
      sets: [{ id: 1, index: 1, homePoints: 0, awayPoints: 0 }], events: [], _timestamp: Date.now(),
    }))
    assert(await until(() => told.length >= 1), 'the scorer is answered on its first sync')
    assert(told[0] && told[0].present === false, '…no display yet')
    const board = new RelaySubscriber({ url: `ws://127.0.0.1:${wsPort}`, matchId: seed, reconnectMs: 0 })
    board.on('error', () => {})
    board.start()
    assert(await until(() => told.length >= 2), 'the board subscribes: the scorer is told')
    assert(told[1] && told[1].present === true && told[1].settingsUrl === 'http://172.24.1.1:8890/#settings', `…with the board's Settings page (${told[1] && told[1].settingsUrl})`)
    board.stop()
    assert(await until(() => told.length >= 3), 'the board gone: told again')
    assert(told[2] && told[2].present === false && told[2].settingsUrl === null, '…no display')
    scorer.close()
  } finally {
    proc.kill('SIGTERM')
  }
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nboard announce: all ok')
process.exit(0)
