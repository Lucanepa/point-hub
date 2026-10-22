#!/usr/bin/env node
// Record what the bridge says to the panel firmware — and what the panel then shows — during a
// rehearsal on the real board, so openscore can later be checked against real traffic instead of
// "judged equivalent side by side" (firmware/openscore/ROADMAP.md, Phase 2; research render-02).
//
// A tee proxy: the bridge connects here instead of to the vendor app on :8889; every byte is
// forwarded unchanged both ways, and a copy goes through src/ledboxProtocol.js's StreamDecoder (one
// per connection and direction, as that file insists) into stream.ndjson. When the bridge's writes
// have SETTLED (no display command for --settle ms; the vendor repaints at ~1 Hz, so 2 s), the
// vendor's frame — www/buffer.png, in RAM via ledbox-buffer-tmpfs — is copied to frames/ as the
// reference. A countdown never settles (a write every second), so --every also takes one mid-way.
// Identical frames are not stored twice.
//
// THE WIFI QR IS A SECRET (firmware/openscore/goldentest.py: it encodes the AP passphrase). Frames
// are therefore masked here, before anything is written: every image section of the current layout
// whose src or name says "wifi" (kscw_crest's and the vendor waiting screen's wifiqr, 48x48) is
// painted black, using the board's own layout XML for the geometry. Before the first SetLayout the
// layout is unknown, so the union of all of them is masked. A layout that looks like a QR screen but
// has no XML here is skipped rather than guessed at. Still: look at frames before committing any.
//
// stream.ndjson, one JSON object per line:
//   {"seq":12,"t":1534,"conn":1,"dir":"to_board","msg":{"cmd":"SetSections","value":[...]}}
//   {"seq":13,"t":1561,"conn":1,"dir":"from_board","msg":{"status":"ok","sender":"SetSections",...}}
//   {"seq":1,"t":0,"conn":1,"event":"open","from":"127.0.0.1:41234"}       (and "close")
// frames.ndjson: {"n":3,"file":"frames/0003.png","t":..,"afterSeq":12,"layout":"...","settled":true,
//   "masked":1,"sha256":".."} — afterSeq is the last message the frame can reflect, so a replay of
// stream.ndjson up to that seq into openscore (--port 18889, its own base dir) should paint it.
// --raw also keeps the exact bytes per connection and direction (raw/<conn>-to_board.bin, ...).
//
// ON THE BOARD (from the bridge install, which has src/ next to tools/):
//   1. start it, detached from the SSH session (if the session drops, a foreground copy dies and
//      the bridge loses the panel):
//        sudo systemd-run --unit=ledbox-record --uid=pi --gid=pi -p WorkingDirectory=/home/pi/ledbox-bridge \
//          /opt/nodejs/bin/node tools/record-board-traffic.mjs --minutes 30
//        ss -ltn | grep 18899                      # expect: LISTEN 127.0.0.1:18899
//   2. point the bridge at it — a RUNTIME drop-in (lives in /run, so a reboot undoes it too). An
//      EnvironmentFile, not Environment=: the unit's own .env is an EnvironmentFile, and those win
//      over Environment=; a later EnvironmentFile wins over an earlier one.
//        printf 'LEDBOX_HOST=127.0.0.1\nLEDBOX_PORT=18899\n' | sudo tee /run/ledbox-record.env
//        sudo mkdir -p /run/systemd/system/ledbox-bridge.service.d
//        printf '[Service]\nEnvironmentFile=/run/ledbox-record.env\n' | sudo tee /run/systemd/system/ledbox-bridge.service.d/record.conf
//        sudo systemctl daemon-reload && sudo systemctl restart ledbox-bridge
//        journalctl -u ledbox-record -f          # expect "open conn 1" within ~10 s, then frames
//   3. UNDO — bridge back to :8889 FIRST, then stop the recorder (the other order leaves the bridge
//      talking to a closed port until the undo):
//        sudo rm /run/systemd/system/ledbox-bridge.service.d/record.conf /run/ledbox-record.env
//        sudo systemctl daemon-reload && sudo systemctl restart ledbox-bridge
//        sudo systemctl stop ledbox-record
//   After --minutes the recording stops but forwarding carries on, so a forgotten undo never cuts
//   the panel off. Output: /home/pi/ledbox-record/<stamp>/ — copy it off with scp -r.
//
// Zero dependencies (Node >= 22, like the bridge). The PNG work is a minimal 8-bit, non-interlaced
// codec — enough for what PIL writes for a 192x64 frame.

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { StreamDecoder } from '../src/ledboxProtocol.js'

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let crcTable = null
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// A file the vendor is half-way through rewriting has no IEND yet.
export function isCompletePng(buf) {
  return buf.length > 20 && buf.subarray(0, 8).equals(SIG) && buf.subarray(-8, -4).toString('latin1') === 'IEND'
}

// -> { width, height, channels (3 = RGB, 4 = RGBA), data }. Grey and palette images come out RGB.
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')
  let at = 8, ihdr = null, plte = null, end = false
  const idat = []
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    if (at + 12 + len > buf.length) break
    const d = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') ihdr = { width: d.readUInt32BE(0), height: d.readUInt32BE(4), depth: d[8], color: d[9], interlace: d[12] }
    else if (type === 'PLTE') plte = d
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') { end = true; break }
    at += 12 + len
  }
  if (!ihdr || !end) throw new Error('truncated PNG')
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color]
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || !bpp || (ihdr.color === 3 && !plte)) {
    throw new Error(`unsupported PNG (depth ${ihdr.depth}, colour type ${ihdr.color}, interlace ${ihdr.interlace})`)
  }
  const { width: w, height: h } = ihdr
  const stride = w * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  if (raw.length < (stride + 1) * h) throw new Error('short PNG image data')
  const px = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = px.subarray(y * stride, (y + 1) * stride)
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      let v = src[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) v += paeth(a, b, c)
      else if (f !== 0) throw new Error(`bad PNG filter ${f}`)
      row[i] = v & 255
    }
  }
  const alpha = ihdr.color === 4 || ihdr.color === 6
  const ch = alpha ? 4 : 3
  if (ihdr.color === 2 || ihdr.color === 6) return { width: w, height: h, channels: ch, data: px }
  const out = Buffer.alloc(w * h * ch)
  for (let p = 0; p < w * h; p++) {
    let r, g, bl, al = 255
    if (ihdr.color === 3) { const k = px[p] * 3; r = plte[k]; g = plte[k + 1]; bl = plte[k + 2] }
    else { r = g = bl = px[p * bpp]; if (alpha) al = px[p * bpp + 1] }
    out[p * ch] = r; out[p * ch + 1] = g; out[p * ch + 2] = bl
    if (alpha) out[p * ch + 3] = al
  }
  return { width: w, height: h, channels: ch, data: out }
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// `filter` (0-4) for every row: 0 is all a frame needs; the others exist so the test can feed the
// decoder every filter type a real encoder (PIL's adaptive filtering) may write.
export function encodePng({ width, height, channels, data }, filter = 0) {
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter
    const row = data.subarray(y * stride, (y + 1) * stride)
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      const pred = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0
      raw[y * (stride + 1) + 1 + i] = (row[i] - pred) & 255
    }
  }
  const chunk = (type, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), d])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Black out each {x, y, w, h}, clipped to the image. Alpha, if any, is made opaque.
export function maskRects(img, rects) {
  for (const r of rects) {
    for (let y = Math.max(0, r.y); y < Math.min(img.height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(img.width, r.x + r.w); x++) {
        const o = (y * img.width + x) * img.channels
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 0
        if (img.channels === 4) img.data[o + 3] = 255
      }
    }
  }
  return img
}

// ── layouts: where the Wi-Fi QR sits ────────────────────────────────────────────────────────────
// -> { name, rects } for one layout XML: every image section whose src or name says "wifi".
export function wifiQrRects(xml) {
  const name = (xml.match(/<layout\b[^>]*\bname="([^"]*)"/) || [])[1] || null
  const rects = []
  for (const m of xml.matchAll(/<section\b([^>]*)>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    if (a.type !== 'image' || !/wifi/i.test(`${a.src || ''} ${a.name || ''}`)) continue
    const n = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d)
    // No size given: mask generously rather than leave half a QR readable.
    rects.push({ x: n(a.x, 0), y: n(a.y, 0), w: n(a.width, 64), h: n(a.height, 64) })
  }
  return { name, rects }
}

export function loadLayouts(dir) {
  const map = new Map()
  const walk = (d, depth) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory() && depth < 2) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.xml')) {
        try {
          const { name, rects } = wifiQrRects(fs.readFileSync(p, 'utf8'))
          if (name) map.set(name, rects)
        } catch { /* unreadable layout: ignore */ }
      }
    }
  }
  walk(dir, 0)
  return map
}

// What to mask for a frame taken while `layout` is up. null = do not store this frame.
export function masksFor(layout, layouts) {
  if (layout && layouts.has(layout)) return layouts.get(layout)
  if (layout) return /crest|wait|qr|wifi/i.test(layout) ? null : []
  const all = [...layouts.values()].flat()
  return all.length ? all : null
}

// ── the recorder ────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    listen: '127.0.0.1:18899', upstream: '127.0.0.1:8889', out: '',
    buffer: '/home/pi/ledbox/www/buffer.png', layouts: '/home/pi/ledbox/layout',
    settle: 2000, every: 5000, minutes: 0, raw: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i]
    if (k === '--listen') o.listen = v()
    else if (k === '--upstream') o.upstream = v()
    else if (k === '--out') o.out = v()
    else if (k === '--buffer') o.buffer = v()
    else if (k === '--layouts') o.layouts = v()
    else if (k === '--settle') o.settle = Number(v())
    else if (k === '--every') o.every = Number(v())
    else if (k === '--minutes') o.minutes = Number(v())
    else if (k === '--raw') o.raw = true
    else if (k === '-h' || k === '--help') o.help = true
    else throw new Error(`unknown argument ${k}`)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (!o.out) o.out = fs.existsSync('/home/pi') ? `/home/pi/ledbox-record/${stamp}` : `./board-traffic-${stamp}`
  return o
}

const hostPort = (s) => { const i = s.lastIndexOf(':'); return { host: s.slice(0, i), port: Number(s.slice(i + 1)) } }
// Anything that can change what the panel shows. Reads and the handshake's Disconnect cannot.
const isDisplay = (cmd) => typeof cmd === 'string' && !/^(Get|Info$|Disconnect$)/.test(cmd)

export async function main(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv)
  if (opt.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    return
  }
  const L = hostPort(opt.listen), U = hostPort(opt.upstream)
  fs.mkdirSync(path.join(opt.out, 'frames'), { recursive: true })
  if (opt.raw) fs.mkdirSync(path.join(opt.out, 'raw'), { recursive: true })
  const layouts = loadLayouts(opt.layouts)
  const t0 = Date.now()
  const meta = {
    started: new Date(t0).toISOString(), host: os.hostname(), node: process.version, ...opt,
    layoutsWithWifiQr: [...layouts].filter(([, r]) => r.length).map(([n]) => n),
  }
  const stream = fs.createWriteStream(path.join(opt.out, 'stream.ndjson'), { flags: 'a' })
  const framesLog = fs.createWriteStream(path.join(opt.out, 'frames.ndjson'), { flags: 'a' })
  const say = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)
  fs.writeFileSync(path.join(opt.out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

  let recording = true, seq = 0, frameN = 0, lastSha = '', connSeq = 0
  let layout = null, dirtySince = 0, settleTimer = null
  const pendingLayout = new Map() // conn -> the layout before its last SetLayout, until the board answers
  const counts = { to_board: 0, from_board: 0, frames: 0, duplicates: 0, skipped: 0, undecodable: 0 }
  const rec = (o) => { if (recording) stream.write(JSON.stringify({ seq: ++seq, t: Date.now() - t0, ...o }) + '\n') }

  const readFrame = async () => {
    for (let i = 0; i < 4; i++) {
      try {
        const b = fs.readFileSync(opt.buffer)
        if (isCompletePng(b)) return b
      } catch { /* not there (yet) */ }
      await new Promise((r) => setTimeout(r, 150))
    }
    return null
  }

  const capture = async (settled) => {
    if (!recording) return
    const rects = masksFor(layout, layouts)
    const why = (s) => { counts.skipped++; framesLog.write(JSON.stringify({ skipped: s, t: Date.now() - t0, afterSeq: seq, layout }) + '\n'); say(`frame skipped: ${s}`) }
    if (rects === null) return why(`layout ${layout || '(unknown)'} may show the Wi-Fi QR and its geometry is unknown`)
    const raw = await readFrame()
    if (!raw) return why(`no complete PNG at ${opt.buffer}`)
    let bytes = raw
    if (rects.length) {
      try { bytes = encodePng(maskRects(decodePng(raw), rects)) } catch (e) { return why(`cannot mask (${e.message})`) }
    }
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    if (sha === lastSha) { counts.duplicates++; return }
    lastSha = sha
    const file = `frames/${String(++frameN).padStart(4, '0')}.png`
    fs.writeFileSync(path.join(opt.out, file), bytes)
    counts.frames++
    framesLog.write(JSON.stringify({ n: frameN, file, t: Date.now() - t0, afterSeq: seq, layout, settled, masked: rects.length, sha256: sha }) + '\n')
    say(`frame ${file}  layout=${layout || '?'}${rects.length ? ` (${rects.length} QR masked)` : ''}${settled ? '' : ' (mid-update)'}`)
  }

  const touched = () => {
    const now = Date.now()
    if (!dirtySince) dirtySince = now
    clearTimeout(settleTimer)
    if (now - dirtySince >= opt.every) { dirtySince = now; capture(false) }
    settleTimer = setTimeout(() => { dirtySince = 0; capture(true) }, opt.settle)
  }

  const observe = (conn, dir, dec, chunk, rawOut) => {
    if (!recording) return
    rawOut?.write(chunk)
    let msgs = []
    try { msgs = dec.push(chunk) } catch { counts.undecodable++ }
    for (const msg of msgs) {
      counts[dir]++
      rec({ conn, dir, msg })
      if (dir === 'to_board') {
        if (msg.cmd === 'SetLayout' && typeof (msg.name || msg.value) === 'string') { pendingLayout.set(conn, layout); layout = msg.name || msg.value }
        if (isDisplay(msg.cmd)) touched()
      } else {
        // The board's answers keep the layout honest: Init reports the current one, a refused
        // SetLayout (code 5: not on this device) means the panel did NOT change.
        if (msg.sender === 'Init' && msg.value && typeof msg.value.current_layout === 'string') layout = msg.value.current_layout
        if (msg.sender === 'GetLayout' && typeof msg.value === 'string') layout = msg.value
        if (msg.sender === 'SetLayout' && msg.status && msg.status !== 'ok' && pendingLayout.has(conn)) layout = pendingLayout.get(conn)
        if (msg.sender === 'SetLayout') pendingLayout.delete(conn)
      }
    }
  }

  const sockets = new Set()
  const server = net.createServer((client) => {
    const conn = ++connSeq
    const up = net.connect(U.port, U.host)
    sockets.add(client); sockets.add(up)
    const from = `${client.remoteAddress}:${client.remotePort}`
    rec({ conn, event: 'open', from })
    say(`open conn ${conn} from ${from} → ${opt.upstream}`)
    const decTo = new StreamDecoder(), decFrom = new StreamDecoder()
    const rawTo = opt.raw ? fs.createWriteStream(path.join(opt.out, 'raw', `${conn}-to_board.bin`)) : null
    const rawFrom = opt.raw ? fs.createWriteStream(path.join(opt.out, 'raw', `${conn}-from_board.bin`)) : null
    // Forwarding first, observing second: a decode problem must never cost the panel a byte.
    client.on('data', (c) => { up.write(c); observe(conn, 'to_board', decTo, c, rawTo) })
    up.on('data', (c) => { client.write(c); observe(conn, 'from_board', decFrom, c, rawFrom) })
    let closed = false
    const close = (why) => {
      if (closed) return
      closed = true
      client.destroy(); up.destroy(); sockets.delete(client); sockets.delete(up)
      rawTo?.end(); rawFrom?.end()
      rec({ conn, event: 'close', why })
      say(`close conn ${conn} (${why})`)
    }
    client.on('close', () => close('bridge closed')); up.on('close', () => close('panel closed'))
    client.on('error', (e) => close(`bridge: ${e.code || e.message}`)); up.on('error', (e) => close(`panel: ${e.code || e.message}`))
  })

  const finish = () => {
    if (!recording) return
    recording = false
    clearTimeout(settleTimer)
    meta.stopped = new Date().toISOString(); meta.counts = counts
    fs.writeFileSync(path.join(opt.out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    stream.end(); framesLog.end()
    say(`recording stopped: ${counts.to_board} to the board, ${counts.from_board} back, ${counts.frames} frames (${counts.duplicates} duplicates, ${counts.skipped} skipped) in ${opt.out}`)
  }
  const shutdown = () => {
    finish()
    server.close()
    for (const s of sockets) s.destroy()
    setTimeout(() => process.exit(0), 200).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(L.port, L.host, resolve) })
  say(`listening on ${opt.listen}, forwarding to ${opt.upstream}; recording to ${opt.out}`)
  say(`wifi-QR geometry known for: ${meta.layoutsWithWifiQr.join(', ') || 'NONE (frames before a known layout are skipped)'}`)
  capture(true) // the panel as it is before anything happens
  if (opt.minutes > 0) {
    setTimeout(() => { finish(); say('still forwarding — undo the bridge redirect, then stop this') }, opt.minutes * 60000).unref()
  }
  return { server, finish, shutdown, out: opt.out }
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href } catch { return false }
})()
if (invokedDirectly) main().catch((e) => { console.error(`!! ${e.message}`); process.exit(1) })
