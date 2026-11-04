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
  ['K', 'K', 'Bottom cap', 'blank 1004 × 150; final depth about 140, set at the dry fit', 1],
  ['H', 'H', 'Cheeks', 'blank 370 × 150 → 370 × 130 → two triangles', 1],
  ['Y', 'Y', 'Backing plates', 'blank 300 × 208 → 2 × 208 × 140, glued: 12 mm', 1],
  ['T', 'T', 'Pull-out foot', '600 × 150', 1],
  ['spare', '', 'Spare', '400 × 300, for practice cuts and remakes', 1],
  ['cover', '', 'Transport covers, 3 mm', 'poplar 3 mm: front 1020 × 380, ends 380 × 220 ×2, lid 300 × 225', 4],
  ['batten', '', 'Beech battens 15 × 20', '× 1000: 2 long battens, 2 foot rails, 2 tray posts 362, blocks, 1 spare. 15 × 15 is not stocked in Zürich', 5],
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
    ['lights', 'Status lights', 'STATUS and LINK: RGB 5 mm matte common-cathode LEDs in metal panel holders, Ø8 holes; resistors 150 / 47 / 47 Ω', 2],
    ['btn', 'Power button', '16 mm, self-reset, with a green 6 V ring: the ring is the POWER light. Ø16 hole', 1],
    ['sensor', 'Clock + temperature', 'DS3231 (0x68) with CR2032, SHT40 (0x44)', 2],
    ['pdsrc', 'Tablet charging module', 'USB-C PD 65 W (DMyond), off the fused input through 3 A', 1],
    ['lan', 'USB-C hub', 'Ethernet (RTL8153) + charging input: the DATA cable to the Pi', 1],
    ['plate', 'Electronics tray', '2 mm aluminium, up to 400 × 200: everything mounts on it; stands on two batten posts', 1],
    ['small', 'Small parts', 'TVS P6KE27A, 5 A and 3 A inline fuses, 10 kΩ resistor', 1],
  ]],
  ['Transport', [
    ['neod', 'Magnets N48', 'Ø8 × 3, sunk into the box borders: 8 front, 4 per end, 4 lid', 20],
    ['washer', 'M5 body washers', 'sunk about 1 mm into the covers, opposite each magnet', 20],
    ['felt', 'Felt', 'dark grey, 0.8–1 mm (not 4 mm), inside the covers', 1],
    ['cablec', 'USB-C cable, 3 m', 'PD + data, for speaker-stand set-ups: the tablet stays on the table', 1],
    ['bag', 'Custom bag', 'after the build, AliExpress: 104 × 40 × 24 cm inside, 15–20 mm padding, 600D nylon, zip on 3 sides, handles + strap, outer pocket', 1],
  ]],
  ['Screws, glue, paint', [
    ['screw20', 'Wood screws T20', '3.5 × 16 (shell, blocks, back); 3.5 × 30 for the two stay pivots', 70],
    ['m4', 'Machine screws T20', 'M4 × 16 with nuts: stand flange', 4],
    ['standoff', 'Standoffs', 'M2.5 about 10 mm (Pi, bonnet, small boards), M3 where the holes are M3', 16],
    ['ties', 'Cable-tie mounts', 'self-adhesive, with small ties: leads flat on the tray', 10],
    ['glue', 'Wood glue D3', 'water-resistant PVA (UHU Holzleim wasserfest)', 1],
    ['paint', 'Paint', 'matte black, gloss black for the front face, filler, P120 + P180', 1],
    ['wire', 'Wire, red + black', '2.5 mm² · 1 mm² · ferrules · heat-shrink', 1],
    ['sticker', 'Lettering and label', '“POINT HUB” front, back label: after first light', 2],
  ]],
];
const toolList = [
  ['drill', 'Drill/driver', 'Bosch GSB 18V-65, T20 bits'],
  ['bits', 'Drill bits', 'wood bits and HSS bits (Ø2, 2.5, 2.7, 3.2, 4.5, 4.8, 6.5, 8)'],
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
  ['strip', 'Wire stripper', 'automatic, 0.2–6 mm² (Jokari Super 4 Plus or Knipex)'],
  ['cutter', 'Side cutter', '140–160 mm'],
  ['forst', 'Forstner bits', 'Ø8 for the magnets, washer size for the covers; not spade bits'],
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
  ['A', 'First light', 'At home, before anything is cut. One module on the Pi: this decides whether the plan holds.', [
    [0, 'One module, one test', d.stepLight(), [`Fit the Active Cooler on the Pi 5, then the tall header, then the bonnet on top. The bonnet lies <b>over the Pi and the cooler</b>, never off the side: turned round, pin 1 lands on pin 40.`, `Connect 12 V to <b>+Vin</b> and <b>−Vin</b> of the Mean Well: the powerbank’s car socket, through a car plug with bare wires.`, `Switch on and measure <b>+V</b> and <b>−V</b>: it must read 5.0–5.2 V.`, `Switch off. Connect the module’s power lead to +V and −V.`, `Connect the ribbon from <b>Port 1</b> to the module’s input: the socket at the tail of the → arrow printed on its back.`, `Power the Pi from its own USB-C supply.`, `Run Adafruit Piomatter for one 64 × 32 panel, 1/16 scan, pinout <b>Active3BGR</b>, at low brightness (settings: BUILD.md §10.2).`], [
      CHECK('Nobody has run these modules on a Pi 5 yet. If the picture is scrambled or flickers, stop and try the fallback: Pi 4 2 GB with the hzeller library. The 13-point checklist is in firmware/flushbuffer/README.md.'),
      NO('Leave the bonnet’s E4 / E8 pads open: these modules don’t use the E line.'),
      N('Twisted bare wire is fine for this test. In the box every end gets a ferrule.')]],
  ]],
  ['B', 'Workshop', 'Saw, hole saw and metal work at the community-centre open workshop (GZ Hirzenbach: wood and metal, Tue 14–21, Sat 11–17; own tools and material allowed).', [
    [1, 'Get the parts', d.step1(), [`Collect the plywood from Jumbo: Oecoplan poplar 6 mm, already cut into rectangles.`, `Find the four oversize blanks: K, H, Y and the pocket walls. Jumbo cuts nothing under 230 × 150, so you finish these yourself.`, `Write each part’s letter on it in pencil.`, `Measure the real thickness of A, B and C1, and note it.`, `Add the five beech battens, 15 × 20 × 1000.`], [N('Measure the real thickness at pickup: “6 mm” can be anything from 5.6 to 6.3. The outer joints get sanded flush later.'), N('Pencil each part’s letter on it as it comes off the saw.')]],
    [2, 'Cut the openings', d.step2(), [`Tape the cut lines, good face down.`, `Drill Ø8 inside every corner of each opening.`, `Saw from hole to hole: the window in A, a window in each D, the flap opening in B, the two handle cut-outs in C1.`, `File the corners clean.`, `Cut the horn hole in B with the Ø32 hole saw, drilling from both sides.`, `Drill the rest of B: the two USB-C ports, the <b>Ø16 button</b>, the two <b>Ø8 lights</b>, the vents and the six back screws.`, `Leave the holes in the bottom C2 until after the dry fit.`], [OK('Painter’s tape on the cut line and the good face down: the T101B blade cuts on the up stroke, so the face down stays clean.'), N('Check the USB-C cut-outs against the sockets you actually have.')]],
    [3, 'Rip the blanks', d.step3(), [`Cheeks H: rip the blank to 130, then saw corner to corner for two triangles.`, `Backing plates Y: cut two pieces 140 × 208.`, `Pocket walls: rip four strips 25 wide and cut two of them to 205.`, `Leave K at 150: the dry fit sets its depth.`, `Battens: cut two foot rails of 205, two tray posts of 362, and the blocks. Keep one batten spare.`], [N('A batten clamped as a fence keeps long rips straight. Cut beside the line on the offcut side, then sand to it.')]],
    [4, 'Make the metal parts', d.step4(), [`Cut two stays, 200 long, from the 25 × 4 aluminium.`, `Drill a Ø4.5 pivot hole 12 mm from one end of each.`, `Mark five notches ${notch} mm from the pivot (0, 5, 10, 15 and 20°), 9 mm up from the lower edge.`, `At each mark drill Ø6.5, cut in from the edge with the T118B blade on both sides of the hole, and file the slot smooth.`, `Cut three steel bars of 360 from the 20 × 4 flat.`, `Cut the piano hinge to 1000 (T118A, or sandwich it in plywood and use T118B).`, `Deburr every cut with a file.`], [N('The bars are 360, not 368: the front frame they sit on is only 366 tall. Three of them need two 1 m bars.'), N('Tape both stays together and drill through both: the notches then match.')]],
  ]],
  ['C', 'Case', 'Back home: gluing, fitting and painting. Ventilate when painting; keep sawdust away from where you will wire later.', [
    [5, 'Dry fit', d.step5(), [`Tape the box together without glue: bottom, both ends, top and back.`, `Hold A in the front opening, with tape along its top edge as a hinge.`, `Swing it: it needs 2 mm each side and 1 mm top and bottom.`, `Hold the K blank against A’s bottom edge and swing to 0° and to 20°.`, `Stand the tray upright on its posts and swing again: K must clear it.`, `Decide where Y goes, mark it, and rip K to its final depth.`, `Take everything apart and mark where each piece goes.`], [
      OPEN('The bottom cap K and the backing plates Y both want the middle of the floor: K slides over the front 14 cm, Y sits under the stand cup. Decide here, before gluing Y: <b>(1)</b> Y towards the back, with K riding over it on two thin runners, or <b>(2)</b> move Y and the stand cup off K’s path. Check K’s sweep at 0° and at 20°.'),
      N(`At 20° the bottom of A stands ${out20} mm out. A ${d.G.K} mm cap still reaches the floor (up to about ${Math.floor(reach)}°), so rip K to about ${d.G.K} from the 150 blank. At 0° its back edge lies 146 mm behind the front: only 68 mm of floor is left behind it.`),
      CHECK('Hold the empty tray upright behind K (next to the two posts) and tilt from 0° to 20°: K must clear it. Check that the ribbons reach the modules over the tray’s top edge with 12 cm of slack; longer HUB75 ribbons are cheap if not.')]],
    [6, 'Glue the shell', d.step6(), [`Spread D3 glue, and join the bottom C2, both ends D and the top C1.`, `Fit the batten under the top along its front edge, 20 mm face on the panel: the piano hinge screws into it.`, `Fit the batten on the bottom along the back edge: the back panel screws into it.`, `Add blocks from offcuts at the top back corners and middle, and in the inside corners. Keep them 40 mm back from the front.`, `Pre-drill Ø2.5 and screw through the panels into the battens.`, `Tape every 15 cm along the long joints, clamp where you can reach, and check it’s square.`, `Leave it to dry overnight.`], [N('Pre-drill Ø2.5 for every 3.5 mm screw: beech is hard.'), N('The glue stays open about 10 minutes: one joint at a time.'), OK('Before it sets: the front opening is 1008 × 368 and square (equal diagonals).')]],
    [7, 'Stand cup and threads', d.step7(), [`Drill the bottom where the dry fit put Y: Ø45 for the stand cup.`, `Drill the holes for the two thread inserts, the size the inserts ask for.`, `Glue the two Y layers together, then glue them inside the bottom.`, `Fit the 35 mm stand flange with four M4 × 16.`, `Screw the ¼″-20 and ⅜″-16 inserts in from below.`], [N('The 6 mm bottom alone is too thin for bolts and inserts: they need the 12 mm plate.')]],
    [8, 'Screen pocket and flap', d.step8(), [`Glue the pocket walls P2 and P3 round the flap opening, on the inside of B.`, `Glue the pocket back P1 on top: this makes a box 25 mm deep.`, `Glue the two flap layers F together (12 mm).`, `Trim the flap to the real screen, 10 mm clear of the walls all round.`, `Fit two torque hinges along the flap’s top edge, into a block under the pocket’s top wall.`, `Fit the magnetic catch on a block at the bottom.`, `Cut a slot through F and P1 for the display ribbon.`], [N('The torque hinges hold the flap at any angle; it swings out like an awning from closed to about 75° open. Fit a stop there, for example a short cord from the flap to the pocket.'), N('Catches screw into blocks or battens, never into 6 mm plywood; pre-drill 2 mm. No counter-plate: a steel washer.')]],
    [9, 'Hang the front frame', d.step9(), [`Lay A face-down.`, `Screw one hinge leaf along its top border, with the knuckle at A’s top back edge.`, `Put A in the opening with a 0.5 mm card under it and 2 mm on each side. 1.5 mm stays free under the top.`, `Screw the other leaf into the batten under the top.`, `Leave it for now: it comes off again for painting, but the screw holes are set.`], [N('Pre-drill 2 mm for the hinge screws.')]],
    [10, 'Cap, cheeks and stays', d.step10(), [`Glue each cheek H to a strip of batten on the back of A’s end border, just inboard of the bench screen.`, `Hang K from A’s bottom inside edge, so its back edge slides on the floor.`, `Fix a block on A’s back at each bottom corner and fit the stay’s pivot: a 3.5 × 30 screw with a washer, not tight.`, `Through each end wall’s bottom border, 60 mm behind the front and 12 mm above the floor, fit the pin: an M6 × 30 bolt through a 12 mm block, with a nylon lock nut.`, `Lift A’s bottom and drop a notch on the pin.`, `Check 0, 5, 10, 15 and 20° with the speed square.`], [
      N('K hangs from A’s bottom edge on three 50 mm butt hinges (3 × 12 screws; glue a 6 mm offcut doubler under each leaf on K and on A first, or the screws come through). Cut K’s depth at the dry fit, about 140 from the 150 blank: a shallower cap no longer reaches the floor at 20°.'),
      OPEN('The stay, its pin and the cheek share the 22 mm strip at each end of A. If the cheek touches the pin’s nut, trim the cheek’s bottom back corner: K closes that part of the gap anyway.'),
      OK('Teeth don’t creep when a ball hits the front.')]],
    [11, 'Handles', d.step11(), [`Drop each K16 handle into its cut-out from above, the rim flat on the top.`, `Push six M4 × 16 pan-head Torx screws through the rim.`, `Tighten a lock nut on each, inside the box.`], [N('The tray sits 7.6 mm deep under the top: check it clears the blocks and the pocket.')]],
    [12, 'Pull-out foot', d.step12(), [`Glue two batten rails, 205 long, under the bottom from front to back, 602 apart inside.`, `Screw a strip of plywood offcut under each, overhanging 12 mm inward: the foot rides on these lips like a drawer.`, `Slide the foot T in. Pulled out 12 cm, it turns the 22 cm base into 34 cm.`, `Fit two screws in a slot to stop it at full travel.`, `Fit a turn button on the back end of a rail to hold it in.`], [N('With the foot in, check that a tripod plate still reaches the threads; if not, cut a notch in T’s front edge.')]],
    [0, 'Pockets for the covers', d.stepCoverHoles(), [`Put tape on the drill bit as a depth stop.`, `Drill the magnet pockets, Ø8 × 3 mm, into the borders of A, both D and around the flap on B.`, `Lay each cover on and mark the washer positions.`, `Drill the washer pockets about 1 mm deep in the 3 mm covers.`, `Do this now, before the paint. Magnets, washers and felt go in once the paint is dry.`], [NO('No 4 mm felt: it holds the magnet too far away.'), N('Washers are plain steel, so the magnets have no polarity to get wrong.')]],
    [13, 'Paint', d.step13(), [`Take the hinge, stays, handles and catches off, and label them.`, `Round every outside edge about 3 mm with sandpaper: P120, then P180.`, `Fill the grain on A’s front face, and sand.`, `Paint everything matte black, two coats, inside too, so nothing reflects behind the LEDs.`, `Paint A’s front face gloss black.`, `Let it cure. Then glue in the magnets, washers and felt.`], [N(`Keep the 3 mm round on A’s top front edge: at 20° that corner swings up about ${Math.ceil(d.HINGE_RISE)} mm into the top.`), N('Paint at the workshop if they allow it, or on a balcony on a drop sheet. Optional: a 2K matte clear on top against splashes.')]],
    [14, 'Pads and corner caps', d.step14(), [`Wait until the paint has fully cured.`, `Put the hardware back.`, `Stick four clear rubber pads under the rails and two under the foot’s back end.`, `Trim the black corner caps so they cover only the ends’ 6 mm edge: the front frame must swing past them.`, `Fit them on the four front corners.`], []],
  ]],
  ['D', 'Screens', 'The front frame comes off its hinge once more for the modules.', [
    [15, 'Modules on the front frame', d.step15(), [`Unscrew the hinge from the batten (it stays on A) and lay A face-down on a blanket.`, `Peel the inner film off the smoked sheet and lay it over the window.`, `Lay six modules on top, LEDs down, all arrows the same way.`, `Connect the short ribbons: 1 → 2 → 3 and 4 → 5 → 6.`, `Fit four M3 magnetic screws in each module.`, `Glue blocks on A’s top and bottom border, packed to the magnet height.`, `Screw the three steel bars onto the blocks: the magnets snap on, so a module swaps out in seconds.`], [OK('Leave the IN of modules 1 and 4 free: the driver plugs in there.'), N('Keep the sheet’s outer film on until the very end.')]],
    [16, 'Bench screens', d.step16(), [`Lay one smoked sheet behind each end window.`, `Put one module on it, arrows up.`, `Twist four turn buttons over the module’s edges.`], [N('The stay’s pin block sits just under the bench screen: keep the bottom border free.')]],
    [17, 'Hang it again', d.step17(), [`Screw the hinge back into the batten, same holes.`, `Plug in the ribbons and power leads, with about 12 cm of slack.`, `Tilt to 20° and back with everything plugged in: nothing may pull tight or catch on a cheek.`], []],
  ]],
  ['E', 'Electronics', 'Low voltage only: nothing in here can give you a shock. Solder at home, with a window open.', [
    [18, 'Build the tray', d.step18(), [`Lay all the parts on the aluminium sheet, in the rows shown.`, `Mark the holes through the parts and drill: Ø3 for M2.5, Ø3.5 for M3. Deburr.`, `Screw the converter and the fuse box flat on the metal.`, `Put everything else on standoffs.`, `Fix the two posts, 362 long, between floor and top, 150 mm behind the front.`, `Screw the tray to the posts with four screws, its parts facing the back.`, `Fit the two USB-C sockets in the back panel.`], [N('Leave 15 cm of slack on everything that goes to the back panel, so it can come off.'), N('Pi at the top, nearest the back: its Wi-Fi is the only link out, and it can’t get through the modules.'), CHECK('Only 64 mm stands free from tray to back panel, and 39 mm where the flap pocket is. Keep the tall parts away from the pocket, and check the Pi + bonnet + ribbon stack at the dry fit.')]],
    [19, 'Power path', d.step19(), [`Wire POWER socket → STUSB4500, with the TVS diode across + and − at the socket.`, `Wire STUSB4500 → 5 A fuse → INA226 (0x41, A0 bridged) → converter, in 1 mm².`, `Join −Vin to −V on the converter.`, `Wire converter → INA226 (0x40) → fuse box, in 2.5 mm².`, `After the 5 A fuse, wire a 3 A fuse → tablet charger → the USB-C hub’s charging input.`, `Put a ferrule on every wire end.`], [N('Set the STUSB4500 to “output only above 5 V”: a 5 V-only source leaves the box off instead of half-booting it.'), N('Join the converter’s −Vin to −V: the USB-C board talks to the Pi and needs a shared ground.'), N('The Pi takes its 5 V on the header pins from its own fuse; its USB-C socket stays empty.')]],
    [20, 'First power-up', d.step20(), [`Check nothing else is connected.`, `Plug a small USB-C phone charger into POWER.`, `Measure at the fuse box: it must read 5.0–5.2 V.`], [N('A weak charger is the safety net: it cannot push enough current to damage anything.')]],
    [21, 'LED power and data', d.step21(), [`Connect each of the six modules to its own fuse way: 1–6.`, `Connect the bench modules to ways 7 and 8, and the Pi to way 9.`, `Keep way 10 for the horn. 11 and 12 are spare.`, `Connect the ribbon from OUT 1 to module 1, and OUT 2 to module 4.`, `Connect OUT 3 to the left bench module, and on to the right one.`], [N('Panel power leads that don’t reach: extend with 1.5 mm².')]],
    [22, 'I²C parts and the horn', d.step22(), [`Join the USB-C board, the clock, the temperature sensor, both current sensors and the MCP23017 on two wires.`, `Connect those wires to pins 27 and 28 (GPIO 0 and 1) of the tall header.`, `Connect MCP23017 pin GPA0 to the input of the isolated MOSFET module.`, `Wire fuse way 10 through the MOSFET module to the buzzer.`, `Screw the buzzer on from inside, over the Ø32 hole.`], [CHECK('Chain 3 uses GPIO 2, 3 and 14, which is why I²C moved to pins 27/28. Confirm this still holds on the Pi 5 with the bonnet before you wire it.'), N('The MCP23017 starts with every pin an input, so the horn stays off at boot.')]],
    [0, 'Button and lights', d.stepLights(), [`Press the 16 mm button into its Ø16 hole.`, `Press the two LED holders into their Ø8 holes, next to POWER and DATA.`, `Solder a 2-pin header on the Pi 5’s J2 pads and connect the button’s switch contacts to it.`, `Connect the green ring straight to 5 V: it shows power even when the Pi is dead.`, `Connect GPA1–3 to STATUS and GPA4–6 to LINK, through 150, 47 and 47 Ω.`], [N('There is one button and it doesn’t cut power: hold it 2 s and the Pi shuts down cleanly. To switch off, unplug.'), N('Until the software drives them, STATUS and LINK stay off: no light is better than a wrong one.'), CHECK('Green and blue may be dim at 3.3 V. Look at them on the bench before you close the box.')]],
    [23, 'Control screen', d.step23(), [`Screw the screen onto the flap’s outer face.`, `Pass its ribbon through the slot.`, `Run the 300 mm DSI cable to the Pi 5’s display port, with a loose loop at the hinge so it flexes instead of folding.`], [CHECK('Run all eight modules and the screen together. The LED driver needs one Pi core; if the modules flicker with the screen on, the screen stays out.')]],
    [24, 'Test', d.step24(), [`Leave the back off and slide in the prepared SD card.`, `Power up with a 65 W laptop charger.`, `POWER lights green at once. STATUS blinks yellow, then turns green.`, `LINK shows blue with the tablet on the cable, green when online.`, `Let the self-test run, then the test pattern on all eight modules, for 30 minutes.`, `Read the result on the diagnostics page (BUILD.md §6).`], [NO('Before the first match the SD card must run read-only: then pulling the plug can’t corrupt it. Unplugging is this board’s off switch.'), CHECK('Still to write: the scoring app for the touchscreen, the diagnostics page and the light driver (BUILD.md §10.7).'), CHECK('First light on the Pi 5 with Piomatter, the screen flicker test and the soak test are not done yet on this design. If the Pi 5 path fails, a Pi 4 2 GB with the hzeller library is the fallback (BUILD.md).')]],
  ]],
  ['F', 'Finish', 'Ready for the hall.', [
    [25, 'Close up', d.step25(), [`Put the fuse map, spare fuses and a spare SD card inside the back.`, `Fit the EPDM D-seal round the back panel’s rim, and the brush seal at the front frame’s gap.`, `Put the back panel on and drive in the six T20 screws. Turn buttons hold the rest.`, `Put dust caps on the USB-C sockets.`, `Stick on the POINT HUB lettering and the back label after first light, when the port positions are final.`], []],
    [26, 'Set it up', d.step26(), [`<b>On a table:</b> lift the front frame’s bottom and drop the stays into a notch, 0 to 20° toward the first referee.`, `Swing the flap open for the scorer and pull the foot out.`, `<b>On a speaker stand or tripod:</b> foot in, flap as needed. The 3 m USB-C cable keeps the tablet on the scorer’s table.`, `Plug the charger into POWER.`, `Plug the tablet into DATA: one cable carries the scores and charges it, and no scorer PIN is needed on it.`], [OK('Any USB-C charger works from 18 W; 65 W or more gives full brightness and charges the tablet.'), NO('Never plug the DATA cable into the school’s network: it’s for the tablet or a laptop only.'), NO('Never in direct sun or by a sunny window: the box would overheat. It dims itself from 50 °C.'), N('Keep a flip scoreboard with digits of 12 cm or more in the kit: Swiss Volley requires one if the board fails.'), N('Coming in from a cold car: wait 45 minutes before switching on, or condensation can short the modules.')]],
    [0, 'Covers and bag', d.stepCovers(), [`Snap on the front cover.`, `Snap on both end covers.`, `Snap on the lid over the flap.`, `Put the box in its padded bag, with chargers and cables in the outer pocket.`, `Order the bag once the box is built, from the real measurements.`], [N('Keep the T20 key, the flip scoreboard and the 3 m USB-C cable in the outer pocket.')]],
    [27, 'Open it', d.step27(), [`Unplug the charger.`, `Undo the six T20 screws.`, `Ease the back panel off.`, `Unplug the screen ribbon at the Pi: the tray faces you and everything is in reach.`], [OK('Swapping the SD card or a fuse takes a minute.'), N('The back takes a T20 key on purpose: in a public hall, anything that opens by hand gets opened. Keep the key in the kit bag.')]],
  ]],
];

const SKILLS = [
  ['jigsaw', 'Cut a window with the jigsaw', ['Take the battery out, fit the blade, push it till it locks. T101B for straights, T101AOF for corners.', 'Mark the cut, with masking tape on the line, and lay the good face <b>down</b>: the blade cuts on the up stroke.', 'Clamp the sheet so the blade has free space below it.', 'Drill Ø8 inside every corner.', 'Set orbit to 0, for the cleanest cut.', 'Saw from hole to hole, with the shoe flat, letting the blade do the work.', 'File the corners clean.'], [['Bosch: cutting an opening, drill the corners first (Norwegian, good pictures)', 'https://www.bosch-diy.com/no/no/all-about-diy/step-by-step-project/worktop-additions'], ['Bosch GST 18V-125 S: product page, with the manual', 'https://www.bosch-professional.com/gb/en/products/gst-18v-125-s-06015B2001']]],
  ['straight', 'Saw a straight line', ['Measure from the blade to the edge of the shoe, on an offcut.', 'Clamp a straight batten that far from your line.', 'Keep the shoe tight against the batten for the whole cut.', 'Cut a little wide and sand down to size.'], []],
  ['holesaw', 'Cut a round hole', ['Mark the centre and clamp the board.', 'Drill in gear 1, hammer off.', 'Stop halfway, when the centre bit has come through.', 'Turn the board over and finish from the other side, using the same centre hole.'], [['This Old House: how to use a hole saw', 'https://www.thisoldhouse.com/tools/how-to-use-a-hole-saw'], ['Ron Hazelton: clean holes with a hole saw', 'https://www.ronhazelton.com/tips/how_to_bore_clean_holes_with_a_hole_saw']]],
  ['predrill', 'Pre-drill and screw', ['Drill Ø2.5 through the panel and into the beech.', 'Set the drill’s clutch low, gear 1, T20 bit.', 'Drive the screw until the head sits flush.'], [['Bosch GSB 18V-65: product page, with the manual', 'https://www.bosch-professional.com/gb/en/products/gsb-18v-65-06019N3300']]],
  ['metal', 'Cut and drill metal', ['Mark the spot and press the centre punch on it.', 'Clamp the bar in the vise.', 'Put a drop of oil on the mark.', 'Drill slowly with an HSS bit, gear 1, light pressure.', 'Saw with the T118B blade at low speed.', 'File every edge and hole. Wear glasses.'], [['Instructables: how to use a centre punch', 'https://www.instructables.com/How-to-Use-a-Center-Punch-With-Metal'], ['Tivoly: drilling guide', 'https://www.tivoly.com/en/faq/drill-guide']]],
  ['glue', 'Glue and tape a joint', ['Dry fit first. Lay out parts, tape, screws and a damp cloth.', 'Run a thin line of D3 glue and spread it.', 'Join the parts: tiny beads along the joint mean the right amount.', 'Tape every 15 cm across the joint, pulled tight. Clamp the short joints.', 'Check the diagonals are equal.', 'Wipe off the squeeze-out and let it dry overnight.'], [['Fine Woodworking: tips on gluing', 'https://www.finewoodworking.com/item/27124/how-to-glue-up-joints-tips-on-gluing'], ['Rockler: how long to clamp', 'https://rockler.com/learn/glue-up-clamping-time']]],
  ['forstner', 'Sink a magnet or washer pocket', ['Wrap tape round the bit at the depth you want.', 'Try it on an offcut and check with the magnet.', 'Drill slowly, gear 1, stopping when the tape touches.', 'For the 3 mm covers, drill 1 mm deep only.'], [['Woodcraft: depth stops for Forstner bits', 'https://www.woodcraft.com/blogs/magazine/stop-collar-for-forstner-bits'], ['KM Tools: stop Forstner tear-out', 'https://kmtools.com/blogs/news/quick-tip-forstner-bit-tearout']]],
  ['spray', 'Spray paint', ['Sand smooth, remove the dust, mask what must stay bare.', 'Shake the can for as long as it says.', 'Try it on an offcut first.', 'Spray from about 25 cm in long passes. Start and stop past the edge.', 'Thin coats. Wait as the can says, then sand lightly with P180.', '2K paint: outside only, A2 respirator and gloves.'], [['Instructables: perfectly spray paint', 'https://www.instructables.com/Perfectly-Spray-Paint'], ['Homebuilding: spray painting wood', 'https://www.homebuilding.co.uk/advice/spray-painting-wood'], ['Krylon: how to spray paint', 'https://www.krylon.com/en/how-to/how-to-spray-paint']]],
  ['crimp', 'Strip and crimp a wire end', ['Strip 8 mm: automatic stripper, one squeeze.', 'Twist the strands tight.', 'Push the ferrule on: no strands left outside.', 'Crimp in the HSC8 until it opens by itself.', 'Tug hard. If it moves, cut it off and use a new one.'], [['DigiKey: using and crimping wire ferrules', 'https://forum.digikey.com/t/using-and-crimping-wire-ferrules/1358'], ['Herth+Buss: crimping video', 'https://herthundbuss.com/en/videos-en/professional-and-precise-crimping-of-wire-end-ferrules-fast-and-uncomplicated/']]],
  ['solder', 'Solder a joint', ['Power the Pinecil from a USB-C PD charger, 65 W. Set 320–350 °C and let it heat up.', 'Tin the tip: touch solder on it, wipe it on the cleaner.', 'Slide heat-shrink on the wire now, if it needs some.', 'Hold the tip on the pad and the pin together for about 2 s.', 'Feed solder into the joint, not onto the iron.', 'Take the solder away, then the iron.', 'Look: shiny and cone-shaped is right. Slide the heat-shrink over and warm it evenly.'], [['Adafruit: guide to excellent soldering', 'https://learn.adafruit.com/adafruit-guide-excellent-soldering'], ['Adafruit: what bad joints look like', 'https://learn.adafruit.com/adafruit-guide-excellent-soldering/common-problems'], ['PINE64: Pinecil wiki', 'https://wiki.pine64.org/wiki/Pinecil']]],
  ['meter', 'Measure a voltage', ['Black lead in COM, red in V.', 'Turn the dial to DC volts: V with a straight line.', 'Black probe on −, red on +. Read the display.', 'A minus sign means they’re swapped: nothing breaks.'], [['SparkFun: how to use a multimeter', 'https://learn.sparkfun.com/tutorials/how-to-use-a-multimeter/introduction']]],
];
const skillName = Object.fromEntries(SKILLS.map(s => [s[0], s[1]]));
const USES = { 'One module, one test': ['meter', 'crimp'], 'Cut the openings': ['jigsaw', 'holesaw'], 'Rip the blanks': ['straight'], 'Make the metal parts': ['metal'], 'Glue the shell': ['glue', 'predrill'], 'Stand cup and threads': ['holesaw'], 'Screen pocket and flap': ['glue'], 'Hang the front frame': ['predrill'], 'Cap, cheeks and stays': ['metal', 'predrill'], 'Pull-out foot': ['glue', 'predrill'], 'Pockets for the covers': ['forstner'], 'Paint': ['spray'], 'Build the tray': ['metal'], 'Power path': ['crimp', 'solder'], 'First power-up': ['meter'], 'LED power and data': ['crimp'], 'I²C parts and the horn': ['solder'], 'Button and lights': ['solder'], 'Test': ['meter'] };
const host = (u) => new URL(u).hostname.replace(/^www\./, '');
const skillHtml = SKILLS.map(([k, name, acts, links]) => `<article class="skill" id="how-${k}"><div class="fig">${d.how[k]()}</div><div class="txt"><h3>${name}</h3><ol class="acts">${acts.map(a => `<li><span>${a}</span></li>`).join('')}</ol>${links.length ? `<ul class="links">${links.map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${t}</a> <span>${host(u)}</span></li>`).join('')}</ul>` : ''}</div></article>`).join('');
let stepNo = 0;
stages.forEach(s => s[3].forEach(st => { st[0] = ++stepNo; }));
const partCards = wood.map(([ic, L, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[ic]}</div><div class="plabel">${L ? `<span class="pl">${L}</span>` : ''}<span class="pn">${name}</span><span class="pq">×${n}</span></div><span class="ps">${spec}</span></li>`).join('');
const groupHtml = groups.map(([g, items]) => `<div class="label subh">${g}</div><ul class="grid">${items.map(([k, name, spec, n]) => `<li class="part"><div class="pic">${d.icons[k]}</div><div class="plabel"><span class="pn">${name}</span><span class="pq">${n > 1 ? '×' + n : ''}</span></div><span class="ps">${spec}</span></li>`).join('')}</ul>`).join('');
const toolCards = toolList.map(([k, name, spec]) => `<li class="part tool"><div class="pic">${d.tools[k]}</div><div class="plabel"><span class="pn">${name}</span></div><span class="ps">${spec}</span></li>`).join('');
const two = (n) => String(n).padStart(2, '0');
const stageTimes = { A: 'about 2 h', B: 'one workshop afternoon', C: 'about 8 h + paint cure', D: 'about 2 h', E: 'about 6 h', F: 'about 1 h' };
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
      <ol class="acts">${cap.map(s => `<li><span>${s}</span></li>`).join('')}</ol>
      ${USES[title] ? `<p class="usehow">How to: ${USES[title].map(k => `<a href="#how-${k}">${skillName[k]}</a>`).join(' · ')}</p>` : ''}
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
.toc { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; margin-top: 56px; background: var(--line); border: 1px solid var(--line); }
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
.acts { list-style: none; counter-reset: act; margin: 0; padding: 0; display: grid; gap: 8px; max-width: 60ch; }
.acts li { counter-increment: act; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; font-size: 16px; }
.acts li::before { content: counter(act); width: 24px; height: 24px; border-radius: 50%; background: var(--ink); color: var(--sheet); display: grid; place-items: center; font: 600 12px var(--mono); }
.skills { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.skill { background: var(--sheet); border-radius: 8px; padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-content: start; min-width: 0; scroll-margin-top: 16px; }
.skill .fig { padding: 0; overflow: visible; }
.skill .fig .ill { min-width: 0 !important; width: 100%; }
.skill h3 { font-size: 22px; font-weight: 600; font-variation-settings: "wdth" 85; }
.skill .acts li { font-size: 14.5px; }
.links { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 14px; }
.links a, .usehow a { color: var(--blue); }
.links span { color: var(--faint); font: 400 11px var(--mono); margin-left: 6px; }
.usehow { font-size: 14px; color: var(--mute); }
@media (max-width: 760px) { .skills { grid-template-columns: minmax(0, 1fr); } }
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
@media print {
  @page { size: A4; }
  body { background: #fff; font-size: 11pt; }
  .wrap { max-width: none; padding: 0; }
  .bar, #stage3d { display: none !important; }
  #poster { display: grid !important; }
  .stage { background: none; }
  .view { max-height: 62mm; }
  .subh { break-after: avoid; margin: 4mm 0 2mm; }
  .part { padding: 2mm; gap: 1mm; }
  .pn { font-size: 8.5pt; } .ps { font-size: 7.5pt; } .pq { font-size: 8pt; }
  .specs dd { font-size: 12pt; } .specs div { padding: 2mm 2mm 2mm 0; }
  .step { padding-block: 3mm; }
  h1 { font-size: 64pt; }
  .hero-t { padding-block: 8mm 6mm; }
  .toc { margin-top: 8mm; grid-template-columns: repeat(6, minmax(0, 1fr)); }
  section.block { padding-top: 8mm; break-before: page; }
  .part { break-inside: avoid; border: 1px solid var(--line); }
  .stage-sec { padding-top: 0; break-before: page; }
  .stage-head { break-after: avoid; }
  .step { grid-template-columns: 1fr; gap: 3mm; padding-block: 5mm; break-inside: avoid; }
  .fig { padding: 0; overflow: visible; }
  .fig .ill { min-width: 0 !important; max-height: 88mm; width: auto; max-width: 100%; margin: 0 auto; }
  .skills { grid-template-columns: minmax(0, 1fr); gap: 3mm; }
  .skill { break-inside: avoid; border: 1px solid var(--line); padding: 3mm; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 4mm; align-items: start; }
  .skill h3 { font-size: 13pt; }
  .skill .acts li, .links { font-size: 9pt; }
  .skill .fig .ill { width: 100%; max-height: none; margin: 0; }
  .grid { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 2mm; }
  .acts { gap: 1.2mm; } .notes { gap: 1mm; }
  .toc { break-inside: avoid; }
  .acts, .notes { max-width: none; }
  .acts li { font-size: 10.5pt; }
  .notes li { font-size: 9.5pt; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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

  <section class="block" id="how" aria-labelledby="how-h">
    <div class="bh"><h2 id="how-h">How to do it</h2><p>Each technique once, with a drawing. The steps link back here. The links open guides and videos from other sites.</p></div>
    <div class="skills">${skillHtml}</div>
  </section>

  ${stageHtml}

  <footer class="end">
    <p>KSC Wiedikon · Point Hub board build manual, design D, draft of 4 November 2026.</p>
    <p>The panel software comes ready on the SD card. Wiring, settings and safety: BUILD.md.</p>
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
