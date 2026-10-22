// Self-test for firmware/flushbuffer/flushbuffer.cc's own logic, off the board: the live control
// files, the power governor, start and exit. Needs g++ (skipped without it) and Linux.
//
// The real driver needs a Pi's GPIO, so it is compiled here against stand-ins for hzeller's
// led-matrix.h and stb_image.h (test/fixtures/flushbuffer-fake/): no panel, no PNG decoder, and
// every frame logged with the brightness its pixels were set at. What this can NOT show is the
// glass — hzeller's real SetBrightness, the GPIO timing, the panel itself. That part is checked at
// the board (firmware/flushbuffer/README.md); this pins everything around it:
//   - the driver file it writes is the one src/panelBrightness.js and the watchdog's live_driver
//     accept (pid + start time), in a directory anyone on the board can write, and a clean exit
//     takes it away again; a driver that fails to start never writes one;
//   - a console change through applyBrightness reaches the frames with no restart, 0 draws black
//     while the process stays up, a broken file is ignored, no file means the launch value;
//   - with a budget, no white frame is ever drawn brighter than the highest level whose estimate
//     fits — including the first white frame after a dark one — the level climbs back no faster
//     than rise_per_s, and the boot starts from black; the power file overrides the flags and
//     budget 0 switches the governor off.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyBrightness, liveDriver } from '../src/panelBrightness.js'
import { log } from '../src/logStore.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

if (process.platform !== 'linux') { console.log('skipped: needs Linux (/proc)'); process.exit(0) }
if (spawnSync('g++', ['--version']).status !== 0) { console.log('skipped: no g++ to build the driver with'); process.exit(0) }
log.configure?.({ console: false })

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-flushbuffer-'))
const W = 192, H = 64
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(30) } return pred() }

// hzeller's luminance_cie1931 with C's float roundings, and the 7 shown planes of pwm_bits=7.
const f32 = Math.fround
const cie = (c, b) => {
  const v = f32((c * b) / 255)
  const inner = v <= 8 ? v / 902.3 : Math.pow(f32(v + 16) / 116, 3)
  return Math.round(f32(2047 * inner))
}
const SHOWN = 2047 & ~15
const whiteMa = (fullWhite, b) => fullWhite * (cie(255, b) & SHOWN) / (cie(255, 100) & SHOWN)

const ppm = (rgb) => Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), Buffer.alloc(W * H * 3, Buffer.from(rgb))])
const showImage = (file, rgb) => { fs.writeFileSync(`${file}.tmp`, ppm(rgb)); fs.renameSync(`${file}.tmp`, file) }
const frames = (logFile) => {
  let text = ''
  try { text = fs.readFileSync(logFile, 'utf8') } catch { return [] }
  return text.trim().split('\n').filter(Boolean).map((l) => Object.fromEntries(l.split(' ').slice(1).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)])))
}
const procStart = (pid) => { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }

const bin = path.join(tmp, 'flushBuffer2')
const kids = []
const start = (name, args) => {
  const logFile = path.join(tmp, `${name}.frames`)
  const p = spawn(bin, args, { env: { ...process.env, FAKE_MATRIX_LOG: logFile }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  p.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((r) => p.on('exit', (code) => r(code)))
  kids.push(p)
  return { p, logFile, exited, stderr: () => stderr, frames: () => frames(logFile) }
}

try {
  console.log('▶ build against the stand-in matrix')
  fs.copyFileSync(path.join(repo, 'firmware', 'flushbuffer', 'flushbuffer.cc'), path.join(tmp, 'flushbuffer.cc'))
  const cc = spawnSync('g++', ['-std=c++11', '-O1', '-Wall', '-Wextra', '-Wno-unused-parameter',
    '-I', path.join(repo, 'test', 'fixtures', 'flushbuffer-fake'), '-o', bin, path.join(tmp, 'flushbuffer.cc'), '-lm'], { encoding: 'utf8' })
  ok(cc.status === 0, `flushbuffer.cc compiles (C++11)${cc.status ? `\n${cc.stderr}` : ''}`)
  if (cc.status !== 0) throw new Error('no binary')
  ok(!/warning:/.test(cc.stderr), `with no warnings${/warning:/.test(cc.stderr) ? `\n${cc.stderr}` : ''}`)

  const img = path.join(tmp, 'buffer.ppm')
  showImage(img, [255, 255, 255])

  console.log('▶ live brightness (governor off)')
  const ctl = path.join(tmp, 'ctl')
  const paths = { settingIni: path.join(tmp, 'setting.ini'), panelOffFlag: path.join(tmp, 'PANEL_OFF'), ctlDir: ctl }
  fs.writeFileSync(paths.settingIni, '[DISPLAY]\nbrightness=40\n')
  const calls = []
  const exec = (cmd, args, cb) => { calls.push([cmd, ...args]); if (cb) cb(null) }
  const a = start('a', [img, '--led-brightness=40', `--ctl-dir=${ctl}`])
  ok(await waitFor(() => fs.existsSync(path.join(ctl, 'driver'))), 'the driver file appears')
  ok((fs.statSync(ctl).mode & 0o7777) === 0o777, `control dir is 0777, no sticky bit (got ${(fs.statSync(ctl).mode & 0o7777).toString(8)})`)
  const drv = fs.readFileSync(path.join(ctl, 'driver'), 'utf8')
  ok(drv.includes(`\npid=${a.p.pid}\n`) && drv.includes(`\nstart=${procStart(a.p.pid)}\n`) && /\ncontrol=brightness power\n/.test(drv),
    'it names this process, its start time and what it reads')
  ok(liveDriver(ctl)?.pid === a.p.pid, 'panelBrightness.liveDriver accepts it')
  const watchdog = fs.readFileSync(path.join(repo, 'firmware', 'ledbox-watchdog.sh'), 'utf8')
  fs.writeFileSync(path.join(tmp, 'wd.sh'), watchdog.slice(0, watchdog.indexOf('\nsleep 90')).replaceAll('/run/ledbox-panel', ctl))
  const wd = (body) => execFileSync('bash', ['-c', `source ${JSON.stringify(path.join(tmp, 'wd.sh'))}\n${body}`], { encoding: 'utf8' }).trim()
  ok(wd('live_driver && echo yes || echo no') === 'yes', 'the watchdog\'s live_driver accepts it')
  ok(await waitFor(() => a.frames().some((f) => f.b === 40 && f.lit === W * H)), 'frames at the launch brightness 40')

  let r = applyBrightness(70, { paths, exec })
  ok(r === 'live' && calls.length === 0, `console 70 -> live, nothing restarted (got ${r})`)
  ok(await waitFor(() => a.frames().at(-1)?.b === 70), 'frames at 70 within the poll interval')
  ok(/^brightness=70$/m.test(fs.readFileSync(paths.settingIni, 'utf8')), 'setting.ini holds 70 for the next launch')
  r = applyBrightness(0, { paths, exec })
  ok(r === 'live' && calls.length === 0, `console 0 -> live (got ${r})`)
  ok(await waitFor(() => a.frames().at(-1)?.set === 0), 'frames go black')
  await sleep(300)
  ok(a.p.exitCode === null && a.frames().at(-1)?.set === 0, 'and stay black with the process still running')
  fs.writeFileSync(path.join(ctl, 'brightness'), 'abc\n')
  await sleep(400)
  ok(a.frames().at(-1)?.set === 0 && /ignoring .*brightness/.test(a.stderr()), 'a file that is not a number is ignored (and said so)')
  fs.writeFileSync(path.join(ctl, 'brightness'), '101\n')
  await sleep(300)
  ok(a.frames().at(-1)?.set === 0, '101 is ignored too')
  fs.rmSync(path.join(ctl, 'brightness'))
  ok(await waitFor(() => a.frames().at(-1)?.b === 40 && a.frames().at(-1)?.lit === W * H), 'no brightness file -> back to the launch value 40')
  ok(await waitFor(() => /requested=40 shown=40 cap=off budget_ma=0/.test(fs.readFileSync(path.join(ctl, 'status'), 'utf8'))),
    'the status file says what is on the glass')
  ok(a.frames().every((f) => f.mixed === 0), 'no frame was ever drawn at two brightnesses')
  a.p.kill('SIGTERM')
  ok(await a.exited === 0, 'SIGTERM -> clean exit')
  ok(!fs.existsSync(path.join(ctl, 'driver')) && !fs.existsSync(path.join(ctl, 'status')), 'a clean exit takes the driver and status files away')
  ok(liveDriver(ctl) === null && applyBrightness(55, { paths, exec }) === 'restart', 'after which the console goes back to restarting the driver')

  console.log('▶ start-up')
  fs.writeFileSync(path.join(ctl, 'brightness'), '0\n')
  const b = start('b', [img, '--led-brightness=40', `--ctl-dir=${ctl}`])
  await waitFor(() => b.frames().length >= 10)
  ok(b.frames().length >= 10 && b.frames().every((f) => f.set === 0), 'a brightness 0 left in the file holds from the very first frame')
  b.p.kill('SIGTERM'); await b.exited
  const c = start('c', [img, '--led-brightness=0', `--ctl-dir=${path.join(tmp, 'ctl-c')}`])
  ok(await c.exited !== 0 && !fs.existsSync(path.join(tmp, 'ctl-c', 'driver')), 'a driver that fails to start writes no driver file')
  const d = start('d', [img, '--led-brightness=30', '--ctl-dir='])
  ok(await waitFor(() => d.frames().some((f) => f.b === 30 && f.lit === W * H)) && /live control/.test(d.stderr()) === false,
    '--ctl-dir= with nothing after it: no live control, frames at the launch value')
  d.p.kill('SIGTERM'); await d.exited

  console.log('▶ power governor')
  const FULL = 24000
  // A budget halfway between the estimates at 45 and 46: white must settle at exactly 45.
  const CAP = 45
  const budget = Math.floor((whiteMa(FULL, CAP) + whiteMa(FULL, CAP + 1)) / 2)
  const ctlG = path.join(tmp, 'ctl-g')
  showImage(img, [255, 255, 255])
  const g = start('g', [img, '--led-brightness=100', `--ctl-dir=${ctlG}`, `--power-budget-ma=${budget}`,
    `--power-full-white-ma=${FULL}`, '--power-rise-per-s=200'])
  ok(await waitFor(() => g.frames().some((f) => f.b === CAP && f.lit === W * H)), `white at brightness 100 with a ${budget} mA budget settles at ${CAP}`)
  const boot = g.frames()
  ok(boot[0]?.set === 0, 'the boot starts from black (fade-in)')
  const litB = boot.filter((f) => f.lit).map((f) => f.b)
  ok(litB.length > 1 && litB.every((v, i) => i === 0 || v >= litB[i - 1]) && new Set(litB).size > 2, `and climbs in steps (${[...new Set(litB)].join(' ')})`)
  await sleep(300)
  ok(g.frames().filter((f) => f.lit).every((f) => f.b <= CAP), `no white frame above ${CAP}`)
  ok(await waitFor(() => /cap=45 /.test(fs.readFileSync(path.join(ctlG, 'status'), 'utf8')) && /limited_frames=[1-9]/.test(fs.readFileSync(path.join(ctlG, 'status'), 'utf8'))),
    'status shows the cap and the limited frames')

  const mark = g.frames().length
  showImage(img, [0, 0, 0])
  ok(await waitFor(() => g.frames().at(-1)?.b === 100), 'a black frame fits at any level: back up to the requested 100')
  const climb = g.frames().slice(mark).filter((f) => f.set && !f.lit).map((f) => f.b)
  ok(new Set(climb.filter((v) => v > CAP && v < 100)).size >= 3, `but no faster than rise_per_s (${[...new Set(climb)].join(' ')})`)
  const mark2 = g.frames().length
  showImage(img, [255, 255, 255])
  ok(await waitFor(() => g.frames().slice(mark2).some((f) => f.lit)), 'white again')
  const firstWhite = g.frames().slice(mark2).find((f) => f.lit)
  ok(firstWhite && firstWhite.b <= CAP, `the FIRST white frame after the dark ones is already capped (b=${firstWhite?.b})`)
  ok(g.frames().filter((f) => f.lit).every((f) => f.b <= CAP), `still no white frame above ${CAP}, ever`)

  fs.writeFileSync(path.join(ctlG, 'power'), 'budget_ma=0\n')
  ok(await waitFor(() => g.frames().at(-1)?.b === 100 && g.frames().at(-1)?.lit), 'power file budget_ma=0 -> governor off, white at 100')
  fs.writeFileSync(path.join(ctlG, 'power'), `# calibrated\nbudget_ma = ${budget}\nfull_white_ma=${FULL}\nbogus line\n`)
  ok(await waitFor(() => g.frames().at(-1)?.b === CAP), 'power file with the budget again -> capped at once')
  ok(/power: ignoring line "bogus line"/.test(g.stderr()), 'a line that does not parse is skipped, the rest applies')
  fs.writeFileSync(path.join(ctlG, 'power'), `budget_ma=${budget}\nfull_white_ma=${FULL}\nred_ma=0\ngreen_ma=0\nblue_ma=0\n`)
  ok(await waitFor(() => g.frames().at(-1)?.b === 100), 'per-channel keys override full_white_ma (all 0 -> nothing to cap)')
  fs.rmSync(path.join(ctlG, 'power'))
  ok(await waitFor(() => g.frames().at(-1)?.b === CAP), 'no power file -> back to the --power-* flags')
  ok(g.frames().every((f) => f.mixed === 0), 'no frame was ever drawn at two brightnesses')
  g.p.kill('SIGTERM'); await g.exited
} finally {
  for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌' : '✅'} flushbuffer: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
