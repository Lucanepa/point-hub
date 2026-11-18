// The console's side of OpenVolley online and the cloud, asserted against web/index.html in the
// style of hall-internet-ui-selftest.mjs (no browser: the scripts are lifted out of the page and run
// against a tiny DOM, the markup is asserted from source — a renamed id or function fails loudly):
//
//   [1] Settings ▸ OpenVolley online: the card, hidden unless the board has the switch, no Save row
//   [2] what the card says for every state the board reports
//   [3] the switch: a PIN-carrying POST, the answer adopted, a refusal and a locked console in words
//   [4] the Link tab: the cloud's rows marked as such, the laptop line counts only the laptop's, the
//       cloud's own line, and the "follows by itself" note only with the switch on
//   [5] Settings ▸ Hall internet ▸ Open the login page: the button stays "Opening…" until the page
//       is there (it sprang back at once, which looked like a tap that did nothing), and gives itself
//       back with a reason when the page never comes
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const index = fs.readFileSync(path.resolve(here, '..', 'web', 'index.html'), 'utf8')
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
const markup = index.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '')
const tagOf = (id) => (markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [])[0] || ''
const section = (from, to) => { const a = js.indexOf(from), b = js.indexOf(to, a); return a >= 0 && b > a ? js.slice(a, b) : '' }
// One named function's source, by brace matching from its header.
function fnSource(name) {
  const at = js.search(new RegExp(`\\bfunction ${name}\\(`))
  if (at < 0) return ''
  let i = js.indexOf('{', at), depth = 0
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break }
  return js.slice(at, i + 1)
}

function el(id) {
  const cls = new Set()
  return {
    id, hidden: false, disabled: false, title: '', value: '', textContent: '', dataset: {}, listeners: {}, attrs: {},
    classList: { toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c) }, contains: (c) => cls.has(c),
      add: (c) => cls.add(c), remove: (...c) => c.forEach((x) => cls.delete(x)) },
    addEventListener(t, f) { this.listeners[t] = f },
    focus() {}, select() {}, scrollIntoView() {}, offsetWidth: 1, setAttribute(k, v) { this.attrs[k] = String(v) },
  }
}

console.log('[1] the card')
const ovBlock = section('// --- openvolley online', '// --- hall internet')
ok(!!ovBlock, 'the console has an "openvolley online" script block')
{
  const card = tagOf('ovOnlineCard')
  ok(/^<fieldset/.test(card) && /\bhidden\b/.test(card) && /class="uplink ovonline"/.test(card), 'Settings has an OpenVolley online card, hidden until the board says it has the switch')
  const inner = (markup.match(/<fieldset id="ovOnlineCard"[\s\S]*?<\/fieldset>/) || [''])[0]
  ok(/<legend>[\s\S]*OpenVolley online<\/legend>/.test(inner), '...headed "OpenVolley online"')
  ok(!/data-set=/.test(inner), '...with no data-set: the switch is the board\'s, not a setting (no Save row)')
  ok(/id="ovoToggle"/.test(inner) && /id="ovoErr"[^>]*role="alert"/.test(inner), '...one button and an error line read out')
  ok(/nothing else, no other site/.test(inner), '...and says plainly that nothing else gets through')
  ok(markup.indexOf('id="uplinkCard"') < markup.indexOf('id="ovOnlineCard"'), 'right after Hall internet, which it depends on')
  ok(/renderOvOnline\(st\.ovOnline\);/.test(js), 'every status poll renders it')
}

function ovPage({ reply = {} } = {}) {
  const nodes = {}
  const $ = (sel) => (nodes[sel] ||= el(sel))
  const io = { calls: [], toasts: [], refreshed: 0 }
  const api = async (p, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    io.calls.push({ path: p, method: (opts && opts.method) || 'GET', body, headers: (opts && opts.headers) || {}, signal: opts && opts.signal })
    const r = typeof reply[p] === 'function' ? reply[p](body) : reply[p]
    if (r instanceof Error) throw r
    return r
  }
  const make = new Function('$', 'api', 'toast', 'refreshStatus', 'deadline', 'pinNow',
    ovBlock + '\nreturn { ovOnlineView, renderOvOnline, ovOnlineToggle, get OVO() { return OVO } }')
  const f = make($, api, (m) => io.toasts.push(m), () => { io.refreshed++ }, (ms) => ({ ms }), () => '2468')
  return { f, $, io }
}

console.log('\n[2] what it says')
{
  const { f } = ovPage()
  ok(f.ovOnlineView(null) === null, 'no switch on this board: nothing (the card stays hidden)')
  let v = f.ovOnlineView({ available: false, reason: 'not-installed' })
  ok(v.line === 'Not set up on this board' && v.button === null && /setup-ov-online\.sh/.test(v.sub), 'not installed: says so, no button')
  v = f.ovOnlineView({ available: true, enabled: false, active: false, reason: null })
  ok(v.state === 'off' && v.line === 'Off — the board\'s Wi-Fi has no internet' && v.button === 'Turn on' && v.want === true, 'off: "Off — the board\'s Wi-Fi has no internet", Turn on')
  v = f.ovOnlineView({ available: true, enabled: true, active: true, autoLink: true })
  ok(v.state === 'on' && v.button === 'Turn off' && v.want === false && /by itself/.test(v.sub) && /nothing else/.test(v.sub), 'on: Turn off, only OpenVolley, and the board follows by itself')
  v = f.ovOnlineView({ available: true, enabled: true, active: false, reason: 'no-uplink-dns' })
  ok(v.state === 'warn' && /no hall internet/.test(v.sub) && v.button === 'Turn off', 'on without hall internet: a warning that says why, still Turn off')
  v = f.ovOnlineView({ available: true, enabled: true, active: false, reason: 'something-new' })
  ok(v.state === 'warn' && /off and on again/.test(v.sub), 'an unknown reason: the generic way out')
  v = f.ovOnlineView({ available: true, enabled: false, active: false, reason: 'leftover' })
  ok(v.state === 'warn' && v.button === 'Remove them' && v.want === false, 'off with pieces left: offers to remove them (an off)')
  v = f.ovOnlineView({ available: true, checking: true, enabled: false })
  ok(v.state === 'checking' && v.button === null, 'still asking the board: no button yet')
}

console.log('\n[3] the switch')
{
  const p = ovPage({ reply: { '/api/ovonline': (b) => ({ ok: true, ovOnline: { available: true, enabled: b.on, active: b.on, autoLink: true } }) } })
  p.f.renderOvOnline(null)
  ok(p.$('#ovOnlineCard').hidden === true, 'st.ovOnline null: card hidden')
  p.f.renderOvOnline({ available: true, enabled: false, active: false, reason: null })
  ok(p.$('#ovOnlineCard').hidden === false && p.$('#ovoToggle').textContent === 'Turn on' && p.$('#ovoToggle').hidden === false, 'off: card shown, "Turn on"')
  ok(p.$('#cloudFollowNote').hidden === true, 'the Link tab\'s "follows by itself" note is hidden while off')
  ok(typeof p.$('#ovoToggle').listeners.click === 'function', 'the button is wired')
  const run = p.f.ovOnlineToggle()
  ok(p.$('#ovoToggle').disabled === true && p.$('#ovoToggle').textContent === 'Turning on…', 'while the board switches: disabled, "Turning on…"')
  // A status poll in the meantime does not undo the button.
  p.f.renderOvOnline({ available: true, enabled: false, active: false })
  ok(p.$('#ovoToggle').textContent === 'Turning on…', '...and a status poll meanwhile leaves it so')
  await run
  const c = p.io.calls.find((x) => x.path === '/api/ovonline')
  ok(c && c.method === 'POST' && c.body.on === true && c.headers['X-Scorer-Pin'] === '2468' && c.headers['content-type'] === 'application/json', 'POST /api/ovonline { on: true } with the scorer PIN')
  ok(c && c.signal && c.signal.ms >= 30000, '...with a deadline long enough for the board to restart its DNS server')
  ok(p.f.OVO.enabled === true && p.$('#ovoStat').dataset.state === 'on' && p.$('#ovoToggle').textContent === 'Turn off' && p.$('#ovoToggle').disabled === false, 'the answer adopted: on, "Turn off"')
  ok(p.$('#cloudFollowNote').hidden === false, 'the Link tab says the board follows a live hall match by itself')
  ok(p.io.toasts.includes('OpenVolley online is on') && p.io.refreshed === 1, 'a toast, and the status read again')
  await p.f.ovOnlineToggle()
  ok(p.io.calls.at(-1).body.on === false && p.f.OVO.enabled === false && p.io.toasts.at(-1) === 'OpenVolley online is off', 'and off again')

  const refused = ovPage({ reply: { '/api/ovonline': { ok: false, reason: 'no-firewall', error: 'The board\'s firewall is not set up for this — nothing was opened.', ovOnline: { available: true, enabled: false } } } })
  refused.f.renderOvOnline({ available: true, enabled: false })
  await refused.f.ovOnlineToggle()
  ok(refused.$('#ovoErr').hidden === false && /firewall is not set up/.test(refused.$('#ovoErr').textContent) && refused.$('#ovoToggle').textContent === 'Turn on', 'a refusal: the board\'s sentence, still "Turn on"')
  const locked = ovPage({ reply: { '/api/ovonline': Object.assign(new Error('scorer PIN required'), { status: 403 }) } })
  locked.f.renderOvOnline({ available: true, enabled: false })
  await locked.f.ovOnlineToggle()
  ok(/Unlock scoring first/.test(locked.$('#ovoErr').textContent), 'a locked console: "Unlock scoring first"')
}

console.log('\n[4] the Link tab')
{
  ok(/id="cloudLine"/.test(markup) && /<p class="note" id="cloudFollowNote" hidden>/.test(markup), 'the Link tab has the cloud line and the follow note (hidden)')
  const make = new Function(`${fnSource('relayView')}\n${fnSource('cloudView')}\nreturn { relayView, cloudView }`)
  const { relayView, cloudView } = make()
  const r = { relay: { ok: true, address: '172.24.1.23:8080', source: 'settings' }, matches: [{ source: 'lan', id: 'a' }, { source: 'cloud', id: 'b' }, { source: 'cloud', id: 'c' }] }
  ok(/1 match listed/.test(relayView(r).text), 'the laptop line counts the laptop\'s rows only, not the cloud\'s')
  ok(cloudView(null) === null && cloudView({ ok: true, count: 2, hall: 1 }) === null, 'the cloud listed something: no extra line')
  ok(/No match on OpenVolley's server from this hall/.test(cloudView({ ok: true, count: 0 })), 'nothing listed: one plain line')
  ok(/didn't answer/.test(cloudView({ ok: false, address: 'backend.openvolley.app', error: 'cloud: timed out' })), 'not reached: says so, with what it means')
  const refresh = fnSource('refreshMatches')
  ok(/m\.source === "cloud"/.test(refresh) && /"OpenVolley cloud · "/.test(refresh) && /"this hall"/.test(refresh), 'a cloud row is marked "OpenVolley cloud · this hall" (or why it may not be)')
  ok(/linkMatch\(m\)/.test(refresh) && /source: m\.source \|\| "lan", matchId: m\.id/.test(fnSource('linkMatch')), 'and links with its own source, like the laptop\'s')
  ok(!/\.innerHTML\s*=(?!\s*""\s*;)/.test(refresh), 'rows go in as text, never as markup')
}

console.log('\n[5] Hall internet ▸ Open the login page')
{
  const block = section('// --- hall internet', '// --- settings ---')
  ok(/async function uplinkOpenPortal\(/.test(block) && /\$\("#upPortal"\)\.addEventListener\("click", uplinkOpenPortal\)/.test(block), 'the button runs uplinkOpenPortal')
  const nodes = {}
  const $ = (sel) => (nodes[sel] ||= el(sel))
  const io = { calls: [], toasts: [], assigned: [], timers: [] }
  const api = async (p, opts) => { io.calls.push({ path: p, method: opts && opts.method, headers: opts && opts.headers }); return reply(p) }
  let reply = () => ({ ok: true, url: '/hall-login/', until: '2026-11-17T20:10:00Z' })
  const location = { hash: '', pathname: '/', search: '', assign: (u) => io.assigned.push(u) }
  const make = new Function('$', 'api', 'toast', 'SETTINGS', 'LAST_STATUS', 'goToTab', 'dismissKeyboard', 'refreshStatus',
    'setCard', 'diagOpen', 'deadline', 'SCORER_PIN', 'pinNow', 'localStorage', 'sessionStorage', 'location', 'setTimeout', 'history',
    block + '\nreturn { uplinkOpenPortal, get upBusy() { return upBusy } }')
  const f = make($, api, (m) => io.toasts.push(m), { liveScoring: 'kscw' }, {}, () => {}, () => {}, () => {}, () => {}, () => false,
    (ms) => ({ ms }), '2468', () => '2468', { setItem() {}, getItem: () => null, removeItem() {} }, { setItem() {}, getItem: () => null, removeItem() {} },
    location, (fn, ms) => { io.timers.push({ fn, ms }); return io.timers.length }, { replaceState() {} })
  $('#upPortal').textContent = 'Open the login page'
  await f.uplinkOpenPortal()
  const c = io.calls.find((x) => x.path === '/api/uplink/portal')
  ok(c && c.method === 'POST' && c.headers['X-Scorer-Pin'] === '2468', 'asks the board to open it, with the PIN')
  ok(io.assigned[0] === '/hall-login/', 'then goes to the page the board opened')
  ok(f.upBusy === true && $('#upPortal').disabled === true && $('#upPortal').textContent === 'Opening…', 'and keeps saying "Opening…" while the board fetches it — no springing back')
  ok(io.toasts.some((m) => /Opening the hall's login page/.test(m)), '...with a toast that says the board is fetching it')
  const late = io.timers.find((t) => t.ms >= 30000)
  ok(!!late, 'a watch for the page never coming')
  late.fn()
  ok(f.upBusy === false && $('#upPortal').textContent === 'Open the login page' && $('#upErr').hidden === false && /didn't open/.test($('#upErr').textContent),
    'still here long after: the button is back, with why')
  // A refusal never leaves the console.
  reply = () => ({ ok: true })
  io.assigned.length = 0
  await f.uplinkOpenPortal()
  ok(!io.assigned.length && f.upBusy === false && /could not open/.test($('#upErr').textContent), 'no page to go to: stays, button back, says so')
}

console.log(`\n${fail ? '❌' : '✅'} ov-online UI: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
