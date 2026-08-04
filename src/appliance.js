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

  const manualSource = new sport.Source()
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
  const livePush = livePushFromEnv(process.env, sport.key, () => settings.values.liveScoring === 'kscw')
  livePush.attach(sourceManager)
  logStore.info('livePush', livePush.enabled
    ? `configured → ${process.env.DIRECTUS_URL} (${sport.key}); publishing ${livePush.isLive() ? 'ON' : 'OFF — flip Settings ▸ Connect to live scoring'}`
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
    matchFontMax: settings.values.matchFontMax,
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
  })

  // The default screen on a fresh boot (the KSC Wiedikon crest) is asserted by the client
  // itself after the handshake (see `defaultIdle` above), so it survives the board's own
  // boot-default layout and every reconnect. /api/action, /api/manual and /api/link lift
  // idle when a match starts so the scoreboard paints.
  // Replay an interrupted match, but only once the panel is actually up: showIdle(false) and the
  // repaint both talk to the board, and firing them at a socket that has not handshaken yet just
  // burns two send timeouts. `once` — a later reconnect must not resurrect a match the operator
  // has since replaced.
  if (uncleanShutdown) {
    ledbox.once('ready', () => {
      Promise.resolve(server.resumeInterruptedGame())
        .then((info) => { if (!info) log.info('nothing saved to restore for this sport', { sport: sport.key }) })
        .catch((e) => log.error(`could not restore the interrupted match: ${e.message}`, { error: e.message }))
    })
  }

  ledbox.connect()

  await new Promise((resolve) => server.listen(config.controlPort, '0.0.0.0', resolve))
  const port = server.address().port
  // The board is its own Tailscale node, so the console no longer hangs off the `openvolley` Pi.
  log.info(`control UI on http://0.0.0.0:${port}  (board's own AP, the house LAN, or its tailnet name)`, { port, logs: `/logs` })

  // We are up: from here a disappearance is a crash, so arm the marker. Best-effort — a board with
  // a full or read-only card must still score.
  try {
    fs.mkdirSync(path.dirname(runMark), { recursive: true })
    fs.writeFileSync(runMark, String(process.pid))
  } catch (err) { log.warn(`could not arm the crash marker: ${err.message}`, { marker: runMark, error: err.message }) }

  const close = async () => {
    log.info('shutting down')
    // Disarm FIRST: this is what tells the next boot the stop was deliberate, and it must happen
    // even if a later step of the shutdown hangs.
    try { fs.rmSync(runMark, { force: true }) } catch { /* best-effort */ }
    logStore.flush()
    livePush.detach()
    sourceManager.stop()
    await new Promise((r) => server.close(r))
    ledbox.disconnect()
    if (mock) await mock.close()
  }

  return { server, sourceManager, manualSource, ledbox, livePush, close }
}

// Run directly (node src/appliance.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  // An appliance must stay up through a match: a stray unhandled rejection (most often a
  // board write that timed out) or a non-fatal exception should be logged, not terminate
  // the process. Node's default is to crash on an unhandled rejection. These land in the
  // log store (and so on /logs and on disk), not just in whatever terminal is attached.
  installProcessLogging()
  startAppliance().then(({ close }) => {
    const shutdown = async () => { await close(); process.exit(0) }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch((err) => {
    logStore.error('appliance', 'fatal — could not start', err)
    logStore.flush()
    process.exit(1)
  })
}
