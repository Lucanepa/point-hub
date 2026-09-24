// The console's "Hall internet" card, asserted against web/index.html: the KWI hall's uplink is
// Swisscom's free Wi-Fi, a captive portal that wants an SMS login about once a day, and until this
// card the board being logged out was invisible — the scoreboard kept working and /live quietly
// stopped. What is pinned here: the card's wording for each state, the hall-time "until" line, the
// one-hour warning, the Game-tab banner that appears for a portal and nothing else, and above all
// that the phone number is typed, sent once and gone — not in SETTINGS, not in localStorage, not
// left in the field.
//
// No browser here (the layout was checked in headless Chrome at 1180x820, 844x390 and 800x1280),
// so the card's script is lifted out of the page whole and run against a tiny DOM, and the
// markup/CSS is asserted from source — a renamed function or id fails loudly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const index = fs.readFileSync(path.resolve(here, '..', 'web', 'index.html'), 'utf8')
const css = ((index.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '')
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
const markup = index.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '')
const tagOf = (id) => (markup.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [])[0] || ''

// The card's whole script: from its heading to the next section's.
const start = js.indexOf('// --- hall internet')
const end = js.indexOf('// --- settings ---', start)
const block = start >= 0 && end > start ? js.slice(start, end) : ''
if (!block) { console.log('❌ the hall-internet block is missing from the console script'); process.exit(1) }

// --- a tiny DOM: every id the block asks for, created on first use -------------------------
function el(id) {
  const cls = new Set()
  return {
    id, hidden: false, disabled: false, title: '', value: '', textContent: '', dataset: {}, listeners: {}, focused: 0, attrs: {},
    classList: { toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c) }, contains: (c) => cls.has(c),
      add: (c) => cls.add(c), remove: (...c) => c.forEach((x) => cls.delete(x)) },
    addEventListener(t, f) { this.listeners[t] = f },
    focus() { this.focused++ }, select() {}, scrollIntoView() {}, offsetWidth: 1,
    setAttribute(k, v) { this.attrs[k] = String(v) },
  }
}
const Zurich = (iso) => Date.parse(iso)

function page({ reply = {}, liveScoring = 'kscw' } = {}) {
  const nodes = {}
  const $ = (sel) => (nodes[sel] ||= el(sel))
  $('#tab-manual').classList.add('active')
  const io = { calls: [], toasts: [], statusRefreshed: 0, tabs: [], stored: [] }
  const api = async (p, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    io.calls.push({ path: p, method: (opts && opts.method) || 'GET', body, headers: (opts && opts.headers) || {}, signal: opts && opts.signal })
    const r = typeof reply[p] === 'function' ? reply[p](body) : reply[p]
    if (r instanceof Error) throw r
    return r
  }
  const LAST_STATUS = {}
  // Anything that writes to storage fails the privacy checks below.
  const localStorage = { setItem: (k, v) => io.stored.push([k, v]), getItem: () => null, removeItem() {} }
  const make = new Function('$', 'api', 'toast', 'SETTINGS', 'LAST_STATUS', 'goToTab', 'dismissKeyboard', 'refreshStatus',
    'setCard', 'diagOpen', 'deadline', 'SCORER_PIN', 'localStorage', 'sessionStorage',
    block + `
    return { uplinkUntil, uplinkSoon, uplinkView, renderUplink, renderUplinkBrief, refreshUplink, uplinkSendCode, uplinkLogIn,
      uplinkCheck, goToUplink,
      get UPLINK() { return UPLINK }, set UPLINK(v) { UPLINK = v }, get upStep() { return upStep } }`)
  const f = make($, api, (m, o) => io.toasts.push({ m, o }), { liveScoring }, LAST_STATUS, (t) => io.tabs.push(t), () => {},
    () => { io.statusRefreshed++ }, (card, lvl) => { card.level = lvl }, () => false, (ms) => ({ ms }), '1234',
    localStorage, localStorage)
  return { f, $, io, LAST_STATUS, nodes }
}

console.log('[1] the card, the banner and the fields are in the page')
{
  ok(/<fieldset id="uplinkCard"[^>]*>\s*<legend>[\s\S]*?Hall internet<\/legend>/.test(markup), 'Settings has a "Hall internet" card')
  ok(markup.indexOf('id="uplinkCard"') < markup.indexOf('data-set="blinkPoint"'), 'first in the grid — it is what a hall evening needs first')
  const phone = tagOf('upPhone')
  ok(/type="tel"/.test(phone) && /inputmode="tel"/.test(phone), 'the number field brings up the phone keypad')
  ok(/autocomplete="off"/.test(phone), 'and the browser is not asked to remember or offer a number')
  ok(/placeholder="079 123 45 67"/.test(phone), 'its placeholder shows the local format')
  ok(!/\bvalue=/.test(phone) && !/\bname=/.test(phone) && !/data-set/.test(phone), 'it starts empty, has no form name and is no setting')
  const code = tagOf('upCode')
  ok(/inputmode="numeric"/.test(code) && /autocomplete="one-time-code"/.test(code), 'the code field is a numeric keypad that can take the SMS code from the keyboard')
  ok(!/data-set/.test(code), 'and is no setting either')
  const card = (markup.match(/<fieldset id="uplinkCard"[\s\S]*?<\/fieldset>/) || [])[0] || ''
  ok(card && !/data-set/.test(card), 'nothing in the card has a data-set — no Save button, nothing to persist')
  ok(/id="upSend"[^>]*>Send code</.test(card) && /id="upLogin"[^>]*>Log in</.test(card), '"Send code", then "Log in"')
  ok(/<form id="upPhoneForm"[^>]*autocomplete="off"/.test(card), 'the number form itself opts out of autofill')
  ok(/is not saved on the board/.test(card), 'and the card says the number is not kept')
  const banner = tagOf('uplinkBanner')
  ok(/\bhidden\b/.test(banner) && /role="status"/.test(banner), 'the Game-tab banner is there, hidden until needed, and announced')
  ok(/Hall Wi-Fi needs a login<\/b> <span class="ubsub" id="ubSub">— live scoring is paused/.test(markup) && /id="ubLogin"[^>]*>Log in</.test(markup),
    'it reads "Hall Wi-Fi needs a login — live scoring is paused · Log in"')
  ok(markup.indexOf('id="uplinkBanner"') > markup.indexOf('id="tab-manual"') && markup.indexOf('id="uplinkBanner"') < markup.indexOf('id="tab-link"'),
    'and lives on the Game tab')
  ok(/id="dcUplink"/.test(markup) && /id="uplinkTag"/.test(markup), 'Diagnostics has a card and the header has a chip for it')
}

console.log('\n[2] every target is a finger\'s width, and the fields do not zoom iOS')
{
  ok(/\.uplink \.upbtn\{[^}]*min-height:var\(--tap\)/.test(css), 'card buttons ≥ 44px')
  ok(/\.uplink \.uprow input\{[^}]*min-height:var\(--tap\)/.test(css), 'fields ≥ 44px')
  ok(/\.uplink \.uprow input\{[^}]*font-size:16px/.test(css), 'fields at 16px (smaller makes iOS zoom the page in)')
  ok(/\.uplink \.uplink2\{[^}]*min-height:var\(--tap\)/.test(css), '"Use a different number" ≥ 44px')
  ok(/\.upbanner button\{[^}]*min-height:var\(--tap\);min-width:var\(--tap\)/.test(css), 'banner buttons ≥ 44px')
  ok(/\.uptag\{[^}]*min-height:var\(--tap\)/.test(css), 'header chip ≥ 44px')
  ok(/@media \(max-height:500px\)\{[\s\S]*?\.upbanner \.ubtext\{[^}]*white-space:nowrap/.test(css), 'on a phone held sideways the banner stays one line')
}

console.log('\n[3] "until" is said in hall time')
{
  const { f } = page()
  const now = Zurich('2026-09-24T10:00:00Z')                 // 12:00 in Zurich (CEST)
  ok(f.uplinkUntil('2026-09-24T15:30:00Z', now) === '17:30', 'later today → "17:30"')
  ok(f.uplinkUntil('2026-09-25T15:30:00Z', now) === 'tomorrow 17:30', 'tomorrow → "tomorrow 17:30"')
  ok(f.uplinkUntil('2026-09-26T15:30:00Z', now) === 'Sat 26.09. 17:30', 'further out → weekday and date')
  ok(f.uplinkUntil('2026-09-24T22:30:00Z', Zurich('2026-09-24T21:00:00Z')) === 'tomorrow 00:30', 'the day turns over at Zurich midnight, not UTC midnight')
  ok(f.uplinkUntil(null, now) === '' && f.uplinkUntil('nonsense', now) === '', 'no date → nothing, never "Invalid Date"')
}

console.log('\n[4] what the card says, state by state')
{
  const { f } = page()
  const now = Zurich('2026-09-24T10:00:00Z')
  let v = f.uplinkView({ status: 'online', validUntil: '2026-09-24T15:30:00Z', ssid: 'Free_WLAN_KTZH' }, now)
  ok(v.line === 'Online — logged in until 17:30' && v.state === 'online', 'online: "Online — logged in until 17:30"')
  // The board refuses a login while it is online (the portal only takes one once it has let go),
  // so the card offers none.
  ok(v.form === null && v.reveal === false, 'with no number field — there is nothing to log in to')
  v = f.uplinkView({ status: 'online', validUntil: '2026-09-24T10:45:00Z' }, now)
  ok(v.state === 'soon' && v.warn && /runs out at 12:45/.test(v.sub) && v.form === null, 'under an hour left: warned in gold, and told what will happen')
  ok(f.uplinkSoon({ status: 'online', validUntil: '2026-09-24T10:59:00Z' }, now) && !f.uplinkSoon({ status: 'online', validUntil: '2026-09-24T11:01:00Z' }, now),
    'the warning starts at 60 minutes')
  ok(!f.uplinkSoon({ status: 'online', validUntil: null }, now), 'online with no login to run out (another network) is never "soon"')
  v = f.uplinkView({ status: 'portal', ssid: 'Free_WLAN_KTZH', validUntil: null }, now)
  ok(v.line === 'Hall Wi-Fi Free_WLAN_KTZH needs a login' && v.form === 'phone', 'portal: "Hall Wi-Fi Free_WLAN_KTZH needs a login", number field open')
  ok(f.uplinkView({ status: 'portal', ssid: null }, now).line === 'Hall Wi-Fi needs a login', 'and without a network name, still a sentence')
  v = f.uplinkView({ status: 'offline' }, now)
  ok(v.line === 'No internet uplink' && v.form === null && v.reveal === true, 'offline: "No internet uplink", no field until "Log in by SMS" (the board looks again first)')
  ok(f.uplinkView({ status: 'checking' }, now).line === 'Checking the internet…', 'checking says so')
  ok(/Update the appliance/.test(f.uplinkView(false, now).sub), 'a board without the feature says so instead of spinning')
}

console.log('\n[5] the Game-tab banner is for a portal and nothing else')
{
  const { f, $, LAST_STATUS } = page()
  f.renderUplinkBrief({ status: 'portal', validUntil: null })
  ok($('#uplinkBanner').hidden === false, 'portal → banner')
  ok($('#uplinkTag').hidden === true, 'and no header chip on top of it while the Game tab is showing')
  for (const status of ['online', 'offline', 'checking']) {
    f.renderUplinkBrief({ status, validUntil: null })
    ok($('#uplinkBanner').hidden === true, `${status} → no banner`)
  }
  f.renderUplinkBrief(undefined)
  ok($('#uplinkBanner').hidden === true, 'an older board that reports nothing → no banner')
  // ✕ holds for this logout only.
  LAST_STATUS.uplink = { status: 'portal' }
  f.renderUplinkBrief(LAST_STATUS.uplink); $('#ubClose').listeners.click()
  ok($('#uplinkBanner').hidden === true && $('#uplinkTag').hidden === false, '✕ hides it, and the header chip takes over')
  f.renderUplinkBrief({ status: 'online' }); f.renderUplinkBrief({ status: 'portal' })
  ok($('#uplinkBanner').hidden === false, 'the next logout shows it again')
  const off = page({ liveScoring: 'off' })
  off.f.renderUplinkBrief({ status: 'portal' })
  ok(/no internet/.test(off.$('#ubSub').textContent), 'with live scoring off it does not claim live scoring is paused')
  const offCard = page({ liveScoring: 'off', reply: { '/api/uplink': { status: 'portal', portal: 'pwlan', ssid: 'Free_WLAN_KTZH', validUntil: null, loggedInAt: null, step: 'idle' } } })
  await offCard.f.refreshUplink()
  ok(/no internet/.test(offCard.$('#upSub').textContent) && !/paused/.test(offCard.$('#upSub').textContent), 'and the card says the same as the banner')
  // Header chip for a login about to run out.
  const soonAt = new Date(Date.now() + 20 * 60000).toISOString()
  f.renderUplinkBrief({ status: 'online', validUntil: soonAt })
  ok($('#uplinkTag').hidden === false && $('#uplinkTagPre').textContent === 'Wi-Fi until ' && /^(tomorrow )?\d\d:\d\d$/.test($('#uplinkTagTxt').textContent)
    && /runs out at/.test($('#uplinkTag').attrs['aria-label']), 'within the hour: "Wi-Fi until 17:30" in the header, said in full to a screen reader')
  ok($('#dcUplink').level === 'warn', 'and the Diagnostics card goes amber')
  f.renderUplinkBrief({ status: 'online', validUntil: new Date(Date.now() + 5 * 3600000).toISOString() })
  ok($('#uplinkTag').hidden === true && $('#dcUplink').level === '', 'hours left: header quiet, card normal')
  $('#uplinkTag').listeners.click()
}

console.log('\n[6] logging in: the number goes to the board once and is gone')
{
  const until = new Date(Date.now() + 3 * 3600000).toISOString()
  const { f, $, io } = page({ reply: {
    '/api/uplink': { status: 'portal', portal: 'pwlan', ssid: 'Free_WLAN_KTZH', validUntil: null, loggedInAt: null, step: 'idle' },
    '/api/uplink/login': { ok: true, step: 'code' },
    '/api/uplink/code': { ok: true, status: 'online', validUntil: until },
  } })
  await f.refreshUplink()
  ok($('#upPhoneForm').hidden === false && $('#upCodeForm').hidden === true, 'portal: the number step is showing')
  ok($('#upPhone').value === '', 'with the field empty')
  $('#upPhone').value = 'abc'
  await f.uplinkSendCode({ preventDefault() {} })
  ok(!io.calls.some((c) => c.path === '/api/uplink/login') && !$('#upErr').hidden, 'something that is not a number is caught here, with a reason')
  $('#upPhone').value = '079 123 45 67'
  await f.uplinkSendCode({ preventDefault() {} })
  const login = io.calls.find((c) => c.path === '/api/uplink/login')
  ok(login && login.method === 'POST' && login.body.phone === '079 123 45 67', 'POST /api/uplink/login {phone}')
  ok(login && Number.isFinite(login.body.epochMs), 'with the tablet\'s clock, for a board whose clock the portal\'s certificate refuses')
  ok(login && login.headers['X-Scorer-Pin'] === '1234', 'PIN-gated like every other write')
  ok(login && login.signal && login.signal.ms > 8000, 'with a deadline long enough for the board to walk the portal\'s redirects')
  ok($('#upPhone').value === '', 'the number is cleared from the field as soon as the board has it')
  ok($('#upPhoneForm').hidden === true && $('#upCodeForm').hidden === false, 'and the code step is showing')
  ok($('#upCode').focused > 0, 'with the cursor already in the code box')
  $('#upCode').value = '12 34 56'
  await f.uplinkLogIn({ preventDefault() {} })
  const code = io.calls.find((c) => c.path === '/api/uplink/code')
  ok(code && code.body.code === '123456' && code.headers['X-Scorer-Pin'] === '1234', 'POST /api/uplink/code {code}, spaces dropped')
  ok(io.toasts.some((t) => /^Online until \d\d:\d\d$|^Online until tomorrow \d\d:\d\d$/.test(t.m)), 'a toast: "Online until 17:30"')
  ok($('#upCode').value === '' && $('#upPhone').value === '', 'both fields empty afterwards')
  ok(io.statusRefreshed > 0, 'and the header is re-read at once')
  ok(io.stored.length === 0, 'nothing was written to localStorage or sessionStorage on the way')
  const everyBody = JSON.stringify(io.calls.filter((c) => c.path !== '/api/uplink/login').map((c) => c.body))
  ok(!/079|791234567/.test(everyBody), 'and the number went to no other request')
}

console.log('\n[7] refusals come back in words')
{
  const { f, $, io } = page({ reply: {
    '/api/uplink': { status: 'portal', ssid: null, validUntil: null, step: 'code' },
    '/api/uplink/code': { ok: false, error: 'That code was not accepted — check the SMS and try again' },
    '/api/uplink/login': Object.assign(new Error('The number was refused — use the international format, e.g. +41 79 …'), { status: 400 }),
  } })
  await f.refreshUplink()
  ok($('#upCodeForm').hidden === false, 'a login the board is already holding (tablet reloaded mid-way) opens on the code step')
  $('#upCode').value = '000000'
  await f.uplinkLogIn({ preventDefault() {} })
  ok(!$('#upErr').hidden && /code was not accepted/.test($('#upErr').textContent), '{ok:false, error} is shown as the board worded it')
  ok($('#upCodeForm').hidden === false, 'and the code step stays, to try again')
  $('#upRestart').listeners.click()
  ok($('#upPhoneForm').hidden === false && $('#upCodeForm').hidden === true, '"Use a different number" goes back to the number')
  $('#upPhone').value = '+41 79 123 45 67'
  await f.uplinkSendCode({ preventDefault() {} })
  ok(/international format/.test($('#upErr').textContent), 'an HTTP refusal is shown in its own words too')
  ok($('#upPhoneForm').hidden === false, 'and the number step stays')
  const slow = page({ reply: { '/api/uplink/login': Object.assign(new Error("The board didn't answer in time — try again."), {}) } })
  slow.$('#upPhone').value = '0791234567'
  await slow.f.uplinkSendCode({ preventDefault() {} })
  ok(/login page didn't answer/.test(slow.$('#upErr').textContent), 'a timeout blames the login page, not the board')
  const locked = page({ reply: { '/api/uplink/check': Object.assign(new Error('PIN required'), { status: 403 }) } })
  await locked.f.uplinkCheck()
  ok(/Unlock scoring first/.test(locked.$('#upErr').textContent), 'a locked tablet is told to unlock')
  const old = page({ reply: { '/api/uplink': Object.assign(new Error('/api/uplink → 404'), { status: 404 }) } })
  await old.f.refreshUplink()
  ok(old.f.UPLINK === false && old.$('#upPhoneForm').hidden && old.$('#upCheck').hidden, 'a board without the routes: no form, no button, just a note')
  // The board's 10-minute session ran out under a tablet sitting on the code step.
  const exp = page({ reply: { '/api/uplink/login': { ok: true, step: 'code' }, '/api/uplink': { status: 'portal', step: 'idle' } } })
  exp.$('#upPhone').value = '0791234567'
  await exp.f.uplinkSendCode({ preventDefault() {} })
  await exp.f.refreshUplink()
  ok(/timed out/.test(exp.$('#upErr').textContent) && exp.$('#upPhoneForm').hidden === false, 'a login the board dropped says so and goes back to the number')
  // The portal took the code but the internet is not through yet: the board has ended the login.
  const late = page({ reply: {
    '/api/uplink': { status: 'portal', step: 'code' },
    '/api/uplink/code': { ok: false, error: 'Logged in, but the internet does not answer yet — tap Check again in a minute',
      validUntil: '2026-09-25T15:30:00Z', uplink: { status: 'portal', step: 'idle', validUntil: '2026-09-25T15:30:00Z' } },
  } })
  await late.f.refreshUplink()
  late.$('#upCode').value = '123456'
  await late.f.uplinkLogIn({ preventDefault() {} })
  ok(/Check again in a minute/.test(late.$('#upErr').textContent) && late.$('#upCodeForm').hidden === true,
    'the board\'s own view in the reply ends the code step when the board has ended it')
  ok(late.$('#upCode').value === '', 'and the used code is not left in the box')
  // Refused because the board is in fact online: the reply's view puts the card right.
  const already = page({ reply: {
    '/api/uplink/login': { ok: false, error: 'The hall internet already works — no login needed', uplink: { status: 'online', step: 'idle', validUntil: null } },
  } })
  already.f.UPLINK = { status: 'offline', step: 'idle' }
  already.$('#upReveal').listeners.click()
  already.$('#upPhone').value = '0791234567'
  await already.f.uplinkSendCode({ preventDefault() {} })
  ok(already.$('#upStatTxt').textContent === 'Online — the board has internet' && already.$('#upPhoneForm').hidden === true, 'a login refused as unneeded shows the board online')
  ok(already.$('#upPhone').value === '', 'and the number field that went away took the number with it')
  void io
}

console.log('\n[8] the rest of the console is wired to it')
{
  ok(/renderPrematch\(st\);\s*\n\s*renderUplinkBrief\(st\.uplink\);/.test(js), 'every status poll updates the banner / header / Diagnostics')
  ok(/b\.dataset\.tab === "settings" \|\| b\.dataset\.tab === "diag"\) refreshUplink\(\)/.test(js), 'opening Settings or Diagnostics reads the full state')
  ok(/\$\("#ubLogin"\)\.addEventListener\("click", goToUplink\)/.test(js), 'the banner\'s "Log in" goes straight to the card')
  ok(!/localStorage\.setItem\([^)]*(phone|Phone|upPhone)/.test(js) && !/sessionStorage/.test(block), 'no storage call anywhere near the number')
  ok(!/reportUi\(/.test(block), 'and the card reports nothing to the board log itself')
  // The phone field must never be picked up by the settings save (setEls is every [data-set]).
  ok(/const setEls = \(\) => \$\$\("\[data-set\]"\)/.test(js), 'settings still save [data-set] fields only — which the card has none of')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
