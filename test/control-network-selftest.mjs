// The board's own Wi-Fi and cable are for control only: a device on them must never reach the
// internet through the board. Runs provisioning/ledbox-firewall.sh in a private network namespace
// (unshare -rn, no root) against a fake board with forwarding and NAT on, and asserts the phone is
// cut off while the board keeps its own uplink (test/control-network-netns.sh). Skips where user
// namespaces or iptables are not available (not Linux, a locked-down CI).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./control-network-netns.sh', import.meta.url))
const can = process.platform === 'linux' && fs.existsSync('/usr/sbin/iptables') &&
  spawnSync('unshare', ['-rn', 'true']).status === 0
if (!can) {
  console.log('⏭  control-network: skipped (needs Linux, iptables and unprivileged user namespaces)')
  process.exit(0)
}
const r = spawnSync('unshare', ['-rn', 'bash', script], { encoding: 'utf8', timeout: 60_000 })
const lines = (r.stdout || '').split('\n').filter((l) => /^(PASS|FAIL) /.test(l))
let pass = 0, fail = 0
for (const l of lines) {
  if (l.startsWith('PASS ')) { pass++; console.log('  ✅', l.slice(5)) } else { fail++; console.log('  ❌', l.slice(5)) }
}
if (lines.length < 9) { fail++; console.log('  ❌ the namespace test did not run to the end\n' + (r.stderr || '').slice(-1500)) }
console.log(`\n${fail ? '❌' : '✅'} control-network: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
