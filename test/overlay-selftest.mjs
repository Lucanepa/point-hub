// The livestream overlay: /overlay (an OBS browser source), GET /api/overlay.json (a vMix Data
// Source) and the /api/overlay/stream that feeds the page.
//
// What is locked down here:
//   [1] the object itself (src/overlay.js): flat, every key always present, A/B as the public /live
//       row has them (serve re-projected for a linked match on the right), the countdown, and
//       NOTHING else — a state carrying a roster, a referee or a serving player's number must not
//       leak a byte of them onto a broadcast;
//   [2] end to end: the page and the JSON need no PIN on a board that has one, are read-only, are
//       never cached, answer cross-origin reads (and /api/status still does not), and the stream
//       pushes a frame per change — a point, a countdown starting and ending — and none for a
//       change that does not move the scorebug;
//   [3] a streaming PC left running does not count as someone at the console (the panel's QR codes
//       stay), the number of open streams is capped, and a shutdown is not held up by one;
//   [4] the page and the README.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toOverlay, OVERLAY_KEYS, OVERLAY_SETS } from '../src/overlay.js'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STATE = {
  side_a: 'left',
  team_a_name: 'KSC Wiedikon H1', team_a_short: 'kscw', team_a_color: '#1D4ED8',
  team_b_name: 'Volley Zürich', team_b_short: 'VOLZ', team_b_color: '#ef4444',
  points_a: 12, points_b: 9, sets_won_a: 1, sets_won_b: 0, timeouts_a: 1, timeouts_b: 0, subs_a: 2, subs_b: 3,
  serving_team: 'left', set_results: [{ a: 25, b: 21, dur: 1500 }],
}

console.log('[1] the object: flat, complete, public data only')
{
  const idle = toOverlay(null)
  eq(JSON.stringify(Object.keys(idle)), JSON.stringify(OVERLAY_KEYS), 'with no match on the board every key is still there, in order')
  eq(idle.status, 'idle', 'and it says idle')
  ok(idle.team_a === '' && idle.points_a === 0 && idle.set1_a === '' && idle.break === '', 'blank and zero, not missing')

  const o = toOverlay(STATE)
  eq(JSON.stringify(Object.keys(o)), JSON.stringify(OVERLAY_KEYS), 'a live match answers exactly the same keys')
  eq(o.status, 'live', 'status live')
  eq(o.team_a, 'KSCW', 'team A by its short code, in capitals like the panel')
  eq(o.team_a_name, 'KSC Wiedikon H1', 'and its full name as typed')
  eq(o.team_a_color, '#1d4ed8', 'its colour as #rrggbb')
  ok(o.points_a === 12 && o.points_b === 9 && o.sets_a === 1 && o.sets_b === 0, 'points and sets')
  ok(o.timeouts_a === 1 && o.fouls_a === 0, 'timeouts; no fouls outside basketball')
  eq(o.serving, 'a', 'A serves')
  eq(o.period, 2, 'second set')
  eq(o.period_label, 'SET 2', 'labelled for a title')
  eq(o.set_scores, '25-21', 'the finished set as one string')
  ok(o.set1_a === 25 && o.set1_b === 21 && o.set2_a === '' && o[`set${OVERLAY_SETS}_b`] === '', 'and as columns, blank past the sets played')
  ok(!('subs_a' in o) && !JSON.stringify(o).includes('dur'), 'no substitutions, no set durations')

  // A linked OpenVolley match keeps A fixed and says where it stands; serve is a PHYSICAL side.
  const lan = toOverlay({ ...STATE, side_a: 'right', serving_team: 'left' })
  eq(lan.serving, 'b', 'A on the right and the left side serving: B serves')

  // Whatever else a state carries stays off the broadcast.
  const leaky = toOverlay({
    ...STATE,
    roster: [{ name: 'Anna Muster', birthdate: '2009-04-01' }], referee: 'Hans Schiri',
    serve_player: 7, players_a: ['Anna Muster'], gamesheet: { secret: 'x' },
  })
  eq(JSON.stringify(Object.keys(leaky)), JSON.stringify(OVERLAY_KEYS), 'extra fields in the state add no keys')
  const text = JSON.stringify(leaky)
  ok(!/Muster|birthdate|2009-04-01|Schiri|secret/.test(text), 'and none of their values appear anywhere in it')

  const bad = toOverlay({ ...STATE, team_a_color: 'red;background:url(x)', team_b_color: '#12345' })
  ok(bad.team_a_color === '#2563eb' && bad.team_b_color === '#ef4444', 'a colour that is not #rrggbb becomes the board\'s default')

  const long = toOverlay({ ...STATE, team_a_short: '', team_a_name: `Line\nbreak\u0007 ${'x'.repeat(80)}` })
  ok(!/[\u0000-\u001f]/.test(long.team_a_name) && long.team_a_name.length <= 40, `typed names lose control characters and are clamped (${long.team_a_name.length})`)
  ok(long.team_a.startsWith('LINE BREAK'), 'with no short code the name stands in, in capitals')

  const brk = toOverlay(STATE, { countdown: { label: 'time out', team: 'kscw', remainingMs: 22500 } })
  ok(brk.break === 'TIME OUT' && brk.break_team === 'KSCW', 'a timeout on the panel: TIME OUT, KSCW')
  ok(brk.break_seconds === 23 && brk.break_clock === '0:23', 'with 23 s left, as 0:23')
  eq(toOverlay(STATE, { countdown: { label: 'INTERVAL', team: '', remainingMs: 180000 } }).break_clock, '3:00', 'the interval reads 3:00')
  eq(toOverlay(STATE, { countdown: { label: 'X', remainingMs: 0 } }).break, '', 'a countdown that has run out is no break')

  const final = toOverlay({ ...STATE, sets_won_a: 3, sets_won_b: 1, points_a: 0, points_b: 0 })
  eq(final.status, 'final', 'three sets won: final')
  const bb = toOverlay({ ...STATE, period: 2, subs_a: 4, subs_b: 1 }, { sport: 'basketball' })
  ok(bb.period_label === 'Q2' && bb.fouls_a === 4 && bb.fouls_b === 1, 'basketball: Q2, and team fouls (carried in subs on the board)')
  eq(toOverlay({ ...STATE, period: 5 }, { sport: 'basketball' }).period_label, 'OT1', 'overtime')
  eq(toOverlay(STATE, { sport: 'simple' }).period_label, '', 'the simple scoreboard has no sets to label')
}

// SSE, read the way a browser would: frames split on a blank line, `data:` lines parsed.
async function openStream(url, headers = {}) {
  const ac = new AbortController()
  const res = await fetch(url, { headers, signal: ac.signal })
  const frames = []
  if (res.status === 200) {
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const line = chunk.split('\n').find((l) => l.startsWith('data: '))
            if (line) frames.push(JSON.parse(line.slice(6)))
          }
        }
      } catch { /* aborted */ }
    })()
  }
  return { res, frames, close: () => ac.abort() }
}
const until = async (cond, ms = 2000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(20) }
  return cond()
}

console.log('\n[2] end to end: open, read-only, uncached, pushed on every change')
{
  const PIN = '1357'
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-overlay-'))
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ scorerPin: PIN, sport: 'volleyball' }))
  let app
  const streams = []
  try {
    app = await startAppliance({
      stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0, mock: true, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    const post = (p, body) => fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-scorer-pin': PIN }, body: JSON.stringify(body),
    })
    await sleep(200)

    const page = await fetch(base + '/overlay')
    eq(page.status, 200, 'GET /overlay -> 200 with a PIN set on the board, and none sent')
    ok(/^text\/html/.test(page.headers.get('content-type') || ''), 'as HTML')
    const html = await page.text()
    ok(/html,body\{[^}]*background:transparent/.test(html), 'a transparent page, for OBS to composite over the camera')
    ok(/new EventSource\("\/api\/overlay\/stream"\)/.test(html), 'it listens to /api/overlay/stream')
    ok(/fetch\("\/api\/overlay\.json"/.test(html) && /setInterval\(fetchOnce, 3000\)/.test(html), 'and polls /api/overlay.json every 3 s while the stream is down')
    ok(!/(src|href)="https?:/.test(html) && !/@import|url\(http/.test(html), 'nothing loaded from the internet (the board has none)')
    ok(!/innerHTML/.test(html) && /textContent/.test(html), 'team names go in as text, never as markup')
    ok(/HEX\.test/.test(html), 'and only a #rrggbb colour reaches a style')

    let r = await fetch(base + '/api/overlay.json')
    eq(r.status, 200, 'GET /api/overlay.json -> 200, no PIN')
    ok(/^application\/json/.test(r.headers.get('content-type') || ''), 'as JSON')
    eq(r.headers.get('cache-control'), 'no-store', 'never cached — a stale score on a broadcast is the one thing it must not be')
    let o = await r.json()
    eq(o.status, 'idle', 'nothing on the board yet: idle')

    const s1 = await openStream(base + '/api/overlay/stream')
    streams.push(s1)
    eq(s1.res.status, 200, 'GET /api/overlay/stream -> 200, no PIN')
    ok(/^text\/event-stream/.test(s1.res.headers.get('content-type') || ''), 'as an event stream')
    ok(await until(() => s1.frames.length >= 1), 'a frame on connect')
    eq(s1.frames[0] && s1.frames[0].status, 'idle', 'saying idle')

    await post('/api/manual', {})
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW', name: 'KSC Wiedikon' } })
    await post('/api/action', { action: { type: 'team', side: 'right', short: 'VOLZ', name: 'Volley Zürich' } })
    await post('/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    ok(await until(() => s1.frames.some((f) => f.points_a === 1)), 'a point is pushed')
    o = s1.frames[s1.frames.length - 1]
    ok(o.team_a === 'KSCW' && o.team_b === 'VOLZ' && o.status === 'live', 'with the names, live')
    o = await (await fetch(base + '/api/overlay.json')).json()
    ok(o.points_a === 1 && o.team_a === 'KSCW', 'and the JSON agrees')

    // Nothing the scorebug shows changed: no frame.
    const before = s1.frames.length
    await post('/api/action', { action: { type: 'team', side: 'left', short: 'KSCW', name: 'KSC Wiedikon' } })
    await sleep(250)
    eq(s1.frames.length, before, 'a change that does not move the scorebug sends no frame')

    await post('/api/countdown', { seconds: 30, label: 'TIME OUT', content: 'full', side: 'left' })
    ok(await until(() => s1.frames.some((f) => f.break === 'TIME OUT')), 'a timeout on the panel is pushed')
    o = s1.frames[s1.frames.length - 1]
    ok(o.break_team === 'KSCW' && o.break_seconds > 25 && o.break_seconds <= 30, `with the team and the time left (${o.break_seconds} s)`)
    await post('/api/countdown/stop', { expired: false })
    ok(await until(() => s1.frames[s1.frames.length - 1].break === ''), 'and its end too')

    // Read-only: nothing writes through it.
    r = await fetch(base + '/api/overlay.json', { method: 'POST', headers: { 'content-type': 'application/json', 'x-scorer-pin': PIN }, body: '{"points_a":99}' })
    ok(r.status >= 400, `POST /api/overlay.json is refused (${r.status})`)
    o = await (await fetch(base + '/api/overlay.json')).json()
    eq(o.points_a, 1, 'and changed nothing')

    // Cross-origin: the overlay yes, the rest of the board no.
    r = await fetch(base + '/api/overlay.json', { headers: { origin: 'http://graphics.example' } })
    eq(r.headers.get('access-control-allow-origin'), '*', 'a producer\'s page on another origin may read the scorebug')
    r = await fetch(base + '/api/status', { headers: { origin: 'http://graphics.example' } })
    eq(r.headers.get('access-control-allow-origin'), null, 'but still not /api/status')
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    for (const s of streams) s.close()
    if (app) await app.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('\n[3] not a viewer, capped, and never holds a shutdown')
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-overlay-'))
  let app
  const streams = []
  try {
    app = await startAppliance({
      stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0, mock: true, controlPort: 0, debug: false,
    })
    const base = `http://127.0.0.1:${app.server.address().port}`
    await sleep(200)
    ok(!app.ledbox.viewerPresent(), 'a fresh board has nobody at the console')
    await fetch(base + '/api/overlay.json')
    const s = await openStream(base + '/api/overlay/stream')
    streams.push(s)
    await until(() => s.frames.length >= 1)
    await fetch(base + '/overlay')
    ok(!app.ledbox.viewerPresent(), 'the overlay page, its JSON and its stream do not count as one — the QR codes stay')
    await fetch(base + '/api/status')
    ok(app.ledbox.viewerPresent(), 'the console\'s own poll still does')

    // The cap: eight open at once (one is already), the ninth refused, room again once one closes.
    for (let i = 0; i < 7; i++) streams.push(await openStream(base + '/api/overlay/stream'))
    ok(streams.every((x) => x.res.status === 200), `${streams.length} streams open`)
    const over = await openStream(base + '/api/overlay/stream')
    eq(over.res.status, 503, 'the ninth is refused (503) — the page then polls the JSON')
    ok(!!over.res.headers.get('retry-after'), 'with Retry-After')
    over.close()
    streams.shift().close()
    await sleep(150)
    const again = await openStream(base + '/api/overlay/stream')
    streams.push(again)
    eq(again.res.status, 200, 'one closed, one more fits')

    // A shutdown with eight streams open finishes at once (closeStreams ends them).
    const t0 = Date.now()
    await app.close()
    app = null
    const ms = Date.now() - t0
    ok(ms < 2000, `close() with open overlay streams took ${ms} ms`)
  } catch (err) {
    fail++
    console.log(`  ❌ threw: ${err?.stack || err}`)
  } finally {
    for (const s of streams) s.close()
    if (app) await app.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

console.log('\n[4] the README')
{
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  ok(/`\/overlay`/.test(readme) && /`\/api\/overlay\.json`/.test(readme), 'documents /overlay and /api/overlay.json')
  ok(/OBS/.test(readme) && /1920/.test(readme) && /1080/.test(readme), 'with the OBS browser source settings')
  ok(/vMix/.test(readme) && /Data Sources/.test(readme), 'and the vMix Data Source')
  const named = ['team_a', 'team_a_color', 'serving', 'period_label', 'status', 'set_scores', 'break_clock']
  ok(named.every((k) => readme.includes('`' + k)), 'its keys')
  ok(/tailnet/.test(readme) && /no(ne)? internet|has none/.test(readme), 'and how a streaming laptop reaches a board whose Wi-Fi has no internet')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — overlay-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
