// The console and /logs page logic that has no server behind it to test through: the scorer-PIN
// rule the tablet applies before it sends, the basketball match summary, and the live log tail
// across reconnects and appliance restarts.
//
// There is no browser here, so the functions are lifted out of the page source by name and run
// against small stubs. That keeps the test on the code that actually ships rather than on a copy
// of it — a renamed function fails loudly here instead of the test quietly checking nothing.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => fs.readFileSync(path.resolve(here, '..', 'web', f), 'utf8')
const index = read('index.html')
const logs = read('logs.html')

// `function name(...) { ... }` out of the page, by brace matching. Good enough for this code: the
// functions lifted here have no unbalanced brace inside a string or regex.
function lift(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`))
  if (at < 0) throw new Error(`function ${name} not found`)
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`function ${name} is unbalanced`)
}
const flush = () => new Promise((r) => setTimeout(r, 0))

// A fake EventSource the tests drive by hand.
class FakeES {
  static all = []
  constructor(url) { this.url = url; this.closed = false; FakeES.all.push(this) }
  close() { this.closed = true }
  send(e) { this.onmessage && this.onmessage({ data: JSON.stringify(e) }) }
  open() { this.onopen && this.onopen() }
}
const entry = (id, level = 'info') => ({ id, level, scope: 't', msg: 'm' + id, ts: '2026-09-23T10:00:00Z' })

console.log('[1] the scorer PIN is checked on the tablet by the board\'s own rule')
{
  const m = index.match(/const PIN_RE = (\/.*\/);/)
  ok(!!m, 'the console declares the PIN rule')
  const re = eval(m[1])
  for (const good of ['1', '1234', '12345678']) ok(re.test(good), `accepts ${good}`)
  // '12.34' is what the numeric keypad offers; it reached the board as 1234 and locked the setter
  // out. 'abcd' sanitised to '' and silently removed the lock.
  for (const bad of ['12.34', 'abcd', '12 34', '-123', '123456789', '']) ok(!re.test(bad), `rejects ${JSON.stringify(bad)}`)
  const save = lift(index, 'saveSettings')
  const check = save.indexOf('PIN_RE.test(newPin)'), post = save.indexOf('postJSON("/api/settings"')
  ok(check > 0 && check < post, 'saveSettings refuses a bad PIN before anything is posted')
  ok(/if \(newPin && !PIN_RE\.test\(newPin\)\)[\s\S]{0,200}return;/.test(save), 'and returns without saving')
  ok(/data-set="scorerPin"[^>]*pattern="\[0-9\]\*"|pattern="\[0-9\]\*"[^>]*data-set="scorerPin"/.test(index),
    'the settings PIN box asks for the digits-only keypad')
  ok(/postJSON\("\/api\/settings", \{ clearPin: true \}\)/.test(index), 'removing the PIN is its own explicit request')
}

console.log('\n[2] a basketball game ends with a winner, not "Match drawn 0 – 0"')
{
  const num = (x) => Array.isArray(x) ? x.length : (Number(x) || 0)
  const make = (SPORT) => new Function('num', 'SPORT', lift(index, 'matchTally') + '\nreturn matchTally;')(num, SPORT)
  const state = { points_a: 78, points_b: 71, sets_won_a: 0, sets_won_b: 0 }
  eq(make('basketball')(state), { bball: true, a: 78, b: 71 }, 'basketball decides on the running score')
  eq(make('volleyball')({ points_a: 20, points_b: 25, sets_won_a: 3, sets_won_b: 1 }), { bball: false, a: 3, b: 1 },
    'volleyball still decides on sets')
  ok(/const \{ bball, a: sa, b: sb \} = matchTally\(state\)/.test(lift(index, 'showMatchEnd')), 'the console summary uses it')
  ok(/matchTally\(state\)/.test(lift(index, 'resultLines')), 'and so does the panel, so the two cannot disagree')
}

console.log('\n[3] the Diagnostics tail does not repeat itself on reconnect')
{
  FakeES.all = []
  // Just enough of a <ul> for the tail: rows in order, sibling links, removal, and clearing by
  // textContent. `rows` reads back what the operator would see.
  const kids = []
  const list = {
    get lastElementChild() { return kids[kids.length - 1] || null },
    appendChild(li) { li.parentNode = list; kids.push(li) },
    removeChild(li) { kids.splice(kids.indexOf(li), 1); li.parentNode = null },
    set textContent(_) { for (const k of kids) k.parentNode = null; kids.length = 0 },
  }
  const node = (label) => ({
    label, style: {}, parentNode: null,
    get nextElementSibling() { const i = kids.indexOf(this); return i < 0 ? null : kids[i + 1] || null },
    set textContent(v) { this.label = v },
  })
  const rows = () => kids.map((k) => k.label)
  const els = { '#logLevel': { value: 'info' }, '#logState': { textContent: '' }, '#logList': list }
  let stats = { startedAt: 'boot-1', lastId: 0 }
  const ctx = {
    $: (s) => els[s],
    EventSource: FakeES,
    api: async () => ({ stats }),
    appendLogRow: (e) => list.appendChild(node(e.id)),
    document: { createElement: () => node('') },
  }
  const src = ['let logES = null, logPaused = false, logLastId = 0, logBoot = null;',
    lift(index, 'openLogStream'), lift(index, 'closeLogStream'), lift(index, 'checkLogBoot'),
    'return { openLogStream, closeLogStream, get es() { return logES } };'].join('\n')
  const t = new Function(...Object.keys(ctx), src)(...Object.values(ctx))

  t.openLogStream()
  let es = t.es
  ok(!/sinceId/.test(es.url), 'a first open asks for the history')
  es.open(); await flush()
  for (const id of [1, 2, 3]) es.send(entry(id))
  // EventSource's own reconnect reuses the URL, so the server replays the history again.
  for (const id of [1, 2, 3, 4]) es.send(entry(id))
  eq(rows(), [1, 2, 3, 4], 'a replayed catch-up adds only the line it had not seen')

  t.openLogStream()   // leaving the tab and coming back, or the tablet waking
  ok(/sinceId=4/.test(t.es.url), 'reopening asks only for what came after the last line shown')

  // The appliance restarts: ids begin at 1 again.
  stats = { startedAt: 'boot-2', lastId: 2 }
  es = t.es
  es.open(); await flush()
  ok(es.closed && t.es !== es, 'a restarted appliance is noticed on reconnect and the stream reopened')
  ok(!/sinceId/.test(t.es.url), 'from the start of the new run')
  t.es.send(entry(1)); t.es.send(entry(2))
  eq(rows(), [1, 2, 3, 4, '— the board restarted —', 1, 2],
    'and the new run\'s lines are shown under the old ones, not dropped under the old mark')

  // A restart whose new run has already logged past the old mark (4 → 7) by the time EventSource
  // reconnects with sinceId=2: lines 5..7 get through before the check resolves, then the replay
  // brings 1..7. They must not be shown twice.
  t.openLogStream()
  es = t.es
  ok(/sinceId=2/.test(es.url), 'the tail picks up after the new run\'s last line')
  stats = { startedAt: 'boot-3', lastId: 7 }
  es.open()                                // the check is now in flight
  for (const id of [3, 4, 5, 6, 7]) es.send(entry(id))
  await flush()
  ok(es.closed && t.es !== es, 'the second restart is noticed too')
  for (const id of [1, 2, 3, 4, 5, 6, 7]) t.es.send(entry(id))
  eq(rows(), [1, 2, 3, 4, '— the board restarted —', 1, 2, '— the board restarted —', 1, 2, 3, 4, 5, 6, 7],
    'lines the reconnect let through before the check are taken back, not repeated under the marker')

  // Nothing shown before the connection (a fresh level filter empties the list): the lines it
  // appended are all the new run's, and all go.
  list.textContent = ''
  t.openLogStream()
  es = t.es
  stats = { startedAt: 'boot-4', lastId: 2 }
  es.open()
  for (const id of [8, 9]) es.send(entry(id))
  await flush()
  for (const id of [1, 2]) t.es.send(entry(id))
  eq(rows(), ['— the board restarted —', 1, 2], 'with an empty list to start from, the early lines are cleared entirely')
}

console.log('\n[4] /logs does not count a replayed line twice')
{
  FakeES.all = []
  const counters = { cErr: { textContent: '0' }, cWarn: { textContent: '0' }, jump: { hidden: true, textContent: '' } }
  const appended = []
  let stats = { startedAt: 'boot-1', lastId: 0 }
  let reloads = 0
  const ctx = {
    $: (id) => counters[id],
    EventSource: FakeES,
    setLive: () => {},
    append: (list) => appended.push(...list.map((e) => e.id)),
    reload: async () => { reloads++ },
    fetch: async () => ({ ok: true, json: async () => ({ stats }) }),
  }
  const src = ['let es = null, lastId = 0, streamId = 0, boot = null, paused = false, pending = [];',
    lift(logs, 'connect'), lift(logs, 'checkBoot'),
    'return { connect, get es() { return es }, setLast(n) { lastId = n } };'].join('\n')
  const t = new Function(...Object.keys(ctx), src)(...Object.values(ctx))

  t.setLast(10)
  t.connect()
  let es = t.es
  ok(/sinceId=10/.test(es.url), 'the stream starts after the page it just loaded')
  es.open(); await flush()
  es.send(entry(11, 'error')); es.send(entry(12, 'warn'))
  // A Wi-Fi roam: EventSource reconnects with the same sinceId=10 and gets 11 and 12 again.
  es.open(); await flush()
  es.send(entry(11, 'error')); es.send(entry(12, 'warn')); es.send(entry(13, 'error'))
  eq(appended, [11, 12, 13], 'replayed lines are not appended again')
  eq([counters.cErr.textContent, counters.cWarn.textContent].map(String), ["2", "1"], 'and the ERR/WARN counters count each line once')

  stats = { startedAt: 'boot-2', lastId: 3 }
  es.open(); await flush(); await flush()
  ok(reloads === 1 && t.es !== es, 'an appliance restart reloads the page from the new run and reconnects')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
