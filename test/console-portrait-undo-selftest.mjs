// The console's four bigger changes from the 2026-09-23 UI review: a real portrait layout instead
// of the "Rotate to landscape" wall, an offline state that shows at once and says which tap did not
// count, a general Undo, and a header you can read at a glance (plus basketball's period moved to
// the centre).
//
// Same method as ui-quickfix-selftest: layout is asserted against the CSS source, and the logic that
// decides what the scorer sees — the offline marking, the sticky toast, the Undo button, what an
// undo does to a running interval — is lifted out of the page by name and run against stubs.

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
  if (at < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`${name} is unbalanced`)
}
function mediaBlock(src, header) {
  const at = src.indexOf(header)
  if (at < 0) return ''
  let i = src.indexOf('{', at), depth = 0
  for (const start = i; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return ''
}
// A class list that behaves enough like the DOM's.
const classes = (...init) => {
  const set = new Set(init)
  return { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => { const v = on === undefined ? !set.has(c) : !!on; v ? set.add(c) : set.delete(c); return v },
    contains: (c) => set.has(c) }
}
const el = (extra = {}) => ({ textContent: '', hidden: false, disabled: false, title: '', attrs: {}, classList: classes(),
  setAttribute(k, v) { this.attrs[k] = v }, isConnected: true, ...extra })

console.log('[1] portrait is a layout, not a wall')
{
  const portrait = mediaBlock(css, '@media (orientation:portrait) and (max-width:600px){\n    #rotate')
  ok(!!portrait, 'the portrait tip has its own block')
  ok(!/#rotate\{[^}]*position:fixed/.test(portrait) && !/#rotate\{[^}]*inset:0/.test(portrait),
    '#rotate no longer covers the whole screen (it hid the console, the offline banner and every countdown)')
  ok(/body\.rotate-ok #rotate\{display:none\}/.test(portrait), 'the tip can be dismissed')
  ok(/localStorage\.setItem\("rotateTipOk", "1"\)/.test(js) && /getItem\("rotateTipOk"\)/.test(js), 'and stays dismissed on this device')
  const layout = mediaBlock(css, '@media (orientation:portrait) and (max-width:600px){\n    .topbar')
  ok(!!layout, 'there is a portrait layout for phones')
  ok(/\.board\{display:flex;flex-direction:column/.test(layout), 'the team cards stack')
  ok(/\.sv-arrow \.licon\{transform:rotate\(90deg\)\}/.test(layout), 'the serve arrows point up/down, at the cards they mean')
  ok(/\.score\.bball\{display:grid/.test(layout), 'basketball keeps −1, the total and +1/+2/+3 on one row')
  ok(/\.game\{[^}]*overflow-y:auto/.test(layout), 'a shorter phone scrolls rather than cutting controls off')
  ok(/\.topbar \.hdricon\{display:inline-flex\}/.test(layout) && /class="iconbtn hdricon js-awake"/.test(index) && /class="iconbtn hdricon js-fs"/.test(index),
    'keep-awake and full screen stay reachable (header copies, synced as a set)')
  ok(/lock\(portrait \? "portrait" : "landscape"\)/.test(js), 'full screen locks the orientation in use instead of forcing landscape')
}

console.log('\n[2] offline shows at once, over the header, and greys the scoring controls')
{
  ok(/#offline\{position:fixed;top:0/.test(css), 'the banner is an overlay — it no longer pushes the scoreboard down mid-rally')
  ok(/body\.offline #tab-manual \.board,body\.offline #tab-manual \.gfooter\{filter:grayscale\(1\)/.test(css), 'body.offline greys the scoring controls')
  ok(/body\.offline #tab-manual::after\{content:"Not sent — board unreachable"/.test(css), 'and says in words that taps are not getting through')
  const rs = lift(js, 'refreshStatus')
  ok(!/pollFails >= 2/.test(rs) && /showFrozen\(\)/.test(rs), 'the FIRST failed poll shows it (it used to wait for two)')
  ok(/setOffline\(true\)/.test(lift(js, 'showFrozen')), 'showFrozen puts the body in the offline state')
  ok(/setOffline\(false\)/.test(lift(js, 'renderStatus')), 'and any good poll takes it back out, with no reload')

  // notSent / markSent against stubs.
  const toasts = []
  let frozen = 0
  const body = { classList: classes() }
  const btn = el()
  const els = {}
  const $$ = (s) => (s === '.notsent' ? [btn].filter((b) => b.classList.contains('notsent')) : [])
  const mk = new Function('toast', 'showFrozen', 'clearStickyToast', 'setOffline', '$$',
    lift(js, 'notSent') + '\n' + lift(js, 'markSent') + '\nreturn { notSent, markSent };')
  let cleared = 0
  const t = mk((m, o) => toasts.push({ m, o }), () => { frozen++; body.classList.add('offline') }, () => { cleared++ },
    (on) => body.classList.toggle('offline', on), $$)
  t.notSent(new Error('The board didn\'t answer in time — try again.'), btn)
  ok(btn.classList.contains('notsent'), 'a failed write rings the control that was tapped')
  ok(frozen === 1 && body.classList.contains('offline'), 'no reply at all = offline straight away')
  const last = toasts.pop()
  ok(last.o && last.o.sticky && /^Not sent — board unreachable/.test(last.m), `with a sticky toast ("${last.m}")`)
  ok(!/try again/i.test(last.m), 'which does not invite a blind re-tap (a timed-out write may still have landed)')
  t.markSent()
  ok(!btn.classList.contains('notsent') && !body.classList.contains('offline') && cleared === 1,
    'the next write that gets through clears the ring, the offline state and the sticky toast')
  const err400 = Object.assign(new Error('bad value'), { status: 400 })
  t.notSent(err400, btn)
  ok(frozen === 1 && toasts.pop().o.sticky, 'a refusal (the board answered) is not treated as offline, but still stays up')
  const err403 = Object.assign(new Error('PIN required'), { status: 403 })
  t.notSent(err403, el())
  ok(!toasts.pop().o, 'a PIN refusal is a plain toast — the PIN pad is already open')
  const sa = lift(js, 'sendAction')
  ok(/markSent\(\)/.test(sa) && /notSent\(e, btn\)/.test(sa), 'sendAction wires both in')
}

console.log('\n[3] a sticky toast survives an ordinary one')
{
  // Minimal DOM for #toast.
  const mkEl = () => {
    const e = { children: [], classList: classes(), _text: '', attrs: {}, listeners: {},
      append(...k) { this.children.push(...k) }, setAttribute(k, v) { this.attrs[k] = v },
      addEventListener(t, f) { this.listeners[t] = f },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join('') },
      set textContent(v) { this._text = v; this.children = [] } }
    return e
  }
  const t = mkEl()
  const timers = []
  const fake = { setTimeout: (f) => { timers.push(f); return timers.length }, clearTimeout: () => {} }
  const api = new Function('$', 'document', 'setTimeout', 'clearTimeout',
    'let toastTimer, stickyToast = null;\n' + lift(js, 'toast') + '\n' + lift(js, 'hideToast') + '\n' + lift(js, 'clearStickyToast') +
    '\nreturn { toast, hideToast, clearStickyToast, get sticky() { return stickyToast } };')(
    () => t, { createElement: mkEl }, fake.setTimeout, fake.clearTimeout)
  api.toast('Not sent — board unreachable.', { sticky: true })
  ok(t.classList.contains('show') && t.classList.contains('bad') && t.classList.contains('interactive'), 'the sticky toast is up, red, and takes taps (its ✕)')
  const n = timers.length
  api.toast('Screen will stay awake')
  ok(/Screen will stay awake/.test(t.textContent), 'an ordinary note can show over it')
  timers[timers.length - 1]()          // the note's own timeout
  timers[timers.length - 1]()          // the restore
  ok(/Not sent/.test(t.textContent) && t.classList.contains('show') && timers.length > n, 'and the unresolved failure comes back after it')
  api.clearStickyToast()
  ok(api.sticky === null && !t.classList.contains('show'), 'clearing it takes it down for good')
  let undone = 0
  api.toast('Timeout · KSCW', { action: { label: 'Undo', fn: () => { undone++ } } })
  const b = t.children.find((c) => c._text === 'Undo')
  ok(!!b && t.classList.contains('interactive'), 'an action toast carries its button')
  b.listeners.click()
  ok(undone === 1 && !t.classList.contains('show'), 'which runs the action and closes the toast')
}

console.log('\n[4] Undo: the button, and what an undo does to the screens around it')
{
  const b = el(), label = el()
  const renderUndo = new Function('$', lift(js, 'renderUndo') + '\nreturn renderUndo;')((s) => (s === '#undoBtn' ? b : label))
  renderUndo({ canUndo: true, undoLabel: 'Point KSCW' })
  ok(!b.disabled && label.textContent === 'Point KSCW' && /Undo: Point KSCW/.test(b.title), 'enabled and labelled with what it will take back')
  renderUndo({ canUndo: false, undoLabel: 'stale' })
  ok(b.disabled && label.textContent === '', 'disabled, with no label, when there is nothing to undo')
  renderUndo({})
  ok(b.disabled, 'and disabled against a board that does not report canUndo at all')
  ok(/<button id="undoBtn" type="button" disabled/.test(index), 'it starts disabled')
  ok(/<div class="striprow">\s*<div id="setStrip"[\s\S]{0,400}<button id="undoBtn"/.test(index), 'and sits beside the set strip')
  const sa = lift(js, 'sendAction')
  ok(/"canUndo" in r[\s\S]{0,120}patch\.undoLabel = r\.undoLabel/.test(sa), 'every action reply updates it, not only the next poll')
  ok(/renderUndo\(LAST_STATUS\)/.test(sa), 'the round trip does not leave it enabled when the journal is empty')

  const num = (x) => Number(x) || 0
  const setIsClosed = new Function('num', lift(js, 'setIsClosed') + '\nreturn setIsClosed;')(num)
  ok(setIsClosed({ points_a: 25, points_b: 20, set_results: [{ a: 25, b: 20 }] }), 'a set whose final score is still showing is closed')
  ok(!setIsClosed({ points_a: 0, points_b: 0, set_results: [{ a: 25, b: 20 }] }), 'the next set at 0–0 is not')
  ok(!setIsClosed({ points_a: 0, points_b: 0, set_results: [{ a: 0, b: 0 }] }), 'nor is a 0–0 placeholder')

  // afterUndo against stubs.
  const run = ({ closed, cd = { hidden: true, label: '' }, mode = 'match', cdLabel = '', asked = '', over = false, meOpen = false, SPORT = 'volleyball' }) => {
    const calls = []
    const els = { '#cd': { hidden: cd.hidden }, '#cdLabel': { textContent: cd.label }, '#matchEnd': { hidden: !meOpen } }
    const board = { mode, cd: mode === 'countdown' ? { label: cdLabel } : null }
    const f = new Function('toast', '$', 'board', 'SPORT', 'setIsClosed', 'clearCountdown', 'stopServerCountdown', 'showSetEndPrompt',
      'matchOver', 'closeMatchEnd', 'undoAsked', lift(js, 'afterUndo') + '\nreturn afterUndo;')(
      (m) => calls.push('toast:' + m), (s) => els[s], board, SPORT, () => closed,
      () => { calls.push('clear'); els['#cd'].hidden = true }, (x) => calls.push('stop:' + x), () => calls.push('setEnded'),
      () => over, () => calls.push('closeMatchEnd'), asked)
    f({})
    return calls
  }
  let c = run({ closed: true, cd: { hidden: false, label: 'INTERVAL' }, mode: 'countdown', cdLabel: 'INTERVAL', asked: 'Next set' })
  ok(c.includes('toast:Undone: Next set'), 'it says what was undone')
  ok(c.includes('clear') && c.includes('stop:false') && c.includes('setEnded'),
    'undoing "Start interval" stops the interval clock (on the panel too) and brings back SET ENDED')
  c = run({ closed: false, cd: { hidden: false, label: 'SET ENDED' }, asked: 'Point KSCW' })
  ok(c.includes('clear') && !c.includes('setEnded'), 'undoing the set-winning point takes SET ENDED down (the set is open again)')
  c = run({ closed: false, cd: { hidden: false, label: 'TO KSCW' }, mode: 'countdown', cdLabel: 'TIME OUT', asked: 'Timeout KSCW' })
  ok(c.includes('clear') && c.includes('stop:false'), 'undoing a timeout stops its clock')
  c = run({ closed: false, cd: { hidden: false, label: 'TO KSCW' }, mode: 'countdown', cdLabel: 'TIME OUT', asked: 'Point KSCW' })
  ok(!c.includes('clear'), 'undoing something else leaves a running timeout alone')
  c = run({ closed: false, over: false, meOpen: true, asked: 'Point KSCW' })
  ok(c.includes('closeMatchEnd'), 'undoing the match point closes the result dialog')
  c = run({ closed: true, SPORT: 'basketball', asked: 'End period' })
  ok(!c.includes('setEnded'), 'basketball has no set interval to put back')

  const he = lift(js, 'handleEvent')
  ok(/event === "undo-empty"\) \{ toast\("Nothing to undo"\)/.test(he), '"undo-empty" says there is nothing to undo')
  ok(/event === "undo"\) \{ afterUndo\(s\)/.test(he), '"undo" goes through afterUndo')
}

console.log('\n[5] timeouts and subs: straight through, with Undo — confirms kept for destructive actions')
{
  const side = js.slice(js.indexOf('// per-side controls'), js.indexOf('// serve toggle'))
  const stat = side.slice(side.indexOf('querySelectorAll("[data-stat]")'))
  ok(!/askConfirm/.test(stat), 'no "Add a timeout for X?" confirm before a T/O or sub')
  ok(/action: \{ label: "Undo"/.test(stat), 'an Undo toast after it instead')
  ok(/String\(LAST_STATUS\.undoLabel \|\| ""\) !== step/.test(stat), 'which only undoes THAT step, never whatever came after it')
  ok(/if \(!r\) \{[\s\S]{0,200}clearCountdown\(\)/.test(stat), 'a timeout that never reached the board does not leave its clock running')
  const reset = js.slice(js.indexOf('$("#resetBtn").addEventListener'), js.indexOf('$("#refreshBtn")'))
  ok(/askConfirm\(resetWarning\(\)/.test(reset), 'Reset still confirms')
  ok(/savedGame && !await askConfirm\("Start a new game\?/.test(js), 'and so does New game over a saved match')
}

console.log('\n[6] the header reads at a glance')
{
  ok(/<span id="modeTag" hidden>/.test(index), 'the mode tag starts hidden')
  const rs = lift(js, 'renderStatus')
  ok(/const linked = !!st\.mode && !\["manual", "idle"\]\.includes\(st\.mode\)/.test(rs) && /\$\("#modeTag"\)\.hidden = !linked/.test(rs),
    'and shows only for a linked match ("Mode Manual" said nothing)')
  ok(Number((css.match(/#setNo\{[^}]*font-size:(\d+)px/) || [])[1]) >= 18, 'the set / period chip is at least 18px')
  const dot = el(), ic = el(), txt = el()
  dot.classList = classes()
  const setDot = new Function('$', 'IC', lift(js, 'setDot') + '\nreturn setDot;')(
    (s) => ({ '#dot': dot, '#dotIc': ic, '#dotTxt': txt })[s], { wifiOn: 'on', wifiOff: 'off' })
  setDot(true, 'LedBox connected')
  ok(txt.textContent === 'Board ✓' && dot.classList.contains('ok'), 'connected reads "Board ✓"')
  setDot(false, 'LedBox not connected')
  ok(txt.textContent === 'Board ✗' && dot.classList.contains('bad') && ic.innerHTML === 'off', 'and not connected "Board ✗", in red, beside the icon')
}

console.log('\n[7] basketball: the period lives in the centre beside POSS.')
{
  ok(/basketball: \{ serveLabel: "POSS\.",[^\n]*show: \{[^}]*\bset: false/.test(js), 'no per-team Period tile (it showed one shared value twice)')
  const centre = index.slice(index.indexOf('<div class="centercol">'), index.indexOf('<div class="side right"'))
  ok(/id="periodBox"/.test(centre) && /data-period="-1"/.test(centre) && /data-period="1"/.test(centre), 'a single −/+ period control sits in the centre column')
  ok(/\$\("#periodBox"\); if \(pb\) pb\.hidden = SPORT !== "basketball"/.test(lift(js, 'applySportUI')), 'shown for basketball only')
  ok(/\$\$\("\[data-period\]"\)[\s\S]{0,160}sendAction\(\{ type: "set", side: "left", delta: Number\(b\.dataset\.period\) \}, b\)/.test(js), 'and sends the same `set` action the tiles did')
  ok(/#periodVal/.test(lift(js, 'renderBoard')), 'the readout follows the state (Q1…, OT1, FINAL)')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
