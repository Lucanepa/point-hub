// The uplink keeper (src/uplinkKeeper.js, installed by provisioning/setup-uplink-keeper.sh): wlan1
// converges on the best saved Wi-Fi in range by itself, and the school login behind SCHULEN_KTZH
// is never put at risk — one refusal and it is never tried again, across reboots, until a person
// runs setup-wlan1-client.sh --login; and whatever happens, at most 4 attempts a day, with backoff.
//
// [1]-[8] drive the pure decision and classifier with the profiles the C0270 really has. [9] runs
// the root job end to end against a fake nmcli and a fake journalctl (no NetworkManager needed),
// and [10] checks what the bridge shows from the files it writes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  decide, needsScan, classifyFailure, recordAttempt, resetProfile, emptyState, keeperView, readKeeperView,
  parseConnectionDetail, parseConnectionList, parseDevice, parseScan, failuresToday, EAP_CAP_PER_DAY, BACKOFF_MIN,
} from '../src/uplinkKeeper.js'
import { Uplink } from '../src/hallLogin.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const here = path.dirname(fileURLToPath(import.meta.url))
const KEEPER = path.resolve(here, '..', 'src', 'uplinkKeeper.js')

// The C0270's saved profiles (setup-wlan1-client.sh), keeper-owned school login.
const P = {
  house: { name: 'ledbox-uplink', type: '802-11-wireless', iface: 'wlan1', autoconnect: true, priority: 10, ssid: 'HouseNet', mode: 'infrastructure', band: 'a', keyMgmt: 'sae', eap: false },
  router: { name: 'kscw-router', type: '802-11-wireless', iface: 'wlan1', autoconnect: true, priority: 9, ssid: 'KSCW_eScoresheet', mode: 'infrastructure', band: '', keyMgmt: 'wpa-psk', eap: false },
  school: { name: 'hall-login', type: '802-11-wireless', iface: 'wlan1', autoconnect: false, priority: 8, ssid: 'SCHULEN_KTZH', mode: 'infrastructure', band: 'a', keyMgmt: 'wpa-eap', eap: true },
  hotspot: { name: 'phone-hotspot', type: '802-11-wireless', iface: 'wlan1', autoconnect: true, priority: 6, ssid: 'KSCW-Board', mode: 'infrastructure', band: '', keyMgmt: 'wpa-psk', eap: false },
  free: { name: 'hall-uplink', type: '802-11-wireless', iface: 'wlan1', autoconnect: true, priority: 5, ssid: 'Free_WLAN_KTZH', mode: 'infrastructure', band: '', keyMgmt: '', eap: false },
}
const HALL = [P.router, P.school, P.hotspot, P.free]   // what the hall board has (the house one too, out of range)
const ALL = [P.house, ...HALL]
const seen = (ssid, signal = 60, freq = 5180) => ({ ssid, signal, freq })
const MIN = 60_000
const clockAt = (min, boot = 'boot-A', up0 = 100) => ({ now: Date.UTC(2026, 10, 17, 18, 0) + min * MIN, boot, up: up0 + min * 60 })
const onFree = { state: 100, connection: 'hall-uplink' }
const idle = { state: 30, connection: null }

console.log('\n[1] tonight: on Free_WLAN_KTZH behind its login page, SCHULEN_KTZH in range')
{
  const d = decide({ clock: clockAt(0), device: onFree, profiles: ALL, scan: [seen('Free_WLAN_KTZH', 70, 2412), seen('SCHULEN_KTZH', 62)], online: false })
  ok(d.action === 'up' && d.target === 'hall-login' && d.eap === true, `tries hall-login (${d.action} ${d.target}, ${d.reason})`)
  ok(d.prev === 'hall-uplink', 'and knows to go back to hall-uplink if it fails')
  ok(needsScan({ device: onFree, profiles: ALL, online: false, state: emptyState(), clock: clockAt(0), present: true }), 'offline: it scans')
  const idleD = decide({ clock: clockAt(0), device: idle, profiles: ALL, scan: [seen('SCHULEN_KTZH', 62)], online: false })
  ok(idleD.action === 'up' && idleD.target === 'hall-login' && idleD.reason === 'idle', 'wlan1 idle (every profile blocked by NM): the same')
}

console.log('\n[2] the school login refused → never again, also after a reboot')
{
  const j = "wlan1: CTRL-EVENT-EAP-STARTED EAP authentication started\nwlan1: CTRL-EVENT-EAP-METHOD EAP vendor 0 method 21 (TTLS) selected\nwlan1: CTRL-EVENT-EAP-FAILURE EAP authentication failed\n<warn>  device (wlan1): Activation: failed for connection 'hall-login'"
  const c = classifyFailure({ eap: true, code: 4, out: 'Error: Connection activation failed: Secrets were required, but not provided', journal: j, name: 'hall-login' })
  ok(c.cls === 'refused' && c.why === 'eap-failure', `EAP-FAILURE → refused (${c.cls}/${c.why})`)
  let s = recordAttempt(emptyState(), { p: 'hall-login', eap: true, ok: false, ...c, clock: clockAt(0) })
  ok(s.refused['hall-login'] && s.refused['hall-login'].why === 'eap-failure', 'remembered as refused')
  const scan = [seen('Free_WLAN_KTZH', 70, 2412), seen('SCHULEN_KTZH', 80)]
  for (const [label, clock] of [['2 min later', clockAt(2)], ['an hour later', clockAt(60)], ['a week later', clockAt(7 * 24 * 60)],
    ['after a reboot', clockAt(5, 'boot-B', 40)], ['after a reboot with the clock thrown back', { now: Date.UTC(2026, 9, 2), boot: 'boot-C', up: 50 }]]) {
    const d = decide({ clock, state: s, device: onFree, profiles: ALL, scan, online: false })
    ok(d.action === 'none' && d.blocked.some((b) => b.name === 'hall-login' && b.why === 'refused'), `${label}: no attempt, held back as refused`)
  }
  ok(!needsScan({ device: { state: 100, connection: 'hall-uplink' }, profiles: HALL.filter((p) => p !== P.router && p !== P.hotspot), online: true, state: s, clock: clockAt(3), present: true }),
    'online on Free with only the refused one above it: not even a scan')
  // Anything the classifier cannot positively call "not a refusal" is one.
  const unclear = [
    ['a timeout after EAP started', { code: 3, out: 'Error: Timeout expired (90 seconds)', journal: 'wlan1: CTRL-EVENT-EAP-STARTED EAP authentication started' }],
    ['supplicant took too long, no journal', { code: 4, out: 'Error: Connection activation failed: 802.1X supplicant took too long to authenticate', journal: null }],
    ['no-secrets with an empty journal', { code: 4, out: 'Error: Connection activation failed: Secrets were required, but not provided', journal: '' }],
    ['an error nobody has seen before', { code: 4, out: 'Error: Connection activation failed: something new', journal: 'wlan1: CTRL-EVENT-EAP-STARTED' }],
  ]
  for (const [label, x] of unclear) {
    const r = classifyFailure({ eap: true, name: 'hall-login', ...x })
    ok(r.cls === 'refused' && r.why === 'unclear', `${label} → refused (unclear)`)
  }
  s = resetProfile(s, 'hall-login')
  ok(!s.refused['hall-login'] && failuresToday(s, 'hall-login', clockAt(3)) === 0, '--reset hall-login (what --login runs after a login that worked) clears it')
  const d = decide({ clock: clockAt(3), state: s, device: onFree, profiles: ALL, scan, online: false })
  ok(d.action === 'up' && d.target === 'hall-login', 'and it is tried again')
}

console.log('\n[3] failures that sent no password: retried — with backoff, and at most 4 a day')
{
  const ns = { code: 4, out: 'Error: Connection activation failed: The Wi-Fi network could not be found', journal: '' }
  const c = classifyFailure({ eap: true, name: 'hall-login', ...ns })
  ok(c.cls === 'notseen', `ssid-not-found → ${c.cls}`)
  ok(classifyFailure({ eap: true, name: 'hall-login', code: 4, out: 'Error: Connection activation failed: IP configuration could not be reserved (no available address, timeout, etc.).', journal: '' }).cls === 'ip', 'DHCP after 802.1X → ip (the login was accepted)')
  ok(classifyFailure({ eap: true, name: 'hall-login', code: 4, out: 'x', journal: 'wlan1: CTRL-EVENT-EAP-STARTED\nwlan1: CTRL-EVENT-EAP-TLS-CERT-ERROR reason=1 depth=0 subject=... err=\'certificate is not yet valid\'' }).cls === 'cert', 'certificate refused → cert (the password never left)')
  ok(classifyFailure({ eap: true, name: 'hall-login', code: 4, out: 'Error: Connection activation failed: 802.1X supplicant took too long to authenticate', journal: "wlan1: SME: Trying to authenticate with aa:bb:cc:dd:ee:ff (SSID='SCHULEN_KTZH' freq=5180 MHz)\nwlan1: SME: Authentication timed out" }).cls === 'noeap',
    'association timed out, the journal shows the radio stage and no EAP → noeap')
  ok(classifyFailure({ eap: true, name: 'hall-login', code: 4, out: 'Error: Connection activation failed: The Wi-Fi network could not be found', journal: 'wlan1: CTRL-EVENT-EAP-STARTED' }).cls === 'refused',
    '"not found" but EAP had started → refused, not trusted')
  // NM autoconnecting Free after our failure must not be read as evidence about the school login.
  const after = "wlan1: CTRL-EVENT-EAP-STARTED\n<warn> device (wlan1): Activation: failed for connection 'hall-login'\nwlan1: SME: Trying to authenticate with 11:22:33:44:55:66 (SSID='Free_WLAN_KTZH')\n<info> device (wlan1): state change: ip-config -> failed (reason 'ip-config-unavailable')"
  ok(classifyFailure({ eap: true, name: 'hall-login', code: 4, out: 'Error: Connection activation failed: Secrets were required, but not provided', journal: after }).cls === 'refused',
    'what NM did with Free after our attempt ended is ignored')
  ok(classifyFailure({ eap: true, name: 'hall-login', code: 4, out: 'x', journal: "<warn> device (wlan1): Activation: failed for connection 'hall-login'\nwlan1: CTRL-EVENT-EAP-FAILURE EAP authentication failed" }).cls === 'refused',
    'an EAP-FAILURE logged after the cut still counts')
  ok(classifyFailure({ eap: true, name: 'hall-login', interrupted: true, journal: null }).cls === 'interrupted', 'an attempt cut short with nothing in the journal → interrupted (counted, not a refusal)')
  ok(classifyFailure({ eap: true, name: 'hall-login', interrupted: true, journal: 'wlan1: CTRL-EVENT-EAP-FAILURE' }).cls === 'refused', '…unless the journal kept a refusal')

  const scan = [seen('Free_WLAN_KTZH', 70, 2412), seen('SCHULEN_KTZH', 60)]
  const at = (min, s, boot, up0) => decide({ clock: clockAt(min, boot, up0), state: s, device: onFree, profiles: ALL, scan, online: false })
  let s = emptyState()
  let t = 0
  const tries = []
  for (let k = 0; k < 6; k++) {
    // Look every 2 minutes, try when allowed, fail as "not found" every time.
    for (let guard = 0; guard < 200 && at(t, s).action !== 'up'; guard++) t += 1
    if (at(t, s).action !== 'up') break
    tries.push(t)
    s = recordAttempt(s, { p: 'hall-login', eap: true, ok: false, cls: 'notseen', clock: clockAt(t) })
  }
  ok(tries.length === EAP_CAP_PER_DAY, `${tries.length} attempts in the first day (cap ${EAP_CAP_PER_DAY})`)
  const gaps = tries.slice(1).map((x, i) => x - tries[i])
  ok(gaps.every((g, i) => g >= BACKOFF_MIN[i]), `spaced by the backoff: ${gaps.join(', ')} min (≥ ${BACKOFF_MIN.slice(0, 3).join(', ')})`)
  const capped = at(tries[3] + 120, s)
  ok(capped.action === 'none' && capped.blocked.some((b) => b.why === 'capped'), 'then capped')
  ok(at(tries[0] + 23 * 60, s).action === 'none', '23 h after the first: still capped')
  ok(at(tries[0] + 24 * 60 + 1, s).action === 'up', '24 h after the first: one is free again')
  // A reboot does not reset the count, and neither does the clock jumping forward within a boot.
  ok(at(tries[3] + 10, s, 'boot-B', 30).action === 'none', 'after a reboot: still capped')
  const jumped = { now: clockAt(tries[3]).now + 40 * 24 * 3600_000, boot: 'boot-A', up: clockAt(tries[3] + 10).up }
  ok(decide({ clock: jumped, state: s, device: onFree, profiles: ALL, scan, online: false }).action === 'none',
    'NTP jumps the clock 40 days ahead mid-boot: the monotonic clock still says capped')
  // PSK: retried forever, only spaced.
  let r = emptyState()
  for (let k = 0; k < 6; k++) r = recordAttempt(r, { p: 'kscw-router', eap: false, ok: false, cls: 'failed', clock: clockAt(k * 31) })
  const rd = (min) => decide({ clock: clockAt(min), state: r, device: onFree, profiles: ALL, scan: [seen('KSCW_eScoresheet', 50, 2437)], online: false })
  ok(rd(5 * 31 + 10).action === 'none' && rd(5 * 31 + 31).action === 'up', 'a PSK profile has no cap — 30 min between tries after the 4th')
}

console.log('\n[4] not in range → no attempt')
{
  for (const [label, scan] of [['nothing in range', []], ['SCHULEN too weak (30)', [seen('SCHULEN_KTZH', 30)]],
    ['SCHULEN only on 2.4 GHz, the profile is pinned to 5 GHz', [seen('SCHULEN_KTZH', 70, 2437)]]]) {
    const d = decide({ clock: clockAt(0), device: onFree, profiles: ALL, scan: [seen('Free_WLAN_KTZH', 70, 2412), ...scan], online: false })
    ok(d.action === 'none', `${label}: none (${d.reason})`)
  }
  ok(decide({ clock: clockAt(0), device: onFree, profiles: ALL, scan: [seen('KSCW-Board', 30, 2437)], online: false }).target === 'phone-hotspot',
    'a PSK hotspot at 30 is good enough (only the school login needs 35)')
  ok(decide({ clock: clockAt(0), device: idle, profiles: ALL, scan: [], online: false }).action === 'none', 'idle and nothing in range: none')
}

console.log('\n[5] already on the best → nothing')
{
  const onSchool = { state: 100, connection: 'hall-login' }
  const scan = [seen('SCHULEN_KTZH', 70), seen('Free_WLAN_KTZH', 70, 2412), seen('KSCW-Board', 60, 2437)]
  ok(decide({ clock: clockAt(0), device: onSchool, profiles: ALL, scan, online: true }).action === 'none', 'online on hall-login, only lower ones in range: none')
  ok(decide({ clock: clockAt(0), device: onSchool, profiles: ALL, scan, online: false }).action === 'none', 'even offline on hall-login it never moves DOWN to Free')
  ok(decide({ clock: clockAt(0), device: onFree, profiles: ALL, scan: [seen('Free_WLAN_KTZH', 70, 2412)], online: true }).action === 'none', 'online on Free (logged in by SMS) with nothing better: none')
  for (const st of [40, 50, 60, 70]) ok(decide({ clock: clockAt(0), device: { state: st, connection: 'hall-uplink' }, profiles: ALL, scan, online: false }).reason === 'busy', `wlan1 activating (state ${st}): never a second attempt in flight`)
  ok(decide({ clock: clockAt(0), paused: true, device: onFree, profiles: ALL, scan, online: false }).reason === 'paused', 'paused while --login has wlan1')
  ok(decide({ clock: clockAt(0), clockOk: false, device: onFree, profiles: ALL, scan, online: false }).target !== 'hall-login', 'a clock before 2026: the school login waits (its certificate check would fail)')
}

console.log('\n[6] the club router comes up above → switch')
{
  const onSchool = { state: 100, connection: 'hall-login' }
  const scan = [seen('SCHULEN_KTZH', 70), seen('KSCW_eScoresheet', 55, 2437)]
  const first = decide({ clock: clockAt(0), device: onSchool, profiles: ALL, scan, online: true })
  ok(first.action === 'none' && first.reason === 'confirming' && first.target === 'kscw-router', 'online: first sighting only noted')
  const second = decide({ clock: clockAt(2), run: { sightings: first.sightings }, device: onSchool, profiles: ALL, scan, online: true })
  ok(second.action === 'up' && second.target === 'kscw-router' && second.prev === 'hall-login', 'seen twice in a row: moves up to kscw-router')
  ok(decide({ clock: clockAt(0), device: onSchool, profiles: ALL, scan, online: false }).action === 'up', 'offline: at once')
  ok(decide({ clock: clockAt(0), device: onFree, profiles: ALL, scan, online: false }).target === 'kscw-router', 'from Free with both in range: the router (9) before the school (8)')
}

console.log('\n[7] online on the best → untouched')
{
  const onHouse = { state: 100, connection: 'ledbox-uplink' }
  const scan = ALL.map((p) => seen(p.ssid, 80))
  ok(!needsScan({ device: onHouse, profiles: ALL, online: true, state: emptyState(), clock: clockAt(0), present: true }), 'online on the house network (10): no scan at all')
  ok(decide({ clock: clockAt(0), device: onHouse, profiles: ALL, scan, online: true }).action === 'none', 'and no attempt, everything in range or not')
  const onRouter = { state: 100, connection: 'kscw-router' }
  ok(decide({ clock: clockAt(0), device: onRouter, profiles: HALL, scan, online: true }).action === 'none', 'online on the router at the hall: untouched')
}

console.log('\n[8] parsing nmcli')
{
  const list = parseConnectionList('802-11-wireless:yes:8:hall-login\n802-3-ethernet:yes:100:Wired connection 1\n802-11-wireless:yes:5:hall-uplink\nloopback:no:0:lo\n')
  ok(JSON.stringify(list) === '["hall-login","hall-uplink"]', 'connection list: Wi-Fi profiles only')
  const det = parseConnectionDetail('hall-login', 'connection.id:hall-login\nconnection.type:802-11-wireless\nconnection.interface-name:wlan1\nconnection.autoconnect:yes\nconnection.autoconnect-priority:8\n802-11-wireless.ssid:SCHULEN_KTZH\n802-11-wireless.mode:infrastructure\n802-11-wireless.band:a\n802-11-wireless-security.key-mgmt:wpa-eap\n802-1x.password:\n')
  ok(det.eap && det.priority === 8 && det.band === 'a' && det.ssid === 'SCHULEN_KTZH' && det.autoconnect, 'detail: priority, band, SSID, 802.1X')
  const open = parseConnectionDetail('hall-uplink', 'connection.interface-name:wlan1\nconnection.autoconnect-priority:5\n802-11-wireless.ssid:Free_WLAN_KTZH\n802-11-wireless.band:\n')
  ok(!open.eap && open.keyMgmt === '' && open.band === '', 'an open profile has no security block')
  ok(JSON.stringify(parseDevice('GENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:hall-uplink\n')) === '{"state":100,"connection":"hall-uplink"}', 'device: connected')
  ok(JSON.stringify(parseDevice('GENERAL.STATE:30 (disconnected)\nGENERAL.CONNECTION:\n')) === '{"state":30,"connection":null}', 'device: disconnected')
  const sc = parseScan('62:5180 MHz:WPA2 802.1X:SCHULEN_KTZH\n70:2412 MHz::Free_WLAN_KTZH\n40:2437 MHz:WPA2:a:b:c\n20:5200 MHz:WPA2:--\n')
  ok(sc.length === 3 && sc[0].signal === 62 && sc[0].freq === 5180 && sc[2].ssid === 'a:b:c', 'scan: signal, frequency, an SSID with colons, hidden ones skipped')
}

console.log('\n[9] the root job against a fake NetworkManager')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplink-keeper-'))
{
  const scen = path.join(dir, 'nm.json'), log = path.join(dir, 'calls.log'), jfile = path.join(dir, 'journal.txt')
  // A fake nmcli: answers from nm.json, logs every call, and "connects" what it is told to.
  const fakeNm = path.join(dir, 'nmcli')
  fs.writeFileSync(fakeNm, `#!/usr/bin/env node
const fs = require('fs')
const s = JSON.parse(fs.readFileSync(process.env.FAKE_NM, 'utf8'))
const a = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_NM_LOG, a.join(' ') + '\\n')
const save = () => fs.writeFileSync(process.env.FAKE_NM, JSON.stringify(s))
const j = a.join(' ')
const i = a.indexOf('id')
const name = i >= 0 ? a[i + 1] : null
if (j.includes('device show wlan1')) { console.log('GENERAL.STATE:' + s.device.state + ' (x)\\nGENERAL.CONNECTION:' + (s.device.connection || '')); process.exit(0) }
if (j.endsWith('connection show') ) { for (const [n, p] of Object.entries(s.profiles)) console.log('802-11-wireless:' + p.autoconnect + ':' + p.priority + ':' + n); process.exit(0) }
if (a.includes('show') && name) { const p = s.profiles[name]; console.log(['connection.id:' + name, 'connection.type:802-11-wireless', 'connection.interface-name:wlan1', 'connection.autoconnect:' + p.autoconnect, 'connection.autoconnect-priority:' + p.priority, '802-11-wireless.ssid:' + p.ssid, '802-11-wireless.mode:infrastructure', '802-11-wireless.band:' + (p.band || ''), ...(p.km ? ['802-11-wireless-security.key-mgmt:' + p.km] : [])].join('\\n')); process.exit(0) }
if (j.includes('wifi list')) { for (const r of s.scan) console.log(r.join(':')); process.exit(0) }
if (a.includes('modify') && name) { s.profiles[name].autoconnect = a[a.length - 1]; save(); process.exit(0) }
if (a.includes('down') && name) { process.exit(0) }
if (a.includes('up') && name) { const r = (s.up || {})[name]; if (r) { console.error(r.out); process.exit(r.code) } s.device = { state: 100, connection: name }; save(); process.exit(0) }
process.exit(0)
`, { mode: 0o755 })
  const fakeJ = path.join(dir, 'journalctl')
  fs.writeFileSync(fakeJ, `#!/bin/sh\n[ -f "${jfile}" ] && cat "${jfile}" || exit 1\n`, { mode: 0o755 })

  const portal = http.createServer((req, res) => { res.writeHead(portal.online ? 204 : 302, portal.online ? {} : { location: 'https://login.example/' }); res.end() })
  await new Promise((r) => portal.listen(0, '127.0.0.1', r))
  const probeUrl = `http://127.0.0.1:${portal.address().port}/generate_204`
  const stateFile = path.join(dir, 'var', 'keeper.json'), runFile = path.join(dir, 'run', 'status.json'), pauseFile = path.join(dir, 'run', 'pause')
  const keeper = (args, { boot = 'boot-A', min = 0, up = 100 } = {}) => new Promise((resolve) => {
    fs.writeFileSync(log, '')
    execFile(process.execPath, [KEEPER, ...args], {
      env: { ...process.env, NMCLI: fakeNm, JOURNALCTL: fakeJ, FAKE_NM: scen, FAKE_NM_LOG: log, KEEPER_STATE: stateFile, KEEPER_RUN: runFile,
        KEEPER_PAUSE: pauseFile, KEEPER_PROBE_URL: probeUrl, KEEPER_SETTLE_MS: '0', KEEPER_BOOT_ID: boot,
        KEEPER_NOW: String(clockAt(min).now), KEEPER_UPTIME: String(up + min * 60) },
    }, (err, stdout) => resolve({ code: err ? err.code : 0, out: String(stdout), calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) }))
  })
  const setNm = (s) => fs.writeFileSync(scen, JSON.stringify(s))
  const nm = () => JSON.parse(fs.readFileSync(scen, 'utf8'))
  const tried = (r, name) => r.calls.some((c) => c.includes(`connection up id ${name} `))
  const base = {
    device: { state: 100, connection: 'hall-uplink' },
    profiles: {
      'hall-login': { autoconnect: 'yes', priority: 8, ssid: 'SCHULEN_KTZH', band: 'a', km: 'wpa-eap' },
      'hall-uplink': { autoconnect: 'yes', priority: 5, ssid: 'Free_WLAN_KTZH' },
      'kscw-router': { autoconnect: 'yes', priority: 9, ssid: 'KSCW_eScoresheet', km: 'wpa-psk' },
    },
    scan: [['70', '2412 MHz', '', 'Free_WLAN_KTZH'], ['62', '5180 MHz', 'WPA2 802.1X', 'SCHULEN_KTZH']],
    up: { 'hall-login': { code: 4, out: 'Error: Connection activation failed: Secrets were required, but not provided' } },
  }
  setNm(base)
  fs.writeFileSync(jfile, "wlan1: CTRL-EVENT-EAP-STARTED EAP authentication started\nwlan1: CTRL-EVENT-EAP-FAILURE EAP authentication failed\n<warn> device (wlan1): Activation: failed for connection 'hall-login'\n")
  portal.online = false

  const dry = await keeper(['--dry-run'])
  ok(dry.code === 0 && /"target": "hall-login"/.test(dry.out) && !dry.calls.some((c) => / up |modify/.test(` ${c} `)), '--dry-run says it would try hall-login, and changes nothing')

  let r = await keeper(['--once'])
  ok(r.code === 0, `runs (exit ${r.code})`)
  ok(r.calls.some((c) => c === 'connection modify id hall-login connection.autoconnect no') && nm().profiles['hall-login'].autoconnect === 'no', 'takes over the school login: its NM autoconnect is switched off')
  ok(tried(r, 'hall-login') && r.calls.some((c) => c.startsWith('--wait 90 connection up id hall-login ifname wlan1')), 'tries hall-login, once, on wlan1')
  ok(tried(r, 'hall-uplink'), 'refused: goes straight back to hall-uplink')
  let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  ok(st.refused['hall-login'] && st.refused['hall-login'].why === 'eap-failure' && st.inflight === null, 'state: refused, nothing in flight')
  ok(/REFUSED/.test(r.out), 'and the journal line says so')
  ok((fs.statSync(stateFile).mode & 0o777) === 0o644 && (fs.statSync(runFile).mode & 0o777) === 0o644, 'both files readable by the bridge (0644)')
  const disk = fs.readFileSync(stateFile, 'utf8') + fs.readFileSync(runFile, 'utf8')
  ok(!/SCHULEN|Free_WLAN|KSCW_eScoresheet/.test(disk), 'no SSID in either file — profile names only')

  for (const [label, opt] of [['the next look', { min: 2 }], ['after a reboot', { boot: 'boot-B', min: 5, up: 30 }], ['a day later, another boot', { boot: 'boot-C', min: 26 * 60, up: 30 }]]) {
    setNm({ ...nm(), device: { state: 100, connection: 'hall-uplink' } })
    r = await keeper(['--once'], opt)
    ok(!tried(r, 'hall-login'), `${label}: hall-login not tried`)
  }
  const v = readKeeperView({ stateFile, runFile, now: clockAt(26 * 60).now })
  ok(v.refused && v.refused.profile === 'hall-login' && v.refused.kind === 'school', 'the view the bridge reads: school login refused')

  r = await keeper(['--reset', 'hall-login'])
  ok(r.code === 0 && !JSON.parse(fs.readFileSync(stateFile, 'utf8')).refused['hall-login'], '--reset hall-login clears it')
  setNm({ ...nm(), up: {} })
  r = await keeper(['--once'], { min: 26 * 60 + 2 })
  ok(tried(r, 'hall-login') && nm().device.connection === 'hall-login', 'tried again — and connected')
  const v2 = readKeeperView({ stateFile, runFile, now: clockAt(26 * 60 + 3).now })
  ok(v2.using && v2.using.kind === 'school' && v2.last.ok && !v2.refused && !v2.stale, 'view: on the school Wi-Fi, moved there by itself')

  // Online on the school Wi-Fi, the router appears: two looks, then it switches.
  portal.online = true
  setNm({ ...nm(), scan: [...base.scan, ['55', '2437 MHz', 'WPA2', 'KSCW_eScoresheet']] })
  r = await keeper(['--once'], { min: 26 * 60 + 4 })
  ok(!r.calls.some((c) => c.includes('connection up')), 'online: the router seen once — not yet')
  r = await keeper(['--once'], { min: 26 * 60 + 6 })
  ok(tried(r, 'kscw-router') && nm().device.connection === 'kscw-router', 'seen twice: up to the router')
  r = await keeper(['--once'], { min: 26 * 60 + 8 })
  ok(!r.calls.some((c) => c.includes('wifi list') || c.includes('connection up')), 'online on the best saved network: no scan, no attempt')

  // A --login in progress pauses it.
  setNm({ ...nm(), device: { state: 30, connection: null } })
  fs.writeFileSync(pauseFile, '')
  r = await keeper(['--once'], { min: 26 * 60 + 10 })
  ok(!r.calls.some((c) => c.includes('connection up')) && JSON.parse(fs.readFileSync(runFile, 'utf8')).action.reason === 'paused', 'pause file from --login: hands off')
  fs.rmSync(pauseFile)

  // An attempt killed half-way (power cut): the next run counts it from the journal.
  const s0 = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  fs.writeFileSync(stateFile, JSON.stringify({ ...s0, inflight: { p: 'hall-login', eap: true, at: clockAt(26 * 60 + 11).now, boot: 'boot-C', up: 100 } }))
  fs.writeFileSync(jfile, "wlan1: CTRL-EVENT-EAP-STARTED\nwlan1: CTRL-EVENT-EAP-FAILURE EAP authentication failed\n")
  setNm({ ...nm(), device: { state: 100, connection: 'hall-uplink' }, scan: base.scan })
  portal.online = false
  r = await keeper(['--once'], { boot: 'boot-D', min: 26 * 60 + 14, up: 60 })
  st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  ok(st.inflight === null && st.refused['hall-login'] && !tried(r, 'hall-login'), 'a refusal from an attempt cut short is still a refusal — not tried again')
  portal.close()
}

console.log('\n[10] what the console gets: GET /api/uplink → keeper')
{
  const now = clockAt(0).now
  const persist = recordAttempt(emptyState(), { p: 'hall-login', eap: true, ok: false, cls: 'refused', why: 'eap-failure', clock: clockAt(-3) })
  const runDoc = { checkedAt: new Date(now - 60_000).toISOString(), using: 'hall-uplink', online: false, blocked: [] }
  const view = keeperView(persist, runDoc, now)
  ok(view.refused && view.using.kind === 'free' && view.online === false && !view.stale, 'refused school login, on the free Wi-Fi')
  ok(keeperView(null, null) === null, 'no keeper installed → null')
  ok(keeperView(emptyState(), { checkedAt: new Date(now - 30 * 60_000).toISOString() }, now).stale, 'no look for 30 min → stale')
  let capped = emptyState()
  for (let k = 0; k < 4; k++) capped = recordAttempt(capped, { p: 'hall-login', eap: true, ok: false, cls: 'notseen', clock: clockAt(-60 + k * 10) })
  ok(keeperView(capped, runDoc, now).capped && keeperView(capped, runDoc, now).capped.tries === 4, 'four failures today → capped')
  const up = new Uplink({ login: { sessionExpiresAt: () => null, detect: async () => ({ status: 'portal' }) }, ssid: () => null, keeper: () => view })
  ok(up.view().keeper === view, 'Uplink.view() carries it')
  const plain = new Uplink({ login: { sessionExpiresAt: () => null }, ssid: () => null, keeper: () => { throw new Error('unreadable') } })
  ok(plain.view().keeper === null, 'an unreadable keeper state is null, never an error')
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail ? '❌' : '✅'} uplink keeper: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
