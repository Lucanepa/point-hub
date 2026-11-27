// node streampi/streampi-selftest.mjs — the pure parts of streampi.js: settings, camera and sound
// card picking, ffmpeg's arguments. No camera, no ffmpeg, no browser.
import assert from 'node:assert/strict'
import { buildConfig, missing, maskOutput, cleanSettings, publicSettings, pickVideoDevice, pickAudioCard, ffmpegArgs, overlayRegion } from './streampi.js'

// settings → one stream: YouTube by default, the key after the slash, 1080p unless 720p
const cfg = buildConfig({}, { overlayUrl: 'http://192.168.5.1:8890/overlay', streamKey: 'abcd-1234' })
assert.equal(cfg.OUTPUT, 'rtmps://a.rtmps.youtube.com:443/live2/abcd-1234')
assert.equal(cfg.SIZE, '1920x1080')
assert.equal(cfg.BITRATE, '4500k')
assert.deepEqual(missing(cfg), [])
assert.deepEqual(missing(buildConfig({}, {})), ['the score overlay address', 'the stream key'])
const c720 = buildConfig({}, { quality: '720p', platform: 'other', server: 'rtmp://example.org/live/', streamKey: 'k', source: 'test' })
assert.equal(c720.SIZE, '1280x720')
assert.equal(c720.OUTPUT, 'rtmp://example.org/live/k')
assert.equal(c720.VIDEO_DEVICE, 'test')
// the environment wins (tests write a file)
assert.equal(buildConfig({ OUTPUT: '/tmp/x.mkv' }, { streamKey: 'k' }).OUTPUT, '/tmp/x.mkv')
// the key never reaches a log line or the console
assert.equal(maskOutput('rtmps://a.rtmps.youtube.com:443/live2/abcd-1234'), 'rtmps://a.rtmps.youtube.com:443/live2/•••')
assert.equal(maskOutput('/tmp/x.mkv'), '/tmp/x.mkv')
const saved = cleanSettings({ streamKey: 'secret', platform: 'nope', quality: '4k', autostart: 'yes' })
assert.equal(saved.platform, 'youtube')
assert.equal(saved.quality, '1080p')
assert.equal(saved.autostart, false)
assert.equal(cleanSettings({ streamKey: '' }, saved).streamKey, 'secret', 'an empty key field keeps the saved key')
assert.equal(publicSettings(saved).streamKey, undefined)
assert.equal(publicSettings(saved).streamKeySet, true)

// camera: the Osmo's capture node (index 0), never its metadata node or the laptop's camera
const fw13 = [
  { dev: '/dev/video0', name: 'Laptop Webcam Module (2nd Gen)', index: '0\n' },
  { dev: '/dev/video1', name: 'Laptop Webcam Module (2nd Gen)', index: '1\n' },
  { dev: '/dev/video2', name: 'OsmoAction6_SN:398D5537: OsmoAc', index: '0\n' },
  { dev: '/dev/video3', name: 'OsmoAction6_SN:398D5537: OsmoAc', index: '1\n' },
]
assert.equal(pickVideoDevice(fw13), '/dev/video2')
assert.equal(pickVideoDevice(fw13.slice(0, 2)), null)
assert.equal(pickVideoDevice([{ dev: '/dev/video0', name: 'USB Camera', index: '0' }]), '/dev/video0')

// sound card: the Osmo's, as fw13's /proc/asound/cards lists it (26.11.2026)
const cards = ` 0 [Generic        ]: HDA-Intel - HD-Audio Generic
                      HD-Audio Generic at 0xb04c8000 irq 151
 3 [OsmoAction6SN39]: USB-Audio - OsmoAction6_SN:398D5537
                      DJI OsmoAction6_SN:398D5537 at usb-0000:c3:00.4-1, high speed`
assert.equal(pickAudioCard(cards), 'OsmoAction6SN39')
assert.equal(pickAudioCard(' 0 [Generic ]: HDA-Intel - HD-Audio Generic'), null)

// ffmpeg: camera + microphone + scorebug pipe, all on the wall clock; steady fps; x264 off a Pi 4
const a = ffmpegArgs(cfg, { video: '/dev/video2', audioCard: 'OsmoAction6SN39', pi4: false })
const s = a.join(' ')
assert.match(s, /-f v4l2 -input_format h264 -video_size 1920x1080 -framerate 30 -use_wallclock_as_timestamps 1 .*-i \/dev\/video2/)
assert.match(s, /-f alsa -use_wallclock_as_timestamps 1 .*-i plughw:CARD=OsmoAction6SN39/)
assert.match(s, /-f image2pipe -framerate 4 -use_wallclock_as_timestamps 1 .*-i pipe:0/)
assert.match(s, /\[0:v\]fps=30\[cam\].*overlay=0:0:eof_action=repeat.*\[1:a\]aresample=async=1000\[a\]/)

// only the scorebug's corner is captured and blended: half the width, 45 % of the height
assert.deepEqual(overlayRegion(cfg), { x: 0, y: 0, width: 960, height: 486 })
assert.deepEqual(overlayRegion({ ...cfg, OVERLAY_URL: 'http://b:8890/overlay?corner=br' }), { x: 960, y: 594, width: 960, height: 486 })
assert.deepEqual(overlayRegion({ ...c720, OVERLAY_URL: 'http://b:8890/overlay?corner=tr' }), { x: 640, y: 0, width: 640, height: 324 })
assert.deepEqual(overlayRegion({ ...cfg, OVERLAY_REGION: 'full' }), { x: 0, y: 0, width: 1920, height: 1080 })
assert.match(ffmpegArgs({ ...cfg, OVERLAY_URL: 'http://b:8890/overlay?corner=bl' }, { video: 'test', audioCard: null, pi4: false }).join(' '), /overlay=0:594:/)
assert.match(s, /-c:v libx264 -preset veryfast/)
assert.match(s, /-b:v 4500k -maxrate 4500k -bufsize 9000k -g 60 -keyint_min 60/)
assert.deepEqual(a.slice(-3), ['-f', 'flv', 'rtmps://a.rtmps.youtube.com:443/live2/abcd-1234'])
assert.ok(!s.includes('h264_v4l2m2m'))

// test pattern: no camera, no microphone; a Pi 4: hardware decode + encode; a file: no -f flv
const t = ffmpegArgs({ ...c720, OUTPUT: '/tmp/x.mkv', DURATION: '30' }, { video: 'test', audioCard: null, pi4: false }).join(' ')
assert.match(t, /-re -f lavfi -i testsrc2=size=1280x720:rate=30/)
assert.match(t, /anullsrc/)
assert.match(t, /-t 30 -y \/tmp\/x\.mkv$/)
assert.ok(!t.includes('flv'))
const pi = ffmpegArgs(cfg, { video: '/dev/video0', audioCard: null, pi4: true }).join(' ')
assert.match(pi, /-c:v h264_v4l2m2m -i \/dev\/video0/)
assert.match(pi, /-c:v h264_v4l2m2m -b:v/)

console.log('streampi selftest: ok')
