// Following an OpenVolley match by its scoreboard code (src/followCode.js, docs/openvolley-link-DESIGN.md
// "Follow by scoreboard code"):
//
//   [1] the code: normalised as the relays compare it, formatted ABCD-2345, found in a pasted board link
//       (…/board#CODE, ?code=), its log ref = 8 hex of sha256("d:" + code) as OpenVolley logs it
//   [2] FollowCodeStore: 0600, round trip, garbage refused, cleared
//   [3] RelaySubscriber by code against a fake relay: the subscription (code, device display, the
//       settings announcement, no matchId, no PIN); ok → the room; ended → stops, no reconnect;
//       not-found → final for a code never seen, waited out (15/30/60 s, here ms) for one followed before,
//       given up after a while; rate-limited → nothing sent before retryAfter, not even on a reconnect;
//       an older relay ("Match ID required") → unsupported
//   [4] the appliance: POST /api/link { source: 'code' } behind the scorer PIN, a wrong / ended /
//       rate-limited code answered before the panel is touched, a pasted board link, the score on the
//       panel, the code on disk (0600) for a reconnect, the code ending → unlinked, back to the clock
//   [5] a bridge restart follows the saved code again; Stop following forgets it
//   [6] the code never reached the log
//   [7] the console's card: the field's formatting, the POST, the status line in every state, German
//   and through all of it: the code never reaches the log.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { normalizeCode, formatCode, extractCode, codeRef, FollowCodeStore } from '../src/followCode.js'
import { RelaySubscriber } from '../src/relaySubscriber.js'
import { setBoardAnnouncement } from '../src/boardAnnounce.js'
import { log as logStore } from '../src/logStore.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : `, want ${JSON.stringify(want)}`})`)
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(20) } return !!(await fn()) }

const CODE = 'ABCD2345'
const OTHER = 'WXYZ6789'
// Every log entry from here on, to prove no code ever reaches it (in any spelling).
const logged = []
logStore.on('entry', (e) => logged.push(JSON.stringify(e)))
const leaks = () => logged.filter((l) => [CODE, OTHER].some((c) => l.toUpperCase().includes(c) || l.toUpperCase().includes(`${c.slice(0, 4)}-${c.slice(4)}`)))

console.log('[1] the code')
{
  eq(normalizeCode('abcd-2345'), CODE, 'lower case and a dash')
  eq(normalizeCode(' AB CD 23 45 '), CODE, 'spaces')
  eq([normalizeCode('ABCD234'), normalizeCode('ABCD23456'), normalizeCode('ABCD2340'), normalizeCode('OBCD2345'), normalizeCode('IBCD2345'), normalizeCode('1BCD2345'), normalizeCode(12345678)], [null, null, null, null, null, null, null], 'not 8 symbols, or 0 / O / 1 / I, or not a string: none')
  eq(formatCode('abcd2345'), 'ABCD-2345', 'shown as the scorer sees it')
  eq(extractCode('https://livescore.openvolley.app/board#ABCD2345'), CODE, 'the board page of the scorer\'s QR code')
  eq(extractCode('http://192.168.1.20:5173/livescore/board#abcd-2345'), CODE, 'a hall relay\'s board page, lower case')
  eq(extractCode('livescore.openvolley.app/board#ABCD-2345'), CODE, 'pasted without the scheme')
  eq(extractCode('https://livescore.openvolley.app/board?code=ABCD2345'), CODE, '?code=')
  eq(extractCode('Code: ABCD-2345'), CODE, 'a code in a sentence')
  eq(extractCode('ABCD-2345 or WXYZ-6789'), null, 'two codes: none guessed')
  eq(extractCode('https://livescore.openvolley.app/board#4711'), null, 'a game number is not a code')
  eq(extractCode(''), null, 'empty')
  eq(codeRef('abcd-2345'), crypto.createHash('sha256').update('d:ABCD2345').digest('hex').slice(0, 8), 'the log ref: 8 hex of sha256("d:" + code), as OpenVolley\'s relays log it')
  ok(!codeRef(CODE).toUpperCase().includes(CODE), '...which is not the code')
}

console.log('\n[2] FollowCodeStore')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-store-'))
  const file = path.join(dir, 'follow-code.json')
  const st = new FollowCodeStore({ file })
  eq(st.get(), null, 'nothing saved: null')
  ok(st.save({ code: 'abcd-2345', relay: 'cloud', wsUrl: 'wss://backend.openvolley.app', endsAt: 123 }), 'saved')
  eq((fs.statSync(file).mode & 0o777).toString(8), '600', 'mode 0600')
  const g = st.get()
  ok(g.code === CODE && g.relay === 'cloud' && g.endsAt === 123 && g.confirmed === false, `read back normalised (${g.relay} ${g.endsAt})`)
  ok(st.update({ confirmed: true }) && st.get().confirmed === true, 'update')
  fs.writeFileSync(file, JSON.stringify({ code: 'nope', relay: 'cloud', wsUrl: 'wss://x' }))
  eq(st.get(), null, 'not a code: ignored')
  fs.writeFileSync(file, JSON.stringify({ code: CODE, relay: 'elsewhere', wsUrl: 'wss://x' }))
  eq(st.get(), null, 'an unknown relay: ignored')
  fs.writeFileSync(file, JSON.stringify({ code: CODE, relay: 'laptop', wsUrl: 'file:///etc/passwd' }))
  eq(st.get(), null, 'not a ws URL: ignored')
  st.clear()
  ok(!fs.existsSync(file), 'cleared')
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- a fake relay that knows scoreboard codes: HTTP and WebSocket on one port (like the cloud) --------
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function fakeRelay(host = '127.0.0.1') {
  const r = {
    codes: new Map(), ended: new Set(), rate: null, legacy: false, connections: 0, lookups: 0,
    subs: [], followers: new Map(), sockets: new Set(), endsAt: Date.now() + 12 * 3600 * 1000,
  }
  const norm = (v) => { const s = String(v || '').toUpperCase().replace(/[\s-]/g, ''); return s.length === 8 && [...s].every((c) => ALPHA.includes(c)) ? s : null }
  r.server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method !== 'POST' || req.url !== '/api/display/lookup') { res.statusCode = 404; return res.end('{}') }
      r.lookups++
      let code = null
      try { code = norm(JSON.parse(body).code) } catch { code = null }
      if (r.rate) { res.statusCode = 429; res.setHeader('retry-after', String(r.rate)); return res.end(JSON.stringify({ ok: false, code: 'OV_DISPLAY_RATE_LIMITED' })) }
      if (code && r.ended.has(code)) { res.statusCode = 410; return res.end(JSON.stringify({ ok: false, code: 'OV_DISPLAY_ENDED' })) }
      if (code && r.codes.has(code)) return res.end(JSON.stringify({ ok: true, matchId: r.codes.get(code), endsAt: r.endsAt }))
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, code: 'OV_DISPLAY_NOT_FOUND' }))
    })
  })
  r.wss = new WebSocketServer({ server: r.server })
  r.wss.on('connection', (ws) => {
    r.connections++
    r.sockets.add(ws)
    ws.on('close', () => { r.sockets.delete(ws); for (const s of r.followers.values()) s.delete(ws) })
    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(String(raw)) } catch { return }
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }))
      if (m.type !== 'subscribe-match') return
      r.subs.push(m)
      if (m.matchId == null && r.legacy) return ws.send(JSON.stringify({ type: 'error', message: 'Match ID required' }))
      if (m.code == null) return
      const code = norm(m.code)
      if (r.rate) return ws.send(JSON.stringify({ type: 'display-code', ok: false, reason: 'rate-limited', retryAfter: r.rate }))
      if (code && r.ended.has(code)) return ws.send(JSON.stringify({ type: 'display-code', ok: false, reason: 'ended' }))
      if (!code || !r.codes.has(code)) return ws.send(JSON.stringify({ type: 'display-code', ok: false, reason: 'not-found' }))
      const room = r.codes.get(code)
      ws.send(JSON.stringify({ type: 'display-code', ok: true, matchId: room, endsAt: r.endsAt }))
      if (!r.followers.has(code)) r.followers.set(code, new Set())
      r.followers.get(code).add(ws)
      const live = r.live && r.live[room]
      ws.send(JSON.stringify({
        type: 'match-full-data', matchId: room, access: 'summary',
        match: { status: 'live', gameNumber: 4711 }, homeTeam: { name: 'KSC Wiedikon', shortName: 'KSC' }, awayTeam: { name: 'VBC Züri', shortName: 'VBC' },
        sets: [], ...(live ? { liveState: live, data: { liveState: live } } : {}),
      }))
    })
  })
  r.live = {}
  r.push = (room, liveState) => {
    r.live[room] = liveState
    for (const [code, set] of r.followers) if (r.codes.get(code) === room) for (const ws of set) ws.send(JSON.stringify({ type: 'live-state-update', matchId: room, liveState }))
  }
  // The scorer makes a new code / stops sharing: the old one ends for its boards.
  r.end = (code) => {
    const room = r.codes.get(code)
    r.codes.delete(code)
    r.ended.add(code)
    for (const ws of r.followers.get(code) || []) ws.send(JSON.stringify({ type: 'display-code', ok: false, reason: 'ended', matchId: room }))
    r.followers.delete(code)
  }
  r.dropAll = () => { for (const ws of r.sockets) ws.terminate() }
  r.listen = () => new Promise((res) => r.server.listen(0, host, () => { r.port = r.server.address().port; r.ws = `ws://${host}:${r.port}`; res(r) }))
  r.close = () => new Promise((res) => { for (const ws of r.sockets) ws.terminate(); r.wss.close(); r.server.close(() => res()) })
  r.bySub = () => r.subs.filter((m) => m.code != null)
  return r
}
const subOf = (relay, extra = {}) => {
  const sub = new RelaySubscriber({ url: relay.ws, reconnectMs: 50, ...extra })
  const seen = { codes: [], states: [] }
  sub.on('code', (i) => seen.codes.push(i))
  sub.on('state', (s) => seen.states.push(s))
  sub.on('error', () => {})
  return { sub, seen }
}

console.log('\n[3] RelaySubscriber by code')
{
  const relay = await fakeRelay().listen()
  relay.codes.set(CODE, 'room_a')
  relay.live.room_a = { points_a: 3, points_b: 1 }

  // the subscription, and what comes back
  setBoardAnnouncement({ settingsUrl: 'http://172.24.1.1:8890/#settings' })
  let { sub, seen } = subOf(relay, { code: 'abcd-2345', pin: '123456' })
  sub.start()
  ok(await until(() => seen.codes.length >= 1), 'the relay answered the code')
  setBoardAnnouncement(null)
  eq(relay.subs[0], { type: 'subscribe-match', code: CODE, device: 'display', settingsUrl: 'http://172.24.1.1:8890/#settings' }, 'subscribe-match { code, device: display, settingsUrl } — no matchId, no PIN')
  ok(seen.codes[0].ok === true && seen.codes[0].matchId === 'room_a' && sub.matchId === 'room_a' && sub.codeState === 'following', `ok: the room is now the matchId (${sub.matchId}, ${sub.codeState})`)
  ok(await until(() => seen.states.length >= 1) && seen.states[0].points_a === 3, 'the summary\'s live state passes')
  relay.push('room_a', { points_a: 4, points_b: 1 })
  ok(await until(() => seen.states.length >= 2) && seen.states[1].points_a === 4, 'and every live-state-update')
  eq(sub.pinState, 'none', 'a PIN next to a code is never offered')
  // A reconnect sends the code again.
  const before = relay.bySub().length
  relay.dropAll()
  ok(await until(() => relay.bySub().length > before), 'after a dropped socket: the code again on the new one')
  ok(sub.codeState === 'following', 'still following')

  // ended: stops, does not come back
  relay.end(CODE)
  ok(await until(() => seen.codes.some((c) => c.final)), 'the code ends: a final answer')
  const fin = seen.codes.find((c) => c.final)
  ok(fin.reason === 'ended' && sub.codeState === 'ended', `reason ended (${fin.reason})`)
  const conns = relay.connections
  await sleep(300)
  eq(relay.connections, conns, 'no reconnect after the code ended')
  sub.stop()

  // not-found, never seen: final at once, one lookup
  relay.subs.length = 0;
  ({ sub, seen } = subOf(relay, { code: OTHER }))
  sub.start()
  ok(await until(() => seen.codes.some((c) => c.final)), 'a code the relay never knew: final')
  ok(seen.codes[0].reason === 'not-found' && sub.codeState === 'not-found', 'reason not-found')
  await sleep(300)
  eq(relay.bySub().length, 1, 'asked once, no storm')
  sub.stop()

  // not-found for a code followed before (restored after a restart): waited out, then found again
  relay.subs.length = 0;
  ({ sub, seen } = subOf(relay, { code: OTHER, codeConfirmed: true, codeRetryMs: [400, 800, 1600] }))
  sub.start()
  ok(await until(() => seen.codes.length >= 1), 'asked')
  ok(seen.codes[0].ok === false && seen.codes[0].final === false && sub.codeState === 'lost' && sub.codeRetryAt > Date.now(), `not found: not final, lost, a retry time (${sub.codeState})`)
  await sleep(60)
  eq(relay.bySub().length, 1, 'nothing sent before the wait is over')
  ok(await until(() => relay.bySub().length >= 2, 2000), 'asked again after the wait, on the same socket')
  eq(relay.connections > 0 && relay.bySub().length, 2, 'once')
  relay.codes.set(OTHER, 'room_b')
  ok(await until(() => sub.codeState === 'following', 2000), 'the scorer is back: following again')
  sub.stop()
  relay.codes.delete(OTHER)

  // ...and given up after a while
  ;({ sub, seen } = subOf(relay, { code: OTHER, codeConfirmed: true, codeRetryMs: [40], codeGiveUpMs: 150 }))
  sub.start()
  ok(await until(() => seen.codes.some((c) => c.final), 2000), 'not found for longer than the give-up time: final')
  ok(sub.codeState === 'not-found', 'not-found')
  sub.stop()

  // rate-limited: nothing before retryAfter, not even after a reconnect
  relay.rate = 7
  relay.subs.length = 0;
  ({ sub, seen } = subOf(relay, { code: CODE }))
  sub.start()
  ok(await until(() => seen.codes.length >= 1), 'asked')
  const rl = seen.codes[0]
  ok(rl.reason === 'rate-limited' && rl.retryAfter === 7 && rl.final === false && sub.codeState === 'rate-limited', `rate-limited, wait 7 s, not final (${JSON.stringify(rl)})`)
  ok(Math.abs(sub.codeRetryAt - Date.now() - 7000) < 1000, 'retry time 7 s on')
  relay.dropAll()
  ok(await until(() => relay.connections >= 2), 'the socket dropped and came back')
  await sleep(300)
  eq(relay.bySub().length, 1, 'no lookup on the new socket before the wait is over')
  sub.stop()
  relay.rate = null

  // an older relay
  relay.legacy = true
  ;({ sub, seen } = subOf(relay, { code: CODE }))
  sub.start()
  ok(await until(() => seen.codes.some((c) => c.final)), 'an older relay: final')
  eq(seen.codes[0].reason, 'unsupported', 'unsupported')
  sub.stop()
  await relay.close()
}

// --- the appliance ---------------------------------------------------------------------------------
async function boot(stateDir, extra = {}) {
  const mock = new MockLedbox()
  const lb = await mock.listen(0, '127.0.0.1')
  const app = await startAppliance({
    mock: false, ledboxHost: '127.0.0.1', ledboxPort: lb.port, ledboxLayout: 'volleyball_matchscore_02', ledboxAlias: 'fc', ledboxApiVersion: 2,
    controlPort: 0, stateDir, reconnectMs: 100, relayUrl: 'ws://127.0.0.1:9', relayDiscovery: false,
    uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9', debug: false, ...extra,
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  for (let i = 0; i < 100 && !app.ledbox.ready; i++) await sleep(20)
  const close = async () => { await app.close(); await mock.close() }
  return { app, base, mock, close }
}
const J = (base, p) => fetch(base + p).then((r) => r.json())
const post = async (base, p, body = {}, pin = '') => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(pin ? { 'x-scorer-pin': pin } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const live = (o = {}) => ({
  current_set: 1, team_a_name: 'KSC Wiedikon', team_a_short: 'KSC', team_a_color: '#2563eb', team_b_name: 'VBC Züri', team_b_short: 'VBC', team_b_color: '#ef4444',
  best_of: 5, sets_won_a: 0, sets_won_b: 0, points_a: 0, points_b: 0, side_a: 'left', serving_team: 'left', timeouts_a: 0, timeouts_b: 0,
  subs_count_a: 0, subs_count_b: 0, match_status: 'live', last_event_type: 'point', timeout_active: false, set_interval_active: false, ...o,
})
const PIN = '2468'

console.log('\n[4] the appliance: POST /api/link { source: \'code\' }')
const cloud = await fakeRelay('127.0.0.2').listen()
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-state-'))
const codeFile = path.join(stateDir, 'data', 'follow-code.json')
let b = await boot(stateDir, { cloudRelay: cloud.ws })
{
  const { base, mock } = b
  await post(base, '/api/settings', { scorerPin: PIN, orientation: 'front' })
  const st0 = await J(base, '/api/status')
  ok(st0.followCode && st0.followCode.linked === false && st0.followCode.state === null, `/api/status.followCode, not following (${JSON.stringify(st0.followCode)})`)
  eq(st0.followCode.relays, ['cloud', 'laptop'], 'the cloud and a laptop; not the board\'s own OpenVolley (this board has none)')

  cloud.codes.set(CODE, 'room_c')
  cloud.push('room_c', live({ points_a: 7, points_b: 5 }))
  eq((await post(base, '/api/link', { source: 'code', code: CODE })).status, 403, 'without the scorer PIN: 403')
  eq(cloud.lookups, 0, '...and the relay was not asked')
  let r = await post(base, '/api/link', { source: 'code', code: 'ABCD-234' }, PIN)
  ok(r.status === 400 && r.json.reason === 'bad-code', `not a code: 400 (${r.json.error})`)
  r = await post(base, '/api/link', { source: 'code', code: CODE, relay: 'board' }, PIN)
  eq(r.status, 409, 'the board\'s own OpenVolley on a board without one: 409')
  r = await post(base, '/api/link', { source: 'code', code: CODE, relay: 'mars' }, PIN)
  eq(r.status, 400, 'an unknown relay: 400')

  r = await post(base, '/api/link', { source: 'code', code: OTHER }, PIN)
  ok(r.status === 404 && r.json.reason === 'not-found' && r.json.mode !== 'lan', `a wrong code: 404, not linked (${r.json.mode})`)
  eq(cloud.bySub().length, 0, '...answered by the HTTP lookup: no subscription made')
  eq((await J(base, '/api/status')).followCode.state, 'not-found', 'the status line says not found')
  cloud.ended.add(OTHER)
  r = await post(base, '/api/link', { source: 'code', code: OTHER }, PIN)
  ok(r.status === 410 && r.json.reason === 'ended', 'an ended code: 410')
  cloud.ended.delete(OTHER)
  cloud.rate = 120
  r = await post(base, '/api/link', { source: 'code', code: CODE }, PIN)
  ok(r.status === 429 && r.json.retryAfter === 120 && r.json.followCode.state === 'rate-limited' && r.json.followCode.retryAt > Date.now() + 100000, `rate-limited: 429, retry after 120 s (${JSON.stringify(r.json.followCode)})`)
  cloud.rate = null

  // A pasted board link from the scorer's QR code; the cloud is the default relay.
  r = await post(base, '/api/link', { source: 'code', code: 'https://livescore.openvolley.app/board#abcd-2345' }, PIN)
  ok(r.status === 200 && r.json.mode === 'lan' && r.json.linkSource === 'code' && r.json.relay.source === 'cloud', `linked from the board link, on the cloud (${r.status} ${r.json.mode} ${r.json.linkSource})`)
  eq(r.json.matchId, 'room_c', 'the room from the lookup')
  ok(await until(async () => (await J(base, '/api/status')).followCode.state === 'following'), 'following')
  const fc = (await J(base, '/api/status')).followCode
  ok(fc.linked === true && fc.relay === 'cloud' && fc.endsAt === cloud.endsAt && fc.ref === codeRef(CODE), `status: linked, cloud, until the code ends, its ref (${JSON.stringify(fc)})`)
  ok(!JSON.stringify(await J(base, '/api/status')).toUpperCase().includes(CODE), '/api/status never carries the code')
  ok(await until(() => mock.text('score1') === '7' && mock.text('score2') === '5'), `the score on the panel (${mock.text('team1')} ${mock.text('score1')}:${mock.text('score2')} ${mock.text('team2')})`)
  cloud.push('room_c', live({ points_a: 8, points_b: 5, subs_count_a: 2 }))
  ok(await until(() => mock.text('score1') === '8'), '8:5 live')
  ok(await until(() => mock.text('sub1') === '2'), `the substitutions from subs_count_a (${mock.text('sub1')})`)
  // On disk for a reconnect or a restart
  ok(fs.existsSync(codeFile) && (fs.statSync(codeFile).mode & 0o777) === 0o600, 'the code saved, 0600')
  const saved = JSON.parse(fs.readFileSync(codeFile, 'utf8'))
  ok(saved.code === CODE && saved.relay === 'cloud' && saved.confirmed === true && saved.endsAt === cloud.endsAt, `saved: relay, confirmed, endsAt (${saved.relay} ${saved.confirmed})`)
  eq((await post(base, '/api/link/pin', { pin: '123456' }, PIN)).status, 409, 'no match PIN on a code link')
  // a dropped socket: the board subscribes with the code again and goes on
  const n = cloud.bySub().length
  cloud.dropAll()
  ok(await until(() => cloud.bySub().length > n), 'after a dropped socket: subscribed by the code again')
  cloud.push('room_c', live({ points_a: 9, points_b: 5 }))
  ok(await until(() => mock.text('score1') === '9'), '9:5 after the reconnect')

  // the scorer makes a new code: the old one ends, the board unlinks to the clock
  cloud.end(CODE)
  ok(await until(async () => (await J(base, '/api/status')).mode === 'idle'), 'the code ended: unlinked')
  const st = await J(base, '/api/status')
  ok(st.followCode.linked === false && st.followCode.state === 'ended', `the status line says ended (${JSON.stringify(st.followCode)})`)
  ok(st.ledbox.idle === true && mock.text('score1') !== '9', 'the 9:5 is off the panel')
  ok(!fs.existsSync(codeFile), 'the saved code is gone')
}

console.log('\n[5] a bridge restart, and Stop following')
{
  cloud.codes.set(OTHER, 'room_d')
  cloud.push('room_d', live({ points_a: 12, points_b: 10 }))
  let r = await post(b.base, '/api/link', { source: 'code', code: 'WXYZ 6789' }, PIN)
  ok(r.status === 200 && r.json.matchId === 'room_d', 'linked by another code')
  ok(await until(() => b.mock.text('score1') === '12'), '12:10 on the panel')
  await b.close()
  ok(fs.existsSync(codeFile), 'a clean shutdown keeps the saved code')
  const subsBefore = cloud.bySub().length
  b = await boot(stateDir, { cloudRelay: cloud.ws })
  ok(await until(async () => (await J(b.base, '/api/status')).followCode.state === 'following', 4000), 'after the restart: following the saved code again, by itself')
  ok(cloud.bySub().length > subsBefore && cloud.bySub().at(-1).code === OTHER, 'it subscribed with the saved code')
  const st = await J(b.base, '/api/status')
  ok(st.mode === 'lan' && st.matchId === 'room_d' && st.linkSource === 'code', `mode lan, the room, linkSource code (${st.mode} ${st.matchId})`)
  ok(await until(() => b.mock.text('score1') === '12'), 'the score back on the panel')
  // the relay restarted too and has not got the code back yet: the board waits, it does not give up
  // (codeConfirmed), and does not storm the relay. Not waited out here (15 s); [3] covers the waits.
  cloud.codes.delete(OTHER)
  cloud.dropAll()
  ok(await until(async () => (await J(b.base, '/api/status')).followCode.state === 'lost'), 'the relay lost the code: lost, still linked')
  eq((await J(b.base, '/api/status')).mode, 'lan', '...still linked')
  cloud.codes.set(OTHER, 'room_d')
  // Stop following and score here: the saved code is forgotten
  r = await post(b.base, '/api/manual', { takeOver: true }, PIN)
  ok(r.status === 200 && r.json.mode === 'manual', 'Stop following: manual')
  ok(!fs.existsSync(codeFile), 'the saved code is gone')
  await b.close()
  b = await boot(stateDir, { cloudRelay: cloud.ws })
  await sleep(500)
  ok((await J(b.base, '/api/status')).mode !== 'lan', 'the next restart follows nothing')
  await b.close()
}

console.log('\n[6] the code never reached the log')
{
  ok(logged.length > 50, `${logged.length} log entries seen`)
  ok(logged.some((l) => l.includes(`ref=${codeRef(CODE)}`)), 'the ref is logged instead')
  const bad = leaks()
  ok(bad.length === 0, `no code in any of them${bad.length ? `: ${bad[0].slice(0, 200)}` : ''}`)
  const files = []
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p) } }
  walk(stateDir)
  const inFiles = files.filter((f) => /\.jsonl?$|\.log$/.test(f) && fs.readFileSync(f, 'utf8').toUpperCase().includes(CODE))
  ok(inFiles.length === 0, `nor in the board's files (${files.length} looked at${inFiles.length ? `: ${inFiles.join(', ')}` : ''})`)
}

console.log('\n[7] the console\'s Link tab card (web/index.html, lifted out and run against a tiny DOM)')
{
  const index = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
  const a = js.indexOf('// --- follow by scoreboard code'), z = js.indexOf('// --- diagnostics', a)
  const block = a >= 0 && z > a ? js.slice(a, z) : ''
  ok(!!block, 'the console has a "follow by scoreboard code" script block')
  ok(/<div id="codeCard" class="codecard">/.test(index) && /<form id="codeForm"/.test(index) && /id="codeInput"[^>]*autocapitalize="characters"/.test(index), 'the card, its form, and a field that capitalises')
  ok(/name="codeRelay" value="cloud" checked/.test(index), 'the cloud is the relay chosen by default')
  ok(/renderFollowCode\(st\);/.test(js), 'every status poll renders it')
  ok(index.indexOf('id="codeCard"') > index.indexOf('id="tab-link"') && index.indexOf('id="codeCard"') < index.indexOf('id="tab-settings"'), 'on the Link tab')
  const el = (id, extra = {}) => ({ id, hidden: false, disabled: false, value: '', textContent: '', dataset: {}, listeners: {}, addEventListener(t, f) { this.listeners[t] = f }, focus() {}, ...extra })
  const nodes = {}
  const radios = ['cloud', 'board', 'laptop'].map((v) => el(`r-${v}`, { value: v, checked: v === 'cloud' }))
  const labels = ['cloud', 'board', 'laptop'].map((v) => el(`l-${v}`, { dataset: { relay: v } }))
  const $ = (sel) => {
    if (sel === 'input[name=codeRelay]:checked') return radios.find((r) => r.checked) || null
    const m = sel.match(/value=(\w+)\]$/)
    if (m) return radios.find((r) => r.value === m[1]) || null
    return (nodes[sel] ||= el(sel))
  }
  const $$ = () => labels
  const io = { posts: [], toasts: [], refreshed: 0, reply: null }
  const postJSON = async (p, body) => { io.posts.push({ p, body }); if (io.reply instanceof Error) throw io.reply; return io.reply || {} }
  const f = new Function('$', '$$', 'toast', 'postJSON', 'refreshStatus', block + '\nreturn { formatCodeField, linkByCode, renderFollowCode, codeFromLink }')(
    $, $$, (m) => io.toasts.push(m), postJSON, () => { io.refreshed++ })
  ok(typeof $('#codeInput').listeners.input === 'function' && typeof $('#codeForm').listeners.submit === 'function', 'the field formats as it is typed, the form submits')
  const typed = (v) => { $('#codeInput').value = v; f.formatCodeField(); return $('#codeInput').value }
  eq(typed('abcd'), 'ABCD', 'typing: upper case')
  eq(typed('abcd2'), 'ABCD-2', '...the dash after four')
  eq(typed('ab cd 23 45 99'), 'ABCD-2345', '...spaces dropped, eight symbols at most')
  eq(typed('https://livescore.openvolley.app/board#abcd2345'), 'ABCD-2345', 'a pasted board link becomes its code')
  eq(typed('https://livescore.openvolley.app/bo'), 'https://livescore.openvolley.app/bo', 'a link still being pasted is left alone')
  $('#codeInput').value = 'ABCD-2345'
  radios[0].checked = false; radios[2].checked = true
  await f.linkByCode({ preventDefault() {} })
  eq(io.posts.at(-1), { p: '/api/link', body: { source: 'code', code: 'ABCD2345', relay: 'laptop' } }, 'Link: POST /api/link { source: code, code, relay }')
  ok(io.toasts.at(-1) === 'Following the match by its scoreboard code' && io.refreshed === 1, 'a toast, and the status asked again')
  io.reply = new Error('OpenVolley does not know this scoreboard code.')
  await f.linkByCode({ preventDefault() {} })
  eq(io.toasts.at(-1), 'OpenVolley does not know this scoreboard code.', 'a refusal: the board\'s words')
  const n = io.posts.length
  $('#codeInput').value = 'nonsense'
  await f.linkByCode({ preventDefault() {} })
  ok(io.posts.length === n && /not a scoreboard code/.test(io.toasts.at(-1)), 'not a code: nothing sent, said why')
  // the status line
  const line = (fc) => { f.renderFollowCode({ followCode: fc }); const l = $('#codeStat'); return l.hidden ? '' : `${l.dataset.tone}: ${l.textContent}` }
  const base = { relays: ['cloud', 'laptop'], linked: false, state: null, retryAt: null, endsAt: null }
  eq(line(base), '', 'nothing to say: no line')
  ok(labels[1].hidden === true && labels[0].hidden === false && labels[2].hidden === false, 'no "OpenVolley on this board" where the board runs none')
  radios.forEach((r) => { r.checked = r.value === 'board' })
  line({ ...base, relays: ['laptop'] })
  ok(radios[2].checked === true, 'a relay the board cannot use is not left chosen')
  ok(/^ok: Following the match by its code, until \d\d:\d\d$/.test(line({ ...base, linked: true, state: 'following', endsAt: Date.now() + 3600e3 })), 'following, until when')
  ok(/^warn: The code is not found right now — trying again in (29|30) s$/.test(line({ ...base, linked: true, state: 'lost', retryAt: Date.now() + 30e3 })), 'lost: trying again in 30 s')
  ok(/^warn: Too many tries — trying again in 1[12]\d s$/.test(line({ ...base, linked: true, state: 'rate-limited', retryAt: Date.now() + 120e3 })), 'rate-limited while linked')
  eq(line({ ...base, linked: true, state: 'looking' }), 'warn: Looking for the code…', 'looking')
  eq(line({ ...base, state: 'ended' }), 'bad: The code has ended. Ask the scorer for the new one.', 'ended')
  eq(line({ ...base, state: 'not-found' }), 'bad: Code not found. Check it, and where the scorer scores.', 'not found')
  ok(/^bad: Too many tries — try again in \d+ s$/.test(line({ ...base, state: 'rate-limited', retryAt: Date.now() + 60e3 })), 'too many tries: when to try again')
  eq(line({ ...base, state: 'unsupported' }), 'bad: This OpenVolley does not know scoreboard codes yet.', 'an older OpenVolley')
  // every line has its German
  const de = JSON.parse(fs.readFileSync(new URL('../web/i18n/de.json', import.meta.url), 'utf8'))
  const tr = (s) => de.exact[s] || (de.patterns.find(([re]) => new RegExp(re).test(s)) || [])[1]
  const words = ['Follow by scoreboard code', 'OpenVolley cloud', 'OpenVolley on this board', 'Scorer laptop', 'Looking for the code…', 'Following the match by its code, until 21:30',
    'The code is not found right now — trying again in 30 s', 'Too many tries — trying again in 120 s', 'Too many tries — try again in 60 s', 'The code has ended. Ask the scorer for the new one.',
    'Code not found. Check it, and where the scorer scores.', 'This OpenVolley does not know scoreboard codes yet.', 'Following the match by its scoreboard code',
    'That is not a scoreboard code: 8 letters and digits, like ABCD-2345']
  const missing = words.filter((w) => !tr(w))
  ok(missing.length === 0, `German for every word of the card${missing.length ? `: missing ${missing.join(' | ')}` : ''}`)
}

await cloud.close()
fs.rmSync(stateDir, { recursive: true, force: true })
console.log(`\n${fail ? '❌' : '✅'} follow-code: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
