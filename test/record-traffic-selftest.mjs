// tools/record-board-traffic.mjs — the tee proxy for recording a rehearsal on the real board.
//
// It sits between the bridge and the panel firmware during a live rehearsal, so the two things that
// must never go wrong are pinned here: every byte is forwarded unchanged both ways (also once the
// recording has stopped), and no stored frame ever shows the Wi-Fi QR (it encodes the AP
// passphrase). Plus the parts that make the recording useful: the decoded stream in order, the
// layout tracking that decides the mask (Init's current_layout, a refused SetLayout not counting),
// and a PNG codec that reads every filter type an encoder may write.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encode, StreamDecoder } from '../src/ledboxProtocol.js'
import { MockLedbox } from '../src/mockLedbox.js'
import {
  decodePng, encodePng, isCompletePng, maskRects, wifiQrRects, loadLayouts, masksFor, main,
} from '../tools/record-board-traffic.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(20) } return cond() }

const W = 192, H = 64
const image = (channels, fill) => {
  const data = Buffer.alloc(W * H * channels)
  for (let p = 0; p < W * H; p++) for (let c = 0; c < channels; c++) data[p * channels + c] = fill(p % W, Math.floor(p / W), c)
  return { width: W, height: H, channels, data }
}
const pixel = (img, x, y) => [...img.data.subarray((y * W + x) * img.channels, (y * W + x) * img.channels + 3)]

console.log('PNG codec:')
{
  const rgb = image(3, (x, y, c) => (x * 7 + y * 13 + c * 51) & 255)
  for (const f of [0, 1, 2, 3, 4]) {
    const back = decodePng(encodePng(rgb, f))
    ok(back.width === W && back.height === H && back.channels === 3 && back.data.equals(rgb.data), `RGB round trip, filter ${f}`)
  }
  const rgba = image(4, (x, y, c) => (c === 3 ? 200 : (x ^ y) & 255))
  ok(decodePng(encodePng(rgba, 4)).data.equals(rgba.data), 'RGBA round trip')
  const png = encodePng(rgb)
  ok(isCompletePng(png) && !isCompletePng(png.subarray(0, png.length - 20)), 'a half-written file is told apart from a whole one')
  let threw = false
  try { decodePng(png.subarray(0, 40)) } catch { threw = true }
  ok(threw, 'a truncated PNG throws instead of decoding garbage')
}

console.log('masking:')
{
  const crest = fs.readFileSync(path.join(repo, 'layouts', '32_kscw_crest.xml'), 'utf8')
  const q = wifiQrRects(crest)
  ok(q.name === 'kscw_crest' && q.rects.length === 1 && JSON.stringify(q.rects[0]) === '{"x":8,"y":12,"w":48,"h":48}',
    'kscw_crest: exactly the wifiqr box (8,12 48x48) — not the Open-UI QR')
  ok(wifiQrRects(fs.readFileSync(path.join(repo, 'layouts', '02_volleyball_matchscore_02.xml'), 'utf8')).rects.length === 0, 'the match layout has nothing to mask')
  const img = maskRects(image(3, () => 255), q.rects)
  ok(pixel(img, 8, 12).join() === '0,0,0' && pixel(img, 55, 59).join() === '0,0,0' && pixel(img, 56, 12).join() === '255,255,255' && pixel(img, 7, 30).join() === '255,255,255',
    'the box is black, its edges exact')
  const map = new Map([['kscw_crest', q.rects], ['volleyball_matchscore_02', []]])
  ok(masksFor('kscw_crest', map) === q.rects, 'known layout: its own boxes')
  ok(masksFor('volleyball_matchscore_02', map).length === 0, 'known layout without a QR: no mask')
  ok(masksFor('some_other_crest', map) === null, 'a QR-looking layout with no XML: skipped, not guessed')
  ok(masksFor('kscw_break', map).length === 0, 'an ordinary unknown layout: no mask')
  ok(masksFor(null, map).length === 1, 'layout not known yet: every QR box masked')
  ok(masksFor(null, new Map()) === null, 'layout not known and no geometry at all: skipped')
}

console.log('the proxy, end to end against the mock board:')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'record-traffic-'))
  const lay = path.join(tmp, 'layout')
  fs.mkdirSync(path.join(lay, 'system'), { recursive: true })
  fs.copyFileSync(path.join(repo, 'layouts', '32_kscw_crest.xml'), path.join(lay, '32_kscw_crest.xml'))
  fs.copyFileSync(path.join(repo, 'firmware', 'openscore', 'layout', 'system', 'waiting.xml'), path.join(lay, 'system', 'waiting.xml'))
  ok(loadLayouts(lay).size === 2, 'layouts found, including the vendor system/ folder')
  const buffer = path.join(tmp, 'buffer.png')
  const paint = (v) => fs.writeFileSync(buffer, encodePng(image(3, (x, y, c) => (c === 0 ? v : 255))))
  paint(255)

  const mock = new MockLedbox({ layouts: { kscw_crest: ['wifiqr', 'uiqr', 'media', 'wifilbl', 'uilbl'] } })
  const m = await mock.listen(0, '127.0.0.1')
  const out = path.join(tmp, 'out')
  const r = await main(['--listen', '127.0.0.1:0', '--upstream', `127.0.0.1:${m.port}`, '--out', out,
    '--buffer', buffer, '--layouts', lay, '--settle', '150', '--every', '5000'])
  const port = r.server.address().port

  const sock = net.connect(port, '127.0.0.1')
  const dec = new StreamDecoder()
  const replies = []
  sock.on('data', (c) => replies.push(...dec.push(c)))
  await new Promise((res) => sock.once('connect', res))
  const send = async (msg) => { const n = replies.length; sock.write(encode(msg)); await waitFor(() => replies.length > n); return replies[replies.length - 1] }
  const frames = () => fs.readFileSync(path.join(out, 'frames.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  const init = await send({ cmd: 'Init', alias: 't', sport: 'volleyball', value: { version: 2 } })
  ok(init?.status === 'ok' && init.value?.current_layout === 'waiting', 'Init goes through and its reply comes back intact')

  paint(10)
  ok((await send({ cmd: 'SetLayout', value: 'kscw_crest' }))?.status === 'ok', 'SetLayout kscw_crest forwarded')
  await waitFor(() => frames().some((f) => f.layout === 'kscw_crest'), 2000)
  const crestFrame = frames().find((f) => f.layout === 'kscw_crest')
  ok(crestFrame && crestFrame.settled && crestFrame.masked === 1, 'a settled frame is taken on kscw_crest, with the QR masked')
  if (crestFrame) {
    const img = decodePng(fs.readFileSync(path.join(out, crestFrame.file)))
    ok(pixel(img, 20, 30).join() === '0,0,0' && pixel(img, 100, 30).join() === '10,255,255', 'stored frame: QR box black, the rest is the panel')
  }

  paint(20)
  const refused = await send({ cmd: 'SetLayout', value: 'no_such_crest' })
  ok(refused?.status === 'error', 'a SetLayout the board refuses comes back refused')
  await waitFor(() => frames().length > (crestFrame?.n || 0) + 0 && frames().at(-1).sha256 !== crestFrame?.sha256, 2000)
  ok(frames().at(-1)?.layout === 'kscw_crest' && frames().at(-1)?.masked === 1, 'a refused SetLayout leaves the layout (and the mask) as it was')

  paint(30)
  await send({ cmd: 'SetLayout', value: 'volleyball_matchscore_02' })
  await send({ cmd: 'SetSections', value: [{ name: 'score1', value: { attrib: 'text', value: '7' } }] })
  await waitFor(() => frames().at(-1)?.layout === 'volleyball_matchscore_02', 2000)
  const plain = frames().at(-1)
  ok(plain?.masked === 0 && fs.readFileSync(path.join(out, plain.file)).equals(fs.readFileSync(buffer)), 'match layout: the frame is the vendor file, byte for byte')
  ok(mock.text('score1') === '7', 'the board really got the write')

  await sleep(400)
  const n = frames().length
  await send({ cmd: 'SetSections', value: [{ name: 'score1', value: { attrib: 'text', value: '7' } }] })
  await sleep(400)
  ok(frames().length === n, 'an unchanged panel is not stored twice')

  r.finish()
  const lines = fs.readFileSync(path.join(out, 'stream.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const seqs = lines.map((l) => l.seq)
  ok(lines[0]?.event === 'open' && seqs.every((s, i) => s === i + 1), 'stream.ndjson: opens with the connection, seq strictly in order')
  ok(lines.filter((l) => l.dir === 'to_board').map((l) => l.msg.cmd).join() === 'Init,SetLayout,SetLayout,SetLayout,SetSections,SetSections', 'every command to the board, decoded, in order')
  ok(lines.filter((l) => l.dir === 'from_board').length === 6 && lines.some((l) => l.dir === 'from_board' && l.msg.error_code === 5), 'every answer from the board, refusals included')

  const after = await send({ cmd: 'GetLayout' })
  ok(after?.value === 'volleyball_matchscore_02', 'after the recording stops it still forwards (a forgotten undo never cuts the panel off)')
  ok(fs.readFileSync(path.join(out, 'stream.ndjson'), 'utf8').trim().split('\n').length === lines.length, '...and records nothing more')
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'))
  ok(meta.counts?.to_board === 6 && meta.stopped, 'meta.json closes with the counts')

  sock.destroy()
  r.server.close()
  await mock.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — record-traffic-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
