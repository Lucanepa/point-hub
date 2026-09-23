// Self-test for controlServer's PANEL_RESTART (the brightness change's driver bounce), run against
// the watchdog's own start_panel (zero deps; needs bash, flock, pgrep — i.e. Linux).
//
// Both starters share /home/pi/ledbox/panel.lock, and the brightness path used to take it too
// late and let go of it too early: the SIGTERM went out BEFORE the lock (so the watchdog could see
// "no driver" in the gap and start one at the old brightness), and the lock was released the
// moment startled was launched — before startled had exec'd flushBuffer2 — so a watchdog check in
// that window started a second driver beside it. This pins, with a driver that takes ~1s to die
// on SIGTERM and a startled that takes ~0.8s to exec it:
//   - a restart racing the watchdog's start_panel never has two drivers alive at once, and ends
//     with exactly one — a NEW one (the brightness only applies at launch);
//   - the restart returns only once that driver exists, and the lock is free afterwards (the
//     launched driver did not inherit it — `flock -o`);
//   - a driver that will not exit is left alone: no second driver is started beside it.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

if (process.platform !== 'linux') { console.log('skipped: needs Linux (flock, pgrep, /proc)'); process.exit(0) }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = fs.readFileSync(path.join(repo, 'src', 'controlServer.js'), 'utf8')
const watchdog = fs.readFileSync(path.join(repo, 'firmware', 'ledbox-watchdog.sh'), 'utf8')

// PANEL_START / PANEL_RESTART are module-private string constants; evaluate just those two.
const from = server.indexOf('const PANEL_START =')
const to = server.indexOf('function applyBrightness')
if (from < 0 || to < 0) { console.log('  ❌ could not find PANEL_START / PANEL_RESTART in controlServer.js'); process.exit(1) }
// eslint-disable-next-line no-new-func
const PANEL_RESTART = new Function(`${server.slice(from, to)}; return PANEL_RESTART`)()

console.log('▶ PANEL_RESTART shape')
ok(/^flock -o /.test(PANEL_RESTART), 'the whole restart runs under `flock -o` (the driver never inherits the lock)')
ok(PANEL_RESTART.indexOf('pkill') > PANEL_RESTART.indexOf('flock'), 'the SIGTERM is sent INSIDE the lock')
ok(/startled[\s\S]*pgrep -x flushBuffer2[^;]*&& exit 0/.test(PANEL_RESTART), 'the lock is held until the new driver shows up')
ok(PANEL_RESTART.includes('systemd-run') && PANEL_RESTART.includes('./startled'), 'systemd-run launch kept, with its in-cgroup fallback')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-panel-restart-'))
const DRIVER = `fb2r${process.pid}`.slice(0, 15) // unique: never touch a real driver or another run's
const sub = (s) => s
  .replaceAll('/home/pi/ledbox-bridge', path.join(tmp, 'bridge'))
  .replaceAll('/home/pi/ledbox', path.join(tmp, 'ledbox'))
  .replaceAll('flushBuffer2', DRIVER)
const cut = watchdog.indexOf('\nsleep 90')
const lib = sub(watchdog.slice(0, cut)).replace(/^log\(\) \{.*$/m, 'log() { echo "LOG: $1"; }')
fs.mkdirSync(path.join(tmp, 'ledbox', 'bin'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'bridge'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'path'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'lib.sh'), lib)
fs.writeFileSync(path.join(tmp, 'restart.sh'), sub(PANEL_RESTART))
// sudo stand-in: no systemd here, so systemd-run "is refused" and the fallback launch runs —
// the path that shares the lock fd with its children, i.e. the one `-o` matters for.
fs.writeFileSync(path.join(tmp, 'path', 'sudo'), '#!/bin/bash\n[ "$1" = -n ] && shift\n[ "$1" = systemd-run ] && exit 1\nexec "$@"\n', { mode: 0o755 })
// The watchdog calls systemd-run directly (it runs as root), so refuse that too: this test must
// never reach the real systemd, and the fallback is the launch path under test.
fs.writeFileSync(path.join(tmp, 'path', 'systemd-run'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
fs.writeFileSync(path.join(tmp, 'ledbox', 'bin', 'startled'), `#!/bin/bash\nsleep 0.8\nexec ./${DRIVER}\n`, { mode: 0o755 })
// Slow to die, like the real one releasing the GPIO. STUBBORN makes it ignore SIGTERM entirely.
fs.writeFileSync(path.join(tmp, 'ledbox', 'bin', DRIVER),
  `#!/bin/bash\nif [ -f ${JSON.stringify(path.join(tmp, 'STUBBORN'))} ]; then trap '' TERM; else trap 'sleep 1; exit 0' TERM; fi\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 })

const env = { ...process.env, PATH: `${path.join(tmp, 'path')}:${process.env.PATH}` }
const pids = () => { try { return execFileSync('pgrep', ['-x', DRIVER], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return [] } }
const killDrivers = () => { try { execFileSync('pkill', ['-KILL', '-x', DRIVER]) } catch { /* none */ } }
const lockFree = () => execFileSync('bash', ['-c', `flock -n ${JSON.stringify(path.join(tmp, 'ledbox', 'panel.lock'))} true && echo free || echo held`], { encoding: 'utf8' }).trim() === 'free'
const startDriver = () => {
  spawn('bash', ['-c', `cd ${JSON.stringify(path.join(tmp, 'ledbox', 'bin'))} && exec ./${DRIVER}`], { stdio: 'ignore', detached: true }).unref()
}
const waitFor = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)) } return pred() }
// Run a bash body to completion while sampling the driver count; resolves { code, max }.
const run = (body) => new Promise((resolve) => {
  let max = 0
  const timer = setInterval(() => { max = Math.max(max, pids().length) }, 40)
  const p = spawn('bash', ['-c', body], { env, stdio: 'ignore' })
  const kill = setTimeout(() => p.kill('SIGKILL'), 40000)
  p.on('exit', (code) => { clearInterval(timer); clearTimeout(kill); resolve({ code, max }) })
})

try {
  console.log('▶ restart vs the watchdog\'s start_panel')
  startDriver()
  ok(await waitFor(() => pids().length === 1), 'a driver is running before the restart')
  const old = pids()[0]
  const restart = `bash ${JSON.stringify(path.join(tmp, 'restart.sh'))} >/dev/null 2>&1`
  // The watchdog fires while the old driver is still dying — the window the pre-lock kill left open.
  const r = await run(`${restart} & sleep 0.3; source ${JSON.stringify(path.join(tmp, 'lib.sh'))}; start_panel >/dev/null 2>&1 & wait`)
  const after = pids()
  ok(r.max <= 1, `never two drivers at once (saw ${r.max})`)
  ok(after.length === 1, `exactly one driver afterwards (got ${after.length})`)
  ok(after.length === 1 && after[0] !== old, 'and it is a NEW driver, started at the new brightness')
  ok(lockFree(), 'panel.lock is free while the new driver runs')

  console.log('▶ restart returns only once the driver is up')
  const r2 = await run(restart)
  ok(r2.code === 0 && pids().length === 1, `restart exit ${r2.code} with the driver running`)
  ok(r2.max <= 1, `still never two drivers at once (saw ${r2.max})`)

  console.log('▶ a driver that will not exit')
  killDrivers()
  fs.writeFileSync(path.join(tmp, 'STUBBORN'), '')
  startDriver()
  await waitFor(() => pids().length === 1)
  const stuck = pids()[0]
  const r3 = await run(restart)
  ok(r3.code === 4, `restart gives up with exit 4 (got ${r3.code})`)
  ok(pids().length === 1 && pids()[0] === stuck && r3.max <= 1, 'and starts no second driver beside it')
} finally {
  killDrivers()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
