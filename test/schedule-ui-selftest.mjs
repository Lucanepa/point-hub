// Round 3 console work, asserted against web/index.html: today's games on the Link tab, "Show
// clock" everywhere pinning the clock screen, Delete saved game clearing the mirror, the Settings
// steppers lining up, and the real crest / Point Hub mark in place of drawn stand-ins.
//
// No browser here (the layout itself was checked in headless Chrome at 1180x820, 844x390 and
// 390x844), so the logic that decides what the scorer reads is lifted out of the page by name and
// run against stubs, and the markup/CSS is asserted from source — a renamed function fails loudly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const web = (f) => path.resolve(here, '..', 'web', f)
const index = fs.readFileSync(web('index.html'), 'utf8')
const css = ((index.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '')
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''

function lift(src, name) {
  let at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`))
  if (at < 0) at = src.search(new RegExp(`const ${name} = `))
  if (at < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`${name} is unbalanced`)
}
// A handler body: from its anchor to the next top-level `});`.
const handler = (anchor) => { const at = js.indexOf(anchor); return at < 0 ? '' : js.slice(at, js.indexOf('\n  });', at)) }

// --- a tiny DOM, enough for refreshSchedule --------------------------------------------------
function el(tag) {
  return {
    tag, children: [], attrs: {}, className: '', hidden: false, disabled: false, title: '', _text: '',
    listeners: {},
    get textContent() { return this._text + this.children.map((c) => c.textContent).join('') },
    set textContent(v) { this._text = String(v); this.children = [] },
    set innerHTML(v) { if (v !== '') throw new Error('innerHTML used with content'); this.children = []; this._text = '' },
    append(...c) { this.children.push(...c) }, appendChild(c) { this.children.push(c) },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    addEventListener(t, f) { this.listeners[t] = f },
  }
}

console.log('\n[1] Today at the hall: rows, empty and offline')
{
  const nodes = { '#schedule': el('ul'), '#schedNote': el('p'), '#schedRefreshBtn': el('button'), '#schedDate': el('span') }
  const document = { createElement: el, createTextNode: (t) => ({ textContent: String(t) }) }
  let reply = null, asked = ''
  const api = async (p) => { asked = p; if (reply instanceof Error) throw reply; return reply }
  const started = []
  // The season list (renderUpcoming) finds no #upcomingWrap in this DOM and steps aside; its own
  // selftest is season-schedule-ui-selftest.mjs.
  const make = new Function('$', 'api', 'document', 'startScheduled',
    'let schedLoading = false, schedShowAll = false, schedDays = [], schedToday = "";\nconst SCHED_OPEN_DAYS = 14, SCHED_TZ = "Europe/Zurich";\n' +
    // Outside the tablet app: the offline schedule copy (android/BRIDGE.md) is not taken.
    'const IN_APP = false, appSaveSchedule = () => {};\n' +
    ['fmtSchedDate', 'schedAddDays', 'schedLocal', 'schedOff', 'schedStatusText', 'schedRow', 'schedDay', 'renderUpcoming'].map((n) => lift(js, n)).join('\n') + '\n' +
    'const schedShort = ' + lift(js, 'schedShort').replace(/^const schedShort = /, '') + ';\n' +
    lift(js, 'refreshSchedule') + '\nreturn refreshSchedule;')
  const refreshSchedule = make((s) => nodes[s], api, document, (g) => started.push(g))

  reply = { ok: true, date: '2026-09-23', sport: 'volleyball', games: [
    { id: 1, time: '19:30', home: 'KSC Wiedikon H1', away: 'KSC Wiedikon H3', homeShort: 'KSCW H1', awayShort: 'KSCW H3', league: '3. Liga Herren', hall: 'KWI A' },
    { id: 3, time: '20:45', home: 'KSC Wiedikon D2', away: '<img src=x onerror=alert(1)>', homeShort: 'KSCW D2', awayShort: '', league: '2. Liga Damen', hall: 'KWI B' },
  ] }
  await refreshSchedule(false)
  const rows = nodes['#schedule'].children
  ok(asked === '/api/schedule?range=season', 'opens with the cached season read (an older board answering today-only still fills Today)')
  ok(rows.length === 2, 'one row per game')
  const b0 = rows[0].children[0]
  ok(b0.tag === 'button' && b0.className === 'schedrow', 'each row is one big button')
  ok(/19:30/.test(b0.textContent) && /KSCW H1vsKSCW H3/.test(b0.textContent) && /3\. Liga Herren · KWI A/.test(b0.textContent), `row reads time · HOME vs AWAY · league ("${b0.textContent}")`)
  ok(/<IMG SRC=X/.test(rows[1].children[0].textContent), 'a hostile name is text (uppercased, capped), never markup')
  ok(nodes['#schedNote'].hidden === true, 'the note steps aside when there are games')
  ok(nodes['#schedDate'].textContent === 'Wed 23.09.', `the date is shown ("${nodes['#schedDate'].textContent}")`)
  b0.listeners.click(); ok(started.length === 1 && started[0].id === 1, 'tapping the row starts that game')

  reply = { ok: true, date: '2026-09-23', games: [] }
  await refreshSchedule(true)
  ok(asked === '/api/schedule?range=season&refresh=1', 'Refresh bypasses the cache')
  ok(nodes['#schedNote'].textContent === 'No home games today.' && !nodes['#schedNote'].hidden, 'empty: "No home games today."')

  reply = { ok: false, error: "The board could not reach the club's schedule. It may have no internet here — type the team names instead.", games: [] }
  await refreshSchedule(false)
  const n = nodes['#schedNote'].textContent
  ok(/could not reach the club's schedule/.test(n) && /You can still type the names on the Game tab\.$/.test(n), `offline: the server's reason plus the way round it ("${n}")`)
  ok(!/type the team names instead/.test(n), 'the server\'s own hint is not said twice')

  reply = new Error('/api/schedule → timeout')
  await refreshSchedule(false)
  ok(/You can still type the names on the Game tab/.test(nodes['#schedNote'].textContent), 'a board that does not answer gets the same way round it')
}

console.log('\n[2] starting a scheduled game')
{
  const s = lift(js, 'startScheduled')
  ok(/"Start " \+ home \+ " vs " \+ away \+ "\? The current score is cleared\."/.test(s), 'confirm reads "Start KSCW H1 vs KSCW H3? The current score is cleared."')
  ok(/danger: live/.test(s) && /const live = hasScore\(lastState\)/.test(s), 'red only when a match is in progress')
  ok(/choice: "new", teams: \{/.test(s) && /left: \{ name:/.test(s) && /right: \{ name:/.test(s), 'POST /api/game {choice:new, teams:{left,right}} — home on the left')
  ok(/goToTab\("manual"\)/.test(s), 'then switches to the Game tab')
  const hasScore = new Function('const num = (x) => Array.isArray(x) ? x.length : (Number(x) || 0);\n' + lift(js, 'hasScore') + '\nreturn hasScore;')()
  ok(!hasScore({ points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0 }) && !hasScore(null), '0–0 is not a match in progress')
  ok(hasScore({ points_a: 0, points_b: 1 }) && hasScore({ sets_won_a: [1] }), 'a point or a set is')
  ok(/if \(b\.dataset\.tab === "link"\) refreshSchedule\(false\)/.test(js), 'the list loads whenever the Link tab opens')
  const tab = index.slice(index.indexOf('id="tab-link"'), index.indexOf('</section>', index.indexOf('id="tab-link"')))
  ok(tab.indexOf('id="schedule"') > 0 && tab.indexOf('id="schedule"') < tab.indexOf('id="matches"'), 'Today at the hall sits above the LAN relay list')
}

console.log('\n[3] every "Show clock" pins the clock screen and closes its dialog')
{
  const sc = lift(js, 'showClock')
  ok(/postJSON\("\/api\/idle", \{ on: true, screen: "clock" \}\)/.test(sc), 'showClock posts /api/idle {on:true, screen:"clock"}')
  ok(/board\.mode = "clock"/.test(sc), 'and puts the mirror on the clock')
  ok(/id="spClock"/.test(index) && /Show clock<\/span><\/button>/.test(index), 'the sport picker has a Show clock button')
  const sp = handler('spClockBtn.addEventListener'), gp = handler('gpClockBtn.addEventListener'), me = handler('$("#meClock").addEventListener')
  ok(/showClock\(/.test(sp) && /closeSportPicker\(\)/.test(sp), 'picker: shows the clock, closes the picker')
  ok(/showClock\(/.test(gp) && /closeGamePicker\(\)/.test(gp), 'game menu: shows the clock, closes the menu')
  ok(/showClock\(/.test(me) && /closeMatchEnd\(\)/.test(me), 'match result: shows the clock, closes the dialog')
  ok(!/gameChoice\("clock"\)/.test(js), 'nothing uses the old {choice:"clock"} path any more')
  ok(/#bvPanel\[data-mode="clock"\] \.bvclock\{display:flex\}/.test(css), 'the mirror has a clock face')
}

console.log('\n[4] Delete saved game hides Continue/Delete and clears the mirror')
{
  const h = handler('gpDeleteBtn.addEventListener')
  ok(/\$\("#gpContinue"\)\.hidden = true; \$\("#gpDelete"\)\.hidden = true;/.test(h), 'both buttons go at once')
  ok(/r\.cleared === true/.test(h) && /board\.mode = "clock"/.test(h), 'a cleared board shows as the clock on the mirror')
  ok(/refreshStatus\(\)/.test(h), 'and the state is re-read')
}

console.log('\n[5] Settings steppers line up, units after the group')
{
  ok(/\.settings \.stepper\{[^}]*width:calc\(2 \* var\(--tap\) \+ 68px\)/.test(css), 'every stepper group has one fixed width')
  ok(/\.settings \.row em\{[^}]*flex:0 0 18px;width:18px/.test(css), 'the unit slot is fixed, wide enough for "ms"/"px"')
  const b = lift(js, 'buildSteppers')
  ok(/if \(!input\.parentElement\.querySelector\("em"\)\)/.test(b), 'a unitless row ("Total subs / set") gets an empty slot, so it lines up')
}

console.log('\n[6] the real crest and the Point Hub mark')
{
  ok(/'<img class="bvcrest" src="kscw_logo\.svg" alt="">'/.test(js), 'the mirror shows web/kscw_logo.svg')
  ok(!/<svg class="bvcrest"/.test(js), 'the drawn placeholder crest is gone')
  const logo = fs.readFileSync(web('kscw_logo.svg'), 'utf8')
  ok(/viewBox="0 0 253\.89 277\.99"/.test(logo) && /id="Trio"/.test(logo) && !/id="(Blau|Gelb|Weiss)"/.test(logo), 'kscw_logo.svg is the website crest, visible layer only')
  ok(/#bvPanel\[data-branding="plain"\] \.bvcrest\{display:none\}/.test(css), '"Plain" branding still hides it')
  ok(/<span class="brand"><img class="brandmark" src="favicon\.svg" alt=""/.test(index), 'the top bar carries the Point Hub mark')
  ok(!/<span class="brand"><svg class="licon l-volleyball"/.test(index), 'not the generic volleyball')
}

console.log(`\n${fail ? '❌' : '✅'} schedule-ui-selftest: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
