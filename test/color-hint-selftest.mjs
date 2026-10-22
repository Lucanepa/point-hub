// The console's team-colour hint (web/index.html, renderColorHint): one quiet line under the team
// cards when the two colours will not tell the teams apart on the board, or one of them will not
// light at all, with a one-tap preset that fixes it.
//
//   [1] it is wired in: the element, the render call, the side recoloured last
//   [2] the console's LED maths is the bridge's (src/ledColor.js) — same dark colours, every
//       brightness
//   [3] colorAdvice: red-green pairs, look-alikes, a dark team, the side it names, and a
//       suggestion that actually clears the clash
//   [4] the line itself: wording, hidden when there is nothing to say (or no colours on the board),
//       and the chip sends the preset for the named team
//
// No browser: the functions are lifted out of the page and run against stubs, as theme-selftest does.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDark } from '../src/ledColor.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const eq = (got, want, m) => ok(JSON.stringify(got) === JSON.stringify(want), `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)

const here = path.dirname(fileURLToPath(import.meta.url))
const index = fs.readFileSync(path.join(here, '..', 'web', 'index.html'), 'utf8')
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''

function lift(name) {
  const at = js.search(new RegExp(`function ${name}\\(`))
  if (at < 0) throw new Error(`${name} not found`)
  let i = js.indexOf('{', js.indexOf(')', at)), depth = 0
  for (; i < js.length; i++) {
    if (js[i] === '{') depth++
    else if (js[i] === '}' && --depth === 0) return js.slice(at, i + 1)
  }
  throw new Error(`${name} is unbalanced`)
}
// `const NAME = …;` at the top level of the script, braces and brackets balanced.
function liftConst(name) {
  const at = js.indexOf(`const ${name} =`)
  if (at < 0) throw new Error(`${name} not found`)
  let depth = 0
  for (let i = at; i < js.length; i++) {
    const c = js[i]
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ';' && depth === 0) return js.slice(at, i + 1)
  }
  throw new Error(`${name} is unbalanced`)
}

const pure = ['ledLevel', 'ledDark', 'cvdOklab', 'colorGap', 'colorAdvice'].map(lift).join('\n')
const consts = ['CVD', 'COLOR_ALIKE', 'DARK_TEAM_INK', 'PRESETS'].map(liftConst).join('\n')
const { ledDark, colorGap, colorAdvice, PRESETS, COLOR_ALIKE } = new Function(
  `${consts}\n${pure}\nreturn { ledDark, colorGap, colorAdvice, PRESETS, COLOR_ALIKE };`)()

console.log('\n[1] wired in')
{
  const at = index.indexOf('id="colorHint"')
  ok(at > 0 && /<p class="colorhint" id="colorHint" role="status" hidden><\/p>/.test(index), 'a status line, hidden until it has something to say')
  ok(at > index.indexOf('<div class="board">') && at < index.indexOf('<div class="boardview">'), 'under the team cards, above the mirror (so phones, which hide the mirror, still get it)')
  ok(/renderColorHint\(s\);/.test(lift('renderBoard')), 'renderBoard keeps it current on every status')
  ok(/lastColorSide = side\(\);/.test(js), 'recolouring a team remembers which one, so a clash is pinned on it')
  ok(/\.colorhint\{/.test(index) && /\.colorhint button\{/.test(index), 'it has its own small styles')
}

console.log('\n[2] the same LED maths as the bridge')
{
  const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('')
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 256 }
  const colours = [...PRESETS.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))]
  for (let g = 0; g < 256; g += 3) colours.push([g, g, g])
  for (let n = 0; n < 1500; n++) colours.push([rnd(), rnd(), rnd()])
  let mismatch = 0, checked = 0
  for (const b of [1, 5, 10, 20, 30, 40, 50, 60, 75, 90, 100]) {
    for (const rgb of colours) { checked++; if (ledDark(toHex(rgb), b) !== isDark(rgb, b)) mismatch++ }
  }
  ok(mismatch === 0, `${checked} colour × brightness checks, ${mismatch} disagreements between the console and the bridge`)
  ok(ledDark('#111827', 40) && !ledDark('#2563eb', 40), '#111827 dark, #2563eb not, at 40')
  ok(!ledDark('nonsense', 40), 'a malformed colour is not called dark')
}

console.log('\n[3] colorAdvice')
{
  const A = (l, r, prefer) => colorAdvice(l, r, 40, PRESETS, prefer)
  const rg = A('#ef4444', '#22c55e')
  eq(rg && rg.kind, 'cvd', 'red #ef4444 vs green #22c55e: alike to red-green colour-blind eyes')
  ok(colorGap('#ef4444', '#22c55e').normal > 3 * COLOR_ALIKE, 'though plainly different for everyone else')
  eq(rg && rg.side, 'right', 'with nothing else to go on, it names the right-hand team')
  eq(A('#ef4444', '#22c55e', 'left').side, 'left', 'or the one just recoloured')
  ok(rg && rg.suggest && !['#ef4444', '#22c55e', '#111827'].includes(rg.suggest), `and suggests a third preset (${rg && rg.suggest})`)
  eq(A('#ef4444', rg.suggest), null, 'which clears the clash')
  eq(A('#2563eb', '#6366f1').kind, 'alike', 'two blues: alike for everyone')
  eq(A('#3b82f6', '#a855f7').kind, 'cvd', 'blue vs purple: alike for red-green colour-blind eyes')
  const navyWhite = A('#111827', '#ffffff')
  eq([navyWhite.kind, navyWhite.dark, navyWhite.side], ['alike', [true, false], 'left'],
    '#111827 vs white: the board shows light grey vs white, alike; the dark team is the one to change')
  ok(!ledDark(navyWhite.suggest, 40), `and the suggestion lights (${navyWhite.suggest})`)
  const navyRed = A('#111827', '#ef4444')
  eq([navyRed.kind, navyRed.dark, navyRed.side], ['dark', [true, false], 'left'], '#111827 vs red: only the too-dark note')
  eq(A('#ef4444', '#000000', 'left').side, 'right', 'a dark team is named whichever side was recoloured last')
  eq(A('#111827', '#000000').dark, [true, true], 'both dark: both flagged')
  eq(A('#ef4444', '#2563eb'), null, 'red vs blue: nothing to say')
  eq(A('#3b6fe0', '#e0453d'), null, "the console's own default blue vs red: nothing to say")
  eq(A('#ef4444', ''), null, 'a missing colour: nothing to say')
  eq(colorAdvice('#ef4444', '#22c55e', 40, [], null).suggest, null, 'no presets: the note stands without a chip')
  // Every flagged preset pair gets a suggestion that clears it.
  let flagged = 0, cleared = 0
  for (const l of PRESETS) for (const r of PRESETS) {
    if (l === r) continue
    const a = A(l, r)
    if (!a) continue
    flagged++
    const after = a.side === 'left' ? A(a.suggest, r) : A(l, a.suggest)
    if (!after || (after.kind === 'dark' && after.side !== a.side)) cleared++
    else console.log('     still flagged:', l, r, '->', a.side, a.suggest, after.kind)
  }
  ok(flagged > 0 && cleared === flagged, `${flagged} preset pairs flagged; the suggested preset clears every one`)
}

console.log('\n[4] the line on the page')
{
  const make = () => {
    const kids = []
    const node = (tag) => ({
      tag, children: [], style: {}, className: '', title: '', type: '', listeners: {},
      append(...xs) { for (const x of xs) this.children.push(x) },
      addEventListener(t, f) { this.listeners[t] = f },
      get text() { return this.children.map((c) => (typeof c === 'string' ? c : c.text || '')).join('') + (this.textContent || '') },
    })
    const el = node('p'); el.hidden = true
    Object.defineProperty(el, 'textContent', {
      get() { return this._tc || '' },
      set(v) { this._tc = v; if (v === '') this.children = [] },
    })
    const sent = []
    const env = {
      $: (sel) => (sel === '#colorHint' ? el : null),
      document: { createElement: (t) => { const n = node(t); kids.push(n); return n } },
      SETTINGS: { brightness: 40 }, SPORT: 'volleyball', sendAction: (a) => sent.push(a),
    }
    return { el, sent, env }
  }
  const run = (env, s) => new Function('$', 'document', 'SETTINGS', 'SPORT', 'sendAction',
    `${consts}\n${pure}\nlet lastColorSide = null;\n${lift('renderColorHint')}\nrenderColorHint(arguments[5]);`)(
    env.$, env.document, env.SETTINGS, env.SPORT, env.sendAction, s)
  const side = (short, color) => ({ short, color })
  const words = (el) => el.children.map((c) => (typeof c === 'string' ? c : c.textContent || c.children.map((x) => (typeof x === 'string' ? x : '')).join(''))).join(' ')

  {
    const { el, sent, env } = make()
    run(env, { left: side('KSCW', '#ef4444'), right: side('ZUG', '#22c55e') })
    ok(!el.hidden, 'red vs green: shown')
    ok(/KSCW and ZUG look alike to red-green colour-blind spectators\./.test(words(el)), `"${words(el)}"`)
    const chip = el.children.find((c) => c.tag === 'button')
    ok(chip && /for ZUG/.test(words({ children: chip.children })), 'the chip names the team it would change')
    chip.listeners.click()
    ok(sent.length === 1 && sent[0].type === 'team' && sent[0].side === 'right' && /^#[0-9a-f]{6}$/.test(sent[0].color), `and tapping it sends ${JSON.stringify(sent[0])}`)
  }
  {
    const { el, env } = make()
    run(env, { left: side('NAVY', '#111827'), right: side('ZUG', '#ef4444') })
    ok(/NAVY's colour is too dark for the LEDs, so the board shows it light grey\./.test(words(el)), `dark: "${words(el)}"`)
  }
  {
    const { el, env } = make()
    run(env, { left: side('', '#111827'), right: side('', '#ffffff') })
    ok(/^The left team and the right team look alike on the board\. The left team's colour is too dark/.test(words(el)), `unnamed, alike and dark: "${words(el)}"`)
  }
  {
    const { el, env } = make()
    run(env, { left: side('KSCW', '#ef4444'), right: side('ZUG', '#2563eb') })
    ok(el.hidden && el.children.length === 0, 'red vs blue: hidden, empty')
  }
  {
    const { el, env } = make()
    env.SPORT = 'simple'
    run(env, { left: side('A', '#ef4444'), right: side('B', '#22c55e') })
    ok(el.hidden, 'the simple scoreboard paints no team colours, so it says nothing')
  }
  {
    const { el, env } = make()
    env.SETTINGS = { brightness: 0 }
    run(env, { left: side('NAVY', '#111827'), right: side('ZUG', '#ef4444') })
    ok(!el.hidden, 'with the panel switched off it still judges at the indoor brightness')
  }
  {
    const { el, env } = make()
    run(env, null)
    ok(el.hidden, 'no state yet: hidden')
  }
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
