// The uplink keeper: keeps the board's second radio (wlan1) on the best saved Wi-Fi that is in
// range, without ever risking the school account behind SCHULEN_KTZH.
//
// Why it exists. NetworkManager joins the best saved network it can see AT THE MOMENT it connects,
// and then stays: it does not leave a working connection for a better one that appears later, and
// a profile it failed once (the SSID not seen yet at boot, an association timeout, auth-retries=1
// used up) has its autoconnect blocked until the next reboot. Nothing ever tries it again. On
// 17.11.2026 the C0270 came up at the KWI hall on Free_WLAN_KTZH (behind its SMS login page, so
// offline) while SCHULEN_KTZH — which it had used on 02.11 and 13.11 — was right there. Nobody could
// reach the board. The owner's rule is plug and play: power on, and it sorts itself out.
//
// So every two minutes (a root loop, provisioning/setup-uplink-keeper.sh) this looks at wlan1 —
// the active connection, whether the board is really online, which saved profiles' SSIDs a scan
// shows and how strong — and if a saved profile with a HIGHER priority than the active one is in
// range (or any, when wlan1 is idle), it brings that one up. It only ever moves UP: the Free Wi-Fi
// fallback and the console's SMS login (hallLogin.js) are left exactly as they were, and a board
// online over the best network it can see is never touched.
//
// The school login is the dangerous one. The LEUnet handbook: wrong credentials and too many
// attempts LOCK the account for up to 8 hours, and it is a real person's school account. So for any
// 802.1X profile (key-mgmt wpa-eap) the keeper is strict:
//   - it owns the profile's attempts: its NM autoconnect is switched off, so a stale password is
//     never presented by NM on its own at every boot (~2 strikes each, see setup-wlan1-client.sh);
//   - every failed attempt is classified from NM's answer and wpa_supplicant's journal. Only what is
//     POSITIVELY known not to have been a refusal (the SSID was not found, the TLS certificate was
//     refused so the password was never sent, EAP never even started, or EAP succeeded and DHCP
//     failed after it) is retried. Anything else — including an answer this code cannot read —
//     counts as a refusal;
//   - after ONE refusal it never tries that profile again, across reboots, until someone runs
//     setup-wlan1-client.sh --login again (or --reset here). The console says so in words;
//   - whatever the classification, at most EAP_CAP_PER_DAY attempts in 24 h, with backoff.
//
// Zero dependencies and self-contained (only node: builtins), because the root job runs a
// root-owned COPY of this file (/usr/local/lib/ledbox/uplink-keeper.mjs), not the one the bridge's
// user can write. The bridge imports keeperView() from here to show what the keeper last did; it
// only ever READS the two state files, which hold profile names and times — never an SSID (see
// systemInfo.js on why the console does not name networks) and never a secret.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const IFACE = 'wlan1'
// Persistent (attempts, refusals): survives a reboot, so a power cycle at the hall does not buy
// the school login a fresh set of strikes. Written only when an attempt happens — the SD card.
export const STATE_FILE = '/var/lib/ledbox-uplink/keeper.json'
// Volatile (what the last look saw): tmpfs, rewritten every run for free.
export const RUN_FILE = '/run/ledbox-uplink/status.json'
// setup-wlan1-client.sh --login drops this while it has wlan1 in its hands. Older than
// PAUSE_MAX_MS = a --login that died without its trap; ignored then.
export const PAUSE_FILE = '/run/ledbox-uplink/pause'
const PAUSE_MAX_MS = 15 * 60_000

// At most 4 school-login attempts that did not end connected in any 24 h, whatever they were
// classified as. The classifier lets through only failures that sent no password (or whose
// password was accepted), so this is the backstop for the day it is wrong. 4 because: each
// attempt is one `nmcli connection up` of a profile with auth-retries=1 and auth-timeout=12, which
// is at most ~2 EAP exchanges (setup-wlan1-client.sh --login), so even 4 misread refusals stay
// near the lower end of where directory lockouts usually start (5-10 bad logins); and 4 still
// covers what really happens at boot — the SSID not seen yet, a weak first association — with the
// backoff below spreading them over ~25 minutes instead of four in a row.
export const EAP_CAP_PER_DAY = 4
// Minutes to wait after the 1st, 2nd, 3rd, 4th+ consecutive failure of the same profile. A PSK or
// open profile simply keeps going at the last step (retrying those costs nothing but a moment).
export const BACKOFF_MIN = [2, 5, 15, 30]
// NM's SIGNAL, 0-100. Below this an attempt mostly ends in an association timeout — harmless for a
// PSK profile, but for the school login it spends one of only four attempts for nothing.
export const MIN_SIGNAL = 25
export const MIN_SIGNAL_EAP = 35
// While the board is ONLINE on a lower profile, a better one must be seen in two looks in a row
// (~2 min) before the working link is dropped for it: one sighting at the edge of range is not
// worth cutting live scoring for. Offline, one look is enough — there is nothing to lose.
export const STABLE_SIGHTINGS = 2
const WAIT_S = 90               // nmcli --wait for one attempt: 802.1X (12 s max) + DHCP (45 s)
const DAY_S = 24 * 3600

// What the console calls each of setup-wlan1-client.sh's profiles. Roles, never SSIDs.
export const PROFILE_KINDS = {
  'hall-login': 'school',
  'kscw-router': 'router',
  'phone-hotspot': 'hotspot',
  'hall-uplink': 'free',
  'ledbox-uplink': 'house',
}
export function kindOf(name, eap = false) {
  return PROFILE_KINDS[name] || (eap ? 'school' : 'other')
}

// ── parsing nmcli ─────────────────────────────────────────────────────────────────────────────
// Everything is asked for with `-t -e no` and with the one field that can hold a ':' (a name, an
// SSID) LAST, so whatever follows the fixed fields is that value verbatim.

const after = (line, n) => { let s = line; for (let i = 0; i < n; i++) { const k = s.indexOf(':'); if (k < 0) return null; s = s.slice(k + 1) } return s }
const head = (line, n) => line.split(':').slice(0, n)

// `nmcli -t -e no -f TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,NAME connection show`
export function parseConnectionList(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    const [type] = head(line, 1)
    const name = after(line, 3)
    if (name == null || !name) continue
    if (type !== '802-11-wireless' && type !== 'wifi') continue
    out.push(name)
  }
  return out
}

// `nmcli -t -e no connection show id <name>` — "property:value" lines. Secrets are not printed
// without --show-secrets, and nothing but the fields below is kept anyway.
export function parseConnectionDetail(name, text) {
  const v = {}
  for (const line of String(text || '').split('\n')) {
    const k = line.indexOf(':')
    if (k <= 0) continue
    v[line.slice(0, k)] = line.slice(k + 1)
  }
  const keyMgmt = (v['802-11-wireless-security.key-mgmt'] || '').trim()
  const pr = Number.parseInt(v['connection.autoconnect-priority'], 10)
  const band = (v['802-11-wireless.band'] || '').trim()
  return {
    name,
    type: v['connection.type'] || '802-11-wireless',
    iface: (v['connection.interface-name'] || '').replace(/^--$/, ''),
    autoconnect: (v['connection.autoconnect'] || 'yes') === 'yes',
    priority: Number.isFinite(pr) ? pr : 0,
    ssid: v['802-11-wireless.ssid'] || '',
    mode: v['802-11-wireless.mode'] || 'infrastructure',
    band: band === '--' ? '' : band,
    keyMgmt: keyMgmt === '--' ? '' : keyMgmt,
    eap: keyMgmt === 'wpa-eap',
  }
}

// `nmcli -t -e no -f GENERAL.STATE,GENERAL.CONNECTION device show wlan1`
// state: NM's device state number — 10 unmanaged, 20 unavailable, 30 disconnected, 40-90 on the
// way up (prepare, config, need-auth, ip-config, ip-check, secondaries), 100 activated, 110+ going down.
export function parseDevice(text) {
  let state = 0, connection = null
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('GENERAL.STATE:')) state = Number.parseInt(line.slice(14), 10) || 0
    else if (line.startsWith('GENERAL.CONNECTION:')) {
      const c = line.slice(19).trim()
      connection = c && c !== '--' ? c : null
    }
  }
  return { state, connection }
}

// `nmcli -t -e no -f SIGNAL,FREQ,SECURITY,SSID device wifi list ifname wlan1 --rescan auto`
export function parseScan(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    const [sig, freq] = head(line, 2)
    const ssid = after(line, 3)
    if (!ssid || ssid === '--') continue
    out.push({ ssid, signal: Number.parseInt(sig, 10) || 0, freq: Number.parseInt(freq, 10) || 0 })
  }
  return out
}

// ── failure classification ────────────────────────────────────────────────────────────────────
// What Debian bookworm's NetworkManager (1.42) and wpa_supplicant (2.10) say. nmcli's own error is
// about OUR activation and nothing else; the journal (NetworkManager + wpa_supplicant units, since
// the attempt started, lines naming wlan1 or the profile) adds what only wpa_supplicant knows —
// whether the password ever reached the server.
//
//   nmcli: "Error: Connection activation failed: <reason>", exit 4; "Timeout expired", exit 3;
//          exit 10 = the connection/device/access point does not exist.
//     reasons: "Secrets were required, but not provided" (no-secrets — how a refused 802.1X login
//              ends once auth-retries is used up), "802.1X supplicant disconnected|failed|took too
//              long to authenticate", "The Wi-Fi network could not be found" (ssid-not-found),
//              "IP configuration could not be reserved (no available address, timeout, etc.)",
//              "DHCP client failed…".
//   wpa_supplicant (logs to the journal, `-s` in Debian's unit):
//              "wlan1: CTRL-EVENT-EAP-STARTED", "…-EAP-PROPOSED-METHOD", "…-EAP-METHOD" = EAP began,
//              so the outer identity went out and the password may have; "CTRL-EVENT-EAP-FAILURE
//              EAP authentication failed" = the server REFUSED (a strike); "CTRL-EVENT-EAP-TLS-CERT-
//              ERROR" = the server certificate was refused, so with TTLS/PAP the password (inside
//              the tunnel) was never sent; "CTRL-EVENT-EAP-SUCCESS" = accepted; "SME: Trying to
//              authenticate", "Trying to associate", "Associated with" = it reached the radio stage.
//
// NM's log line "Activation: failed for connection '<name>'" ends our attempt: what follows is NM
// autoconnecting something else (Free_WLAN_KTZH's DHCP failing, say), and must not be read as
// evidence about the school login. The EAP-FAILURE count alone uses the whole window — it can only
// be the school login (the one 802.1X profile), and over-counting a refusal is the safe direction.
//
// Returns { cls, why }: cls 'refused' | 'cert' | 'ip' | 'notseen' | 'noeap' | 'interrupted' |
// 'failed'. For an 802.1X profile only 'refused' stops it for good; 'why' says how sure: 'eap-
// failure' (the server said no) or 'unclear' (nothing proved it was not a refusal).
export function classifyFailure({ eap, code = null, out = '', journal = null, name = '', interrupted = false }) {
  const o = String(out || '')
  const all = (journal == null ? '' : String(journal)).split('\n').filter((l) => l.includes(IFACE) || (name && l.includes(`'${name}'`)))
  const cut = all.findIndex((l) => name && l.includes(`Activation: failed for connection '${name}'`))
  const mine = (cut >= 0 ? all.slice(0, cut + 1) : all).join('\n')
  const whole = all.join('\n')

  const eapFailure = /CTRL-EVENT-EAP-FAILURE|EAP authentication failed/i.test(whole)
  const certError = /CTRL-EVENT-EAP-TLS-CERT-ERROR|TLS-CERT-ERROR|Domain suffix mismatch|certificate verify failed/i.test(mine)
  const eapStarted = /CTRL-EVENT-EAP-(STARTED|PROPOSED-METHOD|METHOD)/i.test(mine)
  const eapSuccess = /CTRL-EVENT-EAP-SUCCESS|EAP authentication completed successfully/i.test(mine)
  // wpa_supplicant demonstrably logged this attempt's radio stage: then the ABSENCE of any EAP
  // line means EAP never started. Without these lines (no journal, or wpa_supplicant not logging)
  // absence proves nothing.
  const radioSeen = /SME: Trying to authenticate|Trying to associate|Associated with|CTRL-EVENT-ASSOC-REJECT|CTRL-EVENT-AUTH-REJECT|Authentication with .* timed out|SME: Authentication timed out/i.test(mine)
  const notFound = code === 10 || /could not be found|ssid-not-found/i.test(o)
  const ipFail = /IP configuration could not be reserved|ip-config-unavailable|DHCP client (failed|error)|dhcp-(failed|error|start-failed)/i.test(o)

  if (!eap) {
    // Informational only: a PSK or open profile is retried with backoff whatever went wrong.
    if (/4-Way Handshake failed|pre-shared key may be incorrect|WRONG_KEY/i.test(mine) || /Secrets were required/i.test(o)) return { cls: 'refused', why: 'psk' }
    if (notFound) return { cls: 'notseen', why: 'nm' }
    if (ipFail) return { cls: 'ip', why: 'nm' }
    return { cls: interrupted ? 'interrupted' : 'failed', why: 'nm' }
  }
  if (eapFailure) return { cls: 'refused', why: 'eap-failure' }
  if (certError) return { cls: 'cert', why: 'tls' }                 // the password was never sent
  if (eapSuccess) return { cls: 'ip', why: 'eap-success' }           // accepted; what failed came after
  if (ipFail) return { cls: 'ip', why: 'nm' }                        // NM starts IP config only after 802.1X completed
  if (notFound && !eapStarted) return { cls: 'notseen', why: 'nm' }  // never associated, so never sent anything
  if (radioSeen && !eapStarted) return { cls: 'noeap', why: 'journal' }
  // An attempt cut short (power loss, a kill) left no answer to read. The server did not answer it
  // either as far as anyone knows, so it is NOT a refusal — but it does count towards the cap and
  // the backoff. Only reached when the journal shows nothing that settles it.
  if (interrupted) return { cls: 'interrupted', why: 'unknown' }
  return { cls: 'refused', why: 'unclear' }
}

// ── the clock ─────────────────────────────────────────────────────────────────────────────────
// The board has no RTC: at boot its wall clock is the last shutdown (fake-hwclock) and it jumps
// forward at the first NTP sync — by hours, or weeks. Within one boot, time is measured on the
// monotonic uptime, so neither a jump nor a stale clock can shorten a backoff or empty the 24 h
// window. Across boots only the wall clock is left; a timestamp that is in the "future" (the clock
// went back) counts as having happened at the start of this boot.

function elapsedS(rec, clock) {
  if (rec.boot && rec.boot === clock.boot && Number.isFinite(rec.up)) return clock.up - rec.up
  const d = (clock.now - rec.at) / 1000
  return d >= 0 ? d : clock.up
}

export function failuresToday(state, name, clock) {
  return (state.attempts || []).filter((a) => a.p === name && !a.ok && elapsedS(a, clock) < DAY_S).length
}

export function backoffLeftS(state, name, clock) {
  const f = state.fails && state.fails[name]
  if (!f || !f.n) return 0
  const wait = BACKOFF_MIN[Math.min(f.n, BACKOFF_MIN.length) - 1] * 60
  return Math.max(0, wait - elapsedS(f, clock))
}

export function blockedWhy(p, state, clock, clockOk = true) {
  if (p.eap && state.refused && state.refused[p.name]) return 'refused'
  if (p.eap && !clockOk) return 'clock'           // the certificate check would fail on the dates
  if (p.eap && failuresToday(state, p.name, clock) >= EAP_CAP_PER_DAY) return 'capped'
  if (backoffLeftS(state, p.name, clock) > 0) return 'backoff'
  return null
}

// ── the decision ──────────────────────────────────────────────────────────────────────────────

export function emptyState() {
  return { v: 1, attempts: [], refused: {}, fails: {}, inflight: null }
}

// The profiles the keeper may bring up: Wi-Fi clients on wlan1 that NM would autoconnect anyway,
// plus 802.1X ones, whose autoconnect the keeper itself switched off to own their attempts.
export function eligible(p) {
  return (p.type === '802-11-wireless' || p.type === 'wifi') && (p.iface === IFACE || p.iface === '')
    && p.mode !== 'ap' && !!p.ssid && (p.autoconnect || p.eap)
}

function bandOk(band, freq) {
  if (band === 'a') return freq >= 4900
  if (band === 'bg') return freq > 0 && freq < 3000
  return true
}

export function signalOf(p, scan) {
  let best = -1
  for (const r of scan || []) if (r.ssid === p.ssid && bandOk(p.band, r.freq) && r.signal > best) best = r.signal
  return best
}

const ACTIVATING = (st) => st >= 40 && st < 100

// Whether this look needs a Wi-Fi scan at all. Online on a profile nothing unblocked outranks:
// no — and no scan is the quietest thing a radio sharing the hall's air can do.
export function needsScan({ paused, present, device, profiles, online, state, clock, clockOk = true }) {
  if (paused || !present || !device || ACTIVATING(device.state) || device.state < 30) return false
  if (device.state !== 100 || !online) return true
  const active = profiles.find((p) => p.name === device.connection)
  const floor = active ? active.priority : 0
  return profiles.some((p) => eligible(p) && p.name !== device.connection && p.priority > floor && !blockedWhy(p, state, clock, clockOk))
}

// Pure: what to do now. Never acts. Returns { action: 'none'|'up', reason, target?, prev?, eap?,
// sightings, blocked } — `blocked` lists profiles in range that are held back, and why (the
// console shows a refused or capped school login from it).
export function decide({ clock, state = emptyState(), run = {}, paused = false, present = true, device, profiles = [], scan = [], online = false, clockOk = true }) {
  const prevSight = (run && run.sightings) || {}
  const sightings = {}
  const blocked = []
  const out = (action, reason, extra = {}) => ({ action, reason, sightings, blocked, ...extra })
  if (paused) return out('none', 'paused')
  if (!present) return out('none', 'no-wlan1')
  if (!device || device.state < 30) return out('none', 'not-ready')
  if (ACTIVATING(device.state)) return out('none', 'busy')          // NM, or someone, is already on it
  if (device.state > 100) return out('none', 'busy')                 // going down: let it finish

  const active = device.state === 100 && device.connection
    ? profiles.find((p) => p.name === device.connection) || { name: device.connection, priority: 0, eap: false }
    : null
  const signal = {}
  const usable = profiles.filter(eligible)
  for (const p of usable) {
    const s = signalOf(p, scan)
    if (s >= (p.eap ? MIN_SIGNAL_EAP : MIN_SIGNAL)) {
      sightings[p.name] = (prevSight[p.name] || 0) + 1
      signal[p.name] = s
    }
  }
  const floor = active ? active.priority : -Infinity
  const cands = []
  for (const p of usable) {
    if (!sightings[p.name] || (active && p.name === active.name)) continue
    const why = blockedWhy(p, state, clock, clockOk)
    if (why) { if (p.priority > floor) blocked.push({ name: p.name, why, eap: p.eap }); continue }
    if (p.priority > floor) cands.push(p)
  }
  cands.sort((a, b) => b.priority - a.priority || signal[b.name] - signal[a.name])
  if (!cands.length) return out('none', active ? (online ? 'online-best' : 'nothing-better') : 'nothing-in-range')
  const target = cands[0]
  if (active && online && sightings[target.name] < STABLE_SIGHTINGS) return out('none', 'confirming', { target: target.name })
  return out('up', active ? (online ? 'better' : 'offline-better') : 'idle', { target: target.name, eap: target.eap, prev: active ? active.name : null })
}

// One attempt's outcome into the persistent state. Returns a new state object.
export function recordAttempt(state, { p, eap, ok, cls, why = null, clock }) {
  const s = { ...emptyState(), ...state, refused: { ...(state.refused || {}) }, fails: { ...(state.fails || {}) } }
  const rec = { p, eap: !!eap, ok: !!ok, cls, at: clock.now, boot: clock.boot, up: clock.up }
  // A week of history at most, and never more than 50 entries: enough for the 24 h window across
  // clock trouble, small enough to rewrite on an SD card.
  s.attempts = [...(state.attempts || []), rec].filter((a) => clock.now - a.at < 7 * DAY_S * 1000 || a.boot === clock.boot).slice(-50)
  if (ok) delete s.fails[p]
  else {
    const n = ((s.fails[p] && s.fails[p].n) || 0) + 1
    s.fails[p] = { n, at: clock.now, boot: clock.boot, up: clock.up }
  }
  if (eap && !ok && cls === 'refused') s.refused[p] = { at: new Date(clock.now).toISOString(), why: why || 'unclear' }
  return s
}

// --reset: what setup-wlan1-client.sh --login (after a login that worked) and --forget-login call.
// A person just entered credentials that the server accepted, or removed them: the old refusal and
// the old count no longer say anything. name = null resets every 802.1X profile.
export function resetProfile(state, name = null) {
  const s = { ...emptyState(), ...state, refused: { ...(state.refused || {}) }, fails: { ...(state.fails || {}) } }
  const hit = (p, eap) => (name ? p === name : eap)
  for (const p of Object.keys(s.refused)) if (hit(p, true)) delete s.refused[p]
  const eapNames = new Set((s.attempts || []).filter((a) => a.eap).map((a) => a.p))
  for (const p of Object.keys(s.fails)) if (hit(p, eapNames.has(p))) delete s.fails[p]
  s.attempts = (s.attempts || []).filter((a) => !hit(a.p, a.eap))
  if (s.inflight && hit(s.inflight.p, s.inflight.eap)) s.inflight = null
  return s
}

// ── what the console shows (the bridge, unprivileged, reads the two files) ────────────────────

const STALE_MS = 10 * 60_000   // the loop looks every ~2 min; three missed looks = not running

export function keeperView(persist, run, now = Date.now()) {
  if (!persist && !run) return null
  const p = persist || emptyState()
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
  const last = (p.attempts || []).length ? p.attempts[p.attempts.length - 1] : null
  const ref = Object.entries(p.refused || {})[0] || null
  // From the attempts themselves, not from the last look's `blocked` (a board online on a link
  // nothing unblocked outranks does not even scan). Wall clock only — this is for the words on the
  // card; the keeper's own count (failuresToday) is the one that decides.
  const eapFails = {}
  for (const a of p.attempts || []) if (a.eap && !a.ok && now - a.at < DAY_S * 1000) eapFails[a.p] = (eapFails[a.p] || 0) + 1
  const cappedName = Object.keys(eapFails).find((n) => eapFails[n] >= EAP_CAP_PER_DAY && !(p.refused || {})[n]) || null
  const capped = cappedName ? { name: cappedName } : null
  const checked = run && Date.parse(run.checkedAt)
  return {
    checkedAt: run && run.checkedAt ? run.checkedAt : null,
    stale: !Number.isFinite(checked) || now - checked > STALE_MS,
    online: run && typeof run.online === 'boolean' ? run.online : null,
    using: run && run.using ? { profile: run.using, kind: kindOf(run.using, !!run.usingEap) } : null,
    last: last ? { at: iso(last.at), profile: last.p, kind: kindOf(last.p, last.eap), ok: !!last.ok, result: last.cls } : null,
    refused: ref ? { profile: ref[0], kind: kindOf(ref[0], true), at: ref[1].at || null, why: ref[1].why || 'unclear' } : null,
    capped: capped ? { profile: capped.name, kind: kindOf(capped.name, true), tries: EAP_CAP_PER_DAY } : null,
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function readKeeperView({ stateFile = STATE_FILE, runFile = RUN_FILE, now = Date.now() } = {}) {
  return keeperView(readJson(stateFile), readJson(runFile), now)
}

// ── the root job ──────────────────────────────────────────────────────────────────────────────

function writeJson(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o644 })
  fs.chmodSync(tmp, 0o644)            // world-readable on purpose: the bridge runs as pi
  fs.renameSync(tmp, file)
}

function run(cmd, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({ code, out: `${stdout || ''}${stderr || ''}` })
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Android's connectivity check, like hallLogin.js: plain HTTP, so a captive portal answers with a
// redirect (not online) instead of a TLS error. 204 and nothing else is "online".
const PROBE_URL = 'http://connectivitycheck.gstatic.com/generate_204'
function probe(url, ms = 10_000) {
  return new Promise((resolve) => {
    let done = false
    const fin = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      const req = http.get(url, { timeout: ms }, (res) => { res.resume(); fin(res.statusCode === 204) })
      req.on('timeout', () => { req.destroy(); fin(false) })
      req.on('error', () => fin(false))
    } catch { fin(false) }
  })
}

function clockNow(env) {
  const now = env.KEEPER_NOW ? Number(env.KEEPER_NOW) : Date.now()
  let boot = env.KEEPER_BOOT_ID || ''
  if (!boot) { try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { boot = 'unknown' } }
  let up = env.KEEPER_UPTIME ? Number(env.KEEPER_UPTIME) : NaN
  if (!Number.isFinite(up)) { try { up = Number.parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) } catch { up = 0 } }
  return { now, boot, up }
}

// A lock beside the run file, so a hand-run --once never overlaps the loop's.
function takeLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true } catch (e) {
      if (e.code !== 'EEXIST') return false
      const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10)
      let alive = false
      try { if (pid > 0) { process.kill(pid, 0); alive = true } } catch (k) { alive = k.code === 'EPERM' }
      if (alive) return false
      try { fs.unlinkSync(file) } catch { return false }
    }
  }
  return false
}

export async function main(argv = process.argv.slice(2), env = process.env, say = (m) => console.log(m)) {
  const o = {
    nmcli: env.NMCLI || 'nmcli',
    journalctl: env.JOURNALCTL || 'journalctl',
    stateFile: env.KEEPER_STATE || STATE_FILE,
    runFile: env.KEEPER_RUN || RUN_FILE,
    pauseFile: env.KEEPER_PAUSE || PAUSE_FILE,
    probeUrl: env.KEEPER_PROBE_URL || PROBE_URL,
    settleMs: env.KEEPER_SETTLE_MS != null ? Number(env.KEEPER_SETTLE_MS) : 1500,
  }
  const mode = argv[0] || '--once'
  const clock = clockNow(env)
  let state = { ...emptyState(), ...(readJson(o.stateFile) || {}) }
  const prevRun = readJson(o.runFile) || {}

  if (mode === '--status') { say(JSON.stringify(keeperView(readJson(o.stateFile), prevRun, clock.now), null, 2)); return 0 }
  if (mode === '--reset') {
    const name = argv[1] || null
    writeJson(o.stateFile, resetProfile(state, name))
    say(`uplink keeper: ${name ? `'${name}'` : 'every 802.1X profile'} reset — it may be tried again`)
    return 0
  }
  if (mode !== '--once' && mode !== '--dry-run') { say('usage: uplink-keeper [--once|--dry-run|--status|--reset [profile]]'); return 2 }
  const dry = mode === '--dry-run'
  const lockFile = path.join(path.dirname(o.runFile), 'lock')
  if (!dry && !takeLock(lockFile)) { say('uplink keeper: another run is in progress — skipped'); return 0 }
  try {
    return await once({ o, clock, state, prevRun, dry, say })
  } finally {
    if (!dry) { try { fs.unlinkSync(lockFile) } catch { /* gone already */ } }
  }
}

async function once({ o, clock, state, prevRun, dry, say }) {
  const nm = (args, ms) => run(o.nmcli, args, ms)
  const save = () => { if (!dry) writeJson(o.stateFile, state) }
  const runDoc = (extra) => ({ v: 1, checkedAt: new Date(clock.now).toISOString(), boot: clock.boot, ...extra })

  let paused = false
  // Against the real wall clock: that is what stamped the file.
  try { paused = Date.now() - fs.statSync(o.pauseFile).mtimeMs < PAUSE_MAX_MS } catch { /* no pause */ }
  if (paused) {
    if (!dry) writeJson(o.runFile, runDoc({ using: prevRun.using || null, usingEap: !!prevRun.usingEap, online: prevRun.online ?? null, action: { what: 'none', reason: 'paused' }, sightings: {}, blocked: prevRun.blocked || [] }))
    if (prevRun.action && prevRun.action.reason !== 'paused') say('uplink keeper: paused — setup-wlan1-client.sh --login has wlan1')
    return 0
  }

  const journal = async (sinceMs) => {
    const r = await run(o.journalctl, ['-u', 'NetworkManager', '-u', 'wpa_supplicant', '--since', `@${Math.floor(sinceMs / 1000) - 1}`, '--no-pager', '-q', '-o', 'cat'], 15_000)
    return r.code === 0 ? r.out : null
  }

  // An attempt the last run started and never finished (power loss, a kill): read what the journal
  // kept of it, and count it like any other.
  if (state.inflight && !dry) {
    const f = state.inflight
    const j = await journal(f.at)
    const { cls, why } = classifyFailure({ eap: f.eap, journal: j, name: f.p, interrupted: true })
    state = recordAttempt(state, { p: f.p, eap: f.eap, ok: false, cls, why, clock })
    state.inflight = null
    save()
    say(`uplink keeper: the attempt on '${f.p}' was cut short — counted as ${cls}${cls === 'refused' ? ' (it will not be tried again)' : ''}`)
  }

  const dev = await nm(['-t', '-e', 'no', '-f', 'GENERAL.STATE,GENERAL.CONNECTION', 'device', 'show', IFACE])
  const present = dev.code === 0
  const device = present ? parseDevice(dev.out) : { state: 0, connection: null }

  const profiles = []
  if (present) {
    const list = await nm(['-t', '-e', 'no', '-f', 'TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,NAME', 'connection', 'show'])
    for (const name of parseConnectionList(list.out)) {
      const d = await nm(['-t', '-e', 'no', 'connection', 'show', 'id', name])
      if (d.code === 0) profiles.push(parseConnectionDetail(name, d.out))
    }
  }

  // The keeper owns every 802.1X profile's attempts: NM autoconnect would present a changed
  // password at every boot (~2 strikes each), which no cap here could see or stop.
  for (const p of profiles) {
    if (!p.eap || !p.autoconnect || (p.iface !== IFACE && p.iface !== '')) continue
    if (!dry) {
      const r = await nm(['connection', 'modify', 'id', p.name, 'connection.autoconnect', 'no'])
      if (r.code === 0) say(`uplink keeper: '${p.name}' is 802.1X — its NM autoconnect is now off, the keeper brings it up (lockout-safe)`)
    }
    p.autoconnect = false
  }

  const online = device.state === 100 ? await probe(o.probeUrl) : false
  // The school login's certificate check needs a plausible clock (no RTC; see the README).
  const clockOk = new Date(clock.now).getUTCFullYear() >= 2026
  const input = { clock, state, run: prevRun, paused, present, device, profiles, online, clockOk }
  let scan = []
  if (needsScan(input)) {
    const s = await nm(['-t', '-e', 'no', '-f', 'SIGNAL,FREQ,SECURITY,SSID', 'device', 'wifi', 'list', 'ifname', IFACE, '--rescan', 'auto'], 30_000)
    scan = s.code === 0 ? parseScan(s.out) : []
  }
  const d = decide({ ...input, scan })
  if (dry) {
    say(JSON.stringify({ device, online, profiles: profiles.map((p) => ({ name: p.name, priority: p.priority, eap: p.eap, autoconnect: p.autoconnect, signal: signalOf(p, scan), blocked: blockedWhy(p, state, clock, clockOk) })), decision: { action: d.action, reason: d.reason, target: d.target || null, blocked: d.blocked } }, null, 2))
    return 0
  }

  let using = device.state === 100 ? device.connection : null
  let attempt = null
  if (d.action === 'up') {
    const p = profiles.find((x) => x.name === d.target)
    say(`uplink keeper: trying '${p.name}' (${kindOf(p.name, p.eap)}) — ${d.reason === 'idle' ? 'wlan1 is idle' : d.reason === 'better' ? `it outranks '${d.prev}'` : `'${d.prev}' is not online and this one outranks it`}`)
    state.inflight = { p: p.name, eap: p.eap, at: clock.now, boot: clock.boot, up: clock.up }
    save()
    const r = await nm(['--wait', String(WAIT_S), 'connection', 'up', 'id', p.name, 'ifname', IFACE], (WAIT_S + 20) * 1000)
    let ok = r.code === 0
    let cls = 'connected', why = null
    if (!ok) {
      // nmcli gave up waiting, but NM carries on activating — and for the school login that is
      // more EAP exchanges. Stop it before reading what happened.
      if (r.code === 3 || /Timeout expired/i.test(r.out)) await nm(['connection', 'down', 'id', p.name])
      if (o.settleMs > 0) await sleep(o.settleMs)
      ;({ cls, why } = classifyFailure({ eap: p.eap, code: r.code, out: r.out, journal: await journal(clock.now), name: p.name }))
    }
    state = recordAttempt(state, { p: p.name, eap: p.eap, ok, cls, why, clock })
    state.inflight = null
    save()
    attempt = { profile: p.name, ok, cls }
    if (ok) {
      using = p.name
      say(`uplink keeper: on '${p.name}' now`)
    } else {
      const left = p.eap ? Math.max(0, EAP_CAP_PER_DAY - failuresToday(state, p.name, clock)) : null
      say(`uplink keeper: '${p.name}' did not connect (${cls}${why ? `, ${why}` : ''})${p.eap && cls === 'refused' ? ' — the school login was REFUSED or could not be read as anything else; it will not be tried again until setup-wlan1-client.sh --login is run' : p.eap ? ` — ${left} attempt(s) left in 24 h` : ''}`)
      if (p.eap && cls === 'refused') {
        // Belt and braces: autoconnect is off already (above), make sure.
        await nm(['connection', 'modify', 'id', p.name, 'connection.autoconnect', 'no'])
      }
      // Back to what it was on. Not an 802.1X one: that goes through the guarded path on the next look.
      const prev = d.prev && profiles.find((x) => x.name === d.prev)
      if (prev && !prev.eap) {
        const b = await nm(['--wait', '60', 'connection', 'up', 'id', prev.name, 'ifname', IFACE], 80_000)
        if (b.code === 0) { using = prev.name; say(`uplink keeper: back on '${prev.name}'`) } else using = null
      } else using = null
    }
  } else if (prevRun.action && prevRun.action.reason !== d.reason && ['nothing-better', 'nothing-in-range', 'online-best'].includes(d.reason) && d.blocked.length) {
    say(`uplink keeper: holding back ${d.blocked.map((b) => `'${b.name}' (${b.why})`).join(', ')}`)
  }
  const usingP = using && profiles.find((x) => x.name === using)
  writeJson(o.runFile, runDoc({
    using, usingEap: !!(usingP && usingP.eap), online: attempt ? (attempt.ok ? null : false) : online,
    action: { what: d.action, reason: d.reason, target: d.target || null }, attempt,
    sightings: d.sightings, blocked: d.blocked,
  }))
  return 0
}

// Run as a script (the root job's copy is an .mjs; the repo's is imported by the bridge).
const self = fileURLToPath(import.meta.url)
let invoked = ''
try { invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '' } catch { invoked = '' }
if (invoked && invoked === fs.realpathSync(self)) {
  main().then((rc) => process.exit(rc), (err) => { console.error(`uplink keeper: ${err && err.stack ? err.stack : err}`); process.exit(1) })
}
