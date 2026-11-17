// OpenVolley online for devices on the board's Wi-Fi — the bridge's side — and the Link tab's matches
// on OpenVolley's server (the cloud):
//
//   [1] src/ovOnline.js: the helper's JSON trusted only for its shape, the status cached (a console
//       polling /api/status every 1.5 s never forks a sudo per poll), on/off, and every refusal
//       (no forward drop, no nftset, no sudo rule, not installed) in words the console can show
//   [2] the real command line: `sudo -n <helper> on|off|status` (a stand-in helper, no sudo)
//   [3] the routes: /api/status.ovOnline, GET /api/ovonline, POST /api/ovonline behind the PIN
//   [4] GET /api/matches lists the cloud's matches beside the laptop's: the hall's own first, only
//       this board's sport, never a test or a finished match, ids clamped
//   [5] POST /api/link { source: 'cloud' } links one (and a board without the cloud says so)
//   [6] the cloud follow: with the switch ON and exactly one live match from this hall, the board
//       links it by itself — never over a hand-scored game in play, a countdown, a laptop's match or
//       a cloud match still going; once that one has ended, the next takes over. OFF, never.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startAppliance } from '../src/appliance.js'
import { MockLedbox } from '../src/mockLedbox.js'
import { OvOnline, parseStatus, REFUSAL } from '../src/ovOnline.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(got === want, `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const statusLine = (o = {}) => JSON.stringify({
  installed: true, enabled: false, active: false, reason: null, firewall: true, nftset: true, upstream: '192.168.1.1', addresses: 0,
  pieces: { nft: false, forward: false, nat: false, dns: false, ipForward: false }, ap: 'wlan0', uplink: 'wlan1', ...o,
}) + '\n'
const ON = { enabled: true, active: true, addresses: 3, pieces: { nft: true, forward: true, nat: true, dns: true, ipForward: true } }

// A stand-in helper: records its commands, answers like ledbox-ov-online.sh.
function fakeHelper() {
  const h = { calls: [], state: 'off', refuse: null, sudoRefused: false, delayMs: 0 }
  h.run = async (cmd) => {
    h.calls.push(cmd)
    if (h.delayMs) await sleep(h.delayMs)
    if (h.sudoRefused) return { code: 1, stdout: '', stderr: 'sudo: a password is required\n' }
    if (cmd === 'on' && h.refuse) return { code: h.refuse === 'no-nftset' ? 4 : 3, stdout: statusLine({ firewall: h.refuse !== 'no-firewall', nftset: h.refuse !== 'no-nftset' }), stderr: '' }
    if (cmd === 'on') h.state = 'on'
    if (cmd === 'off') h.state = 'off'
    return { code: 0, stdout: statusLine(h.state === 'on' ? ON : {}), stderr: '' }
  }
  return h
}

console.log('[1] ovOnline.js')
{
  ok(parseStatus('noise\n' + statusLine(ON)).active === true, 'the last JSON line of the helper is the status')
  ok(parseStatus('{"installed":false}') === null && parseStatus('not json') === null, '...anything that is not its status is not one')
  const odd = parseStatus(JSON.stringify({ installed: true, enabled: 'yes', active: 1, reason: '<img src=x onerror=1>', upstream: '1.2.3.4; rm', addresses: -5 }))
  ok(odd.enabled === false && odd.active === false && odd.reason === null && odd.upstream === null && odd.addresses === 0, 'only the shape is trusted: no truthy strings, no unknown reason, no odd upstream')

  let t = 0
  const h = fakeHelper()
  const o = new OvOnline({ run: h.run, exists: () => true, ttlMs: 15000, now: () => t })
  let v = o.view()
  ok(v.available === true && v.checking === true, 'first look: checking, and a status asked for in the background')
  await sleep(5)
  v = o.view()
  ok(v.available === true && v.enabled === false && v.active === false && v.reason === null, `then: off (${JSON.stringify(v)})`)
  for (let i = 0; i < 20; i++) o.view()
  eq(h.calls.length, 1, 'twenty polls within the ttl ask the helper no more')
  t += 16000; o.view(); await sleep(5)
  eq(h.calls.length, 2, 'a stale answer is asked for again, once')
  let r = await o.set(true)
  ok(r.ok === true && r.view.enabled === true && r.view.active === true && h.calls.at(-1) === 'on', 'set(true): `on`, enabled and active')
  r = await o.set(false)
  ok(r.ok === true && r.view.enabled === false && h.calls.at(-1) === 'off', 'set(false): `off`')
  h.refuse = 'no-firewall'
  r = await o.set(true)
  ok(r.ok === false && r.reason === 'no-firewall' && r.view.enabled === false, 'no forward drop on the board: refused, still off, reason no-firewall')
  h.refuse = 'no-nftset'
  r = await o.set(true)
  ok(r.ok === false && r.reason === 'no-nftset', 'a dnsmasq without nftset: reason no-nftset')
  h.refuse = null
  h.sudoRefused = true
  r = await o.set(true)
  ok(r.ok === false && r.reason === 'no-sudo', 'no sudo rule for the bridge: reason no-sudo')
  h.sudoRefused = false
  const gone = new OvOnline({ run: h.run, exists: () => false })
  v = gone.view()
  ok(v.available === false && v.reason === 'not-installed', 'no helper installed: not available, not-installed')
  r = await gone.set(true)
  ok(r.ok === false && r.reason === 'not-installed', '...and set() asks nothing')
  ok(['no-firewall', 'no-nftset', 'no-sudo', 'not-installed', 'failed'].every((k) => typeof REFUSAL[k] === 'string' && REFUSAL[k].length > 10), 'each refusal has its sentence for the console')
  // A status poll and a switch at once: the switch's answer is the one kept.
  const h2 = fakeHelper(); h2.delayMs = 30
  const o2 = new OvOnline({ run: h2.run, exists: () => true })
  const p1 = o2.refresh(), p2 = o2.set(true)
  await Promise.all([p1, p2])
  ok(o2.view().enabled === true && h2.calls.join(',') === 'status,on', 'one helper call at a time, the newest answer wins')
}

console.log('\n[2] the command line')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovo-helper-'))
  const helper = path.join(dir, 'ledbox-ov-online')
  fs.writeFileSync(helper, `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(dir, 'args'))}\necho '${statusLine({ enabled: true }).trim()}'\n`, { mode: 0o755 })
  const o = new OvOnline({ helper, sudo: false })
  await o.refresh(); await o.set(true); await o.set(false)
  eq(fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n').join('|'), 'status|on|off', 'the helper is run with exactly status, on, off')
  ok(o.view().enabled === true, '...and its JSON read back')
  // With sudo (the board): `sudo -n <helper> <cmd>` — checked by its arguments, never run here.
  const seen = []
  const sudo = new OvOnline({ helper: '/usr/local/sbin/ledbox-ov-online', exists: () => true })
  sudo._exec = function (cmd) { seen.push(this._sudo ? ['sudo', '-n', this.helper, cmd] : [this.helper, cmd]); return Promise.resolve({ code: 0, stdout: statusLine(), stderr: '' }) }
  sudo._run = (cmd) => sudo._exec(cmd)
  await sudo.set(true)
  eq(seen[0].join(' '), 'sudo -n /usr/local/sbin/ledbox-ov-online on', 'on the board: sudo -n, never a prompt')
  fs.rmSync(dir, { recursive: true, force: true })
}

// --- an appliance on a mock board, with a stand-in helper and a fake cloud ---------------------------
let cloudList = []
let cloudHits = 0
const cloud = http.createServer((req, res) => {
  if (req.url.startsWith('/api/match/list')) cloudHits++
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(req.url.startsWith('/api/match/list') ? { success: true, matches: cloudList } : {}))
})
// 127.0.0.2: a free address, so nothing else on this machine answers for the fake cloud.
await new Promise((r) => cloud.listen(0, '127.0.0.2', r))
const cloudRelay = `ws://127.0.0.2:${cloud.address().port}`

async function boot(extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovo-state-'))
  const mock = new MockLedbox()
  const addr = await mock.listen(0, '127.0.0.1')
  const app = await startAppliance({
    mock: false, ledboxHost: '127.0.0.1', ledboxPort: addr.port, controlPort: 0, stateDir, reconnectMs: 100,
    relayUrl: 'ws://127.0.0.1:9', relayDiscovery: false,
    uplinkProbeUrl: 'http://127.0.0.1:9/generate_204', uplinkPortalUrl: 'http://127.0.0.1:9', ...extra,
  })
  const close = app.close
  app.close = async () => { await close(); await mock.close() }
  const base = `http://127.0.0.1:${app.server.address().port}`
  for (let i = 0; i < 100 && !app.ledbox.ready; i++) await sleep(20)
  return { app, base }
}
const J = (base, p, opts) => fetch(base + p, opts).then((r) => r.json())
const postRaw = (base, p, body = {}, pin = '') => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(pin ? { 'x-scorer-pin': pin } : {}) }, body: JSON.stringify(body) })
const post = (base, p, body = {}, pin = '') => postRaw(base, p, body, pin).then((r) => r.json())

console.log('\n[3] the routes')
{
  const none = await boot()
  eq((await J(none.base, '/api/status')).ovOnline, null, 'a board without the switch: /api/status.ovOnline is null')
  eq((await fetch(none.base + '/api/ovonline')).status, 404, '...and GET /api/ovonline is 404')
  await none.app.close()

  const h = fakeHelper()
  const { app, base } = await boot({ ovOnline: new OvOnline({ run: h.run, exists: () => true }) })
  const st0 = (await J(base, '/api/status')).ovOnline
  ok(st0 && st0.available === true && st0.autoLink === false, `/api/status carries the switch (${JSON.stringify(st0)}), no cloud follow without the cloud`)
  let g = await J(base, '/api/ovonline')
  ok(g.available === true && g.enabled === false && g.pieces && g.pieces.nft === false, 'GET /api/ovonline asks afresh, pieces included')
  await post(base, '/api/settings', { scorerPin: '2468' }, '')
  eq((await postRaw(base, '/api/ovonline', { on: true })).status, 403, 'POST without the PIN: 403')
  ok(h.state === 'off', '...and nothing switched')
  eq((await postRaw(base, '/api/ovonline', { on: 'yes' }, '2468')).status, 400, 'on must be true or false')
  let r = await post(base, '/api/ovonline', { on: true }, '2468')
  ok(r.ok === true && r.ovOnline.enabled === true && r.ovOnline.active === true && h.state === 'on', `with the PIN: on (${JSON.stringify(r)})`)
  ok((await J(base, '/api/status')).ovOnline.enabled === true, '/api/status says on')
  h.refuse = 'no-firewall'; await post(base, '/api/ovonline', { on: false }, '2468')
  r = await post(base, '/api/ovonline', { on: true }, '2468')
  ok(r.ok === false && r.reason === 'no-firewall' && r.error === REFUSAL['no-firewall'] && r.ovOnline.enabled === false, 'a refusal: ok false, its sentence, still off')
  await app.close()
}

console.log('\n[4] the cloud\'s matches on the Link tab')
{
  const { app, base } = await boot({ cloudRelay })
  cloudList = [
    { id: 'away1', gameNumber: '900001', homeTeam: 'Elsewhere A', awayTeam: 'Elsewhere B', status: 'live', sportType: 'indoor', refereeConnectionEnabled: true },
    { id: 'hall1', gameNumber: '406300', homeTeam: 'KSCW H3', awayTeam: 'Volley Visitors', status: 'live', sportType: 'indoor', refereeConnectionEnabled: false },
    { id: 'hall2', gameNumber: '406301', homeTeam: 'KSCW D1', awayTeam: 'Guests', status: 'scheduled', sportType: 'indoor', refereeConnectionEnabled: false },
    { id: 'beach1', gameNumber: 'B1', homeTeam: 'Sand', awayTeam: 'Dune', status: 'live', sportType: 'beach', refereeConnectionEnabled: false },
    { id: 'test1', gameNumber: 'T', homeTeam: 'Test', awayTeam: 'Test', status: 'live', sportType: 'indoor', test: true },
    { id: 'done1', gameNumber: 'D', homeTeam: 'Done', awayTeam: 'Done', status: 'ended', sportType: 'indoor' },
    { id: '"><img src=x onerror=alert(1)>', gameNumber: '1', homeTeam: 'X\u0000Y', awayTeam: 'Z', status: 'live', sportType: 'indoor', refereeConnectionEnabled: true },
  ]
  const r = await J(base, '/api/matches')
  const c = r.matches.filter((m) => m.source === 'cloud')
  ok(r.cloud && r.cloud.ok === true && r.cloud.address === `127.0.0.2:${cloud.address().port}`, `the cloud answered (${JSON.stringify(r.cloud)})`)
  eq(c.map((m) => m.id).join(','), 'hall1,hall2,away1,imgsrcxonerroralert1', 'the hall\'s own first (live, then scheduled), then the others; no beach, no test, no finished match')
  const h1 = c[0]
  ok(h1.hall === true && h1.live === true && h1.referee === false && h1.label === '406300 KSCW H3-Volley Visitors', `a hall match: ${JSON.stringify(h1)}`)
  ok(c[2].hall === false && c[2].referee === true, 'referee connection on and not in this board\'s schedule: not known to be from this hall')
  ok(!c.some((m) => /[<>"\u0000]/.test(m.id + m.label)), 'ids and labels clamped (the console posts the id straight back)')
  ok(r.relay.ok === false && r.errors.length === 1 && /^lan:/.test(r.errors[0]), 'the laptop search reports as before, the cloud is not an error')
  await app.close()
  // The cloud not answering: an empty cloud section with its reason, nothing else changes.
  const down = await boot({ cloudRelay: 'ws://127.0.0.1:9' })
  const d = await J(down.base, '/api/matches')
  ok(d.cloud && d.cloud.ok === false && /cloud:/.test(d.cloud.error) && !d.matches.length, `the cloud not answering: cloud.ok false (${d.cloud && d.cloud.error})`)
  await down.app.close()
  const off = await boot()
  ok((await J(off.base, '/api/matches')).cloud === null, 'a board without the cloud (a test config) never asks it')
  await off.app.close()
}

console.log('\n[5] linking a cloud match')
{
  const { app, base } = await boot({ cloudRelay })
  const r = await post(base, '/api/link', { source: 'cloud', matchId: 'hall1' })
  ok(r.mode === 'lan' && r.matchId === 'hall1' && r.linkSource === 'cloud' && r.relay && r.relay.source === 'cloud', `linked: mode lan, linkSource cloud (${r.mode} ${r.matchId} ${r.linkSource})`)
  eq(app.sourceManager.active.relayUrl, cloudRelay, 'subscribed on the cloud relay')
  eq((await postRaw(base, '/api/link', { source: 'cloud' })).status, 400, 'no matchId: 400')
  await app.close()
  const none = await boot()
  eq((await postRaw(none.base, '/api/link', { source: 'cloud', matchId: 'x' })).status, 501, 'a board without the cloud: 501')
  await none.app.close()
}

console.log('\n[6] the cloud follow (OpenVolley online ON)')
{
  const h = fakeHelper()
  const { app, base } = await boot({ cloudRelay, ovOnline: new OvOnline({ run: h.run, exists: () => true, ttlMs: 0 }) })
  const status = () => J(base, '/api/status')
  const follow = () => app.server.followCloudScorer()
  const hall = (id, live = true) => ({ id, gameNumber: id, homeTeam: 'KSCW', awayTeam: 'Guests', status: live ? 'live' : 'scheduled', sportType: 'indoor', refereeConnectionEnabled: false })
  ok((await status()).ovOnline.autoLink === true, 'the switch says the board follows a cloud match by itself')

  cloudList = [hall('c1')]
  cloudHits = 0
  await J(base, '/api/ovonline') // the view now says off
  await follow()
  ok((await status()).mode !== 'lan' && cloudHits === 0, 'switch OFF: nothing followed, the cloud not even asked')

  await post(base, '/api/ovonline', { on: true })
  await J(base, '/api/ovonline')
  cloudList = []
  await follow()
  ok((await status()).mode !== 'lan', 'ON, no live match: nothing')
  cloudList = [hall('c1', false)]
  await follow()
  ok((await status()).mode !== 'lan', 'a scheduled one is not followed until it is live')
  cloudList = [hall('c1'), hall('c2')]
  await follow()
  ok((await status()).mode !== 'lan', 'two live from this hall: it does not guess')
  cloudList = [{ ...hall('x1'), refereeConnectionEnabled: true }]
  await follow()
  ok((await status()).mode !== 'lan', 'one live, but not known to be from this hall: not followed')

  // A hand-scored game in play is never taken over.
  await post(base, '/api/manual')
  await post(base, '/api/action', { action: { type: 'point', side: 'left', delta: 1 } })
  cloudList = [hall('c1')]
  await follow()
  let st = await status()
  ok(st.mode === 'manual', `a hand-scored game in play: not taken over (mode ${st.mode})`)
  await post(base, '/api/action', { action: { type: 'reset' } })

  // A countdown is never interrupted.
  await post(base, '/api/countdown', { seconds: 60, label: 'WARM-UP' })
  await follow()
  ok((await status()).mode !== 'lan', 'a countdown running: not taken over')
  await post(base, '/api/countdown/stop', { expired: false })

  await follow()
  st = await status()
  ok(st.mode === 'lan' && st.matchId === 'c1' && st.linkSource === 'cloud', `nothing else on the board: the one live hall match is followed (${st.mode} ${st.matchId} ${st.linkSource})`)
  cloudList = [hall('c1'), hall('c2')]
  await follow()
  eq((await status()).matchId, 'c1', 'a second one appearing does not take over')
  cloudList = [hall('c2')]
  await follow()
  eq((await status()).matchId, 'c1', 'the linked one gone from the list but not ended (a dropped scorer): stays')
  // The linked match ends (the scorer closed it): the next live one takes over.
  app.sourceManager.active.emit('match-ended', app.sourceManager.getState() || {})
  await sleep(50)
  eq((await status()).link, 'ended', 'the linked cloud match ended')
  await follow()
  eq((await status()).matchId, 'c2', 'once it has ended, the next live one takes over')

  // A laptop's match (linked by hand on the Link tab) is never taken over.
  const laptop = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ matches: [{ id: 'lap1', status: 'live' }] })) })
  await new Promise((r) => laptop.listen(0, '127.0.0.3', r))
  await post(base, '/api/settings', { relayAddress: `127.0.0.3:${laptop.address().port}` })
  await J(base, '/api/matches')
  await post(base, '/api/link', { source: 'lan', matchId: 'lap1', relay: `127.0.0.3:${laptop.address().port}` })
  st = await status()
  ok(st.matchId === 'lap1' && st.linkSource === 'lan', 'the laptop\'s match linked by hand')
  app.sourceManager.active.emit('match-ended', app.sourceManager.getState() || {})
  cloudList = [hall('c3')]
  await follow()
  eq((await status()).matchId, 'lap1', 'a laptop\'s match is never taken over by the cloud, ended or not')
  laptop.close()

  // OFF again: the board stops asking.
  await post(base, '/api/ovonline', { on: false })
  await J(base, '/api/ovonline')
  await post(base, '/api/manual')
  cloudHits = 0
  await follow()
  ok((await status()).mode === 'manual' && cloudHits === 0, 'switched off: no follow, the cloud not asked')
  await app.close()
}

cloud.close()
console.log(`\n${fail ? '❌' : '✅'} ov-online: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
