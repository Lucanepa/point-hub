// Pictures of SATZBALL / MATCHBALL and the substitution notice as the Point Hub board draws them:
// the REAL bridge client (src/ledboxClient.js) driving the REAL openscore (firmware/openscore,
// the board's own setting.ini with its 96-row canvas: front + the two bench modules), every frame
// read back from openscore's buffer.png and laid out as the hall sees it: bench L, the front, bench
// R, the benches turned upright. Neutral team names only.
//
//   node tools/render-board-notices.mjs [out-dir]      (default docs/img/board-notices)
//
// Needs python3 with Pillow (as openscore itself). No board, no network.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { LedboxClient } from '../src/ledboxClient.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.resolve(process.argv[2] || path.join(REPO, 'docs', 'img', 'board-notices'))
const OS = path.join(REPO, 'firmware', 'openscore')

// openscore's tree as setup-board.sh lays it out on the board: its own layouts, then ours.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'openscore-notices-'))
for (const d of ['layout', 'fonts', 'media']) fs.cpSync(path.join(OS, d), path.join(base, d), { recursive: true })
for (const f of fs.readdirSync(path.join(REPO, 'layouts'))) {
  if (/_kscw_.*\.xml$/.test(f)) fs.copyFileSync(path.join(REPO, 'layouts', f), path.join(base, 'layout', f))
}
fs.writeFileSync(path.join(base, 'setting.ini'), fs.readFileSync(path.join(OS, 'setting-point-hub.ini'), 'utf8').replace(/^cmd=.*$/m, 'cmd='))
fs.mkdirSync(OUT, { recursive: true })

const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const fw = spawn('python3', [path.join(OS, 'openscore.py'), '--base-dir', base, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
let fwErr = ''
fw.stderr.on('data', (b) => { fwErr += b })
for (let i = 0; i < 50; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true) }); s.on('error', () => r(false)) })) break; await sleep(100) }

// calloutMs 0: no ticker, the word stays up (its turn); the name turn is asked for by hand.
const client = new LedboxClient({ hosts: ['127.0.0.1'], port, reconnectMs: 0, layoutGuardMs: 0, idleTickMs: 0, calloutMs: 0, gamePointCallout: true, language: 'de', brightness: 40 })
client.on('error', () => {})
const ready = new Promise((r) => client.once('ready', r))
client.connect()
await ready
await sleep(150)

const BUFFER = path.join(base, 'www', 'buffer.png')
const frames = []
const shot = async (name, title) => {
  await sleep(250)
  const raw = path.join(base, `${name}.raw.png`)
  fs.copyFileSync(BUFFER, raw)
  frames.push({ name, title, raw })
}
const st = (o) => ({
  team_a_short: 'HEIM', team_a_name: 'Heim', team_a_color: '#2563eb',
  team_b_short: 'GAST', team_b_name: 'Gast', team_b_color: '#ef4444',
  side_a: 'left', serving_team: 'left', timeouts_a: 1, timeouts_b: 0, subs_a: 2, subs_b: 3,
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, sets_to_win: 3, ...o,
})

try {
  await client.pushState(st({ points_a: 24, points_b: 23, sets_won_a: 1, sets_won_b: 0 }))
  await shot('01_satzball_word', 'SATZBALL: 24:23, the word\'s turn (front name slot + both benches)')
  client._calloutShown = false
  await client.pushState(st({ points_a: 24, points_b: 23, sets_won_a: 1, sets_won_b: 0 }))
  await shot('02_satzball_name', 'SATZBALL: the name\'s turn (1.5 s each)')
  client._calloutShown = true
  await client.pushState(st({ points_a: 13, points_b: 14, sets_won_a: 2, sets_won_b: 2, serving_team: 'right' }))
  await shot('03_matchball_deciding', 'MATCHBALL: deciding set 13:14, right team')
  client.setLimits({ language: 'en' })
  await client.pushState(st({ points_a: 24, points_b: 23, sets_won_a: 2, sets_won_b: 0 }))
  await shot('04_match_point_en', 'MATCH POINT: English, 2:0 up at 24:23')
  client.setLimits({ language: 'de' })
  await client.pushState(st({ points_a: 12, points_b: 9 }))
  const msg = client.showMessage('', { ms: 900, lines: ['WECHSEL', '12 ⇄ 7'], color: '37,99,235' })
  await shot('05_wechsel_numbers', 'Substitution with the shirt numbers (LAN relay, or the match PIN)')
  await msg
  const msg2 = client.showMessage('', { ms: 900, lines: ['WECHSEL', 'GAST'], color: '239,68,68' })
  await shot('06_wechsel_team', 'Substitution without numbers (OpenVolley cloud, no PIN): the team')
  await msg2
} finally {
  client.disconnect()
  await sleep(100)
  fw.kill()
}

// The hall's view: bench L | front | bench R, each bench turned back upright (the canvas holds them
// a quarter turn round, setting.ini bench_*_rotate=270), 4x, with a dark frame between the modules.
const py = `
import json, sys
from PIL import Image, ImageDraw
frames = json.loads(sys.argv[1]); out = sys.argv[2]
S = 4
for f in frames:
    im = Image.open(f["raw"]).convert("RGB")
    front = im.crop((0, 0, 192, 64))
    bl = im.crop((128, 64, 192, 96)).rotate(90, expand=True)
    br = im.crop((64, 64, 128, 96)).rotate(90, expand=True)
    gap = 6
    W = 32 + gap + 192 + gap + 32
    canvas = Image.new("RGB", (W, 64), (24, 24, 24))
    canvas.paste(bl, (0, 0)); canvas.paste(front, (32 + gap, 0)); canvas.paste(br, (32 + gap + 192 + gap, 0))
    big = canvas.resize((W * S, 64 * S), Image.NEAREST)
    title_h = 28
    sheet = Image.new("RGB", (big.width, big.height + title_h), (24, 24, 24))
    sheet.paste(big, (0, title_h))
    ImageDraw.Draw(sheet).text((8, 8), "bench L  |  front  |  bench R  :   " + f["title"], fill=(200, 200, 200))
    sheet.save(f"{out}/{f['name']}.png")
    print(f"{out}/{f['name']}.png")
`
const r = spawnSync('python3', ['-c', py, JSON.stringify(frames), OUT], { encoding: 'utf8' })
process.stdout.write(r.stdout || '')
if (r.status !== 0) { process.stderr.write(r.stderr || fwErr); process.exitCode = 1 }
fs.rmSync(base, { recursive: true, force: true })
