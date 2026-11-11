// German and Swiss German: web/i18n/*.json, read by the console (web/i18n.js) and the tablet app's
// Game tab alike. A word with no entry stays English, so what can go wrong here is a file that does
// not load, a pattern that breaks, or a sentence the scorer depends on that was left out.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Settings } from '../src/settings.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../web/i18n/${f}.json`, import.meta.url), 'utf8'))
const de = read('de')
const ch = read('de-CH')

console.log('\n[1] the two files match')
ok(JSON.stringify(Object.keys(de.exact).sort()) === JSON.stringify(Object.keys(ch.exact).sort()), `the same ${Object.keys(de.exact).length} exact keys`)
ok(JSON.stringify(de.patterns.map((p) => p[0])) === JSON.stringify(ch.patterns.map((p) => p[0])), `the same ${de.patterns.length} patterns, in the same order`)

for (const [name, words] of [['de', de], ['de-CH', ch]]) {
  console.log(`\n[2] ${name}`)
  const text = JSON.stringify(words)
  ok(!text.includes('ß'), 'Swiss spelling: no ß')
  let broken = 0, refs = 0
  for (const [re, to] of words.patterns) {
    let groups = 0
    try { groups = new RegExp(`${re}|`).exec('').length - 1 } catch { broken++; continue }
    if (!re.startsWith('^') || !re.endsWith('$')) broken++
    for (const m of to.matchAll(/\$(\d)/g)) if (Number(m[1]) > groups) refs++
  }
  ok(broken === 0, 'every pattern compiles and is anchored')
  ok(refs === 0, 'every $n has its group')
  const empty = Object.entries(words.exact).filter(([, v]) => !String(v).trim())
  ok(empty.length === 0, 'no empty translation')
  for (const must of [
    'Close set →', 'Close match →', 'SET ENDED', 'MATCH ENDED', 'OFFICIAL WARM-UP', 'Start the official warm-up?', 'Not now',
    'Start match now', 'New game', 'How do you want to score it?', 'Another game from the schedule', 'Link the OpenVolley eScoresheet',
    'Manual', 'Match info', 'Switch sides', 'Reset match', 'Undo', 'Warm-up', 'Font size', 'Font\nsize',
    'Live', 'Waiting for the scoresheet', 'Link lost', 'Match ended',
  ]) ok(words.exact[must] && words.exact[must] !== must || must === 'Live', `${JSON.stringify(must)} → ${JSON.stringify(words.exact[must])}`)
  const lookup = (s) => {
    if (words.exact[s]) return words.exact[s]
    for (const [re, to] of words.patterns) { const r = new RegExp(re); if (r.test(s)) return s.replace(r, to) }
    return s
  }
  const composed = lookup('Start official warm-up (10 min)')
  ok(composed !== 'Start official warm-up (10 min)', `the banner's warm-up button: ${composed}`)
  const toast = lookup('Set is over — tap Close set')
  ok(toast !== 'Set is over — tap Close set' && toast.includes(words.exact['Close set →'].replace(/\s*→$/, '')), `its toast names the same button: ${toast}`)
  ok(lookup('KSCW H3') === 'KSCW H3' && lookup('25') === '25', 'team names and scores are left alone')
}

console.log('\n[3] the setting')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'))
  const s = new Settings(path.join(dir, 'settings.json'))
  ok(s.values.language === 'en', 'English until someone chooses')
  ok(s.update({ language: 'de-CH' }).language === 'de-CH', 'Swiss German')
  ok(s.update({ language: 'fr' }).language === 'de-CH', 'an unknown language is refused')
  ok(new Settings(path.join(dir, 'settings.json')).values.language === 'de-CH', 'and it survives a restart')
}

console.log(`\n${fail ? '❌' : '✅'} i18n: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
