// pointhubd and the Point Hub canvas in openscore, against simulated chips: runs their Python tests,
// so `npm test` covers them. firmware/openscore/test_point_hub.py needs Pillow, like openscore itself.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
for (const [dir, mod] of [['firmware/pointhubd', 'test_pointhubd'], ['firmware/openscore', 'test_point_hub']]) {
  const r = spawnSync('python3', ['-W', 'ignore', '-m', 'unittest', mod], { cwd: path.join(root, dir), encoding: 'utf8' })
  const last = (r.stderr || '').trim().split('\n').slice(-3).join(' | ')
  if (r.status === 0) console.log(`  ✅ ${mod}: ${last}`)
  else { failed++; console.log(`  ❌ ${mod}\n${r.stdout}\n${r.stderr}`) }
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
