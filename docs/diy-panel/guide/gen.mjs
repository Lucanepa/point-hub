import fs from 'node:fs';
import * as d from './draw.mjs';

const dir = new URL('.', import.meta.url).pathname;
// The idle crest the 3D view shows comes from openscore's golden images; pass another PNG to override.
const crestPath = process.argv[2] || new URL('../../../firmware/openscore/golden/03_kscw_crest.png', import.meta.url).pathname;
const crest = 'data:image/png;base64,' + fs.readFileSync(crestPath).toString('base64');
const scene = fs.readFileSync(dir + 'scene.js', 'utf8').replace('__CREST__', crest);

// The cut list (Jumbo online cut-to-size, Oecoplan poplar 6 mm). Letters match the drawings.
const wood = [
  ['A', 'A', 'Front frame', '1004 × 366; window 960 × 320 cut at home. Tilts on the piano hinge', 1],
  ['B', 'B', 'Back', '1020 × 380; flap opening 280 × 205, ports, horn hole, vents at home', 1],
  ['C', 'C1', 'Top', '1020 × 214; two handle cut-outs 129 × 52 at home', 1],
  ['C', 'C2', 'Bottom', '1020 × 214; stand cup and thread holes after the dry fit', 1],
  ['D', 'D', 'Ends', '368 × 214; window 160 × 320 each, for the bench screens', 2],
  ['F', 'F', 'Flap', '260 × 180, two layers glued (12 mm); trim to the screen', 2],
  ['P', 'P1', 'Pocket back', '292 × 217', 1],
  ['P', 'P2·P3', 'Pocket walls', 'blank 292 × 150 → 2 × 292 × 25 and 2 × 205 × 25', 1],
  ['K', 'K', 'Bottom cap', 'blank 1004 × 150 → 1004 × 104; final depth at the dry fit', 1],
  ['H', 'H', 'Cheeks', 'blank 370 × 150 → 370 × 130 → two triangles', 1],
  ['Y', 'Y', 'Backing plates', 'blank 300 × 208 → 2 × 208 × 140, glued: 12 mm', 1],
  ['T', 'T', 'Pull-out foot', '600 × 150', 1],
  ['spare', '', 'Spare', '400 × 300, for practice cuts and remakes', 1],
  ['batten', '', 'Beech battens 15 × 20', '× 1000: 2 long battens, 2 foot rails, blocks, 1 spare. 15 × 15 is not stocked in Zürich', 5],
];
const groups = [
  ['Front and tilt', [
    ['pc', 'Smoked polycarbonate 3 mm', 'Makrolon UV 2760 grey (about 62 % light): 990 × 350 + 2 × 172 × 332', 3],
    ['module', 'LED module P5 64 × 32', 'indoor, ICN2037BP + 74HC138, one batch: 8 + 2 spare', 10],
    ['magnet', 'M3 magnetic screws', 'size 1313, four per module', 40],
    ['bars', 'Steel flat bar 20 × 4', 'cut to 3 × 360 (must be steel: the magnets hold on it); two 1 m bars', 3],
    ['piano', 'Piano hinge', 'about 1000 × 32, cut to 1000', 1],
    ['caphinge', 'Cap hinges', 'K to A’s bottom edge: 3 butt hinges 50 mm, 3 × 12 screws, a 6 mm doubler under each leaf', 3],
    ['stay', 'Ratchet stays', 'aluminium flat 25 × 4 (or steel), 200 long, five notches', 2],
    ['pin', 'M6 × 30 hex bolt', 'with nylon lock nut: the pin each stay drops onto', 2],
  ]],
  ['Screen flap', [
    ['screen', '10.1″ DSI touch screen', 'Waveshare 10.1″ DSI LCD (C), 1280 × 800', 1],
    ['dsi', 'Display cable', 'standard–mini DSI, 300 mm (Raspberry Pi SC1132)', 1],
    ['torque', 'Torque hinges', 'friction hinge 1.2 N·m', 2],
    ['catch', 'Magnetic catches', 'Hettich 27 × 18, screw-on, 2 kg, adjustable (flap and back)', 6],
  ]],
  ['Case', [
    ['handle', 'K16 recessed handles', 'spring-back, rim 155 × 83.3, cut-out 129 × 52, + 6 × M4 × 16 pan Torx A2 and lock nuts each', 2],
    ['pads', 'Rubber pads', 'clear, self-adhesive, 20 × 20: 4 under the box, 2 under the foot, 2 spare', 8],
    ['caps', 'Corner caps', 'black rubber, front corners only, trimmed to the ends’ edge', 4],
    ['turn', 'Turn buttons', 'bench screens, back panel, foot', 12],
    ['stand', 'Stand cup', '35 mm (K&M 195/8 flange), M4 screws', 1],
    ['inserts', 'Tripod threads', '¼″-20 and ⅜″-16 wood inserts, in the 12 mm plate', 2],
    ['seal', 'Splash protection', 'black silicone, EPDM D-seal, brush seal, USB-C dust caps, vent mesh; optional 2K matte clear', 1],
  ]],
  ['Electronics', [
    ['pi', 'Raspberry Pi 5, 8 GB', '+ Active Cooler (SC1148). Fallback if Pi 5 + Piomatter fails: Pi 4 2 GB with the hzeller library', 1],
    ['bonnet', 'LED driver board', 'Adafruit Triple LED Matrix Bonnet (6358)', 1],
    ['header', 'Stacking header', '40 pin, tall: reaches pins 27/28 under the bonnet', 1],
    ['sd', 'microSD card', '32 GB, prepared; one spare', 2],
    ['conv', 'Converter', 'Mean Well RSD-60G-5, 9–36 V in, 5 V 12 A out', 1],
    ['pd', 'USB-C power board', 'STUSB4500 (I²C 0x28)', 1],
    ['ext', 'USB-C panel sockets', 'panel-mount extensions, 30 cm: POWER and DATA', 2],
    ['fuse', 'Fuse box', '12-way ATO, 5 A per way + spares', 1],
    ['ina', 'INA226 current sensors', 'R002 (2 mΩ) boards: 0x40 on the 5 V out, 0x41 on the input (A0 bridged to VCC), one spare', 3],
    ['chip', 'MCP23017 module', 'I²C 0x20: switches the horn', 1],
    ['mosfet', 'MOSFET module', 'AOD4184, isolated (optocoupler input)', 1],
    ['buzzer', 'Horn buzzer', 'SFM-27 active piezo, continuous (not “-II”), 3–24 V, about 95 dB', 1],
    ['lights', 'Status lights', 'POWER · STATUS · LINK: RGB 5 mm matte common-cathode LEDs in metal panel holders, Ø8 holes; resistors 330 / 150 / 47 Ω', 3],
    ['sensor', 'Clock + temperature', 'DS3231 (0x68) with CR2032, SHT40 (0x44)', 2],
    ['pdsrc', 'Tablet charging module', 'USB-C PD 65 W (DMyond), off the fused input through 3 A', 1],
    ['lan', 'USB-C hub', 'Ethernet (RTL8153) + charging input: the DATA cable to the Pi', 1],
    ['plate', 'Aluminium plate', 'under the converter and the fuse box', 1],
    ['small', 'Small parts', 'TVS P6KE27A, 5 A and 3 A inline fuses, 10 kΩ resistor', 1],
  ]],
  ['Screws, glue, paint', [
    ['screw20', 'Wood screws T20', '3.5 × 16 (shell, blocks, back); 3.5 × 30 for the two stay pivots', 70],
    ['m4', 'Machine screws T20', 'M4 × 16 with nuts: stand flange', 4],
    ['standoff', 'Standoffs', 'M2.5, for the Pi', 4],
    ['glue', 'Wood glue D3', 'water-resistant PVA (UHU Holzleim wasserfest)', 1],
    ['paint', 'Paint', 'matte black, gloss black for the front face, filler, P120 + P180', 1],
    ['wire', 'Wire, red + black', '2.5 mm² · 1 mm² · ferrules · heat-shrink', 1],
    ['sticker', 'Lettering and label', '“POINT HUB” front, back label: after first light', 2],
  ]],
];
const toolList = [
  ['drill', 'Drill/driver', 'Bosch GSB 18V-65, T20 bits'],
  ['bits', 'Drill bits', 'wood bits and HSS bits (Ø2, 2.5, 4.5, 4.8, 6.5, 10)'],
  ['jigsaw', 'Jigsaw', 'Bosch GST 18V-125 S'],
  ['blades', 'Jigsaw blades', 'T101B straight wood · T101AOF curves · T118B aluminium/steel · T118A piano hinge'],
  ['holesaw', 'Hole saws', 'Wolfcraft Ø32 and Ø45'],
  ['punch', 'Centre punch', 'automatic'],
  ['files', 'Files', 'flat set + needle files'],
  ['clamp', 'Clamps', '4 × Wolfcraft EHZ Easy 300'],
  ['vise', 'Table vise', '50 mm'],
  ['square', 'Squares', 'speed square (angles for the tilt) + square set'],
  ['sand', 'Sanding', 'sponges + paper P120 / P180'],
  ['roller', 'Roller and brush', '10 cm foam roller, 25 mm brush'],
  ['tape', 'Painter’s tape', 'still to buy: holds the long joints'],
  ['iron', 'Soldering iron', 'Pinecil V2 (USB-C PD 20 V), Sn63/Pb37 0.8 mm, tip cleaner'],
  ['crimp', 'Ferrule crimper', 'HSC8 6-4A + 400 ferrules'],
  ['shrink', 'Heat-shrink', '2:1 assortment'],
  ['meter', 'Multimeter', 'UNI-T UT33B+'],
  ['laser', 'Laser meter', 'Bosch GLM 50-27 C'],
];

const N = (t) => `<li class="n-info"><span class="ni" aria-hidden="true">i</span><span>${t}</span></li>`;
const OK = (t) => `<li class="n-ok"><span class="ni" aria-hidden="true">✓</span><span>${t}</span></li>`;
const NO = (t) => `<li class="n-no"><span class="ni" aria-hidden="true">✕</span><span>${t}</span></li>`;
const OPEN = (t) => `<li class="n-open"><span class="ni" aria-hidden="true">?</span><span><b>Open point.</b> ${t}</span></li>`;
const CHECK = (t) => `<li class="n-open"><span class="ni" aria-hidden="true">!</span><span><b>Check before you rely on it.</b> ${t}</span></li>`;
const notch = d.NOTCH.map(n => Math.round(n)).join(', ');
const reach = d.capReach(), short20 = Math.round(d.capK(20).short), out20 = Math.round(d.OUT20);
const stages = [
  ['A', 'Workshop', 'Saw, hole saw and metal work at the community-centre open workshop (GZ Hirzenbach: wood and metal, Tue 14–21, Sat 11–17; own tools and material allowed).', [
    [1, 'Get the parts', d.step1(), 'The plywood comes from Jumbo’s online cut-to-size service: Oecoplan poplar, 6 mm, every piece already a rectangle. Jumbo cuts nothing under 230 × 150, so the bottom cap K, the cheeks H, the backing plates Y and the pocket walls come as oversize blanks you cut yourself. Add five beech battens 15 × 20 × 1000.', [N('Measure the real thickness at pickup: “6 mm” can be anything from 5.6 to 6.3. The outer joints get sanded flush later.'), N('Pencil each part’s letter on it as it comes off the saw.')]],
    [2, 'Cut the openings', d.step2(), 'With the jigsaw: the front window in A, a window in each end D, the flap opening in B and the two handle cut-outs in the top C1. Drill Ø10 in every corner first, then saw from hole to hole. Hole saws for the horn hole (Ø32). Ports, vents and the six back-screw holes in B. Leave the bottom C2’s holes until after the dry fit.', [OK('Painter’s tape on the cut line and the good face down: the T101B blade cuts on the up stroke, so the face down stays clean.'), N('Check the USB-C cut-outs against the sockets you actually have.')]],
    [3, 'Rip the blanks', d.step3(), 'Cheeks H: rip the blank to 130, then saw corner to corner for two triangles. Backing plates Y: two pieces 140 × 208. Pocket walls: four strips 25 wide, two of them cut to 205. Leave K at 150 until the dry fit decides its depth.', [N('A batten clamped as a fence keeps long rips straight. Cut beside the line on the offcut side, then sand to it.')]],
    [4, 'Make the metal parts', d.step4(), `Two ratchet stays from the 25 × 4 aluminium flat, 200 long: a Ø4.5 pivot hole 12 mm from one end, then five notches ${notch} mm from it (0, 5, 10, 15 and 20°), 9 mm up from the lower edge. For each notch drill Ø6.5, then cut in from the edge with the jigsaw (T118B) on both sides of the hole and file the slot smooth. Cut three steel bars of 360 from the 20 × 4 flat, and the piano hinge to 1000 (T118A, or sandwich it in plywood and use T118B).`, [N('The bars are 360, not 368: the front frame they sit on is only 366 tall. Three of them need two 1 m bars.'), N('Tape both stays together and drill through both: the notches then match.')]],
  ]],
  ['B', 'Case', 'Back home: gluing, fitting and painting. Ventilate when painting; keep sawdust away from where you will wire later.', [
    [5, 'Dry fit', d.step5(), 'Tape the box together without glue: bottom, both ends, top and back. Hold the front frame A in the front opening (tape along its top edge works as a hinge for now) and swing it: it needs 2 mm each side and 1 mm top and bottom. Then hold the K blank against A’s bottom edge and swing to 0° and to 20°.', [
      OPEN('The bottom cap K and the backing plates Y both want the middle of the floor: K slides over the front 11 cm, Y sits under the stand cup. Decide here, before gluing Y: <b>(1)</b> Y towards the back, with K riding over it on two thin runners, or <b>(2)</b> move Y and the stand cup off K’s path. Check K’s sweep at 0° and at 20°.'),
      OPEN(`At 20° the bottom of A stands ${out20} mm out. A ${d.G.K} mm cap reaches the floor only up to about ${reach}°; at 20° it ends ${short20} mm short of the front edge. Mark K’s final depth from the 150 blank here, knowing a deeper K needs more floor.`)]],
    [6, 'Glue the shell', d.step6(), 'Glue (D3, water-resistant) and screw the bottom C2, both ends D and the top C1. Battens go in with their 20 mm face on the panel and 15 mm into the box: one under the top along its front edge (the piano hinge screws into it), one on the bottom along the back edge (the back panel screws into it). Blocks from offcuts at the top back corners and middle, and in the inside corners where the ends meet the top and bottom, kept 40 mm back from the front so the frame, cheeks and stays clear them. Painter’s tape every 15 cm holds the long joints; clamps where they reach.', [N('Pre-drill Ø2.5 for every 3.5 mm screw: beech is hard.'), N('The glue stays open about 10 minutes: one joint at a time.'), OK('Before it sets: the front opening is 1008 × 368 and square (equal diagonals).')]],
    [7, 'Stand cup and threads', d.step7(), 'Drill the bottom where the dry fit put Y: Ø45 for the stand cup, and holes for the two thread inserts (the size the inserts ask for). Glue the two Y layers together and inside the bottom, then fit the 35 mm stand flange with four M4 × 16 and screw the ¼″-20 and ⅜″-16 inserts in from below.', [N('The 6 mm bottom alone is too thin for bolts and inserts: they need the 12 mm plate.')]],
    [8, 'Screen pocket and flap', d.step8(), 'Glue the pocket walls P2 and P3 round the flap opening on the inside of B, and the pocket back P1 on top: a box 25 mm deep. Glue the two flap layers F together (12 mm) and trim them to the real screen, 10 mm clear of the walls all round. Two torque hinges along the flap’s top edge, into a block under the pocket’s top wall; a magnetic catch on a block at the bottom. A slot through F and P1 for the display ribbon.', [N('The torque hinges hold the flap at any angle; it swings out like an awning from closed to about 75° open. Fit a stop there, for example a short cord from the flap to the pocket.'), N('Catches screw into blocks or battens, never into 6 mm plywood; pre-drill 2 mm. No counter-plate: a steel washer.')]],
    [9, 'Hang the front frame', d.step9(), 'Lay A face-down. Screw one leaf of the piano hinge along its top border, knuckle at A’s top back edge so nothing shows from the front. Offer A into the opening with a 0.5 mm card under it (1.5 mm stays free under the top, which the 3 mm round on A’s top front edge needs at 20°) and 2 mm on each side, and screw the other leaf into the batten under the top. It comes off again for painting: the screw holes are set now.', [N('Pre-drill 2 mm for the hinge screws.')]],
    [10, 'Cap, cheeks and stays', d.step10(), 'Glue each cheek H to a strip of batten on the back of A’s end border, just inboard of the bench screen. Hang K from A’s bottom inside edge so its back edge slides on the floor. For the stays: a block on A’s back at each bottom corner carries the pivot (a 3.5 × 30 screw with a washer, not tight); through each end wall’s bottom border, 60 mm behind the front and 12 mm above the floor, an M6 × 30 bolt through a 12 mm block with a nylon lock nut is the pin. Lift A’s bottom, drop a notch on the pin, and check 0, 5, 10, 15 and 20° with the speed square.', [
      N('K hangs from A’s bottom edge on three 50 mm butt hinges (3 × 12 screws; glue a 6 mm offcut doubler under each leaf on K and on A first, or the screws come through). Cut K’s depth at the dry fit (about 140 from the 150 blank): at 20° a 104 mm cap no longer reaches the floor.'),
      OPEN('The stay, its pin and the cheek share the 22 mm strip at each end of A. If the cheek touches the pin’s nut, trim the cheek’s bottom back corner: K closes that part of the gap anyway.'),
      OK('Teeth don’t creep when a ball hits the front.')]],
    [11, 'Handles', d.step11(), 'Drop each K16 handle into its cut-out from above, the rim flat on the top. Six M4 × 16 pan-head Torx screws through the rim, a lock nut on each inside.', [N('The tray sits 7.6 mm deep under the top: check it clears the blocks and the pocket.')]],
    [12, 'Pull-out foot', d.step12(), 'Two batten rails, 205 long, glued under the bottom from front to back, 602 apart inside. A strip of plywood offcut screwed under each overhangs 12 mm inward: the foot T rides on these lips like a drawer. Pulled out 12 cm it turns the 22 cm base into 34 cm, so a ball can’t tip the box over backwards. Two screws in a slot stop it at full travel; a turn button on the back end of a rail holds it in.', [N('With the foot in, check that a tripod plate still reaches the threads; if not, cut a notch in T’s front edge.')]],
    [13, 'Paint', d.step13(), 'Take the hinge, stays, handles and catches off again and label them. Round every outside edge with sandpaper, about 3 mm (P120, then P180), and fill the grain on A’s front face. Two coats of matte black everywhere, inside too, so nothing reflects behind the LEDs. A’s front face gets gloss black: behind the smoked sheet, screen and border read as one black surface when the board is off.', [N(`Keep the 3 mm round on A’s top front edge: at 20° that corner swings up about ${Math.ceil(d.HINGE_RISE)} mm into the top.`), N('Paint at the workshop if they allow it, or on a balcony on a drop sheet. Optional: a 2K matte clear on top against splashes.')]],
    [14, 'Pads and corner caps', d.step14(), 'When the paint has fully cured: put the hardware back, then four clear rubber pads under the rails and two under the foot’s back end. Black rubber caps on the box’s four front corners, trimmed so they cover only the ends’ 6 mm edge: the front frame must swing past them.', []],
  ]],
  ['C', 'Screens', 'The front frame comes off its hinge once more for the modules.', [
    [15, 'Modules on the front frame', d.step15(), 'Unscrew the hinge from the batten (it stays on A) and lay A face-down on a blanket. Peel the inner film off the smoked sheet and lay it over the window. Six modules on top, LEDs down, all arrows the same way, short ribbons 1 → 2 → 3 and 4 → 5 → 6. Four M3 magnetic screws in each module. Glue blocks on A’s top and bottom border, packed to the magnet height, and screw the three steel bars onto them: the magnets snap on, so a module swaps out in seconds.', [OK('Leave the IN of modules 1 and 4 free: the driver plugs in there.'), N('Keep the sheet’s outer film on until the very end.')]],
    [16, 'Bench screens', d.step16(), 'One smoked sheet and one module behind each end window, arrows up. Twist four turn buttons over the module’s edges.', [N('The stay’s pin block sits just under the bench screen: keep the bottom border free.')]],
    [17, 'Hang it again', d.step17(), 'Screw the hinge back into the batten, same holes. Plug the ribbons and power leads with about 12 cm of slack, then tilt to 20° and back with everything plugged in: nothing may pull tight or catch on a cheek.', []],
  ]],
  ['D', 'Electronics', 'Low voltage only: nothing in here can give you a shock. Solder at home, with a window open.', [
    [18, 'Lay out the electronics', d.step18(), 'On the floor, behind the strip K slides over. Pi 5 with its cooler and the bonnet on the left near the flap, the I²C parts and the horn switch beside it; converter and fuse box on the aluminium plate on the right, the USB-C board and the two current sensors near POWER, the tablet charger and the USB-C hub under the pocket. Fit the two USB-C sockets in the back panel; their cables reach inside.', [N('Leave 15 cm of slack on everything that goes to the back panel, so it can come off.')]],
    [19, 'Power path', d.step19(), 'POWER socket → TVS diode across + and − → STUSB4500 → INA226 (0x41, A0 bridged) → 5 A fuse → converter, in 1 mm². Converter → INA226 (0x40, 2 mΩ shunt) → fuse box, in 2.5 mm². After the 5 A fuse, a 3 A fuse feeds the tablet charger into the USB-C hub’s charging input. A ferrule on every wire end.', [N('Set the STUSB4500 to “output only above 5 V”: a 5 V-only source leaves the box off instead of half-booting it.'), N('Join the converter’s −Vin to −V: the USB-C board talks to the Pi and needs a shared ground.'), N('The Pi takes its 5 V on the header pins from its own fuse; its USB-C socket stays empty.')]],
    [20, 'First power-up', d.step20(), 'Nothing else connected. A small USB-C phone charger into POWER; measure at the fuse box.', [N('A weak charger is the safety net: it cannot push enough current to damage anything.')]],
    [21, 'LED power and data', d.step21(), 'Every module, each bench module and the Pi on its own 5 A fuse (ways 1–9). Way 10 is the horn, 11 and 12 are spare. Ribbon OUT 1 to module 1, OUT 2 to module 4, OUT 3 to the left bench module and on to the right one.', [N('Panel power leads that don’t reach: extend with 1.5 mm².')]],
    [22, 'I²C parts and the horn', d.step22(), 'The USB-C board, the clock, the temperature sensor, both current sensors and the MCP23017 share two wires to pins 27 and 28 (GPIO 0 and 1) of the tall header. MCP23017 pin GPA0 drives the isolated MOSFET module, which switches the buzzer’s 5 V from fuse way 10. The buzzer screws on from inside over the Ø32 hole. GPA1–3 drive the STATUS light and GPA4–6 the LINK light (red, green, blue through 150, 47 and 47 Ω); the POWER light hangs on 5 V through 330 Ω so it shows power even when the Pi is dead.', [CHECK('Chain 3 uses GPIO 2, 3 and 14, which is why I²C moved to pins 27/28. Confirm this still holds on the Pi 5 with the bonnet before you wire it.'), N('The MCP23017 starts with every pin an input, so the horn stays off at boot.')]],
    [23, 'Control screen', d.step23(), 'Screw the screen onto the flap’s outer face and pass its ribbon through the slot. The 300 mm DSI cable runs to the Pi 5’s display port with a loose loop at the hinge, so it flexes instead of folding.', [CHECK('Run all eight modules and the screen together. The LED driver needs one Pi core; if the modules flicker with the screen on, the screen stays out.')]],
    [24, 'Test', d.step24(), 'With the back still off, slide in the prepared SD card and power up with a 65 W laptop charger. POWER lights green at once; STATUS blinks yellow while it starts, then turns green; LINK shows blue with the tablet on the cable, green when online (the full colour code is in BUILD.md §6 and on the back label). The power-on self-test runs, then a test pattern on all eight modules; leave it for 30 minutes. The diagnostics page shows what the self-test found (BUILD.md §6).', [CHECK('First light on the Pi 5 with Piomatter, the screen flicker test and the soak test are not done yet on this design. If the Pi 5 path fails, a Pi 4 2 GB with the hzeller library is the fallback (BUILD.md).')]],
  ]],
  ['E', 'Finish', 'Ready for the hall.', [
    [25, 'Close up', d.step25(), 'Put the back panel on and drive the six T20 screws into the batten and the blocks; turn buttons hold the rest. Inside the back: the fuse map, spare fuses and a spare SD card. An EPDM D-seal round the back panel’s rim, a brush seal at the front frame’s gap, dust caps on the USB-C sockets. The POINT HUB lettering and the back label wait until after first light, when the port positions are final.', []],
    [26, 'Set it up', d.step26(), 'On a table: lift the front frame’s bottom and drop the stays into the notch you want, 0 to 20° toward the first referee; swing the flap open for the scorer; pull the foot out. On a speaker stand or a tripod: foot in, flap as needed. Charger into POWER, tablet into DATA: one cable carries the scores and charges the tablet, and the scorer PIN isn’t needed on it.', [OK('Any USB-C charger works from 18 W; 65 W or more gives full brightness and charges the tablet.'), NO('Never plug the DATA cable into the school’s network: it’s for the tablet or a laptop only.'), NO('Never in direct sun or by a sunny window: the box would overheat. It dims itself from 50 °C.'), N('Keep a flip scoreboard with digits of 12 cm or more in the kit: Swiss Volley requires one if the board fails.'), N('Coming in from a cold car: wait 45 minutes before switching on, or condensation can short the modules.')]],
    [27, 'Open it', d.step27(), 'Unplug the charger. Undo the six T20 screws, ease the back panel off and unplug the screen ribbon at the Pi: everything inside is in reach.', [OK('Swapping the SD card or a fuse takes a minute.'), N('The back takes a T20 key on purpose: in a public hall, anything that opens by hand gets opened. Keep the key in the kit bag.')]],
  ]],
];

const partCards = wood.map(([ic, L, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[ic]}</div><div class="plabel">${L ? `<span class="pl">${L}</span>` : ''}<span class="pn">${name}</span><span class="pq">×${n}</span></div><span class="ps">${spec}</span></li>`).join('');
const groupHtml = groups.map(([g, items]) => `<div class="label subh">${g}</div><ul class="grid">${items.map(([k, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[k]}</div><div class="plabel"><span class="pn">${name}</span><span class="pq">${n > 1 ? '×' + n : ''}</span></div><span class="ps">${spec}</span></li>`).join('')}</ul>`).join('');
const toolCards = toolList.map(([k, name, spec]) => `<li class="part tool"><div class="pic">${d.tools[k]}</div><div class="plabel"><span class="pn">${name}</span></div><span class="ps">${spec}</span></li>`).join('');
const two = (n) => String(n).padStart(2, '0');
const stageTimes = { A: 'one workshop afternoon', B: 'about 8 h + paint cure', C: 'about 2 h', D: 'about 5 h', E: 'about 1 h' };
const nSteps = stages.reduce((a, s) => a + s[3].length, 0);
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
  --ok: #1f8a4c; --okbg: #e3f3e9; --no: #c4302b; --nobg: #fbe5e3; --info: #3b5ccc; --infobg: #e9eefc; --open: #9a5b00; --openbg: #fbefd9;
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
  --ok: #52c784; --okbg: #11301e; --no: #ff6b61; --nobg: #3a1513; --info: #8fa9ff; --infobg: #172244; --open: #f2b705; --openbg: #3a2a08;
  --stage-hi: #1a1c20; --stage-lo: #08090a; --stage-ink: #e6e8eb; --stage-mute: #8b929a; --stage-btn: rgba(22,24,27,.82); --stage-line: rgba(255,255,255,.12);
  color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0c0d0f; --sheet: #141619; --ink: #eceef0; --mute: #9aa1a9; --faint: #6d747c; --line: #24282d;
  --accent: #f2b705; --accent-ink: #111317;
  --shade: #1c1f23; --shade2: #353b42; --modback: #4b545e; --glass: #8e99a5; --alu: #59616b; --screen: #050607; --gloss: #3b4148; --dot: #2a2f35;
  --blue: #79a3ff; --red: #ff6b61; --gold: #f0c12e;
  --ok: #52c784; --okbg: #11301e; --no: #ff6b61; --nobg: #3a1513; --info: #8fa9ff; --infobg: #172244; --open: #f2b705; --openbg: #3a2a08;
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
.bar { position: static; display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding-block: 14px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); pointer-events: none; }
.bar > * { pointer-events: auto; }
.seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--stage-btn); box-shadow: inset 0 0 0 1px var(--stage-line); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.segl { font: 500 10.5px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--stage-mute); padding: 0 6px 0 10px; align-self: center; }
.seg button { font: 500 12.5px var(--body); color: var(--stage-mute); background: transparent; border: 0; padding: 6px 12px; border-radius: 999px; cursor: pointer; }
.seg button:hover { color: var(--stage-ink); }
.seg button[aria-pressed="true"] { background: var(--stage-ink); color: var(--stage-lo); }
#stage-status { flex-basis: 100%; font: 500 11px var(--mono); letter-spacing: .04em; color: var(--stage-mute); }

.specs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin: 0; border-bottom: 1px solid var(--line); }
.specs div { padding: 16px 16px 16px 0; border-top: 1px solid var(--line); min-width: 0; }
.specs dt { font: 500 10.5px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--faint); }
.specs dd { margin: 4px 0 0; font: 600 18px/1.25 var(--display); font-variation-settings: "wdth" 88; font-variant-numeric: tabular-nums; }
.draft { padding-block: 14px 0; color: var(--faint); font: 400 12px/1.5 var(--mono); }

/* contents */
.toc { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; margin-top: 56px; background: var(--line); border: 1px solid var(--line); }
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
.n-open .ni { background: var(--openbg); color: var(--open); }
.notes .n-open { color: var(--ink); }
.notes b { font-weight: 600; color: var(--ink); }
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
.tape { fill: var(--gold); fill-opacity: .55; } .wrf { fill: var(--red); } .wbf { fill: var(--ink); }
.tmono { font: 500 10px var(--mono); fill: var(--ink); }
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
  <span class="label">Design D · draft 2.11.2026</span>
</header>

<div class="wrap hero-t">
  <h1>Point Hub</h1>
  <p class="lede"><b>Our own scoreboard.</b> 1.67 times the size of the Tech4Sport box, a small score panel facing each bench, a front that tilts toward the first referee, a touch screen for the scorer in a flap at the back, two USB-C ports. ${nSteps} steps.</p>
</div>

<section class="stage" aria-label="3D view of the finished Point Hub board">
  <div class="view">
    <div id="poster">${d.poster()}</div>
    <div id="stage3d" hidden></div>
  </div>
  <div class="bar">
    <div class="seg" role="group" aria-label="Screen"><button type="button" data-screen="match" aria-pressed="true">Match</button><button type="button" data-screen="idle" aria-pressed="false">Idle</button><button type="button" data-screen="test" aria-pressed="false">Test</button></div>
    <div class="seg" role="group" aria-label="Front tilt"><span class="segl">Front</span>${[0, 5, 10, 15, 20].map(a => `<button type="button" data-tilt="${a}" aria-pressed="${a === 0}">${a}°</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Screen flap"><span class="segl">Flap</span><button type="button" data-flap="closed" aria-pressed="true">Closed</button><button type="button" data-flap="open" aria-pressed="false">Open</button></div>
    <div class="seg" role="group" aria-label="Rear foot"><span class="segl">Foot</span><button type="button" data-foot="in" aria-pressed="true">In</button><button type="button" data-foot="out" aria-pressed="false">Out</button></div>
    <div class="seg" role="group" aria-label="Mount"><button type="button" data-mount="studio" aria-pressed="true">Studio</button><button type="button" data-mount="table" aria-pressed="false">Table</button><button type="button" data-mount="speaker" aria-pressed="false">Speaker stand</button><button type="button" data-mount="tripod" aria-pressed="false">Tripod</button></div>
    <div class="seg" role="group" aria-label="View"><button type="button" data-view="three" aria-pressed="true">¾</button><button type="button" data-view="front" aria-pressed="false">Front</button><button type="button" data-view="side" aria-pressed="false">Side</button><button type="button" data-view="back" aria-pressed="false">Scorer</button><button type="button" data-view="bench" aria-pressed="false">Bench</button></div>
    <span id="stage-status">Loading the 3D view…</span>
  </div>
</section>

<div class="wrap">
  <dl class="specs">
    <div><dt>Size</dt><dd>102 × 38 × 22 cm</dd></div>
    <div><dt>Weight</dt><dd>about 8.5 kg</dd></div>
    <div><dt>Main screen</dt><dd>192 × 64 LEDs, 5 mm</dd></div>
    <div><dt>Bench panels</dt><dd>2 × 32 × 64 LEDs</dd></div>
    <div><dt>Front tilt</dt><dd>0–20°, five notches</dd></div>
    <div><dt>Scorer screen</dt><dd>10.1″ touch, in a flap</dd></div>
    <div><dt>Power</dt><dd>USB-C charger, 65 W+</dd></div>
    <div><dt>Ports</dt><dd>2 × USB-C</dd></div>
  </dl>
  <p class="draft">Sizes in the steps still depend on the exact parts that arrive. Marked “open point”: decided at the dry fit. Marked “check before you rely on it”: not tested yet.</p>

  <nav class="toc" aria-label="Stages">${toc}</nav>

  <section class="block" aria-labelledby="parts-h">
    <div class="bh"><h2 id="parts-h">In the box</h2><p>The wood letters match the cut list and the drawings.</p></div>
    <div class="label subh">Cut list · Jumbo cut-to-size, Oecoplan poplar 6 mm</div>
    <ul class="grid">${partCards}</ul>
    ${groupHtml}
  </section>

  <section class="block" aria-labelledby="tools-h">
    <div class="bh"><h2 id="tools-h">Tools</h2><p>The kit we bought; the workshop has the rest.</p></div>
    <ul class="grid">${toolCards}</ul>
  </section>

  ${stageHtml}

  <footer class="end">
    <p>KSC Wiedikon · Point Hub board build manual, design D, draft of 2 November 2026.</p>
    <p>The panel software comes ready on the SD card in step 24. Wiring, settings and safety: BUILD.md.</p>
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
