// Round 5 console work, asserted against web/index.html: the season's home games on the Link tab
// (Today first, then Upcoming a day at a time, cancelled games greyed), the status line that says
// how old the board's copy is, the "Prepare home games automatically" switch, and the mirror
// keeping a gap between the left name and its set digit.
//
// No browser here (the layout itself was checked in headless Chrome at 1180x820, 844x390 and
// 390x844), so the logic is lifted out of the page by name and run against a tiny DOM, and the
// markup/CSS is asserted from source — a renamed function fails loudly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const index = fs.readFileSync(path.resolve(here, '..', 'web', 'index.html'), 'utf8')
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

// --- a tiny DOM: enough for the schedule list, <details> and its toggle ---------------------
function el(tag) {
  const cls = new Set()
  return {
    tag, children: [], attrs: {}, hidden: false, disabled: false, title: '', type: '', _text: '', open: false,
    listeners: {},
    get className() { return [...cls].join(' ') }, set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)) },
    classList: { toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c) }, contains: (c) => cls.has(c) },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join('') },
    set textContent(v) { this._text = String(v); this.children = [] },
    set innerHTML(v) { if (v !== '') throw new Error('innerHTML used with content'); this.children = []; this._text = '' },
    append(...c) { this.children.push(...c) }, appendChild(c) { this.children.push(c); return c },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    addEventListener(t, f) { this.listeners[t] = f },
  }
}
const find = (root, pred, out = []) => { if (!root || !root.children) return out; for (const c of root.children) { if (pred(c)) out.push(c); find(c, pred, out) } return out }

const NAMES = ['fmtSchedDate', 'schedAddDays', 'schedLocal', 'schedOff', 'schedStatusText', 'schedRow', 'schedDay', 'renderUpcoming', 'refreshSchedule']
function page() {
  const nodes = {}
  for (const [sel, tag] of [['#schedule', 'ul'], ['#schedNote', 'p'], ['#schedRefreshBtn', 'button'], ['#schedDate', 'span'],
    ['#schedStatus', 'p'], ['#upcomingWrap', 'div'], ['#upcoming', 'div'], ['#seasonMoreBtn', 'button']]) nodes[sel] = el(tag)
  const document = { createElement: el, createTextNode: (t) => ({ textContent: String(t) }) }
  const io = { reply: null, asked: '', started: [] }
  const api = async (p) => { io.asked = p; if (io.reply instanceof Error) throw io.reply; return io.reply }
  const make = new Function('$', 'api', 'document', 'startScheduled',
    'let schedLoading = false, schedShowAll = false, schedDays = [], schedToday = "";\nconst SCHED_OPEN_DAYS = 14, SCHED_TZ = "Europe/Zurich";\n' +
    NAMES.map((n) => lift(js, n)).join('\n') + '\n' +
    'const schedShort = ' + lift(js, 'schedShort').replace(/^const schedShort = /, '') + ';\n' +
    'return { refreshSchedule, schedStatusText, schedLocal, showAll: () => { schedShowAll = true; renderUpcoming(); }, today: () => schedToday };')
  const fns = make((s) => nodes[s], api, document, (g) => io.started.push(g))
  return { nodes, io, ...fns }
}

const game = (id, date, time, extra = {}) => ({ id, date, time, home: 'KSC Wiedikon H1', away: 'VBC Züri Unterland H2',
  homeShort: 'KSCW H1', awayShort: 'ZÜRI H2', league: '3. Liga Herren', hall: 'KWI A', ...extra })
function season(today = '2026-09-23') {
  const days = []
  // 12 home days across the season: 3 in the first fortnight, the rest later.
  for (const [i, d] of ['2026-09-26', '2026-09-30', '2026-10-03', '2026-10-17', '2026-10-24', '2026-11-07', '2026-11-21',
    '2026-12-05', '2027-01-16', '2027-01-30', '2027-02-13', '2027-03-06'].entries()) {
    days.push({ date: d, games: [game(100 + i * 2, d, '14:00'), game(101 + i * 2, d, '16:30', i === 1 ? { status: 'cancelled' } : {})] })
  }
  return { ok: true, date: today, fetchedAt: '2026-09-23T15:52:10.000Z', stale: false,
    today: [game(1, today, '19:30'), game(2, today, '20:45', { status: 'postponed' })], upcoming: days }
}

console.log('\n[1] the status line: fresh, stale, never synced, nothing at all')
{
  const { schedStatusText, schedLocal } = page()
  const at = schedLocal('2026-09-23T15:52:10.000Z')
  ok(at && at.hm === '17:52' && at.dm === '23.09' && at.day === '2026-09-23', `times are the hall's (Zurich), not UTC (${JSON.stringify(at)})`)
  ok(schedLocal('2026-09-23T22:30:00.000Z').day === '2026-09-24', 'after midnight in Zurich it is already tomorrow')
  ok(schedStatusText({ ok: true, fetchedAt: '2026-09-23T15:52:10.000Z', stale: false }, '2026-09-23').text === 'Season schedule · updated 17:52', '"Season schedule · updated 17:52"')
  ok(schedStatusText({ ok: true, fetchedAt: '2026-09-22T18:10:00.000Z', stale: false }, '2026-09-23').text === 'Season schedule · updated 22.09 20:10', 'an update from yesterday carries its date')
  const st = schedStatusText({ ok: true, fetchedAt: '2026-09-23T15:52:10.000Z', stale: true }, '2026-09-24')
  ok(st.text === 'offline — last update 23.09 17:52' && st.stale === true, `stale: "offline — last update 23.09 17:52" ("${st.text}")`)
  ok(/^offline — /.test(schedStatusText({ ok: true, fetchedAt: null, stale: true }, '2026-09-23').text), 'stale without a timestamp (clock never synced) still says offline')
  ok(schedStatusText({ ok: false, error: 'x' }, '').text === 'No schedule yet — the board downloads it as soon as it has internet', 'no cache at all: "No schedule yet — …"')
  ok(schedStatusText({ ok: true, date: '2026-09-23', games: [] }, '2026-09-23').text === '', 'an older board (today only, no cache fields) gets no status line')
}

console.log('\n[2] Today first, then the season a day at a time')
{
  const p = page()
  p.io.reply = season()
  await p.refreshSchedule(false)
  const { nodes, io } = p
  ok(io.asked === '/api/schedule?range=season', 'reads ?range=season')
  ok(nodes['#schedStatus'].textContent === 'Season schedule · updated 17:52' && !nodes['#schedStatus'].hidden, 'the status line is shown')
  ok(!nodes['#schedStatus'].classList.contains('stale'), 'fresh is not amber')
  const today = nodes['#schedule'].children
  ok(today.length === 2, 'both of tonight\'s games are listed')
  const b0 = today[0].children[0], b1 = today[1].children[0]
  ok(b0.className === 'schedrow' && !b0.disabled && typeof b0.listeners.click === 'function', 'a game that is on is a live button')
  ok(b0.children[2].textContent === 'Start', 'tonight\'s rows say Start')
  ok(b1.className === 'schedrow off' && b1.disabled === true && !b1.listeners.click, 'a postponed game is greyed and cannot be tapped')
  ok(b1.children[2].textContent === 'Postponed' && /postponed$/.test(b1.attrs['aria-label']), 'and says so, to the eye and to a screen reader')
  b0.listeners.click(); ok(io.started.length === 1 && io.started[0].id === 1, 'tapping tonight\'s row starts that game')
  ok(nodes['#upcomingWrap'].hidden === false, 'Upcoming is shown')
  const days = nodes['#upcoming'].children
  ok(days.length === 3 && days.every((d) => d.tag === 'details'), `only the next 14 days are listed (${days.length})`)
  ok(days.every((d) => d.open === true), 'and they are open')
  ok(days[0].children[0].textContent === 'Sat 26.09.2 games', `a day reads "Sat 26.09. · 2 games" ("${days[0].children[0].textContent}")`)
  ok(/1 game · 1 off$/.test(days[1].children[0].textContent), 'a day with a cancelled game counts it apart')
  const rows = find(days[0], (c) => c.className === 'schedrow')
  ok(rows.length === 2 && rows[0].children[2].textContent === 'Prepare', 'an open day has its rows, and they say Prepare')
  rows[1].listeners.click(); ok(io.started[1].id === 101 && io.started[1].date === '2026-09-26', 'tapping one prepares that game, date and all')
  ok(find(days[1], (c) => c.className === 'schedrow off').length === 1, 'the cancelled game is greyed there too')
  const more = nodes['#seasonMoreBtn']
  ok(more.hidden === false && more.textContent === 'Show whole season (9 more days)', `"${more.textContent}"`)

  p.showAll()
  const all = nodes['#upcoming'].children
  ok(all.length === 12 && more.hidden === true, 'Show whole season lists every day and steps aside')
  const late = all[11]
  ok(late.open === false && late.children.length === 1, 'the later days are collapsed and their rows not built yet (lazy)')
  late.open = true; late.listeners.toggle()
  ok(find(late, (c) => c.className === 'schedrow').length === 2, 'opening one builds its rows')
  late.listeners.toggle()
  ok(late.children.length === 2, 'and only once')
}

console.log('\n[3] offline with a copy, nothing today, nothing at all')
{
  const p = page()
  const r = season(); r.stale = true; r.today = []
  p.io.reply = r
  await p.refreshSchedule(true)
  ok(p.io.asked === '/api/schedule?range=season&refresh=1', 'Refresh asks the board to fetch now')
  ok(p.nodes['#schedStatus'].textContent === 'offline — last update 23.09 17:52' && p.nodes['#schedStatus'].classList.contains('stale'), 'stale copy: amber "offline — last update …"')
  ok(p.nodes['#schedNote'].textContent === 'No home games today. The next is Sat 26.09.', `no game tonight points at the next ("${p.nodes['#schedNote'].textContent}")`)
  ok(p.nodes['#upcoming'].children.length === 3, 'the saved season is still listed offline')

  p.io.reply = { ok: false, error: 'The board could not reach the club\'s schedule. It may have no internet here — type the team names instead.' }
  await p.refreshSchedule(false)
  ok(p.nodes['#schedStatus'].textContent === 'No schedule yet — the board downloads it as soon as it has internet', 'no copy: "No schedule yet"')
  ok(/You can still type the names on the Game tab\.$/.test(p.nodes['#schedNote'].textContent), 'and the way round it')
  ok(p.nodes['#upcomingWrap'].hidden === true, 'Upcoming hides')

  const q = page()
  const far = season(); far.upcoming = far.upcoming.slice(5)
  q.io.reply = far
  await q.refreshSchedule(false)
  ok(q.nodes['#upcoming'].children.length === 1 && /next 14 days\. The next is Sat 07\.11\.$/.test(q.nodes['#upcoming'].children[0].textContent), 'a quiet fortnight says when the next home game is')
  ok(q.nodes['#seasonMoreBtn'].hidden === false, 'with the whole season one tap away')
}

console.log('\n[4] preparing a game from another day')
{
  const s = lift(js, 'startScheduled')
  ok(/"Prepare " \+ home \+ " vs " \+ away \+ " \(" \+ fmtSchedDate\(g\.date\)/.test(s), 'the confirm names the day: "Prepare KSCW H1 vs ZÜRI H2 (Sat 26.09. 14:00)?"')
  ok(/danger: live/.test(s) && /prematch: true/.test(s), 'red only when a match is in progress, and always a pre-match')
}

console.log('\n[5] the switch in Settings')
{
  const fsx = index.slice(index.lastIndexOf('<fieldset>', index.indexOf('data-set="autoPrepare"')), index.indexOf('</fieldset>', index.indexOf('data-set="autoPrepare"')))
  ok(/<span>Prepare home games automatically \(60 min before\)<\/span>/.test(fsx), 'the row reads "Prepare home games automatically (60 min before)"')
  ok(/<input type="checkbox" data-set="autoPrepare" checked>/.test(fsx), 'a checkbox, on by default')
  ok(/automatic game preparation are shared across all sports/.test(js), 'the per-sport note lists it as shared')
}

console.log('\n[6] the mirror keeps a gap between the name and the set digit')
{
  const f = new Function('BH', 'cq', lift(js, 'fitMirrorName').replace('NAME_MIN_PX', '9') + '\nreturn fitMirrorName;')(64, (v) => (v / 64 * 100) + 'cqh')
  // Text width in this stub: 4.5 × font size (px per board px = 3).
  const name = (fs) => ({ style: { fontSize: (fs / 64 * 100) + 'cqh' }, get scrollWidth() { return Math.round(4.5 * parseFloat(this.style.fontSize) / 100 * 64 * 3) } })
  const n = name(18)
  f(n, 200, 3)
  const fitted = parseFloat(n.style.fontSize) / 100 * 64
  ok(n.style.maxWidth === '200px' && fitted < 18 && n.scrollWidth <= 200, `a name wider than its room shrinks to fit (18 → ${fitted.toFixed(1)})`)
  const short = name(18); f(short, 400, 3)
  ok(Math.abs(parseFloat(short.style.fontSize) / 100 * 64 - 18) < 1e-9, 'a name that fits keeps its size')
  const tiny = name(18); f(tiny, 20, 3)
  ok(Math.abs(parseFloat(tiny.style.fontSize) / 100 * 64 - 9) < 1e-9 && tiny.style.overflow === 'hidden', 'never below 9 px — past that it is clipped')
  const rp = lift(js, 'fitMirrorNames')
  ok(/set1\.offsetLeft - set1\.offsetWidth - n1\.offsetLeft - NAME_GAP \* px/.test(rp), 'the left name\'s room ends NAME_GAP board px before the set digit')
  ok(/n2\.offsetLeft - \(set2\.offsetLeft \+ set2\.offsetWidth\) - NAME_GAP \* px/.test(rp), 'and the right name\'s the same, mirrored')
  ok(/const NAME_GAP = [3-9]\b/.test(js), 'the gap is a few board px')
  ok(/fitMirrorNames\(\);/.test(lift(js, 'renderPreview')), 'every repaint fits the names')
  ok(/new ResizeObserver\(\(\) => fitMirrorNames\(\)\)/.test(js) && /observeMirrorFit\(inner\)/.test(lift(js, 'buildBoard')), 'and so does the match face appearing (painted on another tab it had no width)')
}

console.log('\n[7] markup and style')
{
  const tab = index.slice(index.indexOf('id="tab-link"'), index.indexOf('</section>', index.indexOf('id="tab-link"')))
  const at = (id) => tab.indexOf(`id="${id}"`)
  ok(at('schedStatus') > 0 && at('schedStatus') < at('schedule') && at('schedule') < at('upcoming') && at('upcoming') < at('matches'), 'status line, Today, Upcoming, then the relay list')
  ok(/\.schedrow\.off\{[^}]*color:var\(--muted\)/.test(css) && /\.schedrow\.off \.steams\{[^}]*line-through/.test(css), 'cancelled rows are greyed and struck through')
  ok(/\.schedstat\.stale\{color:var\(--warn\)\}/.test(css), 'a stale copy is amber')
  ok(/\$\("#seasonMoreBtn"\)\.addEventListener\("click"/.test(js), 'Show whole season is wired')
}

console.log(`\n${fail ? '❌' : '✅'} season-schedule-ui-selftest: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
