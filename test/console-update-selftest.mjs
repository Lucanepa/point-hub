// The tablet is the board's control screen and stays open for days. After a deploy it must pick up
// the new console by itself — but never reload in the middle of a match.
import fs from 'node:fs'
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const srv = fs.readFileSync(new URL('../src/controlServer.js', import.meta.url), 'utf8')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m) } else { fail++; console.log('  ❌ ' + m) } }
console.log('\n[1] the board says which console it serves')
ok(/build: consoleBuild/.test(srv), '/api/status carries a build id')
ok(/createHash\('sha1'\)/.test(srv) && /'index\.html', 'logs\.html'/.test(srv), 'the build id is a hash of the files the tablet loads, not a hand-bumped number')
console.log('\n[2] the console reloads itself, only when it is quiet')
ok(/if \(st\.build\) noteBuild\(st\.build\)/.test(html), 'every status reply is checked for a new build')
ok(/if \(!BOOT_BUILD\) \{ BOOT_BUILD = build; return; \}/.test(html), 'the first build seen is the one this page loaded')
ok(/blank \|\| LAST_STATUS\.prematch\) && !cdTimer && !typing/.test(html), 'quiet = no score on the board (or pre-match), no countdown, nobody typing')
ok(/if \(quietForReload\(\)\) \{ location\.reload\(\); return; \}/.test(html), 'a quiet board reloads straight away')
ok(/id="updateBar" role="status" hidden/.test(html) && /#updateNow/.test(html), 'mid-match it only shows an "Update ready" bar with a Reload now button')
console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
