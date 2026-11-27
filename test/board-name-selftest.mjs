// Long team names are shortened to fit the panel (boardName, src/volleyballMapper.js).
//
// Since 26.11.2026 OpenVolley no longer has a typed short name: team_a_short is the full name less
// its club words ("VBC Klosterau D2" -> "Klosterau D2"), with no length cap. The fitter shrinks a
// name only down to 9pt, so anything longer than ~12 capitals ran into the set counter. Locked here:
//   1. a name that already fits is painted exactly as it came (no board changes on deploy);
//   2. a long one is shortened until it fits the 86px box at 11pt, and keeps its team part (D1/D2);
//   3. the board's real screens get it: scoreboard and timeout screen, full name kept for the idle.
import { boardName, fitFontSize, toLeftRight, toSections, toBreakSections, resultWinnerLine } from '../src/volleyballMapper.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
const size = (s, w = 86) => fitFontSize(s, w, { max: 18, min: 9 })

console.log('[1] a name that fits is left alone')
for (const n of ['KSCW', 'KLOSTERAU D2', 'WIEDIKON H3', 'TEAM A', 'LE MONT', 'VOLLEY', 'VBC ZUG']) {
  ok(boardName(n) === n, `${n} unchanged`)
}
ok(boardName('MÜLLER/SORRENTINO') === 'MÜLLER/SORRENTINO', 'a beach pair is never cut (it would drop the second player)')

console.log('\n[2] a long name, step by step')
const cases = [
  ['VBC KUESNACHT', 'KUESNACHT', 'club words go'],
  ['VOLERO ZÜRICH D1', 'VOLERO Z. D1', 'place words after the first become initials'],
  ['ZÜRI UNTERLAND D2', 'ZÜRI U. D2', '...keeping the team part'],
  ['SCHÖNENWERD H1', 'SCHÖNEN. H1', 'one long place word is cut, with a dot'],
  ['MUSTERHAUSEN-BEISPIELAU AM SEEBLICK DAMEN 2', 'MUSTERHA. D2', 'DAMEN 2 -> D2, AM goes, the rest is cut'],
  ['VOLLEYBALLCLUB MUSTERHAUSEN-BEISPIELAU AM SEEBLICK DAMEN 2', 'MUSTERHA. D2', 'the full name, club word first, gives the same'],
  ['ST. MUSTERBERG JUNIORINNEN U18', 'ST. MUST. U18', 'ST. stays with its word, JUNIORINNEN U18 -> U18'],
  ['LA CHAUX-DE-FONDS DAMES 1', 'LA CHAUX. D1', 'French: DAMES 1 -> D1, never "CHAUX-."'],
]
for (const [n, want, why] of cases) {
  const got = boardName(n)
  ok(got === want, `${why}: ${n} -> ${got}`)
}
const longs = [...cases.map((c) => c[0]), 'SG VOLLEY ZÜRICH-OERLIKON HERREN 3', 'VC KANTONSSCHULE ENGE ZÜRICH']
ok(longs.every((n) => size(boardName(n)) >= 11), 'every shortened name fits the 86px box at 11pt or larger')
ok(boardName('SG VOLLEY ZÜRICH-OERLIKON HERREN 3').endsWith(' H3'), 'HERREN 3 -> H3, still at the end')
ok(longs.every((n) => boardName(n).trim().length > 0), 'never empty')

console.log('\n[3] on the board\'s screens')
{
  const state = { side_a: 'left', team_a_short: 'Zürich Unterland D2', team_a_name: 'VBC Zürich Unterland D2', team_b_name: 'VBC Kuesnacht' }
  const v = toLeftRight(state)
  ok(v.leftName === 'ZÜRICH U. D2' && v.rightName === 'KUESNACHT', `scoreboard names shortened (${v.leftName} | ${v.rightName}), the name as fallback`)
  ok(v.leftFull === 'VBC ZÜRICH UNTERLAND D2', 'the full name stays full for the idle screen')
  const sec = toSections(state)
  const get = (s, n, a) => s.find((x) => x.name === n && x.value.attrib === a)?.value.value
  ok(get(sec, 'team1', 'text') === 'ZÜRICH U. D2' && Number(get(sec, 'team1', 'fontsize')) >= 11, `team1 painted shortened at ${get(sec, 'team1', 'fontsize')}pt`)
  const brk = toBreakSections(state, { timerText: '0:30', label: 'TIMEOUT', team: 'VOLERO ZÜRICH-ALTSTETTEN D1', side: 'left' })
  const t = get(brk, 'team', 'text')
  ok(t && fitFontSize(t, 58, { max: 18, min: 7 }) >= 8 && t.endsWith(' D1') && t !== 'VOLERO ZÜRICH-ALTSTETTEN D1', `the timeout screen's 58px column shortens to fit: ${t}`)
}

console.log('\n[4] the end-of-match screen')
{
  const st = { team_a_short: 'MUSTERHAUSEN-BEISPIELAU AM SEEBLICK DAMEN 2', team_a_name: 'VOLLEYBALLCLUB MUSTERHAUSEN-BEISPIELAU AM SEEBLICK DAMEN 2', team_b_short: 'KSCW D3', team_b_name: 'KSC WIEDIKON D3' }
  const head = (l) => fitFontSize(l, 188, { max: 17, min: 8 })
  const long = resultWinnerLine('MUSTERHAUSEN-BEISPIELAU AM SEEBLICK DAMEN 2 WINS', st)
  ok(long.endsWith(' D2 WINS') && head(long) >= 12, `a winner too long for a headline is shortened, WINS kept: ${long} (${head(long)}pt)`)
  ok(resultWinnerLine('KSCW D3 WINS', st) === 'KSC WIEDIKON D3 WINS', 'a short winner still gets its full name when it fits')
  ok(resultWinnerLine('ZÜRICH UNTERLAND D2 WINS', null) === 'ZÜRICH UNTERLAND D2 WINS', 'a winner that already fits as a headline is left alone')
  ok(resultWinnerLine('DRAW', st) === 'DRAW', 'a line that is not "… WINS" is left alone')
}

console.log(`\n${fail ? '❌' : '✅'} board-name: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
