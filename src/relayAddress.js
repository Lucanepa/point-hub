// Where the scorer laptop's OpenVolley relay is, and how to reach its match list.
//
// The appliance runs on the LedBox board, and the scorer laptop's address changes from hall to
// hall. RELAY_URL in .env is a per-board deploy setting nobody at the scorer's table can change,
// and its default (ws://127.0.0.1:8080) is the board itself. So the console has a "Scorer laptop
// address" setting (host[:port], stored with the other settings), and when nothing answers there
// the board can look for the laptop on its own networks.
//
// The OpenVolley relays (all of them speak the same WebSocket protocol on :8080):
//   backend/server.js --local (the standalone/SEA server)  HTTP and WS on ONE port, 8080
//   desktop app (Electron, Tauri) and frontend/server.js    WS on 8080, HTTP on 5173
//   the cloud (wss://backend.openvolley.app)                HTTPS and WSS on 443
// so the match list is tried at the relay's own origin first and on :5173 second.
//
// Zero dependencies: node:os and the global fetch (Node >= 22).

import os from 'node:os'

export const DEFAULT_RELAY_PORT = 8080
export const DESKTOP_HTTP_PORT = 5173
const MAX_LEN = 100

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

// Parse what an operator typed into "Scorer laptop address".
//   ''                          -> { ok, value: '' }              (cleared: find it automatically)
//   '172.24.1.23'               -> { ok, value: '172.24.1.23' }   (ws, port 8080)
//   'Laptop.local:9000'         -> { ok, value: 'laptop.local:9000' }
//   'ws://10.0.0.5:8080/'       -> { ok, value: '10.0.0.5:8080' } (a pasted URL is fine)
//   'wss://backend.openvolley.app' -> { ok, value: 'wss://backend.openvolley.app' }
//   anything else               -> { ok: false, error }
// The canonical value is what settings.json stores, and what relayWsUrl() turns into a URL.
export function parseRelayAddress(input) {
  let s = String(input ?? '').trim()
  if (s === '') return { ok: true, value: '' }
  if (s.length > MAX_LEN) return { ok: false, error: 'Scorer laptop address is too long' }
  let secure = false
  const scheme = /^([a-z]+):\/\//i.exec(s)
  if (scheme) {
    const p = scheme[1].toLowerCase()
    if (!['ws', 'wss', 'http', 'https'].includes(p)) return { ok: false, error: 'Scorer laptop address must start with ws:// or wss:// if it has a scheme' }
    secure = p === 'wss' || p === 'https'
    s = s.slice(scheme[0].length)
  }
  s = s.replace(/\/+$/, '')
  if (s.includes('/') || s.includes('@') || s.includes('?') || s.includes('#')) {
    return { ok: false, error: 'Scorer laptop address is a host and an optional port, like 172.24.1.23 or 172.24.1.23:8080' }
  }
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s)
  if (!m) return { ok: false, error: 'Scorer laptop address is a host and an optional port, like 172.24.1.23:8080' }
  const host = m[1].toLowerCase()
  const port = m[2] != null ? Number(m[2]) : null
  if (port != null && !(port >= 1 && port <= 65535)) return { ok: false, error: 'The port must be 1–65535' }
  const isIp = /^[\d.]+$/.test(host)
  if (isIp ? !IPV4_RE.test(host) : !(host.length <= 253 && host.split('.').every((l) => LABEL_RE.test(l)))) {
    return { ok: false, error: `"${host.slice(0, 40)}" is not an IP address or a host name` }
  }
  const hp = port != null ? `${host}:${port}` : host
  return { ok: true, value: secure ? `wss://${hp}` : hp }
}

// The relay WebSocket URL for a canonical address (see parseRelayAddress). A plain address gets
// port 8080, the port every OpenVolley relay listens on; a wss:// one keeps the scheme's default.
export function relayWsUrl(address) {
  const v = String(address || '')
  if (!v) return ''
  if (v.startsWith('wss://')) return v
  return /:\d+$/.test(v) ? `ws://${v}` : `ws://${v}:${DEFAULT_RELAY_PORT}`
}

// host[:port] of a relay URL, for the console and the log ("172.24.1.23:8080").
export function relayHostLabel(url) {
  try { return new URL(url).host } catch { return String(url || '') }
}

// The HTTP bases to try for /api/match/list, best first. RELAY_HTTP_URL, when set, is the only
// one. Otherwise the relay's own origin (the standalone server and the cloud serve HTTP there),
// then :5173 on the same host (the desktop app and frontend/server.js).
export function relayHttpCandidates(wsUrl, override = '', { desktopPort = DESKTOP_HTTP_PORT } = {}) {
  if (override) return [String(override).replace(/\/+$/, '')]
  let u
  try { u = new URL(wsUrl) } catch { return [] }
  const proto = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:'
  const out = [`${proto}//${u.host}`]
  const desktop = `${proto}//${u.hostname}:${desktopPort}`
  if (!out.includes(desktop)) out.push(desktop)
  return out
}

// Private IPv4 /24s the board itself sits on — where a scorer laptop could be. Loopback, link-local,
// the tailnet (100.64/10) and public addresses are never scanned. A wider netmask is still searched
// as the /24 around the board's own address: a hall network is small, and a /16 would take minutes.
export function localSubnets(interfaces = os.networkInterfaces(), { max = 3 } = {}) {
  const out = []
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const a of addrs || []) {
      const fam = a.family === 4 ? 'IPv4' : a.family
      if (fam !== 'IPv4' || a.internal || !IPV4_RE.test(String(a.address))) continue
      const [o1, o2] = a.address.split('.').map(Number)
      const priv = o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168)
      if (!priv) continue
      const prefix = a.address.split('.').slice(0, 3).join('.')
      if (out.some((s) => s.prefix === prefix)) continue
      out.push({ iface: name, prefix, self: a.address })
      if (out.length >= max) return out
    }
  }
  return out
}

// One host: is an OpenVolley relay listening on it?
//   :8080/api/server/status answers JSON -> the standalone server (HTTP and WS on 8080)
//   :8080 answers anything else (the desktop relay's WS port says 426 "WebSocket only")
//       -> confirm on :5173/api/server/status (the desktop app's HTTP port)
// Resolves { host, wsUrl, httpUrl } or null. Never throws.
export async function probeRelay(host, { fetchImpl = fetch, timeoutMs = 700, signal } = {}) {
  const get = async (url) => {
    const sigs = [AbortSignal.timeout(timeoutMs)]
    if (signal) sigs.push(signal)
    return fetchImpl(url, { signal: AbortSignal.any(sigs), headers: { accept: 'application/json' } })
  }
  const status = async (res) => {
    // Drain what we will not read, or the socket stays parked in fetch's pool.
    if (!res.ok) { try { await res.body?.cancel() } catch { /* already gone */ } return null }
    const j = await res.json().catch(() => null)
    return j && typeof j === 'object' && j.status === 'online' ? j : null
  }
  const wsPortOf = (j) => {
    const n = Number(j && j.wsPort)
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_RELAY_PORT
  }
  let res
  try { res = await get(`http://${host}:${DEFAULT_RELAY_PORT}/api/server/status`) } catch { return null }
  const j = await status(res).catch(() => null)
  if (j) return { host, wsUrl: `ws://${host}:${wsPortOf(j)}`, httpUrl: `http://${host}:${DEFAULT_RELAY_PORT}` }
  try {
    const r2 = await get(`http://${host}:${DESKTOP_HTTP_PORT}/api/server/status`)
    const j2 = await status(r2)
    if (j2) return { host, wsUrl: `ws://${host}:${wsPortOf(j2)}`, httpUrl: `http://${host}:${DESKTOP_HTTP_PORT}` }
  } catch { /* nothing on 5173 */ }
  return null
}

// Look for scorer laptops on the board's own networks: one GET per address of each private /24,
// at most `concurrency` at a time, each given `timeoutMs`. Worst case (every address silent) is
// about ceil(253 / concurrency) * timeoutMs per subnet — 2.8 s for a /24 at the defaults. Read-only
// (GET /api/server/status) and only ever started by the operator refreshing the Link tab.
// Resolves { found: [{ host, wsUrl, httpUrl }], subnets: ['172.24.1'], ms }.
export async function discoverRelays({
  interfaces, fetchImpl = fetch, timeoutMs = 700, concurrency = 64, subnets, skip = [],
} = {}) {
  const t0 = Date.now()
  const nets = subnets || localSubnets(interfaces)
  const hosts = []
  for (const n of nets) {
    for (let i = 1; i <= 254; i++) {
      const h = `${n.prefix}.${i}`
      if (h !== n.self && !skip.includes(h)) hosts.push(h)
    }
  }
  const found = []
  let next = 0
  const worker = async () => {
    while (next < hosts.length) {
      const h = hosts[next++]
      const r = await probeRelay(h, { fetchImpl, timeoutMs })
      if (r) found.push(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker))
  // Stable order: the address list order, not whichever answered first.
  found.sort((a, b) => hosts.indexOf(a.host) - hosts.indexOf(b.host))
  return { found, subnets: nets.map((n) => n.prefix), ms: Date.now() - t0 }
}
