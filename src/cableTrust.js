// Cable trust: a tablet plugged into the board by CABLE is never asked for the scorer PIN.
//
// Owner decision 2026-10-22. The cable is a direct, physical connection to the board — whoever is
// holding its other end is standing at the scorer's table — so the PIN, which exists to keep the
// people on the board's Wi-Fi (the whole hall can join it: the passphrase is on the panel) from
// scoring, has nothing to protect there.
//
// The board's eth0 is statically 192.168.5.1 and hands a cabled tablet an address in 192.168.5.x
// (DHCP on eth0, no router behind it); the DIY board uses the same subnet through a USB-C Ethernet
// adapter. A request is cable-trusted when BOTH hold:
//   * it arrived on the cable address: the socket's LOCAL address is the board's cable address, so
//     it came in through eth0 and not through the Wi-Fi AP (172.24.1.1), the hall uplink, the
//     tailnet or loopback;
//   * it came from the cable subnet: the socket's REMOTE address is inside it (and is not the board
//     itself — a process on the board talking to its own cable address is no tablet).
// Both are properties of the TCP connection the kernel accepted. Nothing a client SENDS — no
// header, no query flag, no X-Forwarded-For — has any say, and nothing here ever reads one. The
// HTTPS listener shares the request handler, and a TLS socket reports the same two addresses, so
// the rule is identical on :8890 and :8891.
//
// Configurable (config.js: CABLE_TRUST, CABLE_ADDRESS, CABLE_SUBNET) and switchable off. A
// malformed address or subnet turns it OFF rather than guessing — failing closed means a cabled
// tablet is asked for the PIN like any other, never that a Wi-Fi one is waved through.

export const DEFAULT_CABLE_ADDRESS = '192.168.5.1'
export const DEFAULT_CABLE_SUBNET = '192.168.5.0/24'

// A dotted-quad IPv4 address — or its IPv4-mapped IPv6 form (::ffff:a.b.c.d), which is how Node
// reports IPv4 peers on a dual-stack listener — as an unsigned 32-bit number. Anything else
// (a real IPv6 address, junk, empty) is null.
export function ipv4ToInt(addr) {
  const s = String(addr ?? '').trim().toLowerCase().replace(/^::ffff:/, '')
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

// 'a.b.c.d/n' -> { net, mask } (unsigned), or null. A bare address counts as /32.
export function parseCidr(cidr) {
  const [addr, bitsRaw, extra] = String(cidr ?? '').trim().split('/')
  if (extra !== undefined) return null
  const ip = ipv4ToInt(addr)
  const bits = bitsRaw === undefined ? 32 : (/^\d{1,2}$/.test(bitsRaw) ? Number(bitsRaw) : NaN)
  if (ip === null || !(bits >= 0 && bits <= 32)) return null
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { net: (ip & mask) >>> 0, mask }
}

// The rule itself, on two addresses. Pure, so the tests can feed it every shape a socket reports.
export function isCableTrusted(localAddress, remoteAddress, { address = DEFAULT_CABLE_ADDRESS, subnet = DEFAULT_CABLE_SUBNET } = {}) {
  const want = ipv4ToInt(address)
  const net = parseCidr(subnet)
  const local = ipv4ToInt(localAddress)
  const remote = ipv4ToInt(remoteAddress)
  if (want === null || !net || local === null || remote === null) return false
  if (local !== want) return false            // not in through the cable
  if (remote === want) return false           // the board talking to itself
  return ((remote & net.mask) >>> 0) === net.net
}

// What the control server holds: the settings, whether they are usable, and `trusts(socket)`.
export function makeCableTrust({ enabled = true, address = DEFAULT_CABLE_ADDRESS, subnet = DEFAULT_CABLE_SUBNET } = {}) {
  const addr = String(address || DEFAULT_CABLE_ADDRESS).trim()
  const sub = String(subnet || DEFAULT_CABLE_SUBNET).trim()
  const valid = ipv4ToInt(addr) !== null && parseCidr(sub) !== null
  const on = !!enabled && valid
  return {
    enabled: on,
    address: addr,
    subnet: sub,
    // Why it is off, for the boot log: 'disabled' (CABLE_TRUST=0) or 'invalid' (bad address/subnet).
    off: on ? null : (!enabled ? 'disabled' : 'invalid'),
    trusts(socket) {
      if (!on || !socket) return false
      return isCableTrusted(socket.localAddress, socket.remoteAddress, { address: addr, subnet: sub })
    },
  }
}
