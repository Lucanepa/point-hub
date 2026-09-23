// The console's hall-usability fixes from the 2026-09-23 UI review: what a volunteer scorer sees
// and taps, in a bright hall, on a phone on its side or a tablet on the table.
//
// Layout is a browser's business and there is no browser here, so the CSS is asserted against the
// source (the way console-shell-selftest does), and the logic that decides what the scorer reads —
// panel contrast, the confirm wording, the History phrasing, the Link tab's error text, the
// set-closed toast — is lifted out of the page by name and run against stubs. A renamed function
// fails loudly here rather than the test quietly checking nothing.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => fs.readFileSync(path.resolve(here, '..', 'web', f), 'utf8')
const index = read('index.html')
const logs = read('logs.html')
// Comments stripped: several rules are explained by naming the selector they replaced.
const css = ((index.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '')
const logsCss = (logs.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || ''

// Brace-matched source of `function name(…) {…}` or `const name = (…) => {…}`.
function lift(src, name) {
  let at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`))
  if (at < 0) at = src.search(new RegExp(`const ${name} = `))
  if (at < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1) + (src[i + 1] === ';' ? ';' : '')
  }
  throw new Error(`${name} is unbalanced`)
}
// The block a media query opens, by brace matching from its header.
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

console.log('[1] `hidden` always hides (the phantom "Continue game")')
{
  ok(/\[hidden\]\{display:none!important\}/.test(css), 'the console has one global [hidden] rule that beats author display rules')
  ok(/\.gpopt\{display:flex/.test(css), 'the game-menu rows still set display:flex (which is what used to beat `hidden`)')
  ok(/id="gpContinue" hidden/.test(index) && /id="gpDelete" hidden/.test(index), 'Continue and Delete start hidden')
  ok(/\[hidden\]\{display:none!important\}/.test(logsCss), 'and /logs has the same rule')
}

console.log('\n[2] Settings steppers stay inside their cards')
{
  ok(!/\.settings \.row span\{flex:1/.test(css), 'the label rule no longer matches the stepper wrapper span')
  ok(/\.settings \.row > span:first-child\{flex:1;min-width:0\}/.test(css), 'only the label text flexes')
  ok(/\.settings \.stepper\{[^}]*flex:0 0 auto/.test(css), 'the stepper keeps its own size')
}

console.log('\n[3] a phone on its side keeps every scoring control on screen')
{
  ok(/@media \(min-width:740px\) and \(min-height:560px\)\{[\s\S]{0,80}\.boardview\{display:flex\}/.test(css),
    'the board mirror needs HEIGHT as well as width (it collapsed to a lone "-" at 844x390)')
  const short = mediaBlock(css, '@media (max-height:500px)')
  ok(!!short, 'there is a short-screen layout')
  ok(/\.gfooter\{flex-direction:row/.test(short), 'the set strip shares one row with the action buttons')
  ok(/\.spopt\{min-height:0/.test(short), 'the sport tiles shrink so "Keep current sport" is not below the fold')
  ok(/#serveOrder \.editbox\{[^}]*grid-template-columns:repeat\(3/.test(short), 'the beach serve order lays its three questions side by side')
  // One deliberate exception: only the LATEST set pill shows here, so the strip keeps room for the
  // remove-last-set trash (from the third set on it scrolled off the end). No control is hidden.
  ok(!/display:none/.test(short.replace('.setpill:not(:last-of-type){display:none}', '')), 'no control is hidden to make it fit')
  ok(/\.setpill:not\(:last-of-type\)\{display:none\}/.test(short) && !/\.setundo\{[^}]*display:none/.test(short),
    'the set strip shows the latest pill and always the remove-last-set trash')
  ok(/#serveOrder \.editbox,#edit \.editbox,#confirm \.editbox,#pinModal \.editbox\{max-height:calc\(100dvh - 24px\);overflow-y:auto\}/.test(css),
    'every dialog box scrolls inside the viewport instead of clipping')
}

console.log('\n[4] touch targets are finger-sized')
{
  ok(/--tap:44px/.test(css), 'one --tap token (44px)')
  const uses = (sel) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\{[^}]*width:var\\(--tap\\);height:var\\(--tap\\)').test(css)
  for (const sel of ['.smbtn', '.setundo', '.sv-arrow', '.stbtn', '.namesize button']) ok(uses(sel), `${sel} is a --tap square`)
  ok(/#cd \.cd-stop\{min-width:var\(--tap\);height:var\(--tap\)/.test(css), 'the countdown ✕ is too')
  ok(/\.stat \.pm\{display:flex;gap:8px/.test(css), '− and + on a stat are 8px apart')
  ok(/\.stat\{[^}]*cursor:pointer/.test(css), 'the whole stat tile reads as tappable')
  const side = lift(index, 'applySportUI') && index.slice(index.indexOf('// per-side controls'), index.indexOf('// serve toggle'))
  ok(/closest\("\.stat"\)[\s\S]{0,200}!e\.target\.closest\("button"\)[\s\S]{0,80}querySelector\("\[data-val\]"\)/.test(side),
    'a tap anywhere on a tile (not its −/+) opens that number\'s editor')
  ok(/#scopes button\{min-height:var\(--tap\)/.test(logsCss), '/logs scope chips are --tap tall')
  ok(/\.brand a\{[^}]*min-height:var\(--tap\)/.test(logsCss), 'and so is the "← Controller" link')
}

console.log('\n[5] hint text is readable on the team panels')
{
  const hint = (css.match(/\n\s*\.taphint\{([^}]*)\}/) || [])[1] || ''
  ok(!/opacity/.test(hint), 'the tap hint has no opacity')
  ok(Number((hint.match(/font-size:(\d+)px/) || [])[1]) >= 12 && /font-weight:700/.test(hint), 'and is at least 12px bold')
  ok(/\.side \.taphint\{color:var\(--on-edge\)\}/.test(css), 'in full-strength panel ink')
  ok(/\.side \.stat \.name\{color:var\(--on-edge\)\}/.test(css), 'as are the stat labels')
  ok(Number(((css.match(/\n\s*\.stat \.name\{[^}]*font-size:(\d+)px/) || [])[1])) >= 12, 'which are 12px')

  const inkOn = new Function(lift(index, 'inkOn') + '\nreturn inkOn;')()
  const panelFor = new Function('inkOn', 'const PANEL_MIN_CONTRAST = 4.5; const TILE_TINT = 0.15;\n' + lift(index, 'panelFor') + '\nreturn panelFor;')(inkOn)
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const tile = (bg, ink, t) => bg.map((v, i) => v + (ink[i] - v) * t)
  // Every preset the console offers, plus the stock defaults and the review's example.
  const colours = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#3b82f6',
    '#2563eb', '#6366f1', '#a855f7', '#ec4899', '#ffffff', '#111827', '#e0453d', '#3b6fe0', '#888888']
  let worst = Infinity, worstC = ''
  for (const c of colours) {
    const p = panelFor(c)
    const r = ratio(rgb(p.ink), tile(rgb(p.bg), rgb(p.ink), 0.15))
    if (r < worst) { worst = r; worstC = c }
  }
  ok(worst >= 4.5, `every preset panel gives its ink >= 4.5:1 even on the paler stat tiles (worst ${worstC} at ${worst.toFixed(2)})`)
  ok(ratio([255, 255, 255], rgb('#ef4444')) < 4.5 && panelFor('#ef4444').ink === '#ffffff',
    'the stock red, 3.8:1 under white as it comes, keeps white ink…')
  const red = rgb(panelFor('#ef4444').bg)
  ok(red[0] > red[1] * 2 && red[0] > red[2] * 2, '…on a panel that is still plainly red')
  ok(panelFor('#1e3a8a').bg === '#1e3a8a', 'a colour that already passes is painted exactly as chosen')
  ok(panelFor('nonsense') === null, 'a malformed colour falls back to the stock panel')
}

console.log('\n[6] destructive buttons ask in plain words, with a red verb')
{
  ok(/#resetBtn\{position:relative;margin-left:auto\}/.test(css), 'Reset sits apart from Switch sides')
  ok(!/\.danger:first-of-type/.test(css), 'the selector that never matched is gone')
  const reset = index.slice(index.indexOf('$("#resetBtn").addEventListener'), index.indexOf('$("#refreshBtn")'))
  ok(/askConfirm\(resetWarning\(\), \{ yes: "Reset match", danger: true \}\)/.test(reset), 'Reset asks with a "Reset match" danger verb')
  // Blank was taken off the board's console (see the comment above #resetBtn); nothing may call the
  // endpoint that went with it.
  ok(!/blankBtn|\/api\/blank/.test(index), 'Blank is gone, button and endpoint call alike')
  const warn = new Function('SPORT', lift(index, 'resetWarning') + '\nreturn resetWarning();')
  ok(/0–0/.test(warn('volleyball')) && /subs/.test(warn('volleyball')), 'the volleyball warning says what is cleared')
  ok(/fouls/.test(warn('basketball')) && !/subs/.test(warn('basketball')), 'basketball in its own words')

  // askConfirm against stub elements: the verb and the danger styling are applied, and reset.
  const el = () => ({ textContent: '', hidden: true, classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c) }, contains(c) { return this.set.has(c) } } })
  const els = { '#confirmMsg': el(), '#confirmYes': el(), '#confirmNo': el(), '#confirm': el() }
  const ask = new Function('$', 'let confirmResolve = null;\n' + lift(index, 'askConfirm') + '\nreturn askConfirm;')((s) => els[s])
  ask('Reset?', { yes: 'Reset match', danger: true })
  ok(els['#confirmYes'].textContent === 'Reset match' && els['#confirmYes'].classList.contains('danger'), 'askConfirm paints the named verb red')
  ask('Add a timeout?')
  ok(els['#confirmYes'].textContent === 'Confirm' && !els['#confirmYes'].classList.contains('danger'), 'and the next plain confirm is plain again')
  ok(/#confirmYes\.danger\{[^}]*background:var\(--bad\)/.test(css), 'the danger verb is styled red')
}

console.log('\n[7] accessibility basics')
{
  ok(/^<html lang="en">/.test(index), 'the console declares its language')
  ok(/<html lang="en">/.test(logs), 'so does /logs')
  for (const id of ['confirm', 'edit', 'pinModal', 'serveOrder', 'sportPicker', 'gamePicker', 'matchEnd']) {
    const tag = (index.match(new RegExp(`<div id="${id}"[^>]*>`)) || [''])[0]
    ok(/role="(alert)?dialog"/.test(tag) && /aria-modal="true"/.test(tag), `#${id} is a modal dialog`)
  }
  ok(/<div id="toast" role="status" aria-live="polite"/.test(index), 'toasts (write failures included) are announced')
  ok(/placeholder="TEAM A" aria-label="Left team name"/.test(index) && /placeholder="TEAM B" aria-label="Right team name"/.test(index),
    'the team-name boxes are labelled')
  ok(/new MutationObserver/.test(index) && /attributeFilter: \["hidden"\]/.test(index), 'dialogs manage focus off their `hidden` attribute')
  ok(/e\.key !== "Tab"[\s\S]{0,800}else if \(!e\.shiftKey && a === last\) \{ e\.preventDefault\(\); first\.focus\(\); \}/.test(index), 'Tab is kept inside the top dialog')
  ok(/document\.addEventListener\("keydown", \(e\) => \{\s*const top = topModal\(\);[\s\S]*?\}, true\);/.test(index),
    'Escape is handled in the capture phase (so it closes one dialog, not the one underneath too)')
}

console.log('\n[8] History reads basketball periods, undos and refused points')
{
  const periodLabel = (p) => { p = Number(p) || 1; return p <= 4 ? 'Q' + p : 'OT' + (p - 4) }
  const eventText = new Function('periodLabel', lift(index, 'eventText') + '\nreturn eventText;')(periodLabel)
  const m = { team_a: 'KSCW', team_b: 'VBC' }
  ok(eventText({ type: 'period-end', period: 3, score: [54, 48] }, m) === 'End of Q3 (54–48)', 'End of Q3 (54–48)')
  ok(eventText({ type: 'period-end', period: 5 }, m) === 'End of OT1', 'overtime is OT1, not Q5')
  ok(eventText({ type: 'undo', what: 'Point KSCW' }, m) === 'Undone: Point KSCW', 'an undo names what it took back')
  ok(eventText({ type: 'undo' }, m) === 'Last action undone', 'and still reads without a label')
  ok(/already over/.test(eventText({ type: 'set-closed', side: 'a' }, m)), 'a refused point says why')
  ok(eventText({ type: 'point', side: 'b', delta: 1 }, m) === 'Point · VBC', 'the existing phrasing is unchanged')
  ok(/\.logrow\.period-end\{color:var\(--gold\)/.test(css), 'period ends stand out like set ends')
}

console.log('\n[9] the Link tab speaks plainly; Diagnostics hides container plumbing')
{
  const linkErrorText = new Function(lift(index, 'linkErrorText') + '\nreturn linkErrorText;')()
  const t = linkErrorText('lan: fetch failed')
  // The lan source is the OpenVolley laptop's relay, so its absence is named as that (round 3).
  ok(/OpenVolley laptop isn't on this network/.test(t) && !/fetch failed|lan:/.test(t), `"lan: fetch failed" → "${t}"`)
  ok(/Can't reach the scoresheet server/.test(linkErrorText('cloud: fetch failed')), 'a cloud source that cannot be reached still says so')
  ok(/isn't set up/.test(linkErrorText('lan: no relay configured (RELAY_HTTP_URL is empty)')), 'an unconfigured relay is not reported as a fault')
  ok(/p\.title = String\(m\)/.test(index), 'the raw error stays on the row for whoever is debugging')
  const re = eval((index.match(/const VIRTUAL_IFACE = (\/.*\/);/) || [])[1])
  for (const n of ['lo', 'docker0', 'veth1a2b', 'br-0f3c9', 'virbr0']) ok(re.test(n), `${n} is hidden`)
  for (const n of ['wlan0', 'eth0', 'br0', 'usb0', 'uap0']) ok(!re.test(n), `${n} is shown`)
}

console.log('\n[10] a point refused because the set is over says so (set-closed)')
{
  const toasts = []
  let prompted = 0
  const cd = { hidden: true }
  const mk = (SPORT, over) => new Function('toast', 'matchOver', 'SPORT', '$', 'showSetEndPrompt',
    lift(index, 'handleEvent') + '\nreturn handleEvent;')(
    (m) => toasts.push(m), () => over, SPORT, (s) => (s === '#cd' ? cd : null), () => { prompted++ })
  mk('volleyball', false)('set-closed', { points_a: 25, points_b: 10 })
  ok(toasts.pop() === 'Set is over — tap Start interval', 'the toast names the way on')
  ok(prompted === 1, 'and the SET ENDED card comes back if it had been dismissed')
  cd.hidden = false
  mk('beach', false)('set-closed', {})
  ok(prompted === 1, 'but is not stacked when it is already up')
  mk('volleyball', true)('set-closed', {})
  ok(/match is over/.test(toasts.pop()), 'after the last set it says the match is over instead')
  const clear = lift(index, 'applySportUI')
  ok(/clearCountdown\(\)/.test(clear), 'a sport switch takes down a SET ENDED card from the old match')
}

console.log('\n[11] a refused Settings save shows the board\'s own reason')
{
  const save = lift(index, 'saveSettings')
  ok(/e\.status === 400 \? "Not saved — " \+ msg/.test(save), 'a 400 puts the server\'s words on the status line')
  ok(/clickedBtn\.classList\.add\("fail"\)/.test(save), 'and marks the Save that was pressed')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
