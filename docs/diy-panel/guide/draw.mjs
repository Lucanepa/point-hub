// IKEA-style line drawings for the Point Hub board guide. Everything is drawn to scale
// from the real dimensions (mm). World axes for the standing box: X left->right
// (0..1020), Y front->back (0..220), Z bottom->top (0..380).
let UID = 0;
const R = n => Math.round(n * 10) / 10;
const P2 = a => a.map(p => R(p[0]) + ',' + R(p[1])).join(' ');
export const poly = (a, c = 'o p0') => `<polygon class="${c}" points="${P2(a)}"/>`;
export const pline = (a, c = 'o nf') => `<polyline class="${c}" points="${P2(a)}"/>`;
export const path = (d, c = 'o nf') => `<path class="${c}" d="${d}"/>`;
export const ln = (a, b, c = 'o') => `<line class="${c}" x1="${R(a[0])}" y1="${R(a[1])}" x2="${R(b[0])}" y2="${R(b[1])}"/>`;
export const rect = (x, y, w, h, c = 'o p0', rx = 0) => `<rect class="${c}" x="${R(x)}" y="${R(y)}" width="${R(w)}" height="${R(h)}"${rx ? ` rx="${rx}"` : ''}/>`;
export const circ = (x, y, r, c = 'o p0') => `<circle class="${c}" cx="${R(x)}" cy="${R(y)}" r="${R(r)}"/>`;
export const txt = (x, y, s, c = 't', a = 'middle') => `<text class="${c}" x="${R(x)}" y="${R(y)}" text-anchor="${a}">${s}</text>`;
const lines = (x, y, arr, c = 'tl', a = 'start', lh = 15) => arr.map((s, i) => txt(x, y + i * lh, s, c, a)).join('');

function head(b, ux, uy, s) {
  const bx = b[0] - ux * s, by = b[1] - uy * s, px = -uy, py = ux;
  return poly([[b[0], b[1]], [bx + px * s * 0.48, by + py * s * 0.48], [bx - px * s * 0.48, by - py * s * 0.48]], 'ah');
}
export function arrow(a, b, c = 'ar', s = 10) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  return ln(a, [b[0] - ux * s * 0.7, b[1] - uy * s * 0.7], c) + head(b, ux, uy, s);
}
export function carrow(a, q, b, c = 'ar', s = 10) {
  const dx = b[0] - q[0], dy = b[1] - q[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const e = [b[0] - ux * s * 0.7, b[1] - uy * s * 0.7];
  return path(`M${R(a[0])} ${R(a[1])} Q${R(q[0])} ${R(q[1])} ${R(e[0])} ${R(e[1])}`, c) + head(b, ux, uy, s);
}

const FRONT = { ax: 1, ay: 0.42, by: -0.26, bz: -1 };
const TOP = { ax: 1, ay: 0.22, by: -0.72, bz: -0.48 };
const proj = (m, X0, Y0, k) => (x, y, z) => [X0 + k * (m.ax * x + m.ay * y), Y0 + k * (m.by * y + m.bz * z)];
const fFront = (P, x, z, w, h, y) => [P(x, y, z), P(x + w, y, z), P(x + w, y, z + h), P(x, y, z + h)];
const fTop = (P, x, y, w, d, z) => [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)];
const fSide = (P, y, z, d, h, x) => [P(x, y, z), P(x, y + d, z), P(x, y + d, z + h), P(x, y, z + h)];
const quadD = q => 'M' + q.map(p => R(p[0]) + ' ' + R(p[1])).join(' L') + ' Z';
const hole = (outer, inner, c = 'o p0') => `<path class="${c}" fill-rule="evenodd" d="${quadD(outer)} ${quadD(inner)}"/>`;
function box(P, x, y, z, w, d, h, cf = 'o p0', ct = 'o p1', cs = 'o p2') {
  return poly(fSide(P, y, z, d, h, x + w), cs) + poly(fTop(P, x, y, w, d, z + h), ct) + poly(fFront(P, x, z, w, h, y), cf);
}

export function torx(cx, cy, r = 8) {
  const p = [];
  for (let i = 0; i < 12; i++) { const a = Math.PI * i / 6 - Math.PI / 2, rr = i % 2 ? r * 0.3 : r * 0.58; p.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  return circ(cx, cy, r, 'o p0') + poly(p, 'ah');
}
const screw = (x, y, r = 2.4) => circ(x, y, r, 'o p2 thin');
export const badge = (x, y, L) => rect(x - 9, y - 9, 18, 18, 'o p0', 2) + txt(x, y + 4.6, L, 'tb');
const count = (x, y, s, a = 'start') => txt(x, y, s, 'tc', a);
export function ok(x, y, r = 12) {
  return circ(x, y, r, 'okc') + path(`M${R(x - r * 0.45)} ${R(y + 0.5)} l${R(r * 0.32)} ${R(r * 0.34)} l${R(r * 0.62)} ${R(-r * 0.66)}`, 'okm');
}
export function no(x, y, r = 12) {
  const a = r * 0.4;
  return circ(x, y, r, 'noc') + path(`M${R(x - a)} ${R(y - a)} L${R(x + a)} ${R(y + a)} M${R(x + a)} ${R(y - a)} L${R(x - a)} ${R(y + a)}`, 'nom');
}
function mag(cx, cy, r, target, inner) {
  const id = 'mg' + (++UID);
  const dx = target[0] - cx, dy = target[1] - cy, L = Math.hypot(dx, dy) || 1, e = [cx + dx / L * r, cy + dy / L * r];
  return ln(e, target, 'o thin') + circ(target[0], target[1], 3.2, 'ah')
    + `<clipPath id="${id}"><circle cx="${R(cx)}" cy="${R(cy)}" r="${R(r - 1)}"/></clipPath>`
    + circ(cx, cy, r, 'o p0') + `<g clip-path="url(#${id})">${inner}</g>` + circ(cx, cy, r, 'o nf magc');
}
const svg = (w, h, body, label) => `<svg class="ill" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">${body}</svg>`;

// ---- small reusable pictograms -------------------------------------------
function glue(x, y) {
  return path(`M${x - 9} ${y + 26} L${x - 9} ${y + 2} Q${x - 9} ${y - 4} ${x - 3} ${y - 4} L${x + 3} ${y - 4} Q${x + 9} ${y - 4} ${x + 9} ${y + 2} L${x + 9} ${y + 26} Z`, 'o p0')
    + path(`M${x - 3} ${y - 4} L${x - 1.5} ${y - 14} L${x + 1.5} ${y - 14} L${x + 3} ${y - 4}`, 'o p2') + rect(x - 6, y + 6, 12, 12, 'o p1 thin') + txt(x, y + 15, 'W', 'tt');
}
function clock(x, y, label) {
  return circ(x, y, 14, 'o p0') + ln([x, y], [x, y - 9]) + ln([x, y], [x + 7, y + 3]) + txt(x + 22, y + 5, label, 'tc', 'start');
}
function charger(x, y, wlabel) {
  return rect(x, y, 46, 40, 'o p0', 6) + ln([x + 14, y], [x + 14, y - 10], 'o thick') + ln([x + 32, y], [x + 32, y - 10], 'o thick')
    + rect(x + 17, y + 40, 12, 7, 'o p2', 1) + txt(x + 23, y + 25, wlabel, 'ts');
}
function usbMeter(x, y, l1, l2) {
  return rect(x, y, 62, 38, 'o p0', 4) + rect(x + 6, y + 6, 50, 26, 'o dark', 2)
    + txt(x + 31, y + 18, l1, 'tled') + txt(x + 31, y + 29, l2, 'tled2');
}
function multimeter(x, y, val) {
  return rect(x, y, 54, 84, 'o p0', 6) + rect(x + 7, y + 8, 40, 20, 'o dark', 2) + txt(x + 27, y + 23, val, 'tled')
    + circ(x + 27, y + 50, 13, 'o p1') + ln([x + 27, y + 50], [x + 34, y + 42]) + circ(x + 15, y + 74, 3.5, 'o p2') + circ(x + 39, y + 74, 3.5, 'o p2');
}
function piBoard(x, y, w = 70, h = 46) {
  let b = rect(x, y, w, h, 'o p1', 3);
  for (let i = 0; i < 13; i++) b += circ(x + 8 + i * 4.3, y + 5, 1.1, 'ah');
  b += rect(x + w - 2, y + 10, 10, 11, 'o p0') + rect(x + w - 2, y + 25, 10, 11, 'o p0') + rect(x + 6, y + h - 2, 8, 5, 'o p0');
  return b;
}
function fuseBox(x, y, n = 10, w = 150) {
  let b = rect(x, y, w, 58, 'o p0', 3) + rect(x + 6, y + 6, w - 12, 8, 'o p2 thin') + rect(x + 6, y + 44, w - 12, 8, 'o p1 thin');
  const gap = (w - 16) / n;
  for (let i = 0; i < n; i++) b += rect(x + 9 + i * gap, y + 18, gap - 5, 20, 'o fuse', 1.5);
  b += txt(x + w + 6, y + 13, '+', 'tc', 'start') + txt(x + w + 6, y + 52, '−', 'tc', 'start');
  return b;
}

// LED module back, drawn on top of a lying box (TOP projection). 320 x 160 x 14 mm.
function modBack(P, x, y, z, num, dir, cls = 'o p2m') {
  let b = box(P, x, y, z, 320, 160, 14, 'o p1', cls, 'o p2');
  const zt = z + 14;
  const inX = dir > 0 ? x + 22 : x + 258, outX = dir > 0 ? x + 258 : x + 22;
  b += poly(fTop(P, inX, y + 70, 40, 30, zt), 'o p0 thin') + poly(fTop(P, outX, y + 70, 40, 30, zt), 'o p0 thin');
  const ci = P(inX + 20, y + 118, zt), co = P(outX + 20, y + 118, zt);
  b += txt(ci[0], ci[1] + 3, 'IN', 'tt') + txt(co[0], co[1] + 3, 'OUT', 'tt');
  const a0 = P(x + (dir > 0 ? 112 : 208), y + 34, zt), a1 = P(x + (dir > 0 ? 208 : 112), y + 34, zt);
  b += arrow(a0, a1, 'ar', 8);
  const c = P(x + 160, y + 95, zt);
  b += circ(c[0], c[1], 8.5, 'o p0') + txt(c[0], c[1] + 4, num, 'tn');
  return b;
}
function ribbon(a, q, b2) {
  const d = `M${R(a[0])} ${R(a[1])} Q${R(q[0])} ${R(q[1])} ${R(b2[0])} ${R(b2[1])}`;
  return path(d, 'rib0') + path(d, 'rib1');
}

// Face-down box base (TOP projection): blanket, front frame on the floor, walls. Back open.
function lyingBox(P, nearCls = 'o p0', withPC = false) {
  let b = poly(fTop(P, -50, -45, 1080, 445, 0), 'o p1 thin');
  b += poly(fSide(P, 0, 0, 380, 6, 1020), 'o p2') + poly(fFront(P, 0, 0, 1020, 6, 0), 'o p0');
  b += hole(fTop(P, 0, 0, 1020, 380, 6), fTop(P, 30, 30, 960, 320, 6), 'o p0');
  if (withPC) b += poly(fTop(P, 15, 15, 990, 350, 9), 'o pc thin') + ln(P(200, 60, 9), P(320, 320, 9), 'glare') + ln(P(240, 60, 9), P(360, 320, 9), 'glare');
  b += box(P, 0, 374, 6, 1020, 6, 208);
  b += poly(fTop(P, 0, 6, 6, 368, 214), 'o p1') + hole(fSide(P, 6, 6, 368, 208, 6), fSide(P, 30, 30, 320, 160, 6), 'o p2') + poly(fFront(P, 0, 6, 6, 208, 6), 'o p0');
  return b;
}
function lyingRightEnd(P) {
  return poly(fTop(P, 1014, 6, 6, 368, 214), 'o p1') + hole(fSide(P, 6, 6, 368, 208, 1020), fSide(P, 30, 30, 320, 160, 1020), 'o p2') + poly(fFront(P, 1014, 6, 6, 208, 6), 'o p0');
}
const nearWall = (P, ghost) => ghost ? box(P, 0, 0, 6, 1020, 6, 208, 'o gh', 'o gh', 'o gh') : box(P, 0, 0, 6, 1020, 6, 208);

// ---------------------------------------------------------------------------
export function step1() {
  const s = 0.285, ox = 22, oy = 16;
  const M = (x, y) => [ox + x * s, oy + y * s];
  let b = rect(ox, oy, 1250 * s, 1250 * s, 'o hatchf');
  const parts = [['A', 10, 10, 1020, 380], ['B', 10, 394, 1020, 380], ['C', 10, 778, 1020, 208], ['C', 10, 990, 1020, 208],
    ['D', 1034, 10, 208, 368], ['D', 1034, 382, 208, 368], ['Y', 1034, 754, 208, 140]];
  for (const [L, x, y, w, h] of parts) {
    const [px, py] = M(x, y); b += rect(px, py, w * s, h * s, 'o p0');
    const [cx, cy] = M(x + w / 2, y + h / 2), big = h * s > 50;
    b += badge(cx, cy - (big ? 8 : 0), L);
    if (big) b += txt(cx, cy + 17, `${w} × ${h}`, 'tm');
  }
  const lx = ox + 1250 * s + 26;
  b += txt(lx, 36, '6 mm poplar plywood', 'tlb', 'start') + txt(lx, 54, 'one sheet 1250 × 1250 mm', 'tl', 'start');
  const rows = [['A', 'front', '1020 × 380'], ['B', 'back (screwed on)', '1020 × 380'], ['C', 'top + bottom ×2', '1020 × 208'],
    ['D', 'ends ×2', '208 × 368'], ['Y', 'backing plate', '208 × 140']];
  rows.forEach(([L, n, d], i) => { const y = 92 + i * 30; b += badge(lx + 9, y - 4, L) + txt(lx + 26, y, n, 'tl', 'start') + txt(lx + 26, y + 13, d + ' mm', 'tm', 'start'); });
  b += lines(lx, 262, ['Hand this list to the store saw', '(straight cuts only), or have the', 'whole sheet laser-cut, windows', 'included.'], 'tl');
  return svg(640, 384, b, 'Cut list: seven rectangles from one sheet of plywood');
}

export function step2() {
  const s = 0.29; let b = '';
  const ax = 20, ay = 26;
  b += rect(ax, ay, 1020 * s, 380 * s, 'o p0') + rect(ax + 30 * s, ay + 30 * s, 960 * s, 320 * s, 'o hatchf');
  b += txt(ax + 510 * s, ay + 190 * s + 4, '960 × 320', 'tm halo') + badge(ax + 2, ay - 4, 'A');
  b += txt(ax + 510 * s, ay + 380 * s + 16, '30 mm border all round', 'ts');
  for (const [i, dx] of [[0, 356], [1, 430]]) {
    const x = dx, y = ay;
    b += rect(x, y, 208 * s, 368 * s, 'o p0') + rect(x + 24 * s, y + 24 * s, 160 * s, 320 * s, 'o hatchf');
    if (!i) b += badge(x + 2, y - 4, 'D');
  }
  b += count(520, 70, '×2') + lines(516, 92, ['window', '160 × 320', '24 mm border'], 'ts', 'start', 12);
  // B seen from outside (screwed on, the way in): ports bottom-left, horn hole, vents, 6 screw holes
  const bx = 20, by = 182, Bz = (z) => by + (380 - z) * s, Bx = x => bx + x * s;
  b += rect(bx, by, 1020 * s, 380 * s, 'o p0') + badge(bx + 2, by - 4, 'B');
  for (let i = 0; i < 8; i++) b += rect(Bx(300 + i * 55), Bz(349), 40 * s, 8 * s, 'o hatchf thin');
  for (const [x, z] of [[14, 14], [510, 14], [1006, 14], [14, 366], [510, 366], [1006, 366]]) b += circ(Bx(x), Bz(z), 2.5, 'o hatchf');
  b += circ(Bx(890), Bz(310), 15 * s, 'o hatchf') + txt(Bx(890), Bz(310) - 9, 'Ø30', 'tt');
  for (const [x, cls, l, a, dx] of [[60, 'ringb', 'DATA', 'end', -4], [120, 'ringg', 'POWER', 'start', 4]]) {
    b += circ(Bx(x), Bz(40), 6, cls) + rect(Bx(x) - 2.4, Bz(40) - 1.3, 4.8, 2.6, 'o dark thin', 1) + txt(Bx(x) + dx, Bz(40) - 10, l, 'tt', a);
  }
  b += txt(bx + 510 * s, by + 380 * s + 16, 'seen from outside', 'ts');
  // C bottom + C top
  const cx = 20, cy = 330, Cx = x => cx + x * s, Cy = y => cy + y * s;
  b += rect(cx, cy, 1020 * s, 208 * s, 'o p0') + badge(cx + 2, cy - 4, 'C') + txt(cx + 26, cy - 1, 'bottom', 'ts', 'start');
  b += circ(Cx(510), Cy(104), 22.5 * s, 'o hatchf') + circ(Cx(410), Cy(104), 3, 'o hatchf') + circ(Cx(610), Cy(104), 3.6, 'o hatchf');
  b += txt(Cx(510), Cy(104) + 20, 'Ø45', 'tt') + txt(Cx(410), Cy(104) + 15, 'Ø8', 'tt') + txt(Cx(610), Cy(104) + 15, 'Ø12', 'tt');
  const tx = 334, ty = 330, Tx = x => tx + x * s, Ty = y => ty + y * s;
  b += rect(tx, ty, 1020 * s, 208 * s, 'o p0') + badge(tx + 2, ty - 4, 'C') + txt(tx + 26, ty - 1, 'top', 'ts', 'start');
  for (const x of [240, 360, 660, 780]) b += circ(Tx(x), Ty(104), 2.2, 'o hatchf');
  b += txt(Tx(510), Ty(104) + 18, '4 × Ø4.5 for the handles', 'tt');
  // legend
  b += lines(356, 196, ['Cut-outs', 'Ø45  stand cup', 'Ø8  ¼″ camera insert', 'Ø12  ⅜″ stand insert', 'Ø30  horn hole, plug it', 'Ø4  back screws ×6 (B)', 'USB-C  13 × 7 + 2 × Ø3', 'vents  8 × 40 × 8'], 'tl', 'start', 16);
  return svg(640, 410, b, 'Windows and holes: front window, two end windows, back panel with the ports, horn hole, vents and six screw holes, bottom and top holes');
}

export function step3() {
  const P = proj(FRONT, 150, 316, 0.4); let b = '';
  b += poly(fFront(P, 0, 0, 1020, 380, 220), 'o nf dash');
  const bl = P(1040, 220, 380); b += badge(bl[0] + 6, bl[1], 'B') + txt(bl[0] + 6, bl[1] + 20, 'later', 'tt');
  b += box(P, 0, 6, 0, 1020, 208, 6);
  b += box(P, 6, 9, 6, 1008, 15, 15, 'o p1', 'o p1', 'o p2');
  b += poly(fTop(P, 0, 6, 6, 208, 374), 'o p1') + hole(fSide(P, 6, 6, 208, 368, 6), fSide(P, 30, 30, 160, 320, 6), 'o p2') + poly(fFront(P, 0, 6, 6, 368, 6), 'o p0');
  b += poly(fTop(P, 1014, 6, 6, 208, 374), 'o p1') + hole(fSide(P, 6, 6, 208, 368, 1020), fSide(P, 30, 30, 160, 320, 1020), 'o p2') + poly(fFront(P, 1014, 6, 6, 368, 6), 'o p0');
  b += box(P, 6, 9, 359, 1008, 15, 15, 'o p1', 'o p1', 'o p2');
  b += box(P, 0, 6, 534, 1020, 208, 6);
  b += arrow(P(170, 110, 520), P(170, 110, 392)) + arrow(P(850, 110, 520), P(850, 110, 392));
  b += poly(fSide(P, -620, 0, 6, 380, 1020), 'o p2') + poly(fTop(P, 0, -620, 1020, 6, 380), 'o p1') + hole(fFront(P, 0, 0, 1020, 380, -620), fFront(P, 30, 30, 960, 320, -620), 'o p0');
  b += arrow(P(990, -560, 190), P(990, -90, 190)) + arrow(P(510, -560, 395), P(510, -90, 395));
  const la = P(-60, -620, 340); b += badge(la[0], la[1], 'A');
  const lc = P(-50, 110, 540); b += badge(lc[0], lc[1], 'C');
  const lc2 = P(820, 214, -24); b += badge(lc2[0], lc2[1], 'C');
  const ld = P(1080, 110, 300); b += badge(ld[0], ld[1], 'D');
  const le = P(1060, 16, 12); b += badge(le[0] + 6, le[1] + 10, 'E');
  b += glue(476, 340) + txt(504, 348, '+', 'tc') + torx(528, 342, 10) + count(544, 349, '×32') + txt(544, 366, '3.5 × 16 T20', 'tm', 'start');
  return svg(640, 396, b, 'Glue and screw bottom, ends, top and front together; the back stays loose');
}

export function step4() {
  const s = 0.54, ox = 46, oy = 168; let b = '';
  const M = (x, y) => [ox + x * s, oy + y * s];
  // turn-over pictogram
  b += rect(28, 40, 70, 26, 'o p1') + rect(28, 66, 70, 5, 'o p2') + carrow([40, 34], [63, 6], [88, 34]);
  b += rect(ox, oy, 1020 * s, 220 * s, 'o p0');
  b += txt(ox + 510 * s, oy - 6, 'front edge', 'ts');
  const yp = M(406, 40); b += rect(yp[0], yp[1], 208 * s, 140 * s, 'o nf dash');
  for (const [x, y] of [[60, 40], [960, 40], [60, 180], [960, 180]]) { const p = M(x, y); b += circ(p[0], p[1], 7, 'o p2'); }
  const c = M(510, 110); b += rect(c[0] - 22, c[1] - 22, 44, 44, 'o p1', 5) + circ(c[0], c[1], 12, 'o p2');
  for (const [dx, dy] of [[-15, -15], [15, -15], [15, 15], [-15, 15]]) b += screw(c[0] + dx, c[1] + dy, 2.2);
  const i1 = M(410, 110), i2 = M(610, 110); b += circ(i1[0], i1[1], 4, 'o p2') + circ(i2[0], i2[1], 5.5, 'o p2');
  b += mag(268, 84, 60, [i1[0], i1[1] - 4], (() => {
    let g = rect(238, 70, 60, 46, 'o p1') + rect(252, 52, 32, 30, 'o p0');
    for (let k = 0; k < 5; k++) g += ln([252, 58 + k * 5], [284, 61 + k * 5], 'o thin');
    g += path('M268 50 L268 18 L300 18', 'o thick nf') + txt(305, 20, 'hex', 'tt', 'start');
    return g + txt(268, 132, '¼″ + ⅜″', 'ts');
  })());
  b += mag(470, 84, 60, [c[0], c[1] - 22], (() => {
    let g = rect(430, 54, 80, 80, 'o p1', 8) + circ(470, 94, 22, 'o p2');
    for (const [dx, dy] of [[-28, -28], [28, -28], [28, 28], [-28, 28]]) g += torx(470 + dx, 94 + dy, 6);
    return g;
  })());
  b += badge(540, 160, 'S') + txt(554, 164, 'M4 × 16 T20 ×4', 'tm', 'start');
  b += badge(126, 32, 'T') + txt(140, 36, '×2', 'tc', 'start');
  const f = M(960, 180); b += badge(f[0] + 20, f[1] + 10, 'U') + count(f[0] + 34, f[1] + 16, '×4');
  b += badge(yp[0] - 14, yp[1] + 8, 'Y') + txt(ox, oy + 220 * s + 18, 'Y: glue the backing plate inside, under the cup and inserts', 'ts', 'start');
  return svg(640, 310, b, 'Turn the box over; fit the stand cup, the two threaded inserts and four rubber feet');
}

export function step5() {
  const P = proj(FRONT, 60, 286, 0.42); let b = '';
  b += box(P, 0, 6, 374, 1020, 208, 6);
  b += poly(fSide(P, 6, 6, 208, 368, 1020), 'o p2') + poly(fSide(P, 30, 30, 160, 320, 1020), 'o dark') + poly(fTop(P, 1014, 6, 6, 208, 374), 'o p1');
  b += poly(fSide(P, 0, 0, 6, 380, 1020), 'o p2') + poly(fTop(P, 0, 0, 1020, 6, 380), 'o p1') + poly(fFront(P, 0, 0, 1020, 380, 0), 'o p0') + poly(fFront(P, 30, 30, 960, 320, 0), 'o dark');
  // spray can
  const x = 560, y = 120;
  b += rect(x, y, 38, 86, 'o p0', 7) + rect(x + 4, y - 14, 30, 16, 'o p1', 4) + rect(x + 12, y - 22, 12, 9, 'o p2', 2) + rect(x + 8, y + 26, 22, 34, 'o dark', 2);
  for (let i = 0; i < 16; i++) { const a = (i * 47) % 70 - 35, r = 14 + (i * 13) % 40; b += circ(x - 6 - r * Math.cos(a * Math.PI / 180), y - 18 + r * Math.sin(a * Math.PI / 180) * 0.6, 1.4, 'ah'); }
  b += count(608, 160, '×2') + clock(556, 252, '24 h');
  return svg(640, 300, b, 'Paint the box matte black inside and out, two coats, let it dry');
}

export function step6() {
  const P = proj(TOP, 80, 336, 0.5); let b = lyingBox(P);
  b += lyingRightEnd(P) + nearWall(P, false);
  b += box(P, 15, 15, 330, 990, 350, 3, 'o pc', 'o pc', 'o pc') + ln(P(250, 40, 333), P(390, 330, 333), 'glare') + ln(P(300, 40, 333), P(440, 330, 333), 'glare');
  b += arrow(P(320, 190, 318), P(320, 190, 40)) + arrow(P(700, 190, 318), P(700, 190, 40));
  const g = P(1010, 340, 340); b += badge(g[0] + 14, g[1] - 6, 'G');
  // peel the film pictogram
  b += path('M30 34 L92 34 L92 62 L78 76 L30 76 Z', 'o pc') + path('M92 62 Q78 58 78 76', 'o p0') + txt(61, 94, 'peel inner film', 'ts');
  b += lines(470, 34, ['Box face-down on a blanket.', 'Same for both end windows', '(2 small sheets G).'], 'tl', 'start', 15);
  return svg(640, 364, b, 'Lay the box face-down and drop the polycarbonate sheet into the front frame');
}

export function step7() {
  const P = proj(TOP, 80, 336, 0.5); let b = lyingBox(P, 'o p0', true);
  // far row (bottom row of the board): 4,5,6 data runs right to left
  b += modBack(P, 30, 190, 9, 4, 1) + modBack(P, 350, 190, 9, 5, 1);
  // near row (top row): 1,2,3 left to right
  b += modBack(P, 30, 30, 9, 1, 1) + modBack(P, 350, 30, 9, 2, 1) + modBack(P, 670, 30, 9, 3, 1);
  const z = 23;
  b += ribbon(P(308, 85, z), P(350, 85, z + 60), P(392, 85, z)) + ribbon(P(628, 85, z), P(670, 85, z + 60), P(712, 85, z));
  b += ribbon(P(308, 245, z), P(350, 245, z + 60), P(392, 245, z));
  b += lyingRightEnd(P) + nearWall(P, true);
  // module 6 coming in
  b += modBack(P, 670, 190, 150, 6, 1) + arrow(P(830, 270, 140), P(830, 270, 34));
  const n = P(-64, 110, 9), f = P(-64, 270, 9);
  b += txt(n[0] - 4, n[1] + 4, 'top row →', 'ts', 'end') + txt(f[0] - 4, f[1] + 4, 'bottom row →', 'ts', 'end');
  b += badge(560, 36, 'H') + count(574, 43, '×6');
  return svg(640, 364, b, 'Place six LED modules, all arrows pointing the same way; connect the short ribbons 1 to 3 and 4 to 6');
}

export function step8() {
  const P = proj(TOP, 80, 336, 0.5); let b = lyingBox(P, 'o p0', true);
  b += modBack(P, 30, 190, 9, 4, 1) + modBack(P, 350, 190, 9, 5, 1) + modBack(P, 670, 190, 9, 6, 1);
  b += modBack(P, 30, 30, 9, 1, 1) + modBack(P, 350, 30, 9, 2, 1) + modBack(P, 670, 30, 9, 3, 1);
  b += box(P, 6, 359, 9, 1008, 15, 15, 'o p1', 'o p1', 'o p2') + box(P, 6, 6, 9, 1008, 15, 15, 'o p1', 'o p1', 'o p2');
  for (const xc of [510, 830]) {
    b += box(P, xc - 10, 6, 24, 20, 368, 3, 'o p0', 'o al', 'o p2');
    for (const y of [13, 75, 145, 235, 305, 367]) { const p = P(xc, y, 27); b += screw(p[0], p[1], 2.3); }
  }
  b += lyingRightEnd(P) + nearWall(P, true);
  b += box(P, 180, 6, 160, 20, 368, 3, 'o p0', 'o al', 'o p2') + arrow(P(190, 190, 150), P(190, 190, 34));
  const tgt = P(510, 75, 27);
  b += mag(560, 70, 56, tgt, (() => {
    let g = rect(504, 86, 112, 22, 'o p2m') + rect(504, 72, 112, 14, 'o al');
    g += rect(546, 76, 28, 10, 'o p2', 2) + rect(546, 86, 28, 6, 'o dark');
    return g;
  })()) + txt(560, 142, 'magnets snap on', 'tm');
  b += badge(24, 40, 'F') + count(38, 47, '×3');
  b += txt(24, 72, 'Steel bars: the modules’', 'ts', 'start') + txt(24, 84, 'own magnets hold them', 'ts', 'start');
  return svg(640, 364, b, 'Screw two battens along the long walls, then three steel bars across the modules');
}

export function step9() {
  const s = 0.56; let b = '';
  function end(x0, y0, label, flip) {
    let g = rect(x0, y0, 208 * s, 368 * s, 'o p0') + rect(x0 + 24 * s - 4, y0 + 24 * s - 4, 160 * s + 8, 320 * s + 8, 'o pc dash thin');
    g += rect(x0 + 24 * s, y0 + 24 * s, 160 * s, 320 * s, 'o p2m');
    const cx = x0 + 104 * s;
    g += rect(cx - 12, y0 + 24 * s + 12, 24, 14, 'o p0 thin') + txt(cx, y0 + 24 * s + 36, 'OUT', 'tt');
    g += rect(cx - 12, y0 + 344 * s - 26, 24, 14, 'o p0 thin') + txt(cx, y0 + 344 * s - 32, 'IN', 'tt');
    g += arrow([cx, y0 + 160], [cx, y0 + 84], 'ar', 9);
    for (const [bx, by, r] of [[40, 12, 1], [168, 12, 1], [40, 356, 0], [168, 356, 0]]) {
      const px = x0 + bx * s, py = y0 + by * s;
      g += `<g transform="rotate(${r ? 0 : 0} ${R(px)} ${R(py)})">${rect(px - 12, py - 4.5, 24, 9, 'o p1', 4.5)}</g>` + screw(px, py, 1.8);
    }
    g += txt(x0 + 104 * s, y0 + 368 * s + 18, label, 'ts');
    return g;
  }
  b += end(70, 30, 'left end, seen from inside') + end(250, 30, 'right end, seen from inside');
  b += mag(520, 128, 82, [250 + 168 * s, 30 + 12 * s], (() => {
    let g = rect(438, 40, 170, 50, 'o p0') + rect(438, 90, 170, 130, 'o p2m');
    g += `<g transform="rotate(-30 520 82)">${rect(470, 66, 100, 32, 'o p1', 16)}</g>` + torx(520, 82, 9);
    g += carrow([566, 50], [600, 70], [588, 108]);
    return g;
  })());
  b += badge(452, 236, 'H') + count(466, 243, '×2') + badge(510, 236, 'G') + count(524, 243, '×2');
  b += lines(452, 270, ['8 turn buttons, 4 per end:', 'twist them over the module edge.', 'Arrows point up on both ends.'], 'tl', 'start', 15);
  return svg(640, 330, b, 'Fit one module behind each end window, held by four turn buttons');
}

export function step10() {
  const s = 0.65, X = x => 18 + (x - 80) * s, Y = y => 46 + y * s; let b = '';
  b += rect(X(80), Y(0), 920 * s, 220 * s, 'o p0');
  b += rect(X(80), Y(6), 920 * s, 21 * s, 'o p2m') + txt(X(540), Y(20), 'LED modules + bars (front)', 'tt halo');
  b += rect(X(80), Y(214), 920 * s, 6 * s, 'o p2');
  b += txt(X(540), Y(220) + 30, 'back panel B (removed, seen from above)', 'ts');
  b += circ(X(130), Y(217), 5, 'o nf dash') + txt(X(130), Y(220) + 15, 'horn', 'tt');
  // components
  b += rect(X(505), Y(44), 330 * s, 146 * s, 'o al thin') + txt(X(670), Y(196), 'aluminium plate', 'tt halo');
  b += rect(X(230), Y(150), 40 * s, 26 * s, 'o p0') + txt(X(250), Y(146), 'RTC + temp', 'tt halo');
  b += rect(X(306), Y(134), 93 * s, 68 * s, 'o p0', 3) + rect(X(300), Y(140), 85 * s, 56 * s, 'o p1', 3);
  for (const x of [318, 343, 368]) b += rect(X(x), Y(134) - 4, 18 * s, 7, 'o dark thin');
  b += txt(X(352), Y(170), 'Pi + driver', 'tt halo') + badge(X(306) - 12, Y(134) - 14, 'I') + badge(X(306) + 10, Y(134) - 14, 'J');
  b += fuseBox(X(520), Y(54), 10, 170 * s) + badge(X(520) - 12, Y(54) + 6, 'Q');
  b += rect(X(720), Y(128), 100 * s, 52 * s, 'o p1', 2); for (let i = 0; i < 6; i++) b += circ(X(735 + i * 14), Y(150), 2, 'o p2 thin');
  b += rect(X(720), Y(128), 12 * s, 52 * s, 'o p2') + badge(X(820) + 12, Y(130), 'N');
  b += rect(X(880), Y(176), 36 * s, 30 * s, 'o p0') + rect(X(890), Y(204), 14 * s, 8, 'o dark thin') + badge(X(916) + 12, Y(180), 'O');
  b += rect(X(110), Y(168), 40 * s, 22 * s, 'o p1') + badge(X(110) - 12, Y(168), 'R');
  // ports + cables
  b += circ(X(900), Y(220), 7, 'ringg') + circ(X(960), Y(220), 7, 'ringb');
  b += txt(X(900), Y(220) + 17, 'POWER', 'tt') + txt(X(960), Y(220) + 17, 'DATA', 'tt');
  b += path(`M${X(900)} ${Y(214)} L${X(900)} ${Y(206)}`, 'wg');
  b += rect(X(925), Y(190), 32 * s, 16 * s, 'o p1', 2) + txt(X(941), Y(186), 'USB-C hub', 'tt halo');
  b += rect(X(840), Y(188), 34 * s, 18 * s, 'o fuse', 2) + txt(X(857), Y(220) + 15, 'charge', 'tt') + path(`M${X(874)} ${Y(197)} L${X(925)} ${Y(197)}`, 'wg');
  b += path(`M${X(960)} ${Y(214)} L${X(960)} ${Y(206)} L${X(941)} ${Y(206)}`, 'wd');
  b += path(`M${X(925)} ${Y(200)} L${X(420)} ${Y(200)} L${X(420)} ${Y(165)} L${X(399)} ${Y(165)}`, 'wd');
  b += path(`M${X(897)} ${Y(176)} L${X(897)} ${Y(120)} L${X(352)} ${Y(120)} L${X(352)} ${Y(134)}`, 'wd dash thin');
  b += path(`M${X(270)} ${Y(160)} L${X(306)} ${Y(160)}`, 'wd dash thin');
  b += txt(X(640), Y(120) - 4, 'I²C (pins 27/28)', 'tt halo');
  b += lines(470, 220, ['Pi on 4 standoffs (M2.5).', 'Everything else: 3.5 × 16 T20.'], 'ts', 'start', 13);
  b += badge(24, 244, 'K') + txt(38, 248, 'tall stacking header between Pi and driver', 'ts', 'start');
  b += badge(24, 266, 'P') + count(38, 272, '×2') + txt(70, 270, 'USB-C extensions', 'ts', 'start');
  return svg(640, 282, b, 'Electronics on the bottom panel, seen from above: Pi with driver board, fuse box, converter, USB-C power board, horn switch');
}

export function step11() {
  let b = '';
  b += rect(14, 104, 22, 112, 'o p2') + circ(25, 160, 9, 'ringg') + rect(21, 157, 8, 6, 'o dark thin') + txt(25, 236, 'POWER', 'tt');
  b += path('M34 160 C60 160 70 160 96 160', 'wg thick2');
  b += rect(96, 134, 64, 52, 'o p0', 3) + rect(92, 154, 12, 12, 'o dark thin', 2) + txt(128, 128, 'O  USB-C board', 'ts');
  b += rect(146, 142, 10, 12, 'o p1 thin') + rect(146, 166, 10, 12, 'o p1 thin') + txt(166, 152, '+', 'tt') + txt(166, 176, '−', 'tt');
  b += path('M156 148 C190 148 200 128 236 128', 'wr') + path('M156 172 C190 172 200 192 236 192', 'wb');
  b += txt(176, 112, '1 mm²', 'tt') + rect(188, 133, 18, 9, 'o fuse', 1.5) + txt(214, 130, '5 A', 'tt', 'start');
  b += rect(236, 96, 128, 128, 'o p1', 2) + txt(300, 90, 'N  RSD-60G-5', 'ts');
  for (let i = 0; i < 5; i++) b += rect(250 + i * 22, 196, 14, 18, 'o p0 thin');
  b += txt(242, 132, '+Vin', 'tt', 'start') + txt(242, 186, '−Vin', 'tt', 'start') + txt(358, 132, '+V', 'tt', 'end') + txt(358, 186, '−V', 'tt', 'end');
  b += path('M364 128 C404 128 420 110 456 110', 'wr thick2') + path('M364 192 C404 192 420 148 456 148', 'wb thick2');
  b += txt(410, 100, '2.5 mm²', 'tt');
  b += fuseBox(456, 100, 10, 150) + txt(531, 94, 'Q  fuse box', 'ts');
  b += mag(560, 248, 44, [470, 110], rect(520, 236, 30, 22, 'o p1') + rect(550, 241, 30, 12, 'o p2') + path('M580 247 L620 247', 'wr thick2') + circ(535, 247, 5, 'o p0') + ln([531, 247], [539, 247]));
  b += no(60, 272, 13) + path('M86 262 L126 282 M86 282 L126 262', 'wr') + path('M86 282 L126 262', 'wb') + txt(138, 276, 'never swap + and −', 'tl', 'start');
  b += ok(60, 40, 13) + txt(84, 45, 'red = +, black = −, everywhere', 'tl', 'start');
  return svg(640, 300, b, 'Power wiring: USB-C power port to the USB-C board, to the converter, to the fuse box');
}

export function step12() {
  let b = '';
  b += charger(24, 112, '20 W') + path('M70 132 C96 132 100 140 124 140', 'o thick nf');
  b += usbMeter(124, 121, '9.00V', '0.05A') + path('M186 140 C206 140 210 140 228 140', 'o thick nf');
  b += rect(228, 92, 24, 96, 'o p2') + circ(240, 140, 8, 'ringg') + txt(240, 204, 'POWER', 'tt');
  b += rect(276, 112, 40, 56, 'o p1', 2) + txt(296, 182, 'N', 'tb');
  b += path('M252 140 L276 140', 'wg');
  b += fuseBox(340, 110, 10, 130) + path('M316 124 L340 120', 'wr') + path('M316 156 L340 158', 'wb');
  b += multimeter(520, 92, '5.08') + path('M534 176 C520 210 470 190 470 120', 'wr') + path('M560 176 C580 220 480 220 476 158', 'wb');
  b += piBoard(360, 220, 56, 36) + no(430, 240, 10) + rect(468, 222, 70, 34, 'o p2m') + no(546, 240, 10) + txt(452, 280, 'Pi and modules not connected yet', 'ts');
  b += ok(40, 34, 12) + txt(60, 39, '5.0–5.2 V → next step', 'tl', 'start');
  b += no(270, 34, 12) + txt(290, 39, '0 V or −5 V → unplug, check + / −', 'tl', 'start');
  return svg(640, 296, b, 'First power-up with a small charger: the USB meter shows 9 V, the multimeter shows about 5.1 V at the fuse box');
}

export function step13() {
  let b = '';
  b += fuseBox(24, 132, 10, 170);
  ['1', '2', '3', '4', '5', '6', 'L', 'R', 'Pi', '·'].forEach((l, i) => { b += txt(24 + 9 + i * 15.4 + 5, 200, l, 'tt'); });
  // front modules mini: OUT 1 top row, OUT 2 bottom row, OUT 3 benches
  const mx = 300, my = 40, mw = 70, mh = 34;
  const pos = [[0, 0, 1, 1], [1, 0, 2, 1], [2, 0, 3, 1], [0, 1, 4, 1], [1, 1, 5, 1], [2, 1, 6, 1]];
  for (const [c, r, n, d] of pos) {
    const x = mx + c * (mw + 4), y = my + r * (mh + 4);
    b += rect(x, y, mw, mh, 'o p2m') + circ(x + mw / 2, y + mh / 2, 8, 'o p0') + txt(x + mw / 2, y + mh / 2 + 4, n, 'tn');
    b += arrow([x + mw / 2 - d * 24, y + 8], [x + mw / 2 + d * 24, y + 8], 'ar', 6);
  }
  b += rect(252, 40, 22, 72, 'o p2m') + txt(263, 126, 'L', 'tb') + rect(534, 40, 22, 72, 'o p2m') + txt(545, 126, 'R', 'tb');
  // driver board with 3 outputs
  b += rect(300, 200, 120, 64, 'o p1', 3) + txt(360, 280, 'J  driver on Pi', 'ts');
  for (const [i, l] of [[0, '1'], [1, '2'], [2, '3']]) b += rect(312 + i * 34, 194, 26, 12, 'o dark thin') + txt(325 + i * 34, 190, l, 'tt');
  b += ribbon([325, 194], [296, 120], [304, 64]) + ribbon([359, 194], [340, 150], [338, 110]);
  b += ribbon([393, 194], [262, 190], [263, 104]) + ribbon([263, 40], [400, 6], [545, 40]);
  b += txt(440, 142, 'OUT 1 → module 1', 'tt', 'start') + txt(440, 154, 'OUT 2 → module 4', 'tt', 'start') + txt(440, 166, 'OUT 3 → L → R', 'tt', 'start');
  // power fan-out (two drawn, rest the same)
  b += path('M41 132 C60 70 200 60 300 50', 'wr thin2') + path('M152 132 C170 110 220 90 252 80', 'wr thin2');
  b += txt(120, 70, 'each fuse → its panel (red + black)', 'tt halo');
  // I2C + data
  b += rect(470, 220, 40, 30, 'o p0') + txt(490, 266, 'O', 'tb') + path('M470 236 L420 236', 'wd dash');
  b += circ(600, 236, 8, 'ringb') + txt(600, 262, 'DATA', 'tt') + path('M592 236 C580 280 560 284 548 284', 'wd') + rect(520, 276, 28, 16, 'o p1', 2) + path('M520 284 C470 286 430 280 420 256', 'wd') + txt(534, 304, 'hub → Pi network port · tablet charges', 'tt');
  b += badge(24, 260, 'Q') + txt(40, 264, '5 A fuses ×10', 'ts', 'start');
  return svg(640, 300, b, 'Connect panel power through the fuses, ribbon OUT 1 to the top row, OUT 2 to the bottom row and OUT 3 to the bench panels, then the I2C and data cables');
}

export function step14() {
  let b = '';
  // back panel off + SD
  b += rect(24, 70, 150, 150, 'o p0') + rect(54, 150, 60, 50, 'o dark');
  b += `<g transform="rotate(-24 54 150)">${rect(54, 100, 60, 50, 'o p1')}</g>`;
  b += path('M88 104 l10 0 l6 6 l0 16 l-16 0 Z', 'o p0') + arrow([96, 132], [96, 170], 'ar', 8) + badge(130, 116, 'M');
  b += txt(99, 240, 'SD card from us', 'ts');
  // charger
  b += charger(208, 120, '65 W') + path('M231 167 C231 200 260 200 280 196', 'o thick nf');
  // front view with test pattern
  const P = proj(FRONT, 286, 236, 0.3);
  b += box(P, 0, 0, 0, 1020, 220, 380);
  const cols = ['#ffffff', '#ffd400', '#00e5ff', '#00e050', '#ff3df0', '#ff2a2a', '#2a5bff'];
  cols.forEach((c, i) => { b += `<polygon points="${P2(fFront(P, 30 + i * 960 / 7, 120, 960 / 7, 230, 0))}" fill="${c}" stroke="none"/>`; });
  b += poly(fFront(P, 30, 30, 960, 90, 0), 'o grad');
  b += poly(fSide(P, 30, 30, 160, 320, 1020), 'o lit');
  b += clock(330, 40, '30 min') + ok(470, 40, 12) + txt(490, 45, 'warm is fine', 'tl', 'start');
  b += no(470, 270, 12) + txt(490, 275, 'hot or smelly → unplug', 'tl', 'start');
  return svg(640, 296, b, 'With the back panel off, put in the prepared SD card, power up with a laptop charger, run the test pattern for 30 minutes');
}

export function step15() {
  // seen from behind: x' = 1020 - X, y' = 220 - Y
  const P = proj(FRONT, 64, 318, 0.42); let b = '';
  b += poly(fSide(P, 6, 0, 214, 380, 1020), 'o p2') + poly(fTop(P, 0, 6, 1020, 214, 380), 'o p1');
  b += poly(fSide(P, 30, 30, 160, 320, 1020), 'o lit');
  b += poly(fFront(P, 6, 6, 1008, 368, 40), 'o p2m');
  b += hole(fFront(P, 0, 0, 1020, 380, 6), fFront(P, 6, 6, 1008, 368, 6), 'o p1');
  for (const [x, z] of [[6, 6], [502, 6], [999, 6], [6, 359], [502, 359], [999, 359]]) b += poly(fFront(P, x, z, 15, 15, 6), 'o p1');
  for (const [x, z] of [[0, 350], [990, 350], [0, 0], [990, 0]]) b += poly(fTop(P, x, 6, 30, 30, z ? 380 : 0), 'o dark');
  b += poly(fSide(P, 6, 0, 30, 30, 1020), 'o dark') + poly(fSide(P, 6, 350, 30, 30, 1020), 'o dark');
  const by = -230;
  b += poly(fSide(P, by, 0, 6, 380, 1020), 'o p2') + poly(fTop(P, 0, by, 1020, 6, 380), 'o p1') + poly(fFront(P, 0, 0, 1020, 380, by), 'o p0');
  const F = (x, z) => P(x, by, z);
  for (let i = 0; i < 8; i++) b += poly(fFront(P, 300 + i * 55, 341, 40, 8, by), 'o dark thin');
  const hp = F(890, 310); b += circ(hp[0], hp[1], 6, 'o p2');
  for (const [x, cls, l, a, dx] of [[60, 'ringb', 'DATA', 'end', -3], [120, 'ringg', 'POWER', 'start', 3]]) { const p = F(x, 40); b += circ(p[0], p[1], 6, cls) + txt(p[0] + dx, p[1] - 9, l, 'tt', a); }
  for (const [x, z] of [[14, 14], [510, 14], [1006, 14], [14, 366], [510, 366], [1006, 366]]) { const k = F(x, z); b += torx(k[0], k[1], 5.5); }
  b += arrow(P(220, by + 10, -10), P(220, -10, -10)) + arrow(P(840, by + 10, -10), P(840, -10, -10));
  for (const hx of [210, 690]) {
    const a = P(hx, 110, 470), c = P(hx + 120, 110, 470);
    b += path(`M${R(a[0])} ${R(a[1])} Q${R((a[0] + c[0]) / 2)} ${R(a[1] - 34)} ${R(c[0])} ${R(c[1])}`, 'o handle');
    b += arrow(P(hx + 60, 110, 455), P(hx + 60, 110, 392), 'ar', 8);
  }
  b += badge(22, 160, 'B');
  b += mag(560, 150, 48, F(1006, 366), (() => {
    let g = rect(512, 150, 96, 12, 'o p0') + rect(540, 162, 40, 30, 'o p1') + rect(552, 120, 16, 30, 'o p2');
    for (let i = 0; i < 6; i++) g += ln([552, 124 + i * 4.5], [568, 126 + i * 4.5], 'o thin');
    // button head with a T20 recess
    g += path('M536 121 Q536 101 560 101 Q584 101 584 121 Z', 'o p1') + torx(560, 112, 7);
    return g + carrow([594, 104], [606, 116], [596, 128], 'ar', 6);
  })());
  b += badge(536, 40, 'V') + count(550, 47, '×2') + txt(536, 66, 'M4 × 16 T20 ×8', 'tm', 'start');
  b += count(330, 300, '×6') + txt(358, 299, 'T20 3.5 × 16', 'ts', 'start');
  b += txt(64, 362, 'blocks: 4 corners + 2 mid', 'ts', 'start') + txt(300, 362, 'rubber guards on the back corners', 'ts', 'start');
  return svg(640, 372, b, 'Put the back panel on and drive in six T20 screws; fit handles, corners and rubber guards');
}

export function step17() {
  const P = proj(FRONT, 70, 330, 0.4); let b = '';
  b += poly(fSide(P, 6, 0, 214, 380, 1020), 'o p2') + poly(fTop(P, 0, 6, 1020, 214, 380), 'o p1');
  b += poly(fFront(P, 6, 6, 1008, 368, 200), 'o p2m');
  b += poly(fTop(P, 6, 6, 1008, 194, 6), 'o p1');
  b += box(P, 330, 115, 6, 170, 50, 22, 'o p0', 'o p0', 'o p2');
  for (let i = 0; i < 10; i++) b += poly(fTop(P, 340 + i * 15.5, 122, 9, 36, 28), 'o fuse thin');
  b += box(P, 200, 40, 6, 100, 52, 40, 'o p1', 'o p1', 'o p2');
  b += box(P, 635, 24, 6, 93, 66, 34, 'o p1', 'o p0', 'o p2');
  for (const x of [650, 680, 710]) b += poly(fTop(P, x, 70, 16, 14, 40), 'o dark thin');
  b += box(P, 105, 14, 6, 36, 30, 12, 'o p0', 'o p0', 'o p2');
  b += hole(fFront(P, 0, 0, 1020, 380, 6), fFront(P, 6, 6, 1008, 368, 6), 'o p1');
  for (const [x, z] of [[6, 6], [502, 6], [999, 6], [6, 359], [502, 359], [999, 359]]) b += poly(fFront(P, x, z, 15, 15, 6), 'o p1');
  const lf = P(415, 140, 40), lp = P(680, 40, 50), lc = P(250, 60, 60), lo = P(123, 20, 30);
  b += txt(lf[0], lf[1] - 10, 'fuses', 'tt halo') + txt(lp[0], lp[1] - 12, 'Pi + SD', 'tt halo') + txt(lc[0], lc[1] - 8, 'converter', 'tt halo') + txt(lo[0], lo[1] - 6, 'USB-C', 'tt halo');
  for (const [x, z] of [[14, 14], [510, 14], [1006, 14], [14, 366], [510, 366], [1006, 366]]) { const k = P(x, 6, z); b += torx(k[0], k[1], 4.5); }
  // the back panel, inside face, set aside
  const dx = 470, dy = 222;
  b += arrow([430, 196], [470, 226]);
  b += rect(dx, dy, 160, 64, 'o p0') + rect(dx + 8, dy + 8, 70, 30, 'o p1 thin');
  ['1', '2', '3', '4', '5', '6', 'L', 'R', 'Pi'].forEach((l, i) => { b += txt(dx + 13 + (i % 5) * 14, dy + 19 + Math.floor(i / 5) * 13, l, 'tt'); });
  for (let i = 0; i < 4; i++) b += rect(dx + 90 + i * 9, dy + 10, 6, 14, 'o fuse thin', 1);
  b += path(`M${dx + 92} ${dy + 34} l14 0 l5 5 l0 18 l-19 0 Z`, 'o p0') + rect(dx + 88, dy + 31, 30, 6, 'o p1 thin', 1);
  b += txt(dx + 43, dy + 54, 'fuse map', 'tt') + txt(dx + 110, dy + 80, 'spare fuses + SD', 'tt') + txt(dx + 92, dy + 110, 'inside of the back panel', 'ts');
  b += ok(40, 34, 12) + txt(60, 39, 'T20 key: six screws, lift off', 'tl', 'start');
  return svg(640, 340, b, 'Open the box: undo six T20 screws and lift the back panel off; it carries a fuse map, spare fuses and a spare SD card');
}

function miniBoard(P) {
  let b = box(P, 0, 0, 0, 1020, 220, 380, 'o p0', 'o p1', 'o p2');
  b += poly(fFront(P, 30, 30, 960, 320, 0), 'o screen');
  b += poly(fSide(P, 30, 30, 160, 320, 1020), 'o screen');
  const l = P(250, 0, 110), r = P(770, 0, 110), s = P(510, 0, 160);
  b += txt(l[0], l[1], '18', 'led led-b') + txt(r[0], r[1], '16', 'led led-o') + txt(s[0], s[1], '2 : 1', 'leds');
  return b;
}
export function step16() {
  let b = '';
  const k = 0.17;
  // table
  let P = proj(FRONT, 30, 160, k);
  b += path('M10 166 L222 166 L236 150 L28 150 Z', 'o p1') + rect(10, 166, 212, 6, 'o p2');
  b += miniBoard(P) + txt(116, 196, 'on the table', 'tl');
  // speaker stand
  P = proj(FRONT, 236, 112, k);
  const c1 = P(510, 110, 0);
  b += rect(c1[0] - 3, c1[1], 6, 108, 'o p2') + rect(c1[0] - 4.5, c1[1] + 60, 9, 70, 'o p2');
  b += ln([c1[0], c1[1] + 112], [c1[0] - 48, c1[1] + 162], 'o thick') + ln([c1[0], c1[1] + 112], [c1[0] + 48, c1[1] + 162], 'o thick') + ln([c1[0], c1[1] + 112], [c1[0] + 10, c1[1] + 170], 'o thick');
  b += miniBoard(P) + txt(c1[0], 300, 'speaker stand · 35 mm', 'tl');
  // tripod / light stand
  P = proj(FRONT, 446, 112, k);
  const c2 = P(510, 110, 0);
  b += rect(c2[0] - 8, c2[1], 16, 7, 'o p2') + rect(c2[0] - 2.5, c2[1] + 7, 5, 40, 'o p2');
  b += ln([c2[0], c2[1] + 46], [c2[0] - 52, c2[1] + 166], 'o thick') + ln([c2[0], c2[1] + 46], [c2[0] + 52, c2[1] + 166], 'o thick') + ln([c2[0], c2[1] + 46], [c2[0] + 6, c2[1] + 172], 'o thick');
  b += miniBoard(P) + txt(c2[0], 300, 'tripod · ¼″ or ⅜″ · 12 kg+', 'tl');
  b += circ(36, 232, 8, 'ringg') + txt(52, 236, 'POWER ← any USB-C charger, 18–100 W', 'tl', 'start');
  b += circ(36, 258, 8, 'ringb') + txt(52, 262, 'DATA ← tablet: scores + charging, no PIN', 'tl', 'start');
  // strap inset: side view, box at the back edge of the table, screen facing the court
  b += ln([20, 322], [620, 322], 'o thin dash');
  b += rect(20, 384, 300, 8, 'o p1') + rect(44, 392, 8, 22, 'o p2') + txt(316, 378, 'court →', 'ts', 'end');
  b += rect(26, 300, 48, 84, 'o p0') + rect(70, 306, 4, 72, 'o dark');
  b += path('M38 300 Q50 280 62 300', 'o nf thick');
  const strapD = 'M50 291 C30 288 19 296 19 312 L19 398 Q19 402 24 402 L66 402';
  b += path(strapD, 'strap0') + path(strapD, 'strap1');
  b += rect(12, 340, 14, 10, 'o p0 thin', 2);
  b += lines(350, 344, ['Strap through each handle,', 'around the back edge of the table.', 'A hit from the court can’t push it off.'], 'tl', 'start', 16);
  return svg(640, 420, b, 'Three ways to set it up: on the table, on a speaker stand, on a tripod or light stand');
}

export function poster() {
  const P = proj(FRONT, 48, 340, 0.52); let b = '';
  b += poly(fSide(P, 0, 0, 220, 380, 1020), 'po-s') + poly(fTop(P, 0, 0, 1020, 220, 380), 'po-t') + poly(fFront(P, 0, 0, 1020, 380, 0), 'po-f');
  b += poly(fFront(P, 30, 30, 960, 320, 0), 'po-scr') + poly(fSide(P, 30, 30, 160, 320, 1020), 'po-scr');
  const l = P(200, 0, 90), r = P(820, 0, 90), s = P(510, 0, 250), n1 = P(40, 0, 300), n2 = P(980, 0, 300);
  b += txt(l[0], l[1], '18', 'pled pled-b') + txt(r[0], r[1], '16', 'pled pled-o') + txt(s[0], s[1], '2 · 1', 'pleds');
  b += txt(n1[0], n1[1], 'WIEDIKON', 'pledn pled-b', 'start') + txt(n2[0], n2[1], 'VOLZ', 'pledn pled-o', 'end');
  for (const hx of [210, 690]) { const a = P(hx, 110, 380), c = P(hx + 120, 110, 380); b += path(`M${R(a[0])} ${R(a[1])} Q${R((a[0] + c[0]) / 2)} ${R(a[1] - 30)} ${R(c[0])} ${R(c[1])}`, 'po-h'); }
  return svg(640, 372, b, 'Point Hub board, front view with a match score');
}

// ---- inventory icons (120 x 80) ------------------------------------------
const I = (b) => `<svg class="ico" viewBox="0 0 120 80" aria-hidden="true">${b}</svg>`;
export const icons = {
  A: I(hole([[10, 18], [110, 18], [110, 56], [10, 56]], [[13, 21], [107, 21], [107, 53], [13, 53]], 'o p0')),
  B: I(rect(10, 18, 100, 38, 'o p0') + rect(80, 44, 12, 9, 'o p1 thin') + circ(16, 51, 2.5, 'ringg') + circ(23, 51, 2.5, 'ringb') + rect(36, 21, 40, 3, 'o p2 thin')),
  C: I(rect(8, 26, 100, 20, 'o p0') + rect(14, 34, 100, 20, 'o p0')),
  D: I(hole([[46, 6], [74, 6], [74, 74], [46, 74]], [[50, 10], [70, 10], [70, 70], [50, 70]], 'o p0') + rect(80, 10, 0.1, 0.1, 'nf')),
  E: I(`<g transform="rotate(-12 60 40)">${rect(10, 26, 100, 7, 'o p1')}${rect(10, 40, 100, 7, 'o p1')}</g>`),
  F: I(rect(8, 22, 104, 7, 'o al') + rect(8, 36, 104, 7, 'o al') + rect(8, 50, 104, 7, 'o al')),
  G: I(rect(14, 16, 74, 44, 'o pc') + ln([30, 22], [44, 54], 'glare') + rect(94, 18, 14, 40, 'o pc')),
  H: I(rect(14, 20, 92, 46, 'o screen') + rect(16, 22, 88, 42, 'dotsf')),
  I: I(piBoard(20, 16, 72, 48)),
  J: I(rect(20, 22, 80, 40, 'o p0', 3) + rect(28, 28, 18, 9, 'o dark thin') + rect(51, 28, 18, 9, 'o dark thin') + rect(74, 28, 18, 9, 'o dark thin') + txt(60, 54, '1   2   3', 'tt')),
  K: I(rect(14, 34, 92, 10, 'o dark') + Array.from({ length: 20 }, (_, i) => ln([18 + i * 4.4, 30], [18 + i * 4.4, 48], 'o thin')).join('')),
  L: I(rect(20, 32, 60, 18, 'o p1', 5) + rect(80, 36, 12, 10, 'o p2') + ln([30, 32], [24, 10], 'o thick')),
  M: I(path('M46 20 L70 20 L76 26 L76 62 L46 62 Z', 'o p0') + rect(50, 24, 4, 8, 'o p2 thin') + rect(57, 24, 4, 8, 'o p2 thin')),
  N: I(rect(24, 18, 72, 46, 'o p1', 2) + rect(24, 18, 10, 46, 'o p2') + Array.from({ length: 4 }, (_, i) => circ(48 + i * 12, 40, 2, 'o p2 thin')).join('')),
  O: I(rect(40, 24, 40, 32, 'o p0', 2) + rect(35, 34, 12, 10, 'o dark thin', 2) + rect(72, 30, 6, 6, 'o p1 thin') + rect(72, 42, 6, 6, 'o p1 thin')),
  P: I(rect(12, 32, 16, 16, 'o p1', 2) + path('M28 40 C60 40 60 30 92 30', 'o thick nf') + rect(92, 26, 14, 8, 'o dark thin', 2)),
  Q: I(fuseBox(14, 14, 8, 84)),
  R: I(rect(30, 26, 50, 30, 'o p1', 2) + rect(76, 30, 10, 20, 'o p0 thin') + path('M86 40 C96 40 98 52 108 52', 'o nf')),
  S: I(rect(36, 16, 48, 48, 'o p1', 6) + circ(60, 40, 14, 'o p2') + torx(44, 24, 3) + torx(76, 24, 3) + torx(44, 56, 3) + torx(76, 56, 3)),
  T: I(rect(30, 22, 18, 34, 'o p2', 2) + rect(66, 18, 24, 40, 'o p2', 2) + Array.from({ length: 5 }, (_, i) => ln([30, 28 + i * 6], [48, 30 + i * 6], 'o thin') + ln([66, 25 + i * 7], [90, 27 + i * 7], 'o thin')).join('')),
  U: I(path('M22 50 Q34 30 46 50 Z', 'o p2') + path('M52 50 Q64 30 76 50 Z', 'o p2') + path('M82 50 Q94 30 106 50 Z', 'o p2')),
  V: I(path('M24 54 Q60 6 96 54', 'o handle') + rect(16, 52, 18, 6, 'o al') + rect(86, 52, 18, 6, 'o al')),
  W: I(path('M40 60 L40 28 L72 28', 'o p0') + path('M40 28 L52 16 L84 16 L72 28 Z', 'o p1') + path('M72 28 L84 16 L84 48 L72 60 Z', 'o p2') + rect(40, 28, 32, 32, 'o p0')),
  X: I(torx(42, 40, 16) + torx(84, 40, 12)),
  guard: I(path('M36 58 L36 26 L84 26', 'o nf') + path('M30 62 L30 20 L90 20 L90 30 L42 30 L42 62 Z', 'o dark')),
  Y: I(rect(28, 22, 64, 40, 'o p0')),
  Z: I(circ(60, 40, 16, 'o p2') + circ(60, 40, 10, 'o p1')),
  screw20: I(torx(26, 40, 12) + path('M38 34 L96 37 L104 40 L96 43 L38 46 Z', 'o p1') + Array.from({ length: 8 }, (_, i) => ln([44 + i * 6.5, 34], [48 + i * 6.5, 46], 'o thin')).join('')),
  screw10: I(torx(30, 40, 10) + rect(40, 35, 46, 10, 'o p1') + Array.from({ length: 7 }, (_, i) => ln([44 + i * 6, 35], [47 + i * 6, 45], 'o thin')).join('')),
  turn: I(rect(26, 32, 50, 16, 'o p1', 8) + screw(38, 40, 3) + carrow([78, 22], [100, 30], [92, 56], 'ar', 7)),
  standoff: I(Array.from({ length: 4 }, (_, i) => rect(18 + i * 24, 26, 10, 26, 'o al') + ln([23 + i * 24, 18], [23 + i * 24, 26], 'o thick')).join('')),
  strap: I(path('M14 52 C14 24 62 22 62 40 C62 58 106 58 106 28', 'strap0') + path('M14 52 C14 24 62 22 62 40 C62 58 106 58 106 28', 'strap1') + rect(98, 18, 16, 14, 'o p0', 2)),
  lan: I(rect(26, 28, 44, 24, 'o p1', 4) + rect(70, 34, 10, 12, 'o dark thin', 2) + path('M26 40 C14 40 14 60 30 62 L98 62', 'wd') + rect(96, 56, 14, 12, 'o p0 thin', 1)),
  sensor: I(rect(18, 26, 38, 30, 'o p1', 2) + circ(37, 41, 9, 'o p0') + rect(66, 30, 34, 22, 'o p1', 2) + rect(78, 36, 10, 10, 'o p0 thin')),
  plate: I(path('M14 52 L76 52 L104 30 L42 30 Z', 'o al') + path('M14 52 L14 56 L76 56 L104 34 L104 30 L76 52', 'o p2')),
  small: I(rect(14, 34, 22, 12, 'o fuse', 2) + ln([8, 40], [14, 40], 'o') + ln([36, 40], [42, 40], 'o') + rect(52, 36, 18, 8, 'o p1', 1) + ln([46, 40], [52, 40]) + ln([70, 40], [76, 40]) + rect(84, 34, 14, 12, 'o dark', 1) + ln([86, 46], [86, 54]) + ln([96, 46], [96, 54])),
  pdsrc: I(rect(26, 26, 50, 30, 'o fuse', 3) + rect(76, 34, 12, 12, 'o dark thin', 3) + path('M40 41 l8 -8 l0 6 l8 0 l-8 8 l0 -6 Z', 'ah')),
  legs: I(path('M30 20 L30 60 M30 20 L58 62', 'o thick nf') + path('M70 20 L70 60 M70 20 L98 62', 'o thick nf') + circ(30, 20, 3, 'o p2') + circ(70, 20, 3, 'o p2')),
  wire: I(path('M16 30 C40 10 70 50 104 26', 'wr') + path('M16 44 C40 24 70 64 104 40', 'wb') + rect(98, 22, 10, 8, 'o p0 thin') + rect(98, 36, 10, 8, 'o p0 thin')),
};

// ---- tools (96 x 64) -------------------------------------------------------
const TI = (b) => `<svg class="ico" viewBox="0 0 96 64" aria-hidden="true">${b}</svg>`;
export const tools = {
  torx: TI(rect(10, 26, 40, 12, 'o p1', 6) + rect(50, 29, 30, 6, 'o al') + txt(30, 54, 'T10 · T20', 'tt')),
  drill: TI(path('M14 18 L62 18 L62 34 L40 34 L36 56 L22 56 L26 34 L14 34 Z', 'o p1') + rect(62, 22, 10, 8, 'o p2') + ln([72, 26], [90, 26], 'o thick')),
  jigsaw: TI(path('M12 22 L70 22 Q80 22 80 32 L80 38 L12 38 Z', 'o p1') + rect(38, 38, 4, 18, 'o al') + rect(8, 38, 76, 4, 'o p2')),
  holesaw: TI(circ(40, 34, 18, 'o p1') + circ(40, 34, 8, 'o p0') + ln([58, 34], [86, 34], 'o thick') + txt(40, 62, 'Ø30 · Ø45', 'tt')),
  crimp: TI(path('M10 50 L40 30 L44 34 L16 56 Z', 'o p1') + path('M10 18 L40 30 L44 26 L16 10 Z', 'o p1') + rect(44, 24, 30, 16, 'o p2', 3)),
  meter: TI(rect(28, 6, 40, 54, 'o p0', 5) + rect(33, 11, 30, 14, 'o dark', 2) + circ(48, 40, 9, 'o p1')),
  usbm: TI(rect(18, 18, 60, 30, 'o p0', 4) + rect(23, 23, 50, 20, 'o dark', 2) + txt(48, 37, '9.00V', 'tled')),
  clamp: TI(path('M14 14 L60 14 L60 22 L22 22 L22 44 L60 44 L60 52 L14 52 Z', 'o p1') + rect(56, 20, 6, 26, 'o al') + rect(66, 30, 22, 6, 'o p2')),
  ruler: TI(`<g transform="rotate(-20 48 32)">${rect(8, 26, 80, 14, 'o p0')}${Array.from({ length: 9 }, (_, i) => ln([14 + i * 8.5, 26], [14 + i * 8.5, i % 2 ? 31 : 34], 'o thin')).join('')}</g>`),
};
