// Renders the board screen's start picture: the Point Hub mark with a volleyball and a whistle on two
// crossed orbits (the same motion as svrz_rc's spinner), for the Plymouth boot theme (moving) and as
// the still picture behind the screen's apps while one starts (labwc + swaybg, pointhub-screen).
//
//   PLAYWRIGHT=/path/to/node_modules/playwright node firmware/screen-splash/gen.mjs
//
// Writes plymouth/{mark,ball,whistle,basketball,tracks,label,bar-track,bar-fill}.png, plymouth/words/*.png (the theme sprites, sized for a 1200-px-high screen;
// the theme scales them to the screen) and splash-1920x1200.png, splash-1280x800.png (the still).
// The ball and whistle are Game Icons (game-icons.net, CC BY 3.0, by Delapouite and Lorc), the same
// paths svrz_rc uses: credited in NOTICE.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright')
const dir = path.dirname(new URL(import.meta.url).pathname)
const icons = JSON.parse(fs.readFileSync(path.join(dir, 'icons.json'), 'utf8'))
const words = JSON.parse(fs.readFileSync(path.join(dir, 'words.json'), 'utf8'))
// The basketball is drawn here (no icon set needed): an orange ball and its four seams.
const basketballSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <circle cx="256" cy="256" r="236" fill="#F97316"/>
  <g fill="none" stroke="#1F2937" stroke-width="22" stroke-linecap="round">
    <circle cx="256" cy="256" r="236"/><path d="M256 20V492M20 256H492"/>
    <path d="M100 78C196 168 196 344 100 434M412 78C316 168 316 344 412 434"/></g></svg>`

// Geometry for a 1200-px-high screen: svrz_rc's spinner (box 186, orbits 78 x 32 tilted +-45 deg,
// satellites 33) at 3x, around the mark instead of a wordmark.
export const S = 3
export const BOX = 186 * S, RX = 78 * S, RY = 32 * S, SAT = 33 * S, MARK = 64 * S
// Three orbits a third of a lap apart: volleyball, whistle, basketball (svrz_rc has two at +-45).
export const TILTS = [60, -60, 0]
// Below the mark, for a 1200-px-high screen: the name, the progress bar, the rotating words.
export const LABEL_Y = BOX / 2 + 40, BAR_Y = LABEL_Y + 90, WORD_Y = BAR_Y + 40, BAR_W = 420, BAR_H = 8
const NAVY = '#111827', GOLD = '#FFC832', BALL = '#E7E5E4', WHISTLE = '#EF4444'

const markSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
  <circle cx="16" cy="16" r="10" fill="none" stroke="${GOLD}" stroke-width="2.6" opacity=".62" stroke-dasharray="14 6.6" stroke-dashoffset="3" stroke-linecap="round"/>
  <circle cx="16" cy="16" r="5.2" fill="${GOLD}"/></svg>`
const iconSvg = (d, colour, size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" fill="${colour}"><path d="${d}"/></svg>`
const ellipse = (deg) => {
  const r = deg * Math.PI / 180, c = BOX / 2, dx = RX * Math.cos(r), dy = RX * Math.sin(r)
  return `M ${c - dx},${c - dy} A ${RX},${RY} ${deg} 1 0 ${c + dx},${c + dy} A ${RX},${RY} ${deg} 1 0 ${c - dx},${c - dy}`
}
const tracksSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}">
  <g fill="none" stroke="#FFFFFF" stroke-opacity=".34" stroke-width="${1.6 * S}">${TILTS.map((d) => `<path d="${ellipse(d)}"/>`).join('')}</g></svg>`

// A point on the orbit tilted by `deg`, at parameter t (radians), relative to the box's centre.
export function orbit (deg, t) {
  const r = deg * Math.PI / 180
  return [RX * Math.cos(t) * Math.cos(r) - RY * Math.sin(t) * Math.sin(r), RX * Math.cos(t) * Math.sin(r) + RY * Math.sin(t) * Math.cos(r)]
}

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })
async function shot (html, w, h, file, transparent = true) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${transparent ? 'transparent' : NAVY}">${html}</body></html>`)
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } })
  console.log('wrote', path.relative(process.cwd(), file))
}
const shadow = 'filter: drop-shadow(0 2px 3px rgba(0,0,0,.45))'
await shot(markSvg(MARK), MARK, MARK, path.join(dir, 'plymouth', 'mark.png'))
await shot(`<div style="${shadow};padding:6px">${iconSvg(icons.ball, BALL, SAT)}</div>`, SAT + 12, SAT + 12, path.join(dir, 'plymouth', 'ball.png'))
await shot(`<div style="${shadow};padding:6px">${iconSvg(icons.whistle, WHISTLE, SAT)}</div>`, SAT + 12, SAT + 12, path.join(dir, 'plymouth', 'whistle.png'))
await shot(`<div style="${shadow};padding:6px">${basketballSvg(SAT)}</div>`, SAT + 12, SAT + 12, path.join(dir, 'plymouth', 'basketball.png'))
await shot(`<div style="width:${BAR_W}px;height:${BAR_H}px;border-radius:${BAR_H / 2}px;background:rgba(255,255,255,.14)"></div>`, BAR_W, BAR_H, path.join(dir, 'plymouth', 'bar-track.png'))
await shot(`<div style="width:${BAR_W}px;height:${BAR_H}px;border-radius:${BAR_H / 2}px;background:${GOLD}"></div>`, BAR_W, BAR_H, path.join(dir, 'plymouth', 'bar-fill.png'))
fs.mkdirSync(path.join(dir, 'plymouth', 'words'), { recursive: true })
for (const f of fs.readdirSync(path.join(dir, 'plymouth', 'words'))) fs.unlinkSync(path.join(dir, 'plymouth', 'words', f))
const wordHtml = (w) => `<div style="width:700px;text-align:center;color:#9CA3AF;font:500 30px Inter,'DejaVu Sans',sans-serif;line-height:44px">${w}</div>`
for (const [i, w] of words.entries()) await shot(wordHtml(w), 700, 44, path.join(dir, 'plymouth', 'words', `w${String(i).padStart(2, '0')}.png`))
await shot(tracksSvg, BOX, BOX, path.join(dir, 'plymouth', 'tracks.png'))
await shot(`<div style="width:600px;text-align:center;color:#9CA3AF;font:600 40px Inter,'DejaVu Sans',sans-serif;letter-spacing:2px;line-height:60px">Point Hub</div>`, 600, 60, path.join(dir, 'plymouth', 'label.png'))

// splash.html: the same picture moving, in a browser, behind an app while it starts (pointhub-screen).
// Self-contained (no fonts, no files): a 1200-px-high stage scaled to the window.
const orbitPath = (deg) => ellipse(deg)
// The page starts STILL_T s into the orbits, the frame the still (below) shows.
const STILL_T = 1.2
const satDiv = (svg, deg, i) => `<div class="sat" style="offset-path:path('${orbitPath(deg)}');animation-delay:${(-STILL_T - i * 2.8 / 3).toFixed(3)}s">${svg}</div>`
const splashHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Point Hub starting</title>
<!-- Generated by gen.mjs: edit that, not this. Ball and whistle: Game Icons (CC BY 3.0, NOTICE). -->
<style>
html, body { margin: 0; height: 100%; background: ${NAVY}; overflow: hidden; cursor: none; }
#stage { position: absolute; left: 50%; top: 50%; width: 1200px; height: 1200px; transform-origin: 50% 50%; }
#box { position: absolute; left: ${600 - BOX / 2}px; top: ${600 - 90 - BOX / 2}px; width: ${BOX}px; height: ${BOX}px; }
#box > svg, #mark { position: absolute; left: 0; top: 0; }
#mark { left: ${BOX / 2 - MARK / 2}px; top: ${BOX / 2 - MARK / 2}px; }
.sat { position: absolute; left: 0; top: 0; width: ${SAT}px; height: ${SAT}px; margin: ${-SAT / 2}px 0 0 ${-SAT / 2}px;
  offset-rotate: 0deg; offset-distance: 0%; animation: orbit 2.8s linear infinite; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
.sat svg { width: 100%; height: 100%; display: block; }
@keyframes orbit { to { offset-distance: 100%; } }
.line { position: absolute; left: 0; right: 0; display: flex; justify-content: center; font-family: Inter, 'DejaVu Sans', sans-serif; color: #9CA3AF; }
#label { top: ${600 - 90 + LABEL_Y}px; font-size: 40px; font-weight: 600; letter-spacing: 2px; line-height: 60px; }
#bar { top: ${600 - 90 + BAR_Y}px; }
#bar div { width: ${BAR_W}px; height: ${BAR_H}px; border-radius: ${BAR_H / 2}px; background: rgba(255,255,255,.14); overflow: hidden; }
#bar span { display: block; height: 100%; width: 50%; border-radius: inherit; background: ${GOLD}; transition: width .35s linear; }
#word { top: ${600 - 90 + WORD_Y}px; font-size: 30px; font-weight: 500; line-height: 44px; }
</style></head><body>
<div id="stage">
  <div id="box">${tracksSvg}<div id="mark">${markSvg(MARK)}</div>
    ${satDiv(iconSvg(icons.ball, BALL, SAT), TILTS[0], 0)}${satDiv(iconSvg(icons.whistle, WHISTLE, SAT), TILTS[1], 1)}${satDiv(basketballSvg(SAT), TILTS[2], 2)}</div>
  <div class="line" id="label">Point Hub</div>
  <div class="line" id="bar"><div><span></span></div></div>
  <div class="line" id="word">Starting…</div>
</div>
<script>
const words = ${JSON.stringify(words)}
const stage = document.getElementById('stage')
const fit = () => { stage.style.transform = 'translate(-50%, -50%) scale(' + (innerHeight / 1200) + ')' }
fit(); addEventListener('resize', fit)
// A phrase at random every 1.6 s, never the same twice in a row (as wiedisync's loading screen).
let last = -1
const word = document.getElementById('word')
setInterval(() => { let i = Math.floor(Math.random() * words.length); if (i === last) i = (i + 1) % words.length; last = i; word.textContent = words[i] }, 1600)
// The bar takes over from the boot picture at 50 % (pointhub.script fills 0-50 %) and climbs with
// ever smaller steps toward 92 %, so it always moves and never claims done.
let pct = 50
const fill = document.querySelector('#bar span')
setInterval(() => { if (pct < 92) pct += Math.max(0.5, (92 - pct) * 0.06); fill.style.width = pct + '%' }, 350)
</script></body></html>
`
fs.writeFileSync(path.join(dir, 'splash.html'), splashHtml)
console.log('wrote splash.html')

// The still (swaybg, up the moment labwc starts, under splash.html while Chromium starts): exactly
// splash.html's first frame, so the boot picture, the still and the moving page read as one.
for (const [w, h] of [[1920, 1200], [1280, 800]]) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(splashHtml.replace(/setInterval\([^\n]*\n/g, ''))
  // the orbits held at the moving page's first frame: its animations start STILL_T s in (the
  // delays), and one whole lap later (2.8 s) is the same frame
  await page.waitForTimeout(400)
  await page.evaluate(() => document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 2800 }))
  await page.waitForTimeout(100)
  const file = path.join(dir, `splash-${w}x${h}.png`)
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } })
  console.log('wrote', path.relative(process.cwd(), file))
}
await browser.close()
