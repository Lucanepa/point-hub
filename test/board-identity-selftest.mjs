// Board identity and capabilities in /api/status (gap-07).
//
// Every board answers at 172.24.1.1 on its own Wi-Fi and 192.168.5.1 on the cable, so the address a
// tablet reached says nothing about WHICH board it is. /api/status.board now says: a stable id
// (settings `boardId`, else the hostname), a label, and caps { sports, panel, renderer }.
//
//   [1] the id from a hostname, the panel size from setting.ini, the renderer from the Init reply
//   [2] the settings: boardId is read from disk and never patched through the API; boardLabel is
//   [3] a running board: the new fields, beside every field /api/status already had (nothing
//       renamed or removed — board.fontsize included); two boards tell themselves apart; the
//       vendor firmware and openscore are told apart from their own Init reply
//
// Plain node, no framework; exits non-zero on any failure.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { idFromHostname, readPanelGeometry, rendererOf, boardIdentity, BOARD_ID_RE } from '../src/boardIdentity.js'
import { Settings } from '../src/settings.js'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-identity-'))

// ── [1] ─────────────────────────────────────────────────────────────────────────────────────
console.log('[1] the pieces')
for (const [h, want] of [['ledbox-c0270', 'ledbox-c0270'], ['LEDBOX-C0270.local', 'ledbox-c0270'], ['raspberrypi', 'raspberrypi'],
  ['kscw_court_2', 'kscw-court-2'], ['-odd-', 'odd'], ['', 'ledbox'], [null, 'ledbox'], ['___', 'ledbox'], ['x'.repeat(80), 'x'.repeat(63)]]) {
  ok(idFromHostname(h) === want, `hostname ${JSON.stringify(h && h.length > 20 ? h.slice(0, 8) + '…' : h)} -> id "${want.length > 20 ? want.slice(0, 8) + '…' : want}"`)
}
ok(BOARD_ID_RE.test('kscw-1') && !BOARD_ID_RE.test('Court 1') && !BOARD_ID_RE.test('-x') && !BOARD_ID_RE.test(''), 'an id is lower-case letters, digits and hyphens')
const vendorIni = path.join(root, 'firmware', 'setting.ini.example')
const osIni = path.join(root, 'firmware', 'openscore', 'setting.ini')
ok(JSON.stringify(readPanelGeometry(vendorIni)) === '{"width":192,"height":64}', "the C0270's setting.ini [DISPLAY]: 192x64")
ok(JSON.stringify(readPanelGeometry(osIni)) === '{"width":192,"height":64}', "openscore's setting.ini: 192x64")
const ini = (name, text) => { const f = path.join(scratch, name); fs.writeFileSync(f, text); return f }
ok(JSON.stringify(readPanelGeometry(ini('diy.ini', '[WIFI]\nwidth=1\n[DISPLAY]\n; P5 build\nwidth = 384 # six modules\nheight=64\n'))) === '{"width":384,"height":64}', 'another panel: only [DISPLAY] counts, comments and spaces are fine')
ok(readPanelGeometry(path.join(scratch, 'none.ini')) === null, 'no file: null (the caller says "default")')
ok(readPanelGeometry(ini('half.ini', '[DISPLAY]\nwidth=192\n')) === null && readPanelGeometry(ini('junk.ini', '[DISPLAY]\nwidth=0\nheight=99999\n')) === null, 'half a size, or an insane one: null')
ok(JSON.stringify(rendererOf({ deviceName: 'LedBox', version: '0.552' })) === '{"kind":"vendor","version":"0.552","device":"LedBox"}', 'the vendor firmware (0.552)')
ok(rendererOf({ deviceName: 'OpenScore', version: 'openscore-1.0.0' }).kind === 'openscore', 'openscore names itself in its version')
ok(rendererOf(null).kind === null && rendererOf({}).kind === null, 'no Init reply yet: kind null')
const id1 = boardIdentity({ hostname: 'ledbox-c0270', sports: ['volleyball'], panel: { width: 192, height: 64 } })
ok(id1.id === 'ledbox-c0270' && id1.idSource === 'hostname' && id1.label === 'ledbox-c0270', 'no boardId: the hostname, and the label falls back to it')
ok(JSON.stringify(id1.caps.panel) === '{"width":192,"height":64,"source":"setting.ini"}' && id1.caps.renderer.kind === null, 'caps: the panel from setting.ini; the renderer unknown until a handshake')
const id2 = boardIdentity({ boardId: 'KSCW-2', boardLabel: 'Court 2', hostname: 'raspberrypi' })
ok(id2.id === 'kscw-2' && id2.idSource === 'settings' && id2.label === 'Court 2', 'a boardId wins (lower-cased), with its label')
ok(boardIdentity({ boardId: 'not valid!', hostname: 'h1' }).id === 'h1', 'a malformed boardId falls back to the hostname')
ok(JSON.stringify(boardIdentity({}).caps.panel) === '{"width":192,"height":64,"source":"default"}', 'no setting.ini: 192x64, marked "default"')

// ── [2] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[2] the settings')
const f = path.join(scratch, 'settings.json')
fs.writeFileSync(f, JSON.stringify({ boardId: 'KSCW-1', boardLabel: 'Court 1', scorerPin: '1234' }))
const s = new Settings(f)
ok(s.values.boardId === 'kscw-1' && s.values.boardLabel === 'Court 1', 'boardId and boardLabel are read from settings.json')
s.update({ boardId: 'renamed', boardLabel: 'Court Ü 1 extra long label for the hall' })
ok(s.values.boardId === 'kscw-1', 'a patch can NEVER change boardId — tablets pair against it')
ok(s.values.boardLabel === 'Court  1 extra long labe', `boardLabel is patchable, printable and capped at 24 (${JSON.stringify(s.values.boardLabel)})`)
ok(JSON.parse(fs.readFileSync(f, 'utf8')).boardId === 'kscw-1', 'and the id on disk is untouched by the save')
ok(new Settings(path.join(scratch, 'fresh.json')).values.boardId === '', 'a fresh board: no boardId (the hostname is used)')

// ── [3] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[3] a running board')
// Every top-level field /api/status had before this change, and board.fontsize's shape. A field
// removed or renamed fails here — the apps in the field read them.
const BEFORE = ['mode', 'matchId', 'sport', 'prematch', 'prematchGameId', 'gameId', 'orientation', 'pinRequired', 'build', 'httpsOrigin',
  'clock', 'uplink', 'ledbox', 'board', 'state', 'canUndo', 'undoLabel', 'log']
const apps = [], mocks = []
async function board(name, { hostname, settings = {}, firmware } = {}) {
  const stateDir = path.join(scratch, name)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ sport: 'volleyball', ...settings }))
  const mock = new MockLedbox({ deviceName: name.toUpperCase(), ...(firmware ? { firmware } : {}) })
  const addr = await mock.listen(0, '127.0.0.1')
  mocks.push(mock)
  const app = await startAppliance({
    stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
    ledboxHost: '127.0.0.1', ledboxPort: addr.port, ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
    mock: false, controlPort: 0, debug: false,
    uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
    hostname, settingIni: vendorIni,
  })
  apps.push(app)
  const base = `http://127.0.0.1:${app.server.address().port}`
  for (let i = 0; i < 40 && !(await (await fetch(base + '/api/status')).json()).ledbox.connected; i++) await sleep(50)
  return base
}
try {
  const a = await board('court1', { hostname: 'ledbox-c0270' })
  const st = await (await fetch(a + '/api/status')).json()
  ok(BEFORE.every((k) => k in st), `every field /api/status already had is still there (${BEFORE.length})`)
  ok(st.board && st.board.fontsize && 'left' in st.board.fontsize && 'right' in st.board.fontsize, 'board.fontsize is where it was, as { left, right }')
  ok(st.board.id === 'ledbox-c0270' && st.board.idSource === 'hostname' && st.board.label === 'ledbox-c0270', `board.id from the hostname: ${st.board.id}`)
  ok(JSON.stringify(st.board.caps.sports) === JSON.stringify(['volleyball', 'beach', 'basketball', 'simple']), `caps.sports: ${st.board.caps.sports.join(', ')}`)
  ok(st.board.caps.panel.width === 192 && st.board.caps.panel.height === 64 && st.board.caps.panel.source === 'setting.ini', 'caps.panel: 192x64 from setting.ini')
  ok(st.board.caps.renderer.kind === 'vendor' && st.board.caps.renderer.version === '0.551' && st.board.caps.renderer.device === 'COURT1', 'caps.renderer: the vendor firmware, from its Init reply')
  const post = (body) => fetch(a + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await post({ boardId: 'hijacked', boardLabel: 'Court 1' })
  const st2 = await (await fetch(a + '/api/status')).json()
  ok(st2.board.id === 'ledbox-c0270' && st2.board.label === 'Court 1', 'POST /api/settings sets the label but cannot touch the id')

  const b = await board('court2', { hostname: 'raspberrypi', settings: { boardId: 'kscw-2', boardLabel: 'Court 2' }, firmware: 'openscore-1.0.0' })
  const sb = await (await fetch(b + '/api/status')).json()
  ok(sb.board.id === 'kscw-2' && sb.board.idSource === 'settings' && sb.board.label === 'Court 2', 'a second board, set up on disk: id kscw-2, "Court 2"')
  ok(sb.board.id !== st.board.id, 'the two boards tell themselves apart — which the address a tablet reached never could')
  ok(sb.board.caps.renderer.kind === 'openscore' && sb.board.caps.renderer.version === 'openscore-1.0.0', 'and this one runs openscore, by its own Init reply')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  for (const app of apps) await app.close()
  for (const m of mocks) await m.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — board-identity-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
