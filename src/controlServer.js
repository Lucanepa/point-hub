// HTTP control server for the LedBox appliance — serves the web UI and a small JSON API
// to drive the board manually or link it to a live LAN match. Zero dependencies (node:http/fs).
//
//   web UI --fetch--> controlServer --> SourceManager --state--> LedboxClient --> LedBox

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { LanSource } from './lanSource.js'
import { toLeftRight } from './volleyballMapper.js'
import { hexToRgb } from './ledboxProtocol.js'
import { execFile } from 'node:child_process'
import { HistoryStore } from './historyStore.js'
import { ResumeStore } from './resumeStore.js'
import { SPORT_LIST, getSport } from './sports.js'
import { PER_SPORT_KEYS, PIN_RE } from './settings.js'
import { log, LEVELS } from './logStore.js'
import { systemInfo } from './systemInfo.js'
import { PinGate, safeEqual } from './pinGate.js'
import { ClockSync } from './clockSync.js'
import { Schedule } from './schedule.js'

const clog = log.child('control')
const alog = log.child('action')

// The browser can post its own errors to /api/logs. That endpoint is deliberately open (a
// spectator's phone hitting a bug is exactly what we want to see, and it has no PIN), so it is
// rate-limited instead — one misbehaving tab in a reload loop must not fill the card.
const UI_LOG_PER_MIN = 60
// One window PER SOURCE ADDRESS rather than a single shared counter. A global counter had both
// halves wrong: one phone in a reload loop silenced every other browser's error reports, and
// 60 accepted posts/min from a single address was still enough to be the heap bomb (measured:
// 59 x 1 MB posts took RSS 67 → 169 MB and wrote 15 MB to the card).
const uiRate = new Map() // ip -> { windowStart, count }
const UI_RATE_MAX_IPS = 256
// A browser error report is a few hundred bytes. The general 1 MiB body cap on this — the one
// mutating route with no PIN — is what a phone in RF range of the board's own AP used to fill
// the heap with, so it gets its own, much smaller ceiling.
const UI_LOG_MAX_BODY = 8 * 1024
const UI_LOG_MAX_MSG = 300

// Actions that set a game up rather than play it. During a pre-match they keep the board on the
// clock and the pre-match on; every other action starts the match (see `prematch`).
const PREMATCH_ACTIONS = new Set(['team', 'serve', 'serve-order', 'serve-player', 'swap', 'undo'])

const ACTION_TYPES = new Set(['point', 'set', 'timeout', 'sub', 'serve', 'serve-order', 'serve-player', 'swap', 'team', 'next-set', 'remove-set', 'reset', 'set-state', 'undo'])

// A team colour ends up inside a `style` attribute in the console and as a SetSections colour on
// the panel. Only a #rrggbb literal is ever legitimate, and anything else is either a mistake or
// the stored-XSS path the review found — so it never gets past this regex.
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

// The console, the mirror and the log page are all served from this very origin, so nothing we
// ship needs CORS at all. What `Access-Control-Allow-Origin: *` was buying instead was a
// cross-origin READ of /api/status, /api/history and the whole 15 MB /api/logs/export by any
// other page open on the venue LAN. So: no wildcard — reflect a same-origin Origin (see
// corsHeaders) and send nothing at all to a foreign one.
const CORS = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Deliberately NOT X-Scorer-Pin. Leaving it out is what makes a browser's preflight fail on a
  // cross-origin mutating request, which is half of why a PIN-protected board is CSRF-safe.
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
}

// Max accepted request body — one bad/slow-drip POST must not exhaust the heap.
const MAX_BODY = 1 << 20 // 1 MiB

// Captive-portal / connectivity checks, answered the way each vendor expects a working network to
// answer. Every one of these is a well-known fixed URL, so serving them is not guesswork.
//   Android/Chrome  -> 204 with an empty body
//   Apple           -> a page whose body is exactly "Success"
//   Windows NCSI    -> "Microsoft NCSI" / "Microsoft Connect Test"
//   Firefox         -> "success\n"
// Getting these wrong (a 404, or our own HTML) is what tells a device it is behind a portal.
const PROBE_204 = new Set([
  '/generate_204', '/gen_204', '/mobile/status.php', '/connectivity-check.html',
])
const APPLE_SUCCESS = '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>\n'
const PROBE_BODIES = {
  '/hotspot-detect.html': { type: 'text/html', body: APPLE_SUCCESS },
  '/library/test/success.html': { type: 'text/html', body: APPLE_SUCCESS },
  '/ncsi.txt': { type: 'text/plain', body: 'Microsoft NCSI' },
  '/connecttest.txt': { type: 'text/plain', body: 'Microsoft Connect Test' },
  '/success.txt': { type: 'text/plain', body: 'success\n' },
}

// Push a new LED brightness to the panel. `startled` reads [DISPLAY] brightness from setting.ini
// and passes it to flushBuffer2 at launch, so we rewrite that key and bounce the driver. The
// bridge runs as pi (passwordless sudo); setting.ini is world-writable. Best-effort — any failure
// is logged, never thrown, and off the board (dev, no setting.ini) it simply no-ops.
const SETTING_INI = '/home/pi/ledbox/setting.ini'
// Brightness 0 = panel off. This flag file (checked by the board watchdog) is what keeps the
// panel dark: without it the watchdog would relight the driver within 30s. Removing it lets the
// watchdog keep the panel alive again.
const PANEL_OFF_FLAG = '/home/pi/ledbox/PANEL_OFF'
// Restart the panel driver at the current setting.ini brightness. Everything happens under the
// lock the watchdog's start_panel shares (firmware/ledbox-watchdog.sh): SIGTERM the running driver,
// WAIT for it to actually exit, start exactly one, and keep holding the lock until the new
// flushBuffer2 is really there. Each part closes a race:
//   * the kill is INSIDE the lock — outside it, the watchdog could see "no driver" in the gap and
//     start one at the OLD brightness, which ours would then either skip or fight;
//   * flushBuffer2 can take ~1s to release the GPIO on SIGTERM, so starting on a fixed timer would
//     be skipped (the guard still sees the dying process) or spawn a second driver beside it —
//     vertical flicker on the panel. If it will not die within ~5s we start nothing: a panel at the
//     old brightness is better than two drivers;
//   * the lock is held until pgrep sees the new driver (~10s max). startled takes a moment to exec
//     flushBuffer2, and releasing the lock the instant it was launched let the watchdog take it,
//     see no driver yet, and start a second one;
//   * `flock -o` closes the lock fd in the command it runs, so the driver we launch (and systemd-run's
//     helpers) never inherit it — an inherited fd would hold the lock for the driver's whole life
//     and lock the watchdog out of every restart after this one.
// Process match is `-x flushBuffer2` (exact comm) so the transient `sudo` wrapper never counts as a
// live driver. Exit codes (logged by applyBrightness): 3 = no driver within 10s, 4 = the old one
// would not exit, 1 = the lock stayed busy for 20s.
//
// The driver is launched as its OWN transient systemd unit, not as a child of this process. A
// backgrounded `( ./startled & )` only leaves the shell, not the cgroup: sudo on this board opens
// no new session scope, so flushBuffer2 stayed a member of ledbox-bridge.service, and the unit's
// default KillMode=control-group took the panel down with the bridge on every deploy, sport switch
// or crash restart after any brightness change — dark until the watchdog noticed (~40s), or for
// good while the watchdog is disabled. systemd-run makes systemd the parent, so the driver outlives
// us exactly as the one rc.local started does. Same user as before (id -un), so buffer.png keeps
// its owner. The unit name carries $$ so a previous launch still being reaped can't collide with
// it; --collect drops it once the driver exits. `sudo -n` never prompts, and should systemd-run be
// refused for any reason the old in-cgroup launch still lights the panel — dark is the worse fault.
const PANEL_START =
  'sudo -n systemd-run --quiet --collect --unit=ledbox-panel-$$ --uid=$(id -un) /home/pi/ledbox/bin/startled >/dev/null 2>&1 || ' +
  '( cd /home/pi/ledbox/bin && ./startled >/dev/null 2>&1 & )'
const PANEL_RESTART =
  "flock -o -w 20 /home/pi/ledbox/panel.lock -c '" +
  'sudo -n pkill -x flushBuffer2; ' +
  'for i in $(seq 25); do pgrep -x flushBuffer2 >/dev/null 2>&1 || break; sleep 0.2; done; ' +
  'pgrep -x flushBuffer2 >/dev/null 2>&1 && exit 4; ' +
  `{ ${PANEL_START}; }; ` +
  'for i in $(seq 50); do pgrep -x flushBuffer2 >/dev/null 2>&1 && exit 0; sleep 0.2; done; ' +
  "exit 3'"

function applyBrightness(value) {
  if (value <= 0) {
    // Off: raise the flag first (so the watchdog leaves it dark), then stop the driver. The
    // scoreboard app keeps running, so the controller UI stays reachable to switch it back on.
    try { fs.writeFileSync(PANEL_OFF_FLAG, '') } catch (err) { clog.error(`brightness off-flag write failed: ${err.message}`, { file: PANEL_OFF_FLAG, error: err.message }) }
    clog.info('panel driver stopped (brightness 0)')
    execFile('sudo', ['pkill', '-x', 'flushBuffer2'], (err) => {
      if (err) clog.warn(`pkill flushBuffer2 failed: ${err.message}`, { error: err.message })
    })
    return
  }
  // On (or level change): clear the off-flag so the watchdog keeps the panel alive.
  try { fs.rmSync(PANEL_OFF_FLAG, { force: true }) } catch { /* not off, nothing to clear */ }
  try {
    let ini = fs.readFileSync(SETTING_INI, 'utf8')
    ini = /^brightness=.*$/m.test(ini)
      ? ini.replace(/^brightness=.*$/m, `brightness=${value}`)
      : ini.replace(/^\[DISPLAY\][^\n]*$/m, (m) => `${m}\nbrightness=${value}`)
    try {
      const tmp = `${SETTING_INI}.tmp`
      fs.writeFileSync(tmp, ini)
      fs.renameSync(tmp, SETTING_INI)
    } catch {
      fs.writeFileSync(SETTING_INI, ini) // world-writable file; write in place if staging a tmp fails
    }
  } catch (err) {
    // Off the board (dev, no setting.ini) this is the expected path, not a fault.
    clog.debug(`setting.ini update skipped: ${err.message}`, { file: SETTING_INI, error: err.message })
    return
  }
  // setting.ini now holds the new level, so whichever starter wins the lock launches at it.
  clog.info(`restarting the panel driver at brightness ${value}`, { brightness: value })
  execFile('bash', ['-c', PANEL_RESTART], (err) => {
    if (!err) return
    const why = { 1: 'panel.lock stayed busy for 20s, restart skipped', 3: 'no flushBuffer2 appeared within 10s of startled', 4: 'the old flushBuffer2 did not exit, so no second driver was started' }[err.code]
    clog.warn(`panel driver restart: ${why || err.message}`, { code: err.code, error: err.message })
  })
}

export function createControlServer({ sourceManager, manualSource, ledbox, relayHttpUrl, relayUrl, webDir, dataDir, reconnectMs, settings, clockSync: clockSyncIn = null, schedule: scheduleIn = null }) {
  const opt = (k) => (settings ? settings.values[k] : undefined)
  // Where match state lives. Defaults beside the bridge, but the appliance passes it explicitly so
  // a test can be pointed at a temp dir instead of the board's real history (see startAppliance).
  const stateHome = dataDir ? path.resolve(dataDir) : path.resolve(webDir, '..', 'data')
  // Completed-match log (History tab + CSV/JSON export).
  const history = new HistoryStore({ file: path.resolve(stateHome, 'history.json') })
  // The per-sport "last game" slot behind the New / Continue / Delete menu (see resumeStore.js).
  const resume = new ResumeStore({ file: path.resolve(stateHome, 'resume.json') })
  const activeSport = () => (settings ? settings.values.sport : 'volleyball')
  // Every change to the live score goes into the match log and the resume slot — not only the ones
  // that arrive through /api/action. The set interval's next-set (/api/countdown swapFirst) and the
  // announced change of ends (/api/message swap) mutate the board too, and skipping them left the
  // slot at the FINISHED set: a restart during the interval, or Continue, brought back 25-23 on the
  // old ends with the set closed, and the next +1 made it 26-23. Both halves are wrapped because
  // persistence must never break scoring. A decided match is dropped from the slot instead: it is
  // already archived in the history, and offering to "continue" a match that is over is worse than
  // offering nothing.
  //
  // `undoable` defaults to whether the source just journaled the action (every caller persists
  // straight after apply()), which is what keeps the log's undo steps in lock-step with the
  // source's: a no-op the source didn't journal must not become a step the log would undo instead.
  //
  // A sport can opt out of the match log (sports.js `history: false` — the simple scoreboard, whose
  // "match" never ends and so would never leave the buffer). The resume slot it keeps either way.
  const keepsHistory = () => getSport(activeSport()).history !== false
  // Whether anything has changed the live board since it was last (re)started — boot, New,
  // Continue, crash restore. Deleting the saved game uses it: with nothing done since, the board is
  // still showing exactly what was saved (or a blank boot board), so clearing it is what the
  // operator means by "delete".
  let touchedSinceStart = false
  const persist = (action, state, event, { undoable = !!(manualSource && manualSource.lastJournaled), label = '' } = {}) => {
    touchedSinceStart = true
    if (keepsHistory()) try { history.record(action, state, event, nowStamp(), nowClock(), { undoable, label }) } catch (e) { log.error('history', `record failed: ${e && e.message}`, e) }
    try {
      if (event === 'match-end' || event === 'game-end') resume.clear(activeSport())
      else resume.save(activeSport(), state, nowStamp(), { prematch })
    } catch (e) { log.error('resume', `save failed: ${e && e.message}`, e) }
  }
  // PRE-MATCH: a game started from the schedule is set up (names, 0-0) but not yet on the panel —
  // the hall keeps the wall clock until the warm-up ends or the scorer starts the match. While this
  // is true the board is on the held clock (or the warm-up countdown), /api/status says so and the
  // console shows its "Ready: … — board shows the clock" banner. Ends — the 0-0 scoreboard painted
  // — when the warm-up countdown ends or is skipped, on "Start match now" (POST /api/prematch), on
  // the first scoring action, and whenever the operator starts, continues or deletes a game, links
  // a LAN match or turns idle off. Kept in the resume slot, so a restart comes back to it.
  //
  // Starting the match is NOT undoable, and undo never reaches back across it: beginMatch() clears
  // the undo trail, so the first undo after the start takes back the first point and stops at 0-0
  // on the scoreboard — it never returns the hall to the clock or unwinds a name typed beforehand.
  let prematch = false
  // Open /api/logs/stream responses. An SSE response never ends by itself, and http.Server.close()
  // waits for every active one — so a /logs tab left open on some laptop held every shutdown (sport
  // switch, deploy, poweroff) until systemd's stop timeout SIGKILLed us. closeStreams() ends them.
  const streams = new Set()
  // Scorer lock: with a PIN set, mutating requests must carry it (X-Scorer-Pin header) — a
  // spectator who scanned the QR can watch but not score. GET reads stay open.
  // Brute-force gate — see pinGate.js. Without it, /api/unlock is an oracle that answers
  // "is this PIN right?" to anyone, unthrottled.
  const pinGate = new PinGate()
  // Shared by pinOk and /api/unlock so guesses against either path count towards the same lock.
  // Returns { ok, locked, retryAfterMs }.
  const tryPin = (req, supplied) => {
    const need = settings ? settings.values.scorerPin : ''
    if (!need) return { ok: true, locked: false, retryAfterMs: 0 } // no PIN set — gate is off
    const ip = clientIp(req)
    const g = pinGate.check(ip)
    if (!g.allowed) return { ok: false, locked: true, retryAfterMs: g.retryAfterMs }
    const ok = safeEqual(supplied, need)
    if (ok) pinGate.succeed(ip)
    else {
      const r = pinGate.fail(ip)
      if (r.lockedMs) clog.warn(`scorer PIN locked out ${ip} for ${Math.round(r.lockedMs / 1000)}s after ${r.fails} failures`, { ip, fails: r.fails, lockedMs: r.lockedMs })
    }
    return { ok, locked: false, retryAfterMs: 0 }
  }
  const pinOk = (req) => {
    const r = tryPin(req, req.headers['x-scorer-pin'] || '')
    // A locked board rejecting a phone is normally a spectator poking at it, but it is also
    // what a scorer sees when they mistype — either way it belongs in the record.
    if (!r.ok) clog.warn(`rejected ${req.method} ${req.url} — ${r.locked ? 'PIN locked out' : 'wrong or missing scorer PIN'}`, { path: req.url, ip: clientIp(req), locked: r.locked })
    req._pinDenial = r
    return r.ok
  }
  const denyPin = (res, req) => {
    const r = (req && req._pinDenial) || {}
    if (r.locked) {
      const secs = Math.ceil(r.retryAfterMs / 1000)
      res.setHeader('Retry-After', String(secs))
      return sendJson(res, 429, { error: `too many wrong PINs — try again in ${secs}s`, retryAfterMs: r.retryAfterMs })
    }
    return sendJson(res, 403, { error: 'scorer PIN required' })
  }
  // Ephemeral display countdown (timeout 30s / set interval / side switch). Owned here
  // so it reaches every surface from ONE source: the control UI banner, the
  // /mockledbox mirror (via /api/board), AND the physical LedBox (pushed once a second
  // by the ticker below). Not part of the board liveState — a transient overlay.
  let countdown = null // { label, endsAt } | null
  let cdTicker = null
  // Read-only, and it has to stay that way: this is reached from the open GET /api/board that
  // web/mockledbox.html polls twice a second. It used to reap an expired countdown itself with a
  // bare stopCountdown() — which defaults expired=false — so a poll landing on the zero-crossing
  // nulled the countdown, killed the ticker, and swallowed the end-of-timeout horn: the referee
  // got no buzzer and the later POST /api/countdown/stop {expired:true} hit the `if (!countdown)`
  // guard. The 1s ticker below is the only thing that knows the clock genuinely ran out, so it
  // is the only thing allowed to end one.
  function countdownView() {
    if (!countdown) return null
    const remainingMs = countdown.endsAt - Date.now()
    if (remainingMs <= 0) return null
    return { label: countdown.label, remainingMs }
  }
  // `side` rides along with `team` so the break screen can size the name with the SAME per-side
  // ceiling the operator set for the scoreboard — a name that is 24px while play is on should not
  // drop to the layout's hard-coded 15 the moment that team calls a timeout.
  function startCountdown(seconds, label, content = 'full', team = '', side = null) {
    clog.info(`countdown started: ${label || '(no label)'} ${seconds}s`, { seconds, label: String(label || ''), content, team: String(team || ''), side })
    countdown = { label: String(label || ''), content, team: String(team || ''), side, endsAt: Date.now() + seconds * 1000 }
    if (cdTicker) clearInterval(cdTicker)
    const tick = () => {
      const remainingMs = countdown ? countdown.endsAt - Date.now() : -1
      if (remainingMs <= 0) { stopCountdown({ expired: true }).catch(() => {}); return }
      // Best-effort push to the physical board (no-op when not ready / no method).
      if (ledbox && typeof ledbox.pushCountdown === 'function') {
        ledbox.pushCountdown(Math.ceil(remainingMs / 1000), countdown.label, { content: countdown.content, team: countdown.team, side: countdown.side }).catch(() => {})
      }
    }
    tick()
    cdTicker = setInterval(tick, 1000)
    // Don't let this daemon-side timer keep the process (or a test) alive.
    if (cdTicker.unref) cdTicker.unref()
  }
  // expired=true means the clock reached zero (time's up); false is a manual skip. Guarded so
  // that whichever of {server tick, client /stop} fires first wins — the other is a no-op, so
  // the horn sounds exactly once.
  //
  // `repaint: false` is for the callers that are about to put the idle clock up (Show clock, the
  // game menu's Clock and Delete): the countdown has to END first — its 1 s ticker re-asserts the
  // break screen and knocks `_idle` off on every tick, so a clock requested over a running warm-up
  // was gone within a second — but going back to the match on the way would flash the scoreboard.
  // Such a stop also leaves a pending pre-match as it is: the hall asked for the clock, not the game.
  //
  // Returns a promise that settles once the panel has left the break screen, so a caller can put
  // the clock up after it rather than race it. Never rejects.
  function stopCountdown({ expired = false, repaint = true } = {}) {
    if (!countdown) return Promise.resolve(false)
    clog.info(expired ? 'countdown reached zero' : 'countdown skipped', {
      expired, label: countdown.label, horn: !!(expired && opt('hornOnCountdownEnd')), repaint, prematch,
    })
    countdown = null
    if (cdTicker) { clearInterval(cdTicker); cdTicker = null }
    const cleared = ledbox && typeof ledbox.pushCountdown === 'function'
      ? Promise.resolve(ledbox.pushCountdown(null, '', { repaint })).catch(() => {})
      : Promise.resolve()
    if (expired && opt('hornOnCountdownEnd') && ledbox && typeof ledbox.horn === 'function') {
      ledbox.horn().catch(() => {})
    }
    // The warm-up of a pre-match ran out (or was skipped): the match is on.
    if (repaint && prematch) return cleared.then(() => beginMatch(expired ? 'warm-up over' : 'warm-up stopped')).catch(() => true)
    return cleared.then(() => true)
  }
  // Leave the pre-match: clear the flag, rewrite the resume slot without it, and make sure the 0-0
  // scoreboard is what the panel shows (after a countdown, pushCountdown(null) has already painted
  // it and `_idle` is off; from the held clock, lifting idle repaints from the state the client
  // holds). Not undoable — see `prematch` above. Returns whether there was a pre-match to leave.
  async function beginMatch(reason) {
    if (!prematch) return false
    prematch = false
    clearUndo()
    try {
      const state = manualSource ? manualSource.getState() : null
      if (state) resume.save(activeSport(), state, nowStamp(), { prematch: false })
    } catch (e) { log.error('resume', `save failed: ${e && e.message}`, e) }
    clog.info(`match started from the pre-match clock (${reason})`, { reason })
    if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
    return true
  }
  // Any path that replaces the game on the board (New, Continue, Delete, a LAN link) drops a
  // pending pre-match without painting anything — that path paints whatever it puts up itself.
  const dropPrematch = (why) => {
    if (!prematch) return
    prematch = false
    clog.info(`pre-match dropped (${why})`, { why })
  }
  // Adopting the console's wall clock when we have no uplink — see clockSync.js for why this
  // exists at all. `isBusy` is the gate that keeps a clock jump away from anything that measures
  // an interval with Date.now(): a live countdown deadline (above) and a match mid-record.
  // Injectable so a test never reaches for `sudo date` on the machine running it.
  const clockSync = clockSyncIn || new ClockSync({
    isBusy: () => countdown !== null || history.current !== null,
  })
  // Today's home games from the club's Directus (see schedule.js). Injectable so a test can point
  // it at a local fake instead of the network.
  const schedule = scheduleIn || new Schedule()

  // Put the wall clock on the panel and keep it there (see LedboxClient.showIdle's `screen`). A
  // running countdown is ended first (quietly, see stopCountdown's `repaint`): left running, its
  // ticker took the panel back to the break screen within a second.
  const holdClock = async () => {
    await stopCountdown({ expired: false, repaint: false })
    if (ledbox && typeof ledbox.showIdle === 'function') await ledbox.showIdle(true, { screen: 'clock' })
  }

  // Named rather than inline so the appliance can hand the SAME handler to an https.Server and
  // serve both listeners from one implementation. Everything per-request (res._cors, the timing
  // log) is resolved inside here, so a second transport needs no special-casing at all.
  const handler = async (req, res) => {
    // Every request is timed and recorded once it completes. GETs are polled about once a
    // second by every open tab, so they sit at `debug`; anything that mutates the board, and
    // anything that failed, is `info` or louder.
    const started = Date.now()
    // Resolved once per request and read by send() below, so every response — including the SSE
    // stream and the log export — answers with the same origin decision.
    res._cors = corsHeaders(req)
    res.on('finish', () => {
      const ms = Date.now() - started
      const line = `${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`
      const data = { method: req.method, path: req.url, status: res.statusCode, ms, ip: clientIp(req) }
      if (res.statusCode >= 500) clog.error(line, data)
      else if (res.statusCode >= 400) clog.warn(line, data)
      else if (req.method === 'GET') clog.debug(line, data)
      else clog.info(line, data)
    })
    try {
      const url = new URL(req.url, 'http://localhost')
      const { pathname } = url

      if (req.method === 'OPTIONS') return send(res, 204, null)

      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname)

      // Connectivity checks from devices joined to the board's own Wi-Fi.
      //
      // A phone or tablet on an AP asks a fixed URL whether it can reach the internet, and decides
      // what the network IS from the answer. Our 404 is the answer that means "a captive portal is
      // intercepting you": the device keeps re-probing (the board's log has one every ~3 s all
      // evening from the scorer's tablet), shows a "sign in to network" nag, and on Android is
      // liable to hold the Wi-Fi at arm's length or drift back to mobile data — which for a
      // scoring console served over that same Wi-Fi is not a cosmetic problem.
      //
      // The truthful answer for this appliance is "yes, you are connected, there is nothing to
      // sign in to", which is what each vendor's expected reply below means. There is no internet
      // out here, but nothing the tablet needs is out there either.
      if (PROBE_204.has(pathname)) return send(res, 204, null)
      if (PROBE_BODIES[pathname]) {
        const { type, body } = PROBE_BODIES[pathname]
        return send(res, 200, body, { 'Content-Type': type })
      }

      // Pretty route for the virtual-board mirror (both the correct + user-typed spelling).
      if (pathname === '/mockledbox' || pathname === '/mochledbox') {
        return serveStatic(res, '/mockledbox.html', webDir)
      }

      // Pretty route for the log viewer.
      if (pathname === '/logs') return serveStatic(res, '/logs.html', webDir)

      // Static web UI.
      return serveStatic(res, pathname, webDir)
    } catch (err) {
      // Malformed JSON bodies are a client error, not a server crash.
      if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid JSON body' })
      // A tagged client error (e.g. body too large) carries its own status code.
      if (err && err.statusCode) {
        // A refused ERROR REPORT is the one refusal worth a line of its own. The console posts its
        // own faults here, so a 413 means a browser tried to tell us something went wrong and we
        // threw the message away — which is exactly the state the log was in after the
        // "tablet went black" report. The report itself is gone; the fact of it should not be.
        if (err.statusCode === 413 && req.url && req.url.startsWith('/api/logs')) {
          clog.warn('a console error report was too large to accept — the fault it described is not recorded', {
            bytes: Number(req.headers['content-length']) || null, limit: UI_LOG_MAX_BODY, ip: clientIp(req),
          })
        }
        return sendJson(res, err.statusCode, { error: err.message })
      }
      // Don't leak internal error detail to clients; log it server-side instead.
      clog.error(`request error: ${err && err.message}`, { method: req.method, path: req.url, error: err })
      return sendJson(res, 500, { error: 'internal error' })
    }
  }

  const server = http.createServer(handler)
  // Handed to the appliance so an optional https.Server can serve the identical implementation.
  server.handler = handler

  async function handleApi(req, res, pathname) {
    // Any API traffic means an operator has the control UI open (it polls /api/status every
    // 1.5s). The board uses this to drop the "how do I connect" QR codes for a wall clock.
    if (ledbox && typeof ledbox.noteViewer === 'function') ledbox.noteViewer()
    // A web page open on some other device must not be able to drive the board. Both guards are
    // free for the real client: a same-origin fetch sends no Origin header at all, and every
    // caller we ship already sends `content-type: application/json`. What they stop is a page on
    // a spectator's phone POSTing /api/action — or /api/shutdown — at a board with no PIN set,
    // which is the shipped default. The Content-Type requirement is the important half: without
    // it a text/plain POST is a CORS "simple request" that succeeds with no preflight to fail.
    // HEAD is listed with GET because it is a safe method that carries no body — uptime probes and
    // curl -I were answering 415 otherwise, which reads as a broken board rather than a refused one.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      if (!isSameOrigin(req)) {
        clog.warn(`rejected a cross-origin ${req.method} ${pathname}`, { path: pathname, origin: String(req.headers.origin || ''), ip: clientIp(req) })
        return sendJson(res, 403, { error: 'cross-origin request refused' })
      }
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (ctype !== 'application/json') {
        clog.warn(`rejected ${req.method} ${pathname} — Content-Type ${ctype || '(none)'}`, { path: pathname, contentType: ctype, ip: clientIp(req) })
        return sendJson(res, 415, { error: 'Content-Type: application/json required' })
      }
    }
    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, status())
    }
    // GET /api/board — the exact section map pushed to the LedBox (1:1 mirror for the web view)
    if (pathname === '/api/board' && req.method === 'GET') {
      return sendJson(res, 200, board())
    }
    // GET /api/matches
    if (pathname === '/api/matches' && req.method === 'GET') {
      return sendJson(res, 200, await listMatches())
    }
    // GET /api/system — host diagnostics: temperature, throttling, disk, memory, interfaces, and
    // whether the clock is actually synced. This is the substitute for a screen and keyboard: the
    // C0270's enclosure has no micro-HDMI cutout, so the Pi's HDMI ports cannot be reached without
    // opening the box, and the tablet running this console is the only display the board will get.
    //
    // Open, like every other read (docs/logging-DESIGN.md). See src/systemInfo.js for what is
    // deliberately excluded — the AP's SSID above all, which appears nowhere else in the API.
    // GET /api/schedule[?refresh=1] — today's home games for this board's sport, for the console's
    // "start from the schedule" list. Open like every other read; the data is public anyway. Always
    // 200: a board with no uplink is the normal case, so failure is `{ ok:false, error }` in words
    // the console can show as they are, never a 5xx.
    if (pathname === '/api/schedule' && req.method === 'GET') {
      const refresh = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1'
      const r = await schedule.today({ sport: activeSport(), refresh })
      return sendJson(res, 200, r.ok
        ? { ok: true, date: r.date, sport: activeSport(), games: r.games }
        : { ok: false, error: r.error, games: [] })
    }
    if (pathname === '/api/system' && req.method === 'GET') {
      return sendJson(res, 200, await systemInfo())
    }
    // POST /api/manual
    if (pathname === '/api/manual' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      await readJson(req) // drain
      // Leave the crest/idle screen so the manual scoreboard paints — from a pre-match, that is
      // starting the match.
      if (prematch) await beginMatch('manual mode')
      if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
      sourceManager.setSource(manualSource, { mode: 'manual' })
      return sendJson(res, 200, status())
    }
    // POST /api/action { action }
    if (pathname === '/api/action' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      const action = body && body.action
      if (!action || !ACTION_TYPES.has(action.type)) {
        alog.warn('rejected an unknown action', { action, ip: clientIp(req) })
        return sendJson(res, 400, { error: 'unknown or missing action.type' })
      }
      // Colours are dropped, not rejected: an operator renaming a team should never lose the
      // edit because something upstream handed us a colour we don't recognise. The source has
      // to be clean because the value persists — resume.save writes it, and it comes back
      // through set-state after a reboot.
      scrubColors(action, (bad) => {
        alog.warn(`dropped an invalid team colour: ${bad.slice(0, 40)}`, { color: bad.slice(0, 120), side: action.side, ip: clientIp(req) })
      })
      if (sourceManager.status.mode !== 'manual') {
        sourceManager.setSource(manualSource, { mode: 'manual' })
      }
      // Getting the teams right before the start — names, colours, who serves, which end — is
      // part of the pre-match, so those keep the board on the clock (their paint is held while idle
      // is up) and leave the flag alone. Anything that scores starts the match: the undo trail is
      // cut first, so the start itself can never be undone (see `prematch`).
      const keepsPrematch = prematch && PREMATCH_ACTIONS.has(action.type)
      if (prematch && !keepsPrematch) {
        prematch = false
        clearUndo()
        clog.info(`match started from the pre-match clock (${action.type})`, { reason: action.type })
      }
      // Any live action (point, serve, …) means the match is on — drop the idle screen so
      // the state push below actually paints the scoreboard.
      if (!keepsPrematch && ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') ledbox.showIdle(false)
      // Read BEFORE the undo pops it: the log's undo marker says what was taken back.
      const undoing = action.type === 'undo' ? String(manualSource.undoLabel || '') : ''
      manualSource.apply(action)
      const newState = manualSource.getState()
      const event = manualSource.lastEvent || null
      // Refused (the set is already won) or nothing to undo: the board did not change, so there is
      // nothing to log as scoring, persist or blink. The console turns the event into a toast.
      if (event === 'set-closed' || event === 'undo-empty') {
        alog.info(event === 'set-closed'
          ? `point ${action.side === 'right' ? 'right' : 'left'} refused — the set is already won`
          : 'undo — nothing to undo', { ...action, event, ip: clientIp(req) })
        return sendJson(res, 200, { ok: true, state: newState, event, ...undoView() })
      }
      if (event === 'undo') {
        alog.info(`undo: ${undoing || 'last action'} → ${count(newState.points_a)}-${count(newState.points_b)}`, {
          type: 'undo', undid: undoing,
          score: `${count(newState.points_a)}-${count(newState.points_b)}`,
          sets: `${count(newState.sets_won_a)}-${count(newState.sets_won_b)}`,
          ip: clientIp(req),
        })
        // Undoing the match point while the result screen holds the panel: pushState will not paint
        // over another layout, so the restored score would sit behind the winner until New game.
        if (ledbox && ledbox.resultLayout && ledbox.currentLayout === ledbox.resultLayout) {
          if (typeof ledbox.clearResult === 'function') await ledbox.clearResult().catch(() => {})
          if (typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
        }
        persist(action, newState, 'undo', { undoable: false, label: undoing })
        return sendJson(res, 200, { ok: true, state: newState, event, ...undoView() })
      }
      // The scoring trail: every hand-entered action with the score it produced. This is what
      // answers "the away team says the score was wrong at 18-17" after the fact.
      alog.info(actionLine(action, newState), {
        ...action,
        score: `${count(newState.points_a)}-${count(newState.points_b)}`,
        sets: `${count(newState.sets_won_a)}-${count(newState.sets_won_b)}`,
        event: manualSource.lastEvent || null,
        ip: clientIp(req),
      })
      pulseForAction(ledbox, action, settings, newState)
      // Match history + resume slot, so a power cut mid-set loses nothing (see persist()).
      persist(action, newState, manualSource.lastEvent)
      return sendJson(res, 200, { ok: true, state: newState, event: manualSource.lastEvent, ...undoView() })
    }
    // GET /api/settings — operator preferences (persisted on the Pi)
    if (pathname === '/api/settings' && req.method === 'GET') {
      if (!settings) return sendJson(res, 200, {})
      // Never hand the PIN to a client — expose only whether one is set.
      // perSportKeys tells the UI which fields belong to the active sport (settings.values already
      // carries the active sport's values, since it's a flat merged view).
      return sendJson(res, 200, { ...settings.values, scorerPin: '', pinSet: !!settings.values.scorerPin, perSportKeys: PER_SPORT_KEYS })
    }
    // POST /api/settings — partial update; unknown keys are dropped and numbers clamped
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req)
      if (!settings) return sendJson(res, 501, { error: 'settings unavailable' })
      if (!pinOk(req)) return denyPin(res, req)
      const patch = { ...(body || {}) }
      // The PIN is validated here, not quietly repaired. An empty field means "leave the current
      // PIN unchanged" (else every ordinary save would wipe the lock). Anything else must be 1-8
      // digits or the whole save is refused: stripping it to its digits turned "abcd" into "" —
      // the lock silently removed under a "Saved." — and "12.34" into a PIN that was not the one
      // the scorer typed. Removing the PIN is its own explicit request, { clearPin: true }.
      const clearPin = patch.clearPin === true
      delete patch.clearPin
      const pin = patch.scorerPin == null ? '' : String(patch.scorerPin).trim()
      if (pin && !PIN_RE.test(pin)) {
        clog.warn('rejected a malformed scorer PIN', { ip: clientIp(req) })
        return sendJson(res, 400, { error: 'PIN must be 1–8 digits' })
      }
      if (pin) patch.scorerPin = pin
      else delete patch.scorerPin
      if (clearPin) patch.scorerPin = ''
      const before = { ...settings.values }
      const prevBrightness = settings.values.brightness
      const updated = settings.update(patch)
      if (clearPin) clog.warn('scorer PIN removed — scoring is open to anyone on the network', { ip: clientIp(req) })
      // The match format is read live by the scoring engine, not just by the console header. Without
      // this a "Best of 3" save changed the header's idea of the deciding set while the engine kept
      // playing best-of-5: set 3 went to 25, and a 2-0 or 2-1 match never ended. Sources without a
      // format (basketball) simply have no setFormat.
      if (manualSource && typeof manualSource.setFormat === 'function') manualSource.setFormat({ bestOf: updated.bestOf })
      // Only what actually CHANGED, so the trail reads as a history of decisions rather than a
      // wall of unchanged preferences. Values are redacted by key name in the log store.
      const changes = {}
      for (const k of Object.keys(updated)) {
        if (JSON.stringify(before[k]) !== JSON.stringify(updated[k])) changes[k] = { from: before[k], to: updated[k] }
      }
      if (Object.keys(changes).length) clog.info(`settings changed: ${Object.keys(changes).join(', ')}`, changes)
      else clog.debug('settings saved with no change', { requested: Object.keys(patch) })
      // Brightness change → rewrite setting.ini + bounce the panel driver. Only when it actually
      // changed, so an unrelated settings save never blinks the panel.
      if ('brightness' in patch && updated.brightness !== prevBrightness) {
        clog.info(`panel brightness ${prevBrightness} → ${updated.brightness}${updated.brightness <= 0 ? ' (panel OFF)' : ''}`, {
          from: prevBrightness, to: updated.brightness, panelOff: updated.brightness <= 0,
        })
        applyBrightness(updated.brightness)
      }
      // The counter-colour thresholds live on the client; push the new totals so the board
      // recolours immediately.
      if (ledbox && typeof ledbox.setLimits === 'function') {
        ledbox.setLimits({
          totalTimeouts: updated.totalTimeouts,
          totalSubs: updated.totalSubs,
          idleFullNames: updated.idleFullNames,
          idleFontMax: updated.idleFontMax,
          matchFontMaxLeft: updated.matchFontMaxLeft,
          matchFontMaxRight: updated.matchFontMaxRight,
          clubName: updated.clubName,
        })
      }
      return sendJson(res, 200, { ...updated, scorerPin: '', pinSet: !!updated.scorerPin })
    }
    // GET /api/sport — the active sport + the pickable list (drives the UI's sport selector).
    if (pathname === '/api/sport' && req.method === 'GET') {
      return sendJson(res, 200, { sport: settings ? settings.values.sport : 'volleyball', sports: SPORT_LIST })
    }
    // POST /api/sport { sport } — switch sport. Persists the choice and restarts the appliance so
    // the new scoring rules, match layout and mapper are built cleanly at boot. Sport changes are
    // rare (once per event), so a ~6s restart beats the edge cases of a live hot-swap.
    if (pathname === '/api/sport' && req.method === 'POST') {
      const body = await readJson(req)
      if (!settings) return sendJson(res, 501, { error: 'settings unavailable' })
      if (!pinOk(req)) return denyPin(res, req)
      const wanted = String((body && body.sport) || '')
      if (!SPORT_LIST.some((s) => s.key === wanted)) {
        clog.warn(`rejected an unknown sport: ${wanted}`, { requested: wanted, known: SPORT_LIST.map((s) => s.key) })
        return sendJson(res, 400, { error: 'unknown sport' })
      }
      const prev = settings.values.sport
      // `allowSport` is what makes this the ONLY route that can change sport. The generic
      // POST /api/settings refuses it, because switching there would persist the new sport and
      // reshape the console while the running engine kept the old one — and without the marker
      // below or the restart, the board would never announce or apply the change.
      const updated = settings.update({ sport: wanted }, { allowSport: true })
      const changed = updated.sport !== prev
      // A sport change restarts the service, so this is the last line before a gap in the log —
      // worth being explicit about, or the restart reads as a crash.
      if (changed) clog.info(`sport ${prev} → ${updated.sport}; restarting the appliance`, { from: prev, to: updated.sport })
      else clog.debug('sport unchanged', { sport: updated.sport })
      // Leave a one-shot marker for the next boot to announce the new sport on the panel. The
      // idle screens are sport-neutral, so without it the switch is invisible on the board.
      // Best-effort: a failed write must never block the switch itself.
      if (changed && settings.file) {
        try {
          fs.writeFileSync(path.join(path.dirname(settings.file), '.sport-switch'), updated.sport)
        } catch (err) { console.error('[sport] could not mark switch:', err.message) }
      }
      sendJson(res, 200, { ok: true, sport: updated.sport, changed, restarting: changed })
      // Restart after the response flushes. On dev (no systemd unit) execFile just errors into the
      // ignored callback; the choice is persisted either way and applied on the next boot.
      if (changed) setTimeout(() => { execFile('sudo', ['systemctl', 'restart', 'ledbox-bridge'], () => {}) }, 700)
      return
    }
    // POST /api/link { source, matchId }
    if (pathname === '/api/link' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      const source = body && body.source
      if (source === 'cloud') return sendJson(res, 501, { error: 'cloud not implemented' })
      if (source !== 'lan') return sendJson(res, 400, { error: 'unknown source' })
      if (body.matchId == null) return sendJson(res, 400, { error: 'matchId required' })
      // Linking a live match leaves the crest/idle screen so the scoreboard paints.
      if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
      dropPrematch('linked a LAN match')
      clog.info(`linking to LAN match ${body.matchId}`, { matchId: String(body.matchId), relayUrl, ip: clientIp(req) })
      const lan = new LanSource({ relayUrl, matchId: String(body.matchId), reconnectMs })
      sourceManager.setSource(lan, { mode: 'lan', matchId: String(body.matchId) })
      return sendJson(res, 200, status())
    }
    // POST /api/countdown { seconds, label, content, swapFirst } — start the shared timer.
    // swapFirst (the set interval) applies next-set FIRST — swap ends + reset points — with the
    // board paint suppressed, so we go straight from the final score to the interval screen with
    // the swapped sets. One atomic sequence, no match-layout repaint to race the layout switch.
    if (pathname === '/api/countdown' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      const seconds = Number(body && body.seconds)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return sendJson(res, 400, { error: 'seconds must be a positive number' })
      }
      const content = ['full', 'sets', 'none'].includes(body && body.content) ? body.content : 'full'
      let state
      if (body && body.swapFirst) {
        ledbox._suppressPaint = true // update the state (+ _lastState) without painting the match
        manualSource.apply({ type: 'next-set' })
        ledbox._suppressPaint = false
        state = manualSource.getState()
        persist({ type: 'next-set' }, state, manualSource.lastEvent)
      }
      // `side` names the team that called the timeout; the board shows its short code so
      // the hall can see whose break it is. Resolved here rather than client-side so the
      // name always matches the state the board is painted from.
      let team = ''
      if (body && (body.side === 'left' || body.side === 'right')) {
        const v = toLeftRight(manualSource.getState())
        team = body.side === 'left' ? v.leftName : v.rightName
      }
      startCountdown(seconds, body && body.label, content, team, (body && (body.side === 'left' || body.side === 'right')) ? body.side : null)
      return sendJson(res, 200, { ok: true, state })
    }
    // POST /api/countdown/stop { expired } — clear the display timer. The UI-driven clock
    // reaches zero before the server tick does, so the client tells us WHY it stopped:
    // expired=true fires the end horn, a manual skip does not.
    if (pathname === '/api/countdown/stop' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      stopCountdown({ expired: !!(body && body.expired) })
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/idle { on, screen } — show the names+VS pre-match screen (on=false returns to
    // scoring). screen:'clock' is the console's "Show clock": the wall clock even with teams set,
    // held until scoring resumes or idle is turned off. Without it, today's screen (names if any).
    if (pathname === '/api/idle' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      const on = body ? body.on !== false : true
      const screen = on && body && body.screen === 'clock' ? 'clock' : 'auto'
      clog.info(on ? `operator switched to the idle screen${screen === 'clock' ? ' (clock)' : ''}` : 'operator returned to scoring', { idle: on, screen, ip: clientIp(req) })
      // An idle screen over a running countdown has to end the countdown — see holdClock.
      if (on) await stopCountdown({ expired: false, repaint: false })
      // Back to scoring from a pre-match is "Start match now" by another name.
      if (!on && prematch) await beginMatch('idle turned off')
      if (ledbox && typeof ledbox.showIdle === 'function') await ledbox.showIdle(on, { screen })
      return sendJson(res, 200, { ok: true, idle: on, screen: on ? screen : null, prematch })
    }
    // POST /api/prematch { action: 'start' } — the console's "Start match now": leave the pre-match
    // clock for the 0-0 scoreboard straight away. A warm-up still running is ended without the horn
    // (the scorer called it, the clock did not run out). Answers 200 with `started:false` when there
    // is no pre-match — a second tap from another tablet is not an error.
    if (pathname === '/api/prematch' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      if (!body || body.action !== 'start') return sendJson(res, 400, { error: "action must be 'start'" })
      const was = prematch
      if (was && countdown) await stopCountdown({ expired: false })
      const started = was && (prematch ? await beginMatch('start now') : true)
      if (was) alog.info('start match now', { ip: clientIp(req) })
      return sendJson(res, 200, { ok: true, started, ...status() })
    }
    // POST /api/unlock { pin } — verify a scorer PIN without performing an action.
    if (pathname === '/api/unlock' && req.method === 'POST') {
      const body = await readJson(req)
      // Goes through the same gate as the header path — this endpoint is the cheapest oracle on
      // the board, so guesses here must count towards the same lock, not get their own budget.
      const r = tryPin(req, (body && body.pin) || '')
      if (r.locked) {
        const secs = Math.ceil(r.retryAfterMs / 1000)
        res.setHeader('Retry-After', String(secs))
        return sendJson(res, 429, { ok: false, error: `too many wrong PINs — try again in ${secs}s`, retryAfterMs: r.retryAfterMs })
      }
      return sendJson(res, 200, { ok: r.ok })
    }
    // POST /api/clock { epochMs } — the console offering its own wall clock, for a board with no
    // RTC and no uplink. PIN-gated like every other mutation: it is privileged (it shells out to
    // `sudo date`) and a wildly wrong clock invalidates the board's TLS cert, which would lock the
    // operator out of the HTTPS console. Answers 200 with `applied:false` far more often than it
    // actually moves anything — see clockSync.js for the five gates and what each `reason` means.
    if (pathname === '/api/clock' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      const r = await clockSync.setFromConsole(body && body.epochMs)
      return sendJson(res, r.ok ? 200 : 400, r)
    }
    // GET /api/game — what the New / Continue / Delete / Clock menu needs for the active sport.
    if (pathname === '/api/game' && req.method === 'GET') {
      return sendJson(res, 200, { sport: activeSport(), saved: resume.summary(activeSport()) })
    }
    // POST /api/game { choice: 'new' | 'continue' | 'delete' | 'clock', teams? }
    if (pathname === '/api/game' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req)
      const choice = body && body.choice
      const sport = activeSport()

      // Delete the saved game. When the board is still showing that game — or nothing has been
      // done since boot / Continue — the panel is cleared too: a fresh 0-0 with no names, and the
      // wall clock held on the panel. Deleting only the file left the deleted match on the wall,
      // which reads to the volunteer as "Delete did nothing". A board showing some OTHER match
      // (a finished one whose slot is already gone, a linked LAN match) is left alone.
      if (choice === 'delete') {
        const saved = resume.get(sport)
        const manual = sourceManager.status.mode !== 'lan'
        const live = manualSource ? manualSource.getState() : null
        const showingSaved = !!(saved && live && sameBoard(saved, live))
        const clears = !!manualSource && manual && (showingSaved || !touchedSinceStart)
        resume.clear(sport)
        if (clears) {
          if (ledbox && typeof ledbox.clearResult === 'function') await ledbox.clearResult()
          // Clock FIRST: pushState is held while idle is up, so the reset below never flashes a
          // 0-0 scoreboard between the old match and the clock.
          await holdClock()
          sourceManager.setSource(manualSource, { mode: 'manual' })
          manualSource.apply({ type: 'reset' })
          clearUndo()
          dropPrematch('saved game deleted')
          // Same as New: an abandoned match must not stay open in the log and swallow the next one.
          if (keepsHistory()) try { history.record({ type: 'reset' }, manualSource.getState(), null, nowStamp(), nowClock()) } catch (e) { log.error('history', `record failed: ${e && e.message}`, e) }
          touchedSinceStart = false
        }
        clog.info(clears ? 'saved game deleted — board cleared to the clock' : 'saved game deleted — board left as it is', {
          sport, hadSaved: !!saved, showingSaved, cleared: clears, ip: clientIp(req),
        })
        return sendJson(res, 200, { ok: true, saved: null, cleared: clears, ...status() })
      }
      // "Just show the clock": park the panel on the clock without touching the score.
      if (choice === 'clock') {
        await holdClock()
        return sendJson(res, 200, { ok: true, saved: resume.summary(sport), ...status() })
      }
      if (choice === 'new' || choice === 'continue') {
        const saved = choice === 'continue' ? resume.get(sport) : null
        if (choice === 'continue' && !saved) return sendJson(res, 404, { error: 'no saved game for this sport' })
        const teams = choice === 'new' ? cleanTeams(body && body.teams) : null
        if (teams) return startScheduledGame(res, req, sport, teams, { prematch: !!(body && body.prematch === true) })
        // Continuing a game saved during its pre-match goes back to the pre-match: names set,
        // 0-0, the clock on the panel.
        if (saved && resume.isPrematch(sport)) return restorePrematch(res, sport, saved)
        dropPrematch(choice === 'new' ? 'new game' : 'continued a saved game')
        // Lift idle FIRST: pushState is deliberately suppressed while an idle screen is up, so
        // restoring the state before this would leave the crest on the panel and the scoreboard
        // unpainted until the next point.
        // Lift whatever non-match screen is up. This used to test `_idle` alone, which was true of
        // the only other screen that existed; the result screen is held up by its LAYOUT instead
        // (pushState refuses to paint while another layout is current), so an `_idle`-only check
        // left the finished match on the panel and the new game unpainted until the first point.
        const offMatch = ledbox && (ledbox._idle || (ledbox.currentLayout && ledbox.currentLayout !== ledbox.layout))
        // Wipe the result screen while it is still the layout in front of us. The board keeps
        // every layout's section values, so leaving it holding this match's winner means the NEXT
        // match end briefly shows the previous team's name.
        if (ledbox && typeof ledbox.clearResult === 'function') await ledbox.clearResult()
        if (offMatch && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
        sourceManager.setSource(manualSource, { mode: 'manual' })
        manualSource.apply(saved ? { type: 'set-state', state: saved } : { type: 'reset' })
        clearUndo()
        // Starting fresh discards the old slot; it refills from the first point of the new match.
        // It also closes the match log's open buffer. The log only starts a new match on a `reset`
        // it is shown, and this reset never went through /api/action — so an abandoned match (a
        // friendly stopped at 1-1) stayed open and the next match's rallies were appended to it,
        // archived under the old match's date. Continue leaves the buffer alone: it is the same match.
        if (choice === 'new') {
          resume.clear(sport)
          if (keepsHistory()) try { history.record({ type: 'reset' }, manualSource.getState(), null, nowStamp(), nowClock()) } catch (e) { log.error('history', `record failed: ${e && e.message}`, e) }
        }
        touchedSinceStart = false
        return sendJson(res, 200, { ok: true, saved: resume.summary(sport), ...status() })
      }
      return sendJson(res, 400, { error: 'choice must be new, continue, delete or clock' })
    }
    // POST /api/message { text, seconds, swap } — hold a full-panel announcement, then return to
    // the match. Used for the change of ends, which wants an instruction rather than a countdown.
    //
    // `swap` flips the ends BEHIND the announcement (paint suppressed, exactly as
    // /api/countdown{swapFirst} does), so the board comes back already showing the new
    // arrangement instead of flashing the old one on the way past.
    //
    // Answers immediately rather than holding the socket open for the whole hold — the console
    // has a match to run, and a request that blocks for three seconds is three seconds in which a
    // scored point queues behind it.
    if (pathname === '/api/message' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req) || {}
      // Same clamp as the result screen: operator-typed text landing on the hall's scoreboard.
      const text = String(body.text == null ? '' : body.text).replace(/[^\x20-\x7EÀ-ÿ]/g, '').slice(0, 32)
      if (!text) return sendJson(res, 400, { error: 'text is required' })
      const seconds = Number(body.seconds)
      const ms = Math.round(Math.min(15, Math.max(0.5, Number.isFinite(seconds) ? seconds : 3)) * 1000)
      let state
      if (body.swap && ledbox) {
        ledbox._suppressPaint = true
        manualSource.apply({ type: 'swap' })
        ledbox._suppressPaint = false
        state = manualSource.getState()
        persist({ type: 'swap' }, state, manualSource.lastEvent)
      }
      clog.info(`announcement: ${text}`, { text, ms, swap: !!body.swap, ip: clientIp(req) })
      const shown = ledbox && typeof ledbox.showMessage === 'function'
      // Deliberately not awaited (see above). Failures land in the log via the client's own
      // error path; the console does not need to wait to find out the panel lacks the layout.
      if (shown) ledbox.showMessage(text, { ms }).catch(() => {})
      return sendJson(res, 200, { ok: !!shown, state })
    }
    // POST /api/result — put the finished match on the panel (winner / set score / every set).
    // The console works out the wording, because what the "score" line means is sport-specific
    // (sets won for volleyball and beach, final points for basketball) and the board does not
    // need to know. Everything is clamped here rather than trusted: these strings are built from
    // operator-typed team names and land straight on the hall's scoreboard.
    if (pathname === '/api/result' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      const body = await readJson(req) || {}
      // Printable ASCII plus the accented Latin-1 letters the panel font actually carries
      // (ARIAL.TTF: äöüÄÖÜéèàçñÉÈÀ). ASCII-only silently ate them — "ZÜRICH WINS" reached the
      // hall as "ZRICH WINS", and it only became reachable once team names started being
      // upper-cased for the board. Anything outside both sets is still dropped.
      const line = (v, max) => String(v == null ? '' : v).replace(/[^\x20-\x7EÀ-ÿ]/g, '').slice(0, max)
      const color = HEX_COLOR.test(String(body.color || '')) ? hexToRgb(body.color) : undefined
      const ok = ledbox && typeof ledbox.showResult === 'function'
        ? await ledbox.showResult({
          winner: line(body.winner, 24), score: line(body.score, 24), history: line(body.history, 60), color,
        })
        : false
      if (!ok) return sendJson(res, 200, { ok: false, error: 'the board has no result screen', ...status() })
      clog.info(`result screen shown: ${line(body.winner, 24)} ${line(body.score, 24)}`)
      return sendJson(res, 200, { ok: true, ...status() })
    }
    // GET /api/history — completed matches (newest first) for the History tab + export
    if (pathname === '/api/history' && req.method === 'GET') {
      return sendJson(res, 200, history.list())
    }
    // POST /api/history/clear — wipe the log
    if (pathname === '/api/history/clear' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      await readJson(req) // drain
      clog.warn('match history cleared', { matches: history.list().matches.length, ip: clientIp(req) })
      history.clear()
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/shutdown — halt the board cleanly (protects the SD card). Fires after the
    // response flushes; the bridge runs as pi with passwordless sudo for systemctl.
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      await readJson(req) // drain
      // The last line before the card goes quiet. Flushed immediately so it survives the halt.
      clog.warn('shutdown requested — halting the board', { ip: clientIp(req) })
      log.flush()
      sendJson(res, 200, { ok: true })
      setTimeout(() => { execFile('sudo', ['systemctl', 'poweroff'], () => {}) }, 700)
      return
    }
    // POST /api/reboot — the same clean halt, then straight back up (~45 s). For a board that
    // looks stuck, and for the firmware's in-memory layouts: it only re-reads the layout XMLs at
    // start, so a label another sport blanked stays blank until the firmware restarts.
    if (pathname === '/api/reboot' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      await readJson(req) // drain
      clog.warn('restart requested — rebooting the board', { ip: clientIp(req) })
      log.flush()
      sendJson(res, 200, { ok: true })
      setTimeout(() => { execFile('sudo', ['systemctl', 'reboot'], () => {}) }, 700)
      return
    }

    // ── /logs ────────────────────────────────────────────────────────────────
    // GET /api/logs?level=&scope=&q=&sinceId=&limit= — filtered slice of the ring buffer,
    // plus the stats the page needs to render its filter chips and counters.
    if (pathname === '/api/logs' && req.method === 'GET') {
      const p = new URL(req.url, 'http://localhost').searchParams
      return sendJson(res, 200, {
        entries: log.query({
          level: p.get('level') || undefined,
          scope: p.get('scope') || undefined,
          q: p.get('q') || undefined,
          sinceId: p.get('sinceId') || undefined,
          limit: p.get('limit') || undefined,
        }),
        stats: log.stats(),
      })
    }
    // GET /api/logs/stream — Server-Sent Events live tail. Chosen over a WebSocket because
    // the appliance has no ws dependency in production and SSE reconnects on its own.
    if (pathname === '/api/logs/stream' && req.method === 'GET') {
      const p = new URL(req.url, 'http://localhost').searchParams
      const level = p.get('level') || undefined
      const scope = p.get('scope') || undefined
      res.writeHead(200, {
        ...res._cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Send the headers NOW. writeHead only queues them, and on a quiet board nothing else is
      // written until a log line or the 20s keep-alive — EventSource.onopen waits for them, so the
      // /logs chip sat on "connecting…" while the stream was perfectly healthy.
      res.write(': open\n\n')
      // Catch up on what the client missed, then stream. An EventSource reconnecting on its own
      // sends the last id it saw as Last-Event-ID, not as ?sinceId — without honouring it, every
      // reconnect replayed the last 200 lines as if they were new. The header wins over the URL:
      // both pages put ?sinceId in the URL, and an automatic reconnect reuses that stale URL, so
      // the header is always the more recent of the two. A fresh page load sends no header.
      const sinceId = req.headers['last-event-id'] || p.get('sinceId') || undefined
      for (const e of log.query({ level, scope, sinceId, limit: 200 })) {
        res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`)
      }
      const matches = (e) => {
        if (level && LEVELS[level] && LEVELS[e.level] < LEVELS[level]) return false
        if (scope && !scope.split(',').map((s) => s.trim()).includes(e.scope)) return false
        return true
      }
      const unsubscribe = log.subscribe((e) => {
        if (!matches(e)) return
        try { res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`) } catch { /* client went away */ }
      })
      // Proxies and phones drop an idle connection; a comment frame every 20s keeps it up.
      const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { /* ignore */ } }, 20000)
      if (keepAlive.unref) keepAlive.unref()
      streams.add(res)
      const done = () => { clearInterval(keepAlive); unsubscribe(); streams.delete(res) }
      req.on('close', done)
      req.on('error', done)
      return
    }
    // POST /api/logs { level, msg, data } — the browser's own errors. Deliberately open (no
    // PIN): a spectator's phone hitting a bug is exactly what this is for. Rate-limited above.
    if (pathname === '/api/logs' && req.method === 'POST') {
      // Its own small cap, not MAX_BODY: at 1 MiB this route was a remote OOM.
      const body = await readJson(req, UI_LOG_MAX_BODY)
      if (!uiRateOk(clientIp(req), Date.now())) return sendJson(res, 429, { error: 'too many log posts' })
      const level = LEVELS[body && body.level] ? body.level : 'error'
      log.log(level, 'ui', String((body && body.msg) || 'ui event').slice(0, UI_LOG_MAX_MSG), {
        ...(body && typeof body.data === 'object' ? body.data : { detail: body && body.data }),
        ua: String(req.headers['user-agent'] || '').slice(0, 120),
        ip: clientIp(req),
      })
      return sendJson(res, 200, { ok: true })
    }
    // POST /api/logs/level { level } — turn the firehose on for a match without a restart.
    if (pathname === '/api/logs/level' && req.method === 'POST') {
      const body = await readJson(req)
      if (!pinOk(req)) return denyPin(res, req)
      const wanted = String((body && body.level) || '')
      if (!LEVELS[wanted]) return sendJson(res, 400, { error: 'unknown level' })
      const prev = log.level
      log.setLevel(wanted)
      clog.info(`log level ${prev} → ${wanted}`, { from: prev, to: wanted, ip: clientIp(req) })
      return sendJson(res, 200, { ok: true, level: wanted })
    }
    // POST /api/logs/clear — wipe memory + the files on disk.
    if (pathname === '/api/logs/clear' && req.method === 'POST') {
      if (!pinOk(req)) return denyPin(res, req)
      await readJson(req) // drain
      log.clear()
      clog.warn('logs cleared', { ip: clientIp(req) })
      return sendJson(res, 200, { ok: true, stats: log.stats() })
    }
    // GET /api/logs/export — the whole trail as JSONL, oldest rotation first, for an email
    // or a bug report. Falls back to the memory ring when nothing was persisted.
    if (pathname === '/api/logs/export' && req.method === 'GET') {
      log.flush()
      const files = log.files().reverse() // .2 → .1 → active, so the download reads forward in time
      const headers = {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="ledbox-logs-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      }
      // Nothing on disk (memory-only board, or the logs were just cleared): serve the ring.
      if (!files.length) {
        return send(res, 200, log.query({ limit: log.stats().maxEntries }).map((e) => JSON.stringify(e)).join('\n'), headers)
      }
      // Streamed one rotation at a time rather than concatenated into a single ~15 MB string.
      // The route stays open by design (docs/logging-DESIGN.md: reads stay open, writes need the
      // PIN), so the cost of someone looping it has to be bounded here instead — and the old
      // blocking readFileSync ran on the same event loop that paints the panel, which is a
      // frozen scoreboard during a rally, not just a slow download.
      res.writeHead(200, { ...res._cors, ...headers })
      for (const f of files) {
        if (res.writableEnded || res.destroyed) break // the client went away mid-download
        await pipeFile(f.path, res)
      }
      return res.end()
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  // New game with both teams already named — the console's "start from today's schedule", home on
  // the left. The names go in BEFORE anything is painted: the reset and both team edits are applied
  // with the paint held, so the hall never sees HOME / AWAY (or the previous match) in between,
  // and the first frame is the new match at 0-0 under its own names. Persisted like any scoring
  // action, so a power cut before the first rally still brings the names back.
  //
  // `prematch` (the console always sends it from the schedule) sets the game up but keeps the hall
  // on the clock: the clock goes up FIRST — pushState is held while idle is up, so nothing of the
  // new match reaches the panel — and the match itself is painted later by beginMatch().
  async function startScheduledGame(res, req, sport, teams, { prematch: pre = false } = {}) {
    const offMatch = ledbox && (ledbox._idle || (ledbox.currentLayout && ledbox.currentLayout !== ledbox.layout))
    if (ledbox && typeof ledbox.clearResult === 'function') await ledbox.clearResult()
    if (pre) await holdClock()
    // Without a pre-match the new game is painted at once, so a countdown still running (a warm-up
    // started before the game was picked) must not keep the break screen over it.
    else await stopCountdown({ expired: false, repaint: false })
    if (ledbox) ledbox._suppressPaint = true
    try {
      sourceManager.setSource(manualSource, { mode: 'manual' })
      manualSource.apply({ type: 'reset' })
      for (const side of ['left', 'right']) {
        const t = teams[side]
        manualSource.apply({ type: 'team', side, name: t.name, short: t.short })
      }
    } finally {
      if (ledbox) ledbox._suppressPaint = false
    }
    const state = manualSource.getState()
    clearUndo()
    resume.clear(sport)
    prematch = pre
    if (keepsHistory()) try { history.record({ type: 'reset' }, state, null, nowStamp(), nowClock()) } catch (e) { log.error('history', `record failed: ${e && e.message}`, e) }
    try { resume.save(sport, state, nowStamp(), { prematch: pre }) } catch (e) { log.error('resume', `save failed: ${e && e.message}`, e) }
    touchedSinceStart = false
    // One paint, of the new state. Lifting idle repaints from the state the client now holds;
    // already on the scoreboard, push it. A pre-match paints nothing: the clock stays up.
    if (pre) { /* held on the clock until beginMatch() */ }
    else if (offMatch && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
    else if (ledbox && typeof ledbox.pushState === 'function') await Promise.resolve(ledbox.pushState(state)).catch(() => {})
    clog.info(`new game from the schedule${pre ? ' (pre-match: the board keeps the clock)' : ''}: ${teams.left.short || teams.left.name} v ${teams.right.short || teams.right.name}`, {
      sport, left: teams.left, right: teams.right, prematch: pre, ip: clientIp(req),
    })
    return sendJson(res, 200, { ok: true, saved: resume.summary(sport), ...status() })
  }

  // Bring back a game saved during its pre-match (Continue, or a restart — see
  // server.resumeInterruptedGame): the state goes in behind the held clock, and the pre-match is on
  // again exactly as it was left.
  async function applyPrematch(sport, saved) {
    if (ledbox && typeof ledbox.clearResult === 'function') await ledbox.clearResult()
    await holdClock()
    sourceManager.setSource(manualSource, { mode: 'manual' })
    manualSource.apply({ type: 'set-state', state: saved })
    clearUndo()
    prematch = true
    touchedSinceStart = false
    clog.info('pre-match restored — the board keeps the clock until the match starts', { sport })
  }
  async function restorePrematch(res, sport, saved) {
    await applyPrematch(sport, saved)
    return sendJson(res, 200, { ok: true, saved: resume.summary(sport), ...status() })
  }

  function status() {
    const { mode, matchId } = sourceManager.status
    return {
      mode, matchId,
      sport: settings ? settings.values.sport : 'volleyball',
      // A schedule start waiting on the clock for its warm-up / "Start match now" (see `prematch`).
      prematch,
      // Where the scorer sits (settings.js). The console mirrors its team cards by it; nothing on
      // the server side changes with it.
      orientation: settings ? settings.values.orientation : 'behind',
      pinRequired: !!(settings && settings.values.scorerPin),
      // So the console knows whether its clock is wanted. `synchronized:false` is the console's
      // cue to offer one at unlock; `true` means NTP has it and the offer would be ignored anyway.
      clock: clockSync.viewSync(),
      ledbox: {
        connected: ledbox.ready === true, host: ledbox.host, port: ledbox.port, layout: ledbox.currentLayout,
        // What the idle screen is doing, so the console can show 'Show clock' as the active choice.
        idle: !!ledbox._idle, clockHeld: !!(ledbox._idle && ledbox._clockHeld),
      },
      // The name sizes the match screen is painted with, per PANEL side — the operator's ceiling
      // after the mapper's shrink-to-fit — so the console's preview draws the names at the board's
      // own size instead of guessing (and a long name no longer runs into the set score there).
      board: { fontsize: matchFontsize() },
      state: sourceManager.getState(),
      ...undoView(),
    }
  }

  // What the console's Undo button needs: whether there is anything to take back, and in words what
  // it is. Only while the hand-scored source is the one on the board — linked to a LAN match, an
  // undo would silently repaint a different score than the one the hall is watching.
  function undoView() {
    const live = sourceManager.status.mode === 'manual' && manualSource && manualSource.canUndo === true
    return { canUndo: !!live, undoLabel: live ? String(manualSource.undoLabel || '') : '' }
  }

  // A fresh match on the board: nothing before it is undoable, in the source or in the log.
  function clearUndo() {
    if (manualSource && typeof manualSource.clearUndo === 'function') manualSource.clearUndo()
    history.clearUndo()
  }

  // The exact SetSections payload the LedBox is showing right now, folded into a
  // { sectionName: {text,color} } map so a browser can render a 1:1 mirror of the
  // physical board. Works with or without hardware (it maps the live liveState the
  // same way the LedboxClient does before pushing).
  function board() {
    return {
      layout: ledbox.layout,
      connected: ledbox.ready === true,
      mode: sourceManager.status.mode,
      countdown: countdownView(),
      screen: matchScreen(),
    }
  }

  // The match screen exactly as the real paint builds it — same mapper, same options — so
  // /api/board (and the virtual panel it feeds) and the console preview show the same name sizes
  // and counter colours as the panel on the wall.
  function matchScreen() {
    const state = sourceManager.getState() || {}
    return sectionsToScreen(ledbox.mapper.toSections(state, {
      totalTimeouts: ledbox.totalTimeouts, totalSubs: ledbox.totalSubs,
      matchFontMaxLeft: ledbox.matchFontMaxLeft, matchFontMaxRight: ledbox.matchFontMaxRight,
    }))
  }

  // Per-side team-name font size of the match screen (team1 = panel left, team2 = panel right in
  // every sport's mapper). Never throws: a status poll must not fail over a preview nicety.
  function matchFontsize() {
    try {
      const screen = matchScreen()
      const px = (n) => { const v = Number(screen[n] && screen[n].fontsize); return Number.isFinite(v) && v > 0 ? v : null }
      return { left: px('team1'), right: px('team2') }
    } catch { return { left: null, right: null } }
  }

  // Query the OpenVolley relay for its match list; never throws (failures land in errors[]).
  async function listMatches() {
    const errors = []
    const matches = []
    // No relay configured at all (RELAY_HTTP_URL= empty). Without this the template below builds
    // the bare path "/api/match/list", and Node's fetch — unlike a browser's — has no base URL to
    // resolve it against, so it throws "Failed to parse URL from /api/match/list". That reads like
    // a bug in the request rather than a missing setting, which is exactly the wrong hint.
    if (!relayHttpUrl) {
      clog.debug('no relay configured — match list is empty by design', { relayHttpUrl })
      return { matches, errors: ['lan: no relay configured (RELAY_HTTP_URL is empty)'] }
    }
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2000)
      let data
      try {
        const resp = await fetch(`${relayHttpUrl}/api/match/list`, { signal: ctrl.signal })
        if (!resp.ok) throw new Error(`relay responded ${resp.status}`)
        data = await resp.json()
      } finally {
        clearTimeout(timer)
      }
      const list = Array.isArray(data) ? data : (data.matches || data.list || [])
      for (const m of list) {
        const num = m.gameNumber || m.game_n || m.id
        const home = m.homeShort || m.home_short || m.homeTeam || m.home || ''
        const away = m.awayShort || m.away_short || m.awayTeam || m.away || ''
        const teams = home || away ? ` ${home}-${away}` : ''
        // Clamped rather than passed through: this id is rendered by the console's match list
        // and posted straight back to /api/link, so whatever occupies RELAY_HTTP_URL gets a say
        // in what lands there. An id can only ever be word characters, a dot or a dash.
        matches.push({ source: 'lan', id: safeMatchId(m.id), label: `${num}${teams}`, live: m.status === 'live' })
      }
      clog.debug(`relay listed ${matches.length} match(es)`, { count: matches.length, relayHttpUrl })
    } catch (err) {
      // The Link tab shows "no matches" either way; only the log distinguishes "the relay is
      // unreachable" from "the relay has nothing".
      clog.warn(`could not list matches from the relay: ${err.message}`, { relayHttpUrl, error: err.message })
      errors.push(`lan: ${err.message}`)
    }
    return { matches, errors }
  }

  // Boot recovery after a crash. The unit is Restart=always, and until this existed a bridge that
  // died at 22-21 came back on the crest with 0-0 behind it and stayed there until somebody
  // realised and pressed Continue — so a repeating fault (an OOM, a bad reply from the panel)
  // meant the scoreboard silently lost the match in front of the hall, while `systemctl is-active`
  // still said `active`.
  //
  // Caller decides WHETHER to call this; see the unclean-shutdown marker in appliance.js. The
  // deliberate restarts (a deploy, a sport switch) shut down cleanly and do not, because an
  // operator is standing there and the game menu is the right answer for them. Note we cannot
  // key this on the slot's age instead: the board has no RTC, and its clock has been 36 h out.
  //
  // Same steps as the "continue" branch of POST /api/game, in the same order and for the same
  // reason — pushState is suppressed while an idle screen is up, so idle must be lifted first or
  // the crest stays on the panel and the scoreboard goes unpainted until the next point.
  server.resumeInterruptedGame = async () => {
    const sport = activeSport()
    const saved = resume.get(sport)
    if (!saved) return null
    const info = resume.summary(sport)
    // A game still in its pre-match comes back to the pre-match: the clock, not the scoreboard.
    if (resume.isPrematch(sport)) {
      await applyPrematch(sport, saved)
      return info
    }
    if (ledbox && ledbox._idle && typeof ledbox.showIdle === 'function') await ledbox.showIdle(false)
    sourceManager.setSource(manualSource, { mode: 'manual' })
    manualSource.apply({ type: 'set-state', state: saved })
    clearUndo()
    touchedSinceStart = false
    dropPrematch('restored an interrupted match')
    clog.warn('restored the interrupted match after an unclean shutdown — press New if this is not the game in the room', {
      sport, teams: info && info.teams, points: info && info.points, sets: info && info.sets, updatedAt: info && info.updatedAt,
    })
    return info
  }

  // End every open log stream. Called by the appliance's close() before it closes the listeners,
  // so an open /logs tab can't hold the shutdown; the browser's EventSource reconnects on its own
  // once the new process is up.
  // Whether the saved slot for the active sport is a pre-match. The appliance restores one at every
  // boot, clean or not: the board shows the clock at boot anyway, so bringing the pre-match back
  // only puts the console's "Ready" banner (and the names) back where the scorer left them.
  server.savedPrematch = () => resume.isPrematch(activeSport())

  server.closeStreams = () => {
    for (const res of streams) { try { res.end() } catch { /* already gone */ } }
    streams.clear()
  }

  return server
}

// Acknowledge an entry ON THE BOARD, not just in the operator's app: the scored point (or
// the substitution just used up) blinks for a couple of seconds. The mapper always paints
// physical left -> section 1, so the action's side maps straight onto the section number.
// Only additions blink — correcting a mistake downward should be quiet.
function pulseForAction(ledbox, action = {}, settings = null, state = null) {
  if (!ledbox || typeof ledbox.pulse !== 'function') return
  if (!(Number(action.delta) > 0)) return // only a real +1 blinks — not a typed correction
  const s = settings ? settings.values : {}
  const ms = s.blinkMs
  const n = action.side === 'right' ? '2' : '1'
  // Blink in the team's own colour (the board would otherwise use the layout default).
  const v = state ? toLeftRight(state) : null
  const color = v ? (action.side === 'right' ? v.rightColor : v.leftColor) : null
  if (action.type === 'point' && s.blinkPoint !== false) ledbox.pulse(`score${n}`, ms, color)
  else if (action.type === 'sub' && s.blinkSub !== false) ledbox.pulse(`sub${n}`, ms, color)
}

// --- helpers ---

// A same-origin fetch — which is everything the console, the mirror and the log page do — sends
// no Origin header at all, so "absent" HAS to count as same-origin or the scorer's own tablet
// stops working. Non-browser clients (curl, the selftests, deploy-board.sh) send none either.
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host || ''
  return origin === `http://${host}` || origin === `https://${host}`
}

// Reflect a same-origin Origin; answer a foreign one with no Access-Control-Allow-Origin at all,
// which is what stops another LAN page reading the board's state and log trail out of it.
function corsHeaders(req) {
  const origin = req.headers.origin
  if (origin && isSameOrigin(req)) return { ...CORS, 'Access-Control-Allow-Origin': origin }
  return { ...CORS }
}

// One 60s window per source address. The map is swept of expired windows once it grows past
// UI_RATE_MAX_IPS, and cleared outright if that isn't enough — the rate limiter for an
// unauthenticated route must not itself become the unbounded thing it exists to prevent.
function uiRateOk(ip, now) {
  let r = uiRate.get(ip)
  if (!r || now - r.windowStart > 60000) { r = { windowStart: now, count: 0 }; uiRate.set(ip, r) }
  if (uiRate.size > UI_RATE_MAX_IPS) {
    for (const [k, v] of uiRate) if (now - v.windowStart > 60000) uiRate.delete(k)
    if (uiRate.size > UI_RATE_MAX_IPS) { uiRate.clear(); uiRate.set(ip, r) }
  }
  return ++r.count <= UI_LOG_PER_MIN
}

// Strip a team colour that isn't a #rrggbb literal out of an action before it reaches the
// source. Dropped rather than rejected, and reported through `onDrop` so the trail still shows
// that something tried. `set-state` is included because that is how a whole board — colours and
// all — arrives from the resume slot and from the direct-entry editor.
function scrubColors(action, onDrop) {
  if (action.type === 'team' && action.color != null && !HEX_COLOR.test(String(action.color))) {
    onDrop(String(action.color))
    delete action.color
  }
  if (action.type === 'set-state' && action.state && typeof action.state === 'object') {
    for (const k of ['team_a_color', 'team_b_color']) {
      const v = action.state[k]
      if (v != null && !HEX_COLOR.test(String(v))) { onDrop(String(v)); delete action.state[k] }
    }
  }
}

// `teams` from POST /api/game { choice:'new', teams:{ left:{name,short}, right:{name,short} } },
// clamped the way every other operator-typed string bound for the panel is (see /api/result):
// printable ASCII plus the accented Latin-1 letters the panel font carries. null when the body
// names no team at all, which keeps the plain New exactly as it was.
function cleanTeams(teams) {
  if (!teams || typeof teams !== 'object') return null
  const line = (v, max) => String(v == null ? '' : v).replace(/[^\x20-\x7EÀ-ÿ]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
  const side = (t) => ({ name: line(t && t.name, 40), short: line(t && t.short, 12) })
  const out = { left: side(teams.left), right: side(teams.right) }
  const any = (t) => t.name || t.short
  return any(out.left) || any(out.right) ? out : null
}

// Is the live board the same game as the saved slot? Compared by what the hall sees, key-order
// independent: the slot is a JSON round-trip of an earlier getState(), so reference or
// string equality of the objects would never hold.
function sameBoard(a, b) {
  const stable = (v) => (Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
      : JSON.stringify(v))
  return stable(a) === stable(b)
}

// A relay-supplied match id, clamped to something that can only ever be an id.
const safeMatchId = (v) => String(v).replace(/[^\w.-]/g, '').slice(0, 64)

// Pipe one log rotation into an already-open response. Resolves on 'close', which fires after
// end, error or destroy alike — an unreadable rotation is skipped exactly the way the old
// readFileSync's catch skipped it, because half a trail beats a failed download.
function pipeFile(filePath, res) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => { /* skip an unreadable rotation */ })
    stream.on('close', resolve)
    res.on('close', () => stream.destroy())
    stream.pipe(res, { end: false })
  })
}

// Who sent this — enough to tell the scorer's tablet from a spectator's phone on the venue LAN.
function clientIp(req) {
  const raw = (req.socket && req.socket.remoteAddress) || ''
  return raw.replace(/^::ffff:/, '') // unwrap the IPv4-mapped IPv6 form
}

// Counters arrive either as a number or as an array of entries (timeouts/subs carry detail in
// some sources); both mean "how many".
const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

// One readable sentence per action for the log's message column. The structured payload
// logged alongside carries the raw action, so this only has to be scannable.
function actionLine(action, state) {
  const score = `${count(state.points_a)}-${count(state.points_b)}`
  const side = action.side === 'right' ? 'right' : 'left'
  const d = Number(action.delta)
  const delta = Number.isFinite(d) ? `${d > 0 ? '+' : ''}${d}` : ''
  switch (action.type) {
    case 'point': return `point ${side} ${delta} → ${score}`
    case 'set': return `set ${side} ${delta}`
    case 'timeout': return `timeout ${side} ${delta}`
    case 'sub': return `sub ${side} ${delta}`
    case 'serve': return `serve → ${action.side || action.value || '?'}`
    case 'serve-order': return 'beach serve order set'
    case 'serve-player': return `serving player → ${action.player ?? '?'}`
    case 'swap': return 'sides swapped'
    case 'team': return `team ${side} edited`
    case 'next-set': return `next set → ${count(state.sets_won_a)}-${count(state.sets_won_b)}`
    case 'remove-set': return 'set removed'
    case 'reset': return 'match reset'
    case 'set-state': return `state set directly → ${score}`
    default: return `${action.type} ${side}`.trim()
  }
}

// Local wall-clock stamp "YYYY-MM-DD HH:MM" for history entries. (The board clock may be
// off until it gets NTP on the venue LAN; the timeline stays internally consistent.)
function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Time of day for a single entry in the match log. Seconds, not minutes: a rally, its correction
// and the timeout that followed can all fall inside one minute, and a play-by-play in which they
// share a timestamp cannot be read back in order.
function nowClock() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Fold a SetSections `value` array into { sectionName: { text, color } } — mirrors
// MockLedbox._applySections so the web view shows exactly what the device holds.
function sectionsToScreen(sections) {
  const screen = {}
  for (const s of sections) {
    // The WRITE shape carries ONE attribute per entry, so a section appears once per
    // attribute. Accumulate into the existing entry — replacing it lets the `color`
    // entry wipe the `text` the same section set a moment earlier.
    const cur = screen[s.name] || (screen[s.name] = {})
    const attrs = Array.isArray(s.value) ? s.value : [s.value]
    for (const a of attrs) {
      if (a.attrib === 'text') cur.text = a.value
      if (a.attrib === 'color') cur.color = a.value
      if (a.attrib === 'fontsize') cur.fontsize = a.value
    }
  }
  return screen
}

// Serve a file from webDir (or index.html for "/"), rejecting any path escaping webDir.
function serveStatic(res, pathname, webDir) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = path.resolve(webDir, rel)
  const root = path.resolve(webDir)
  if (full !== root && !full.startsWith(root + path.sep)) return send(res, 403, 'forbidden')
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'not found')
    const type = CONTENT_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream'
    // The whole UI is one self-contained file that we redeploy often; never let a phone serve a
    // stale cached copy (that surfaced as "the board doesn't switch" after a fix was deployed).
    send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'no-cache, no-store, must-revalidate' })
  })
}

// Read + JSON-parse a request body. Empty body -> {}. Invalid JSON throws SyntaxError.
// `limit` lets a route ask for a tighter ceiling than the general one — /api/logs is
// unauthenticated, so 1 MiB there is a remote heap bomb rather than a generous default.
function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    // Reject an oversized Content-Length up front so a well-behaved client still gets
    // a clean 413 (leave the socket alive to carry the response).
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      const e = new Error('request body too large'); e.statusCode = 413
      return reject(e)
    }
    let raw = ''
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      // Cap accumulation so a slow-drip / chunked body can't exhaust the heap; a client
      // that lies about its length gets the connection torn down.
      if (size > limit) {
        done = true
        const e = new Error('request body too large'); e.statusCode = 413
        req.destroy()
        return reject(e)
      }
      raw += c
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  send(res, code, obj == null ? '' : JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...(res._cors || CORS), ...headers })
  res.end(body == null ? undefined : body)
}
