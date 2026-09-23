// General undo, the set-closed guard and the /logs stream handshake — the server half of the
// console's "Undo last action" button and its set-point double-tap toast.
//
//   [1] HistoryStore: an undo takes back exactly what the undone action wrote — its point, its set
//       end, its "Match over" (un-archiving the match) — and leaves one `undo` marker instead.
//   [2] End to end over HTTP against a mock LedBox: the winner's second tap at set point answers
//       event 'set-closed' with the board unchanged; /api/status carries canUndo/undoLabel; undo
//       restores state, repaints the PANEL, re-saves the resume slot and fixes the archive; an
//       empty journal answers 'undo-empty'; New game clears the journal.
//   [3] /api/logs/stream sends its headers straight away (EventSource.onopen on a quiet board) and
//       honours Last-Event-ID on a reconnect.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/historyStore.js'
import { ManualSource } from '../src/manualSource.js'
import { BeachSource } from '../src/beachSource.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { log } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

// Drive a source and a history exactly as the server does: journal flags passed through, and an
// undo recorded with the label read before it popped.
function rig(Source = ManualSource) {
  const src = new Source()
  const h = new HistoryStore()
  const act = (a) => {
    const label = a.type === 'undo' ? src.undoLabel : ''
    src.apply(a)
    if (src.lastEvent === 'set-closed' || src.lastEvent === 'undo-empty') return src.lastEvent
    h.record(a, src.getState(), src.lastEvent, '2026-09-23 19:00', '19:00:00', { undoable: src.lastJournaled, label })
    return src.lastEvent
  }
  const pt = (side, delta = 1) => act({ type: 'point', side, delta })
  return { src, h, act, pt, events: () => (h.current ? h.current.events : []) }
}

console.log('\n[1] the log follows an undo')
{
  const r = rig()
  r.act({ type: 'team', side: 'left', short: 'KSCW' })
  r.pt('left'); r.pt('left')
  r.act({ type: 'undo' })
  const ev = r.events()
  eq(ev.filter((e) => e.type === 'point').length, 1, 'the undone point is gone from the log')
  const marker = ev[ev.length - 1]
  ok(marker.type === 'undo' && marker.what === 'Point KSCW', 'and an undo marker says what was taken back')
  eq(marker.score.join('–'), '1–0', 'the marker carries the score after the undo')

  // A set end: undo removes the point AND the set-end the point produced.
  const s = rig()
  for (let i = 0; i < 25; i++) s.pt('left')
  ok(s.events().some((e) => e.type === 'set-end'), 'the set end is on the record')
  s.act({ type: 'undo' })
  ok(!s.events().some((e) => e.type === 'set-end'), 'undoing the set point takes the set end off it')

  // The match point: undo un-archives the match and the play-by-play carries on.
  const m = rig()
  m.src.apply({ type: 'set-state', state: { side_a: 'left', sets_won_a: 2, sets_won_b: 2 } })
  for (let i = 0; i < 15; i++) m.pt('left')
  eq(m.h.matches.length, 1, 'the match point archives the match')
  m.act({ type: 'undo' })
  eq(m.h.matches.length, 0, 'undo takes it back off the archive')
  ok(m.h.current && !m.events().some((e) => e.type === 'match-end' || e.type === 'set-end'), 'and reopens it without its end')
  m.pt('left')
  eq(m.h.matches.length, 1, 'the real match point archives it once')
  const done = m.h.matches[0]
  eq(done.events.filter((e) => e.type === 'match-end').length, 1, 'with ONE Match over')
  eq(done.events.filter((e) => e.type === 'point' && e.delta === 1).length, 15, 'and 15 points, not 16')

  // Undoing a "−" that had reopened the archived match puts the match back exactly as it was.
  m.pt('left', -1)
  eq(m.h.matches.length, 0, 'a "−" on the match point reopens the match (as before)')
  m.act({ type: 'undo' })
  eq(m.h.matches.length, 1, 'undoing that "−" archives the match again')
  ok(m.h.matches[0] === done, 'the very same record, untouched')

  // A no-op (a "−" at 0) is not a step: the source did not journal it, so neither may the log.
  const n = rig()
  n.pt('left'); n.pt('right')
  n.pt('left', -1); n.pt('left', -1) // 0-1, then a no-op at 0
  n.act({ type: 'undo' })
  eq(n.src.getState().points_a, 1, 'undo skips the no-op in the source')
  ok(n.events().filter((e) => e.type === 'point' && e.delta === -1).length === 1, 'and in the log the real "−" is the one removed')

  // Undo a reset: the old match is the match again.
  const z = rig()
  z.pt('left'); z.pt('left')
  z.act({ type: 'reset' })
  ok(z.h.current === null, 'reset closes the log buffer')
  z.act({ type: 'undo' })
  ok(z.h.current && z.events().filter((e) => e.type === 'point').length === 2, 'undoing it brings the match and its log back')

  // Beach's winning pair double-tap never reaches the log.
  const b = rig(BeachSource)
  for (let i = 0; i < 21; i++) b.pt('left')
  const before = b.events().length
  eq(b.pt('left'), 'set-closed', 'beach: the second tap at set point is refused')
  eq(b.events().length, before, 'and nothing is logged for it')
}

console.log('\n[2] end to end: /api/action undo and set-closed')
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-undo-'))
let app
try {
  app = await startAppliance({
    stateDir,
    relayUrl: '', relayHttpUrl: '', matchId: '',
    ledboxHost: '127.0.0.1', ledboxPort: addr.port,
    ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
    mock: false, controlPort: 0, debug: false,
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const post = async (p, body) => (await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  })).json()
  const action = (a) => post('/api/action', { action: a })
  const status = async () => (await fetch(base + '/api/status')).json()
  await sleep(300)
  await post('/api/game', { choice: 'new' })
  let st = await status()
  ok(st.canUndo === false && st.undoLabel === '', '/api/status: nothing to undo on a fresh game')

  await action({ type: 'team', side: 'left', short: 'KSCW' })
  for (let i = 0; i < 10; i++) await action({ type: 'point', side: 'right', delta: 1 })
  for (let i = 0; i < 24; i++) await action({ type: 'point', side: 'left', delta: 1 })
  const win = await action({ type: 'point', side: 'left', delta: 1 })
  eq(win.event, 'set-end', 'the first tap at 24-10 ends the set')
  const dbl = await action({ type: 'point', side: 'left', delta: 1 })
  eq(dbl.event, 'set-closed', 'the double tap answers set-closed')
  ok(dbl.ok === true && dbl.state.points_a === 25 && dbl.state.sets_won_a === 1, 'with the state unchanged at 25-10')
  await sleep(150)
  eq(mock.text('score1'), '25', 'and the PANEL still reads 25, not 26')
  ok(dbl.canUndo === true && dbl.undoLabel === 'Point KSCW', 'undo still offers the set point itself')

  st = await status()
  ok(st.canUndo === true && st.undoLabel === 'Point KSCW', '/api/status exposes canUndo + undoLabel')

  const u = await action({ type: 'undo' })
  eq(u.event, 'undo', 'undo answers event undo')
  ok(u.state.points_a === 24 && u.state.sets_won_a === 0 && u.state.set_results.length === 0, 'the set point is taken back: 24-10, no set')
  await sleep(150)
  eq(mock.text('score1'), '24', 'the PANEL repaints after an undo')
  const resume = JSON.parse(fs.readFileSync(path.join(stateDir, 'data', 'resume.json'), 'utf8'))
  const saved = resume.games && resume.games.volleyball && resume.games.volleyball.state
  ok(saved && saved.points_a === 24, 'the resume slot is re-saved at the undone score')

  await action({ type: 'swap' })
  st = await status()
  eq(st.undoLabel, 'Switch sides', 'a swap is offered by name')
  await action({ type: 'undo' })
  st = await status()
  ok(st.state.team_a_short === 'KSCW', 'undo puts the teams back on their ends')

  // Match point, archived, then undone: the History tab must not keep the match.
  await post('/api/game', { choice: 'new' })
  st = await status()
  ok(st.canUndo === false, 'New game clears the journal')
  eq((await action({ type: 'undo' })).event, 'undo-empty', 'and an undo then answers undo-empty')
  await action({ type: 'set-state', state: { side_a: 'left', team_a_short: 'KSCW', team_b_short: 'AWAY', sets_won_a: 2, sets_won_b: 0 } })
  let last
  for (let i = 0; i < 25; i++) last = await action({ type: 'point', side: 'left', delta: 1 })
  eq(last.event, 'match-end', 'the match point ends the match')
  let hist = await (await fetch(base + '/api/history')).json()
  eq(hist.matches.length, 1, 'and archives it')
  await action({ type: 'undo' })
  hist = await (await fetch(base + '/api/history')).json()
  eq(hist.matches.length, 0, 'undo takes the match back off the History tab')
  last = await action({ type: 'point', side: 'left', delta: 1 })
  hist = await (await fetch(base + '/api/history')).json()
  ok(last.event === 'match-end' && hist.matches.length === 1, 'the real match point archives it once')
  const evs = hist.matches[0].events
  eq(evs.filter((e) => e.type === 'match-end').length, 1, 'with one Match over')
  ok(evs.some((e) => e.type === 'undo'), 'and the undo marker on the record')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
}

console.log('\n[3] /api/logs/stream opens at once and resumes from Last-Event-ID')
try {
  const port = app.server.address().port
  const open = (headers = {}, query = '') => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/logs/stream?scope=undotest' + query, headers }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { buf += d })
      resolve({ req, res, text: () => buf })
    })
    req.on('error', reject)
    setTimeout(() => reject(new Error('no response headers within 1s')), 1000).unref()
  })
  const t = log.child('undotest')
  t.info('one'); t.info('two'); t.info('three')
  const all = log.query({ scope: 'undotest' })
  const s1 = await open()
  ok(s1.res.statusCode === 200, 'headers arrive without waiting for a log line or the keep-alive')
  await sleep(100)
  ok(s1.text().startsWith(': open'), 'the stream opens with a comment frame')
  s1.req.destroy()
  const s2 = await open({ 'Last-Event-ID': String(all[1].id) })
  await sleep(100)
  const got = s2.text()
  ok(got.includes('"three"') && !got.includes('"one"') && !got.includes('"two"'), 'a reconnect with Last-Event-ID gets only what came after it')
  s2.req.destroy()
  // What EventSource actually sends on an automatic reconnect: the page's original ?sinceId
  // (stale) in the URL plus the newer Last-Event-ID header. The header must win.
  const s3 = await open({ 'Last-Event-ID': String(all[1].id) }, `&sinceId=${all[0].id}`)
  await sleep(100)
  const got3 = s3.text()
  ok(got3.includes('"three"') && !got3.includes('"two"'), 'Last-Event-ID beats a stale ?sinceId in the reconnect URL')
  s3.req.destroy()
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  if (app) await app.close()
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
