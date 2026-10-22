import fs from 'node:fs';
import * as d from './draw.mjs';

const dir = new URL('.', import.meta.url).pathname;
// The idle crest the 3D view shows comes from openscore's golden images; pass another PNG to override.
const crestPath = process.argv[2] || new URL('../../../firmware/openscore/golden/03_kscw_crest.png', import.meta.url).pathname;
const crest = 'data:image/png;base64,' + fs.readFileSync(crestPath).toString('base64');
const scene = fs.readFileSync(dir + 'scene.js', 'utf8').replace('__CREST__', crest);

const parts = [
  ['A', 'Front frame', '1020 × 380, window 960 × 320', 1],
  ['B', 'Back panel', '1020 × 380, screwed on: the way in', 1],
  ['C', 'Top and bottom', '1020 × 208', 2],
  ['D', 'Ends', '208 × 368, window 160 × 320', 2],
  ['E', 'Battens 15 × 15', '2 × 1008 + corner blocks', 1],
  ['F', 'Steel bars', '20 × 3 × 368, galvanised', 3],
  ['G', 'Polycarbonate 3 mm, smoked', '990 × 350 + 2 × 172 × 332, about half the light through', 3],
  ['H', 'LED module P5', '64 × 32, black-body SMD, one batch (2 spare)', 10],
  ['I', 'Raspberry Pi 4', '1 GB is plenty', 1],
  ['J', 'Driver board', 'Adafruit Triple Bonnet (6358)', 1],
  ['K', 'Stacking header', '40 pin, tall', 1],
  ['M', 'microSD card', '32 GB, prepared by us; one spare', 2],
  ['N', 'Converter', 'Mean Well RSD-60G-5', 1],
  ['O', 'USB-C power board', 'STUSB4500', 1],
  ['P', 'USB-C extension', 'panel mount, 30 cm', 2],
  ['Q', 'Fuse box', '12-way, 5 A fuses ×14 (4 spare)', 1],
  ['R', 'Horn switch', 'MOSFET + I²C switch chip, plug, no horn', 1],
  ['S', 'Stand cup', '35 mm, with M4 screws', 1],
  ['T', 'Threaded inserts', '¼″ and ⅜″', 2],
  ['U', 'Rubber feet', '', 4],
  ['V', 'Handles', 'black, 128 mm', 2],
  ['W', 'Corner caps', 'black rubber, front corners', 4],
  ['Y', 'Backing plate', '208 × 140 plywood', 1],
  ['Z', 'Blanking plug', 'Ø30', 1],
];
const hardware = [
  ['screw20', 'Wood screw T20', '3.5 × 16', 66],
  ['screw20', 'Machine screw T20', 'M4 × 16, with nuts', 12],
  ['standoff', 'Standoffs', 'M2.5 for the Pi', 4],
  ['turn', 'Turn buttons', 'for the bench panels', 8],
  ['strap', 'Velcro strap, buckle', '50 mm × 1 m, for the table edge', 2],
  ['lan', 'USB-C hub: Ethernet + charging', 'RTL8153 with PD charging input, 15 cm patch cable', 1],
  ['pdsrc', 'Tablet charging module', 'USB-C PD out, about 18 W', 1],
  ['legs', 'Tilt legs (optional)', '40 × 50 mm plywood under the front edge, hinge with a stop', 2],
  ['sensor', 'Clock + temperature', 'DS3231 RTC, SHT40 sensor', 2],
  ['plate', 'Aluminium plate', '200 × 150 × 2, under converter + fuses', 1],
  ['small', 'Small parts', '5 A inline fuse, TVS SMBJ22A, 10 kΩ resistor', 1],
  ['sticker', 'Stickers', '“POINT HUB” lettering for the front, label for the back', 2],
  ['wire', 'Wire, red + black', '2.5 mm² 1 m · 1 mm² 2 m · ferrules', 1],
];
const toolList = [
  ['torx', 'Drill/driver', 'T10 + T20 bits'],
  ['drill', 'Wood drill bits', 'Ø2.5 · 3.2 · 4.5 · 8 · 12'],
  ['holesaw', 'Hole saws', 'Ø30 · Ø45'],
  ['jigsaw', 'Jigsaw', 'fine wood blade'],
  ['clamp', 'Two clamps', 'and wood glue'],
  ['ruler', 'Ruler, pencil', 'masking tape'],
  ['crimp', 'Crimp tool', 'for the ferrules'],
  ['meter', 'Multimeter', ''],
  ['usbm', 'USB-C power meter', 'about €12'],
];

const N = (t) => `<li class="n-info"><span class="ni" aria-hidden="true">i</span><span>${t}</span></li>`;
const OK = (t) => `<li class="n-ok"><span class="ni" aria-hidden="true">✓</span><span>${t}</span></li>`;
const NO = (t) => `<li class="n-no"><span class="ni" aria-hidden="true">✕</span><span>${t}</span></li>`;
const stages = [
  ['A', 'Case', 'Plywood, glue, paint. About 5 hours plus a day to dry.', [
    [1, 'Cut the parts', d.step1(), 'Seven rectangles from one 1250 × 1250 sheet of 6 mm poplar plywood. The store saw at Jumbo or Hornbach does these straight cuts.', [N('Poplar keeps the box light. Birch works too and adds about 1.5 kg.')]],
    [2, 'Cut windows and holes', d.step2(), 'Drill a hole in each window corner and join them with the jigsaw. Round holes with a hole saw or wood bit.', [OK('Masking tape on the cut line, good side down: no splinters.'), N('Check the USB-C cut-out against the sockets that actually arrive.')]],
    [3, 'Glue the shell', d.step3(), 'Glue and screw the bottom, both ends, the top and the front frame to the battens. The back panel B stays loose: it is screwed on last. Glue a 15 mm block into each corner of the back edge and one in the middle of the top and the bottom, flush with the edge: the back panel screws into them.', [N('Pre-drill Ø2.5 for every screw near an edge.')]],
    [4, 'Fit the bottom', d.step4(), 'Turn the box over. Glue the backing plate Y inside, then fit the stand cup, the two threaded inserts and the four feet.', []],
    [5, 'Paint', d.step5(), 'Round every outside edge with 120-grit sandpaper, about 3 mm. Then two coats of matte black, inside too, so nothing reflects behind the LEDs. The front face alone gets gloss black: behind the smoked sheet, the screen and its border read as one black surface when the board is off.', [N('Spray outdoors, or roll water-based paint indoors. Fill the plywood grain on the front face first, or it shows through the gloss.')]],
  ]],
  ['B', 'Panels', 'The box lies face-down from here until the electronics.', [
    [6, 'Front sheet in', d.step6(), 'Lay the box face-down on a blanket. Peel the film off the inner face of the smoked polycarbonate and drop it into the front frame. Same for the two small end sheets.', [N('Keep the outer film on until the very end: it protects against scratches.'), N('Smoked sheet: run the brightness about a fifth higher than behind clear. The contrast in a bright hall is much better.')]],
    [7, 'Six modules', d.step7(), 'Lay the modules on the sheet, LEDs down, all arrows pointing the same way. Connect the short ribbons 1 → 2 → 3 and 4 → 5 → 6.', [OK('Leave the IN of modules 1 and 4 free: the driver plugs in there.'), N('Before ordering, get a photo of the driver chips: plain chips like ICN2037 or FM6124 work, “S-PWM” chips like ICN2153 do not.')]],
    [8, 'Bars across', d.step8(), 'Lay three steel bars across the modules and screw them into the two long battens. The modules’ own magnets snap onto the bars: no screws, so a module swaps out in seconds.', [N('If your modules come without magnets, order M3 magnet standoffs from the same seller.')]],
    [9, 'Bench panels', d.step9(), 'One module behind each end window, arrows up. Twist four turn buttons over its edges.', [N('Stand the box upright again after this step.')]],
  ]],
  ['C', 'Electronics', 'Low voltage only: nothing in here can give you a shock.', [
    [10, 'Lay out the electronics', d.step10(), 'On the bottom panel behind the modules. Converter and fuse box sit on the aluminium plate. The DATA socket goes through a small USB-C hub to the Pi’s network port; the charging module feeds the hub, so the tablet charges over the same cable. Fit the two USB-C sockets in the back panel now; their cables reach inside. Put the Pi close to the back panel: its built-in Wi-Fi is the board’s only link to the internet.', [N('Leave 15 cm of slack on every cable so the back panel can come off.'), N('One 10 kΩ resistor keeps the panels dark while the Pi boots, so a weak charger can’t trip. The spot is marked on the wiring card.')]],
    [11, 'Power wiring', d.step11(), 'POWER socket → USB-C board → 5 A fuse → converter (1 mm²) → fuse box (2.5 mm²). A ferrule on every wire end. The small TVS diode goes across the POWER socket’s + and −.', [N('Connect the converter’s −Vin to −V: the USB-C board talks to the Pi and needs a shared ground.')]],
    [12, 'First power-up', d.step12(), 'Nothing else connected. Plug a small phone charger into POWER and measure at the fuse box.', [N('A weak charger is the safety net: it cannot push enough current to damage anything.')]],
    [13, 'Connect everything', d.step13(), 'Every panel and the Pi gets its own 5 A fuse. Ribbon OUT 1 to module 1, OUT 2 to module 4, OUT 3 to the left bench panel and on to the right one. The USB-C board, clock and temperature sensor share the I²C wires to pins 27 and 28 of the tall header.', [N('Panel power leads that don’t reach: extend with 1.5 mm².')]],
    [14, 'Test', d.step14(), 'With the back still open, slide in the SD card we prepared. Power up with a laptop charger: a test pattern runs on all eight modules. Leave it for 30 minutes.', []],
  ]],
  ['D', 'Finish', 'Ready for the hall.', [
    [15, 'Close up', d.step15(), 'Put the back panel on and drive in the six T20 screws. Handles on top, a black rubber cap on each front corner, and the plug in the horn hole. The back corners stay bare, so the back panel lifts straight off. The POINT HUB lettering goes on the bottom-right of the front border, the label beside the ports.', [N('The horn hole stays plugged: horn wiring is ready inside if you ever want one.')]],
    [16, 'Set it up', d.step16(), 'On the table, on a speaker stand, or on a tripod or light stand. On the table, loop a strap through each handle and around the back edge of the table. Charger into POWER, tablet into DATA: one cable carries the scores and charges the tablet, and the scorer PIN isn’t needed on it. The board joins the hall’s Wi-Fi for live scores, but has no Wi-Fi of its own: a laptop for setup or OpenVolley takes the same cable.', [OK('Any USB-C charger works from 18 W; 65 W or more gives full brightness and charges the tablet.'), N('Optional: fold out the two legs under the front edge. They lift the front 5.5 cm, so the screen tilts 15° up toward the first referee on the stand. It then leans on its back feet: keep the strap on. Raising it on a stand helps more against people in the way.'), NO('Never plug the DATA cable into the school’s network: it’s for the tablet or a laptop only.'), N('On a stand, put a sandbag on the feet instead of the strap.'), NO('Never in direct sun or by a sunny window: the box would overheat. It dims itself from 50 °C.'), N('Keep a flip scoreboard with digits of 12 cm or more in the kit: Swiss Volley requires one if the board fails.'), N('Coming in from a cold car: wait 45 minutes before switching on, or condensation can short the modules.')]],

    [17, 'Open it', d.step17(), 'Unplug the charger. Undo the six T20 screws and lift the back panel off: everything inside is in reach. The back panel carries the fuse map, four spare fuses and a spare SD card.', [OK('Swapping the SD card or a fuse takes under a minute.'), N('The back takes a T20 key on purpose: in a public hall, anything that opens by hand gets opened. Keep the key in the kit bag.'), N('The two USB-C cables can stay plugged in: set the back panel down next to the box.')]],  ]],
];

const partCards = parts.map(([L, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[L]}</div><div class="plabel"><span class="pl">${L}</span><span class="pn">${name}</span><span class="pq">×${n}</span></div><span class="ps">${spec}</span></li>`).join('');
const hwCards = hardware.map(([k, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[k]}</div><div class="plabel"><span class="pn">${name}</span><span class="pq">${n > 1 ? '×' + n : ''}</span></div><span class="ps">${spec}</span></li>`).join('');
const toolCards = toolList.map(([k, name, spec]) => `<li class="part tool"><div class="pic">${d.tools[k]}</div><div class="plabel"><span class="pn">${name}</span></div><span class="ps">${spec}</span></li>`).join('');
const two = (n) => String(n).padStart(2, '0');
const stageTimes = { A: 'about 5 h + a day to dry', B: 'about 2 h', C: 'about 4 h', D: 'about 1 h' };
const toc = stages.map(([L, name, , steps]) => `<a class="toc-i" href="#st-${L}"><span class="toc-l">${L}</span><span class="toc-n">${name}</span><span class="toc-s">${two(steps[0][0])}–${two(steps[steps.length - 1][0])}</span></a>`).join('');
const stageHtml = stages.map(([L, name, sub, steps]) => `
<section class="stage-sec" aria-labelledby="st-${L}-h" id="st-${L}">
  <header class="stage-head">
    <span class="sl" aria-hidden="true">${L}</span>
    <div class="stage-t"><h2 id="st-${L}-h">${name}</h2><p>${sub}</p></div>
    <span class="stage-time">${stageTimes[L]}</span>
  </header>
  ${steps.map(([n, title, art, cap, notes]) => `
  <article class="step" id="step-${n}">
    <div class="fig">${art}</div>
    <div class="txt">
      <div class="sh"><span class="num">${two(n)}</span><h3>${title}</h3></div>
      <p class="cap">${cap}</p>
      ${notes.length ? `<ul class="notes">${notes.join('')}</ul>` : ''}
    </div>
  </article>`).join('')}
</section>`).join('');

const html = `<title>Point Hub Assembly</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&family=Azeret+Mono:wght@400;500;600&family=Archivo+Narrow:wght@700&display=swap">
<style>
/* Layout: a product manual. A studio stage with the finished board up top, a one-line spec rail,
   then parts and tools as an inventory, then each step as a sheet: drawing left, words right. */
:root {
  --bg: #f3f4f5; --sheet: #ffffff; --ink: #111317; --mute: #626a73; --faint: #8b929a; --line: #dfe2e6;
  --accent: #a87700; --accent-ink: #ffffff;
  --shade: #eceef1; --shade2: #cdd2d8; --modback: #9aa3ad; --glass: #4a525b; --alu: #e1e5e9; --screen: #0c0d10; --gloss: #1d2024; --dot: #3a4049;
  --blue: #1f5fd6; --red: #cf2f26; --gold: #d29d00;
  --ok: #1f8a4c; --okbg: #e3f3e9; --no: #c4302b; --nobg: #fbe5e3; --info: #3b5ccc; --infobg: #e9eefc;
  --stage-hi: #f1f2f4; --stage-lo: #d3d7dc; --stage-ink: #1a1d21; --stage-mute: #5f666e; --stage-btn: rgba(255,255,255,.84); --stage-line: rgba(17,19,23,.12);
  --display: "Instrument Sans", "Helvetica Neue", Arial, sans-serif;
  --body: "Instrument Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "Azeret Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0c0d0f; --sheet: #141619; --ink: #eceef0; --mute: #9aa1a9; --faint: #6d747c; --line: #24282d;
  --accent: #f2b705; --accent-ink: #111317;
  --shade: #1c1f23; --shade2: #353b42; --modback: #4b545e; --glass: #8e99a5; --alu: #59616b; --screen: #050607; --gloss: #3b4148; --dot: #2a2f35;
  --blue: #79a3ff; --red: #ff6b61; --gold: #f0c12e;
  --ok: #52c784; --okbg: #11301e; --no: #ff6b61; --nobg: #3a1513; --info: #8fa9ff; --infobg: #172244;
  --stage-hi: #1a1c20; --stage-lo: #08090a; --stage-ink: #e6e8eb; --stage-mute: #8b929a; --stage-btn: rgba(22,24,27,.82); --stage-line: rgba(255,255,255,.12);
  color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0c0d0f; --sheet: #141619; --ink: #eceef0; --mute: #9aa1a9; --faint: #6d747c; --line: #24282d;
  --accent: #f2b705; --accent-ink: #111317;
  --shade: #1c1f23; --shade2: #353b42; --modback: #4b545e; --glass: #8e99a5; --alu: #59616b; --screen: #050607; --gloss: #3b4148; --dot: #2a2f35;
  --blue: #79a3ff; --red: #ff6b61; --gold: #f0c12e;
  --ok: #52c784; --okbg: #11301e; --no: #ff6b61; --nobg: #3a1513; --info: #8fa9ff; --infobg: #172244;
  --stage-hi: #1a1c20; --stage-lo: #08090a; --stage-ink: #e6e8eb; --stage-mute: #8b929a; --stage-btn: rgba(22,24,27,.82); --stage-line: rgba(255,255,255,.12);
  color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { background: var(--bg); color: var(--ink); font: 400 16px/1.6 var(--body); -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1200px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; }
p { margin: 0; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.label { font: 500 11px/1.3 var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--mute); }

/* top rail */
.rail { display: flex; flex-wrap: wrap; gap: 6px 22px; align-items: center; padding-block: 18px; }
.rail .club { font: 600 13px var(--display); letter-spacing: .02em; }
.rail .label:last-child { margin-left: auto; }

/* hero */
.hero-t { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 26rem); gap: 20px 48px; align-items: end; padding-block: 28px 30px; }
h1 { font-size: clamp(64px, 12vw, 152px); font-weight: 600; font-variation-settings: "wdth" 75; line-height: .82; letter-spacing: -.035em; }
.lede { color: var(--mute); font-size: 17px; line-height: 1.55; max-width: 42ch; }
.lede b { color: var(--ink); font-weight: 600; }

.stage { position: relative; background: radial-gradient(120% 90% at 50% 18%, var(--stage-hi), var(--stage-lo)); overflow: hidden; }
.view { position: relative; aspect-ratio: 16 / 7.6; max-width: 100%; max-height: 78vh; margin: 0 auto; }
#stage3d, #poster { position: absolute; inset: 0; }
#stage3d canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
#stage3d canvas:active { cursor: grabbing; }
#poster { display: grid; place-items: center; padding: 4% 10%; }
#poster .ill { max-height: 100%; width: auto; max-width: 100%; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding-block: 14px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); pointer-events: none; }
.bar > * { pointer-events: auto; }
.seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--stage-btn); box-shadow: inset 0 0 0 1px var(--stage-line); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.seg button { font: 500 12.5px var(--body); color: var(--stage-mute); background: transparent; border: 0; padding: 6px 12px; border-radius: 999px; cursor: pointer; }
.seg button:hover { color: var(--stage-ink); }
.seg button[aria-pressed="true"] { background: var(--stage-ink); color: var(--stage-lo); }
#stage-status { margin-left: auto; font: 500 11px var(--mono); letter-spacing: .04em; color: var(--stage-mute); }

.specs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin: 0; border-bottom: 1px solid var(--line); }
.specs div { padding: 16px 16px 16px 0; border-top: 1px solid var(--line); min-width: 0; }
.specs dt { font: 500 10.5px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--faint); }
.specs dd { margin: 4px 0 0; font: 600 18px/1.25 var(--display); font-variation-settings: "wdth" 88; font-variant-numeric: tabular-nums; }
.draft { padding-block: 14px 0; color: var(--faint); font: 400 12px/1.5 var(--mono); }

/* contents */
.toc { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-top: 56px; background: var(--line); border: 1px solid var(--line); }
.toc-i { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; column-gap: 12px; padding: 16px; background: var(--bg); text-decoration: none; }
.toc-i:hover { background: var(--sheet); }
.toc-l { grid-row: span 2; font: 600 40px/.9 var(--display); font-variation-settings: "wdth" 75; color: var(--accent); }
.toc-n { font: 600 16px var(--display); }
.toc-s { font: 500 11px var(--mono); color: var(--mute); letter-spacing: .05em; }

/* inventory */
section.block { padding-top: 72px; }
.bh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; margin-bottom: 18px; }
.bh h2 { font-size: 32px; font-weight: 600; font-variation-settings: "wdth" 80; letter-spacing: -.01em; }
.bh p { color: var(--mute); font-size: 14px; }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px; }
.part { background: var(--sheet); border-radius: 6px; padding: 12px 14px 14px; display: grid; gap: 6px; align-content: start; min-width: 0; }
.pic { padding: 4px 6px 2px; }
.pic .ico { width: 100%; height: auto; display: block; }
.plabel { display: flex; align-items: baseline; gap: 8px; }
.pl { flex: none; font: 600 11px var(--mono); color: var(--accent); }
.pn { font: 600 14px/1.25 var(--body); }
.pq { margin-left: auto; font: 500 13px var(--mono); color: var(--mute); font-variant-numeric: tabular-nums; }
.ps { font: 400 12px/1.4 var(--body); color: var(--mute); }
.subh { margin: 26px 0 10px; }

/* steps */
.stage-sec { padding-top: 88px; scroll-margin-top: 16px; }
.stage-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: end; gap: 18px; padding-bottom: 18px; border-bottom: 1px solid var(--ink); }
.sl { font: 600 88px/.78 var(--display); font-variation-settings: "wdth" 75; color: var(--accent); }
.stage-t h2 { font-size: 34px; font-weight: 600; font-variation-settings: "wdth" 80; letter-spacing: -.01em; }
.stage-t p { color: var(--mute); }
.stage-time { font: 500 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--mute); padding-bottom: 6px; }
.step { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 20px 40px; align-items: start; padding-block: 36px; border-bottom: 1px solid var(--line); scroll-margin-top: 16px; }
.fig { background: var(--sheet); border-radius: 8px; padding: 18px; overflow-x: auto; min-width: 0; }
.fig .ill { width: 100%; height: auto; display: block; }
.txt { min-width: 0; display: grid; gap: 14px; padding-top: 6px; }
.sh { display: grid; gap: 4px; }
.num { font: 500 13px var(--mono); letter-spacing: .08em; color: var(--accent); }
.sh h3 { font-size: 26px; font-weight: 600; font-variation-settings: "wdth" 85; letter-spacing: -.01em; line-height: 1.1; }
.cap { font-size: 16px; max-width: 60ch; }
.notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-width: 60ch; }
.notes li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 14px; color: var(--mute); }
.notes li > span:last-child { min-width: 0; }
.ni { width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; font: 600 10px var(--mono); margin-top: 2px; }
.n-info .ni { background: var(--infobg); color: var(--info); }
.n-ok .ni { background: var(--okbg); color: var(--ok); }
.n-no .ni { background: var(--nobg); color: var(--no); }
.notes .n-no { color: var(--ink); }
footer.end { margin-top: 72px; padding-block: 24px 56px; border-top: 1px solid var(--line); color: var(--mute); font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px 28px; }

/* drawings */
.ill { overflow: visible; }
.o { stroke: var(--ink); stroke-width: 1.1; stroke-linejoin: round; stroke-linecap: round; }
.p0 { fill: var(--sheet); } .p1 { fill: var(--shade); } .p2 { fill: var(--shade2); } .p2m { fill: var(--modback); }
.nf { fill: none; } .dash { stroke-dasharray: 4 4; } .gh { fill: var(--sheet); fill-opacity: .5; }
.pc { fill: var(--glass); fill-opacity: .42; } .gl { fill: var(--gloss); } .al { fill: var(--alu); } .dark, .screen { fill: var(--screen); } .fuse { fill: var(--gold); }
.hatchf { fill: url(#hatch); } .dotsf { fill: url(#dots); } .grad { fill: url(#ramp); } .lit { fill: url(#benchg); }
.hbg { fill: var(--sheet); } .hln { stroke: var(--shade2); stroke-width: 1; } .dln { fill: var(--dot); }
.glare { stroke: var(--sheet); stroke-width: 2.5; stroke-linecap: round; opacity: .7; }
.ar { stroke: var(--accent); stroke-width: 2; fill: none; stroke-linecap: round; } .ah { fill: var(--accent); }
.magc { stroke-width: 1.6; }
.handle { fill: none; stroke: var(--ink); stroke-width: 4.5; stroke-linecap: round; }
.wr { stroke: var(--red); stroke-width: 2.6; fill: none; stroke-linecap: round; }
.wb { stroke: var(--ink); stroke-width: 2.6; fill: none; stroke-linecap: round; }
.wd { stroke: var(--blue); stroke-width: 2.1; fill: none; stroke-linecap: round; }
.wg { stroke: var(--gold); stroke-width: 2.8; fill: none; stroke-linecap: round; }
.strap0 { stroke: var(--ink); stroke-width: 6; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.strap1 { stroke: var(--blue); stroke-width: 3.6; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.rib0 { stroke: var(--ink); stroke-width: 6.4; fill: none; stroke-linecap: round; }
.rib1 { stroke: var(--shade2); stroke-width: 4; fill: none; stroke-linecap: round; }
.ringg { fill: none; stroke: var(--gold); stroke-width: 2.6; } .ringb { fill: none; stroke: var(--blue); stroke-width: 2.6; }
.okc { fill: var(--okbg); stroke: var(--ok); stroke-width: 1.4; } .okm { fill: none; stroke: var(--ok); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.noc { fill: var(--nobg); stroke: var(--no); stroke-width: 1.4; } .nom { fill: none; stroke: var(--no); stroke-width: 2.4; stroke-linecap: round; }
.thin { stroke-width: .7; } .thin2 { stroke-width: 1.5; } .thick { stroke-width: 2.2; } .thick2 { stroke-width: 3.6; }
.t, .tm, .ts, .tt, .tb, .tn, .tc, .tl, .tlb { fill: var(--ink); }
.tm { font: 500 10px var(--mono); fill: var(--mute); } .ts { font: 400 11.5px var(--body); fill: var(--mute); } .tt { font: 500 8px var(--mono); letter-spacing: .03em; }
.tb { font: 600 10.5px var(--mono); } .tn { font: 600 10px var(--mono); } .tc { font: 600 15px var(--display); font-variation-settings: "wdth" 80; }
.tl { font: 400 12.5px var(--body); } .tlb { font: 600 13px var(--body); }
.tled { font: 600 11px var(--mono); fill: #7dff9a; } .tled2 { font: 600 9px var(--mono); fill: #7dff9a; }
.halo { paint-order: stroke; stroke: var(--sheet); stroke-width: 3.5px; stroke-linejoin: round; }
.led { font: 700 34px "Archivo Narrow", "Arial Narrow", sans-serif; text-anchor: middle; } .led-b { fill: #3b78ff; } .led-o { fill: #ff6a2b; }
.leds { font: 700 12px "Archivo Narrow", sans-serif; fill: #e8ecf2; }
.po-f { fill: #0a0b0d; stroke: #2a2e34; stroke-width: 1; } .po-t { fill: #1b1d21; stroke: #2a2e34; stroke-width: 1; }
.po-s { fill: #131518; stroke: #2a2e34; stroke-width: 1; } .po-scr { fill: #030304; stroke: #1b1e22; stroke-width: .8; }
.po-h { fill: none; stroke: #16181b; stroke-width: 5; stroke-linecap: round; }
.pled { font: 700 110px "Archivo Narrow", "Arial Narrow", sans-serif; } .pled-b { fill: #3b78ff; } .pled-o { fill: #ff6a2b; }
.pleds { font: 700 36px "Archivo Narrow", sans-serif; fill: #e8ecf2; } .pledn { font: 700 26px "Archivo Narrow", sans-serif; }

@media (max-width: 980px) {
  .step { grid-template-columns: minmax(0, 1fr); }
  .txt { padding-top: 0; }
}
@media (max-width: 760px) {
  .hero-t { grid-template-columns: minmax(0, 1fr); padding-block: 18px 22px; }
  .view { aspect-ratio: 4 / 3.6; }
  .specs, .toc { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stage-head { grid-template-columns: auto minmax(0, 1fr); }
  .stage-time { grid-column: 1 / -1; padding-bottom: 0; }
  .sl { font-size: 64px; }
  .fig { padding: 12px; }
  .fig .ill { min-width: 600px; }
  #stage-status { display: none; }
  .bar { position: static; justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style>

<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
  <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hbg"/><line x1="0" y1="0" x2="0" y2="6" class="hln"/></pattern>
  <pattern id="dots" width="4.6" height="4.6" patternUnits="userSpaceOnUse"><circle cx="2.3" cy="2.3" r="1.15" class="dln"/></pattern>
  <linearGradient id="ramp" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
  <linearGradient id="benchg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".25" stop-color="#ffd400"/><stop offset=".5" stop-color="#00e050"/><stop offset=".75" stop-color="#ff3df0"/><stop offset="1" stop-color="#2a5bff"/></linearGradient>
</defs></svg>

<header class="wrap rail">
  <span class="club">KSC Wiedikon</span>
  <span class="label">Build manual</span>
  <span class="label">Draft · 22.10.2026</span>
</header>

<div class="wrap hero-t">
  <h1>Point Hub</h1>
  <p class="lede"><b>Our own scoreboard.</b> 1.67 times the size of the Tech4Sport box, a small score panel facing each bench, two USB-C ports and nothing else. Seventeen steps over a weekend.</p>
</div>

<section class="stage" aria-label="3D view of the finished Point Hub board">
  <div class="view">
    <div id="poster">${d.poster()}</div>
    <div id="stage3d" hidden></div>
  </div>
  <div class="bar">
    <div class="seg" role="group" aria-label="Screen"><button type="button" data-screen="match" aria-pressed="true">Match</button><button type="button" data-screen="idle" aria-pressed="false">Idle</button><button type="button" data-screen="test" aria-pressed="false">Test</button></div>
    <div class="seg" role="group" aria-label="Mount"><button type="button" data-mount="studio" aria-pressed="true">Studio</button><button type="button" data-mount="table" aria-pressed="false">Table</button><button type="button" data-mount="tilt" aria-pressed="false">Tilted 15°</button><button type="button" data-mount="speaker" aria-pressed="false">Speaker stand</button><button type="button" data-mount="tripod" aria-pressed="false">Tripod</button></div>
    <div class="seg" role="group" aria-label="View"><button type="button" data-view="three" aria-pressed="true">¾</button><button type="button" data-view="front" aria-pressed="false">Front</button><button type="button" data-view="bench" aria-pressed="false">Bench</button><button type="button" data-view="back" aria-pressed="false">Back</button></div>
    <span id="stage-status">Loading the 3D view…</span>
  </div>
</section>

<div class="wrap">
  <dl class="specs">
    <div><dt>Size</dt><dd>102 × 38 × 22 cm</dd></div>
    <div><dt>Weight</dt><dd>about 8 kg</dd></div>
    <div><dt>Main screen</dt><dd>192 × 64 LEDs, 5 mm</dd></div>
    <div><dt>Bench panels</dt><dd>2 × 32 × 64 LEDs</dd></div>
    <div><dt>Power</dt><dd>USB-C charger, 65 W+</dd></div>
    <div><dt>Ports</dt><dd>2 × USB-C</dd></div>
    <div><dt>Parts</dt><dd>about €550</dd></div>
    <div><dt>Build time</dt><dd>12–15 h + drying</dd></div>
  </dl>
  <p class="draft">Sizes in the steps still depend on the exact parts that arrive.</p>

  <nav class="toc" aria-label="Stages">${toc}</nav>

  <section class="block" aria-labelledby="parts-h">
    <div class="bh"><h2 id="parts-h">In the box</h2><p>Letters match the drawings.</p></div>
    <ul class="grid">${partCards}</ul>
    <div class="label subh">Screws and wire</div>
    <ul class="grid">${hwCards}</ul>
  </section>

  <section class="block" aria-labelledby="tools-h">
    <div class="bh"><h2 id="tools-h">Tools</h2><p>All of it fits a normal home toolbox.</p></div>
    <ul class="grid">${toolCards}</ul>
  </section>

  ${stageHtml}

  <footer class="end">
    <p>KSC Wiedikon · Point Hub board build manual, draft of 22 October 2026.</p>
    <p>The panel software comes ready on the SD card in step 14.</p>
  </footer>
</div>

<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
${scene}
</script>
`;
// Standalone: a doctype and viewport so it opens straight from the repo in any browser.
fs.writeFileSync(dir + 'build-manual.html', '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' + html + '</html>\n');
// GUIDE_BARE=<file>: the same page without the document skeleton, for hosts that add their own.
if (process.env.GUIDE_BARE) fs.writeFileSync(process.env.GUIDE_BARE, html);
console.log('wrote', html.length, 'bytes');
