// The appliance's own lifecycle and the settings that have to reach the engine — the audit fixes
// that live between startAppliance(), close() and POST /api/settings, each of which failed quietly:
//
//   [1] a /logs tab left open held every shutdown until systemd's stop timeout SIGKILLed us
//   [2] a taken control port left a live process with no UI instead of failing the boot
//   [3] the TLS hot-reload went blind after the FIRST atomic renewal (file watch on a dead inode)
//   [4] "Best of 3" in Settings never reached the scoring engine, so the match never ended
//   [5] a PIN with no digits in it was stripped to "" — the lock silently removed under "Saved."
//   [6] New game left the match log's buffer open, so an abandoned match swallowed the next one
//   [7] the set interval's next-set never reached the resume slot, so Continue brought back 25-23
//
// Plain node, no framework; exits non-zero on any failure.

import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { startAppliance, watchCertificate } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-lifecycle-'))
const boot = (stateDir, extra = {}) => startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
  mock: true, controlPort: 0, debug: false, ...extra,
})
const base = (app) => `http://127.0.0.1:${app.server.address().port}`
const post = async (app, route, body, headers = {}) => {
  const res = await fetch(base(app) + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const get = async (app, route) => (await fetch(base(app) + route)).json()
const within = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)])

const apps = []
try {
  console.log('\n[1] close() finishes while a /logs event stream is open')
  {
    const app = await boot(path.join(scratch, 's1'))
    apps.push(app)
    // A raw request, not fetch: we want a socket that stays open and never reads to the end.
    const stream = await new Promise((resolve, reject) => {
      const req = http.get(`${base(app)}/api/logs/stream`, (res) => resolve({ req, res }))
      req.on('error', reject)
    })
    stream.res.on('data', () => {})
    const ended = new Promise((r) => stream.res.on('close', r))
    const t0 = Date.now()
    const done = await within(app.close(), 3000)
    ok(done, `close() resolved with a stream open (${Date.now() - t0}ms; used to hang until SIGKILL)`)
    ok(await within(ended, 1000), 'the stream was ended, so the browser reconnects to the new process')
    ok(await within(app.close(), 200), 'a second close() (SIGINT after SIGTERM) returns the same shutdown')
  }

  console.log('\n[2] a control port that is already taken fails the boot')
  {
    const blocker = http.createServer()
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
    let err = null
    try { await boot(path.join(scratch, 's2'), { controlPort: blocker.address().port }) } catch (e) { err = e }
    ok(err && err.code === 'EADDRINUSE', `startAppliance rejects (${err && err.code}) instead of idling with no UI`)
    await new Promise((r) => blocker.close(r))
  }

  console.log('\n[3] the TLS reload survives repeated atomic renewals')
  {
    const dir = path.join(scratch, 'tls')
    fs.mkdirSync(dir)
    const cert = path.join(dir, 'board.crt')
    const key = path.join(dir, 'board.key')
    // What `tailscale cert` does: write a temp file, rename it over the target (a new inode).
    const renew = (n) => {
      for (const [f, v] of [[cert, `cert-${n}`], [key, `key-${n}`]]) {
        fs.writeFileSync(`${f}.tmp`, v)
        fs.renameSync(`${f}.tmp`, f)
      }
    }
    renew(1)
    const applied = []
    const quiet = { info() {}, warn() {} }
    const stop = watchCertificate({
      files: [cert, key],
      read: () => ({ cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') }),
      apply: (ctx) => applied.push(ctx.cert),
      log: quiet, debounceMs: 50, pollMs: 60_000,
    })
    for (const n of [2, 3, 4]) { renew(n); await sleep(250) }
    stop()
    ok(applied.includes('cert-2'), 'the first renewal is picked up')
    ok(applied.at(-1) === 'cert-4', `and so are the second and third (last applied: ${applied.at(-1)})`)
    ok(!applied.includes('cert-1'), 'the certificate already being served is not re-applied')

    // The hourly backstop alone, with no watch event at all (a new directory the watch never saw).
    const dir2 = path.join(scratch, 'tls2')
    fs.mkdirSync(dir2)
    const c2 = path.join(dir2, 'a.crt')
    fs.writeFileSync(c2, 'one')
    const got = []
    const stop2 = watchCertificate({
      files: [c2], read: () => ({ cert: fs.readFileSync(c2, 'utf8') }), apply: (ctx) => got.push(ctx.cert),
      log: quiet, debounceMs: 10_000, pollMs: 80,
    })
    await sleep(20)
    fs.writeFileSync(`${c2}.tmp`, 'two!'); fs.renameSync(`${c2}.tmp`, c2)
    await sleep(300)
    stop2()
    ok(got.includes('two!'), 'the periodic check catches a change even when no event is delivered in time')

    // A reload that fails (key and cert out of step mid-renewal) is retried, not forgotten.
    let tries = 0
    const got3 = []
    const stop3 = watchCertificate({
      files: [c2], read: () => ({ cert: fs.readFileSync(c2, 'utf8') }),
      apply: (ctx) => { if (++tries === 1) throw new Error('key values mismatch'); got3.push(ctx.cert) },
      log: quiet, debounceMs: 10_000, pollMs: 60,
    })
    fs.writeFileSync(`${c2}.tmp`, 'three'); fs.renameSync(`${c2}.tmp`, c2)
    await sleep(300)
    stop3()
    ok(got3.includes('three'), 'a failed swap is retried on the next check')
  }

  console.log('\n[4] the saved match format reaches the scoring engine')
  {
    const dir = path.join(scratch, 's4')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ sport: 'volleyball', perSport: { volleyball: { bestOf: 3 } } }))
    const app = await boot(dir)
    apps.push(app)
    ok(app.manualSource.bestOf === 3, `boots at the saved best-of-3 (engine: ${app.manualSource.bestOf})`)
    await post(app, '/api/settings', { bestOf: 5 })
    ok(app.manualSource.bestOf === 5, 'a Settings save changes it live')
    await post(app, '/api/settings', { bestOf: 3 })
    await post(app, '/api/manual')
    // Two sets to one team: in best-of-3 that is the match.
    let ev = null
    // next-set changes ends, so the same team is on the right for its second set.
    for (const side of ['left', 'right']) {
      await post(app, '/api/action', { action: { type: 'point', side, delta: 24 } })
      ev = (await post(app, '/api/action', { action: { type: 'point', side, delta: 1 } })).body.event
      if (side === 'left') await post(app, '/api/action', { action: { type: 'next-set' } })
    }
    ok(ev === 'match-end', `2-0 ends a best-of-3 match (event: ${ev})`)
    await app.close()
  }

  console.log('\n[5] the scorer PIN is validated, never silently stripped')
  {
    const app = await boot(path.join(scratch, 's5'))
    apps.push(app)
    const setPin = await post(app, '/api/settings', { scorerPin: ' 4321 ' })
    ok(setPin.status === 200 && setPin.body.pinSet === true, 'a digits-only PIN is set (surrounding spaces trimmed)')
    const H = { 'x-scorer-pin': '4321' }
    for (const bad of ['abcd', '12.34', '123456789', '12 34']) {
      const r = await post(app, '/api/settings', { scorerPin: bad }, H)
      ok(r.status === 400 && r.body && r.body.error === 'PIN must be 1–8 digits', `"${bad}" is refused with 400`)
    }
    const s = await get(app, '/api/settings')
    ok(s.pinSet === true, 'and the lock is still on after all of them')
    const blank = await post(app, '/api/settings', { scorerPin: '', clubName: 'KSCW' }, H)
    ok(blank.status === 200 && blank.body.pinSet === true, 'an empty PIN field still means "keep it"')
    ok((await post(app, '/api/unlock', { pin: '4321' })).body.ok === true, 'the PIN is the one that was typed')
    const cleared = await post(app, '/api/settings', { clearPin: true }, H)
    ok(cleared.status === 200 && cleared.body.pinSet === false, 'clearPin is the explicit way to remove it')
    await app.close()
  }

  console.log('\n[6] New game closes an abandoned match in the log')
  {
    const app = await boot(path.join(scratch, 's6'))
    apps.push(app)
    await post(app, '/api/settings', { bestOf: 3 })
    await post(app, '/api/manual')
    await post(app, '/api/action', { action: { type: 'team', side: 'left', short: 'OLD', name: 'Old' } })
    await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 7 } }) // abandoned here
    await post(app, '/api/game', { choice: 'new' })
    await post(app, '/api/action', { action: { type: 'team', side: 'left', short: 'NEW', name: 'New' } })
    for (const side of ['left', 'right']) {
      await post(app, '/api/action', { action: { type: 'point', side, delta: 24 } })
      await post(app, '/api/action', { action: { type: 'point', side, delta: 1 } })
      if (side === 'left') await post(app, '/api/action', { action: { type: 'next-set' } })
    }
    const { matches } = await get(app, '/api/history')
    ok(matches.length === 1 && matches[0].team_a === 'NEW', 'one archived match, the one that finished')
    ok(matches[0] && !matches[0].events.some((e) => e.delta === 7), 'with none of the abandoned match\'s rallies in it')
    await app.close()
  }

  console.log('\n[7] the set interval (and an announced change of ends) is saved for Continue')
  {
    const app = await boot(path.join(scratch, 's7'))
    apps.push(app)
    await post(app, '/api/manual')
    await post(app, '/api/action', { action: { type: 'team', side: 'left', short: 'KSCW', name: 'KSC Wiedikon' } })
    await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 24 } })
    await post(app, '/api/action', { action: { type: 'point', side: 'right', delta: 22 } })
    const end = await post(app, '/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
    ok(end.body.event === 'set-end', 'set won 25-22')
    await post(app, '/api/countdown', { seconds: 60, swapFirst: true })
    await post(app, '/api/countdown/stop', { expired: false })
    const saved = (await get(app, '/api/game')).saved
    ok(saved && saved.points.a === 0 && saved.points.b === 0, `the slot holds the NEW set at 0-0 (saved ${saved && `${saved.points.a}-${saved.points.b}`})`)
    ok(saved && saved.sets.a + saved.sets.b === 1, 'with the finished set counted')
    const before = app.manualSource.getState().team_a_name
    await post(app, '/api/message', { text: 'CHANGE ENDS', seconds: 1, swap: true })
    const r = await post(app, '/api/game', { choice: 'continue' })
    ok(r.status === 200 && app.manualSource.getState().team_a_name !== before, 'Continue comes back on the swapped ends')
    const { matches } = await get(app, '/api/history')
    ok(Array.isArray(matches), 'history still reads cleanly')
    await app.close()
  }
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err && err.stack}`)
} finally {
  for (const a of apps) { try { await a.close() } catch { /* already closed */ } }
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
