// Round 4 console work, asserted against web/index.html: the scorer-behind-the-board mapping of the
// Game tab's team cards, the pre-match banner (schedule start → clock → warm-up / start now), and
// the preview drawing each name at the size the board paints it.
//
// No browser here (the flows were walked in headless Chrome at 1180x820, 844x390 and 390x844
// against a MOCK board, in both orientations), so the pure logic is lifted out of the page by name
// and run against stubs, and the wiring is asserted from source — a renamed function fails loudly.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const index = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
const server = fs.readFileSync(path.join(root, 'src', 'controlServer.js'), 'utf8')
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
const css = ((index.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '')
const markup = index.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/, '')

function lift(src, name) {
  let at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`))
  if (at < 0) at = src.search(new RegExp(`const ${name} = `))
  if (at < 0) throw new Error(`${name} not found`)
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`${name} is unbalanced`)
}
const line = (re) => { const m = js.match(re); return m ? m[0] : '' }
const body = (name) => { try { return lift(js, name) } catch { return '' } }

console.log('\n[1] one mapping between the cards and the panel')
{
  const src = line(/const behind = [^\n]+/) + '\n' + line(/const panelSide = [^\n]+/) + '\n' + line(/const screenSide = [^\n]+/)
  const make = new Function('SETTINGS', src + '\nreturn { behind, panelSide, screenSide };')
  const b = make({ orientation: 'behind' }), f = make({ orientation: 'front' }), d = make({})
  ok(b.panelSide('left') === 'right' && b.panelSide('right') === 'left', 'behind: the scorer\'s left card is the panel\'s right')
  ok(f.panelSide('left') === 'left' && f.panelSide('right') === 'right', 'front: 1:1')
  ok(d.behind() === true && d.panelSide('left') === 'right', 'no setting yet = behind (the default)')
  for (const o of [b, f]) ok(['left', 'right'].every((s) => o.screenSide(o.panelSide(s)) === s), 'screenSide undoes panelSide')
}

console.log('\n[2] every left/right control on the Game tab goes through it')
{
  const perSide = js.slice(js.indexOf('const scr = root.dataset.side;'), js.indexOf('// Basketball period −/+'))
  ok(/const side = \(\) => panelSide\(scr\)/.test(perSide), 'a card resolves its panel side at every tap')
  ok(!/sendAction\(\{[^}]*\bside\s*[,}]/.test(perSide), 'no card action sends the raw screen side')
  ok((perSide.match(/side: (side\(\)|target)/g) || []).length >= 6, 'point, edit, T/O clock, stat, name and colour all send the mapped side')
  ok(/sendAction\(\{ type: "serve", side: panelSide\(b\.dataset\.serve\) \}/.test(js), 'serve arrows are mapped')
  ok(/serving === panelSide\(b\.dataset\.serve\)/.test(js), 'the lit serve arrow is mapped')
  ok(/nudgeFont\(panelSide\(b\.dataset\.font\)/.test(js), 'name-size −/+ move the half their card shows')
  const rfb = body('renderFontBox')
  ok(/data-fontval="\$\{screenSide\(side\)\}"/.test(rfb) && /data-font="\$\{screenSide\(side\)\}"/.test(rfb), 'the name-size readout sits on the card that shows that half')
  const rb = body('renderBoard')
  ok(/s\[panelSide\(side\)\]/.test(rb) && /s\[panelSide\(k\)\]/.test(rb), 'cards and serve colours are painted from the mapped side')
  ok(/\.side\.\$\{screenSide\(side\)\}/.test(body('flashSide')) && /\.side\.\$\{screenSide\(side\)\}/.test(body('flashName')), 'point / winner flashes land on the right card')
  ok(/const aFirst = aIsLeft === \(panelSide\("left"\) === "left"\)/.test(body('renderSetStrip')) && /"\|" \+ aFirst/.test(body('renderSetStrip')), 'set pills read in card order and rebuild when it flips')
  ok(/sd\[panelSide\("left"\)\]\.points \+ "–" \+ sd\[panelSide\("right"\)\]\.points/.test(body('showSetEndPrompt')), 'SET ENDED reads in card order')
  const so = body('openServeOrder')
  ok(/fb\[0\]\.dataset\.first = L/.test(so) && /ordSel\[L\]/.test(so), 'beach serve order: rows follow the cards, buttons carry panel sides')
  ok(/ordSel\[panelSide\("left"\)\]/.test(js) && /ordSel\[panelSide\("right"\)\]/.test(js), 'beach serve order: picks store under the panel side')
  ok(/cfg\.teams\[panelSide\(side\)\]/.test(body('applySportUI')), 'placeholders name the panel team (TEAM B / TEAM R on the left card when behind)')
  const rp = body('renderPreview')
  ok(!/panelSide|screenSide/.test(rp), 'the mirror is never mapped — it is the panel as the court sees it')
  ok(/applyOrientation\(\);/.test(body('renderStatus')) && /applyOrientation\(\);/.test(body('loadSettings')) && /applyOrientation\(\);/.test(body('saveSettings')), 'the flip is applied on status, load and save')
  ok(/shown\.left = \{\}; shown\.right = \{\}/.test(body('applyOrientation')), 'a flip forgets what each card showed (no false flashes)')
}

console.log('\n[3] preview label and the Settings toggle')
{
  ok(/<span class="bvlabel">Seen from the court <span class="bvhint" id="bvHint" hidden>\(mirrored — you sit behind the board\)<\/span><\/span>/.test(markup), 'the mirror is "Seen from the court", with the behind hint')
  ok(/Scorer sits behind the board<\/span>\s*<input type="checkbox" data-set="orientation" data-on="behind" data-off="front" checked>/.test(markup), 'Board identity has the toggle, checked by default')
  const make = new Function((js.match(/const readSet = [\s\S]*?;\n/) || [''])[0] + lift(js, 'writeSet') + '\nreturn { readSet, writeSet };')
  const { readSet, writeSet } = make()
  const box = { type: 'checkbox', checked: true, dataset: { on: 'behind', off: 'front' } }
  ok(readSet(box) === 'behind', 'checked reads as "behind"')
  box.checked = false; ok(readSet(box) === 'front', 'unchecked reads as "front"')
  writeSet(box, 'behind'); ok(box.checked === true, 'loading "behind" checks it')
  writeSet(box, 'front'); ok(box.checked === false, 'loading "front" unchecks it')
  const plain = { type: 'checkbox', checked: false, dataset: {} }
  writeSet(plain, true); ok(plain.checked === true && readSet(plain) === true, 'ordinary checkboxes stay booleans')
  ok(/ORIENTATIONS = \['behind', 'front'\]/.test(fs.readFileSync(path.join(root, 'src', 'settings.js'), 'utf8')), 'the server knows the same two values')
}

console.log('\n[4] pre-match')
{
  const ss = body('startScheduled')
  ok(/choice: "new", teams: \{[\s\S]*\}, prematch: true\b/.test(ss), 'a schedule start always asks for the pre-match')
  ok(/board\.mode = r && r\.prematch === true \? "clock" : "match"/.test(ss), 'and the mirror follows the board onto the clock')
  ok(/if \(prematchOn\) return;/.test(body('showBoardLive')), 'opening the Game tab does not lift the pre-match clock')
  const srvSet = (server.match(/PREMATCH_ACTIONS = new Set\(\[([^\]]*)\]\)/) || [])[1] || ''
  const uiSet = (js.match(/PREMATCH_ACTIONS = \[([^\]]*)\]/) || [])[1] || ''
  const norm = (x) => x.replace(/['"\s]/g, '').split(',').sort().join(',')
  ok(srvSet && norm(srvSet) === norm(uiSet), `the console keeps the pre-match on exactly the server's set-up actions (${norm(uiSet)})`)
  ok(/const keepsPre = prematchOn && PREMATCH_ACTIONS\.includes\(action\.type\)/.test(body('sendAction')) && /patch\.prematch = false/.test(body('sendAction')), 'a scoring action ends the pre-match on the console at once')
  ok(/postJSON\("\/api\/prematch", \{ action: "start" \}\)/.test(body('startMatchNow')), '"Start match now" is POST /api/prematch {action:start}')
  ok(/\$\("#warmupBtn"\)\.addEventListener\("click", startWarmup\)/.test(js) && /\$\("#pmWarmup"\)\.addEventListener\("click", startWarmup\)/.test(js), 'both warm-up buttons are one clock')
  ok(/if \(cb\) cb\(stopped\)/.test(body('finishCountdown')), 'the warm-up\'s end hands its onFinish the stop request')
  ok(/pre \? \(stopped\) =>/.test(body('startWarmup')) && /: null, \{ major: true, action: pre \? "End warm-up · start match" : "End warm-up"/.test(body('startWarmup')), 'outside a pre-match the warm-up is unchanged (no onFinish, same label)')
  ok(/<span class="pmready">Ready: <b id="pmTeams"><\/b> <span class="pmsub" id="pmSub">— board shows the clock<\/span><\/span>/.test(markup), 'banner reads "Ready: A vs B — board shows the clock"')
  ok(/id="pmWarmup"[^>]*>[\s\S]*?Start warm-up<\/button>/.test(markup) && /id="pmStart" class="primary">Start match now<\/button>/.test(markup), 'two big buttons: Start warm-up, Start match now')
  ok(/\.prematch \.pmbtns button\{[^}]*min-height:52px/.test(css), 'banner buttons are big')
  // renderPrematch against stubs
  const nodes = {}
  const node = (id) => (nodes[id] ||= { hidden: false, textContent: '' })
  const document = { body: { classList: { on: new Set(), toggle(c, v) { v ? this.on.add(c) : this.on.delete(c) } } } }
  const make = new Function('$', 'document', 'board',
    'let prematchOn = false;\nconst warmupRunning = () => board.mode === "countdown" && !!board.cd && board.cd.label === "WARM UP";\n' +
    lift(js, 'renderPrematch') + '\nreturn { renderPrematch, get on() { return prematchOn } };')
  const board = { mode: 'match', cd: null }
  const pm = make((sel) => node(sel), document, board)
  const st = { prematch: true, ledbox: { idle: true, clockHeld: true }, state: { team_a_short: 'KSCW H1', team_b_short: 'kscw h3' } }
  pm.renderPrematch(st)
  ok(nodes['#prematch'].hidden === false && document.body.classList.on.has('is-prematch'), 'status.prematch shows the banner')
  ok(nodes['#pmTeams'].textContent === 'KSCW H1 vs KSCW H3', 'home first, as on the schedule, upper-cased')
  ok(board.mode === 'clock' && nodes['#pmSub'].textContent === '— board shows the clock', 'mirror on the clock')
  board.mode = 'countdown'; board.cd = { label: 'WARM UP' }
  pm.renderPrematch(st)
  ok(board.mode === 'countdown' && nodes['#pmWarmup'].hidden === true && /warm-up running/.test(nodes['#pmSub'].textContent), 'a running warm-up keeps the mirror on the countdown and hides Start warm-up')
  board.mode = 'clock'; board.cd = null
  pm.renderPrematch({ ...st, prematch: false })
  ok(nodes['#prematch'].hidden === true && board.mode === 'match' && !pm.on, 'the pre-match ending elsewhere puts the mirror on the scoreboard')
}

console.log('\n[5] preview names at the board\'s own size')
{
  const make = new Function('SETTINGS', 'LAST_STATUS', 'SPORT', 'document',
    line(/const fontKey = [^\n]+/) + '\n' +
    'const NAME_WIDTH = { volleyball: 86, beach: 78, basketball: 62, simple: 86 };\nlet nameCanvas = null;\n' +
    lift(js, 'fitNameLocally') + '\n' + lift(js, 'nameFontSize') + '\nreturn nameFontSize;')
  const doc = { createElement: () => ({ getContext: () => ({ font: '', measureText(t) { return { width: t.length * (parseInt(this.font) * 0.7) } } }) }) }
  const fs1 = make({ matchFontMaxLeft: 18, matchFontMaxRight: 18 }, { board: { fontsize: { left: 18, right: 9 } } }, 'volleyball', doc)
  ok(fs1('left', 'KSCW H1') === 18 && fs1('right', 'VBC VOLLEY USTER') === 9, 'the board\'s per-side size is used as it is')
  const fs2 = make({ matchFontMaxLeft: 14, matchFontMaxRight: 18 }, { board: { fontsize: { left: 18, right: 9 } } }, 'volleyball', doc)
  ok(fs2('left', 'KSCW H1') === 14, 'a −/+ tap moves it before the next status (clamped to the new ceiling)')
  const fs3 = make({ matchFontMaxLeft: 18 }, {}, 'volleyball', doc)
  ok(fs3('left', 'AB') === 18 && fs3('left', 'A VERY LONG TEAM NAME') < 18, 'a board without board.fontsize falls back to measuring')
  ok(/board: \{ fontsize: matchFontsize\(\) \}/.test(server), 'the server sends board.fontsize on /api/status')
  const rp = body('renderPreview')
  ok(/nameFontSize\(side, text\.toUpperCase\(\)\)/.test(rp) && /el\.style\.maxWidth = col; el\.style\.overflow = "hidden"/.test(rp), 'the mirror sizes each name and keeps it in its column')
  ok(/renderPreview\(bvLast\.s, bvLast\.serving\);   \/\/ the mirror's name follows the tap too/.test(body('nudgeFont')) && /refreshStatus\(\);/.test(body('nudgeFont')), 'a name-size tap redraws the mirror now and fetches the board\'s size')
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — console-orientation: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
