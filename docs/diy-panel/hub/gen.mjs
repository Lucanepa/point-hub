// Level 1 hub board: 1:1 placement drawing + connections, for a paper check before KiCad.
// Every number is in millimetres, board origin top left, seen from the parts side.
// node docs/diy-panel/hub/gen.mjs  →  hub-level1.html (print it at 100 %, or use pdf.cjs)
import fs from 'node:fs';

const dir = new URL('.', import.meta.url).pathname;
const W = 90, H = 60, P = 2.54, XH = 2.5;

// JST-XH top-entry socket: n pins at 2.5 mm, body (n−1)·2.5 + 4.9 long, 5.75 deep, the cable
// side 3.4 from the pin row. `open` is the side the cable leaves; `edge` is where the body sits.
function xh(ref, n, open, edge, start, pins, what) {
  const len = (n - 1) * XH + 4.9;
  let x0, y0, w, h, pts = [];
  if (open === 'up' || open === 'down') {
    w = len; h = 5.75; x0 = start; y0 = open === 'up' ? edge : edge - h;
    const py = open === 'up' ? y0 + 3.4 : y0 + h - 3.4;
    for (let i = 0; i < n; i++) pts.push([x0 + 2.45 + i * XH, py]);
  } else {
    w = 5.75; h = len; y0 = start; x0 = open === 'left' ? edge : edge - w;
    const px = open === 'left' ? x0 + 3.4 : x0 + w - 3.4;
    for (let i = 0; i < n; i++) pts.push([px, y0 + 2.45 + i * XH]);
  }
  return { kind: 'xh', ref, open, box: [x0, y0, w, h], pts, pins, what };
}

// 2.54 mm female header strip for a module that plugs in.
function strip(ref, pts, pins) { return { kind: 'strip', ref, pts, pins }; }

const parts = [];

// I²C ports along the top edge, cable up: GND, 3V3, SDA, SCL (the order on the INA226 is different:
// wire the pigtail to the module's labels).
const ports = [['J2', 'INA226 5 V out · 0x40'], ['J3', 'INA226 input · 0x41'], ['J4', 'STUSB4500 · 0x28'], ['J5', 'SHT40 · 0x44'], ['J6', 'spare']];
ports.forEach(([ref, what], k) => parts.push(xh(ref, 4, 'up', 0, 11 + k * 14, ['GND', '3V3', 'SDA', 'SCL'], what)));

// The lead to the Pi, left edge.
parts.push(xh('J1', 6, 'left', 0, 17, ['3V3', '5V', 'GND', 'SDA', 'SCL', 'OE'], 'to the Pi: pins 1, 4, 6, 27, 28, 12'));

// Lights and button, right edge.
parts.push(xh('J8', 4, 'right', W, 13, ['R', 'G', 'B', 'K'], 'STATUS light'));
parts.push(xh('J9', 4, 'right', W, 27, ['R', 'G', 'B', 'K'], 'LINK light'));
parts.push(xh('J10', 4, 'right', W, 41, ['RING', 'RING', 'SW', 'SW'], 'button: red, red, black, black'));

// Horn signal and the Pi 5 power pads, bottom edge.
parts.push(xh('J7', 2, 'down', H, 58, ['GPA0', 'GND'], 'horn (AOD4184)'));
parts.push(xh('J11', 2, 'down', H, 69, ['SW', 'SW'], 'Pi 5 J2 pads'));

// MCP23017 module ≈ 28 × 21.5, label side up: one row of 10 on one long edge, two rows of 10 on
// the other, 15.24 from the single row to the nearer double row. Paper check 13.11: single row at
// the top, VCC at the left; the silk reads "B7/A7", so B is the inner row, A the outer (beep test
// GND → right end of each double row confirms it: the A row has GND).
const mx = 20, my = 14;
const single = ['VCC', 'GND', 'SCL', 'SDA', 'NC', 'NC', 'RST', 'A0', 'A1', 'A2'];
const rowB = ['B7', 'B6', 'B5', 'B4', 'B3', 'B2', 'B1', 'B0', 'INTB', 'VCC'];
const rowA = ['A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'INTA', 'GND'];
parts.push(strip('U1', single.map((_, i) => [mx + i * P, my]), single));
parts.push(strip('U1b', rowB.map((_, i) => [mx + i * P, my + 6 * P]), rowB));
parts.push(strip('U1a', rowA.map((_, i) => [mx + i * P, my + 7 * P]), rowA));
const mcp = { x: mx + 4.5 * P - 14, y: my + 3.5 * P - 10.75, w: 28, h: 21.5 };

// DS3231 module (HW-084 / ZS-042) ≈ 38 × 22, chip side up, cell holder underneath. Paper check
// 13.11: its right-angle header (32K SQW SCL SDA VCC GND, top to bottom) points out sideways and
// cannot plug into the hub. Instead 4 straight male pins go into the module's empty pass-through
// holes at the other end (SCL SDA VCC GND, top to bottom) and plug into a 1 × 4 female header.
// Header 8.5 + pin plastic 2.5 = 11 mm under the module, room for the cell holder.
// Measured on the paper 13.11: ≈ 40 × 24; the holes sit 2 from the short edge and 1 above the
// middle. Moved 2 right so the old right-angle pins (≈ 8 further left) stay over the board.
const rtc = { x: 12.5, y: 35, w: 40, h: 24 };
const dx = rtc.x + rtc.w - 2, dy = rtc.y + rtc.h / 2 - 1 - 1.5 * P;
const ds = ['SCL', 'SDA', 'VCC', 'GND'];
parts.push(strip('U2', ds.map((_, i) => [dx, dy + i * P]), ds));

// Resistors, ¼ W axial, pads 10.16 apart.
const res = [['R1', '10k', 'OE pull-up'], ['R2', '150', 'STATUS red'], ['R3', '47', 'STATUS green'], ['R4', '47', 'STATUS blue'],
  ['R5', '150', 'LINK red'], ['R6', '47', 'LINK green'], ['R7', '47', 'LINK blue']];
res.forEach(([ref, val, what], j) => parts.push({ kind: 'res', ref, val, what, a: [52, 12.5 + j * 3.6], b: [52 + 4 * P, 12.5 + j * 3.6] }));

const holes = [[3.5, 3.5], [W - 3.5, 3.5], [3.5, H - 3.5], [W - 3.5, H - 3.5]];

// ---- drawing -------------------------------------------------------------------------------
const f = (v) => +v.toFixed(2);
function board(detail) {
  const s = [];
  const t = (x, y, txt, size, opt = '') => s.push(`<text x="${f(x)}" y="${f(y)}" font-size="${size}" ${opt}>${txt}</text>`);
  s.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="1.5" class="pcb"/>`);
  for (const [x, y] of holes) {
    s.push(`<circle cx="${x}" cy="${y}" r="2.5" class="keep"/><circle cx="${x}" cy="${y}" r="1.35" class="hole"/>`);
  }
  // module silhouettes first, so pads draw on top
  s.push(`<rect x="${f(mcp.x)}" y="${f(mcp.y)}" width="${mcp.w}" height="${mcp.h}" class="mod"/>`);
  t(mcp.x + mcp.w / 2, mcp.y + mcp.h / 2 - (detail ? 1.2 : 0.2), 'U1 MCP23017', detail ? 1.5 : 1.9, 'text-anchor="middle" class="modt"');
  t(mcp.x + mcp.w / 2, mcp.y + mcp.h / 2 + (detail ? 0.8 : 2.2), '28 × 21.5', detail ? 1.2 : 1.6, 'text-anchor="middle" class="dim"');
  s.push(`<rect x="${f(rtc.x)}" y="${f(rtc.y)}" width="${rtc.w}" height="${rtc.h}" class="mod2"/>`);
  t(rtc.x + rtc.w / 2 - 3, rtc.y + rtc.h / 2 - 0.5, 'U2 DS3231, chip side up', detail ? 1.4 : 1.8, 'text-anchor="middle" class="modt"');
  t(rtc.x + rtc.w / 2 - 3, rtc.y + rtc.h / 2 + 2, '40 × 24 · 11 mm above the board', detail ? 1.2 : 1.6, 'text-anchor="middle" class="dim"');
  t(rtc.x + 1, rtc.y + 2.6, '← old right-angle pins, unused', detail ? 1 : 1.3, 'class="dim"');

  for (const p of parts) {
    if (p.kind === 'xh') {
      const [x, y, w, h] = p.box;
      s.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" class="xh"/>`);
      p.pts.forEach(([px, py], i) => s.push(i === 0
        ? `<rect x="${f(px - 0.55)}" y="${f(py - 0.55)}" width="1.1" height="1.1" class="pad"/>`
        : `<circle cx="${f(px)}" cy="${f(py)}" r="0.55" class="pad"/>`));
      const horiz = p.open === 'up' || p.open === 'down';
      const lx = horiz ? x + w / 2 : (p.open === 'left' ? x + w + 1.2 : x - 1.2);
      const ly = horiz ? (p.open === 'up' ? y + h + (detail ? 3.4 : 2) : y - (detail ? 3 : 1)) : y + h / 2;
      const anchor = horiz ? 'middle' : (p.open === 'left' ? 'start' : 'end');
      t(lx, ly, p.ref, detail ? 1.5 : 1.8, `text-anchor="${anchor}" class="ref"`);
      if (detail) {
        p.pts.forEach(([px, py], i) => {
          if (horiz) t(px, p.open === 'up' ? py + 3.5 : py - 2.4, p.pins[i], 0.75, 'text-anchor="middle" class="pin"');
          else t(p.open === 'left' ? px - 1.3 : px + 1.3, py + 0.3, p.pins[i], 0.75, `text-anchor="${p.open === 'left' ? 'end' : 'start'}" class="pin pinout"`);
        });
        const wx = horiz ? x + w / 2 : (p.open === 'left' ? x + w + 1.2 : x - 1.2);
        const wy = horiz ? (p.open === 'up' ? y + h + 4.6 : y - 4.2) : y + h / 2 + 1.6;
        t(wx, wy, p.what, 0.8, `text-anchor="${anchor}" class="what"`);
      }
    } else if (p.kind === 'strip') {
      for (const [px, py] of p.pts) s.push(`<rect x="${f(px - 1.27)}" y="${f(py - 1.27)}" width="${P}" height="${P}" class="fh"/>`);
      p.pts.forEach(([px, py], i) => s.push(i === 0 && p.ref !== 'U1b' && p.ref !== 'U1a'
        ? `<rect x="${f(px - 0.5)}" y="${f(py - 0.5)}" width="1" height="1" class="pad"/>`
        : `<circle cx="${f(px)}" cy="${f(py)}" r="0.5" class="pad"/>`));
      if (detail) {
        const vertical = p.ref === 'U2';
        p.pts.forEach(([px, py], i) => {
          if (vertical) t(px - 1.6, py + 0.3, p.pins[i], 0.75, 'text-anchor="end" class="pin"');
          else if (p.ref === 'U1') t(px, py - 1.7, p.pins[i], 0.7, 'text-anchor="middle" class="pin"');
          else if (p.ref === 'U1b') t(px, py - 1.6, p.pins[i], 0.62, 'text-anchor="middle" class="pin"');
          else t(px, py + 2.2, p.pins[i], 0.62, 'text-anchor="middle" class="pin"');
        });
      }
    } else if (p.kind === 'res') {
      const [ax, ay] = p.a, [bx] = p.b;
      s.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${ay}" class="lead"/>`);
      s.push(`<rect x="${f((ax + bx) / 2 - 3.2)}" y="${f(ay - 1.15)}" width="6.4" height="2.3" rx="0.9" class="res"/>`);
      s.push(`<circle cx="${ax}" cy="${ay}" r="0.6" class="pad"/><circle cx="${f(bx)}" cy="${ay}" r="0.6" class="pad"/>`);
      t((ax + bx) / 2, ay + 0.45, `${p.ref} ${p.val}`, detail ? 1.05 : 1.2, 'text-anchor="middle" class="rv"');
      if (detail) t(bx + 1.2, ay + 0.3, p.what, 0.8, 'class="what"');
    }
  }
  t(55, 41.5, 'Point Hub · hub L1 · v0.3', detail ? 1.2 : 1.5, 'class="silk"');
  return s.join('\n');
}

function svg(scale, detail) {
  const m = detail ? 12 : 8;
  const vb = `${-m} ${-m} ${W + 2 * m} ${H + 2 * m}`;
  const dims = [
    `<line x1="0" y1="${H + 3}" x2="${W}" y2="${H + 3}" class="dimline"/>`,
    `<text x="${W / 2}" y="${H + 5.6}" font-size="2" text-anchor="middle" class="dim">90 mm</text>`,
    `<line x1="${-3}" y1="0" x2="${-3}" y2="${H}" class="dimline"/>`,
    `<text x="${-4.2}" y="${H / 2}" font-size="2" text-anchor="middle" class="dim" transform="rotate(-90 ${-4.2} ${H / 2})">60 mm</text>`,
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" style="width:${(W + 2 * m) * scale}mm;height:${(H + 2 * m) * scale}mm">${board(detail)}${detail ? '' : dims}</svg>`;
}

// ---- connections ----------------------------------------------------------------------------
const nets = [
  ['3V3', 'J1·1 (Pi pin 1) → every port J2–J6 pin 2, U1 VCC (both), U1 RST, U2 VCC, R1'],
  ['5V', 'J1·2 (Pi pin 4) → J10·1 (button ring)'],
  ['GND', 'J1·3 (Pi pin 6) → ports J2–J6 pin 1, U1 GND (both), U1 address pins A0 A1 A2 (single row), U2 GND, J7·2, J8·4, J9·4, J10·2'],
  ['SDA', 'J1·4 (Pi pin 27, GPIO0) → ports J2–J6 pin 3, U1 SDA, U2 SDA'],
  ['SCL', 'J1·5 (Pi pin 28, GPIO1) → ports J2–J6 pin 4, U1 SCL, U2 SCL'],
  ['OE', 'J1·6 (Pi pin 12, GPIO18) → R1 10k → 3V3: panels stay dark at power-on'],
  ['Horn', 'U1 GPA0 (port-A row “A0”) → J7·1 (horn: AOD4184 PWM; J7·2 → its GND)'],
  ['STATUS', 'U1 GPA1 → R2 150 → J8·1 red; GPA2 → R3 47 → J8·2 green; GPA3 → R4 47 → J8·3 blue; J8·4 = common cathode'],
  ['LINK', 'U1 GPA4 → R5 150 → J9·1 red; GPA5 → R6 47 → J9·2 green; GPA6 → R7 47 → J9·3 blue; J9·4 = common cathode'],
  ['Button', 'J10·3 → J11·1, J10·4 → J11·2 (straight through to the Pi 5 J2 pads; either way round)'],
  ['Unused', 'U1 port B, INTA, INTB, GPA7 (input); the DS3231 right-angle header (32K, SQW and a second copy of the bus)'],
];
const bom = [
  ['Hub PCB', '90 × 60, 2 layers, 1.6 mm, JLCPCB (5 pieces is the minimum order)', 'after this check, in KiCad'],
  ['JST-XH sockets, top entry, through-hole', '2-pin × 2, 4-pin × 8, 6-pin × 1', 'to buy'],
  ['JST-XH pigtails, pre-crimped, 20–30 cm', '2-pin × 2, 4-pin × 8, 6-pin × 1 (no crimping needed)', 'to buy'],
  ['Female headers 2.54 mm, 8.5 mm tall', '1 × 10 (×1), 2 × 10 (×1), 1 × 4 (×1)', 'to buy (or from a kit)'],
  ['Male pin header 2.54 mm, straight', '1 × 4 for the DS3231 (the MCP23017 bag has its own)', 'kit'],
  ['Dupont female housings 1-pin', '6, for the Pi end of the J1 lead', 'to buy (or cut a jumper)'],
  ['Resistors', '10k × 1, 150 × 2, 47 × 4', 'arrived 12.11'],
  ['M2.5 standoffs + screws', '4', 'kit'],
];
const checks = [
  'Print page 1 at <b>100 % / actual size</b> (not “fit to page”). The 50 mm bar must measure 50 mm, the board 90 × 60.',
  '<b>MCP23017</b>, label side up: single row at the top, VCC at the left (checked 13.11). Beep test: one probe on single-row GND, the other on the right end of the inner row, then the outer row. The one that beeps is row A; the drawing says outer.',
  '<b>DS3231</b>, chip side up: the four plain holes at its right end (SCL SDA VCC GND) sit over U2, SCL on the square (checked 13.11). Cell side up is mirrored: SCL would land on GND.',
  'Put the <b>INA226</b>, <b>AOD4184</b> and <b>button</b> next to the paper where they will sit in the box: are the J-sockets on the right side for their wires?',
  'Tell me what moves; I make the KiCad board from the corrected positions.',
];

const css = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.35 system-ui, sans-serif; color: #111; }
.page { width: 210mm; height: 297mm; padding: 14mm 14mm 12mm; page-break-after: always; position: relative; }
.page:last-child { page-break-after: auto; }
h1 { font-size: 16pt; margin: 0 0 1mm; } h2 { font-size: 12pt; margin: 5mm 0 2mm; }
.sub { color: #555; margin: 0 0 5mm; }
.bar { display: flex; align-items: center; gap: 3mm; margin: 6mm 0 2mm; }
.bar .b { width: 50mm; height: 3mm; background: repeating-linear-gradient(90deg, #111 0 10mm, #fff 10mm 20mm); border: 0.2mm solid #111; }
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; }
td, th { border-bottom: 0.2mm solid #ccc; padding: 0.8mm 1.5mm; text-align: left; vertical-align: top; }
th { background: #f2f2f2; }
ol { padding-left: 5mm; } li { margin-bottom: 1.5mm; }
.center { display: flex; justify-content: center; }
.pcb { fill: #f4f8f2; stroke: #111; stroke-width: 0.25; }
.hole { fill: #fff; stroke: #111; stroke-width: 0.2; } .keep { fill: none; stroke: #999; stroke-width: 0.12; stroke-dasharray: 0.6 0.4; }
.mod { fill: #fde9e7; stroke: #c0392b; stroke-width: 0.2; stroke-dasharray: 1 0.5; }
.mod2 { fill: rgba(52, 120, 200, 0.10); stroke: #2c6db5; stroke-width: 0.2; stroke-dasharray: 1 0.5; }
.xh { fill: #fff; stroke: #333; stroke-width: 0.2; }
.fh { fill: #222; stroke: none; opacity: 0.12; }
.pad { fill: #b8860b; stroke: #6b4d00; stroke-width: 0.1; }
.res { fill: #d8c7a3; stroke: #6b5a3a; stroke-width: 0.12; } .lead { stroke: #777; stroke-width: 0.3; }
text { font-family: system-ui, sans-serif; fill: #111; }
.ref { font-weight: 700; } .pin { fill: #333; } .what { fill: #2c6db5; } .rv { font-weight: 600; }
.modt { font-weight: 700; fill: #333; } .dim { fill: #666; } .silk { fill: #777; }
.dimline { stroke: #666; stroke-width: 0.15; }
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Point Hub · hub board L1 · paper check</title><style>${css}</style></head><body>
<section class="page">
  <h1>Hub board, Level 1 — paper check at 1:1</h1>
  <p class="sub">Point Hub board · v0.3 · 13.11.2026 · seen from the parts side · print at 100 %</p>
  <div class="center">${svg(1, false)}</div>
  <div class="bar"><div class="b"></div><span>50 mm: check with the ruler before you lay parts on it</span></div>
  <h2>What to check</h2>
  <ol>${checks.map((c) => `<li>${c}</li>`).join('')}</ol>
  <p class="sub" style="margin-top:4mm">Squares = pin 1. Red outline = MCP23017 (plugs in from above). Blue outline = DS3231 (on 4 straight pins, chip side up, cell underneath).
  Dashed circles = M2.5 holes, keep clear. The INA226 boards, AOD4184, PD board and button are <b>not</b> on the hub; they connect with cables.</p>
</section>
<section class="page">
  <h1>Pin names (enlarged, not for measuring)</h1>
  <p class="sub">Socket pin order as seen from the parts side; pin 1 is the square pad.</p>
  <div class="center">${svg(1.6, true)}</div>
  <h2>Notes</h2>
  <ol>
    <li>Everything runs at <b>3.3 V</b> (MCP23017, DS3231, INA226, SHT40). The only 5 V on the hub is the button ring.</li>
    <li>I²C pull-ups come from the modules. With all of them on the bus they add up: if the bus is unreliable, cut the I²C pull-up jumper on the STUSB4500 board first.</li>
    <li>The I²C ports are JST-XH, not Qwiic: through-hole, easy to solder by hand, and they lock. Wire each pigtail to the module's own pin labels (the INA226 order is VCC SDA SCL ALE GND).</li>
    <li>The J1 lead: XH-6 on the hub, six single Dupont housings on the Pi's pins 1, 4, 6, 12, 27, 28 through the tall stacking header.</li>
    <li>DS3231: solder 4 straight male pins into its plain SCL SDA VCC GND holes, plastic on the cell side, pins pointing down (with the Pinecil, in the same session as removing the module's charging resistor “201” next to D2). Leave the right-angle header on; put tape over its pins so they touch nothing.</li>
    <li>Positions follow ruler photos (±1 mm). Nothing is ordered until the paper check is done.</li>
  </ol>
</section>
<section class="page">
  <h1>Connections</h1>
  <table><tr><th>Net</th><th>Joins</th></tr>${nets.map(([n, j]) => `<tr><td><b>${n}</b></td><td>${j}</td></tr>`).join('')}</table>
  <h2>Ports</h2>
  <table><tr><th>Socket</th><th>Pins</th><th>Goes to</th></tr>${parts.filter((p) => p.kind === 'xh').sort((a, b) => +a.ref.slice(1) - +b.ref.slice(1))
    .map((p) => `<tr><td><b>${p.ref}</b></td><td>${p.pins.join(' · ')}</td><td>${p.what}</td></tr>`).join('')}</table>
  <h2>Parts for the hub</h2>
  <table><tr><th>Part</th><th>How many</th><th>State</th></tr>${bom.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>
</section>
</body></html>`;

fs.writeFileSync(dir + 'hub-level1.html', html);
console.log('wrote', dir + 'hub-level1.html');
