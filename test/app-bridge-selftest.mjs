// The Android tablet app (android/) and the board, from the board's side of android/BRIDGE.md.
//
//   [1] /app/version.json and /app/pointhub.apk: served from the dist dir with the right types,
//       no-store, the APK as a download, no PIN even on a PIN-protected board
//   [2] nothing there: a plain 404 for both, and /app says so instead of offering a dead button
//   [3] GET /app: the install page (button, the one-time "unknown apps" step, the version)
//   [4] the console, from source: it detects the bridge, skips the gate / wake lock / https move
//       in the app, keeps backups and the schedule on the tablet, and wraps every bridge call
//
// Plain node, no framework; exits non-zero on any failure.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAppliance } from '../src/appliance.js'
import { loadConfig } from '../src/config.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-app-'))
const boot = (stateDir, extra = {}) => startAppliance({
  stateDir, relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 250,
  mock: true, controlPort: 0, debug: false, ...extra,
})
const base = (app) => `http://127.0.0.1:${app.server.address().port}`

// A stand-in release, shaped exactly as android/build-release.sh writes it.
const dist = path.join(scratch, 'dist')
fs.mkdirSync(dist, { recursive: true })
const apk = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(4096, 7)])
const version = { versionCode: 3, versionName: '1.0.2', sha256: 'a'.repeat(64), url: '/app/pointhub.apk', notes: 'Fixes <b>things</b> & more', size: apk.length }
fs.writeFileSync(path.join(dist, 'pointhub.apk'), apk)
fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify(version, null, 2))

const apps = []
try {
  console.log('\n[1] the release is served')
  ok(loadConfig({ APP_DIST_DIR: '/x/y' }).appDistDir === '/x/y' && loadConfig({}).appDistDir === '', 'APP_DIST_DIR is read from the environment (unset = <repo>/android/dist)')
  const app = await boot(path.join(scratch, 'with'), { appDistDir: dist })
  apps.push(app)
  // A PIN on the board must not lock a fresh tablet out of installing the app.
  const pinned = await fetch(base(app) + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scorerPin: '4711' }) })
  ok(pinned.status === 200, `a scorer PIN is set (${pinned.status})`)

  let r = await fetch(base(app) + '/app/version.json')
  ok(r.status === 200, `version.json served (${r.status})`)
  ok(/^application\/json/.test(r.headers.get('content-type') || ''), `as application/json (${r.headers.get('content-type')})`)
  ok(/no-store/.test(r.headers.get('cache-control') || ''), `no-store (${r.headers.get('cache-control')})`)
  const v = await r.json().catch(() => null)
  ok(v && v.versionCode === 3 && v.url === '/app/pointhub.apk' && v.sha256 === version.sha256, 'the manifest as written, byte for byte in meaning')

  r = await fetch(base(app) + '/app/pointhub.apk')
  const body = Buffer.from(await r.arrayBuffer())
  ok(r.status === 200, `pointhub.apk served (${r.status})`)
  ok(r.headers.get('content-type') === 'application/vnd.android.package-archive', `as application/vnd.android.package-archive (${r.headers.get('content-type')})`)
  ok(/^attachment;\s*filename="pointhub\.apk"$/.test(r.headers.get('content-disposition') || ''), `as a download (${r.headers.get('content-disposition')})`)
  ok(/no-store/.test(r.headers.get('cache-control') || ''), 'no-store')
  ok(r.headers.get('content-length') === String(apk.length) && body.equals(apk), `the whole file, unchanged (${body.length} bytes)`)
  r = await fetch(base(app) + '/app/pointhub.apk', { method: 'HEAD' })
  ok(r.status === 200 && r.headers.get('content-length') === String(apk.length), 'HEAD answers with the size')
  r = await fetch(base(app) + '/app/pointhub.apk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ok(r.status === 405, `nothing but GET/HEAD (${r.status})`)
  // Only the two named files: nothing else in the dist dir is reachable.
  fs.writeFileSync(path.join(dist, 'apksigner.txt'), 'secret-ish')
  for (const p of ['/app/apksigner.txt', '/app/../android/dist/version.json', '/app/%2e%2e/package.json']) {
    r = await fetch(base(app) + p)
    ok(r.status === 404 || r.status === 403, `${p} is not served (${r.status})`)
  }

  console.log('\n[3] the install page')
  r = await fetch(base(app) + '/app')
  const page = await r.text()
  ok(r.status === 200 && /^text\/html/.test(r.headers.get('content-type') || ''), `/app is a page (${r.status}, ${r.headers.get('content-type')})`)
  ok(/no-store/.test(r.headers.get('cache-control') || ''), 'no-store')
  ok(/<title>Point Hub app<\/title>/.test(page) && /Install Point Hub on this tablet/.test(page), 'titled "Install Point Hub on this tablet"')
  ok(/<a class="btn" id="download" href="\/app\/pointhub\.apk" download="pointhub\.apk">Download Point Hub<\/a>/.test(page), 'one download button, straight at the APK')
  ok(/Only the first time:/.test(page) && /Allow from this source/.test(page), 'the one-time "install unknown apps" step is spelled out')
  ok(/Version 1\.0\.2 \(3\)/.test(page), 'the version it offers')
  ok(/Fixes &lt;b&gt;things&lt;\/b&gt; &amp; more/.test(page) && !/<b>things<\/b>/.test(page), 'release notes are escaped')
  ok(!/<script/i.test(page) && !/https?:\/\/(?!localhost)/.test(page.replace(/<a [^>]*href="\/[^"]*"/g, '')), 'self-contained: no script, nothing off the board')
  ok((await fetch(base(app) + '/app/')).status === 200, '/app/ too')
  r = await fetch(base(app) + '/app', { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36 PointHubApp/1.0.2' } })
  ok(/already in the app \(version 1\.0\.2\)/.test(await r.text()), 'opened inside the app, it says so')

  console.log('\n[2] no release on the board')
  const empty = path.join(scratch, 'empty')
  fs.mkdirSync(empty)
  const bare = await boot(path.join(scratch, 'without'), { appDistDir: empty })
  apps.push(bare)
  for (const p of ['/app/version.json', '/app/pointhub.apk']) {
    r = await fetch(base(bare) + p)
    const t = await r.text()
    ok(r.status === 404 && /^text\/plain/.test(r.headers.get('content-type') || '') && t === 'not found', `${p}: plain 404 (${r.status}, ${r.headers.get('content-type')})`)
  }
  r = await fetch(base(bare) + '/app')
  const none = await r.text()
  ok(r.status === 200 && /no copy of the tablet app yet/.test(none) && !/id="download"/.test(none), '/app says there is none, with no dead button')
  ok((await fetch(base(bare) + '/api/status')).status === 200, '/api/status (the app\'s discovery) is untouched')

  console.log('\n[4] the console in the app (from source)')
  ok(/const APP_BRIDGE = \(\(\) => \{ try \{ return window\.PointHubApp \|\| null; \} catch \{ return null; \} \}\)\(\);/.test(js), 'feature-detects window.PointHubApp (never the UA alone)')
  ok(/function appCall\(method, \.\.\.args\) \{[\s\S]*?try \{ return typeof APP_BRIDGE\[method\] === "function" \? APP_BRIDGE\[method\]\(\.\.\.args\) : undefined; \}\s*catch \{ return undefined; \}/.test(js), 'every bridge call goes through one try/catch (appCall)')
  // Every direct touch of the bridge object is inside a try.
  const direct = [...js.matchAll(/APP_BRIDGE\.(\w+)\(/g)].map((m) => m.index)
  ok(direct.every((i) => /try \{ [^\n]*$/.test(js.slice(Math.max(0, i - 60), i))), `the ${direct.length} direct APP_BRIDGE call(s) sit inside try`)
  ok(!/\bPointHubApp\.\w+\(/.test(js), 'no call on window.PointHubApp bypasses appCall')
  ok(/const APP_MODE = IN_APP \|\| APP_QUERY/.test(js), 'the bridge alone means app mode (?app=1 is only the backup)')
  ok(/const want = IN_APP \? false :/.test(js), 'the full-screen gate never shows in the app')
  ok(/if \(IN_APP\) \{ appCall\("keepAwake", true\); return; \}/.test(js) && /if \(IN_APP\) \{ appCall\("keepAwake", false\); return; \}/.test(js), 'keep-awake goes to PointHubApp.keepAwake, not a wake lock or the video')
  ok(/appCall\("keepAwake", false\);\s+\/\/ the board is going away/.test(js), 'and lets the tablet sleep once the board is shut down')
  ok(/if \(IN_APP\) return;\s*if \(!origin \|\| secureOk/.test(js), 'no move to https inside the app: it chooses the origin itself')
  ok(/if \(!IN_APP && "serviceWorker" in navigator/.test(js) && /if \(IN_APP\) \{ const mf = document\.querySelector\('link\[rel="manifest"\]'\); if \(mf\) mf\.remove\(\); \}/.test(js), 'no service worker and no install manifest in the app')
  ok(/html\.in-app \.js-fs\{display:none!important\}/.test(html), 'the full-screen buttons are hidden in the app')
  ok(/html\.in-app \.js-awake\{display:none!important\}/.test(html) && /addEventListener\("click", \(\) => \{ if \(!IN_APP\) setKeepAwake\(!keepAwake\); \}\)/.test(js), 'the keep-awake toggle is hidden and inert in the app (the app holds it)')
  ok(/while \(utf8Len\(json\) > BACKUP_MAX/.test(js) && /utf8Len\(json\) <= SCHEDULE_MAX/.test(js) && /new TextEncoder\(\)\.encode\(str\)\.length/.test(js), 'backup and schedule caps count UTF-8 bytes, as the app does')
  ok(/\[s\.team_a_name \|\| "", s\.team_b_name \|\| ""\]\.sort\(\)\.join\("\|"\)/.test(js) && /prev\.id && sig\.id \? prev\.id === sig\.id : prev\.teams === sig\.teams/.test(js), 'a change of ends does not make the set-end backup look like a new match')
  ok(/appBackupTick\(st\);/.test(js) && /const BACKUP_EVERY_MS = 60000;/.test(js), 'every status feeds the backup ticker (at most once a minute in play)')
  ok(/appSaveBackup\(over && !prev\.over \? "match-end" : "set-end", \{ refreshHistory: true \}\)/.test(js), 'a set end and a match end save straight away, with fresh history')
  ok(/appCall\("saveBackup", bkName\(reason, s\), json\)/.test(js) && /summary: backupSummary\(s, reason\)/.test(js) && /history: \(bkHist \|\| \[\]\)/.test(js), 'saveBackup(name, json) carries a summary, the status snapshot and the history')
  ok(/if \(IN_APP && r && r\.ok !== false\) appSaveSchedule\(r\);/.test(js) && /appCall\("saveSchedule", json\)/.test(js), 'the season schedule is handed to saveSchedule when it loads')
  ok(/id="appCard" hidden/.test(html) && /id="appExportBtn"[^>]*>[\s\S]{0,400}Export backups to the tablet<\/button>/.test(html), 'Settings ▸ Diagnostics has the app card with "Export backups to the tablet"')
  ok(/appJson\("getInfo", \{\}\)/.test(js) && /appCall\("exportBackups"\)/.test(js), 'showing getInfo\'s version, exporting with exportBackups')
  ok(/window\.addEventListener\("pointhubapp"/.test(js), 'the export\'s outcome is read from the app\'s event')
  ok(/<a class="setlink" id="getAppLink" href="\/app">[\s\S]{0,600}Get the tablet app<\/a>/.test(html) && /if \(link\) link\.hidden = IN_APP;/.test(js), 'in a browser, Settings links to /app ("Get the tablet app")')
} catch (e) {
  fail++
  console.log('  ❌ threw:', e && e.stack || e)
} finally {
  for (const a of apps) { try { await a.stop() } catch {} }
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — app-bridge-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
