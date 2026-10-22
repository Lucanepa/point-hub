// STATE_DIR: everything the appliance writes goes under ONE directory, and by default that is the
// checkout, exactly as before.
//
// Why it exists: a board with a read-only root (an overlay root on the DIY build) loses every write
// outside its persistent data partition at the next power cut — the scorer PIN and settings, the
// match history, and the resume slot, whose whole job is to survive exactly that power cut. So the
// appliance's state has to be movable onto the data partition, and NOTHING it writes may be left
// behind on the root.
//
//   [1] config: STATE_DIR is read, trimmed, and unset means the checkout (the C0270's paths)
//   [2] every write site in src/ is accounted for — a new one fails here until someone decides
//       where its file lives (the same idea as control-auth-selftest's ROUTES table)
//   [3] a booted appliance with a state dir writes settings, history, the resume slot, its logs
//       and the crash marker there, consumes the sport-switch marker from there, and leaves the
//       checkout's own settings.json and data/ untouched
//   [4] a state dir that cannot be written (a data partition that did not mount) still boots and
//       scores, from memory, and says so at error level
//   [5] the headless bridge and the board watchdog follow the same setting
//
// Plain node, no framework; exits non-zero on any failure.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, stateRootOf, CODE_ROOT } from '../src/config.js'
import { startAppliance, checkStateDir } from '../src/appliance.js'
import { log as logStore } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-statedir-'))

// ── [1] ─────────────────────────────────────────────────────────────────────────────────────
console.log('[1] config')
ok(CODE_ROOT === root, `CODE_ROOT is the checkout (${CODE_ROOT})`)
ok(loadConfig({}).stateDir === '', 'STATE_DIR unset -> stateDir ""')
ok(stateRootOf(loadConfig({})) === root, 'and the state root is the checkout — the paths every board has always used')
ok(stateRootOf({}) === root && stateRootOf() === root && stateRootOf({ stateDir: '   ' }) === root, 'a hand-built config without one (or a blank one) means the checkout too')
ok(loadConfig({ STATE_DIR: ' /data/ledbox ' }).stateDir === '/data/ledbox', 'STATE_DIR=/data/ledbox is read (and trimmed)')
ok(stateRootOf(loadConfig({ STATE_DIR: '/data/ledbox' })) === '/data/ledbox', 'and becomes the state root')
ok(stateRootOf({ stateDir: 'rel/dir' }) === path.resolve('rel/dir'), 'a relative one resolves from the working directory (the checkout, under systemd)')

// ── [2] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[2] every write site in src/ is accounted for')
// module -> [expected number of fs write calls, where their paths come from]. A new write call
// changes the count and fails this check: decide whether its file is state (then it must hang off
// the state dir) and update the table.
const WRITES = {
  'appliance.js': [5, 'the crash marker data/.running, the .sport-switch marker it consumes, and checkStateDir — all under the state dir'],
  'settings.js': [3, 'settings.json in the state dir (appliance passes the path)'],
  'logStore.js': [6, 'data/logs/*.jsonl and its rotations (appliance/bridge configure the path)'],
  'historyStore.js': [3, 'data/history.json (controlServer, from dataDir)'],
  'resumeStore.js': [3, 'data/resume.json (controlServer, from dataDir)'],
  'seasonSchedule.js': [3, 'data/schedule.json (controlServer, from dataDir)'],
  'autoPrepare.js': [3, 'data/autoprepare.json (controlServer, from dataDir)'],
  'gameSheet.js': [4, 'data/gamesheet.json (controlServer, from dataDir)'],
  'hallLogin.js': [3, 'data/uplink.json (controlServer, from dataDir)'],
  'matchUpload.js': [3, 'data/match-uploads.json (appliance, from dataDir)'],
  // The two that are NOT appliance state: PANEL_OFF and setting.ini belong to the panel firmware and
  // are read by it (and by ledbox-watchdog.sh) at those fixed paths, so moving them would break it.
  'controlServer.js': [6, '.sport-switch beside settings.json; plus the FIRMWARE\'s own PANEL_OFF flag and setting.ini (fixed paths the firmware reads)'],
}
const WRITE_RE = /\bfs(?:\.promises)?\.(?:writeFileSync|appendFileSync|mkdirSync|renameSync|rmSync|unlinkSync|createWriteStream|copyFileSync|writeFile|appendFile|mkdir|rename|rm|unlink|copyFile|symlinkSync|truncateSync|openSync)\(/g
const found = {}
for (const f of fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  const n = (fs.readFileSync(path.join(root, 'src', f), 'utf8').match(WRITE_RE) || []).length
  if (n) found[f] = n
}
for (const [f, n] of Object.entries(found)) {
  const want = WRITES[f]
  ok(!!want && want[0] === n, want ? `${f}: ${n} write call(s) — ${want[1]}` : `${f}: ${n} write call(s) NOT CLASSIFIED — decide where its file lives, then add it to WRITES`)
}
for (const f of Object.keys(WRITES)) if (!found[f]) ok(false, `${f} is in WRITES but writes nothing any more — drop it`)
const cs = fs.readFileSync(path.join(root, 'src', 'controlServer.js'), 'utf8')
const stores = [...cs.matchAll(/file: path\.resolve\((\w+), '([\w.-]+)'\)/g)].map((m) => [m[1], m[2]])
ok(stores.length >= 6 && stores.every(([base]) => base === 'stateHome'), `every store controlServer builds sits in stateHome (${stores.map((s) => s[1]).join(', ')})`)
ok(/const stateHome = dataDir \? path\.resolve\(dataDir\)/.test(cs), 'and stateHome is the dataDir the appliance hands it')
ok(/fs\.writeFileSync\(path\.join\(path\.dirname\(settings\.file\), '\.sport-switch'\)/.test(cs), 'the sport-switch marker is written beside settings.json, where the next boot looks for it')

// ── [3] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[3] a booted appliance writes only under its state dir')
// The checkout's own state, before: a test must prove it never touched it.
const snapshot = () => {
  const out = {}
  const add = (p) => { try { const st = fs.statSync(p); out[path.relative(root, p)] = `${st.size}:${st.mtimeMs}` } catch {} }
  add(path.join(root, 'settings.json'))
  add(path.join(root, '.sport-switch'))
  const walk = (d) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else add(p) } }
  walk(path.join(root, 'data'))
  return JSON.stringify(out)
}
const before = snapshot()

const stateDir = path.join(scratch, 'data-partition', 'ledbox') // does not exist yet, like a fresh /data
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ sport: 'volleyball', scorerPin: '2468' }))
// As POST /api/sport leaves it just before the restart.
fs.writeFileSync(path.join(stateDir, '.sport-switch'), 'volleyball')
const boot = (dir, extra = {}) => startAppliance({
  stateDir: dir,
  relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
  mock: true, controlPort: 0, debug: false,
  uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9',
  ...extra,
})
const app = await boot(stateDir)
const base = `http://127.0.0.1:${app.server.address().port}`
const post = async (p, body, pin = '2468') => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Scorer-Pin': pin }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
try {
  await sleep(200)
  ok(!fs.existsSync(path.join(stateDir, '.sport-switch')), 'the sport-switch marker was read from the state dir and consumed')
  ok(fs.existsSync(path.join(stateDir, 'data', '.running')), 'the crash marker is armed in <state>/data/.running')
  const st = await (await fetch(base + '/api/status')).json()
  ok(st.pinRequired === true, 'the PIN in <state>/settings.json is the one in force')
  ok((await post('/api/settings', { clubName: 'STATE TEST' })).status === 200, 'a settings save')
  ok(JSON.parse(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8')).clubName === 'STATE TEST', 'lands in <state>/settings.json')
  await post('/api/game', { choice: 'new' })
  ok((await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })).status === 200, 'a scored point')
  await sleep(50)
  const resume = JSON.parse(fs.readFileSync(path.join(stateDir, 'data', 'resume.json'), 'utf8'))
  ok(resume && resume.games && resume.games.volleyball, 'lands in <state>/data/resume.json (the power-cut slot)')
  // The archive is written when a match is archived (or the log cleared), not per point.
  ok((await post('/api/history/clear', {})).status === 200 && fs.existsSync(path.join(stateDir, 'data', 'history.json')), 'the match archive is <state>/data/history.json')
  logStore.flush()
  ok(fs.existsSync(path.join(stateDir, 'data', 'logs', 'appliance.jsonl')), 'the log trail is <state>/data/logs/appliance.jsonl')
  const line = fs.readFileSync(path.join(stateDir, 'data', 'logs', 'appliance.jsonl'), 'utf8').split('\n').find((l) => l.includes('"starting"'))
  ok(!!line && line.includes(JSON.stringify(stateDir).slice(1, -1)), 'and its "starting" line names the state dir in use')
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  await app.close()
}
ok(!fs.existsSync(path.join(stateDir, 'data', '.running')), 'a clean stop disarms the crash marker in the state dir')
ok(snapshot() === before, "the checkout's own settings.json and data/ were not touched")

// ── [4] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[4] a state dir that cannot be written')
const missing = checkStateDir(path.join(scratch, 'fresh', 'nested'))
ok(missing.ok && fs.existsSync(path.join(scratch, 'fresh', 'nested')), 'a missing one is created (a fresh, empty data partition)')
if (process.getuid && process.getuid() === 0) {
  console.log('  ↷ skipped: running as root, which writes through any permission')
} else {
  const ro = path.join(scratch, 'readonly')
  fs.mkdirSync(ro)
  fs.chmodSync(ro, 0o555)
  const r = checkStateDir(ro)
  ok(!r.ok && /EACCES|EROFS|EPERM/.test(r.error), `an unwritable one is reported (${r.error})`)
  const seen = []
  const off = logStore.subscribe((e) => { if (e.level === 'error' && /not writable/.test(e.msg)) seen.push(e) })
  const roApp = await boot(ro)
  try {
    await sleep(200)
    ok(seen.length === 1 && /will NOT survive a restart/.test(seen[0].msg), 'the boot says so once, at error level')
    const roBase = `http://127.0.0.1:${roApp.server.address().port}`
    const r1 = await fetch(roBase + '/api/status')
    ok(r1.status === 200, 'and the board still answers')
    // No PIN could be loaded from an unreadable-for-writing dir that holds no settings: the board is
    // open in this hand-built (non-mandatory) config, so it scores from memory.
    const a = await fetch(roBase + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: { type: 'point', side: 'left', delta: 1 } }) })
    ok(a.status === 200, 'and still scores (from memory)')
  } finally {
    off()
    await roApp.close()
    fs.chmodSync(ro, 0o755)
  }
}

// ── [5] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[5] the headless bridge and the board watchdog follow it')
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8')
ok(/path\.resolve\(stateRootOf\(config\), 'data', 'logs', 'bridge\.jsonl'\)/.test(bridge), 'bridge.js logs to <state>/data/logs/bridge.jsonl')
const wd = fs.readFileSync(path.join(root, 'firmware', 'ledbox-watchdog.sh'), 'utf8')
ok(/BRIDGE_DIR=\/home\/pi\/ledbox-bridge\n/.test(wd) && /sed -n 's\/\^\[\[:space:\]\]\*STATE_DIR=/.test(wd), 'ledbox-watchdog.sh reads STATE_DIR from the bridge\'s .env')
ok(/'\) BRIDGE_STATE=\$BRIDGE_DIR ;;/.test(wd) && /BRIDGE_SETTINGS=\$BRIDGE_STATE\/settings\.json/.test(wd), 'and without one reads /home/pi/ledbox-bridge/settings.json, as before')

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — state-dir-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
