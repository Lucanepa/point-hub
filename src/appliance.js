// LedBox appliance — a self-contained controller for a Tech4Sport LedBox with a web UI.
// Serves a manual scoreboard controller plus a "link to a live LAN match" mode, pushing
// the resulting liveState onto the LedBox.
//
//   web UI --HTTP--> controlServer --> SourceManager --liveState--> LedboxClient --> LedBox
//
// Run: node src/appliance.js   (configure via environment; see .env.example)

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import { loadConfig } from './config.js'
import { LedboxClient } from './ledboxClient.js'
import { MockLedbox } from './mockLedbox.js'
import { getSport, DEFAULT_SPORT } from './sports.js'
import { livePushFromEnv } from './livePush.js'
import { SourceManager } from './sourceManager.js'
import { createControlServer } from './controlServer.js'
import { Settings } from './settings.js'
import { log as logStore, installProcessLogging } from './logStore.js'

export async function startAppliance(config = loadConfig()) {
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
  // Everything this process persists — settings.json, data/ (logs, history, the resume slot) and
  // the two boot markers — hangs off one root. In production that is the checkout, but a test that
  // pointed at it would read the board's real PIN and scribble on the real match history, which is
  // exactly why test/appliance-selftest.mjs sat excluded from `npm test` and rotted. Pass
  // `stateDir` to send it all somewhere disposable.
  const stateDir = config.stateDir ? path.resolve(config.stateDir) : path.resolve(webDir, '..')
  const dataDir = path.resolve(stateDir, 'data')

  // Logging is configured FIRST, so everything from here on — including a failure to load
  // settings or reach the board — lands in data/logs and on the /logs page. DEBUG=1 opens the
  // firehose (every board write, every HTTP request); the level is also switchable at runtime
  // from /logs, so a match can be turned verbose without a restart.
  logStore.configure({
    file: path.resolve(dataDir, 'logs', 'appliance.jsonl'),
    level: config.logLevel || (config.debug ? 'debug' : 'info'),
  })
  const log = logStore.child('appliance')
  const boardLog = logStore.child('ledbox')
  log.info('starting', {
    node: process.version,
    pid: process.pid,
    controlPort: config.controlPort,
    relayUrl: config.relayUrl,
    ledboxHosts: config.ledboxHosts,
    mock: config.mock,
    logLevel: logStore.level,
  })

  // Load settings first: the active sport selects the Source, the match layout and the
  // state→sections mapper built below (see src/sports.js). Preferences live beside the code so
  // they survive restarts and reboots.
  const settings = new Settings(path.resolve(stateDir, 'settings.json'))
  const sport = getSport(settings.values.sport || DEFAULT_SPORT)
  log.info(`sport: ${sport.key} (${sport.label})`, { sport: sport.key, layouts: sport.layouts })

  // Was this boot caused by a sport switch? /api/sport drops a marker just before restarting us.
  // Consume it (delete first, so a crash mid-announcement can't replay it every boot) and hold
  // the sport name on the panel once, so the operator sees the switch land — the idle screens
  // are shared by every sport and would otherwise look identical before and after.
  let bootMessage = null
  const switchMark = path.resolve(stateDir, '.sport-switch')
  try {
    if (fs.existsSync(switchMark)) {
      const marked = fs.readFileSync(switchMark, 'utf8').trim()
      fs.unlinkSync(switchMark)
      // Only announce a switch that matches the sport we actually booted into.
      if (marked === sport.key) bootMessage = sport.label
    }
  } catch (err) { log.warn(`sport marker unreadable: ${err.message}`, { file: switchMark, error: err.message }) }
  if (bootMessage) log.info(`announcing sport switch on the panel: ${bootMessage}`, { sport: sport.key })

  // Did the previous run end on purpose? This marker is written once we are up and removed by
  // close(), so finding it here means the last process died without being asked to — a crash, an
  // OOM, or the hall losing power. That is the one case where replaying the saved match is right:
  // the unit is Restart=always, so otherwise a repeating fault brings the board back at 0-0 and
  // leaves it there, mid-match, while systemd still reports it healthy.
  //
  // A deploy or a sport switch stops us with SIGTERM and clears the marker, so those still land on
  // the game menu — which is correct, because an operator is standing at the tablet. Read before
  // anything writes it.
  const runMark = path.resolve(dataDir, '.running')
  let uncleanShutdown = false
  try { uncleanShutdown = fs.existsSync(runMark) } catch { /* unreadable -> assume a clean boot */ }
  if (uncleanShutdown) log.warn('previous run did not shut down cleanly', { marker: runMark })

  // Target: the real LedBox, or an in-process mock on an ephemeral port for testing.
  // Accept either the config's host list or a single (possibly comma-separated) host,
  // so hand-built configs and the tests keep working.
  let ledboxHosts = config.ledboxHosts
    || String(config.ledboxHost || '172.24.1.1').split(',').map((h) => h.trim()).filter(Boolean)
  let { ledboxPort } = config
  let mock = null
  if (config.mock) {
    mock = new MockLedbox()
    const addr = await mock.listen(0, '127.0.0.1')
    ledboxHosts = ['127.0.0.1']
    ledboxPort = addr.port
    log.info(`MOCK LedBox on ${ledboxHosts[0]}:${ledboxPort}`, { host: ledboxHosts[0], port: ledboxPort })
  }

  const ledbox = new LedboxClient({
    hosts: ledboxHosts,
    port: ledboxPort,
    alias: config.ledboxAlias,
    sport: sport.key,
    ...sport.layouts,        // match + idle + crest layout names for this sport
    mapper: sport.mapper,    // per-sport state→sections (only the match screen differs)
    apiVersion: config.ledboxApiVersion,
    reconnectMs: config.reconnectMs,
    // A fresh boot with no match settles on the KSC Wiedikon crest idle screen (rather than a
    // blank scoreboard). Asserted inside connect() after the handshake so it survives the
    // board's own boot-default layout and reconnects.
    defaultIdle: true,
    bootMessage, // set only when this boot follows a sport switch
  })
  // The board's socket lifecycle is the single most useful thing in the log when a venue
  // reports "the panel froze" — every transition is recorded with the address in use, since
  // the client walks a host list (hotspot vs ethernet) and failover is otherwise invisible.
  ledbox.on('connect', () => boardLog.info('tcp connected', { host: ledbox.host, port: ledboxPort }))
  ledbox.on('ready', (info) => boardLog.info(`ready (${ledbox.host}:${ledboxPort}, ${sport.key}, layout ${sport.layouts.layout})`, {
    host: ledbox.host, port: ledboxPort, sport: sport.key, layout: sport.layouts.layout, device: info,
  }))
  ledbox.on('close', () => boardLog.warn('disconnected', { host: ledbox.host, reconnectMs: ledbox.reconnectMs }))
  ledbox.on('error', (e) => boardLog.error(`error: ${e.message}`, e))

  // Built at the SAVED match format, not the engine's default. Without it a board set to best-of-3
  // booted best-of-5 whatever Settings said: the console header called set 3 the deciding set while
  // the engine played it to 25 and never ended the match at two sets. POST /api/settings re-applies
  // it live through setFormat, so a change mid-event needs no restart either.
  const manualSource = new sport.Source({ bestOf: settings.values.bestOf })
  const sourceManager = new SourceManager()
  // Whatever the active source emits gets painted onto the board. Fire-and-forget:
  // swallow push rejections (e.g. a timeout while the board is down) so they don't
  // surface as unhandled rejections and crash the process.
  sourceManager.on('state', (s) => {
    ledbox.pushState(s).catch((e) => boardLog.error(`push failed: ${e.message}`, { error: e.message, host: ledbox.host, layout: ledbox.currentLayout }))
  })
  // A source failing (e.g. the LAN relay is unreachable) must not crash the appliance.
  sourceManager.on('error', (e) => logStore.error('source', `error: ${e.message}`, e))

  // Mirror the board to wiedisync so members can follow the match at /live.
  // Attached to the SourceManager, not to the scoring source, so a LINKED LAN
  // match publishes too. A no-op stub unless DIRECTUS_URL + LIVE_PUBLISH_TOKEN
  // are set, and every failure inside it is swallowed — it can never reach the
  // board. The sport is fixed at boot (switching it restarts the appliance).
  // env sets the CAPABILITY (DIRECTUS_URL + token); the "Connect to live scoring" setting is the
  // runtime on/off — so a configured board still publishes NOTHING until the operator flips it.
  // A sport can opt out altogether (sports.js `livePush: false` — the simple scoreboard is not a
  // match the /live page could show), and then the toggle is moot: it stays OFF whatever it says.
  const publishes = sport.livePush !== false
  const livePush = livePushFromEnv(process.env, sport.key, () => publishes && settings.values.liveScoring === 'kscw')
  livePush.attach(sourceManager)
  logStore.info('livePush', livePush.enabled
    ? `configured → ${process.env.DIRECTUS_URL} (${sport.key}); publishing ${livePush.isLive() ? 'ON' : publishes ? 'OFF — flip Settings ▸ Connect to live scoring' : `OFF — ${sport.label} is never published`}`
    : 'disabled (no DIRECTUS_URL / LIVE_PUBLISH_TOKEN)',
  { enabled: livePush.enabled, publishing: livePush.isLive(), url: process.env.DIRECTUS_URL || null, sport: sport.key })

  // The full preference set at boot: nearly every "why did the board do that?" question
  // (blink off, wrong allowance, horn silent) is answered by this one line. The PIN is
  // redacted by the log store, so this is safe to hand to anyone.
  log.info('settings loaded', settings.values)
  // Seed the counter-colour thresholds from saved settings before the first paint.
  ledbox.setLimits({
    totalTimeouts: settings.values.totalTimeouts,
    totalSubs: settings.values.totalSubs,
    idleFullNames: settings.values.idleFullNames,
    idleFontMax: settings.values.idleFontMax,
    matchFontMaxLeft: settings.values.matchFontMaxLeft,
    matchFontMaxRight: settings.values.matchFontMaxRight,
    clubName: settings.values.clubName,
  })
  const server = createControlServer({
    sourceManager,
    manualSource,
    ledbox,
    relayHttpUrl: config.relayHttpUrl,
    relayUrl: config.relayUrl,
    reconnectMs: config.reconnectMs,
    settings,
    webDir,
    dataDir,
    // The season schedule's downloads and the automatic pre-match run on their own only on a real
    // boot (loadConfig sets this). A test's hand-built config leaves them off, so no selftest
    // reaches the club's Directus — or has a real 20:00 game set itself up mid-run.
    background: config.scheduleSync === true,
    // The hall internet watch (hallLogin.js): on for a real boot, off for a hand-built test config.
    // The URLs default to the real probe and portal; a test points them at its fake.
    uplinkWatch: config.uplinkWatch === true,
    uplinkOptions: { probeUrl: config.uplinkProbeUrl || '', portalUrl: config.uplinkPortalUrl || '' },
    // Test hook only: { now, trusted } for the automatic pre-match (test/auto-prepare-selftest.mjs).
    autoPrepare: config.autoPrepare || null,
  })

  // The default screen on a fresh boot (the KSC Wiedikon crest) is asserted by the client
  // itself after the handshake (see `defaultIdle` above), so it survives the board's own
  // boot-default layout and every reconnect. /api/action, /api/manual and /api/link lift
  // idle when a match starts so the scoreboard paints.
  // Replay an interrupted match, but only once the panel is actually up: showIdle(false) and the
  // repaint both talk to the board, and firing them at a socket that has not handshaken yet just
  // burns two send timeouts. `once` — a later reconnect must not resurrect a match the operator
  // has since replaced.
  // A game saved during its pre-match comes back after ANY restart (a deploy at 19:50 included):
  // the board shows the clock at boot either way, and this only puts the names and the console's
  // "Ready" banner back. See controlServer's `prematch`. Done BEFORE connect(), not on 'ready':
  // with the panel not up yet the held clock is recorded as intent, so the handshake's own default
  // screen IS the clock — restoring on 'ready' raced that default screen, and the crest won.
  if (server.savedPrematch()) {
    try { await server.resumeInterruptedGame() } catch (e) { log.error(`could not restore the pre-match: ${e.message}`, { error: e.message }) }
  } else if (uncleanShutdown) {
    ledbox.once('ready', () => {
      Promise.resolve(server.resumeInterruptedGame())
        .then((info) => { if (!info) log.info('nothing saved to restore for this sport', { sport: sport.key }) })
        .catch((e) => log.error(`could not restore the interrupted match: ${e.message}`, { error: e.message }))
    })
  }

  ledbox.connect()

  // A listen failure (port already taken — a second instance started by hand while debugging) must
  // FAIL the boot. With no 'error' listener it went to the uncaughtException logger, which swallows
  // it: the process stayed up with no UI, never armed the crash marker or the SIGTERM handler, and
  // systemd kept reporting it healthy. Rejecting reaches the fatal handler below, which exits 1 so
  // Restart=always tries again.
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.controlPort, '0.0.0.0', () => { server.off('error', reject); resolve() })
    })
  } catch (err) {
    // Let go of the board (and the mock) first, so a caller that catches this is not left holding
    // a live socket and its reconnect timer.
    ledbox.disconnect()
    if (mock) await mock.close()
    throw err
  }
  const port = server.address().port
  // The board is its own Tailscale node, so the console no longer hangs off the `openvolley` Pi.
  log.info(`control UI on http://0.0.0.0:${port}  (board's own AP, the house LAN, or its tailnet name)`, { port, logs: `/logs` })

  // Optional TLS listener on the SAME handler. Everything here is best-effort by construction:
  // a missing, unreadable or malformed cert logs a warning and leaves the board running exactly
  // as it does without any of this. HTTP on :8890 is the contract — the QR on the panel and the
  // printed hall guide both point at it — and nothing in this block may endanger it.
  let tlsServer = null
  let stopCertWatch = () => {}
  if (config.tlsCert && config.tlsKey) {
    const readCert = () => ({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) })
    try {
      tlsServer = https.createServer(readCert(), server.handler)
      // A listen failure (port taken, permission) must not be fatal either — hence the explicit
      // error handler rather than letting it reject the boot.
      await new Promise((resolve) => {
        tlsServer.once('error', (err) => {
          log.warn(`HTTPS listener did not start: ${err.message}`, { port: config.httpsPort, error: err.message })
          tlsServer = null
          resolve()
        })
        tlsServer.listen(config.httpsPort, '0.0.0.0', resolve)
      })
      if (tlsServer) {
        log.info(`control UI also on https://0.0.0.0:${config.httpsPort}  (secure context: wake lock, service worker, installable)`, { port: config.httpsPort })
        // Certs are Let's Encrypt via `tailscale cert`, so they roll every ~90 days. Swapping the
        // secure context in place is what keeps a renewal from needing a restart — restarting the
        // appliance to pick up a cert would mean the scoreboard blinking out mid-match, which is a
        // far worse outcome than the expired cert it was fixing.
        stopCertWatch = watchCertificate({
          files: [config.tlsCert, config.tlsKey],
          read: readCert,
          apply: (ctx) => tlsServer.setSecureContext(ctx),
          log,
        })
      }
    } catch (err) {
      log.warn(`HTTPS disabled — could not load the certificate: ${err.message}`, { cert: config.tlsCert, key: config.tlsKey, error: err.message })
      tlsServer = null
    }
  }

  // We are up: from here a disappearance is a crash, so arm the marker. Best-effort — a board with
  // a full or read-only card must still score.
  try {
    fs.mkdirSync(path.dirname(runMark), { recursive: true })
    fs.writeFileSync(runMark, String(process.pid))
  } catch (err) { log.warn(`could not arm the crash marker: ${err.message}`, { marker: runMark, error: err.message }) }

  // Idempotent: SIGINT and SIGTERM can both arrive (a Ctrl-C during a systemctl stop), and a second
  // run would only wait on listeners the first is already closing.
  let closing = null
  const close = () => closing || (closing = (async () => {
    log.info('shutting down')
    // Disarm FIRST: this is what tells the next boot the stop was deliberate, and it must happen
    // even if a later step of the shutdown hangs.
    try { fs.rmSync(runMark, { force: true }) } catch { /* best-effort */ }
    logStore.flush()
    livePush.detach()
    server.stopBackground()
    sourceManager.stop()
    stopCertWatch()
    // Let go of the panel before waiting on anything HTTP-shaped, so nothing below can keep the
    // board's socket (and its reconnect timer) alive.
    ledbox.disconnect()
    // server.close() only stops accepting; its callback waits for every open connection. Idle
    // keep-alives are closed for us, but an active response is not — and a /logs tab's event
    // stream never finishes by itself, so one left open anywhere held this for systemd's full stop
    // timeout, freezing a sport switch, a deploy or a poweroff for ~90s. End the streams, then drop
    // whatever is still attached: we are exiting, and nothing in flight here is worth waiting for.
    server.closeStreams()
    const listeners = [server, tlsServer].filter(Boolean)
    const closed = listeners.map((s) => new Promise((r) => s.close(r)))
    for (const s of listeners) s.closeAllConnections()
    await Promise.all(closed)
    if (mock) await mock.close()
  })())

  return { server, sourceManager, manualSource, ledbox, livePush, close }
}

// Keep an HTTPS listener's certificate current without a restart. Returns a stop function.
//
// Watches the DIRECTORY holding the files, not the files. `tailscale cert` writes atomically — a
// temp file renamed over the target — and a file watch follows the inode, not the path: the first
// renewal fired on the old inode, the swap read the new files, and from then on the watcher sat on
// a deleted inode and saw nothing. A board left running served the day-60 certificate until it
// expired. The directory's inode survives any number of renames.
//
// An hourly stat is the backstop for whatever a watch can still miss (the directory itself
// replaced, a filesystem that does not deliver events). Both paths go through reload(), which only
// swaps when the files' identity (inode, mtime, size) actually changed, and only records the new
// identity once the swap succeeded — so a read caught between the cert and the key landing (a
// key/cert mismatch) is retried on the next event or tick instead of being forgotten.
export function watchCertificate({ files, read, apply, log, debounceMs = 2000, pollMs = 60 * 60 * 1000 }) {
  const identity = () => files.map((f) => {
    const st = fs.statSync(f)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  }).join('|')
  let current = null
  try { current = identity() } catch { /* missing now: the first readable state counts as new */ }
  const reload = () => {
    let next
    try { next = identity() } catch { return } // mid-rename, or gone: wait for the next event
    if (next === current) return
    try {
      apply(read())
      current = next
      log.info('TLS certificate reloaded without a restart', { cert: files[0] })
    } catch (err) {
      log.warn(`TLS certificate reload failed, keeping the old one: ${err.message}`, { error: err.message })
    }
  }
  let pending = null
  const soon = () => { clearTimeout(pending); pending = setTimeout(reload, debounceMs) } // both files land together
  const names = new Set(files.map((f) => path.basename(f)))
  const watchers = []
  for (const dir of new Set(files.map((f) => path.dirname(path.resolve(f))))) {
    try {
      // A null filename (some platforms) could be ours, so it counts.
      watchers.push(fs.watch(dir, { persistent: false }, (_ev, name) => { if (!name || names.has(String(name))) soon() }))
    } catch (err) {
      log.warn(`not watching ${dir} for renewal (the hourly check still runs): ${err.message}`, { dir, error: err.message })
    }
  }
  const poll = setInterval(reload, pollMs)
  poll.unref()
  return () => {
    clearTimeout(pending)
    clearInterval(poll)
    for (const w of watchers) { try { w.close() } catch { /* already closed */ } }
  }
}

// Run directly (node src/appliance.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  // An appliance must stay up through a match: a stray unhandled rejection (most often a
  // board write that timed out) or a non-fatal exception should be logged, not terminate
  // the process. Node's default is to crash on an unhandled rejection. These land in the
  // log store (and so on /logs and on disk), not just in whatever terminal is attached.
  installProcessLogging()
  startAppliance().then(({ close }) => {
    // The bound is a backstop, not the plan: close() normally finishes in milliseconds. It exists
    // so that no future leak of the same kind as the SSE stream can turn a stop back into systemd's
    // SIGKILL — the unit's TimeoutStopSec is set above this, so we always get to exit on our own.
    const shutdown = async () => {
      const bound = setTimeout(() => {
        logStore.warn('appliance', 'shutdown did not finish in 5s — exiting anyway')
        logStore.flush()
        process.exit(0)
      }, 5000)
      bound.unref()
      await close()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch((err) => {
    logStore.error('appliance', 'fatal — could not start', err)
    logStore.flush()
    process.exit(1)
  })
}
