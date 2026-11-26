// provisioning/ledbox-ov-online.sh — "OpenVolley online for devices on the board's Wi-Fi" — on the
// root side. Two halves:
//
//   [1]-[6] the decision logic against stand-ins for iptables, nft, nmcli, sysctl, systemctl and
//           dnsmasq (moved in through the env, like the other selftests' stubs): it never turns on
//           without the firewall's forward drop or a dnsmasq that can fill an nft set, says why it
//           is not active, follows the uplink's DNS server without restarting dnsmasq for nothing,
//           puts the old dnsmasq file back when dnsmasq refuses the new one, and off leaves nothing.
//   [7]     the real thing in a network namespace (test/ov-online-netns.sh, real iptables and nft,
//           a phone, the board and "the internet"): only OpenVolley's addresses get out, on 443 only,
//           through a firewall rebuild and a reboot, and off closes it again. Skipped where user
//           namespaces, iptables or nft are not available.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.resolve(here, '..', 'provisioning', 'ledbox-ov-online.sh')

// --- the stand-ins ---------------------------------------------------------------------------------
// State in plain files under F, so a scenario can set the board up and read back what happened.
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-online-'))
const F = path.join(T, 'fake')
const BIN = path.join(T, 'bin')
fs.mkdirSync(F); fs.mkdirSync(BIN)
const w = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/bash\nF=${JSON.stringify(F)}\n${body}\n`, { mode: 0o755 })
// iptables: rules as "<table> <chain> <spec>" lines, policies as files. -S, -C, -I, -A, -D, -P.
w('iptables', `
echo "iptables $*" >> "$F/calls"
[ "$1" = -w ] && shift 2
t=filter; [ "$1" = -t ] && { t=$2; shift 2; }
op=$1; c=$2; shift 2
R="$F/rules"; touch "$R"
case "$op" in
  -S) [ -n "$c" ] || exit 0
      if [ "$c" = FORWARD ] || [ "$c" = INPUT ] || [ "$c" = POSTROUTING ]; then echo "-P $c $(cat "$F/policy.$c" 2>/dev/null || echo ACCEPT)"
      else grep -q "^$t $c\\$\\|^$t $c " "$F/chains" 2>/dev/null || exit 1; echo "-N $c"; fi
      grep "^$t $c " "$R" | sed "s/^$t $c /-A $c /" ;;
  -C) grep -qxF "$t $c $*" "$R" ;;
  -A) echo "$t $c $*" >> "$R" ;;
  -I) [[ "$1" =~ ^[0-9]+$ ]] && shift; { grep -v "^$t $c " "$R"; echo "$t $c $*"; grep "^$t $c " "$R"; } > "$R.n"; mv "$R.n" "$R" ;;
  -D) n=$(grep -nxF "$t $c $*" "$R" | head -1 | cut -d: -f1); [ -n "$n" ] || exit 1; sed -i "\${n}d" "$R" ;;
  -P) echo "$1" > "$F/policy.$c" ;;
esac`)
// nft: the table exists as a file; its set's addresses in another.
w('nft', `
echo "nft $*" >> "$F/calls"
case "$*" in
  "list table inet ovonline") [ -f "$F/nft.table" ] ;;
  "delete table inet ovonline") [ -f "$F/nft.table" ] && rm -f "$F/nft.table" "$F/nft.set" ;;
  "list set inet ovonline ov4") [ -f "$F/nft.table" ] && { echo "elements = { $(cat "$F/nft.set" 2>/dev/null) }"; } ;;
  "-f -") cat > "$F/nft.table"; [ -f "$F/nft.fail" ] && { rm -f "$F/nft.table"; exit 1; }; true ;;
  *) exit 1 ;;
esac`)
w('nmcli', `echo "nmcli $*" >> "$F/calls"; d=$(cat "$F/dns" 2>/dev/null); [ -n "$d" ] && echo "IP4.DNS[1]:$d"; exit 0`)
w('sysctl', `
echo "sysctl $*" >> "$F/calls"
case "$1" in -n) cat "$F/ip_forward" 2>/dev/null || echo 0 ;; -qw) echo "\${2#*=}" > "$F/ip_forward" ;; esac`)
w('systemctl', `echo "systemctl $*" >> "$F/calls"`)
w('dnsmasq', `
echo "dnsmasq $*" >> "$F/calls"
case "$1" in
  --version) echo "Dnsmasq version 2.90"; echo "Compile time options: IPv6 GNU-getopt $(cat "$F/dnsmasq.opts" 2>/dev/null || echo nftset) auth" ;;
  --test) [ ! -f "$F/dnsmasq.refuse" ] ;;
esac`)
const DNSD = path.join(T, 'dnsmasq.d'), STATE = path.join(T, 'state')
fs.mkdirSync(DNSD)
const env = {
  ...process.env, OV_ONLINE_ALLOW_NONROOT: '1', OV_ONLINE_DEFAULTS: path.join(T, 'defaults'),
  IPT: path.join(BIN, 'iptables'), NFT: path.join(BIN, 'nft'), NMCLI: path.join(BIN, 'nmcli'), SYSCTL: path.join(BIN, 'sysctl'),
  SYSTEMCTL: path.join(BIN, 'systemctl'), DNSMASQ: path.join(BIN, 'dnsmasq'), LOGGER: 'true',
  OV_ONLINE_STATE_DIR: STATE, OV_ONLINE_DNS_DIR: DNSD, OV_ONLINE_NOFWD_SYSCTL: path.join(T, 'no-forward.conf'),
}
const run = (cmd) => {
  const r = spawnSync('bash', [helper, cmd], { env, encoding: 'utf8', timeout: 30000 })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { /* not JSON */ }
  return { rc: r.status, out: r.stdout || '', err: r.stderr || '', json }
}
const rd = (f) => { try { return fs.readFileSync(path.join(F, f), 'utf8') } catch { return '' } }
const calls = () => rd('calls')
const clearCalls = () => fs.rmSync(path.join(F, 'calls'), { force: true })
const conf = () => { try { return fs.readFileSync(path.join(DNSD, 'zz-ledbox-ov-online.conf'), 'utf8') } catch { return null } }
// A fresh board: the firewall's forward drop as ledbox-firewall.sh builds it (or not), forwarding off.
function board({ firewall = true, dns = '192.168.1.1', nftset = true, ipForward = '0' } = {}) {
  for (const f of fs.readdirSync(F)) fs.rmSync(path.join(F, f), { force: true })
  for (const f of fs.readdirSync(DNSD)) fs.rmSync(path.join(DNSD, f), { force: true })
  fs.rmSync(STATE, { recursive: true, force: true })
  fs.writeFileSync(path.join(F, 'ip_forward'), ipForward + '\n')
  fs.writeFileSync(path.join(F, 'dns'), dns)
  if (!nftset) fs.writeFileSync(path.join(F, 'dnsmasq.opts'), 'no-nftset')
  if (firewall) {
    fs.writeFileSync(path.join(F, 'chains'), 'filter LEDBOX-FWD\n')
    fs.writeFileSync(path.join(F, 'policy.FORWARD'), 'DROP\n')
    fs.writeFileSync(path.join(F, 'rules'), 'filter FORWARD -j LEDBOX-FWD\nfilter FORWARD -j ts-forward\nfilter LEDBOX-FWD -j DROP\n')
  }
}
const ours = () => rd('rules').split('\n').filter((l) => l.includes('ledbox-ov-online'))

console.log('[1] off is the default, and status says so')
{
  board()
  const s = run('status')
  ok(s.rc === 0 && s.json && s.json.installed === true, `status answers one line of JSON (${s.out.trim()})`)
  ok(s.json && s.json.enabled === false && s.json.active === false && s.json.reason === null, '...not enabled, not active, nothing left over')
  ok(s.json && s.json.upstream === '192.168.1.1' && s.json.firewall === true && s.json.nftset === true, '...the uplink\'s DNS server from NetworkManager, the firewall and dnsmasq ready')
  ok(!fs.existsSync(path.join(STATE, 'state')), 'status changes nothing')
  clearCalls()
  ok(run('apply').rc === 0 && !/systemctl restart dnsmasq/.test(calls()), 'the boot apply while off with nothing to remove restarts nothing')
  ok(run('refresh').rc === 0 && !/dnsmasq --test/.test(calls()), 'an uplink change while off does nothing')
  ok(run('nonsense').rc === 2, 'an unknown command is refused')
}

console.log('\n[2] never on without the firewall\'s forward drop, or a dnsmasq that fills the set')
{
  board({ firewall: false })
  let r = run('on')
  ok(r.rc === 3 && r.json && r.json.enabled === false, `no forward drop: refused (exit ${r.rc}), still off`)
  ok(rd('ip_forward').trim() === '0' && !rd('nft.table') && !ours().length && conf() === null, '...forwarding untouched, no table, no rule, no dnsmasq file')
  // A forward drop that is not first, or a chain that does not end in DROP, is no forward drop either.
  // tailscaled puts ts-forward first each time it starts: with a real drop, ours goes back in front.
  board(); fs.writeFileSync(path.join(F, 'rules'), 'filter FORWARD -j ts-forward\nfilter FORWARD -j LEDBOX-FWD\nfilter LEDBOX-FWD -j DROP\n')
  r = run('on')
  const fwdRules = rd('rules').split('\n').filter((l) => l.startsWith('filter FORWARD '))
  ok(r.rc === 0 && r.json && r.json.active === true && fwdRules[0] === 'filter FORWARD -j LEDBOX-FWD' && fwdRules.length === 2,
    `LEDBOX-FWD behind tailscale's chain: put back first, then on (${fwdRules.join(' | ')})`)
  // ...but never without a drop: the chain not ending in DROP is not moved, and refused.
  board(); fs.writeFileSync(path.join(F, 'rules'), 'filter FORWARD -j ts-forward\nfilter FORWARD -j LEDBOX-FWD\nfilter LEDBOX-FWD -j ACCEPT\n')
  ok(run('on').rc === 3 && rd('rules').startsWith('filter FORWARD -j ts-forward\n'), 'behind tailscale\'s chain with no DROP at the end: refused, FORWARD untouched')
  board(); fs.writeFileSync(path.join(F, 'policy.FORWARD'), 'ACCEPT\n')
  ok(run('on').rc === 3, 'FORWARD policy ACCEPT: refused')
  board({ nftset: false })
  r = run('on')
  ok(r.rc === 4 && r.json && r.json.nftset === false && r.json.enabled === false, 'a dnsmasq without nftset: refused (exit 4)')
  board(); fs.writeFileSync(env.OV_ONLINE_DEFAULTS, 'OV_ONLINE_AP_IF="wlan0; rm -rf /"\n')
  ok(run('on').rc === 3, 'a bad interface name in the defaults file: refused')
  fs.rmSync(env.OV_ONLINE_DEFAULTS)
}

console.log('\n[3] on: every piece, kernel forwarding last')
{
  board()
  clearCalls()
  const r = run('on')
  ok(r.rc === 0 && r.json && r.json.enabled === true && r.json.active === true, `on → enabled and active (${r.out.trim()})`)
  const p = r.json ? r.json.pieces : {}
  ok(p.nft && p.forward && p.nat && p.dns && p.ipForward, 'nft table, forward accepts, NAT, dnsmasq file, forwarding — all there')
  const lines = rd('rules').split('\n').filter(Boolean)
  const fwd = lines.filter((l) => l.startsWith('filter LEDBOX-FWD '))
  ok(fwd.length === 3 && fwd[2] === 'filter LEDBOX-FWD -j DROP', 'two accepts ahead of LEDBOX-FWD\'s DROP, the DROP still last')
  ok(fwd[0].includes('-i wlan0 -o wlan1 -s 172.24.1.0/24 -m mark --mark 0x77') && fwd[1].includes('-i wlan1 -o wlan0 -d 172.24.1.0/24 -m conntrack --ctstate ESTABLISHED,RELATED'),
    '...out: only the marked packets from the board\'s Wi-Fi; back: only replies')
  ok(lines.includes('nat POSTROUTING -s 172.24.1.0/24 -o wlan1 -m comment --comment ledbox-ov-online -j MASQUERADE'), 'NAT out of the uplink, for the board\'s Wi-Fi only')
  const table = rd('nft.table')
  ok(/iifname "wlan0" oifname "wlan1" ip saddr 172\.24\.1\.0\/24 ip daddr @ov4 tcp dport 443 meta mark set 0x77/.test(table), 'the mark: wlan0 → wlan1, TCP 443, an address in the set')
  const c = conf() || ''
  ok(/^server=\/openvolley\.app\/192\.168\.1\.1$/m.test(c) && /^server=\/connectivitycheck\.gstatic\.com\/192\.168\.1\.1$/m.test(c), 'dnsmasq asks the uplink\'s DNS for openvolley.app and the Android check')
  ok((c.match(/^server=/gm) || []).length === 6 && !/^server=[0-9]/m.test(c), '...and the four time servers, nothing else (no plain server= line)')
  ok(/^server=\/time\.android\.com\/192\.168\.1\.1$/m.test(c) && /^nftset=\/pool\.ntp\.org\/4#inet#ovonline#ntp4$/m.test(c) && !/^nftset=\/[^/]*ntp[^/]*\/4#inet#ovonline#ov4$/m.test(c),
    '...time-server answers go into their own set, not the HTTPS one')
  ok(/ip daddr @ntp4 udp dport 123 meta mark set 0x77/.test(table) && !/@ntp4 tcp/.test(table), 'the time servers: UDP 123 only')
  ok(/^nftset=\/openvolley\.app\/4#inet#ovonline#ov4$/m.test(c) && /^filter-AAAA$/m.test(c), '...answers go into the set, and no IPv6 answers')
  const order = calls().split('\n')
  const at = (re) => order.findIndex((l) => re.test(l))
  ok(at(/^sysctl -qw net\.ipv4\.ip_forward=1/) > at(/^nft -f -/) && at(/^sysctl -qw/) > at(/^systemctl restart dnsmasq/) && at(/^sysctl -qw/) > at(/^iptables .*-I LEDBOX-FWD/),
    'kernel forwarding goes on after everything else')
  ok(/dnsmasq --test/.test(calls()) && at(/dnsmasq --test/) < at(/systemctl restart dnsmasq/), 'dnsmasq checks the file before it is restarted')
  ok(fs.readFileSync(path.join(STATE, 'state'), 'utf8').trim() === 'on', 'remembered for the next boot')
  clearCalls()
  run('on')
  ok(ours().length === 3, 'on again: each rule still once')
}

console.log('\n[4] the uplink moves: a new DNS server, and only then a dnsmasq restart')
{
  clearCalls()
  run('refresh')
  ok(!/systemctl restart dnsmasq/.test(calls()), 'the same DNS server: dnsmasq is not restarted')
  fs.writeFileSync(path.join(F, 'dns'), '10.20.30.1')
  clearCalls()
  run('refresh')
  ok(/^server=\/openvolley\.app\/10\.20\.30\.1$/m.test(conf() || '') && /systemctl restart dnsmasq/.test(calls()), 'a new hall network: its DNS server, dnsmasq restarted once')
  // No uplink at all: nothing resolves, and status says why rather than "on".
  fs.writeFileSync(path.join(F, 'dns'), '')
  run('refresh')
  let s = run('status').json
  ok(s && s.enabled === true && s.active === false && s.reason === 'no-uplink-dns', `no DNS server on wlan1: enabled, not active, reason no-uplink-dns (${JSON.stringify(s && s.reason)})`)
  ok(!/^server=/m.test(conf() || 'server='), '...and dnsmasq asks nobody (OpenVolley\'s names do not resolve)')
  fs.writeFileSync(path.join(F, 'dns'), 'not-an-ip')
  run('refresh')
  ok(!/^server=/m.test(conf() || 'server='), 'a DNS "server" that is not an IPv4 address is not written into dnsmasq')
  fs.writeFileSync(path.join(F, 'dns'), '192.168.1.1')
  run('refresh')
  s = run('status').json
  ok(s && s.active === true, 'back on the uplink: active again')
  // dnsmasq refuses the new file: the old one goes back, and it is not active with a broken file.
  fs.writeFileSync(path.join(F, 'dnsmasq.refuse'), '')
  fs.writeFileSync(path.join(F, 'dns'), '172.16.0.1')
  run('refresh')
  ok(/^server=\/openvolley\.app\/192\.168\.1\.1$/m.test(conf() || ''), 'dnsmasq refused the new file: the old one is back')
  fs.rmSync(path.join(F, 'dnsmasq.refuse'))
  fs.writeFileSync(path.join(F, 'dns'), '192.168.1.1')
  // Pinned upstream in the defaults file wins over NetworkManager.
  fs.writeFileSync(env.OV_ONLINE_DEFAULTS, 'OV_ONLINE_DNS=9.9.9.9\n')
  run('refresh')
  ok(/^server=\/openvolley\.app\/9\.9\.9\.9$/m.test(conf() || ''), 'OV_ONLINE_DNS in /etc/default/ledbox-ov-online pins the upstream')
  fs.rmSync(env.OV_ONLINE_DEFAULTS)
  run('refresh')
}

console.log('\n[5] the firewall rebuilt, a reboot')
{
  // ledbox-firewall.sh flushes LEDBOX-FWD and adds its DROP: forward-rules puts the accepts back.
  fs.writeFileSync(path.join(F, 'rules'), rd('rules').split('\n').filter((l) => !l.startsWith('filter LEDBOX-FWD')).join('\n') + '\nfilter LEDBOX-FWD -j DROP\n')
  ok(run('forward-rules').rc === 0 && ours().filter((l) => l.startsWith('filter LEDBOX-FWD')).length === 2, 'forward-rules: the two accepts are back ahead of the DROP')
  // A reboot: no nft table, no NAT, forwarding back to 0 (lock-control-network.sh's sysctl file).
  fs.rmSync(path.join(F, 'nft.table'))
  fs.writeFileSync(path.join(F, 'rules'), 'filter FORWARD -j LEDBOX-FWD\nfilter LEDBOX-FWD -j DROP\n')
  fs.writeFileSync(path.join(F, 'ip_forward'), '0\n')
  run('forward-rules') // ledbox-lan-guard at boot
  ok(run('apply').rc === 0 && run('status').json.active === true, 'the boot apply puts everything back')
  // tailscaled starts after that and takes the first place in FORWARD: its tailscale0-up refresh puts ours back.
  fs.writeFileSync(path.join(F, 'rules'), 'filter FORWARD -j ts-forward\n' + rd('rules'))
  ok(run('status').json.active === false, 'tailscale\'s chain first: status no longer active')
  ok(run('refresh').rc === 0 && run('status').json.active === true && rd('rules').split('\n').filter((l) => l.startsWith('filter FORWARD '))[0] === 'filter FORWARD -j LEDBOX-FWD',
    '...a refresh puts LEDBOX-FWD back first, active again')
  // forward-rules while off does nothing, and never on a board without the drop.
  run('off')
  fs.writeFileSync(path.join(F, 'rules'), 'filter FORWARD -j LEDBOX-FWD\nfilter LEDBOX-FWD -j DROP\n')
  run('forward-rules')
  ok(!ours().length, 'forward-rules while off adds nothing')
}

console.log('\n[6] off: nothing left, forwarding as it was')
{
  board({ ipForward: '0' })
  run('on')
  ok(rd('ip_forward').trim() === '1', 'on: forwarding 1')
  const r = run('off')
  ok(r.rc === 0 && r.json && r.json.enabled === false && r.json.active === false && r.json.reason === null, `off → not enabled, nothing left (${r.out.trim()})`)
  ok(!ours().length && !rd('nft.table') && conf() === null, 'no rule of ours, no table, no dnsmasq file')
  ok(rd('rules').includes('filter LEDBOX-FWD -j DROP'), 'the firewall\'s own DROP untouched')
  ok(rd('ip_forward').trim() === '0', 'forwarding back to 0, what it was before on')
  // A vendor board that had forwarding on before keeps it on (the forward drop holds either way).
  board({ ipForward: '1' })
  run('on'); run('off')
  ok(rd('ip_forward').trim() === '1', 'a board that had forwarding on gets it back on')
  // A crashed half-on board (pieces, state off): status says leftover, the boot apply cleans it.
  board()
  run('on')
  fs.writeFileSync(path.join(STATE, 'state'), 'off\n')
  ok(run('status').json.reason === 'leftover', 'pieces left while off: reason leftover')
  run('apply')
  ok(!ours().length && !rd('nft.table') && conf() === null && run('status').json.reason === null, 'the boot apply removes them')
  // The hand-applied opening of 17.11.2026: its file and its uncommented rules go too.
  board()
  fs.writeFileSync(path.join(DNSD, 'zz-openvolley-online.conf'), 'server=/openvolley.app/1.1.1.1\n')
  fs.writeFileSync(path.join(DNSD, 'zz-openvolley-ntp.conf'), 'server=/time.android.com/1.1.1.1\n')
  fs.appendFileSync(path.join(F, 'rules'), 'filter LEDBOX-FWD -i wlan0 -o wlan1 -m mark --mark 0x77 -j ACCEPT\nnat POSTROUTING -s 172.24.1.0/24 -o wlan1 -j MASQUERADE\n')
  fs.writeFileSync(path.join(F, 'nft.table'), 'table inet ovonline {}')
  run('off')
  ok(!fs.existsSync(path.join(DNSD, 'zz-openvolley-online.conf')) && !fs.existsSync(path.join(DNSD, 'zz-openvolley-ntp.conf')) && !rd('rules').includes('--mark 0x77 -j ACCEPT') && !rd('rules').includes('MASQUERADE') && !rd('nft.table'),
    'off also removes the hand-applied opening (its file, rules, NAT and table)')
  // Without that file, a MASQUERADE of the same shape is the vendor's and is left alone.
  board()
  fs.appendFileSync(path.join(F, 'rules'), 'nat POSTROUTING -s 172.24.1.0/24 -o wlan1 -j MASQUERADE\n')
  run('on'); run('off')
  ok(rd('rules').includes('nat POSTROUTING -s 172.24.1.0/24 -o wlan1 -j MASQUERADE'), 'a vendor MASQUERADE that is not ours stays')
}

console.log('\n[7] in a network namespace: the real iptables and nft')
{
  const can = process.platform === 'linux' && fs.existsSync('/usr/sbin/iptables') && fs.existsSync('/usr/sbin/nft') &&
    spawnSync('python3', ['-c', '1']).status === 0 && spawnSync('unshare', ['-rn', '/usr/sbin/nft', 'list', 'ruleset']).status === 0
  if (!can) console.log('  ⏭  skipped (needs Linux, iptables, nft, python3 and unprivileged user namespaces)')
  else {
    const r = spawnSync('unshare', ['-rn', 'bash', path.join(here, 'ov-online-netns.sh')], { encoding: 'utf8', timeout: 120_000 })
    const lines = (r.stdout || '').split('\n').filter((l) => /^(PASS|FAIL) /.test(l))
    for (const l of lines) ok(l.startsWith('PASS '), l.slice(5))
    ok(lines.length >= 30 && /\nDONE\n?$/.test(r.stdout || ''), `the namespace test ran to the end (${lines.length} checks)` + (lines.length < 30 ? '\n' + (r.stderr || '').slice(-1500) : ''))
  }
}

fs.rmSync(T, { recursive: true, force: true })
console.log(`\n${fail ? '❌' : '✅'} ov-online helper: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
