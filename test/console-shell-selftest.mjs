// Static guards on the console shell — the handful of one-liners whose removal breaks the app on a
// tablet and on nothing else.
//
// None of this is reachable from the Node suite: it is browser layout and browser focus, and the
// board has no headless browser. But each item below has already cost a match, and each is a
// single attribute or call that a later edit could drop without anything going red. So they are
// asserted against the source, the same way control-auth-selftest asserts that every mutating
// route has been given a decision about authentication.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const html = fs.readFileSync(path.resolve(here, '..', 'web', 'index.html'), 'utf8')
const js = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || ''

console.log('[1] the on-screen keyboard must resize the app, not pan it off screen')
{
  // The failure this prevents: type a score, press Go, and the tablet shows a black screen.
  // Not the display sleeping — the visual viewport left parked below an app that is
  // `height:100dvh; overflow:hidden`, with the dark page background filling the screen.
  const meta = (html.match(/<meta name="viewport"[^>]*>/) || [])[0] || ''
  ok(/interactive-widget=resizes-content/.test(meta),
    'the viewport meta asks the keyboard to resize the layout viewport')
  // The two properties that make the above necessary rather than decorative. If either ever goes
  // away the meta tag stops mattering — and this assertion is where that gets noticed.
  ok(/#app\{[^}]*height:100dvh/.test(html), '#app is still a fixed-height shell (which is why the pan has nowhere to unwind to)')
  ok(/#app\{[^}]*overflow:hidden/.test(html), 'and still non-scrolling')
}

console.log('\n[2] focus is given up before the thing holding it disappears')
{
  ok(/function dismissKeyboard\(\)/.test(js), 'there is a deliberate keyboard-dismissal path')
  ok(/function closeEdit\(\)\s*\{\s*dismissKeyboard\(\)/.test(js),
    'the number editor blurs BEFORE hiding — hiding a focused input is what strands the view')
  ok(/dismissKeyboard\(\);\s*\n\s*sendAction\(\{ type: "team"/.test(js),
    'and so does the team-name box, the other field a scorer types into mid-match')
}

console.log('\n[3] the lock button does what its tooltip says')
{
  // It used to read "tap to change PIN" while unlocked and then open the UNLOCK pad, so the only
  // outcomes were re-entering the PIN you already held (nothing visibly happened) or "Wrong PIN"
  // for trying to set a new one.
  ok(!/\$\("#lockBtn"\)\.addEventListener\("click", openPinModal\)/.test(js),
    'tapping it while unlocked no longer just re-opens the unlock pad')
  ok(/tap to lock this device/.test(js), 'the unlocked tooltip offers locking')
  ok(/if \(!SCORER_PIN\) return openPinModal\(\)/.test(js), 'and locked still goes straight to the PIN pad')
}

console.log('\n[4] the name box cannot send lower case to the panel')
{
  // Belt to the server's braces (toLeftRight upper-cases everything the board paints). Here it
  // also keeps the STORED value matching what the box appears to say, since the box is styled
  // text-transform:uppercase and would otherwise go on quietly lying about its own contents.
  ok(/shortEl\.value = shortEl\.value\.toUpperCase\(\)/.test(js), 'the team-name box upper-cases what it sends')
  ok(/input\.short\{[^}]*text-transform:uppercase/.test(html), 'which is what the box has always displayed')
}

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
