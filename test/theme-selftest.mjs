// The console's colour themes — light (the default), dark, and e-ink (greyscale, for a phone
// courtside in full sun) — asserted against web/index.html and web/logs.html:
//
//   [1] the boot script comes first and applies the stored choice before anything is painted
//   [2] every colour token light defines, dark and e-ink define too; e-ink's are all greys
//   [3] the console script is still the page's bare <script>, the one the other UI selftests read
//   [4] Settings ▸ Theme: three buttons, no Save, wired to the boot script
//   [5] e-ink tells the teams apart by fill, worked out from the team colours
//   [6] dark lifts a team colour used as text until it reads on the dark card
//   [7] /logs follows the same choice
//
// No browser here (the looks were checked in headless Chrome at 390x844 and 1280x800 against a MOCK
// board), so the scripts run against stubs and the stylesheet is read as text.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const index = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
const logs = fs.readFileSync(path.join(root, 'web', 'logs.html'), 'utf8')
const boot = (index.match(/<script id="themeBoot">([\s\S]*?)<\/script>/) || [])[1] || ''
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
const css = ((index.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '')

function lift(src, name) {
  const at = src.search(new RegExp(`function ${name}\\(`))
  if (at < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`${name} is unbalanced`)
}
const body = (name) => { try { return lift(js, name) } catch { return '' } }

// A page as far as the boot script can see it: the root element, a theme-color meta, storage.
function page(src, stored, { throws = false } = {}) {
  const attrs = new Map()
  const meta = { content: '#ffffff', setAttribute(k, v) { if (k === 'content') this.content = v } }
  const listeners = { storage: [], DOMContentLoaded: [] }
  const store = new Map(stored == null ? [] : [['theme', stored]])
  const ctx = {
    document: {
      documentElement: {
        setAttribute: (k, v) => attrs.set(k, String(v)),
        removeAttribute: (k) => attrs.delete(k),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      },
      querySelector: (sel) => (/theme-color/.test(sel) ? meta : null),
      addEventListener: (type, fn) => (listeners[type] || []).push(fn),
    },
    localStorage: {
      getItem: (k) => { if (throws) throw new Error('blocked'); return store.has(k) ? store.get(k) : null },
      setItem: (k, v) => { if (throws) throw new Error('blocked'); store.set(k, String(v)) },
    },
    addEventListener: (type, fn) => (listeners[type] || []).push(fn),
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return {
    theme: () => attrs.get('data-theme') || null,
    meta, store, ctx,
    fire: (type, ev = {}) => (listeners[type] || []).forEach((fn) => fn(ev)),
  }
}

console.log('[1] the boot script runs first and applies the stored choice')
{
  ok(!!boot, 'there is a <script id="themeBoot">')
  const first = index.search(/<script[\s>]/)
  ok(first === index.indexOf('<script id="themeBoot">'), 'it is the first script on the page')
  ok(first < index.indexOf('<style>') && first < index.indexOf('<meta name="viewport"'), 'ahead of the stylesheet and of every other head tag but the charset')
  for (const [stored, want] of [[null, null], ['light', null], ['dark', 'dark'], ['eink', 'eink'], ['neon', null]]) {
    ok(page(boot, stored).theme() === want, `localStorage.theme = ${JSON.stringify(stored)} → data-theme ${want || 'absent (light)'}`)
  }
  ok(page(boot, 'dark', { throws: true }).theme() === null, 'blocked storage is light, not a crash')
  const p = page(boot, 'dark')
  p.fire('DOMContentLoaded')
  const darkBg = (css.match(/:root\[data-theme="dark"\]\{[^}]*--bg:(#[0-9a-f]{6})/i) || [])[1]
  ok(p.meta.content === darkBg, `the browser bar takes the dark ground (${p.meta.content})`)
  p.store.set('theme', 'eink'); p.fire('storage', { key: 'theme' })
  ok(p.theme() === 'eink' && p.meta.content === '#ffffff', 'a change made in another tab is followed, bar included')
  p.store.set('theme', 'dark'); p.fire('storage', { key: 'unrelated' })
  ok(p.theme() === 'eink', 'and another key changing is not mistaken for it')
  ok(p.ctx.phTheme.set('dark') === 'dark' && p.store.get('theme') === 'dark' && p.theme() === 'dark', 'phTheme.set stores and applies')
  ok(p.ctx.phTheme.set('neon') === 'light' && p.store.get('theme') === 'light' && p.theme() === null, 'and turns anything unknown into light')
  ok(/<meta name="theme-color" content="#ffffff">/.test(index), 'the static theme-color stays light (it is what the manifest matches)')
}

console.log('\n[2] every colour token, in every theme')
{
  const block = (sel) => (css.match(new RegExp(sel.replace(/[[\]"]/g, '\\$&') + '\\{([^}]*)\\}')) || [])[1] || ''
  const tokens = (b) => new Map([...b.matchAll(/--([\w-]+):\s*([^;]+);?/g)].map((m) => [m[1], m[2].trim()]))
  const light = tokens(block(':root'))
  const colour = (v) => /^(#[0-9a-f]{3,8}|rgba?\()/i.test(v)
  const names = [...light].filter(([, v]) => colour(v)).map(([k]) => k)
  ok(names.length >= 15, `light defines its colours as tokens (${names.join(' ')})`)
  for (const theme of ['dark', 'eink']) {
    const t = tokens(block(`:root[data-theme="${theme}"]`))
    const missing = names.filter((k) => !t.has(k) && !['left', 'right'].includes(k))
    ok(missing.length === 0, `${theme} sets every one of them${missing.length ? ` — missing ${missing.join(' ')}` : ''}`)
  }
  const eink = tokens(block(':root[data-theme="eink"]'))
  const grey = (v) => {
    const h = /#([0-9a-f]{6})/i.exec(v); if (h) { const [r, g, b] = [0, 2, 4].map((i) => h[1].slice(i, i + 2)); return r === g && g === b }
    const c = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v); return !!c && c[1] === c[2] && c[2] === c[3]
  }
  const hued = [...eink].filter(([, v]) => colour(v) && !grey(v)).map(([k]) => k)
  ok(hued.length === 0, `e-ink is greys only${hued.length ? ` — not ${hued.join(' ')}` : ''}`)
  ok(eink.get('bg') === '#ffffff' && eink.get('fg') === '#000000' && eink.get('line') === '#000000', 'paper white, ink black, black lines')
  ok(['left', 'right', 'left-ink', 'right-ink'].every((k) => /!important/.test(eink.get(k) || '')),
    'the team colours the script paints inline are overridden in e-ink (!important beats inline)')
  // Ink on an accent fill was a literal white, which in dark sat on a light accent. Only the LED
  // mirror (its own look in every theme) keeps a literal white text colour.
  const literal = [...css.matchAll(/([^{}]+)\{[^}]*color:#fff[;}]/g)].map((m) => m[1].trim()).filter((s) => !/^\.bv/.test(s))
  ok(literal.length === 0, `no accent fill keeps a literal white ink${literal.length ? ` — ${literal.join(', ')}` : ''}`)
  ok(!/rgba\(15,17,22,\.32\)\}/.test(css.replace(/:root\{[^}]*\}/, '')), 'the dialog washes come from --scrim')
  ok(/:root\[data-theme="eink"\] \*,[^{]*\{[^}]*box-shadow:none!important[^}]*animation:none!important[^}]*transition:none!important/.test(css),
    'e-ink has no shadows and no motion')
  ok(!/addEventListener\(["'](transitionend|animationend)/.test(js), 'and nothing in the console waits for one to end')
}

console.log('\n[3] the console script is still the bare <script>')
{
  ok(/function renderBoard\(/.test(js) && /function syncThemePick\(/.test(js), 'the selftests\' /<script>/ still finds the console, not the boot script')
}

console.log('\n[4] Settings ▸ Theme')
{
  const card = (index.match(/<fieldset id="themeCard">[\s\S]*?<\/fieldset>/) || [])[0] || ''
  const picks = [...card.matchAll(/data-theme-pick="(\w+)"/g)].map((m) => m[1])
  ok(picks.join() === 'light,dark,eink', `three buttons: ${picks.join(' / ')}`)
  ok(/>Light</.test(card) && />Dark</.test(card) && />E-ink</.test(card), 'labelled Light, Dark, E-ink')
  ok(!/data-set=/.test(card), 'no data-set, so the card gets no Save button — it applies on the tap')
  ok(/aria-pressed/.test(card) && /b\.setAttribute\("aria-pressed"/.test(body('syncThemePick')), 'the chosen one is pressed, for a screen reader too')
  ok(/getAttribute\("data-theme"\)/.test(body('syncThemePick')), 'it reads what is applied, so it is right with storage blocked')
  ok(/window\.phTheme\.set\(b\.dataset\.themePick\)/.test(js), 'a tap goes through the boot script\'s setter')
  ok(/addEventListener\("storage", \(e\) => \{ if \(e\.key === "theme"/.test(js), 'and a change from another tab moves the buttons')
}

console.log('\n[5] e-ink tells the teams apart by fill')
{
  const make = new Function('panelSide', lift(js, 'hexLum') + '\n' + lift(js, 'toneOf') + '\nreturn { hexLum, toneOf };')
  const front = make((s) => s)
  const behind = make((s) => (s === 'left' ? 'right' : 'left'))
  const s = { left: { color: '#0A34D6' }, right: { color: '#E0301A' } }
  ok(front.toneOf('left', s) === 'ink' && front.toneOf('right', s) === 'paper', 'the darker team colour gets the ink card, the other the paper one')
  const swapped = { left: s.right, right: s.left }
  ok(front.toneOf('left', swapped) === 'paper' && front.toneOf('right', swapped) === 'ink', 'and keeps it when the teams change ends')
  ok(behind.toneOf('left', s) === 'paper' && behind.toneOf('right', s) === 'ink', 'scorer behind the board: the card shows its own team\'s tone')
  const same = { left: { color: '#2563eb' }, right: { color: '#2563eb' } }
  ok(front.toneOf('left', same) === 'ink' && front.toneOf('right', same) === 'paper', 'equal colours still give one of each')
  ok(front.toneOf('left', null) === 'ink' && front.toneOf('right', null) === 'paper', 'and so does no state at all')
  ok(front.toneOf('left', { left: { color: 'red' }, right: s.right }) === 'ink', 'an unreadable colour falls back instead of throwing')
  ok(/root\.dataset\.tone = toneOf\(side, s\)/.test(body('renderBoard')), 'renderBoard sets it on each card')
  ok(/\.side\[data-tone="ink"\]\{--edge:#000000!important;--on-edge:#ffffff!important\}/.test(css)
    && /\.side\[data-tone="paper"\]\{--edge:#ffffff!important;--on-edge:#000000!important\}/.test(css), 'and the e-ink sheet paints the two cards from it')
  ok(/v1\.classList\.toggle\("on", serving === "left"\)/.test(body('renderPreview')) && /\.bvrect\.on\{background:#000000!important\}/.test(css),
    'the mirror\'s serving bar is a class too, so e-ink can ink it')
  ok(/\.stat\.warn\{border:2px dashed/.test(css) && /\.stat\.maxed\{background:var\(--on-edge\)/.test(css), 'a limit is a dashed tile, then an inverted one — not amber, then red')
  ok(/\.nav button\.active,\.segbtns button\.on/.test(css), 'the open tab and a chosen segment are inked, not just blue')
}

console.log('\n[6] dark: a team colour as text reads on the dark card')
{
  let theme = null
  const document = { documentElement: { getAttribute: () => theme } }
  const getComputedStyle = () => ({ getPropertyValue: () => ' #1b212b' })
  const { teamText, hexLum } = new Function('document', 'getComputedStyle',
    lift(js, 'hexLum') + '\n' + lift(js, 'teamText') + '\nreturn { teamText, hexLum };')(document, getComputedStyle)
  const ratio = (a, b) => { const x = hexLum(a), y = hexLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  ok(teamText('#0A34D6') === '#0A34D6', 'light keeps the colour exactly')
  theme = 'dark'
  for (const c of ['#0A34D6', '#111827', '#E0301A', '#ffffff']) {
    const out = teamText(c)
    ok(ratio(out, '#1b212b') >= 4.5, `dark: ${c} → ${out} (${ratio(out, '#1b212b').toFixed(1)}:1)`)
  }
  ok(teamText('#f59e0b') === '#f59e0b', 'a colour that already reads is left alone')
  ok(teamText('') === '' && teamText(null) === null, 'no colour stays no colour')
}

console.log('\n[7] /logs follows the same choice')
{
  const lboot = (logs.match(/<script id="themeBoot">([\s\S]*?)<\/script>/) || [])[1] || ''
  ok(!!lboot && logs.search(/<script[\s>]/) === logs.indexOf('<script id="themeBoot">') && logs.indexOf('<script id="themeBoot">') < logs.indexOf('<style>'),
    'its boot script is first too')
  for (const [stored, want] of [[null, null], ['dark', 'dark'], ['eink', 'eink'], ['neon', null]]) {
    ok(page(lboot, stored).theme() === want, `localStorage.theme = ${JSON.stringify(stored)} → data-theme ${want || 'absent'}`)
  }
  const p = page(lboot, null)
  p.store.set('theme', 'dark'); p.fire('storage', { key: 'theme' })
  ok(p.theme() === 'dark', 'and it follows a change made in the console\'s tab')
  ok(/:root\[data-theme="dark"\]\{/.test(logs) && /:root\[data-theme="eink"\]\{/.test(logs), 'with both token sets')
  ok(!/#fff5f4|#fffaf2/.test(logs.replace(/:root\{[^}]*\}/, '')), 'its severity tints come from tokens')
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — theme-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
