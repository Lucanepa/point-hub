// Does the board still show the score after the link to it drops?
//
// This is the "blank board mid-match" property, and it had zero coverage: every client in the rest
// of the suite is built with `reconnectMs: 0` and no test had ever destroyed a connected socket. So
// the whole class of "the board survives an interruption" — the reconnect repaint, the layout
// re-assert, the decoder's state across connections — was guarded by nothing but the fact that it
// was written correctly the first time.
//
// It matters because the failure is invisible in exactly the wrong way: the process stays alive,
// systemd reports the unit active, the tablet keeps rendering, and only the thing bolted to the
// wall in front of the hall is wrong.

import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import { MockLedbox } from '../src/mockLedbox.js'
import { LedboxClient } from '../src/ledboxClient.js'

const PORT = 18899
let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const settle = (ms = 120) => sleep(ms)

// Late in a tight set — the moment where losing the score is most expensive.
const MATCH = {
  match_id: 'reconnect', current_set: 3, side_a: 'left',
  team_a_name: 'KSC Wiedikon', team_a_short: 'KSCW', team_a_color: '#f5b301',
  team_b_name: 'Volero Zürich', team_b_short: 'VZH', team_b_color: '#ef4444',
  points_a: 22, points_b: 21, sets_won_a: 1, sets_won_b: 1,
  timeouts_a: 1, timeouts_b: 2, subs_a: 0, subs_b: 0, serving_team: 'left',
}

const mock = new MockLedbox()
await mock.listen(PORT)
// A real reconnect delay, unlike the rest of the suite — the behaviour under test only exists when
// the client is allowed to come back.
const client = new LedboxClient({ host: '127.0.0.1', port: PORT, reconnectMs: 50 })

let readies = 0
client.on('ready', () => { readies++ })
client.on('error', () => { /* a destroyed socket raises one; not a failure here */ })

try {
  client.connect()
  await once(client, 'ready')
  await settle()

  console.log('\n[1] the match is on the panel')
  await client.pushState(MATCH)
  await settle()
  ok(mock.text('score1') === '22' && mock.text('score2') === '21', 'panel reads 22-21')
  ok(mock.text('team1') === 'KSCW', 'and the teams are right')
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'on the match layout')

  console.log('\n[2] the link drops mid-match — the exact incident this guards')
  const before = readies
  client.socket.destroy()
  ok(await Promise.race([
    once(client, 'ready').then(() => true),
    sleep(4000).then(() => false),
  ]), `client reconnected on its own (ready fired ${readies - before} more time(s))`)
  await settle(400)

  console.log('\n[3] the score is BACK on the panel, unprompted')
  // Nobody scored a point in between. If this fails the board is sitting blank, or on the crest,
  // in front of the hall, and only the next point would fix it.
  ok(mock.text('score1') === '22' && mock.text('score2') === '21', 'panel still reads 22-21 after the reconnect')
  ok(mock.text('team1') === 'KSCW' && mock.text('team2') === 'VZH', 'teams repainted too')
  ok(mock.text('set1') === '1' && mock.text('set2') === '1', 'set count survived')
  ok(mock.currentLayout === 'volleyball_matchscore_02', 'layout re-asserted, not left on the board default')

  console.log('\n[4] and it still takes the next point')
  await client.pushState({ ...MATCH, points_a: 23 })
  await settle()
  ok(mock.text('score1') === '23', 'a point scored after the reconnect lands (23-21)')

  console.log('\n[5] a second drop is survived the same way')
  client.socket.destroy()
  await Promise.race([once(client, 'ready'), sleep(4000)])
  await settle(400)
  await client.pushState({ ...MATCH, points_a: 24 })
  await settle()
  ok(mock.text('score1') === '24', 'still scoring after a second interruption (24-21)')
  ok(readies >= 3, `handshake completed on every connection (${readies} readies)`)
} catch (err) {
  fail++
  console.log(`  ❌ threw: ${err?.stack || err}`)
} finally {
  client.disconnect()
  await mock.close()
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
