// The scorer laptop's address (relayAddress.js): what the console accepts, which URLs it turns
// into, and the network search — all without touching a real network (fetch is a stand-in).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseRelayAddress, relayWsUrl, relayHttpCandidates, relayHostLabel, localSubnets, probeRelay, discoverRelays, isRelayStatus,
} from '../src/relayAddress.js'
import { Settings } from '../src/settings.js'
import { loadConfig } from '../src/config.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }
const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

console.log('\n[1] what "Scorer laptop address" accepts')
{
  const v = (s) => parseRelayAddress(s)
  eq(v(''), { ok: true, value: '' }, 'empty clears it (find it automatically)')
  eq(v('  172.24.1.23 '), { ok: true, value: '172.24.1.23' }, 'a bare IP, trimmed')
  eq(v('172.24.1.23:8080'), { ok: true, value: '172.24.1.23:8080' }, 'IP and port')
  eq(v('Scorer-Laptop.local:9000'), { ok: true, value: 'scorer-laptop.local:9000' }, 'a host name, lower-cased')
  eq(v('ws://10.0.0.5:8080/'), { ok: true, value: '10.0.0.5:8080' }, 'a pasted ws:// URL loses the scheme and the slash')
  eq(v('http://10.0.0.5'), { ok: true, value: '10.0.0.5' }, 'a pasted http:// URL is the same laptop')
  eq(v('wss://backend.openvolley.app'), { ok: true, value: 'wss://backend.openvolley.app' }, 'wss:// is kept (a relay on the internet)')
  for (const bad of ['256.1.1.1', '1.2.3', '10.0.0.5:0', '10.0.0.5:70000', 'laptop:abc', 'ftp://x', 'a b', 'x/y', 'user@host', '-bad.host', 'x'.repeat(120), '::1']) {
    const r = v(bad)
    ok(r.ok === false && typeof r.error === 'string' && r.error.length > 0, `refused: ${JSON.stringify(bad.slice(0, 30))} (${r.error})`)
  }
}

console.log('\n[2] the URLs an address turns into')
{
  eq(relayWsUrl('172.24.1.23'), 'ws://172.24.1.23:8080', 'no port -> the relay port 8080')
  eq(relayWsUrl('172.24.1.23:9000'), 'ws://172.24.1.23:9000', 'an explicit port is kept')
  eq(relayWsUrl('wss://backend.openvolley.app'), 'wss://backend.openvolley.app', 'wss is used as it is')
  eq(relayWsUrl(''), '', 'nothing set -> no URL')
  eq(relayHostLabel('ws://172.24.1.23:8080'), '172.24.1.23:8080', 'host label for the console')
  // The bug this replaces: the match list was ALWAYS looked for on :5173, which is wrong for the
  // standalone server (HTTP and WS share 8080) and for the cloud.
  eq(relayHttpCandidates('ws://172.24.1.23:8080'), ['http://172.24.1.23:8080', 'http://172.24.1.23:5173'],
    'standalone first (same port), desktop app second (:5173)')
  eq(relayHttpCandidates('wss://backend.openvolley.app'), ['https://backend.openvolley.app', 'https://backend.openvolley.app:5173'],
    'the cloud: its own https origin first, never :5173 first')
  eq(relayHttpCandidates('ws://h:5173'), ['http://h:5173'], 'no duplicate when the relay already is on 5173')
  eq(relayHttpCandidates('ws://h:8080', 'http://override:1234/'), ['http://override:1234'], 'RELAY_HTTP_URL is the only one when set')
  eq(relayHttpCandidates('ws://h:8080', '', { desktopPort: 9 }), ['http://h:8080', 'http://h:9'], 'the desktop port can be moved (tests)')
  eq(relayHttpCandidates('not a url'), [], 'garbage -> nothing to try')
}

console.log('\n[3] config: the match-list URL is derived, not forced to :5173')
{
  const c = loadConfig({})
  eq(c.relayHttpUrl, '', 'RELAY_HTTP_URL unset -> empty (derive per relay)')
  eq(c.relayUrlExplicit, false, 'the default relay URL is marked as the default')
  eq(c.relayDiscovery, 'own', "the network search is on for a real boot, on the board's own networks")
  eq(loadConfig({ RELAY_DISCOVERY: 'all' }).relayDiscovery, 'all', "RELAY_DISCOVERY=all searches every private /24")
  eq(loadConfig({ RELAY_URL: 'ws://10.1.1.1:8080' }).relayUrlExplicit, true, 'RELAY_URL set -> explicit')
  eq(loadConfig({ RELAY_URL: 'ws://127.0.0.1:8080' }).relayUrlExplicit, false, 'the default spelled out in .env is still the default')
  eq(loadConfig({ RELAY_DISCOVERY: '0' }).relayDiscovery, false, 'RELAY_DISCOVERY=0 turns the search off')
}

console.log('\n[4] the setting is stored like the others, and a bad one never lands')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-relayaddr-'))
  const file = path.join(dir, 'settings.json')
  const s = new Settings(file)
  eq(s.values.relayAddress, '', 'default: empty (automatic)')
  s.update({ relayAddress: 'WS://172.24.1.23:8080/' })
  eq(s.values.relayAddress, '172.24.1.23:8080', 'stored canonical')
  s.update({ relayAddress: 'not a host!' })
  eq(s.values.relayAddress, '172.24.1.23:8080', 'a malformed one is dropped; the previous stands')
  eq(new Settings(file).values.relayAddress, '172.24.1.23:8080', 'survives a restart')
  eq(JSON.parse(fs.readFileSync(file, 'utf8')).relayAddress, '172.24.1.23:8080', 'global key on disk (not per sport)')
  s.update({ relayAddress: '' })
  eq(s.values.relayAddress, '', 'cleared back to automatic')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n[5] which networks the search covers')
{
  const ifs = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: [{ address: '172.24.1.1', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    eth0: [{ address: '192.168.5.1', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.114.142.10', family: 'IPv4', internal: false }],
    pub: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.7.33', family: 4, internal: false }],
    eth2: [{ address: '172.24.1.9', family: 'IPv4', internal: false }],
  }
  eq(localSubnets(ifs).map((n) => n.prefix), ['172.24.1', '192.168.5'], 'default: only the networks the board runs (its address .1) — its Wi-Fi and the bench cable')
  eq(localSubnets(ifs, { own: false }).map((n) => n.prefix), ['172.24.1', '192.168.5', '10.0.7'], "'all': every private /24 — still no loopback, tailnet or public; one entry per /24")
  eq(localSubnets(ifs, { own: false, max: 1 }).length, 1, 'capped')
}

console.log('\n[6] probing one host, with a stand-in fetch')
{
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
  // backend --local: status on 8080
  const backend = async (url) => {
    if (url === 'http://10.0.0.5:8080/api/server/status') return json({ status: 'online', mode: 'local', wsPort: 8080 })
    throw new TypeError('fetch failed')
  }
  eq(await probeRelay('10.0.0.5', { fetchImpl: backend }), { host: '10.0.0.5', wsUrl: 'ws://10.0.0.5:8080', httpUrl: 'http://10.0.0.5:8080' }, 'standalone server found on :8080')
  // The desktop relays, with the replies they really send (copied from the sources, see
  // DESKTOP_STATUS): /api/server/status says `running: true`, never `status: 'online'`. The selftest
  // used to stub `{status:'online'}` here, a reply no desktop relay sends, and so passed while the
  // search could never find the usual scorer-table setup.
  const DESKTOP_STATUS = (ip, wsPort = 8080, port = 5173) => ({
    running: true, mainInstanceId: null, hasMainInstance: false, protocol: 'http', wsProtocol: 'ws',
    hostname: 'localhost', localIP: ip, port, wsPort,
    urls: { main: `http://${ip}:${port}/`, websocket: `ws://${ip}:${wsPort}` },
  })
  // Electron relayServer.js and frontend/server.js: 8080 is WS-only and says 426.
  const electron = async (url) => {
    if (url.startsWith('http://10.0.0.6:8080/')) return new Response('WebSocket only', { status: 426, headers: { 'content-type': 'text/plain' } })
    if (url === 'http://10.0.0.6:5173/api/server/status') return json(DESKTOP_STATUS('10.0.0.6'))
    throw new TypeError('fetch failed')
  }
  eq(await probeRelay('10.0.0.6', { fetchImpl: electron }), { host: '10.0.0.6', wsUrl: 'ws://10.0.0.6:8080', httpUrl: 'http://10.0.0.6:5173' }, 'Electron / frontend/server.js found through :5173 (8080 says 426)')
  // Tauri relay.rs: 8080 routes only "/", so /api/server/status there is a bare 404.
  const tauri = async (url) => {
    if (url.startsWith('http://10.0.0.9:8080/')) return new Response(null, { status: 404 })
    if (url === 'http://10.0.0.9:5173/api/server/status') return json(DESKTOP_STATUS('10.0.0.9'))
    throw new TypeError('fetch failed')
  }
  eq(await probeRelay('10.0.0.9', { fetchImpl: tauri }), { host: '10.0.0.9', wsUrl: 'ws://10.0.0.9:8080', httpUrl: 'http://10.0.0.9:5173' }, 'Tauri found through :5173 (8080 says 404)')
  // A desktop relay started with another WS port advertises it; the board follows.
  const moved = async (url) => {
    if (url.startsWith('http://10.0.0.10:8080/')) return new Response(null, { status: 404 })
    if (url === 'http://10.0.0.10:5173/api/server/status') return json(DESKTOP_STATUS('10.0.0.10', '9090'))
    throw new TypeError('fetch failed')
  }
  eq((await probeRelay('10.0.0.10', { fetchImpl: moved })).wsUrl, 'ws://10.0.0.10:9090', 'the advertised wsPort is used (even as a string, as frontend/server.js sends WS_PORT from the env)')
  eq(isRelayStatus({ status: 'ok' }), false, "Tauri's /health shape alone is not enough")
  eq(isRelayStatus({ running: 'yes' }), false, 'running must be true, not truthy')
  eq(isRelayStatus([]), false, 'an array is not a status')
  eq(await probeRelay('10.0.0.7', { fetchImpl: async () => { throw new TypeError('fetch failed') } }), null, 'nothing listening -> null')
  eq(await probeRelay('10.0.0.8', { fetchImpl: async () => json({ hello: 'world' }) }), null, 'something else on 8080 -> not a relay')
}

console.log('\n[7] the search: bounded, every host once, stable order')
{
  const seen = []
  let inflight = 0, peak = 0
  const fake = async (url) => {
    seen.push(url)
    inflight++; peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 2))
    inflight--
    // .40 is a Tauri desktop app (404 on 8080, `running: true` on 5173), .7 the standalone server.
    if (url === 'http://172.24.1.40:8080/api/server/status') return new Response(null, { status: 404 })
    if (url === 'http://172.24.1.40:5173/api/server/status') return new Response(JSON.stringify({ running: true, wsPort: 8080, port: 5173 }), { status: 200 })
    if (url === 'http://172.24.1.7:8080/api/server/status') return new Response(JSON.stringify({ status: 'online', wsPort: 8080 }), { status: 200 })
    throw new TypeError('fetch failed')
  }
  const r = await discoverRelays({ subnets: [{ prefix: '172.24.1', self: '172.24.1.1' }], fetchImpl: fake, concurrency: 16 })
  eq(r.found.map((f) => f.host), ['172.24.1.7', '172.24.1.40'], 'both laptops found (standalone and desktop app), in address order')
  eq(r.found[1].httpUrl, 'http://172.24.1.40:5173', 'the desktop app is listed through :5173')
  eq(r.subnets, ['172.24.1'], 'reports what it searched')
  ok(!seen.some((u) => u.includes('//172.24.1.1:')), 'never probes the board itself')
  ok(seen.filter((u) => u.includes(':8080/')).length === 253, `one :8080 probe per address (${seen.filter((u) => u.includes(':8080/')).length})`)
  ok(peak <= 16, `at most 16 at a time (peak ${peak})`)
  // AbortSignal.timeout's timer is unref'd (a real fetch's socket is what holds the loop open).
  const keep = setInterval(() => {}, 1000)
  const t0 = Date.now()
  const slow = await discoverRelays({ subnets: [{ prefix: '10.9.9', self: '10.9.9.1' }], timeoutMs: 50, concurrency: 64,
    fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))) })
  const ms = Date.now() - t0
  ok(slow.found.length === 0 && ms < 1500, `a silent /24 ends on the timeout, not never (${ms} ms)`)
  const t1 = Date.now()
  const capped = await discoverRelays({ subnets: [{ prefix: '10.9.9', self: '10.9.9.1' }, { prefix: '10.9.10', self: '10.9.10.1' }], timeoutMs: 100, concurrency: 8, budgetMs: 300,
    fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))) })
  const ms2 = Date.now() - t1
  ok(capped.found.length === 0 && ms2 < 700, `the whole search stops at its budget (${ms2} ms for 506 slow addresses)`)
  clearInterval(keep)
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
