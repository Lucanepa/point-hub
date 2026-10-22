import fs from 'node:fs';
import * as d from './draw.mjs';

const dir = new URL('.', import.meta.url).pathname;
// The idle crest the 3D view shows comes from openscore's golden images; pass another PNG to override.
const crestPath = process.argv[2] || new URL('../../../firmware/openscore/golden/03_kscw_crest.png', import.meta.url).pathname;
const crest = 'data:image/png;base64,' + fs.readFileSync(crestPath).toString('base64');
const scene = fs.readFileSync(dir + 'scene.js', 'utf8').replace('__CREST__', crest);

const parts = [
  ['A', 'Front frame', '1020 × 380, window 960 × 320', 1],
  ['B', 'Back panel', '1020 × 380, the service door', 1],
  ['C', 'Top and bottom', '1020 × 208', 2],
  ['D', 'Ends', '208 × 368, window 160 × 320', 2],
  ['E', 'Battens 15 × 15', '2 × 1008 + corner blocks', 1],
  ['F', 'Steel bars', '20 × 3 × 368, galvanised', 3],
  ['G', 'Polycarbonate 3 mm', '990 × 350 + 2 × 172 × 332', 3],
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
  ['V', 'Handles', '', 2],
  ['W', 'Metal corners', '30 mm, front corners', 4],
  ['X', 'Door screws', 'M4 × 16 T20, with inserts', 2],
  ['Y', 'Backing plate', '208 × 140 plywood', 1],
  ['Z', 'Blanking plug', 'Ø30', 1],
];
const hardware = [
  ['screw20', 'Wood screw T20', '3.5 × 16', 60],
  ['screw20', 'Machine screw T20', 'M4 × 16, with nuts', 12],
  ['standoff', 'Standoffs', 'M2.5 for the Pi', 4],
  ['turn', 'Turn buttons', 'for the bench panels', 8],
  ['hook', 'Door hooks', 'small L brackets', 2],
  ['guard', 'Rubber corner guards', 'back corners', 4],
  ['strap', 'Velcro strap, buckle', '50 mm × 1 m, for the table edge', 2],
  ['lan', 'USB-C hub: Ethernet + charging', 'RTL8153 with PD charging input, 15 cm patch cable', 1],
  ['pdsrc', 'Tablet charging module', 'USB-C PD out, about 18 W', 1],
  ['legs', 'Tilt legs (optional)', 'plywood, hinges with a stop, 10–15°', 2],
  ['sensor', 'Clock + temperature', 'DS3231 RTC, SHT40 sensor', 2],
  ['plate', 'Aluminium plate', '200 × 150 × 2, under converter + fuses', 1],
  ['small', 'Small parts', '5 A inline fuse, TVS SMBJ22A, 10 kΩ resistor', 1],
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
    [3, 'Glue the shell', d.step3(), 'Glue and screw the bottom, both ends, the top and the front frame to the battens. The back panel B stays loose: it becomes the service door.', [N('Pre-drill Ø2.5 for every screw near an edge.')]],
    [4, 'Fit the bottom', d.step4(), 'Turn the box over. Glue the backing plate Y inside, then fit the stand cup, the two threaded inserts and the four feet.', []],
    [5, 'Paint', d.step5(), 'Two coats of matte black, inside too, so nothing reflects behind the LEDs. Spray outdoors, or roll water-based paint indoors.', []],
  ]],
  ['B', 'Panels', 'The box lies face-down from here until the electronics.', [
    [6, 'Front sheet in', d.step6(), 'Lay the box face-down on a blanket. Peel the film off the inner face of the polycarbonate and drop it into the front frame. Same for the two small end sheets.', [N('Keep the outer film on until the very end: it protects against scratches.')]],
    [7, 'Six modules', d.step7(), 'Lay the modules on the sheet, LEDs down, all arrows pointing the same way. Connect the short ribbons 1 → 2 → 3 and 4 → 5 → 6.', [OK('Leave the IN of modules 1 and 4 free: the driver plugs in there.'), N('Before ordering, get a photo of the driver chips: plain chips like ICN2037 or FM6124 work, “S-PWM” chips like ICN2153 do not.')]],
    [8, 'Bars across', d.step8(), 'Lay three steel bars across the modules and screw them into the two long battens. The modules’ own magnets snap onto the bars: no screws, so a module swaps out in seconds.', [N('If your modules come without magnets, order M3 magnet standoffs from the same seller.')]],
    [9, 'Bench panels', d.step9(), 'One module behind each end window, arrows up. Twist four turn buttons over its edges.', [N('Stand the box upright again after this step.')]],
  ]],
  ['C', 'Electronics', 'Low voltage only: nothing in here can give you a shock.', [
    [10, 'Lay out the electronics', d.step10(), 'On the bottom panel behind the modules. Converter and fuse box sit on the aluminium plate. The DATA socket goes through a small USB-C hub to the Pi’s network port; the charging module feeds the hub, so the tablet charges over the same cable. Fit the two USB-C sockets in the back panel now; their cables reach inside. Put the Pi close to the back door: its built-in Wi-Fi is the board’s only link to the internet.', [N('Leave 15 cm of slack on every cable so the back door can come off.'), N('One 10 kΩ resistor keeps the panels dark while the Pi boots, so a weak charger can’t trip. The spot is marked on the wiring card.')]],
    [11, 'Power wiring', d.step11(), 'POWER socket → USB-C board → 5 A fuse → converter (1 mm²) → fuse box (2.5 mm²). A ferrule on every wire end. The small TVS diode goes across the POWER socket’s + and −.', [N('Connect the converter’s −Vin to −V: the USB-C board talks to the Pi and needs a shared ground.')]],
    [12, 'First power-up', d.step12(), 'Nothing else connected. Plug a small phone charger into POWER and measure at the fuse box.', [N('A weak charger is the safety net: it cannot push enough current to damage anything.')]],
    [13, 'Connect everything', d.step13(), 'Every panel and the Pi gets its own 5 A fuse. Ribbon OUT 1 to module 1, OUT 2 to module 4, OUT 3 to the left bench panel and on to the right one. The USB-C board, clock and temperature sensor share the I²C wires to pins 27 and 28 of the tall header.', [N('Panel power leads that don’t reach: extend with 1.5 mm².')]],
    [14, 'Test', d.step14(), 'With the back still open, slide in the SD card we prepared. Power up with a laptop charger: a test pattern runs on all eight modules. Leave it for 30 minutes.', []],
  ]],
  ['D', 'Finish', 'Ready for the hall.', [
    [15, 'Close up', d.step15(), 'Hook the door’s bottom edge behind the two hooks, tilt it shut and drive in the two T20 door screws. Handles on top, metal corners at the front, rubber guards at the back, and the plug in the horn hole.', [N('The horn hole stays plugged: horn wiring is ready inside if you ever want one.')]],
    [16, 'Set it up', d.step16(), 'On the table, on a speaker stand, or on a tripod or light stand. On the table, loop a strap through each handle and around the back edge of the table. Charger into POWER, tablet into DATA: one cable carries the scores and charges the tablet, and the scorer PIN isn’t needed on it. The board joins the hall’s Wi-Fi for live scores, but has no Wi-Fi of its own: a laptop for setup or OpenVolley takes the same cable.', [OK('Any USB-C charger works from 18 W; 65 W or more gives full brightness and charges the tablet.'), N('Optional: fold out the two back legs to tilt it 10–15° toward the referee. Raising it on a stand helps more against people in the way.'), NO('Never plug the DATA cable into the school’s network: it’s for the tablet or a laptop only.'), N('On a stand, put a sandbag on the feet instead of the strap.'), NO('Never in direct sun or by a sunny window: the box would overheat. It dims itself from 50 °C.'), N('Keep a flip scoreboard with digits of 12 cm or more in the kit: Swiss Volley requires one if the board fails.'), N('Coming in from a cold car: wait 45 minutes before switching on, or condensation can short the modules.')]],

    [17, 'Open it', d.step17(), 'Unplug the charger. Undo the two T20 door screws, tilt the door back, lift it off the hooks: everything inside is in reach. The door carries the fuse map, four spare fuses and a spare SD card.', [OK('Swapping the SD card or a fuse takes under a minute.'), N('The door takes a T20 key on purpose: in a public hall, a door that opens by hand gets opened. Keep the key in the kit bag.'), N('The two USB-C cables can stay plugged in: set the door down next to the box.')]],  ]],
];

const partCards = parts.map(([L, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[L]}</div><div class="plabel"><span class="pl">${L}</span><span class="pn">${name}</span><span class="pc">×${n}</span></div><span class="ps">${spec}</span></li>`).join('');
const hwCards = hardware.map(([k, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[k]}</div><div class="plabel"><span class="pn">${name}</span><span class="pc">${n > 1 ? '×' + n : ''}</span></div><span class="ps">${spec}</span></li>`).join('');
const toolCards = toolList.map(([k, name, spec]) => `<li class="tool"><div class="pic">${d.tools[k]}</div><span class="pn">${name}</span><span class="ps">${spec}</span></li>`).join('');
const stageHtml = stages.map(([L, name, sub, steps]) => `
<section class="stage-sec" aria-labelledby="st-${L}">
  <header class="stage-head"><span class="sl">${L}</span><div><h2 id="st-${L}">${name}</h2><p>${sub}</p></div></header>
  ${steps.map(([n, title, art, cap, notes]) => `
  <article class="step" id="step-${n}">
    <header class="sh"><span class="num">${n}</span><h3>${title}</h3></header>
    <div class="fig">${art}</div>
    <p class="cap">${cap}</p>
    ${notes.length ? `<ul class="notes">${notes.join('')}</ul>` : ''}
  </article>`).join('')}
</section>`).join('');

const html = `<title>Point Hub Assembly</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Archivo+Narrow:wght@600;700&family=Atkinson+Hyperlegible:wght@400;700&family=Azeret+Mono:wght@400;600&display=swap">
<style>
/* Layout: an assembly manual. Masthead + live product stage, then parts, tools and
   numbered step sheets in one reading column; drawings are line art on paper. */
:root {
  --paper: #fafbfa; --ink: #15171a; --mute: #5b6168; --line: #d6dadd;
  --shade: #eceeef; --shade2: #c5cbd0; --modback: #98a1aa; --glass: #bcd7e6; --alu: #dfe3e7; --screen: #0e1013; --dot: #3a4049;
  --gold: #d29d00; --blue: #1f5fd6; --red: #cf2f26;
  --ok: #1f8a4c; --okbg: #e2f3e9; --no: #c4302b; --nobg: #fbe4e2; --info: #1f5fd6; --infobg: #e6eefc;
  --stage: #0e1013; --stage-ink: #cfd4da; --stage-face: #1d2025; --stage-face2: #272b31; --stage-mute: #8a929b;
  --display: "Archivo", "Arial Narrow", Arial, sans-serif;
  --body: "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif;
  --mono: "Azeret Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #111316; --ink: #e8ebee; --mute: #9aa2ab; --line: #2b3036;
  --shade: #1c2025; --shade2: #3a414a; --modback: #4b545e; --glass: #2a4757; --alu: #59616b; --screen: #050607; --dot: #2a2f35;
  --gold: #f0c12e; --blue: #79a3ff; --red: #ff6b61;
  --ok: #52c784; --okbg: #11301e; --no: #ff6b61; --nobg: #3a1513; --info: #79a3ff; --infobg: #142445; color-scheme: dark; } }
:root[data-theme="dark"] {
  --paper: #111316; --ink: #e8ebee; --mute: #9aa2ab; --line: #2b3036;
  --shade: #1c2025; --shade2: #3a414a; --modback: #4b545e; --glass: #2a4757; --alu: #59616b; --screen: #050607; --dot: #2a2f35;
  --gold: #f0c12e; --blue: #79a3ff; --red: #ff6b61;
  --ok: #52c784; --okbg: #11301e; --no: #ff6b61; --nobg: #3a1513; --info: #79a3ff; --infobg: #142445; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--paper); color: var(--ink); font: 400 16px/1.55 var(--body); }
.wrap { max-width: 1180px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.col { max-width: 900px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; }
p { margin: 0; }

.mast { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 32px; align-items: end; padding-block: 40px 22px; border-bottom: 3px solid var(--ink); }
.eyebrow { font: 600 12px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--mute); }
h1 { font-size: clamp(54px, 9vw, 112px); font-weight: 860; font-variation-settings: "wdth" 72; line-height: .86; letter-spacing: -.015em; margin-top: 10px; }
h1 em { font-style: normal; font-variation-settings: "wdth" 125; font-weight: 900; }
.lede { margin-top: 14px; max-width: 46ch; color: var(--mute); font-size: 17px; }
.specs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; margin: 0; border-top: 1.5px solid var(--ink); }
.specs div { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.specs dt { font: 600 10.5px var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--mute); }
.specs dd { margin: 2px 0 0; font: 700 17px/1.25 var(--display); font-variation-settings: "wdth" 88; font-variant-numeric: tabular-nums; }

.stage { margin-top: 24px; background: var(--stage); color: var(--stage-ink); border-radius: 3px; overflow: hidden; }
.view { position: relative; aspect-ratio: 16 / 8.4; max-width: 100%; }
#stage3d, #poster { position: absolute; inset: 0; }
#stage3d canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
#poster { display: grid; place-items: center; padding: 3% 6%; }
#poster .ill { max-height: 100%; width: auto; max-width: 100%; }
.bar { display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center; padding: 12px 16px 14px; border-top: 1px solid #23272d; }
.grp { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.grp > span { font: 600 10.5px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--stage-mute); }
.seg { display: inline-flex; border: 1px solid #3a4048; border-radius: 3px; overflow: hidden; }
.seg button { font: 600 13px var(--body); color: var(--stage-ink); background: transparent; border: 0; padding: 7px 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid #3a4048; }
.seg button[aria-pressed="true"] { background: var(--stage-ink); color: var(--stage); }
.seg button:focus-visible { outline: 2px solid #ffc21a; outline-offset: -2px; }
#stage-status { margin-left: auto; font: 500 12px var(--mono); color: var(--stage-mute); }

.draft { margin-top: 18px; display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: var(--mute); }
.draft b { color: var(--ink); }

section.block { padding-block: 44px 8px; }
.bh { display: flex; align-items: baseline; gap: 14px; border-bottom: 1.5px solid var(--ink); padding-bottom: 8px; margin-bottom: 18px; }
.bh h2 { font-size: 30px; font-weight: 820; font-variation-settings: "wdth" 80; }
.bh p { color: var(--mute); font-size: 14px; }
.grid { list-style: none; margin: 0; padding: 1px; display: grid; grid-template-columns: repeat(auto-fill, minmax(156px, 1fr)); gap: 1px; }
.part, .tool { background: var(--paper); box-shadow: 0 0 0 1px var(--line); padding: 10px 12px 12px; display: grid; gap: 4px; align-content: start; min-width: 0; }
.pic .ico { width: 100%; height: auto; display: block; }
.plabel { display: flex; align-items: center; gap: 7px; }
.pl { display: inline-grid; place-items: center; width: 20px; height: 20px; border: 1.5px solid var(--ink); border-radius: 2px; font: 800 12px var(--display); flex: none; }
.pn { font: 700 14px/1.2 var(--body); }
.pc { margin-left: auto; font: 800 17px var(--display); font-variant-numeric: tabular-nums; }
.ps { font: 500 11.5px/1.35 var(--mono); color: var(--mute); }
.subh { font: 700 13px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--mute); margin: 22px 0 10px; }

.stage-sec { padding-top: 56px; }
.stage-head { display: flex; gap: 18px; align-items: center; padding-bottom: 6px; }
.sl { font: 900 72px/.8 var(--display); font-variation-settings: "wdth" 70; }
.stage-head h2 { font-size: 34px; font-weight: 820; font-variation-settings: "wdth" 78; }
.stage-head p { color: var(--mute); }
.step { display: grid; grid-template-columns: 84px minmax(0, 1fr); column-gap: 20px; padding-block: 26px 30px; border-top: 1.5px solid var(--ink); }
.step > * { grid-column: 2; min-width: 0; }
.step .sh { grid-column: 1 / -1; display: grid; grid-template-columns: 84px minmax(0, 1fr); column-gap: 20px; align-items: baseline; margin-bottom: 6px; }
.num { font: 900 76px/.8 var(--display); font-variation-settings: "wdth" 66; font-variant-numeric: tabular-nums; }
.sh h3 { font-size: 22px; font-weight: 760; font-variation-settings: "wdth" 85; }
.fig { overflow-x: auto; margin-top: 4px; }
.fig .ill { width: 100%; height: auto; display: block; }
.cap { margin-top: 12px; max-width: 64ch; font-size: 16.5px; }
.notes { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; max-width: 64ch; }
.notes li { display: flex; gap: 10px; align-items: flex-start; font-size: 14.5px; }
.ni { flex: none; width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font: 800 12px var(--display); margin-top: 1px; }
.n-info .ni { background: var(--infobg); color: var(--info); border: 1.5px solid var(--info); font-style: italic; font-family: Georgia, serif; }
.n-ok .ni { background: var(--okbg); color: var(--ok); border: 1.5px solid var(--ok); }
.n-no .ni { background: var(--nobg); color: var(--no); border: 1.5px solid var(--no); }
footer.end { margin-top: 56px; padding-block: 22px 48px; border-top: 3px solid var(--ink); color: var(--mute); font-size: 14px; display: grid; gap: 6px; }

/* drawings */
.ill { overflow: visible; }
.o { stroke: var(--ink); stroke-width: 1.35; stroke-linejoin: round; stroke-linecap: round; }
.p0 { fill: var(--paper); } .p1 { fill: var(--shade); } .p2 { fill: var(--shade2); } .p2m { fill: var(--modback); }
.nf { fill: none; } .dash { stroke-dasharray: 5 4; } .gh { fill: var(--paper); fill-opacity: .5; }
.pc { fill: var(--glass); fill-opacity: .6; } .al { fill: var(--alu); } .dark, .screen { fill: var(--screen); } .fuse { fill: var(--gold); }
.hatchf { fill: url(#hatch); } .dotsf { fill: url(#dots); } .grad { fill: url(#ramp); } .lit { fill: url(#benchg); }
.hbg { fill: var(--paper); } .hln { stroke: var(--mute); stroke-width: 1.1; } .dln { fill: var(--dot); }
.glare { stroke: var(--paper); stroke-width: 3; stroke-linecap: round; opacity: .85; }
.ar { stroke: var(--ink); stroke-width: 2.2; fill: none; stroke-linecap: round; } .ah { fill: var(--ink); }
.magc { stroke-width: 2.2; }
.handle { fill: none; stroke: var(--ink); stroke-width: 5; stroke-linecap: round; }
.wr { stroke: var(--red); stroke-width: 2.8; fill: none; stroke-linecap: round; }
.wb { stroke: var(--ink); stroke-width: 2.8; fill: none; stroke-linecap: round; }
.wd { stroke: var(--blue); stroke-width: 2.2; fill: none; stroke-linecap: round; }
.wg { stroke: var(--gold); stroke-width: 3; fill: none; stroke-linecap: round; }
.strap0 { stroke: var(--ink); stroke-width: 6.4; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.strap1 { stroke: var(--blue); stroke-width: 3.8; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.rib0 { stroke: var(--ink); stroke-width: 7; fill: none; stroke-linecap: round; }
.rib1 { stroke: var(--shade2); stroke-width: 4.4; fill: none; stroke-linecap: round; }
.ringg { fill: none; stroke: var(--gold); stroke-width: 3; } .ringb { fill: none; stroke: var(--blue); stroke-width: 3; }
.okc { fill: var(--okbg); stroke: var(--ok); stroke-width: 1.6; } .okm { fill: none; stroke: var(--ok); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.noc { fill: var(--nobg); stroke: var(--no); stroke-width: 1.6; } .nom { fill: none; stroke: var(--no); stroke-width: 2.6; stroke-linecap: round; }
.thin { stroke-width: .8; } .thin2 { stroke-width: 1.6; } .thick { stroke-width: 2.4; } .thick2 { stroke-width: 4; }
.t, .tm, .ts, .tt, .tb, .tn, .tc, .tl, .tlb { fill: var(--ink); }
.tm { font: 500 10.5px var(--mono); } .ts { font: 400 11.5px var(--body); } .tt { font: 600 8.5px var(--mono); }
.tb { font: 800 12px var(--display); } .tn { font: 800 10.5px var(--display); } .tc { font: 800 16px var(--display); }
.tl { font: 400 13px var(--body); } .tlb { font: 700 13.5px var(--body); }
.tled { font: 600 11px var(--mono); fill: #7dff9a; } .tled2 { font: 600 9px var(--mono); fill: #7dff9a; }
.halo { paint-order: stroke; stroke: var(--paper); stroke-width: 3.5px; stroke-linejoin: round; }
.led { font: 700 34px "Archivo Narrow", "Arial Narrow", sans-serif; text-anchor: middle; } .led-b { fill: #3b78ff; } .led-o { fill: #ff6a2b; }
.leds { font: 700 12px "Archivo Narrow", sans-serif; fill: #e8ecf2; }
.po-f { fill: var(--stage-face); stroke: var(--stage-ink); stroke-width: 1.2; } .po-t { fill: var(--stage-face2); stroke: var(--stage-ink); stroke-width: 1.2; }
.po-s { fill: #16181c; stroke: var(--stage-ink); stroke-width: 1.2; } .po-scr { fill: #050607; stroke: var(--stage-ink); stroke-width: .8; }
.po-h { fill: none; stroke: var(--stage-ink); stroke-width: 5; stroke-linecap: round; }
.pled { font: 700 110px "Archivo Narrow", "Arial Narrow", sans-serif; } .pled-b { fill: #3b78ff; } .pled-o { fill: #ff6a2b; }
.pleds { font: 700 36px "Archivo Narrow", sans-serif; fill: #e8ecf2; } .pledn { font: 700 26px "Archivo Narrow", sans-serif; }

@media (max-width: 860px) {
  .mast { grid-template-columns: 1fr; gap: 22px; padding-top: 28px; }
  .view { aspect-ratio: 4 / 3.4; }
  .step { grid-template-columns: 1fr; }
  .step .sh { grid-template-columns: auto minmax(0, 1fr); column-gap: 14px; }
  .step > * { grid-column: 1; }
  .num { font-size: 56px; }
  .fig .ill { min-width: 600px; }
  #stage-status { margin-left: 0; width: 100%; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }
</style>

<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
  <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="hbg"/><line x1="0" y1="0" x2="0" y2="6" class="hln"/></pattern>
  <pattern id="dots" width="4.6" height="4.6" patternUnits="userSpaceOnUse"><circle cx="2.3" cy="2.3" r="1.15" class="dln"/></pattern>
  <linearGradient id="ramp" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
  <linearGradient id="benchg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".25" stop-color="#ffd400"/><stop offset=".5" stop-color="#00e050"/><stop offset=".75" stop-color="#ff3df0"/><stop offset="1" stop-color="#2a5bff"/></linearGradient>
</defs></svg>

<div class="wrap">
  <header class="mast">
    <div>
      <div class="eyebrow">KSC Wiedikon · Point Hub · build manual</div>
      <h1>Point Hub</h1>
      <p class="lede">Our own scoreboard, 1.67 times the size of the Tech4Sport box, with a small score panel facing each bench. Seventeen steps, one weekend.</p>
    </div>
    <dl class="specs">
      <div><dt>Size</dt><dd>102 × 38 × 22 cm</dd></div>
      <div><dt>Weight</dt><dd>about 8 kg</dd></div>
      <div><dt>Main screen</dt><dd>192 × 64 LEDs, 5 mm</dd></div>
      <div><dt>Bench panels</dt><dd>2 × 32 × 64 LEDs</dd></div>
      <div><dt>Power</dt><dd>USB-C charger, 65 W+ ideal</dd></div>
      <div><dt>Ports</dt><dd>2 × USB-C, nothing else</dd></div>
      <div><dt>Parts</dt><dd>about €525</dd></div>
      <div><dt>Build time</dt><dd>12–15 h + drying</dd></div>
    </dl>
  </header>

  <section class="stage" aria-label="3D view of the finished Point Hub board">
    <div class="view">
      <div id="poster">${d.poster()}</div>
      <div id="stage3d" hidden></div>
    </div>
    <div class="bar">
      <div class="grp"><span>Screen</span><div class="seg"><button type="button" data-screen="match" aria-pressed="true">Match</button><button type="button" data-screen="idle" aria-pressed="false">Idle</button><button type="button" data-screen="test" aria-pressed="false">Test</button></div></div>
      <div class="grp"><span>Mount</span><div class="seg"><button type="button" data-mount="table" aria-pressed="true">Table</button><button type="button" data-mount="speaker" aria-pressed="false">Speaker stand</button><button type="button" data-mount="tripod" aria-pressed="false">Tripod</button></div></div>
      <div class="grp"><span>View</span><div class="seg"><button type="button" data-view="three" aria-pressed="true">¾</button><button type="button" data-view="front" aria-pressed="false">Front</button><button type="button" data-view="bench" aria-pressed="false">Bench</button><button type="button" data-view="back" aria-pressed="false">Back</button></div></div>
      <span id="stage-status">Loading the 3D view…</span>
    </div>
  </section>
  <p class="draft"><span class="ni" style="background:var(--infobg);color:var(--info);border:1.5px solid var(--info);font-family:Georgia,serif;font-style:italic">i</span><span><b>Draft, 22 October 2026.</b> Updated with the research pass: three driver outputs (no upside-down row), Adafruit driver board, Pi 4 1 GB, metal plate, clock and temperature sensor. Since then: the tablet cable also charges the tablet, and optional tilt legs. Sizes in the steps still depend on the exact parts that arrive.</span></p>

  <section class="block" aria-labelledby="parts-h">
    <div class="bh"><h2 id="parts-h">In the box</h2><p>Letters match the drawings.</p></div>
    <ul class="grid">${partCards}</ul>
    <div class="subh">Screws and wire</div>
    <ul class="grid">${hwCards}</ul>
  </section>

  <section class="block" aria-labelledby="tools-h">
    <div class="bh"><h2 id="tools-h">Tools</h2><p>All of it fits a normal home toolbox.</p></div>
    <ul class="grid">${toolCards}</ul>
  </section>

  <div class="col">${stageHtml}</div>

  <footer class="end col">
    <p>KSC Wiedikon · Point Hub board build manual, draft of 22 October 2026.</p>
    <p>The panel software (openscore, flushBuffer2 and the Point Hub console) comes ready on the SD card in step 14.</p>
  </footer>
</div>

<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
<script type="module">
${scene}
</script>
`;
// Standalone: a doctype and viewport so it opens straight from the repo in any browser.
fs.writeFileSync(dir + 'build-manual.html', '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' + html + '</html>\n');
console.log('wrote', html.length, 'bytes');
