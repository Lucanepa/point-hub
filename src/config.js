// Runtime config for the LedBox bridge, read from the environment (see .env.example).
// Production has zero npm dependencies: the relay client uses Node's built-in global
// WebSocket (Node >= 22) and the LedBox client uses node:net.

export function loadConfig(env = process.env) {
  const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)))
  // `Number(env.X || default)` is a trap for every numeric var here: '0' is truthy so it skips the
  // default and yields 0, and a typo ('3s') yields NaN. Both are falsy, and the reconnect guards
  // used to read them as plain booleans — so RECONNECT_MS=0 turned reconnection OFF for the whole
  // evening instead of making it fast. Clamp into a sane range and fall back on anything unusable.
  const int = (v, d, lo, hi) => {
    if (v == null || String(v).trim() === '') return d // unset stays unset, not clamped to the floor
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
  }
  return {
    // OpenVolley LAN relay (the eScoresheet server) WebSocket endpoint to subscribe to.
    relayUrl: env.RELAY_URL || 'ws://127.0.0.1:8080',
    // Which match to mirror onto the LedBox (the numeric match id). Required unless MOCK.
    matchId: env.MATCH_ID || null,
    // Physical Tech4Sport LedBox. The board answers on a DIFFERENT address depending on
    // how you reached it — 172.24.1.1 when everyone is on the board's own Wi-Fi (the
    // venue setup), 192.168.5.1 over the ethernet cable (the bench setup). Pinning one
    // means the other silently fails, so accept a comma-separated list and try each in
    // turn on every connect. LEDBOX_HOST still works for a single address.
    ledboxHosts: (env.LEDBOX_HOST || '172.24.1.1,192.168.5.1')
      .split(',').map((h) => h.trim()).filter(Boolean),
    ledboxPort: int(env.LEDBOX_PORT, 8889, 1, 65535),
    ledboxLayout: env.LEDBOX_LAYOUT || 'volleyball_matchscore_02',
    ledboxAlias: env.LEDBOX_ALIAS || 'openvolley',
    ledboxApiVersion: int(env.LEDBOX_API_VERSION, 2, 1, 9),
    // Reconnect backoff (ms) for both the relay and the LedBox sockets. 250 ms floor: whatever an
    // operator meant by 0, they did not mean "never reconnect to the panel again".
    reconnectMs: int(env.RECONNECT_MS, 3000, 250, 60000),
    // Run an in-process mock LedBox instead of talking to real hardware (for testing).
    mock: bool(env.MOCK),
    // Verbose per-update logging.
    debug: bool(env.DEBUG),
    // Log level the appliance RECORDS at: debug | info | warn | error. DEBUG=1 is the historical
    // shorthand for debug. Also switchable at runtime from the /logs page, so this is only the
    // level it boots with.
    logLevel: ['debug', 'info', 'warn', 'error'].includes(String(env.LOG_LEVEL || '').toLowerCase())
      ? String(env.LOG_LEVEL).toLowerCase()
      : (bool(env.DEBUG) ? 'debug' : 'info'),
    // Appliance web control server (manual + LAN link UI) listen port.
    controlPort: int(env.CONTROL_PORT, 8890, 1, 65535),
    // OpenVolley relay HTTP base (for /api/match/list). Derived from relayUrl if unset:
    // ws->http, wss->https, and the relay's HTTP port is 5173 (Vite dev server / API host).
    relayHttpUrl: env.RELAY_HTTP_URL || httpFromWs(env.RELAY_URL || 'ws://127.0.0.1:8080'),
  }
}

// Derive the relay HTTP base from its WS url: swap scheme and force port 5173.
function httpFromWs(wsUrl) {
  try {
    const u = new URL(wsUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.port = '5173'
    return u.origin
  } catch {
    return 'http://127.0.0.1:5173'
  }
}
