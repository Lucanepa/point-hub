// A linked eScoresheet's breaks on the board's own countdowns (research finding product-02):
//   - the scorer's timeout starts the board's TIME OUT clock on the rising edge of
//     `timeout_active`, named for the team whose timeout count went up; the falling edge ends it,
//     silently when the scorer stopped it early, with the horn when it ran its length
//   - a set end (`set_interval_active`, true on OpenVolley's set_end frame only) starts the
//     INTERVAL clock; the next set's line-ups do not end it, the scorer's Start set / End
//     interval, an undo or a rally in the new set do
//   - each is timed from the moment the board sees it, and runs out on its own (horn) when the
//     laptop's end never arrives — a link drop leaves no clock stuck on the panel
//   - a state older than the newest (`_seq` within one `_session`) is dropped, so neither the
//     relay's replay after a reconnect nor a stale frame starts a break twice or rolls a score back
//   - a console tap during a linked break wins: a skip, the operator's own countdown, Show clock
//   - a set interval that turns out to be the match end puts the result up, no interval, no horn
//   - beach and basketball links are as they were: no countdowns from a link
// Needs the `ws` devDependency (npm install).

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { LanSource } from '../src/lanSource.js'
import { Settings } from '../src/settings.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sectionsOf = (file) => [...fs.readFileSync(new URL(`../layouts/${file}`, import.meta.url), 'utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(1)

// OpenVolley's live state as Scoreboard.jsx builds it (the fields this test moves).
const BASE = {
  team_a_name: 'KSC Wiedikon', team_a_short: 'KSC', team_a_color: '#2563eb',
  team_b_name: 'VBC Züri', team_b_short: 'VBC', team_b_color: '#ef4444',
  current_set: 1, points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, side_a: 'left', serving_team: 'left',
  timeouts_a: [], timeouts_b: [], subs_a: null, subs_b: null,
  timeout_active: false, set_interval_active: false, match_status: 'in_progress', last_event_type: 'point',
}

// ------------------------------------------------------------------------------------------------
console.log('\n[1] LanSource: the break edges, frame by frame (no board)')
{
  const lan = new LanSource({ relayUrl: `ws://127.0.0.1:${await freePort()}`, matchId: 'm1', reconnectMs: 0 })
  let seen = []
  lan.on('state', () => seen.push('state'))
  lan.on('timeout-start', (s, info) => seen.push(`timeout-start:${info.side}`))
  for (const ev of ['timeout-end', 'interval-start', 'interval-end', 'match-ended', 'match-resumed']) lan.on(ev, () => seen.push(ev))
  lan.on('error', () => {}) // the closed port above
  lan.start()
  let seq = 0, session = 'S1', cur = { ...BASE }
  // One frame through the real relay path (RelaySubscriber._onMessage → LanSource). `o` changes the
  // match; flags not named are off, as OpenVolley sends them.
  const feed = (o = {}, { order = true, type = 'live-state-update' } = {}) => {
    cur = { ...cur, timeout_active: false, set_interval_active: false, last_event_type: 'point', ...o }
    const liveState = order ? { ...cur, _seq: ++seq, _session: session } : { ...cur }
    seen = []
    lan.sub._onMessage(JSON.stringify(type === 'live-state-update' ? { type, matchId: 'm1', liveState } : { type, matchId: 'm1', data: { liveState } }))
    return seen
  }
  const raw = (liveState) => { seen = []; lan.sub._onMessage(JSON.stringify({ type: 'live-state-update', matchId: 'm1', liveState })); return seen }

  eq(feed({ points_a: 3, points_b: 1 }), ['state'], 'a rally: state only')
  eq(feed({ timeout_active: true, timeouts_a: [{}], last_event_type: 'timeout' }), ['state', 'timeout-start:left'], 'A calls a timeout (A on the left)')
  eq(feed({ timeout_active: true, subs_b: [{}], last_event_type: 'substitution' }), ['state'], 'a substitution during it: no second start')
  eq(feed({ last_event_type: 'end_timeout' }), ['state', 'timeout-end'], 'the scorer ends it: one end')
  eq(feed({ last_event_type: 'end_timeout' }), ['state'], 'a repeat of the end: nothing')
  eq(feed({ timeout_active: true, timeouts_b: [{}], last_event_type: 'timeout' }), ['state', 'timeout-start:right'], 'B calls one: B is on the right')
  eq(feed({ timeout_active: true, timeouts_a: [{}, {}], last_event_type: 'timeout' }), ['state', 'timeout-start:left'],
    'A\'s count goes up while B\'s is still on (the end was missed): a new timeout, for A')
  eq(feed({ last_event_type: 'end_timeout' }), ['state', 'timeout-end'], 'ended')
  cur.side_a = 'right'
  eq(feed({ timeout_active: true, timeouts_a: [{}, {}, {}], last_event_type: 'timeout' }), ['state', 'timeout-start:right'], 'A on the right after the change of ends')
  eq(feed({ last_event_type: 'end_timeout' }), ['state', 'timeout-end'], 'ended')

  console.log('  — ordering')
  const stale = { ...cur, timeout_active: true, _seq: seq - 1, _session: session }
  eq(raw(stale), [], 'a state older than the newest (same session) is dropped: no state, no edge')
  eq(raw({ ...cur, _seq: seq, _session: session }), ['state'], 'the same number again (the relay\'s replay) is taken, and starts nothing')
  session = 'S2'; seq = 0
  eq(feed({ points_a: 4 }), ['state'], 'a new session (the scorer reloaded) starts again at 1 and is taken')
  eq(raw({ ...cur, timeout_active: true, _seq: 0, _session: session }), [], '…and is ordered from then on')
  eq(feed({ points_a: 5 }, { order: false }), ['state'], 'a state with no order at all (an older scorer) is taken')
  eq(feed({ points_a: 6 }, { type: 'match-full-data' }), ['state'], 'the subscribe reply goes through the same check')

  console.log('  — set interval (true on the set_end frame only)')
  const setEnd = { set_interval_active: true, last_event_type: 'set_end', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, side_a: 'left' }
  eq(feed(setEnd), ['state', 'interval-start'], 'set_end: the interval starts')
  eq(feed({ last_event_type: 'lineup' }), ['state'], 'the next set\'s line-up (flag false): the interval goes on')
  eq(feed({ last_event_type: 'reconnect', current_set: 1, points_a: 25, points_b: 21, sets_won_a: 0 }), ['state'],
    'a re-push carrying the finished set\'s own snapshot (25-21 in set 1): goes on')
  eq(feed({ last_event_type: 'set_start', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1 }), ['state', 'interval-end'], 'Start set: over')
  eq(feed({ points_a: 1 }), ['state'], 'and a rally after it is just a rally')
  eq(feed({ ...setEnd, current_set: 3, sets_won_b: 1, points_a: 0 }), ['state', 'interval-start'], 'set 2 ends: interval')
  eq(feed({ last_event_type: 'end_interval' }), ['state', 'interval-end'], 'End interval: over')
  eq(feed({ ...setEnd, current_set: 4, sets_won_a: 2 }), ['state', 'interval-start'], 'set 3 ends: interval')
  eq(feed({ last_event_type: 'point', current_set: 4, points_b: 1 }), ['state', 'interval-end'], 'a rally scored in set 4: over')
  eq(feed({ ...setEnd, current_set: 4, sets_won_a: 2, points_b: 0 }), ['state', 'interval-start'], 'interval again')
  eq(feed({ last_event_type: 'undo', current_set: 3, points_a: 24, points_b: 22, sets_won_a: 1 }), ['state', 'interval-end'], 'the set end undone: over')

  console.log('  — the match end')
  eq(feed({ ...setEnd, current_set: 4, sets_won_a: 3, sets_won_b: 1, match_status: 'ended' }), ['state', 'match-ended'],
    'the deciding set_end (flag true AND ended): the result, no interval')
  eq(feed({ last_event_type: 'match_end', match_status: 'ended' }), ['state'], 'the match_end frame after it: nothing more')
  eq(feed({ last_event_type: 'undo', sets_won_a: 2, points_a: 24, match_status: 'in_progress' }), ['state', 'match-resumed'], 'the end undone')
  eq(feed({ ...setEnd, current_set: 5, sets_won_a: 2, sets_won_b: 2 }), ['state', 'interval-start'], 'a 2-2 set end: interval')
  eq(feed({ last_event_type: 'match_end', match_status: 'ended', sets_won_a: 3 }), ['state', 'match-ended'],
    'the match ended during it: match-ended, and no interval-end on top (the result owns the panel)')
  eq(feed({ last_event_type: 'set_start', match_status: 'ended' }), ['state'], 'nothing after it either')
  eq(feed({ timeout_active: true, timeouts_b: [{}, {}], match_status: 'ended' }), ['state'], 'no timeout over a finished match')

  console.log('  — a first frame, and a source with no break fields')
  const lan2 = new LanSource({ relayUrl: `ws://127.0.0.1:${await freePort()}`, matchId: 'm2', reconnectMs: 0 })
  const seen2 = []
  for (const ev of ['timeout-start', 'interval-start']) lan2.on(ev, () => seen2.push(ev))
  lan2.on('error', () => {})
  lan2.start()
  lan2.sub._onMessage(JSON.stringify({ type: 'match-full-data', matchId: 'm2', data: { liveState: { ...BASE, timeout_active: true, timeouts_a: [{}], _seq: 7, _session: 'X' } } }))
  eq(seen2, ['timeout-start'], 'a link made during a timeout shows it (the laptop\'s own end stops it)')
  const lan3 = new LanSource({ relayUrl: `ws://127.0.0.1:${await freePort()}`, matchId: 'm3', reconnectMs: 0 })
  let edges3 = 0
  for (const ev of ['timeout-start', 'timeout-end', 'interval-start', 'interval-end']) lan3.on(ev, () => edges3++)
  lan3.on('error', () => {})
  lan3.start()
  for (const p of [1, 2, 3]) lan3.sub._onMessage(JSON.stringify({ type: 'live-state-update', matchId: 'm3', liveState: { team_a_short: 'A', team_b_short: 'B', points_a: p, points_b: 0, timeouts_a: p, timeouts_b: 0 } }))
  ok(edges3 === 0, 'states without the break fields (another producer) make no edge at all')
  lan.stop(); lan2.stop(); lan3.stop()
}

// ------------------------------------------------------------------------------------------------
// A relay like OpenVolley's (backend/server.js --local), with a switch to take it down.
const SEED = 'match_1759750000000_ab12cd'
const relay = http.createServer((req, res) => {
  if (req.url === '/api/match/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ success: true, matches: [{ id: SEED, gameNumber: 4711, homeTeam: 'KSC', awayTeam: 'VBC', status: 'live' }] }))
  }
  res.writeHead(404); res.end('not found')
})
const wss = new WebSocketServer({ server: relay })
const subs = new Set()
let lastLive = null
let relayDown = false // true: every connection is dropped as it arrives (the laptop's Wi-Fi gone)
wss.on('connection', (ws) => {
  if (relayDown) { ws.terminate(); return }
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
const dropLinks = () => { for (const ws of wss.clients) ws.terminate(); subs.clear() }

// The scorer: its states numbered within one session, flags off unless named (as OpenVolley
// sends them).
let seq = 0, session = 'scorer-1', cur = { ...BASE }
const frame = (o = {}) => {
  cur = { ...cur, timeout_active: false, set_interval_active: false, last_event_type: 'point', ...o }
  lastLive = { ...cur, _seq: ++seq, _session: session }
  return lastLive
}
const push = (o) => { const s = frame(o); for (const ws of subs) ws.send(JSON.stringify({ type: 'live-state-update', matchId: SEED, liveState: s })); return s }
const resend = (s) => { for (const ws of subs) ws.send(JSON.stringify({ type: 'live-state-update', matchId: SEED, liveState: s })) }

const TO_S = 20, IV_S = 30 // the sport's timeout and interval lengths, as Settings has them here
const BOARD_LAYOUTS = {
  kscw_idle: sectionsOf('30_kscw_idle.xml'), kscw_break: sectionsOf('31_kscw_break.xml'),
  kscw_crest: sectionsOf('32_kscw_crest.xml'), kscw_clock: sectionsOf('33_kscw_clock.xml'),
}
async function boot({ sport = 'volleyball', layouts = {} } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-linkbreaks-'))
  if (sport !== 'volleyball') new Settings(path.join(stateDir, 'settings.json')).update({ sport }, { allowSport: true })
  const mock = new MockLedbox({ layouts: { ...BOARD_LAYOUTS, ...layouts } })
  const addr = await mock.listen(0, '127.0.0.1')
  const horns = { n: 0 }
  mock.on('command', (m) => { if (m.cmd === 'Horn') horns.n++ })
  const app = await startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '', relayDesktopPort: await freePort(),
    ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
    reconnectMs: 200, mock: false, controlPort: 0, debug: false,
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const get = async (p) => (await fetch(base + p)).json()
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, json: await r.json().catch(() => null) } }
  await sleep(250)
  // Roomy lengths, so a slow machine never turns an early end into time's up; the two checks that
  // are about running out shorten the timeout to the 5 s minimum for themselves.
  await post('/api/settings', { relayAddress: `127.0.0.1:${RELAY_PORT}`, timeoutSeconds: TO_S, setIntervalSeconds: IV_S })
  const done = async () => { await app.close(); await mock.close(); fs.rmSync(stateDir, { recursive: true, force: true }) }
  return { mock, horns, get, post, done, t: (n) => mock.text(n), cd: async () => (await get('/api/board')).countdown }
}

const b = await boot()
const { mock, horns, get, post, t, cd } = b
const MATCH = 'volleyball_matchscore_02'
try {
  console.log('\n[2] linked: a timeout on the eScoresheet runs the board\'s TIME OUT clock')
  {
    frame({ points_a: 3, points_b: 1 })
    const l = await post('/api/link', { source: 'lan', matchId: SEED })
    ok(l.status === 200 && l.json.mode === 'lan', `linked (${l.status} ${l.json?.mode})`)
    await sleep(300)
    ok(mock.currentLayout === MATCH && t('score1') === '3', `3:1 on the scoreboard (${t('score1')}:${t('score2')})`)
    push({ timeout_active: true, timeouts_a: [{}], last_event_type: 'timeout' }); await sleep(250)
    const c = await cd()
    ok(mock.currentLayout === 'kscw_break', `the break screen is up (${mock.currentLayout})`)
    ok(t('lbl') === 'TIME OUT' && t('team') === 'KSC', `labelled TIME OUT for KSC, the team that called it (${t('lbl')} / ${t('team')})`)
    ok(c && c.link === 'timeout' && c.remainingMs > (TO_S - 1) * 1000 && c.remainingMs <= TO_S * 1000, `the sport's own ${TO_S} s, timed from now, not from the laptop's stamp (${JSON.stringify(c)})`)
    ok(t('timer') === String(TO_S) && t('score1') === '3' && t('score2') === '1', `clock ${TO_S}, score 3:1 beside it (${t('timer')}, ${t('score1')}:${t('score2')})`)
    push({ timeout_active: true, subs_b: [{ playerIn: 7, playerOut: 12 }], last_event_type: 'substitution' }); await sleep(900)
    const c2 = await cd()
    ok(c2 && c2.remainingMs < c.remainingMs - 700, `a frame during the timeout does not restart it (${c.remainingMs} → ${c2 && c2.remainingMs} ms)`)
    push({ last_event_type: 'end_timeout' }); await sleep(250)
    ok(mock.currentLayout === MATCH && (await cd()) === null, `the scorer stopped it early: back on the scoreboard (${mock.currentLayout})`)
    ok(horns.n === 0, `…without the horn (${horns.n})`)
  }

  console.log('\n[3] the laptop\'s time\'s-up a moment before the board\'s own zero still sounds the horn')
  {
    await post('/api/settings', { timeoutSeconds: 5 })
    push({ timeout_active: true, timeouts_b: [{}], last_event_type: 'timeout' }); await sleep(200)
    ok(t('team') === 'VBC' && t('lbl') === 'TIME OUT', `TIME OUT for VBC (${t('team')})`)
    await sleep(2300)
    push({ last_event_type: 'end_timeout' }); await sleep(250)
    ok(mock.currentLayout === MATCH && horns.n === 1, `ended with ~2.5 s of 5 left: time's up, horn once (${horns.n})`)
    await post('/api/settings', { timeoutSeconds: TO_S })
  }

  console.log('\n[4] the laptop drops mid-timeout and comes back: no second start')
  {
    push({ points_a: 4, timeout_active: true, timeouts_a: [{}, {}], last_event_type: 'timeout' }); await sleep(250)
    const c = await cd()
    ok(c && c.link === 'timeout', 'TIME OUT running')
    dropLinks(); await sleep(700) // the board reconnects (200 ms) and gets the relay's replay
    ok(subs.size === 1, `the board re-subscribed (${subs.size})`)
    const c2 = await cd()
    ok(c2 && c2.remainingMs < c.remainingMs - 500, `the replay of the same frame did not restart the clock (${c.remainingMs} → ${c2 && c2.remainingMs} ms)`)
    // The scorer ends the timeout while the board cannot hear it; the relay keeps the end.
    relayDown = true; dropLinks()
    frame({ last_event_type: 'end_timeout' })
    await sleep(300)
    relayDown = false; await sleep(600)
    ok(subs.size === 1 && (await cd()) === null && mock.currentLayout === MATCH, `the end it missed arrives with the replay and ends it (${mock.currentLayout})`)
    ok(horns.n === 1, `silently: it ended early (${horns.n})`)
  }

  console.log('\n[5] the laptop gone for good mid-timeout: the board\'s clock runs out on its own')
  {
    await post('/api/settings', { timeoutSeconds: 5 })
    push({ timeout_active: true, timeouts_b: [{}, {}], last_event_type: 'timeout' }); await sleep(200)
    const tf = lastLive
    relayDown = true; dropLinks()
    await sleep(5200)
    ok((await cd()) === null && mock.currentLayout === MATCH, `no clock stuck on the panel (${mock.currentLayout})`)
    ok(horns.n === 2, `the horn, once (${horns.n})`)
    relayDown = false; await sleep(600)
    ok(subs.size === 1 && (await cd()) === null, 'back online, the replay of the same timeout frame starts nothing')
    resend(tf); await sleep(200)
    ok((await cd()) === null, 'nor does it a second time')
    push({ last_event_type: 'end_timeout' }); await sleep(200)
    ok(horns.n === 2 && mock.currentLayout === MATCH, `and the late end is a no-op: no second horn (${horns.n})`)
    await post('/api/settings', { timeoutSeconds: TO_S })
  }

  console.log('\n[6] a stale frame neither restarts a break nor rolls the score back')
  {
    const old = push({ points_a: 9, points_b: 8, timeout_active: true, timeouts_a: [{}, {}, {}], last_event_type: 'timeout' }); await sleep(150)
    push({ points_a: 9, points_b: 8, last_event_type: 'end_timeout' }); await sleep(150)
    push({ points_a: 10, points_b: 8 }); await sleep(200)
    ok(t('score1') === '10' && (await cd()) === null, `10:8, no break (${t('score1')}:${t('score2')})`)
    resend(old); await sleep(250)
    ok((await cd()) === null && mock.currentLayout === MATCH, 'the older timeout frame starts nothing')
    ok(t('score1') === '10', `and the score stays 10:8 (${t('score1')}:${t('score2')})`)
    session = 'scorer-2'; seq = 0
    push({ points_b: 9 }); await sleep(200)
    ok(t('score2') === '9', `the scorer reloaded (a new session, from #1 again): taken (${t('score1')}:${t('score2')})`)
  }

  console.log('\n[7] a console tap during a linked timeout wins')
  {
    // A skip (the console's ✕): over, and the laptop's later frames do not bring it back.
    push({ timeout_active: true, timeouts_b: [{}, {}, {}], last_event_type: 'timeout' }); await sleep(200)
    ok((await cd())?.link === 'timeout', 'TIME OUT running')
    await post('/api/countdown/stop', { expired: false }); await sleep(250)
    ok((await cd()) === null && mock.currentLayout === MATCH, 'skipped from the console')
    push({ timeout_active: true, subs_a: [{}], last_event_type: 'substitution' }); await sleep(200)
    ok((await cd()) === null, 'a frame still in the timeout does not restart it')
    push({ last_event_type: 'end_timeout' }); await sleep(200)
    ok((await cd()) === null && horns.n === 2, `the laptop's end: nothing, no horn (${horns.n})`)

    // The operator's own countdown over the linked one: the laptop's end must not take it down.
    push({ timeout_active: true, timeouts_a: [{}, {}, {}, {}], last_event_type: 'timeout' }); await sleep(200)
    await post('/api/countdown', { seconds: 600, label: 'WARM UP', content: 'none' }); await sleep(200)
    ok((await cd())?.label === 'WARM UP', 'the operator started a warm-up over it')
    push({ last_event_type: 'end_timeout' }); await sleep(250)
    const w = await cd()
    ok(w && w.label === 'WARM UP' && w.link == null && mock.currentLayout === 'kscw_break', `the laptop's end left the warm-up running (${JSON.stringify(w)})`)
    await post('/api/countdown/stop', { expired: false }); await sleep(250)

    // Show clock: the operator's screen stays, through the linked timeout and a new one.
    push({ timeout_active: true, timeouts_b: [{}, {}, {}, {}], last_event_type: 'timeout' }); await sleep(200)
    await post('/api/idle', { on: true, screen: 'clock' }); await sleep(250)
    ok(mock.currentLayout === 'kscw_clock', `Show clock during it (${mock.currentLayout})`)
    push({ timeout_active: true, points_a: 11, last_event_type: 'substitution' }); await sleep(200)
    push({ last_event_type: 'end_timeout' }); await sleep(200)
    push({ timeout_active: true, timeouts_a: [{}, {}, {}, {}, {}], last_event_type: 'timeout' }); await sleep(1300)
    ok(mock.currentLayout === 'kscw_clock' && (await cd()) === null, `the clock stays: no countdown over it (${mock.currentLayout})`)
    push({ last_event_type: 'end_timeout' }); await sleep(150)
    await post('/api/idle', { on: false }); await sleep(250)
    ok(mock.currentLayout === MATCH && t('score1') === '11', `back to scoring: 11 (${t('score1')})`)
    ok(horns.n === 2, `no horn anywhere in this (${horns.n})`)

    // Settings ▸ countdown on timeout off: a linked timeout leaves the scoreboard up.
    await post('/api/settings', { countdownOnTimeout: false })
    push({ timeout_active: true, timeouts_b: [{}, {}, {}, {}, {}], last_event_type: 'timeout' }); await sleep(250)
    ok((await cd()) === null && mock.currentLayout === MATCH, 'countdown on timeout off: no TIME OUT')
    push({ last_event_type: 'end_timeout' }); await sleep(150)
    await post('/api/settings', { countdownOnTimeout: true })
  }

  console.log('\n[8] the set interval')
  {
    push({ set_interval_active: true, last_event_type: 'set_end', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1, side_a: 'right', serving_team: 'right' })
    await sleep(250)
    const c = await cd()
    ok(c && c.link === 'interval' && c.remainingMs > (IV_S - 1) * 1000, `INTERVAL running, the sport's own ${IV_S} s (${JSON.stringify(c)})`)
    ok(t('lbl') === 'INTERVAL' && t('timerbig') === String(IV_S), `labelled INTERVAL, clock ${IV_S} (${t('lbl')} ${t('timerbig')})`)
    ok(t('score1') === '0' && t('score2') === '1', `the set score big, KSC now on the right (${t('score1')}:${t('score2')})`)
    push({ last_event_type: 'lineup' }); await sleep(250)
    ok((await cd())?.link === 'interval', 'the next set\'s line-up entered: the interval goes on')
    push({ last_event_type: 'set_start' }); await sleep(250)
    ok((await cd()) === null && mock.currentLayout === MATCH && horns.n === 2, `Start set: back on the scoreboard, no horn (${mock.currentLayout}, ${horns.n})`)
    push({ set_interval_active: true, last_event_type: 'set_end', current_set: 3, sets_won_b: 1, side_a: 'left' }); await sleep(250)
    ok((await cd())?.link === 'interval', 'set 2 over: INTERVAL')
    push({ last_event_type: 'point', current_set: 3, points_a: 1 }); await sleep(250)
    ok((await cd()) === null && t('score1') === '1', `the first rally of set 3 ends it (${t('score1')})`)
  }

  console.log('\n[9] a set interval that turns out to be the match end')
  {
    push({ set_interval_active: true, last_event_type: 'set_end', current_set: 4, points_a: 0, sets_won_a: 2 }); await sleep(250)
    ok((await cd())?.link === 'interval', 'set 3 over at 2-1: INTERVAL')
    push({ last_event_type: 'match_end', match_status: 'ended', sets_won_a: 3 }); await sleep(400)
    ok(mock.currentLayout === 'kscw_result' && /KSC WINS/.test(t('winner') || ''), `the scorer ended the match: the result (${mock.currentLayout}, ${t('winner')})`)
    ok((await cd()) === null && horns.n === 2, `the interval is gone, without the horn (${horns.n})`)
    await sleep(1300)
    ok(mock.currentLayout === 'kscw_result', `and its ticker does not bring the break screen back (${mock.currentLayout})`)
    push({ last_event_type: 'undo', match_status: 'in_progress', current_set: 3, sets_won_a: 2, points_a: 24, points_b: 20 }); await sleep(400)
    ok(mock.currentLayout === MATCH && t('score1') === '24', `the end undone: the score is back (${mock.currentLayout} ${t('score1')})`)
    push({ set_interval_active: true, last_event_type: 'set_end', current_set: 3, points_a: 0, points_b: 0, sets_won_a: 3, match_status: 'ended' }); await sleep(400)
    ok(mock.currentLayout === 'kscw_result' && (await cd()) === null, `the deciding set_end (interval flag AND ended): the result, no INTERVAL (${mock.currentLayout})`)
    ok(horns.n === 2, `no horn (${horns.n})`)
  }
} finally {
  await b.done()
}

console.log('\n[10] beach and basketball links are as they were: the score, no countdowns')
for (const [sport, layout, file] of [['beach', 'beach_matchscore', '40_beach_matchscore.xml'], ['basketball', 'basketball_matchscore', '41_basketball_matchscore.xml']]) {
  const r = await boot({ sport, layouts: { [layout]: sectionsOf(file) } })
  try {
    cur = { ...BASE }
    frame({ points_a: 7, points_b: 5 })
    const l = await r.post('/api/link', { source: 'lan', matchId: SEED })
    await sleep(350)
    ok(l.status === 200 && r.mock.currentLayout === layout && r.t('score1') === '7', `${sport}: linked, 7:5 on ${layout} (${r.mock.currentLayout} ${r.t('score1')}:${r.t('score2')})`)
    push({ timeout_active: true, timeouts_a: [{}], last_event_type: 'timeout' }); await sleep(300)
    ok((await r.cd()) === null && r.mock.currentLayout === layout, `${sport}: a timeout flag starts no countdown`)
    push({ set_interval_active: true, last_event_type: 'set_end', current_set: 2, points_a: 0, points_b: 0, sets_won_a: 1 }); await sleep(300)
    ok((await r.cd()) === null && r.mock.currentLayout === layout, `${sport}: nor does a set end`)
    push({ last_event_type: 'set_start', points_a: 1 }); await sleep(250)
    ok(r.t('score1') === '1' && r.horns.n === 0, `${sport}: the score keeps coming (${r.t('score1')}), no horn`)
  } finally {
    await r.done()
  }
}

for (const ws of wss.clients) ws.terminate()
wss.close()
relay.closeAllConnections?.()
await new Promise((r) => relay.close(r))

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — link-breaks-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
