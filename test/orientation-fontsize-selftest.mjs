// Two things the console's mirrored layout needs from the server, and nothing more.
//
//   [1] `orientation` — where the scorer sits ('behind' the panel, the default, or 'front'). A
//       global setting like branding: validated, persisted, shared across sports, and reported by
//       /api/settings and /api/status. The server itself never changes a side because of it.
//   [2] the name sizes the board is painted with, per PANEL side, in /api/status (board.fontsize).
//       The console preview used a fixed size, so a long name ran into the set score there while
//       the board — which shrinks it to fit — looked fine. The numbers come from the same mapper
//       call as the paint, so they are the operator's ceiling after the shrink.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Settings, GLOBAL_KEYS, PER_SPORT_KEYS } from '../src/settings.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

console.log('[1a] the setting itself')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-orient-'))
  const file = path.join(dir, 'settings.json')
  const s = new Settings(file)
  ok(s.values.orientation === 'behind', "defaults to 'behind'")
  ok(GLOBAL_KEYS.includes('orientation') && !PER_SPORT_KEYS.includes('orientation'), 'a global key, not a per-sport one')
  s.update({ orientation: 'front' })
  ok(s.values.orientation === 'front', "'front' is accepted")
  s.update({ orientation: 'sideways' })
  ok(s.values.orientation === 'front', 'an unknown value is dropped, the old one stands')
  ok(new Settings(file).values.orientation === 'front', 'persisted across a reload')
  ok(s.forSport('beach').orientation === 'front', 'the same for every sport')
  // A settings file written before the key existed.
  fs.writeFileSync(file, JSON.stringify({ brightness: 30, perSport: { volleyball: {} } }))
  ok(new Settings(file).values.orientation === 'behind', "an older file without it reads as 'behind'")
  fs.rmSync(dir, { recursive: true, force: true })
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-orient-app-'))
const mock = new MockLedbox()
const addr = await mock.listen(0, '127.0.0.1')
const app = await startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2,
  reconnectMs: 0, mock: false, controlPort: 0, debug: false,
})
const base = `http://127.0.0.1:${app.server.address().port}`
const post = async (route, body) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const json = await res.json().catch(() => null)
  await sleep(150)
  return json
}
const get = async (route) => (await fetch(base + route)).json()
try {
  await sleep(300)
  console.log('\n[1b] through the API')
  ok((await get('/api/settings')).orientation === 'behind', "GET /api/settings: 'behind'")
  ok((await get('/api/status')).orientation === 'behind', "GET /api/status: 'behind'")
  let r = await post('/api/settings', { orientation: 'front' })
  ok(r.orientation === 'front', "POST /api/settings {orientation:'front'} answers 'front'")
  ok((await get('/api/settings')).orientation === 'front' && (await get('/api/status')).orientation === 'front', 'and both reads follow')
  r = await post('/api/settings', { orientation: 42 })
  ok(r.orientation === 'front', 'a junk value leaves it alone')
  await post('/api/settings', { orientation: 'behind' })
  ok((await get('/api/status')).orientation === 'behind', "back to 'behind'")

  console.log('\n[2] the board\'s name sizes in /api/status')
  await post('/api/manual')
  await post('/api/settings', { matchFontMaxLeft: 30, matchFontMaxRight: 18 })
  await post('/api/action', { action: { type: 'team', side: 'left', name: 'Kantonsschule Wiedikon', short: 'KANTONSSCHULE WIEDIKON' } })
  await post('/api/action', { action: { type: 'team', side: 'right', name: 'Volero', short: 'VZH' } })
  await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  let st = await get('/api/status')
  const fs1 = st.board && st.board.fontsize
  ok(fs1 && Number.isFinite(fs1.left) && Number.isFinite(fs1.right), `board.fontsize is reported (${JSON.stringify(fs1)})`)
  ok(fs1.left < 30, `a long name is shrunk below its ceiling of 30 (${fs1.left})`)
  ok(fs1.right === 18, `a short name gets its full ceiling of 18 (${fs1.right})`)
  ok(Number(mock.fontsize('team1')) === fs1.left && Number(mock.fontsize('team2')) === fs1.right,
    `the same sizes the panel was painted with (${mock.fontsize('team1')}/${mock.fontsize('team2')})`)

  await post('/api/settings', { matchFontMaxRight: 12 })
  st = await get('/api/status')
  ok(st.board.fontsize.right === 12 && st.board.fontsize.left === fs1.left, `name size −: right follows at once (${st.board.fontsize.right}), left unchanged`)
  ok(Number(mock.fontsize('team2')) === 12, 'and the panel agrees')

  // Panel sides, not team sides: after a swap the long name is on the right.
  await post('/api/action', { action: { type: 'swap' } })
  st = await get('/api/status')
  ok(st.board.fontsize.right < 12 && st.board.fontsize.left === 30, `swap: panel right now holds the long name (shrunk), panel left the short one at 30 (${JSON.stringify(st.board.fontsize)})`)
  ok(Number(mock.fontsize('team1')) === st.board.fontsize.left && Number(mock.fontsize('team2')) === st.board.fontsize.right, 'still matching the panel after the swap')
  const board = await get('/api/board')
  ok(Number(board.screen.team1.fontsize) === st.board.fontsize.left, '/api/board carries the same fontsize for the mirror')
} finally {
  await app.close().catch(() => {})
  await mock.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} orientation-fontsize: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
