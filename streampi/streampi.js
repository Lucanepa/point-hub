#!/usr/bin/env node
// Stream Pi: a USB camera (a DJI Osmo Action 6 in Webcam mode) with the board's livestream
// scorebug (/overlay, or any see-through page) laid over it, sent as one stream to YouTube, Twitch
// or any RTMP server. Runs on a small computer next to the camera, so the board keeps driving its
// panel and the camera can stand anywhere. A phone opens http://<stream-pi>:8080 to set it up and
// start or stop it (console.html).
//
//   camera video (UVC, H.264) ──────────────────────────┐
//   camera microphone (USB audio) ──────────────────────┤ ffmpeg: overlay → H.264 + AAC → RTMP
//   Chromium renders the overlay page → a PNG on change ┘   (fed FEED_FPS times a second)
//
// The scorebug comes in through a pipe: ffmpeg's image2 demuxer (-loop 1) never re-reads a picture
// that changed on disk, so the latest picture is written to ffmpeg's stdin instead. Every input is
// stamped with the wall clock and the camera goes through fps=, so a camera that slows down (dim
// light) gives a steady stream with repeated frames instead of a stalled one.
//
//   node streampi.js              the console + the stream (settings in STATE_DIR/settings.json)
//   node streampi.js set-pin 1234 the console PIN (a scrypt hash in STATE_DIR/pin)
//
// Environment (a systemd EnvironmentFile on the Pi): STATE_DIR, CONTROL_PORT, CHROME_PATH,
// PLAYWRIGHT_CORE, FFMPEG, plus the DEFAULTS below. OUTPUT and OVERLAY_URL in the environment win
// over the console (tests write to a file with OUTPUT=/tmp/x.mkv DURATION=30).

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashAdminPin, makeAdminPin, ADMIN_PIN_RE } from '../src/adminPin.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULTS = {
  FPS: '30',
  INPUT_FORMAT: 'h264', // the Osmo sends H.264 (cheap over USB) and MJPEG; h264 up to 4K, mjpeg up to 1080p
  X264_PRESET: 'veryfast',
  FEED_FPS: '4',
  AUDIO_DEVICE: 'auto',
  VIDEO_DEVICE: 'auto',
  ENCODER: 'auto',
}

export const QUALITY = {
  '720p': { SIZE: '1280x720', BITRATE: '2500k' },
  '1080p': { SIZE: '1920x1080', BITRATE: '4500k' },
}

// Where each platform takes a stream; the key goes after the slash. "other" = a full URL typed in.
export const PLATFORMS = {
  youtube: 'rtmps://a.rtmps.youtube.com:443/live2',
  twitch: 'rtmp://live.twitch.tv/app',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/**
 * What one stream runs with: DEFAULTS, then the console's saved settings, then the environment.
 * @param {Record<string,string>} env
 * @param {{ overlayUrl?, platform?, server?, streamKey?, quality?, source? }} saved
 */
export function buildConfig(env = {}, saved = {}) {
  const cfg = { ...DEFAULTS, ...QUALITY[saved.quality === '720p' ? '720p' : '1080p'] }
  cfg.OVERLAY_URL = saved.overlayUrl || ''
  const server = saved.platform === 'other' ? (saved.server || '') : (PLATFORMS[saved.platform] || PLATFORMS.youtube)
  cfg.OUTPUT = server && saved.streamKey ? `${server.replace(/\/+$/, '')}/${saved.streamKey}` : (saved.platform === 'other' ? server : '')
  if (saved.source === 'test') cfg.VIDEO_DEVICE = 'test'
  for (const k of [...Object.keys(DEFAULTS), 'SIZE', 'BITRATE', 'OVERLAY_URL', 'OUTPUT', 'DURATION', 'CHROME_PATH', 'DECODER', 'OVERLAY_REGION']) {
    if (env[k] != null && env[k] !== '') cfg[k] = String(env[k])
  }
  return cfg
}

/** What is still missing before a stream can start, as words for the console. */
export function missing(cfg) {
  const out = []
  if (!/^https?:\/\//i.test(cfg.OVERLAY_URL)) out.push('the score overlay address')
  if (!cfg.OUTPUT) out.push('the stream key')
  return out
}

/** The stream address with its key hidden, for logs and the console. */
export const maskOutput = (url) => String(url || '').replace(/^(rtmps?:\/\/[^/]+\/.+?\/)[^/]+$/i, '$1•••')

/**
 * The camera's capture node: the first /dev/videoN whose name looks like the Osmo (else any
 * camera that is not the laptop's own), and only index 0 — a UVC camera also makes a metadata
 * node (index 1) that gives no picture.
 * @param {{ name: string, index: string, dev: string }[]} nodes  from /sys/class/video4linux
 */
export function pickVideoDevice(nodes) {
  const capture = nodes.filter((n) => n.index.trim() === '0')
  const osmo = capture.find((n) => /osmo|dji/i.test(n.name))
  if (osmo) return osmo.dev
  const other = capture.find((n) => !/integrated|laptop|webcam module|facetime/i.test(n.name))
  return other ? other.dev : null
}

/** The camera's sound card id from /proc/asound/cards (e.g. "OsmoAction6SN39"), or null. */
export function pickAudioCard(cards) {
  for (const line of String(cards).split('\n')) {
    const m = line.match(/^\s*\d+\s+\[(\S+)\s*\]:\s+USB-Audio\s+-\s+(.*)$/)
    if (m && /osmo|dji/i.test(m[2])) return m[1]
  }
  return null
}

function listVideoNodes() {
  const base = '/sys/class/video4linux'
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).sort().map((d) => ({
    dev: `/dev/${d}`,
    name: fs.readFileSync(`${base}/${d}/name`, 'utf8').trim(),
    index: fs.existsSync(`${base}/${d}/index`) ? fs.readFileSync(`${base}/${d}/index`, 'utf8') : '0',
  }))
}

const isPi4 = () => {
  try { return /Raspberry Pi 4|Compute Module 4/.test(fs.readFileSync('/proc/device-tree/model', 'utf8')) } catch { return false }
}

/**
 * The part of the frame the scorebug can be in: half the width and 45 % of the height at the
 * corner the overlay URL names (?corner=tl|tr|bl|br, the LedBox's own option; default top left).
 * Only this part is captured and blended: a full transparent frame cost a Pi 5 a blend of two
 * million pixels 30 times a second (27.11.2026). OVERLAY_REGION=full takes the whole frame (a big
 * ?scale= on the LedBox page, or a page that draws elsewhere).
 */
export function overlayRegion(cfg) {
  const [width, height] = cfg.SIZE.split('x').map(Number)
  if (cfg.OVERLAY_REGION === 'full') return { x: 0, y: 0, width, height }
  let corner = 'tl'
  try { corner = new URL(cfg.OVERLAY_URL).searchParams.get('corner') || 'tl' } catch { /* not a URL: the default */ }
  if (!/^[tb][lr]$/.test(corner)) corner = 'tl'
  const w = Math.round(width / 4) * 2
  const h = Math.round(height * 0.225) * 2
  return { x: corner[1] === 'r' ? width - w : 0, y: corner[0] === 'b' ? height - h : 0, width: w, height: h }
}

/**
 * ffmpeg's arguments. Input 0 = the camera (or a test pattern), 1 = its microphone (or silence),
 * 2 = the scorebug pictures on stdin (overlayRegion's part of the frame). Pure, so the selftest holds it.
 * @param {object} cfg  buildConfig's answer
 * @param {{ video: string, audioCard: string|null, pi4: boolean }} hw  video 'test' = test pattern
 */
export function ffmpegArgs(cfg, hw) {
  const region = overlayRegion(cfg)
  const fps = Number(cfg.FPS)
  const gop = String(fps * 2) // a keyframe every 2 s: what YouTube asks for
  const bitrate = cfg.BITRATE
  const bufsize = `${parseInt(bitrate, 10) * 2}${bitrate.replace(/^\d+/, '')}`
  const encoder = cfg.ENCODER === 'auto' ? (hw.pi4 ? 'h264_v4l2m2m' : 'libx264') : cfg.ENCODER
  // shortcut: the Pi 4 path (hardware decode + encode) is untested until a Pi 4 runs it; ENCODER=libx264 overrides
  const decoder = cfg.DECODER || (hw.pi4 && cfg.INPUT_FORMAT === 'h264' ? 'h264_v4l2m2m' : null)
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-progress', 'pipe:1', '-stats_period', '5']
  if (hw.video === 'test') {
    // no camera: a moving test picture, to check the stream path at home or in the hall
    args.push('-re', '-f', 'lavfi', '-i', `testsrc2=size=${cfg.SIZE}:rate=${fps}`)
  } else {
    args.push('-f', 'v4l2', '-input_format', cfg.INPUT_FORMAT, '-video_size', cfg.SIZE, '-framerate', String(fps),
      '-use_wallclock_as_timestamps', '1', '-thread_queue_size', '512')
    if (decoder) args.push('-c:v', decoder)
    args.push('-i', hw.video)
  }
  // microphone, or silence (YouTube warns about a stream without sound)
  if (hw.audioCard) args.push('-f', 'alsa', '-use_wallclock_as_timestamps', '1', '-thread_queue_size', '1024', '-i', `plughw:CARD=${hw.audioCard}`)
  else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  // scorebug pictures on stdin, stamped when they arrive
  args.push('-f', 'image2pipe', '-framerate', cfg.FEED_FPS, '-use_wallclock_as_timestamps', '1', '-thread_queue_size', '64', '-i', 'pipe:0')
  args.push('-filter_complex',
    `[0:v]fps=${fps}[cam];[2:v]format=rgba[bug];[cam][bug]overlay=${region.x}:${region.y}:eof_action=repeat:format=auto,format=yuv420p[v];[1:a]aresample=async=1000[a]`,
    '-map', '[v]', '-map', '[a]')
  if (encoder === 'libx264') {
    args.push('-c:v', 'libx264', '-preset', cfg.X264_PRESET, '-tune', 'zerolatency', '-profile:v', 'high')
  } else {
    args.push('-c:v', encoder)
  }
  args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize, '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
  if (cfg.DURATION) args.push('-t', cfg.DURATION)
  if (/^rtmps?:\/\//i.test(cfg.OUTPUT)) args.push('-f', 'flv', cfg.OUTPUT)
  else args.push('-y', cfg.OUTPUT)
  return args
}

/**
 * One stream at a time: Chromium on the overlay page + ffmpeg, both started again after a
 * failure until stop(). `status` is what the console shows.
 */
export function makeStreamer({ env = process.env } = {}) {
  const status = { state: 'stopped', detail: '', camera: null, sound: null, overlay: 'off', fps: null, bitrate: null, speed: null, dropped: null, since: null, output: '' }
  let run = null // { cfg, stop: bool, ff, browser, latest }

  async function renderer(r) {
    const { chromium } = await import(env.PLAYWRIGHT_CORE || 'playwright-core')
    const [width, height] = r.cfg.SIZE.split('x').map(Number)
    const clip = overlayRegion(r.cfg)
    while (!r.stop) {
      try {
        r.browser = await chromium.launch({ executablePath: r.cfg.CHROME_PATH || undefined, args: ['--disable-gpu', '--hide-scrollbars'] })
        const page = await r.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
        let timer = null
        let busy = false
        const capture = async () => {
          if (busy) { timer = setTimeout(capture, 100); return }
          busy = true
          try { r.latest = await page.screenshot({ type: 'png', omitBackground: true, clip }) } catch { /* page navigating */ }
          busy = false
        }
        const changed = () => { clearTimeout(timer); timer = setTimeout(capture, 80) }
        await page.exposeFunction('__streampiChanged', changed)
        await page.addInitScript(() => {
          new MutationObserver(() => window.__streampiChanged?.()).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
        })
        await capture() // about:blank: a see-through frame of the right size before the page answers
        await page.goto(r.cfg.OVERLAY_URL, { waitUntil: 'load', timeout: 20000 })
        await capture()
        status.overlay = 'on'
        log('overlay: showing', r.cfg.OVERLAY_URL)
        const safety = setInterval(changed, 2000) // a change the observer cannot see (a CSS animation's end)
        await new Promise((resolve) => r.browser.on('disconnected', resolve))
        clearInterval(safety)
      } catch (err) {
        if (!r.stop) { status.overlay = 'unreachable'; log('overlay:', err.message.split('\n')[0]) }
        try { await r.browser?.close() } catch { /* gone */ }
      }
      if (!r.stop) await new Promise((res) => setTimeout(res, 5000))
    }
  }

  function ffmpegLoop(r) {
    if (r.stop) return
    const video = r.cfg.VIDEO_DEVICE === 'auto' ? pickVideoDevice(listVideoNodes()) : r.cfg.VIDEO_DEVICE
    status.camera = video
    if (!video) {
      Object.assign(status, { state: 'waiting', detail: 'No camera: plug in the Osmo and tap Webcam on it' })
      r.retry = setTimeout(() => ffmpegLoop(r), 3000)
      return
    }
    let audioCard = null
    if (r.cfg.AUDIO_DEVICE === 'auto' && video !== 'test') {
      try { audioCard = pickAudioCard(fs.readFileSync('/proc/asound/cards', 'utf8')) } catch { /* no ALSA */ }
    } else if (!['auto', 'none'].includes(r.cfg.AUDIO_DEVICE)) audioCard = r.cfg.AUDIO_DEVICE
    status.sound = audioCard
    const args = ffmpegArgs(r.cfg, { video, audioCard, pi4: isPi4() })
    log(`stream: ${video}${audioCard ? ` + sound ${audioCard}` : ' (no sound card: silence)'} → ${maskOutput(r.cfg.OUTPUT)}`)
    Object.assign(status, { state: 'starting', detail: 'Connecting…' })
    const ff = spawn(env.FFMPEG || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    r.ff = ff
    let full = false
    ff.stdin.on('drain', () => { full = false })
    ff.stdin.on('error', () => { /* ffmpeg gone: the exit handler decides */ })
    const feed = setInterval(() => {
      if (r.latest && !full && ff.stdin.writable) full = !ff.stdin.write(r.latest)
    }, 1000 / Number(r.cfg.FEED_FPS))
    let progress = {}
    ff.stdout.on('data', (b) => {
      for (const line of b.toString().split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) progress[line.slice(0, i).trim()] = line.slice(i + 1).trim()
        if (line.startsWith('progress=')) {
          Object.assign(status, { state: 'live', detail: '', fps: Number(progress.fps) || 0, bitrate: progress.bitrate, speed: progress.speed, dropped: Number(progress.drop_frames) || 0 })
          if (!status.since) status.since = Date.now()
          log(`stream: fps ${progress.fps} · ${progress.bitrate} · speed ${progress.speed} · dropped ${progress.drop_frames}`)
          progress = {}
        }
      }
    })
    let tail = ''
    ff.stderr.on('data', (b) => { tail = (tail + b.toString()).slice(-2000) })
    ff.on('exit', (code) => {
      clearInterval(feed)
      r.ff = null
      if (r.stop) return
      if (code === 0 && r.cfg.DURATION) { log('stream: done'); stop(); return }
      const last = tail.trim().split('\n').slice(-2).join(' | ').replace(r.cfg.OUTPUT, maskOutput(r.cfg.OUTPUT))
      log(`stream: ffmpeg stopped (${code}): ${last}`)
      Object.assign(status, { state: 'retrying', detail: `Stream stopped, trying again: ${last.slice(0, 200)}`, since: null })
      r.retry = setTimeout(() => ffmpegLoop(r), 5000)
    })
  }

  async function start(saved) {
    if (run) return { ok: false, error: 'already running' }
    const cfg = buildConfig(env, saved)
    const gaps = missing(cfg)
    if (gaps.length) return { ok: false, error: `Missing ${gaps.join(' and ')}` }
    const r = { cfg, stop: false, latest: null }
    run = r
    Object.assign(status, { state: 'starting', detail: 'Starting…', output: maskOutput(cfg.OUTPUT), since: null, fps: null, bitrate: null, speed: null, dropped: null, overlay: 'loading' })
    renderer(r)
    // the first (blank) frame first, so ffmpeg never starts on an empty pipe
    const t0 = Date.now()
    while (!r.latest && !r.stop && Date.now() - t0 < 30000) await new Promise((res) => setTimeout(res, 100))
    if (r.stop) return { ok: false, error: 'stopped' }
    if (!r.latest) { stop(); Object.assign(status, { detail: 'The browser for the overlay did not start' }); return { ok: false, error: status.detail } }
    ffmpegLoop(r)
    return { ok: true }
  }

  function stop() {
    const r = run
    if (!r) return
    r.stop = true
    clearTimeout(r.retry)
    if (r.ff) r.ff.kill('SIGINT') // ffmpeg ends the stream cleanly
    r.browser?.close().catch(() => {})
    run = null
    Object.assign(status, { state: 'stopped', detail: '', overlay: 'off', since: null, fps: null, bitrate: null, speed: null })
    log('stream: stopped')
  }

  return { status, start, stop, running: () => !!run }
}

// ── settings + console ──────────────────────────────────────────────────────────────────────

const SETTING_KEYS = ['overlayUrl', 'platform', 'server', 'streamKey', 'quality', 'source', 'autostart']

export function cleanSettings(body, prev = {}) {
  const out = { ...prev }
  for (const k of SETTING_KEYS) {
    if (!(k in (body || {}))) continue
    const v = body[k]
    if (k === 'streamKey' && (v == null || v === '')) continue // empty = keep the saved key
    if (k === 'autostart') out[k] = v === true
    else out[k] = String(v ?? '').trim().slice(0, 500)
  }
  if (out.platform && !['youtube', 'twitch', 'facebook', 'other'].includes(out.platform)) out.platform = 'youtube'
  if (out.quality && !QUALITY[out.quality]) out.quality = '1080p'
  if (out.source && !['camera', 'test'].includes(out.source)) out.source = 'camera'
  return out
}

/** The settings as the console may see them: never the key itself. */
export const publicSettings = (s) => ({ ...s, streamKey: undefined, streamKeySet: !!s.streamKey })

function main() {
  const stateDir = process.env.STATE_DIR || path.join(HERE, '.state')
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const settingsFile = path.join(stateDir, 'settings.json')
  const pinFile = path.join(stateDir, 'pin')

  if (process.argv[2] === 'set-pin') {
    const pin = process.argv[3] || ''
    if (!ADMIN_PIN_RE.test(pin)) { console.error('a PIN is 4 to 12 digits'); process.exit(1) }
    fs.writeFileSync(pinFile, hashAdminPin(pin), { mode: 0o600 })
    console.log('console PIN set')
    return
  }

  const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return {} } }
  const writeSettings = (s) => {
    fs.writeFileSync(`${settingsFile}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 })
    fs.renameSync(`${settingsFile}.tmp`, settingsFile)
  }
  const pin = makeAdminPin(pinFile)
  const streamer = makeStreamer()
  const page = fs.readFileSync(path.join(HERE, 'console.html'))

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 20000) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve(null) } })
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(page)
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { ...streamer.status, settings: publicSettings(readSettings()), pinSet: pin.isSet() })
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' })
    // every change needs the PIN
    const check = pin.check(req.headers['x-pin'])
    if (!check.ok) {
      if (check.unset) return send(res, 403, { error: 'No PIN set yet: run `node streampi.js set-pin <digits>` on the Stream Pi' })
      if (check.locked) return send(res, 429, { error: `Too many wrong PINs: wait ${Math.ceil(check.retryAfterMs / 1000)} s` })
      return send(res, 401, { error: 'Wrong PIN' })
    }
    if (url.pathname === '/api/settings') {
      const body = await readBody(req)
      if (!body) return send(res, 400, { error: 'not JSON' })
      const next = cleanSettings(body, readSettings())
      writeSettings(next)
      return send(res, 200, { ok: true, settings: publicSettings(next) })
    }
    if (url.pathname === '/api/start') return send(res, 200, await streamer.start(readSettings()))
    if (url.pathname === '/api/stop') { streamer.stop(); return send(res, 200, { ok: true }) }
    if (url.pathname === '/api/pin') return send(res, 200, { ok: true }) // only checks the PIN
    return send(res, 404, { error: 'not found' })
  })
  const port = Number(process.env.CONTROL_PORT || 8080)
  server.listen(port, () => log(`console: http://<this computer>:${port}`))

  // A stream that was set to start by itself (power cut in the hall): start once the console is up.
  const saved = readSettings()
  if (saved.autostart && !missing(buildConfig(process.env, saved)).length) streamer.start(saved)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { streamer.stop(); setTimeout(() => process.exit(0), 1500) })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
