// install-firewall.sh against the real iptables in a private network namespace (unshare -rn, no
// root): a fake C0270 with tailscale's chains, a DERP connection out of its uplink and SSH sessions
// in over the tailnet, the cable and the AP, kept alive through apply, rollback and commit
// (test/firewall-install-netns.sh). The 18.11.2026 incident: install-firewall.sh on the C0270 and
// the tailnet was gone for hours. Starts from the firewall the board had committed on 13.11 when
// git still has it, else from the current one. Skips where user namespaces, iptables, nft or
// python3 are not available.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'firewall-install-netns.sh')
const can = process.platform === 'linux' && fs.existsSync('/usr/sbin/iptables') && fs.existsSync('/usr/sbin/nft') &&
  spawnSync('python3', ['-c', '1']).status === 0 && spawnSync('unshare', ['-rn', '/usr/sbin/iptables', '-S']).status === 0
if (!can) {
  console.log('⏭  firewall-install: skipped (needs Linux, iptables, nft, python3 and unprivileged user namespaces)')
  process.exit(0)
}
const env = { ...process.env }
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fwinst-'))
const old = spawnSync('git', ['-C', path.join(here, '..'), 'show', '5f8defa:provisioning/ledbox-firewall.sh'], { encoding: 'utf8' })
if (old.status === 0 && old.stdout.includes('LEDBOX-FWD')) {
  fs.writeFileSync(path.join(T, 'fw-13.11.sh'), old.stdout)
  env.OLD_FW = path.join(T, 'fw-13.11.sh')
  console.log('  starting from the firewall committed on the C0270 on 13.11 (5f8defa)')
} else console.log('  starting from the current firewall (no git history here)')
const r = spawnSync('unshare', ['-rn', 'bash', script], { encoding: 'utf8', timeout: 240_000, env })
fs.rmSync(T, { recursive: true, force: true })
const lines = (r.stdout || '').split('\n').filter((l) => /^(PASS|FAIL) /.test(l))
let pass = 0, fail = 0
for (const l of lines) {
  if (l.startsWith('PASS ')) { pass++; console.log('  ✅', l.slice(5)) } else { fail++; console.log('  ❌', l.slice(5)) }
}
if (lines.length < 30 || !/\nDONE\n?$/.test(r.stdout || '')) { fail++; console.log('  ❌ the namespace test did not run to the end\n' + (r.stderr || '').slice(-1500)) }
console.log(`\n${fail ? '❌' : '✅'} firewall-install: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
