// Does the board come back with the score after it dies mid-match?
//
// The unit is Restart=always. Until the crash marker existed, a bridge that died at 22-21 came back
// showing the KSC Wiedikon crest with 0-0 behind it and stayed there until somebody realised and
// pressed Continue — and because the restart loops, a repeating fault (an OOM from a flood at
// /api/logs, a bad reply from the panel) meant the scoreboard quietly lost the match in front of
// the hall while `systemctl is-active` still said `active`.
//
// The distinction being tested is deliberate and it is the whole design:
//   died           -> data/.running survives  -> replay the saved match
//   stopped        -> close() removed it      -> land on the game menu, an operator is standing there
// It is keyed on that marker rather than on the age of the saved slot because the board has NO RTC
// and its clock has been 36 h out in the field, so "is this recent?" is not a question it can answer.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-crash-'))
const runMark = path.join(stateDir, 'data', '.running')

// One mock that outlives every boot, so the board is the constant and only the bridge restarts.
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')

const boot = () => startAppliance({
  stateDir,
  relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port,
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
  mock: false, controlPort: 0, debug: false,
})
const post = async (app, route, body) => {
  const base = `http://127.0.0.1:${app.server.address().port}`
  const res = await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body ?? {}),
  })
  await sleep(120)
  return res.status
}
const state = async (app) => (await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`)).json()).state
// A crash is the absence of a clean shutdown: tear the process's resources down WITHOUT close(),
// which is the only thing that removes the marker.
const crash = async (app) => {
  await new Promise((r) => app.server.close(r))
  app.ledbox.disconnect()
  app.livePush.detach()
  app.sourceManager.stop()
}

let app = null
try {
  console.log('\n[1] a match is under way')
  app = await boot()
  await sleep(200)
  await post(app, '/api/manual')
  await post(app, '/api/action', { action: { type: 'team', side: 'left', short: 'KSCW', name: 'KSC Wiedikon' } })
  await post(app, '/api/action', { action: { type: 'team', side: 'right', short: 'VZH', name: 'Volero' } })
  await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 22 } })
  await post(app, '/api/action', { action: { type: 'point', side: 'right', delta: 21 } })
  const live = await state(app)
  ok(live.points_a === 22 && live.points_b === 21, 'scored to 22-21')
  ok(fs.existsSync(runMark), 'the crash marker is armed while running')
  ok(fs.existsSync(path.join(stateDir, 'data', 'resume.json')), 'the match is saved to the resume slot')

  console.log('\n[2] the bridge dies — no clean shutdown')
  await crash(app)
  ok(fs.existsSync(runMark), 'the marker SURVIVES an unclean stop (this is the signal)')

  console.log('\n[3] systemd restarts it: the match comes back by itself')
  app = await boot()
  await sleep(600) // the restore waits for the board handshake, then repaints
  const back = await state(app)
  ok(back.points_a === 22 && back.points_b === 21, `score restored unprompted (${back.points_a}-${back.points_b})`)
  ok(back.team_a_short === 'KSCW' && back.team_b_short === 'VZH', 'teams restored')
  ok(mock.text('score1') === '22' && mock.text('score2') === '21', 'and it is on the PANEL, not just in memory')
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'panel is on the match layout, not the crest')

  console.log('\n[4] a deliberate stop is different — an operator is standing there')
  await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  await app.close()
  ok(!fs.existsSync(runMark), 'close() disarms the marker')

  app = await boot()
  await sleep(600)
  const fresh = await state(app)
  // No source is started on a clean boot, so `state` is null — that is the game-menu state, and it
  // is what the operator should be looking at. What must NOT be true is a restored 23-21.
  ok(!fresh || (fresh.points_a === 0 && fresh.points_b === 0),
    `a clean restart does NOT replay the match (state ${fresh ? `${fresh.points_a}-${fresh.points_b}` : 'null — idle'})`)
  const menu = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/game`)).json()
  ok(menu.saved && menu.saved.points && menu.saved.points.a === 23,
    'but the slot is still there, so Continue is offered (23-21)')
  await app.close()

  console.log('\n[5] a crash with nothing saved is harmless')
  fs.rmSync(path.join(stateDir, 'data', 'resume.json'), { force: true })
  fs.writeFileSync(runMark, 'pretend-crash')
  app = await boot()
  await sleep(400)
  const empty = await state(app)
  ok(!empty || empty.points_a === 0, 'boots to an empty board rather than throwing')
  await app.close()
  app = null
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  if (app) { try { await app.close() } catch { /* already down */ } }
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
