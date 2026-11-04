// IKEA-style line drawings for the Point Hub board guide (design D: tilting front, screen flap,
// pull-out foot). Everything is drawn to scale from the real dimensions (mm). World axes for the
// standing box: X left->right (0..1020), Y front->back (0..220), Z bottom->top (0..380).
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

// ---- design D geometry (mm) ------------------------------------------------
// Side sections look at the left end: y = 0 is the front face, z = 0 the underside of the bottom.
export const G = {
  W: 1020, H: 380, D: 220, t: 6,
  A: { w: 1004, h: 366, z0: 7, win: [960, 320] },         // front frame, 1 mm under it, 1 mm over it
  hinge: [0, 374],                                          // piano hinge axis: top front edge
  K: 140,                                                   // bottom cap, final depth from the 150 blank
  pivot: [16, 18],                                          // stay pivot on A at 0°: 10 mm behind A, 10 mm above its bottom
  pin: [60, 18],                                            // M6 pin through the end wall
  stay: { len: 200, lead: 12, hole: 9 },                    // 25 × 4 strip; pivot 12 mm from the front end; notches 9 mm up
  pocket: { w: 280, h: 205, cz: 190, depth: 25 },
  handle: { x: [230, 790], y: 160, rim: [155, 83.3], cut: [129, 52], holes: [141, 62] },
  foot: { w: 600, d: 150, in: 70, travel: 120, railX: [189, 811] },
};
const d2r = Math.PI / 180;
// rotate a side-section point about the hinge: the bottom of the front frame swings out (toward -y)
export function rotA([y, z], deg) {
  const a = deg * d2r, c = Math.cos(a), s = Math.sin(a), zr = z - G.hinge[1], yr = y - G.hinge[0];
  return [G.hinge[0] + yr * c + zr * s, G.hinge[1] - yr * s + zr * c];
}
// The real knuckle sits on the inside, between A and the batten: A's top front corner rises a little.
const KNUCKLE = [7, 373.5];
function rotK([y, z], deg) {
  const a = deg * d2r, c = Math.cos(a), s = Math.sin(a), yr = y - KNUCKLE[0], zr = z - KNUCKLE[1];
  return [KNUCKLE[0] + yr * c + zr * s, KNUCKLE[1] - yr * s + zr * c];
}
export const HINGE_RISE = rotK([0, 373], 20)[1] - 374;
export const TILTS = [0, 5, 10, 15, 20];
// Notch positions along the stay, measured from the pivot hole: distance pivot -> pin at each tilt.
export const NOTCH = TILTS.map(t => { const q = rotA(G.pivot, t); return Math.hypot(G.pin[0] - q[0], G.pin[1] - q[1]); });
// Where the bottom cap K ends up: hinged on A's bottom inside edge, back edge on the floor (z = 6) if it reaches.
export function capK(deg, L = G.K) {
  const P = rotA([G.t, G.A.z0], deg), dz = P[1] - G.t, reach = Math.sqrt(Math.max(0, L * L - dz * dz));
  const end = [P[0] + reach, G.t];
  return { P, end, short: end[0] < 0 ? -end[0] : 0 };
}
export const OUT20 = -rotA([0, G.A.z0], 20)[0];             // how far the bottom stands out at 20°
// The longest angle a cap of length L still reaches the floor with
export function capReach(L = G.K) { let a = 0; while (a < 30 && !capK(a + 0.25, L).short) a += 0.25; return a; }

const SV = (X0, Y0, s) => ([y, z]) => [X0 + y * s, Y0 - z * s];
const rp = (S, pts) => pts.map(S);
const wbadge = (x, y, L) => { const w = Math.max(18, 8 + L.length * 7); return rect(x - w / 2, y - 9, w, 18, 'o p0', 2) + txt(x, y + 4.6, L, 'tb'); };
function dimH(x0, x1, y, label, c = 'tm') {
  return ln([x0, y], [x1, y], 'o thin') + ln([x0, y - 4], [x0, y + 4], 'o thin') + ln([x1, y - 4], [x1, y + 4], 'o thin') + txt((x0 + x1) / 2, y - 4, label, c);
}
function dimV(x, y0, y1, label, c = 'tm') {
  return ln([x, y0], [x, y1], 'o thin') + ln([x - 4, y0], [x + 4, y0], 'o thin') + ln([x - 4, y1], [x + 4, y1], 'o thin') + txt(x + 6, (y0 + y1) / 2 + 3, label, c, 'start');
}
function tape(x, y, w = 14, h = 30, rot = 0) { return `<g transform="rotate(${rot} ${R(x)} ${R(y)})">${rect(x - w / 2, y - h / 2, w, h, 'o tape thin', 1)}</g>`; }
function roller(x, y) {
  return rect(x, y, 44, 18, 'o p2', 9) + path(`M${x + 44} ${y + 9} L${x + 54} ${y + 9} L${x + 54} ${y + 30} L${x + 30} ${y + 30} L${x + 30} ${y + 60}`, 'o thick nf') + rect(x + 25, y + 58, 10, 26, 'o p1', 3);
}
function brush(x, y) { return path(`M${x} ${y} L${x + 14} ${y} L${x + 12} ${y + 22} L${x + 2} ${y + 22} Z`, 'o p2') + rect(x + 1, y + 22, 12, 8, 'o al') + rect(x + 3, y + 30, 8, 30, 'o p1', 3); }

// side section of the fixed shell (bottom, top, back, the end wall behind as a ghost with its window)
function shellSide(S, opt = {}) {
  let b = poly(rp(S, [[0, 6], [214, 6], [214, 374], [0, 374]]), 'o gh thin');
  b += poly(rp(S, [[27, 30], [187, 30], [187, 350], [27, 350]]), 'o nf dash thin');
  b += poly(rp(S, [[0, 0], [214, 0], [214, 6], [0, 6]]), 'o p1') + poly(rp(S, [[0, 374], [214, 374], [214, 380], [0, 380]]), 'o p1');
  b += poly(rp(S, [[214, 0], [220, 0], [220, 380], [214, 380]]), 'o p1');
  if (opt.batten !== false) b += poly(rp(S, [[8, 359], [28, 359], [28, 374], [8, 374]]), 'o p2');
  return b;
}
// the front frame A in a side section, at a tilt: the frame, the modules and bars behind it
function frameSide(S, deg, cls = 'o p0', withMods = true) {
  let b = '';
  if (withMods) b += poly(rp(S, [[6, 30], [27, 30], [27, 350], [6, 350]].map(p => rotA(p, deg))), cls === 'o p0' ? 'o p2m' : 'o nf dash thin');
  b += poly(rp(S, [[0, 7], [6, 7], [6, 373], [0, 373]].map(p => rotA(p, deg))), cls);
  return b;
}
function capSide(S, deg, cls = 'o p2', L = G.K) {
  const k = capK(deg, L), P = k.P, dy = k.end[0] - P[0], dz = k.end[1] - P[1], l = Math.hypot(dy, dz), ny = -dz / l * 6, nz = dy / l * 6;
  return poly(rp(S, [P, k.end, [k.end[0] + ny, k.end[1] + nz], [P[0] + ny, P[1] + nz]]), cls);
}
function cheekSide(S, deg, cls = 'o gh') {
  const top = rotA([6, 373], deg), bot = rotA([6, 7], deg), back = rotA(rotA([6, 7], -20), deg);
  return poly(rp(S, [top, bot, back]), cls);
}
function staySide(S, deg, cls = 'o al') {
  const q = rotA(G.pivot, deg), u = [G.pin[0] - q[0], G.pin[1] - q[1]], L = Math.hypot(...u), ux = u[0] / L, uz = u[1] / L;
  const a = [q[0] - ux * G.stay.lead, q[1] - uz * G.stay.lead], e = [a[0] + ux * G.stay.len, a[1] + uz * G.stay.len];
  const n = [-uz, ux], lo = -G.stay.hole, hi = 25 - G.stay.hole;
  let b = poly(rp(S, [[a[0] + n[0] * lo, a[1] + n[1] * lo], [e[0] + n[0] * lo, e[1] + n[1] * lo], [e[0] + n[0] * hi, e[1] + n[1] * hi], [a[0] + n[0] * hi, a[1] + n[1] * hi]]), cls);
  for (const d of NOTCH) { const c = S([q[0] + ux * d, q[1] + uz * d]); b += circ(c[0], c[1], 1.6, 'o p0 thin'); }
  const qq = S(q); b += circ(qq[0], qq[1], 1.8, 'o p0 thin');
  return b;
}
const pinSide = (S) => { const p = S(G.pin); return circ(p[0], p[1], 3, 'o dark'); };

// ---------------------------------------------------------------------------
// 1  The cut list (Jumbo cut-to-size, 6 mm Oecoplan poplar)
export function step1() {
  const s = 0.24; let b = '';
  const part = (L, x, y, w, h, o = {}) => {
    let g = rect(x, y, w * s, h * s, o.blank ? 'o p1' : 'o p0');
    if (o.trim) g += o.trim;
    const cx = x + w * s / 2, cy = y + h * s / 2, big = h * s > 44 && w * s > 80;
    g += wbadge(cx, cy - (big ? 7 : 0), L);
    if (big) g += txt(cx, cy + 16, `${w} × ${h}`, 'tm');
    else if (!o.nolabel) g += txt(x + w * s + 4, cy + 3, `${w} × ${h}`, 'tm', 'start');
    return g;
  };
  // column 1: the long parts
  b += part('A', 16, 16, 1004, 366) + part('B', 16, 112, 1020, 380) + part('C1', 16, 210, 1020, 214) + part('C2', 16, 268, 1020, 214);
  b += part('K', 16, 326, 1004, 150, { blank: true, trim: ln([16, 326 + G.K * s], [16 + 1004 * s, 326 + G.K * s], 'o dash') });
  b += part('T', 16, 372, 600, 150);
  for (let i = 0; i < 5; i++) b += rect(16, 418 + i * 7, 1000 * s, 20 * s, 'o p2');
  b += txt(16 + 1000 * s + 6, 434, 'battens 15 × 20 × 1000 ×5 (beech)', 'tm', 'start');
  // column 2: the small parts and the oversize blanks
  const x2 = 286;
  b += part('D', x2, 16, 214, 368, { nolabel: 1 }) + part('D', x2 + 58, 16, 214, 368, { nolabel: 1 }) + txt(x2 + 55, 16 + 368 * s + 11, '214 × 368 ×2', 'tm');
  b += part('P1', x2 + 122, 16, 292, 217, { nolabel: 1 }) + txt(x2 + 122 + 146 * s, 16 + 217 * s + 11, '292 × 217', 'tm');
  b += part('F', x2 + 122, 92, 260, 180, { nolabel: 1 }) + part('F', x2 + 190, 92, 260, 180, { nolabel: 1 }) + txt(x2 + 156 + 65 * s, 92 + 180 * s + 11, '260 × 180 ×2', 'tm');
  b += part('Y', x2, 124, 300, 208, { blank: true, trim: ln([x2 + 140 * s, 124], [x2 + 140 * s, 124 + 208 * s], 'o dash') + ln([x2 + 284 * s, 124], [x2 + 284 * s, 124 + 208 * s], 'o dash') });
  b += part('P2·P3', x2, 182, 292, 150, { blank: true, trim: [1, 2, 3, 4].map(i => ln([x2, 182 + i * 25 * s], [x2 + 292 * s, 182 + i * 25 * s], 'o dash thin')).join('') });
  b += part('H', x2, 226, 370, 150, { blank: true, trim: ln([x2, 226 + 130 * s], [x2 + 370 * s, 226 + 130 * s], 'o dash') + ln([x2, 226 + 130 * s], [x2 + 370 * s, 226], 'o dash') });
  b += part('spare', x2 + 168, 168, 400, 300, { blank: true, nolabel: 1 }) + txt(x2 + 168 + 48, 168 + 72 + 11, '400 × 300 spare', 'tm');
  b += lines(x2, 290, ['Jumbo cuts nothing under 230 × 150, hence the', 'oversize blanks. Saw ± 0.5–1 mm. “6 mm” is', '5.6–6.3 mm: measure at pickup. Pencil the letter', 'on each part: A/B and C1/C2 look alike.'], 'ts', 'start', 14);
  // legend
  const ly = 470;
  b += rect(16, ly - 9, 16, 10, 'o p0') + txt(38, ly, 'final size', 'ts', 'start');
  b += rect(120, ly - 9, 16, 10, 'o p1') + txt(142, ly, 'oversize blank', 'ts', 'start');
  b += ln([250, ly - 4], [266, ly - 4], 'o dash') + txt(272, ly, 'cut at home (step 3)', 'ts', 'start');
  return svg(640, 482, b, 'Cut list: the parts from the Jumbo cut-to-size order, drawn to scale, with the oversize blanks and where they are cut');
}

// 2  Openings, cut at the workshop with the jigsaw and the hole saws
export function step2() {
  const s = 0.27; let b = '';
  // A: window 960 × 320, 22 mm left/right, 23 mm top/bottom
  const ax = 16, ay = 24;
  b += rect(ax, ay, 1004 * s, 366 * s, 'o p0') + rect(ax + 22 * s, ay + 23 * s, 960 * s, 320 * s, 'o hatchf');
  b += txt(ax + 502 * s, ay + 183 * s + 4, '960 × 320', 'tm halo') + wbadge(ax + 4, ay - 4, 'A') + txt(ax + 502 * s, ay + 366 * s + 13, 'border 22 left and right, 23 top and bottom', 'tt');
  // D ×2: window 160 × 320, 27 front and back, 24 top and bottom
  for (const [i, dx] of [[0, 316], [1, 380]]) {
    b += rect(dx, ay, 214 * s, 368 * s, 'o p0') + rect(dx + 27 * s, ay + 24 * s, 160 * s, 320 * s, 'o hatchf');
    if (!i) b += wbadge(dx + 4, ay - 4, 'D');
  }
  b += count(446, 60, '×2') + lines(446, 80, ['160 × 320', '27 front + back', '24 top + bottom'], 'tt', 'start', 11);
  // C1 top, seen from above, back edge up: two handle cut-outs
  const tx = 16, ty = 154, Tx = x => tx + x * s, Ty = y => ty + (214 - y) * s;
  b += rect(tx, ty, 1020 * s, 214 * s, 'o p0') + wbadge(tx + 6, ty - 4, 'C1') + txt(tx + 24, ty - 1, 'top, back edge up', 'tt', 'start');
  for (const hx of G.handle.x) {
    b += rect(Tx(hx - 64.5), Ty(G.handle.y + 26), 129 * s, 52 * s, 'o hatchf');
    for (const dx of [-70.5, 0, 70.5]) for (const dy of [-31, 31]) b += circ(Tx(hx + dx), Ty(G.handle.y + dy), 1.4, 'o hatchf');
  }
  b += txt(Tx(510), ty + 214 * s + 11, '2 × 129 × 52, 6 × Ø4.8 each', 'tt');
  // C2 bottom: stand cup and thread inserts, drilled after the dry fit
  const cx = 316, cy = 154, Cx = x => cx + x * s, Cy = y => cy + (214 - y) * s;
  b += rect(cx, cy, 1020 * s, 214 * s, 'o p0') + wbadge(cx + 6, cy - 4, 'C2') + txt(cx + 24, cy - 1, 'bottom: after the dry fit', 'tt', 'start');
  b += circ(Cx(510), Cy(107), 22.5 * s, 'o nf dash') + circ(Cx(410), Cy(107), 3, 'o nf dash') + circ(Cx(610), Cy(107), 3.6, 'o nf dash');
  b += txt(Cx(510), Cy(107) + 18, 'Ø45 · Ø8 · Ø12', 'tt');
  // B, seen from outside
  const bx = 16, by = 242, Bz = z => by + (380 - z) * s, Bx = x => bx + x * s;
  b += rect(bx, by, 1020 * s, 380 * s, 'o p0') + wbadge(bx + 4, by - 4, 'B');
  b += rect(Bx(510 - 140), Bz(G.pocket.cz + 102.5), 280 * s, 205 * s, 'o hatchf') + txt(Bx(510), Bz(G.pocket.cz) + 3, '280 × 205', 'tm halo');
  for (let i = 0; i < 8; i++) b += rect(Bx(300 + i * 55), Bz(353), 40 * s, 8 * s, 'o hatchf thin');
  for (const [x, z] of [[14, 14], [510, 14], [1006, 14], [14, 366], [510, 366], [1006, 366]]) b += circ(Bx(x), Bz(z), 1.6, 'o hatchf');
  b += circ(Bx(890), Bz(310), 16 * s, 'o hatchf') + txt(Bx(890), Bz(310) - 7, 'Ø32', 'tt');
  for (const [x, cls, l, a, dx] of [[60, 'ringb', 'DATA', 'end', -4], [120, 'ringg', 'POWER', 'start', 4]]) {
    b += circ(Bx(x), Bz(40), 5, cls) + rect(Bx(x) - 2.2, Bz(40) - 1.2, 4.4, 2.4, 'o dark thin', 1) + txt(Bx(x) + dx, Bz(40) - 8, l, 'tt', a);
  }
  b += circ(Bx(175), Bz(40), 8 * s + 1, 'o hatchf') + circ(Bx(215), Bz(40), 2.2, 'o hatchf') + circ(Bx(245), Bz(40), 2.2, 'o hatchf') + txt(Bx(160), Bz(40) - 9, 'button Ø16 · lights Ø8 ×2', 'tt', 'start');
  b += txt(bx + 510 * s, by + 380 * s + 13, 'back B, seen from outside', 'tt');
  // legend
  b += lines(316, 252, ['Windows, flap and handle cut-outs:', '  drill Ø8 in each corner, then', '  jigsaw (T101B, good face down)', 'Ø32  horn hole, hole saw', 'Ø45  stand cup, hole saw', 'Ø8 / Ø12  thread inserts (check', '  the size on the inserts you have)', 'USB-C  13 × 7 + 2 × Ø3', 'vents  8 × 40 × 8 (mesh behind)', 'Ø4  six back screws'], 'ts', 'start', 14);
  return svg(640, 398, b, 'Openings: front window, two end windows, handle cut-outs in the top, the flap opening, ports, horn hole, vents and screw holes in the back');
}

// 3  Rip the oversize blanks
export function step3() {
  const s = 0.4; let b = '';
  const keep = (x, y, w, h) => rect(x, y, w * s, h * s, 'o p0'), off = (x, y, w, h) => rect(x, y, w * s, h * s, 'o hatchf');
  // K: 1004 × 150 → about 140 (after the dry fit)
  let x = 16, y = 30;
  b += keep(x, y, 1004, G.K) + off(x, y + G.K * s, 1004, 150 - G.K) + ln([x - 6, y + G.K * s], [x + 1004 * s + 6, y + G.K * s], 'o dash');
  b += wbadge(x + 40, y + 52 * s, 'K') + txt(x + 60, y + 52 * s + 4, 'about 1004 × 140: rip after the dry fit', 'ts', 'start');
  // H: 370 × 150 → 370 × 130 → two triangles
  x = 16; y = 112;
  b += poly([[x, y], [x + 370 * s, y], [x, y + 130 * s]], 'o p0') + poly([[x + 370 * s, y], [x + 370 * s, y + 130 * s], [x, y + 130 * s]], 'o p0') + off(x, y + 130 * s, 370, 20);
  b += ln([x, y + 130 * s], [x + 370 * s, y], 'o dash') + wbadge(x + 40, y + 16, 'H') + wbadge(x + 370 * s - 30, y + 130 * s - 14, 'H');
  b += txt(x + 185 * s, y + 150 * s + 14, 'rip to 130, then corner to corner', 'tt');
  // Y: 300 × 208 → 2 × 140 × 208
  x = 196; y = 112;
  b += keep(x, y, 140, 208) + keep(x + 144 * s, y, 140, 208) + off(x + 284 * s, y, 16, 208);
  b += wbadge(x + 70 * s, y + 104 * s, 'Y') + wbadge(x + 214 * s, y + 104 * s, 'Y') + txt(x + 150 * s, y + 208 * s + 14, '2 × 140 × 208, glued as a pair', 'tt');
  // P2/P3: 292 × 150 → four 25 mm strips
  x = 340; y = 112;
  for (let i = 0; i < 4; i++) b += keep(x, y + i * 27 * s, i < 2 ? 292 : 205, 25) + (i >= 2 ? off(x + 205 * s, y + i * 27 * s, 87, 25) : '');
  b += off(x, y + 108 * s, 292, 42);
  b += txt(x + 292 * s + 6, y + 13 * s, 'P2 292 × 25 ×2', 'tt', 'start') + txt(x + 292 * s + 6, y + 67 * s, 'P3 205 × 25 ×2', 'tt', 'start');
  // fence tip
  y = 262;
  b += rect(16, y, 230, 30, 'o p1') + rect(16, y - 12, 230, 10, 'o p2') + rect(40, y - 24, 14, 36, 'o al', 2) + rect(200, y - 24, 14, 36, 'o al', 2);
  b += txt(131, y + 46, 'clamp a straight batten as a fence', 'tt');
  b += lines(300, 270, ['T101B for straight rips, good face down.', 'Cut beside the line on the offcut side,', 'then sand to the line.'], 'ts', 'start', 14);
  return svg(640, 326, b, 'Rip the blanks: the bottom cap K, the two triangular cheeks H, the backing plates Y and the four pocket strips');
}

// 4  Metal: the two ratchet stays, the steel bars, the piano hinge
export function step4() {
  let b = '';
  const s = 2.45, x0 = 40, y0 = 46, lo = y0 + 25 * s;          // stay drawn at 2.45 px/mm
  b += rect(x0, y0, G.stay.len * s, 25 * s, 'o al');
  const px = x0 + G.stay.lead * s, hy = lo - G.stay.hole * s;
  b += circ(px, hy, 2.25 * s, 'o p0') + txt(px, y0 - 6, 'pivot Ø4.5', 'tt');
  NOTCH.forEach((d, i) => {
    const nx = px + d * s;
    b += rect(nx - 3.25 * s, hy, 6.5 * s, G.stay.hole * s + 1, 'o p0') + circ(nx, hy, 3.25 * s, 'o p0');
    b += ln([nx - 3.25 * s, hy], [nx - 3.25 * s, lo], 'o p0 nf') + ln([nx + 3.25 * s, hy], [nx + 3.25 * s, lo], 'o p0 nf');
    b += txt(nx, y0 - 6, TILTS[i] + '°', 'tb') + txt(nx, lo + 14, Math.round(d), 'tm');
  });
  b += ln([x0, lo], [x0 + G.stay.len * s, lo], 'o');
  b += txt(x0, lo + 14, 'mm from pivot:', 'tm', 'start');
  b += dimH(x0, x0 + G.stay.len * s, lo + 32, G.stay.len + ' mm · aluminium flat 25 × 4', 'tm') + dimV(x0 + G.stay.len * s + 10, y0, lo, '25');
  b += txt(x0 + G.stay.len * s + 10, hy + 3, '', 'tt');
  // how to make a notch
  const sy = 200;
  const stepPic = (x, n, label, pic) => circ(x, sy - 30, 9, 'o p0') + txt(x, sy - 26, n, 'tn') + pic + txt(x + 30, sy + 46, label, 'tt');
  b += stepPic(40, '1', 'centre punch', rect(56, sy - 10, 40, 20, 'o al') + path(`M76 ${sy - 40} L76 ${sy - 12}`, 'o thick'));
  b += stepPic(150, '2', 'drill Ø6.5 (HSS)', rect(166, sy - 10, 40, 20, 'o al') + circ(186, sy, 5, 'o p0') + ln([186, sy - 40], [186, sy - 8], 'o thick'));
  b += stepPic(260, '3', 'jigsaw in (T118B)', rect(276, sy - 10, 40, 20, 'o al') + circ(296, sy, 5, 'o p0') + rect(291, sy, 10, 10, 'o p0') + arrow([296, sy + 26], [296, sy + 12], 'ar', 6));
  b += stepPic(370, '4', 'file smooth', rect(386, sy - 10, 40, 20, 'o al') + `<g transform="rotate(-30 406 ${sy})">${rect(380, sy - 3, 56, 6, 'o p2', 1)}</g>`);
  // bars and hinge
  b += rect(470, 150, 150, 8, 'o al') + rect(470, 164, 150, 8, 'o al') + rect(470, 178, 150, 8, 'o al') + txt(545, 202, 'steel bars 20 × 4 × 360 ×3', 'tt') + txt(545, 213, '(two 1 m bars: 3 × 360 > 1 m)', 'tt');
  b += rect(470, 232, 150, 10, 'o al') + Array.from({ length: 15 }, (_, i) => ln([474 + i * 10, 232], [474 + i * 10, 242], 'o thin')).join('') + txt(545, 258, 'piano hinge to 1000 (T118A)', 'tt');
  b += lines(16, 286, ['Clamp the strip in the vise between two scraps of wood. Both stays together: tape them as a pair, drill through both.', 'Notch spacing is from the hinge geometry; if your pivot or pin ends up elsewhere, mark the notches on the real box (step 10).'], 'ts', 'start', 15);
  return svg(640, 320, b, 'Ratchet stay: a 200 mm aluminium strip with a pivot hole and five notches for 0, 5, 10, 15 and 20 degrees; steel bars and the piano hinge cut to length');
}

// 5  Dry fit: the front frame's swing, and the open point between the cap K and the backing plates Y
export function step5() {
  let b = '';
  const s = 0.62, S = SV(40 + 140 * s, 300, s);
  b += shellSide(S);
  // Y on the floor, the conflict zone
  b += poly(rp(S, [[3, 6], [211, 6], [211, 18], [3, 18]]), 'o noc');
  const k0 = capK(0), k20 = capK(20);
  b += frameSide(S, 20, 'o nf dash', false) + capSide(S, 20, 'o nf dash') + cheekSide(S, 20, 'o nf dash thin');
  b += frameSide(S, 0, 'o p0') + capSide(S, 0, 'o p2');
  const h = S(G.hinge); b += circ(h[0], h[1], 3.4, 'o p0') + circ(h[0], h[1], 1.2, 'ah');
  // the 20° arc
  const b0 = S([0, G.A.z0]), b20 = S(rotA([0, G.A.z0], 20)), r = Math.hypot(b0[0] - h[0], b0[1] - h[1]);
  b += path(`M${R(b0[0])} ${R(b0[1])} A${R(r)} ${R(r)} 0 0 1 ${R(b20[0])} ${R(b20[1])}`, 'ar') + txt(b20[0] - 4, b20[1] - 26, '20°', 'tb', 'end');
  b += dimH(b20[0], b0[0], S([0, -18])[1] + 4, Math.round(OUT20) + ' mm out');
  // labels
  const lk = S([60, 12]); b += txt(lk[0] + 6, lk[1] - 12, 'K at 0°', 'tt', 'start');
  const ly = S([150, 12]); b += txt(ly[0], ly[1] + 20, 'Y, 12 mm', 'tt');
  const ls = S([-60, -44]); b += txt(ls[0], ls[1], `K ${G.K} at 20°: still on the floor`, 'tt', 'start');
  b += txt(S([110, 200])[0], S([110, 200])[1], 'end wall D (behind)', 'tt halo');
  b += txt(S([0, 392])[0], S([0, 392])[1], 'front', 'ts') + txt(S([217, 392])[0], S([217, 392])[1], 'back', 'ts');
  // top view of the floor: K's path vs Y
  const s2 = 0.24, fx = 382, fy = 40, Fx = x => fx + x * s2, Fy = y => fy + (214 - y) * s2;
  b += txt(fx, fy - 14, 'floor seen from above (front down)', 'ts', 'start');
  b += rect(fx, fy, 1020 * s2, 214 * s2, 'o p0');
  b += rect(Fx(28), Fy(146), 964 * s2, 140 * s2, 'o hatchf') + rect(Fx(440), Fy(211), 140 * s2, 208 * s2, 'o noc') + rect(Fx(30), Fy(168), 400 * s2, 18 * s2, 'o al');
  b += txt(Fx(220), Fy(70) + 3, 'K slides here', 'tt halo') + txt(Fx(230), Fy(150) + 22, '', 'tt') + txt(Fx(510), Fy(170), 'Y', 'tb');
  b += lines(fx, 122, ['Both want the middle of the floor.', 'Decide here, before gluing Y:'], 'tl', 'start', 16);
  b += lines(fx, 164, ['1  Y towards the back, K rides over', '    it on two thin runners', '2  Y and the stand cup off K’s path'], 'tl', 'start', 16);
  b += ok(fx + 8, 236, 9) + lines(fx + 24, 240, ['A swings free: 2 mm each side,', '1 mm top and bottom'], 'ts', 'start', 13);
  b += ok(fx + 8, 276, 9) + lines(fx + 24, 280, [`K ${G.K} mm: on the floor at 20° too,`, 'back edge 146 from the front at 0°'], 'ts', 'start', 13);
  return svg(640, 340, b, 'Dry fit, side section: the front frame at 0 and 20 degrees, the bottom cap K, and where K and the backing plate Y both need the floor');
}

// 6  Glue the shell
export function step6() {
  const P = proj(FRONT, 150, 330, 0.4); let b = '';
  b += poly(fFront(P, 0, 0, 1020, 380, 220), 'o nf dash');
  const bl = P(1040, 220, 380); b += wbadge(bl[0] + 6, bl[1], 'B') + txt(bl[0] + 20, bl[1] + 4, 'back: step 25', 'tt', 'start');
  b += box(P, 0, 0, 0, 1020, 214, 6);
  b += box(P, 6, 194, 6, 1008, 20, 15, 'o p1', 'o p1', 'o p2');                                // bottom back batten
  for (const x of [6, 1000]) for (const y of [120]) b += box(P, x, y, 6, 14, 60, 14, 'o p1', 'o p1', 'o p2');
  b += poly(fTop(P, 0, 0, 6, 214, 374), 'o p1') + hole(fSide(P, 0, 6, 214, 368, 6), fSide(P, 27, 30, 160, 320, 6), 'o p2') + poly(fFront(P, 0, 6, 6, 368, 0), 'o p0');
  b += poly(fTop(P, 1014, 0, 6, 214, 374), 'o p1') + hole(fSide(P, 0, 6, 214, 368, 1020), fSide(P, 27, 30, 160, 320, 1020), 'o p2') + poly(fFront(P, 1014, 6, 6, 368, 0), 'o p0');
  // top, lifted, with its front batten (the piano hinge screws into it) and the back blocks
  const zl = 150;
  b += box(P, 6, 8, 359 + zl, 1008, 20, 15, 'o p1', 'o p1', 'o p2');
  for (const x of [6, 495, 999]) b += box(P, x, 194, 359 + zl, 15, 20, 15, 'o p1', 'o p1', 'o p2');
  b += box(P, 0, 0, 374 + zl, 1020, 214, 6);
  b += arrow(P(170, 110, 500), P(170, 110, 392)) + arrow(P(850, 110, 500), P(850, 110, 392));
  const lc = P(-50, 110, 380 + zl), lc2 = P(820, 214, -24), ld = P(1070, 110, 140);
  b += wbadge(lc[0], lc[1], 'C1') + wbadge(lc2[0], lc2[1], 'C2') + wbadge(ld[0], ld[1], 'D');
  const lb = P(510, 0, 359 + zl); b += txt(lb[0], lb[1] + 16, 'batten under the front edge: the piano hinge screws into it', 'tt halo');
  const lb2 = P(510, 204, 24); b += txt(lb2[0], lb2[1] - 6, 'batten along the back edge: the back screws into it', 'tt halo');
  const la = P(510, 0, 190); b += txt(la[0], la[1], 'front open: A hangs here in step 9', 'ts halo');
  b += glue(34, 40) + txt(62, 46, '+', 'tc') + torx(86, 40, 10) + txt(104, 38, '3.5 × 16 T20', 'tm', 'start') + txt(104, 50, 'pre-drill Ø2.5', 'tm', 'start');
  b += tape(210, 40, 10, 26, -20) + tape(228, 40, 10, 26, -20) + txt(246, 46, 'tape every 15 cm', 'tm', 'start');
  return svg(640, 356, b, 'Glue the bottom, both ends and the top, with battens and blocks; tape every 15 cm instead of clamps. The front and back stay off');
}

// 7  Stand cup and tripod threads in the bottom
export function step7() {
  const s = 0.54, ox = 46, oy = 168; let b = '';
  const M = (x, y) => [ox + x * s, oy + (214 - y) * s];
  b += rect(28, 40, 70, 26, 'o p1') + rect(28, 66, 70, 5, 'o p2') + carrow([40, 34], [63, 6], [88, 34]);
  b += rect(ox, oy, 1020 * s, 214 * s, 'o p0') + txt(ox + 510 * s, oy + 214 * s + 14, 'front edge', 'ts');
  const yp = M(440, 211); b += rect(yp[0], yp[1], 140 * s, 208 * s, 'o nf dash');
  const c = M(510, 107); b += rect(c[0] - 22, c[1] - 22, 44, 44, 'o p1', 5) + circ(c[0], c[1], 12, 'o p2');
  for (const [dx, dy] of [[-15, -15], [15, -15], [15, 15], [-15, 15]]) b += screw(c[0] + dx, c[1] + dy, 2.2);
  const i1 = M(410, 107), i2 = M(610, 107); b += circ(i1[0], i1[1], 4, 'o p2') + circ(i2[0], i2[1], 5.5, 'o p2');
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
  b += txt(548, 160, 'stand flange 35 mm', 'tm', 'start') + txt(548, 172, 'M4 × 16 T20 ×4', 'tm', 'start');
  b += wbadge(yp[0] - 14, yp[1] + 8, 'Y') + lines(ox, oy + 214 * s + 32, ['Y: two layers glued (12 mm), inside, under the flange and the threads.', 'Where Y and the cup sit follows the decision in step 5.'], 'ts', 'start', 14);
  return svg(640, 326, b, 'Turn the box over; glue the backing plate inside, fit the stand flange and the two tripod threads');
}

// 8  Screen pocket and flap
export function step8() {
  let b = '';
  // B from inside, the pocket walls around the opening
  const s = 0.3, bx = 16, by = 40, X = x => bx + x * s, Z = z => by + (380 - z) * s, pw = G.pocket;
  b += rect(bx, by, 1020 * s, 380 * s, 'o p0') + wbadge(bx + 4, by - 4, 'B') + txt(bx + 24, by - 1, 'inside face', 'tt', 'start');
  b += rect(X(510 - 146), Z(pw.cz + 108.5), 292 * s, 217 * s, 'o p1') + rect(X(510 - 140), Z(pw.cz + 102.5), 280 * s, 205 * s, 'o p2');
  b += txt(X(510), Z(pw.cz) + 4, 'P1 on top', 'tt halo');
  b += rect(X(510 - 70), Z(pw.cz + 124), 140 * s, 14 * s, 'o p2') + txt(X(510), Z(pw.cz + 124) - 3, 'hinge block', 'tt');
  b += txt(bx + 510 * s, by + 380 * s + 14, 'P2 top + bottom, P3 sides: 25 deep, round the opening', 'tt');
  // section through the pocket, outside to the right
  const k = 0.92, O = [430, 300], Q = ([u, z]) => [O[0] + u * k, O[1] - (z - 70) * k];
  const top = pw.cz + pw.h / 2, bot = pw.cz - pw.h / 2;
  b += poly(rp(Q, [[-6, 70], [0, 70], [0, bot], [-6, bot]]), 'o p1') + poly(rp(Q, [[-6, top], [0, top], [0, 315], [-6, 315]]), 'o p1');
  b += poly(rp(Q, [[-31, top], [-6, top], [-6, top + 6], [-31, top + 6]]), 'o p2') + poly(rp(Q, [[-31, bot - 6], [-6, bot - 6], [-6, bot], [-31, bot]]), 'o p2');
  b += poly(rp(Q, [[-37, bot - 6], [-31, bot - 6], [-31, top + 6], [-37, top + 6]]), 'o p1');
  b += poly(rp(Q, [[-31, top - 20], [-17, top - 20], [-17, top], [-31, top]]), 'o p2');   // hinge block
  // flap closed: 12 mm, screen on its outer face, glass about 8 mm in from the back face
  const piv = [-16, top - 8], fl = [[-28, top - 8], [-16, top - 8], [-16, top - 188], [-28, top - 188]];
  b += poly(rp(Q, fl), 'o p0') + poly(rp(Q, [[-16, top - 30], [-9, top - 30], [-9, top - 170], [-16, top - 170]]), 'o dark');
  // flap open, 45° from flat
  const rot = ([u, z], a) => { const c = Math.cos(a * d2r), sn = Math.sin(a * d2r), du = u - piv[0], dz = z - piv[1]; return [piv[0] + du * c + dz * sn, piv[1] - du * sn + dz * c]; };
  const open = 45;
  b += poly(rp(Q, fl.map(p => rot(p, -open))), 'o nf dash') + poly(rp(Q, [[-16, top - 30], [-9, top - 30], [-9, top - 170], [-16, top - 170]].map(p => rot(p, -open))), 'o nf dash');
  const pq = Q(piv); b += circ(pq[0], pq[1], 3, 'o p0') + circ(pq[0], pq[1], 1.1, 'ah');
  const e0 = Q([-16, top - 188]), e1 = Q(rot([-16, top - 188], -open));
  b += carrow(e0, [e0[0] + 70, e0[1] + 10], e1, 'ar', 8);
  b += poly(rp(Q, [[-31, bot], [-22, bot], [-22, bot + 14], [-31, bot + 14]]), 'o fuse');   // catch
  const lq = Q([10, top + 10]); b += txt(lq[0], lq[1], 'torque hinges ×2, 1.2 N·m', 'tt', 'start');
  const lc = Q([4, bot + 6]); b += txt(lc[0], lc[1], 'magnetic catch on a block', 'tt', 'start');
  const lf = Q([-56, 190]); b += txt(lf[0], lf[1], 'F ×2', 'tb', 'end') + txt(lf[0], lf[1] + 12, '12 mm', 'tt', 'end');
  const ls = Q([96, 250]); b += txt(ls[0], ls[1], 'open: 45° from flat', 'tt', 'start');
  b += txt(Q([-20, 330])[0], Q([-20, 330])[1], 'inside ← | → scorer', 'tt');
  b += lines(16, 200, ['1  Glue P2 and P3 round the opening, P1 on top:', '    a closed box 25 mm deep, open to the back.', '2  Glue the two flap layers F (12 mm). Trim to', '    the real screen; 10 mm clear all round.', '3  Hinge block under the top wall, two torque', '    hinges at the flap’s top edge.', '4  Catch on a block at the bottom; a steel washer', '    on the flap if there is no counter-plate.', '5  A slot through F and P1 for the display ribbon.'], 'ts', 'start', 15);
  return svg(640, 352, b, 'The screen pocket glued inside the back panel, and a section through it: the flap on two torque hinges at the top, closed and open 45 degrees from flat');
}

// 9  Hang the front frame on the piano hinge
export function step9() {
  let b = '';
  // A seen from behind, hinge along its top edge
  const s = 0.36, ax = 16, ay = 44, X = x => ax + x * s, Z = z => ay + (366 - z) * s;
  b += rect(ax, ay, 1004 * s, 366 * s, 'o p0') + rect(X(22), Z(343), 960 * s, 320 * s, 'o hatchf') + wbadge(ax + 4, ay - 18, 'A') + txt(ax + 24, ay - 15, 'seen from behind', 'tt', 'start');
  b += rect(X(2), ay - 1, 1000 * s, 16 * s, 'o al');
  for (let i = 0; i < 20; i++) b += circ(X(27 + i * 50), ay + 8 * s - 1, 1.1, 'o p0 thin');
  b += txt(X(502), ay + 366 * s + 16, 'hinge leaf on A’s top border, knuckle at its top back edge', 'tt');
  // shims
  const sy = ay + 366 * s + 40;
  b += rect(16, sy, 34, 6, 'o fuse') + txt(56, sy + 6, '1 mm card under A while you screw', 'ts', 'start');
  b += rect(16, sy + 18, 6, 26, 'o fuse') + rect(26, sy + 18, 6, 26, 'o fuse') + txt(56, sy + 35, '2 mm each side', 'ts', 'start');
  // detail: the top front corner in section
  const k = 4.2, O = [470, 214], Q = ([y, z]) => [O[0] + y * k, O[1] - (z - 340) * k];
  b += poly(rp(Q, [[-8, 374], [40, 374], [40, 380], [-8, 380]].map(([y, z]) => [Math.max(y, 0), z])), 'o p1');
  b += poly(rp(Q, [[8, 359], [28, 359], [28, 374], [8, 374]]), 'o p2');
  b += poly(rp(Q, [[0, 340], [6, 340], [6, 373], [0, 373]]), 'o p0');
  b += poly(rp(Q, [[6, 357], [7, 357], [7, 373], [6, 373]]), 'o al') + poly(rp(Q, [[7, 357], [8, 357], [8, 373], [7, 373]]), 'o al');
  const kn = Q([7, 373.5]); b += circ(kn[0], kn[1], 1.6 * k, 'o al');
  b += poly(rp(Q, [[0, 340], [6, 340], [6, 373], [0, 373]].map(p => rotK(p, 20))), 'o nf dash');
  b += txt(Q([20, 383])[0], Q([20, 383])[1], 'C1 top', 'tt') + txt(Q([18, 366])[0], Q([18, 366])[1] + 3, 'batten', 'tt');
  b += txt(Q([3, 345])[0], Q([3, 345])[1], 'A', 'tb');
  { const q = Q(rotK([0, 342], 20)); b += txt(q[0] - 6, q[1] + 4, 'A at 20°', 'tt', 'end'); }
  b += lines(390, 262, ['Keep the 3 mm round on A’s top front', 'edge: the hinge sits on the inside, and at 20°', `that corner swings up about ${Math.ceil(HINGE_RISE)} mm into the top.`], 'ts', 'start', 14);
  return svg(640, 316, b, 'Screw the piano hinge to the top border of the front frame, then into the batten under the top, with 1 mm and 2 mm shims; detail of the hinge line in section');
}

// 10  Cap K, cheeks H and the two ratchet stays
export function step10() {
  let b = '';
  const s = 0.62, S = SV(16 + 130 * s, 290, s), deg = 15;
  b += shellSide(S);
  b += cheekSide(S, deg, 'o p1') + frameSide(S, deg) + capSide(S, deg, 'o p2') + staySide(S, deg) + pinSide(S);
  const pv = S(rotA(G.pivot, deg)), pn = S(G.pin);
  b += txt(pv[0] - 6, pv[1] + 22, 'pivot on A', 'tt', 'end') + txt(pn[0] + 4, pn[1] + 26, 'M6 pin', 'tt', 'start');
  const ch = S(rotA([40, 200], deg)); b += wbadge(ch[0] + 10, ch[1], 'H');
  const kk = capK(deg), km = S([(kk.P[0] + kk.end[0]) / 2, 30]); b += wbadge(km[0], km[1], 'K');
  b += txt(S([-80, 400])[0], S([-80, 400])[1], `shown at ${deg}°`, 'ts');
  // the stay over its pin, close up
  b += mag(352, 92, 52, [pn[0], pn[1] - 2], (() => {
    let g = rect(300, 66, 104, 40, 'o al') + rect(343, 94, 18, 14, 'o p0') + circ(352, 94, 9, 'o p0') + circ(352, 94, 7, 'o dark');
    g += circ(320, 94, 9, 'o p0 nf') + rect(311, 94, 18, 14, 'o p0') + circ(384, 94, 9, 'o p0') + rect(375, 94, 18, 14, 'o p0');
    return g + carrow([392, 48], [410, 60], [404, 80], 'ar', 6);
  })()) + txt(352, 160, 'lift the bottom, drop a notch on the pin', 'tt');
  // the layer stack at each end, seen from the front
  const L = (x, w, cls, label, row) => rect(x, 210, w * 4, 60, cls) + ln([x + w * 2, 270], [x + w * 2, 276 + row * 12], 'o thin') + txt(x + w * 2, 286 + row * 12, label, 'tt');
  b += txt(434, 196, 'at each end, outside → in (mm):', 'ts', 'start');
  b += L(434, 6, 'o p1', 'D 6', 0) + L(458, 12, 'o p2', 'block 12', 1) + L(506, 4, 'o al', 'stay 4', 0) + L(526, 6, 'o p1', 'H 6', 1) + L(554, 6, 'o p2m', 'modules', 0);
  b += lines(434, 316, ['the bench screen sits above the stay;', 'H clears it 23–29 mm from the outside'], 'tt', 'start', 11);
  return svg(640, 340, b, 'Side section at 15 degrees: the triangular cheek, the bottom cap and the stay from its pivot on the front frame to the M6 pin through the end wall');
}

// 11  K16 handles in the top
export function step11() {
  let b = '';
  const s = 2.0, ox = 30, oy = 34, hx = G.handle;
  // rim, cut-out, holes, seen from above
  b += rect(ox, oy, hx.rim[0] * s, hx.rim[1] * s, 'o p2', 6) + rect(ox + 13 * s, oy + 15.65 * s, hx.cut[0] * s, hx.cut[1] * s, 'o dark');
  b += rect(ox + 22 * s, oy + 30 * s, 111 * s, 18 * s, 'o p1', 8);
  for (const dx of [-70.5, 0, 70.5]) for (const dy of [-31, 31]) b += torx(ox + (77.5 + dx) * s, oy + (41.65 + dy) * s, 5);
  b += dimH(ox, ox + hx.rim[0] * s, oy - 10, '155') + dimV(ox + hx.rim[0] * s + 10, oy, oy + hx.rim[1] * s, '83');
  b += dimH(ox + 13 * s, ox + 142 * s, oy + hx.rim[1] * s + 18, 'cut-out 129 × 52') + txt(ox + 77.5 * s, oy + hx.rim[1] * s + 46, 'holes Ø4.8 on 141 × 62', 'tt');
  // section: through the top
  const sx = 400, sy = 120, k = 1.6;
  b += rect(sx, sy, 220, 6 * k, 'o p1') + rect(sx + 50, sy - 1.2 * k, 120, 1.2 * k, 'o p2');
  b += rect(sx + 60, sy, 100, 7.6 * k, 'o p2') + rect(sx + 66, sy + 1, 88, 4, 'o p1', 2);
  for (const x of [sx + 54, sx + 166]) b += rect(x - 2, sy - 1, 4, 16 * k, 'o al') + rect(x - 5, sy + 6 * k, 10, 5, 'o p2');
  b += txt(sx + 110, sy - 12, 'rim 1.2 mm, flush when folded', 'tt') + txt(sx + 110, sy + 44, 'tray 7.6 deep · M4 × 16 + lock nut ×6', 'tt');
  // where on the top
  const ts = 0.2, tx = 400, ty = 200;
  b += rect(tx, ty, 1020 * ts, 214 * ts, 'o p0') + txt(tx + 102, ty + 214 * ts + 12, 'top, back edge up', 'tt');
  for (const x of hx.x) b += rect(tx + (x - 77.5) * ts, ty + (214 - hx.y - 41.65) * ts, 155 * ts, 83.3 * ts, 'o p2', 1);
  b += rect(tx + (510 - 146) * ts, ty, 292 * ts, 6, 'o nf dash') + txt(tx + 102, ty - 4, 'pocket below', 'tt');
  b += lines(30, 290, ['Near the back edge, left and right: clear of the flap pocket (under the', 'middle of the back) and the hinge batten (along the front).'], 'ts', 'start', 14);
  return svg(640, 320, b, 'Recessed K16 spring handle: rim, cut-out and six M4 screws; section through the top; where the two handles go');
}

// 12  The pull-out rear foot
export function step12() {
  let b = '';
  const s = 0.5, ox = 16, oy = 40, ft = G.foot, X = x => ox + x * s, Y = y => oy + y * s;   // seen from below, front up
  b += rect(ox, oy, 1020 * s, 214 * s, 'o p0') + txt(ox, oy - 8, 'seen from below · front edge up', 'ts', 'start');
  for (const rx of ft.railX) b += rect(X(rx), Y(10), 20 * s, 204 * s, 'o p2');
  // foot in (solid) and out (dashed, 120 further back)
  const fx = 510 - ft.w / 2;
  b += rect(X(fx), Y(ft.in), ft.w * s, ft.d * s, 'o p1') + rect(X(fx), Y(ft.in + ft.travel), ft.w * s, ft.d * s, 'o nf dash');
  b += arrow([X(510), Y(150)], [X(510), Y(150 + ft.travel)], 'ar', 8) + txt(X(530), Y(250), '120 mm out', 'tb', 'start');
  // stop slot + 2 screws, turn button, pads
  for (const sx of [300, 720]) b += rect(X(sx) - 2.5, Y(ft.in + 10), 5, 125 * s, 'o p0', 2.5) + torx(X(sx), Y(200), 3.6);
  b += rect(X(ft.railX[1] + 4), Y(214) - 4, 26, 8, 'o p1', 4) + txt(X(ft.railX[1] + 40), Y(214) + 4, 'turn button', 'tt', 'start');
  for (const rx of ft.railX) for (const y of [24, 196]) b += rect(X(rx) - 1, Y(y) - 5, 10, 10, 'o pc');
  for (const x of [fx + 30, fx + ft.w - 50]) b += rect(X(x), Y(ft.in + ft.d - 24), 10, 10, 'o pc');
  b += txt(X(fx + 300), Y(ft.in + 60), 'T', 'tb') + txt(X(ft.railX[0] + 10), Y(232), 'rail', 'tt') + txt(X(ft.railX[1] + 10), Y(232), 'rail', 'tt');
  b += rect(X(360), Y(ft.in), 300 * s, 70 * s, 'o nf dash thin') + txt(X(510), Y(ft.in + 44), 'tripod notch, if needed', 'tt halo');
  // section across one rail
  const k = 3.0, sx = 70, sy = 286, Z = z => sy - z * k, U = u => sx + u * k;
  b += rect(U(-14), Z(6), 66 * k, 6 * k, 'o p1') + txt(U(52) + 6, Z(3) + 3, 'C2', 'tt', 'start');
  b += rect(U(0), Z(0), 20 * k, 15 * k, 'o p2') + txt(U(10), Z(-7) + 3, 'rail 20 × 15', 'tt');
  b += rect(U(-3), Z(-15), 35 * k, 6 * k, 'o p1') + txt(U(-6), Z(-18) + 3, 'lip 6 mm', 'tt', 'end');
  b += rect(U(20.5), Z(-9), 32 * k, 6 * k, 'o p0') + txt(U(54) + 6, Z(-12) + 3, 'T on the lip', 'tt', 'start');
  b += rect(U(2), Z(-21), 10 * k, 3 * k, 'o pc') + txt(U(16), Z(-24) + 12, 'pad', 'tt', 'start');
  b += lines(372, 300, ['Rails run front to back under the bottom;', 'a plywood lip screwed under each holds T.', 'Two screws in a slot stop it at full travel;', 'a turn button holds it in for transport.'], 'ts', 'start', 14);
  return svg(640, 370, b, 'The pull-out rear foot seen from below: two rails, the foot in and pulled out 120 mm, stop slot, turn button and pads; section across one rail');
}

// 13  Paint
export function step13() {
  let b = '';
  const P = proj(FRONT, 40, 262, 0.28);
  b += poly(fSide(P, 0, 0, 214, 380, 1020), 'o dark') + poly(fTop(P, 0, 0, 1020, 214, 380), 'o dark');
  b += poly(fFront(P, 0, 0, 1020, 380, 0), 'o dark') + poly(fFront(P, 6, 6, 1008, 368, 0), 'o dark') + poly(fSide(P, 27, 30, 160, 320, 1020), 'o p2m');
  const lb = P(510, 0, -60); b += txt(lb[0], lb[1], 'box, inside and out: matte black', 'ts');
  // A on its own, gloss front
  const s = 0.26, ax = 372, ay = 150;
  b += rect(ax, ay, 1004 * s, 366 * s, 'o gl') + rect(ax + 22 * s, ay + 23 * s, 960 * s, 320 * s, 'o dark');
  b += ln([ax + 12, ay + 8], [ax + 70, ay + 8], 'glare') + ln([ax + 12, ay + 14], [ax + 40, ay + 14], 'glare');
  b += txt(ax + 502 * s, ay + 366 * s + 16, 'front face of A: gloss black', 'ts') + wbadge(ax - 2, ay - 6, 'A');
  b += roller(420, 30) + brush(500, 40) + count(530, 76, '×2') + txt(540, 112, 'coats, dry between', 'tm', 'start');
  b += lines(20, 26, ['Hinge, stays, handles and catches off first; label them.'], 'tl', 'start');
  return svg(640, 296, b, 'Paint the box matte black inside and out, the front face of the frame gloss black, two coats');
}

// 14  Pads and corner caps, after the paint has cured
export function step14() {
  let b = '';
  const s = 0.42, ox = 30, oy = 40, X = x => ox + x * s, Y = y => oy + y * s, ft = G.foot;
  b += rect(ox, oy, 1020 * s, 214 * s, 'o p0') + txt(ox, oy - 8, 'seen from below', 'ts', 'start');
  for (const rx of ft.railX) b += rect(X(rx), Y(10), 20 * s, 204 * s, 'o p2');
  b += rect(X(510 - ft.w / 2), Y(ft.in), ft.w * s, ft.d * s, 'o p1');
  for (const rx of ft.railX) for (const y of [24, 196]) b += rect(X(rx) - 1, Y(y) - 5, 10, 10, 'o pc') + '';
  for (const x of [510 - ft.w / 2 + 30, 510 + ft.w / 2 - 50]) b += rect(X(x), Y(ft.in + ft.d - 24), 10, 10, 'o pc');
  b += txt(X(ft.railX[0] + 10), Y(214) + 16, '4 under the rails', 'tt') + txt(X(510), Y(214) + 16, '2 under the foot’s back end', 'tt');
  b += txt(ox + 510 * s, oy + 214 * s + 34, '2 spare · press 30 s each', 'tt');
  // corner cap, front corners of the box only, trimmed to the ends' edge
  const cx = 500, cy = 70;
  b += path(`M${cx} ${cy} L${cx + 60} ${cy} L${cx + 60} ${cy + 80} L${cx} ${cy + 80} Z`, 'o p1') + path(`M${cx + 60} ${cy} L${cx + 84} ${cy - 16} L${cx + 84} ${cy + 64} L${cx + 60} ${cy + 80} Z`, 'o p2');
  b += path(`M${cx + 44} ${cy} L${cx + 60} ${cy} L${cx + 84} ${cy - 16} L${cx + 70} ${cy - 16} Z`, 'o dark') + path(`M${cx + 60} ${cy} L${cx + 60} ${cy + 18} L${cx + 84} ${cy + 2} L${cx + 84} ${cy - 16} Z`, 'o dark');
  b += txt(cx + 42, cy + 108, 'rubber cap, front corners', 'tt') + txt(cx + 42, cy + 120, 'only as far as the end’s 6 mm edge:', 'tt') + txt(cx + 42, cy + 132, 'the front frame must swing past it', 'tt');
  b += circ(40, 200, 12, 'o p0') + ln([40, 200], [40, 192]) + ln([40, 200], [46, 203]) + txt(60, 204, 'only after the paint has fully cured (see the tin)', 'tl', 'start');
  return svg(640, 236, b, 'Self-adhesive rubber pads under the rails and the foot, black rubber caps on the box front corners, after the paint has cured');
}

// ---- LED modules on the front frame (TOP projection: A lying face-down) ----
function lyingA(P, withPC = true) {
  let b = poly(fTop(P, -50, -45, 1104, 456, 0), 'o p1 thin');
  b += poly(fSide(P, 0, 0, 366, 6, 1004), 'o p2') + poly(fFront(P, 0, 0, 1004, 6, 0), 'o p0');
  b += hole(fTop(P, 0, 0, 1004, 366, 6), fTop(P, 22, 23, 960, 320, 6), 'o p0');
  if (withPC) b += poly(fTop(P, 7, 8, 990, 350, 9), 'o pc thin') + ln(P(200, 60, 9), P(320, 320, 9), 'glare') + ln(P(240, 60, 9), P(360, 320, 9), 'glare');
  return b;
}
export function step15() {
  const P = proj(TOP, 72, 262, 0.5); let b = lyingA(P);
  b += modBack(P, 22, 183, 9, 4, 1) + modBack(P, 342, 183, 9, 5, 1) + modBack(P, 662, 183, 9, 6, 1);
  b += modBack(P, 22, 23, 9, 1, 1) + modBack(P, 342, 23, 9, 2, 1) + modBack(P, 662, 23, 9, 3, 1);
  const z = 23;
  b += ribbon(P(300, 78, z), P(342, 78, z + 60), P(384, 78, z)) + ribbon(P(620, 78, z), P(662, 78, z + 60), P(704, 78, z));
  b += ribbon(P(300, 238, z), P(342, 238, z + 60), P(384, 238, z)) + ribbon(P(620, 238, z), P(662, 238, z + 60), P(704, 238, z));
  for (const bx of [182, 502, 822]) {
    b += box(P, bx - 10, 3, 9, 20, 20, 22, 'o p1', 'o p1', 'o p2') + box(P, bx - 10, 343, 9, 20, 20, 22, 'o p1', 'o p1', 'o p2');
    b += box(P, bx - 10, 3, 31, 20, 360, 4, 'o p0', 'o al', 'o p2');
    for (const y of [13, 353]) { const p = P(bx, y, 35); b += screw(p[0], p[1], 2.2); }
  }
  const n = P(-60, 103, 9), f = P(-60, 263, 9);
  b += txt(n[0] - 4, n[1] + 4, 'top row →', 'ts', 'end') + txt(f[0] - 4, f[1] + 4, 'bottom row →', 'ts', 'end');
  b += wbadge(24, 24, 'A') + txt(40, 28, 'face-down on a blanket', 'ts', 'start');
  b += lines(400, 24, ['Bars sit on the magnets, screwed to blocks', 'on A’s top and bottom border, packed to', 'the magnet height.'], 'ts', 'start', 13);
  return svg(640, 304, b, 'Front frame face-down: smoked sheet, six modules with the arrows all one way, short ribbons 1 to 3 and 4 to 6, three steel bars on blocks');
}

export function step16() {
  const s = 0.56; let b = '';
  function end(x0, y0, label) {
    let g = rect(x0, y0, 214 * s, 368 * s, 'o p0') + rect(x0 + 27 * s - 4, y0 + 24 * s - 4, 160 * s + 8, 320 * s + 8, 'o pc dash thin');
    g += rect(x0 + 27 * s, y0 + 24 * s, 160 * s, 320 * s, 'o p2m');
    const cx = x0 + 107 * s;
    g += rect(cx - 12, y0 + 24 * s + 12, 24, 14, 'o p0 thin') + txt(cx, y0 + 24 * s + 36, 'OUT', 'tt');
    g += rect(cx - 12, y0 + 344 * s - 26, 24, 14, 'o p0 thin') + txt(cx, y0 + 344 * s - 32, 'IN', 'tt');
    g += arrow([cx, y0 + 160], [cx, y0 + 84], 'ar', 9);
    for (const [bx, by] of [[43, 12], [171, 12], [43, 356], [171, 356]]) { const px = x0 + bx * s, py = y0 + by * s; g += rect(px - 12, py - 4.5, 24, 9, 'o p1', 4.5) + screw(px, py, 1.8); }
    g += rect(x0 + 40 * s, y0 + 352 * s, 30 * s, 12 * s, 'o dark') + txt(x0 + 55 * s, y0 + 368 * s + 30, 'pin block', 'tt');
    g += txt(x0 + 107 * s, y0 + 368 * s + 18, label, 'ts');
    return g;
  }
  b += end(70, 30, 'left end, from inside') + end(250, 30, 'right end, from inside');
  b += mag(520, 128, 82, [250 + 171 * s, 30 + 12 * s], (() => {
    let g = rect(438, 40, 170, 50, 'o p0') + rect(438, 90, 170, 130, 'o p2m');
    g += `<g transform="rotate(-30 520 82)">${rect(470, 66, 100, 32, 'o p1', 16)}</g>` + torx(520, 82, 9);
    g += carrow([566, 50], [600, 70], [588, 108]);
    return g;
  })());
  b += lines(448, 250, ['Smoked sheet 172 × 332 first,', 'then the module, arrows up.', '8 turn buttons, 4 per end.', 'Keep the pin block clear.'], 'tl', 'start', 15);
  return svg(640, 330, b, 'One module behind each end window, held by four turn buttons');
}

export function step17() {
  let b = '';
  const s = 0.62, S = SV(16 + 140 * s, 300, s), deg = 20;
  b += shellSide(S) + frameSide(S, 0, 'o nf dash', false) + frameSide(S, deg) + capSide(S, deg, 'o p2') + staySide(S, deg) + pinSide(S);
  // ribbon and power loops from the front modules to the electronics on the floor
  const a = S(rotA([27, 260], deg)), c = S([150, 30]), a2 = S(rotA([27, 120], deg)), c2 = S([170, 22]);
  b += path(`M${R(a[0])} ${R(a[1])} C${R(a[0] + 120)} ${R(a[1] - 10)} ${R(c[0] - 80)} ${R(c[1] - 160)} ${R(c[0])} ${R(c[1])}`, 'rib0') + path(`M${R(a[0])} ${R(a[1])} C${R(a[0] + 120)} ${R(a[1] - 10)} ${R(c[0] - 80)} ${R(c[1] - 160)} ${R(c[0])} ${R(c[1])}`, 'rib1');
  b += path(`M${R(a2[0])} ${R(a2[1])} C${R(a2[0] + 90)} ${R(a2[1] + 10)} ${R(c2[0] - 60)} ${R(c2[1] - 90)} ${R(c2[0])} ${R(c2[1])}`, 'wr');
  b += rect(c[0] - 12, c[1] - 6, 30, 8, 'o p1') + txt(c[0] + 2, c[1] + 16, 'bonnet', 'tt');
  b += txt(S([120, 230])[0], S([120, 230])[1], '~12 cm slack, a loose loop', 'tb halo');
  b += lines(390, 60, ['Screw the hinge leaf back into the', 'batten (same holes). Then plug the', 'ribbons and power leads with about', '12 cm of slack: tilt to 20° and back', 'with everything plugged in. Nothing', 'may pull tight or catch on a cheek.'], 'tl', 'start', 16);
  b += ok(398, 190, 10) + txt(414, 194, 'bench screens don’t move', 'ts', 'start');
  return svg(640, 330, b, 'Hang the front frame again and route the ribbons and power leads with about 12 centimetres of slack; check the full swing to 20 degrees');
}

// ---- electronics ------------------------------------------------------------
function chip(x, y, w, h, l1, l2, cls = 'o p0') {
  return rect(x, y, w, h, cls, 2) + txt(x + w / 2, y + h / 2 + (l2 ? -1 : 3), l1, 'tt') + (l2 ? txt(x + w / 2, y + h / 2 + 9, l2, 'tt') : '');
}
export const step18 = () => stepTray();

// 19  The power path
export function step19() {
  let b = '';
  const y1 = 92;
  b += rect(14, y1 - 40, 22, 80, 'o p2') + circ(25, y1, 9, 'ringg') + rect(21, y1 - 3, 8, 6, 'o dark thin') + txt(25, y1 + 56, 'POWER', 'tt');
  b += path(`M34 ${y1} L70 ${y1}`, 'wg thick2');
  b += rect(52, y1 + 12, 12, 22, 'o fuse', 2) + txt(58, y1 + 46, 'TVS', 'tt') + path(`M58 ${y1} L58 ${y1 + 12}`, 'o thin');
  b += chip(70, y1 - 24, 74, 48, 'STUSB4500', '0x28');
  b += path(`M144 ${y1 - 10} L176 ${y1 - 10}`, 'wr') + path(`M144 ${y1 + 12} C170 ${y1 + 12} 170 ${y1 + 60} 230 ${y1 + 60}`, 'wb');
  b += rect(176, y1 - 16, 26, 12, 'o fuse', 2) + txt(189, y1 - 22, '5 A', 'tt');
  b += path(`M202 ${y1 - 10} L226 ${y1 - 10}`, 'wr') + chip(226, y1 - 26, 62, 32, 'INA226', '0x41 · 2 mΩ');
  b += path(`M288 ${y1 - 10} L330 ${y1 - 10}`, 'wr') + txt(304, y1 - 18, '1 mm²', 'tt');
  b += rect(330, y1 - 40, 112, 104, 'o p1', 2) + txt(386, y1 - 48, 'RSD-60G-5', 'ts') + txt(336, y1 - 6, '+Vin', 'tt', 'start') + txt(336, y1 + 50, '−Vin', 'tt', 'start') + txt(436, y1 - 6, '+V', 'tt', 'end') + txt(436, y1 + 50, '−V', 'tt', 'end');
  b += path(`M230 ${y1 + 60} L330 ${y1 + 50}`, 'wb');
  b += path(`M442 ${y1 - 10} L470 ${y1 - 10}`, 'wr thick2') + chip(470, y1 - 26, 62, 32, 'INA226', '0x40 · 2 mΩ');
  b += path(`M532 ${y1 - 10} C560 ${y1 - 10} 560 ${y1 + 84} 520 ${y1 + 100}`, 'wr thick2') + path(`M442 ${y1 + 46} C480 ${y1 + 50} 480 ${y1 + 110} 470 ${y1 + 120}`, 'wb thick2') + txt(566, y1 + 40, '2.5 mm²', 'tt', 'start');
  b += fuseBox(330, y1 + 96, 12, 200) + txt(430, y1 + 172, '12-way fuse box, 5 A per way', 'ts');
  // tablet charging branch
  b += path(`M214 ${y1 - 10} L214 ${y1 + 118} L290 ${y1 + 118} L290 ${y1 + 150} L270 ${y1 + 150}`, 'wr thin2') + rect(244, y1 + 144, 26, 12, 'o fuse', 2) + txt(257, y1 + 138, '3 A', 'tt');
  b += chip(150, y1 + 134, 80, 32, 'tablet charger', 'PD 65 W') + path(`M244 ${y1 + 150} L230 ${y1 + 150}`, 'wr thin2');
  b += path(`M150 ${y1 + 150} L110 ${y1 + 150}`, 'wd') + chip(50, y1 + 136, 60, 28, 'USB-C hub') + txt(80, y1 + 180, '→ DATA + Pi network', 'tt');
  b += ok(40, 24, 11) + txt(58, 29, 'red = +, black = −, a ferrule on every end; −Vin joined to −V (shared ground)', 'tl', 'start');
  b += no(40, 296, 11) + txt(58, 300, 'never swap + and −; STUSB4500 set to “output only above 5 V”', 'tl', 'start');
  return svg(640, 316, b, 'Power path: USB-C POWER, surge diode, USB-C power board, input current sensor, 5 A fuse, converter, output current sensor, fuse box; tablet charger off the fused input through 3 A');
}

// 20  First power-up with a small charger
export function step20() {
  let b = '';
  b += charger(24, 112, '20 W') + path('M70 132 C110 132 130 140 170 140', 'o thick nf');
  b += rect(170, 92, 24, 96, 'o p2') + circ(182, 140, 8, 'ringg') + txt(182, 204, 'POWER', 'tt');
  b += rect(220, 112, 40, 56, 'o p1', 2) + txt(240, 182, 'converter', 'tt') + path('M194 140 L220 140', 'wg');
  b += fuseBox(290, 110, 12, 160) + path('M260 124 L290 120', 'wr') + path('M260 156 L290 158', 'wb');
  b += multimeter(520, 92, '5.08') + path('M534 176 C520 210 470 190 470 120', 'wr') + path('M560 176 C580 220 480 220 476 158', 'wb');
  b += piBoard(320, 220, 56, 36) + no(390, 240, 10) + rect(428, 222, 70, 34, 'o p2m') + no(506, 240, 10) + txt(412, 280, 'Pi and modules not connected yet', 'ts');
  b += ok(40, 34, 12) + txt(60, 39, '5.0–5.2 V → next step', 'tl', 'start');
  b += no(270, 34, 12) + txt(290, 39, '0 V or −5 V → unplug, check + / −', 'tl', 'start');
  return svg(640, 296, b, 'First power-up with a small charger: the multimeter shows about 5.1 V at the fuse box');
}

// 21  LED power and data
export function step21() {
  let b = '';
  b += fuseBox(24, 132, 12, 200);
  ['1', '2', '3', '4', '5', '6', 'L', 'R', 'Pi', 'H', '·', '·'].forEach((l, i) => { b += txt(24 + 9 + i * 15.33 + 5, 200, l, 'tt'); });
  b += txt(124, 216, 'H = horn (way 10) · 11, 12 spare', 'tt');
  const mx = 300, my = 40, mw = 70, mh = 34;
  for (const [c, r, n] of [[0, 0, 1], [1, 0, 2], [2, 0, 3], [0, 1, 4], [1, 1, 5], [2, 1, 6]]) {
    const x = mx + c * (mw + 4), y = my + r * (mh + 4);
    b += rect(x, y, mw, mh, 'o p2m') + circ(x + mw / 2, y + mh / 2, 8, 'o p0') + txt(x + mw / 2, y + mh / 2 + 4, n, 'tn') + arrow([x + mw / 2 - 24, y + 8], [x + mw / 2 + 24, y + 8], 'ar', 6);
  }
  b += rect(252, 40, 22, 72, 'o p2m') + txt(263, 126, 'L', 'tb') + rect(534, 40, 22, 72, 'o p2m') + txt(545, 126, 'R', 'tb');
  b += rect(300, 200, 120, 64, 'o p1', 3) + txt(360, 280, 'bonnet on the Pi', 'ts');
  for (const [i, l] of [[0, '1'], [1, '2'], [2, '3']]) b += rect(312 + i * 34, 194, 26, 12, 'o dark thin') + txt(325 + i * 34, 190, l, 'tt');
  b += ribbon([325, 194], [296, 120], [304, 64]) + ribbon([359, 194], [340, 150], [338, 110]);
  b += ribbon([393, 194], [262, 190], [263, 104]) + ribbon([263, 40], [400, 6], [545, 40]);
  b += txt(440, 142, 'OUT 1 → module 1', 'tt', 'start') + txt(440, 154, 'OUT 2 → module 4', 'tt', 'start') + txt(440, 166, 'OUT 3 → L → R', 'tt', 'start');
  b += path('M41 132 C60 70 200 60 300 50', 'wr thin2') + path('M152 132 C170 110 220 90 252 80', 'wr thin2');
  b += txt(120, 70, 'each fuse → its panel (red + black)', 'tt halo');
  return svg(640, 296, b, 'Panel power through one 5 A fuse each; ribbon OUT 1 to the top row, OUT 2 to the bottom row, OUT 3 to the bench panels');
}

// 22  I²C parts and the horn
export function step22() {
  let b = '';
  b += piBoard(20, 40, 90, 60) + txt(65, 118, 'Pi 5 · pins 27 / 28', 'tt') + txt(65, 129, '(GPIO 0/1, tall header)', 'tt');
  b += path('M110 60 L600 60', 'wd') + path('M110 74 L600 74', 'wd dash') + txt(600, 54, 'SDA', 'tt', 'end') + txt(600, 88, 'SCL', 'tt', 'end');
  const dev = [['STUSB4500', '0x28'], ['SHT40', '0x44'], ['DS3231', '0x68'], ['INA226 in', '0x41'], ['INA226 out', '0x40'], ['MCP23017', '0x20']];
  dev.forEach(([n, a], i) => { const x = 140 + i * 78; b += ln([x + 32, 60], [x + 32, 108], 'o thin') + ln([x + 38, 74], [x + 38, 108], 'o thin') + chip(x, 108, 70, 34, n, a, i === 5 ? 'o p1' : 'o p0'); });
  // horn chain
  b += path('M565 142 L565 176 L470 176', 'wd') + txt(570, 168, 'GPA0', 'tt', 'start');
  b += chip(380, 160, 90, 34, 'MOSFET module', 'opto input') + path('M380 177 L300 177', 'wr');
  b += circ(270, 177, 22, 'o p2') + circ(270, 177, 8, 'o dark') + txt(270, 216, 'SFM-27, continuous', 'tt');
  b += path('M425 194 L425 226 L120 226', 'wr thin2') + rect(94, 220, 26, 12, 'o fuse', 2) + txt(107, 246, 'way 10 · 5 V', 'tt');
  b += lines(20, 274, ['i2cset -y &lt;bus&gt; 0x20 0x14 0x00    output latch low', 'i2cset -y &lt;bus&gt; 0x20 0x00 0x80    GPA0–6 = outputs', 'i2cset -y &lt;bus&gt; 0x20 0x14 0x01    horn on  ·  0x14 0x00  off'], 'tmono', 'start', 15);
  b += lines(390, 274, ['MCP23017: A0–A2 to GND, RESET to 3.3 V.', 'INA226 never at 0x44 (that is the SHT40).', 'DS3231: CR2032 in, charging resistor off.', 'Never a PCF8574 for the horn.'], 'ts', 'start', 15);
  return svg(640, 330, b, 'The I2C bus on pins 27 and 28 with the six chips and their addresses; the MCP23017 switches the horn MOSFET, which feeds the buzzer from fuse way 10');
}

// 23  The control screen
export function step23() {
  let b = '';
  const k = 0.9, O = [200, 300], Q = ([u, z]) => [O[0] + u * k, O[1] - (z - 70) * k], top = 292.5, bot = 87.5;
  b += poly(rp(Q, [[-6, 70], [0, 70], [0, bot], [-6, bot]]), 'o p1') + poly(rp(Q, [[-6, top], [0, top], [0, 320], [-6, 320]]), 'o p1');
  b += poly(rp(Q, [[-37, bot - 6], [-31, bot - 6], [-31, top + 6], [-37, top + 6]]), 'o p1');
  const piv = [-16, top - 8], rot = ([u, z]) => { const a = -45 * d2r, c = Math.cos(a), sn = Math.sin(a), du = u - piv[0], dz = z - piv[1]; return [piv[0] + du * c + dz * sn, piv[1] - du * sn + dz * c]; };
  b += poly(rp(Q, [[-28, top - 8], [-16, top - 8], [-16, top - 188], [-28, top - 188]].map(rot)), 'o p0') + poly(rp(Q, [[-16, top - 30], [-9, top - 30], [-9, top - 170], [-16, top - 170]].map(rot)), 'o dark');
  const h = Q(piv), sl = Q([-40, top - 30]), pi = [Q([-120, 90])[0], Q([-120, 90])[1]];
  b += path(`M${R(h[0] - 8)} ${R(h[1] + 6)} C${R(h[0] - 30)} ${R(h[1] + 40)} ${R(h[0] + 10)} ${R(h[1] + 50)} ${R(sl[0])} ${R(sl[1] + 30)} S ${R(pi[0] + 40)} ${R(pi[1] - 30)} ${R(pi[0] + 10)} ${R(pi[1])}`, 'rib0') + path(`M${R(h[0] - 8)} ${R(h[1] + 6)} C${R(h[0] - 30)} ${R(h[1] + 40)} ${R(h[0] + 10)} ${R(h[1] + 50)} ${R(sl[0])} ${R(sl[1] + 30)} S ${R(pi[0] + 40)} ${R(pi[1] - 30)} ${R(pi[0] + 10)} ${R(pi[1])}`, 'rib1');
  b += rect(pi[0] - 30, pi[1] - 4, 50, 14, 'o p1', 2) + txt(pi[0] - 5, pi[1] + 24, 'Pi 5 DSI port', 'tt');
  b += txt(h[0] + 18, h[1] - 8, 'loop at the hinge', 'tt', 'start') + txt(Q([96, 120])[0], Q([96, 120])[1], 'scorer →', 'ts', 'start');
  // flicker test
  const fx = 330;
  b += rect(fx, 60, 130, 44, 'o p2m') + rect(fx + 160, 60, 70, 44, 'o dark', 3) + txt(fx + 65, 120, '8 modules running', 'tt') + txt(fx + 195, 120, 'screen on', 'tt');
  b += ok(fx + 10, 160, 11) + txt(fx + 28, 164, 'no flicker on the modules → keep it', 'tl', 'start');
  b += no(fx + 10, 192, 11) + txt(fx + 28, 196, 'modules flicker → the screen stays out', 'tl', 'start');
  b += lines(fx, 232, ['300 mm standard–mini DSI cable (SC1132).', 'The LED driver needs one Pi core; this test', 'is still to be done: check before you rely on it.'], 'ts', 'start', 14);
  return svg(640, 310, b, 'The 10.1 inch screen on the open flap, the display ribbon with a loop at the hinge to the Pi, and the flicker test with all eight modules running');
}

// 24  Test
export function step24() {
  let b = '';
  b += rect(24, 70, 150, 150, 'o p0') + rect(54, 150, 60, 50, 'o dark');
  b += `<g transform="rotate(-24 54 150)">${rect(54, 100, 60, 50, 'o p1')}</g>`;
  b += path('M88 104 l10 0 l6 6 l0 16 l-16 0 Z', 'o p0') + arrow([96, 132], [96, 170], 'ar', 8) + txt(99, 240, 'the prepared SD card', 'ts');
  b += charger(208, 120, '65 W') + path('M231 167 C231 200 260 200 280 196', 'o thick nf');
  const P = proj(FRONT, 286, 236, 0.3);
  b += box(P, 0, 0, 0, 1020, 220, 380);
  const cols = ['#ffffff', '#ffd400', '#00e5ff', '#00e050', '#ff3df0', '#ff2a2a', '#2a5bff'];
  cols.forEach((c, i) => { b += `<polygon points="${P2(fFront(P, 30 + i * 960 / 7, 120, 960 / 7, 230, 0))}" fill="${c}" stroke="none"/>`; });
  b += poly(fFront(P, 30, 30, 960, 90, 0), 'o grad') + poly(fSide(P, 30, 30, 160, 320, 1020), 'o lit');
  b += clock(330, 40, '30 min') + ok(470, 40, 12) + txt(490, 45, 'warm is fine', 'tl', 'start');
  b += no(470, 270, 12) + txt(490, 275, 'hot or smelly → unplug', 'tl', 'start');
  return svg(640, 296, b, 'With the back panel off, put in the prepared SD card, power up with a laptop charger, run the test pattern for 30 minutes');
}

// 25  Close up
export function step25() {
  const P = proj(FRONT, 64, 318, 0.42); let b = '';
  b += poly(fSide(P, 6, 0, 214, 380, 1020), 'o p2') + poly(fTop(P, 0, 6, 1020, 214, 380), 'o p1');
  b += poly(fSide(P, 27, 30, 160, 320, 1020), 'o lit');
  b += poly(fFront(P, 6, 6, 1008, 368, 60), 'o p2m');
  b += hole(fFront(P, 0, 0, 1020, 380, 6), fFront(P, 6, 6, 1008, 368, 6), 'o p1');
  for (const [x, z] of [[6, 359], [495, 359], [999, 359]]) b += poly(fFront(P, x, z, 15, 15, 6), 'o p1');
  b += poly(fFront(P, 6, 6, 1008, 15, 6), 'o p1');
  const by = -230;
  b += poly(fSide(P, by, 0, 6, 380, 1020), 'o p2') + poly(fTop(P, 0, by, 1020, 6, 380), 'o p1') + poly(fFront(P, 0, 0, 1020, 380, by), 'o p0');
  const F = (x, z) => P(x, by, z);
  b += poly(fFront(P, 370, 87.5, 280, 205, by), 'o dark') + poly(fFront(P, 380, 105, 260, 180, by - 0.1), 'o p1');
  for (let i = 0; i < 8; i++) b += poly(fFront(P, 300 + i * 55, 345, 40, 8, by), 'o dark thin');
  const hp = F(890, 310); b += circ(hp[0], hp[1], 6, 'o p2');
  for (const [x, cls, l, a, dx] of [[60, 'ringb', 'DATA', 'end', -3], [120, 'ringg', 'POWER', 'start', 3]]) { const p = F(x, 40); b += circ(p[0], p[1], 6, cls) + txt(p[0] + dx, p[1] - 9, l, 'tt', a); }
  for (const [x, z] of [[14, 14], [510, 14], [1006, 14], [14, 366], [510, 366], [1006, 366]]) { const k = F(x, z); b += torx(k[0], k[1], 5.5); }
  b += arrow(P(220, by + 10, -10), P(220, -10, -10)) + arrow(P(840, by + 10, -10), P(840, -10, -10));
  b += wbadge(22, 160, 'B');
  b += mag(560, 150, 48, F(1006, 366), (() => {
    let g = rect(512, 150, 96, 12, 'o p0') + rect(540, 162, 40, 30, 'o p1') + rect(552, 120, 16, 30, 'o p2');
    for (let i = 0; i < 6; i++) g += ln([552, 124 + i * 4.5], [568, 126 + i * 4.5], 'o thin');
    g += path('M536 121 Q536 101 560 101 Q584 101 584 121 Z', 'o p1') + torx(560, 112, 7);
    return g;
  })());
  b += count(60, 40, '×6') + txt(88, 39, 'T20 3.5 × 16 into the batten and blocks', 'ts', 'start');
  b += lines(64, 380, ['EPDM D-seal round B’s rim, dust caps on the USB-C sockets.', 'Inside B: fuse map, spare fuses, spare SD. Lettering and the back label after first light.'], 'ts', 'start', 14);
  return svg(640, 410, b, 'Put the back panel with the screen flap on and drive in six T20 screws into the blocks');
}

// side silhouette of the box for the set-up drawing: front frame tilted, flap, foot
function silhouette(X0, Y0, k, deg, flap, foot) {
  const S = SV(X0, Y0, k); let b = '';
  b += poly(rp(S, [[0, 0], [220, 0], [220, 380], [0, 380]]), 'o p0');
  b += poly(rp(S, [[0, 7], [6, 7], [6, 373], [0, 373]].map(p => rotA(p, deg))), 'o gl');
  if (deg) b += poly(rp(S, [rotA([6, 373], deg), rotA([6, 7], deg), [0, 7], [0, 373]]), 'o p1');
  if (foot) b += poly(rp(S, [[70 + 120, -15], [220 + 120, -15], [220 + 120, -9], [70 + 120, -9]]), 'o p1');
  b += poly(rp(S, [[10, -21], [214, -21], [214, 0], [10, 0]]), 'o p2');
  if (flap) {
    const piv = [220 - 16, 284.5], a = 45 * d2r, e = [piv[0] + 180 * Math.sin(a), piv[1] - 180 * Math.cos(a)];
    b += ln(S(piv), S(e), 'o thick2') + ln(S([piv[0] + 8, piv[1] - 4]), S([e[0] + 8 * Math.cos(a), e[1] - 4]), 'o thin');
  }
  return b;
}
// 26  Set it up
export function step26() {
  let b = '';
  const k = 0.42;
  b += rect(16, 230, 300, 8, 'o p1') + rect(40, 238, 8, 30, 'o p2') + rect(282, 238, 8, 30, 'o p2');
  b += silhouette(110, 230 - 21 * k, k, 15, true, true);
  b += arrow([96, 120], [30, 104], 'ar', 9) + txt(28, 92, '1st referee', 'ts', 'start') + arrow([248, 120], [304, 96], 'ar', 9) + txt(306, 90, 'scorer', 'ts', 'end');
  b += txt(166, 262, 'table: front 15°, flap open, foot out', 'tl');
  // speaker stand
  const S2 = 0.2, sx = 380;
  b += silhouette(sx, 140, S2, 0, false, false) + rect(sx + 110 * S2 - 3, 144, 6, 90, 'o p2') + ln([sx + 22, 234], [sx - 20, 280], 'o thick') + ln([sx + 22, 234], [sx + 64, 280], 'o thick');
  b += txt(sx + 22, 298, 'speaker stand · 35 mm', 'tt');
  const tx = 520;
  b += silhouette(tx, 140, S2, 0, false, false) + rect(tx + 14, 144, 16, 8, 'o p2') + ln([tx + 22, 152], [tx - 22, 280], 'o thick') + ln([tx + 22, 152], [tx + 66, 280], 'o thick');
  b += txt(tx + 22, 298, 'tripod · ¼″ or ⅜″', 'tt');
  b += circ(36, 320, 8, 'ringg') + txt(52, 324, 'POWER ← any USB-C charger, 18–100 W (65 W+ for full brightness)', 'tl', 'start');
  b += circ(36, 346, 8, 'ringb') + txt(52, 350, 'DATA ← tablet: scores + charging, no PIN on the cable', 'tl', 'start');
  return svg(640, 366, b, 'Set-ups: on a table with the front tilted 15 degrees toward the first referee, the flap open for the scorer and the foot pulled out; on a speaker stand; on a tripod');
}

// 27  Open it
export function step27() {
  const P = proj(FRONT, 70, 272, 0.4); let b = '';
  b += poly(fSide(P, 6, 0, 214, 380, 1020), 'o p2') + poly(fTop(P, 0, 6, 1020, 214, 380), 'o p1');
  b += poly(fFront(P, 6, 6, 1008, 368, 200), 'o p2m') + poly(fTop(P, 6, 6, 1008, 194, 6), 'o p1');
  b += poly(fFront(P, 30, 6, 400, 200, 64), 'o al');
  b += poly(fFront(P, 44, 110, 85, 70, 40), 'o p1') + poly(fFront(P, 180, 120, 88, 60, 50), 'o p0') + poly(fFront(P, 290, 110, 128, 80, 50), 'o p0');
  for (let i = 0; i < 12; i++) b += poly(fFront(P, 296 + i * 9.8, 125, 6, 45, 49), 'o fuse thin');
  b += poly(fFront(P, 180, 30, 100, 62, 34), 'o p1') + poly(fFront(P, 44, 30, 100, 62, 44), 'o p0');
  b += hole(fFront(P, 0, 0, 1020, 380, 6), fFront(P, 6, 6, 1008, 368, 6), 'o p1');
  const lf = P(354, 40, 200), lp = P(86, 40, 190), lc = P(230, 34, 96);
  b += txt(lf[0], lf[1] - 6, 'fuses', 'tt halo') + txt(lp[0], lp[1] - 6, 'Pi + SD', 'tt halo') + txt(lc[0], lc[1] - 6, 'converter', 'tt halo');
  for (const [x, z] of [[14, 14], [510, 14], [1006, 14], [14, 366], [510, 366], [1006, 366]]) { const k = P(x, 6, z); b += torx(k[0], k[1], 4.5); }
  const dx = 470, dy = 164;
  b += arrow([430, 138], [470, 168]);
  b += rect(dx, dy, 160, 64, 'o p0') + rect(dx + 8, dy + 8, 70, 30, 'o p1 thin') + rect(dx + 100, dy + 6, 52, 40, 'o dark', 2);
  ['1', '2', '3', '4', '5', '6', 'L', 'R', 'Pi', 'H'].forEach((l, i) => { b += txt(dx + 13 + (i % 5) * 14, dy + 19 + Math.floor(i / 5) * 13, l, 'tt'); });
  b += txt(dx + 43, dy + 54, 'fuse map', 'tt') + txt(dx + 126, dy + 58, 'pocket', 'tt') + txt(dx + 80, dy + 82, 'inside of the back panel', 'ts');
  b += ok(40, 34, 12) + txt(60, 39, 'T20 key: six screws, lift off, unplug the screen ribbon', 'tl', 'start');
  return svg(640, 280, b, 'Open the box: undo six T20 screws, lift the back panel off and unplug the screen ribbon; the back carries the fuse map, spare fuses and a spare SD card');
}

export function poster() {
  const P = proj(FRONT, 48, 340, 0.52); let b = '';
  b += poly(fSide(P, 0, 0, 220, 380, 1020), 'po-s') + poly(fTop(P, 0, 0, 1020, 220, 380), 'po-t') + poly(fFront(P, 0, 0, 1020, 380, 0), 'po-f');
  b += poly(fFront(P, 30, 30, 960, 320, 0), 'po-scr') + poly(fSide(P, 27, 30, 160, 320, 1020), 'po-scr');
  const l = P(200, 0, 90), r = P(820, 0, 90), s = P(510, 0, 250), n1 = P(40, 0, 300), n2 = P(980, 0, 300);
  b += txt(l[0], l[1], '18', 'pled pled-b') + txt(r[0], r[1], '16', 'pled pled-o') + txt(s[0], s[1], '2 · 1', 'pleds');
  b += txt(n1[0], n1[1], 'WIEDIKON', 'pledn pled-b', 'start') + txt(n2[0], n2[1], 'VOLZ', 'pledn pled-o', 'end');
  for (const hx of G.handle.x) b += poly(fTop(P, hx - 64.5, 134, 129, 52, 380), 'po-scr');
  return svg(640, 372, b, 'Point Hub board, front view with a match score');
}

// ---- steps added for the first-light test, the tray, the lights and the covers ---------
// First light: one module, before anything is cut
export function stepLight() {
  let b = '';
  // powerbank with its 12 V car socket
  b += rect(16, 104, 96, 76, 'o p1', 6) + txt(64, 132, 'powerbank', 'ts') + circ(64, 156, 11, 'o dark') + txt(64, 196, '12 V car socket', 'tt');
  b += path('M64 156 C90 228 130 150 182 132', 'wr') + path('M64 156 C96 240 130 170 182 164', 'wb');
  // converter with its screw terminals
  b += rect(182, 104, 112, 84, 'o p1', 2) + txt(238, 96, 'Mean Well RSD-60G-5', 'tt');
  b += txt(190, 135, '+Vin', 'tt', 'start') + txt(190, 167, '−Vin', 'tt', 'start') + txt(286, 135, '+V', 'tt', 'end') + txt(286, 167, '−V', 'tt', 'end');
  b += multimeter(304, 22, '5.08') + path('M318 106 C318 122 300 124 294 132', 'wr thin2') + path('M344 106 C344 150 310 160 294 164', 'wb thin2');
  // the module, seen from behind
  b += rect(424, 60, 192, 96, 'o p2m', 2) + rect(440, 92, 28, 22, 'o p0 thin') + txt(454, 106, 'IN', 'tt') + rect(572, 92, 28, 22, 'o p0 thin') + txt(586, 106, 'OUT', 'tt');
  b += rect(506, 72, 28, 16, 'o p0 thin') + txt(520, 83, '5 V', 'tt') + txt(520, 50, 'one LED module, LEDs away from you', 'ts');
  b += path('M294 132 C360 176 450 150 512 88', 'wr thin2') + path('M294 164 C370 200 470 160 528 88', 'wb thin2');
  // Pi and bonnet
  b += piBoard(250, 222, 96, 58) + rect(262, 212, 72, 44, 'o gh') + txt(298, 238, 'bonnet', 'tt') + txt(298, 296, 'Pi 5 + cooler + tall header', 'tt');
  b += ribbon([334, 228], [430, 240], [454, 114]);
  b += txt(362, 276, 'ribbon: OUT 1 → IN', 'tt', 'start');
  b += charger(120, 228, 'Pi'); b += path('M143 275 C160 290 210 280 250 262', 'o thick nf');
  // result
  b += ok(466, 212, 11) + lines(484, 208, ['Clean, stable picture:', 'go on and cut the wood.'], 'tl', 'start', 15);
  b += no(466, 262, 11) + lines(484, 258, ['Scrambled or flickering:', 'stop. Try the fallback first.'], 'tl', 'start', 15);
  b += ok(28, 42, 11) + lines(46, 38, ['Measure first: about 12 V in,', '5.0–5.2 V out. Then plug in', 'the module.'], 'ts', 'start', 14);
  return svg(640, 312, b, 'First light on the bench: powerbank 12 V into the Mean Well converter, 5 V to one LED module, the Pi 5 with the bonnet on its own USB-C supply, ribbon from output 1 to the module');
}

// Build the tray: upright, behind K's path
export function stepTray() {
  let b = '';
  // left: the tray as it stands, seen from the back panel side, to scale
  const s = 0.84, tx = 16, ty = 40, X = x => tx + x * s, Z = z => ty + (200 - z) * s;
  const part = (x, z, w, h, l1, l2, cls) => chip(X(x), Z(z + h), w * s, h * s, l1, l2, cls);
  b += txt(tx, 24, 'the tray: 400 × 200, 2 mm aluminium, seen from the back', 'ts', 'start');
  b += rect(tx, ty, 400 * s, 200 * s, 'o al', 2);
  for (const [x, z] of [[8, 8], [392, 8], [8, 192], [392, 192]]) b += circ(X(x), Z(z), 3, 'o p0');
  // top row: Pi + bonnet, fuse box. Ribbons go over the top edge
  b += rect(X(16), Z(190), 85 * s, 56 * s, 'o p1', 2) + rect(X(22), Z(186), 62 * s, 46 * s, 'o gh') + txt(X(53), Z(160), 'Pi + bonnet', 'tt');
  for (const [x, z] of [[20, 186], [78, 186], [20, 138], [78, 138]]) b += circ(X(x), Z(z), 1.5, 'ah');
  b += rect(X(120), Z(190), 160 * s, 58 * s, 'o p0', 2);
  for (let i = 0; i < 12; i++) b += rect(X(127) + i * 10.8, Z(182), 7, 28, 'o fuse thin', 1);
  b += txt(X(200), Z(182) + 40, 'fuse box', 'tt');
  // middle row
  b += part(14, 64, 128, 52, 'RSD-60G-5', '', 'o p1') + part(150, 66, 60, 44, 'charger') + part(220, 66, 60, 44, 'hub') + part(290, 66, 40, 36, 'SHT40');
  // bottom row
  b += part(14, 14, 60, 38, 'STUSB4500') + part(82, 14, 42, 38, 'INA', '0x41') + part(130, 14, 42, 38, 'INA', '0x40') + part(180, 14, 54, 38, 'MCP23017') + part(240, 14, 50, 38, 'MOSFET') + part(296, 14, 40, 38, 'RTC');
  b += txt(X(367), Z(120), 'flat', 'tt') + txt(X(367), Z(120) + 10, 'parts', 'tt') + txt(X(367), Z(120) + 20, 'only', 'tt');
  // standoff detail
  const dx = 16, dy = 226;
  b += rect(dx, dy + 40, 150, 5, 'o al') + txt(dx + 158, dy + 46, '2 mm tray', 'tt', 'start');
  b += rect(dx + 40, dy + 8, 70, 4, 'o p2') + txt(dx + 118, dy + 13, 'board', 'tt', 'start');
  for (const x of [50, 92]) { b += rect(dx + x, dy + 12, 8, 28, 'o gl') + rect(dx + x - 2, dy + 45, 12, 4, 'o p2'); }
  b += arrow([dx + 25, dy + 12], [dx + 25, dy + 40], 'ar', 7) + txt(dx + 25, dy + 3, '10 mm', 'tt');
  b += ok(dx + 8, dy + 68, 9) + txt(dx + 24, dy + 72, 'Ø2.7 for M2.5, Ø3.2 for M3, deburr. No joint touches the metal.', 'ts', 'start');
  b += ok(dx + 8, dy + 90, 9) + txt(dx + 24, dy + 94, 'Converter and fuse box flat on the aluminium: it cools them.', 'ts', 'start');
  // right: side section to scale, why it stands up
  const S = SV(372, 322, 0.68);
  b += txt(372, 28, 'side view, to scale', 'ts', 'start');
  b += shellSide(S) + frameSide(S, 0) + capSide(S, 0, 'o p2', G.K);
  const t0 = S([150, 6]), t1 = S([150, 206]), tb = S([165, 6]), tt = S([150, 374]);
  b += rect(t1[0] - 1, t1[1], 2.4, t0[1] - t1[1], 'o al');
  b += rect(t0[0] + 2, tt[1], 15 * 0.68, t0[1] - tt[1], 'o gh');
  b += rect(S([168, 0])[0], S([0, 180])[1], 40 * 0.68, 60 * 0.68, 'o p1') ;
  const lab = S([190, 150]);
  b += txt(lab[0] + 22, lab[1] - 20, 'parts', 'tt', 'start');
  const k0 = S([6, 6]), k1 = S([146, 6]);
  b += txt((k0[0] + k1[0]) / 2, k0[1] + 16, 'K, 140', 'tt') + wbadge(S([220, 0])[0] + 16, S([0, 300])[1], 'B');
  const tl = S([136, 250]); b += txt(tl[0], tl[1], 'tray + post', 'tt halo', 'end') + arrow([tl[0] + 3, tl[1] - 3], [t1[0] - 2, tl[1] - 3], 'ar', 7);
  return svg(640, 346, b, 'The electronics tray: all parts on standoffs on one aluminium sheet, which stands upright on two posts just behind the bottom cap K, with the parts facing the removable back panel');
}

// Power button and status lights
export function stepLights() {
  let b = '';
  // the back panel, bottom left corner, as seen from outside
  b += txt(16, 26, 'back panel B, seen from outside', 'ts', 'start');
  b += rect(16, 38, 296, 100, 'o p0');
  const hole = (x, r, cls = 'o dark') => circ(x, 88, r, cls);
  b += circ(52, 88, 13, 'ringb') + rect(46, 85, 12, 6, 'o dark thin', 1) + txt(52, 122, 'DATA', 'tt');
  b += circ(96, 88, 13, 'ringg') + rect(90, 85, 12, 6, 'o dark thin', 1) + txt(96, 122, 'POWER', 'tt');
  b += `<circle cx="146" cy="88" r="17" fill="none" stroke="#21c45d" stroke-width="3.5"/>` + circ(146, 88, 12, 'o p1') + txt(146, 122, 'button Ø16', 'tt');
  b += `<circle cx="198" cy="88" r="9" fill="#21c45d" stroke="var(--ink)"/>` + txt(198, 122, 'STATUS Ø8', 'tt');
  b += `<circle cx="248" cy="88" r="9" fill="#2a7bff" stroke="var(--ink)"/>` + txt(248, 122, 'LINK Ø8', 'tt');
  b += lines(16, 158, ['The button’s green ring is the POWER light.', 'Hold the button 2 s: the Pi shuts down, then unplug.'], 'ts', 'start', 15);
  // wiring on the right
  b += chip(334, 44, 84, 58, 'MCP23017', '0x20', 'o p1');
  const led = (y, name, a, c) => {
    let g = '';
    [['150 Ω', '#ff4a3d'], ['47 Ω', '#21c45d'], ['47 Ω', '#2a7bff']].forEach(([r, col], i) => {
      const yy = y + i * 14;
      g += `<path d="M418 ${yy} L498 ${yy}" stroke="${col}" stroke-width="2" fill="none"/>` + rect(446, yy - 4, 26, 8, 'o p0 thin') + txt(459, yy + 3, r, 'tt');
    });
    g += txt(424, y - 6, a, 'tt', 'start') + circ(516, y + 14, 12, 'o p0') + txt(536, y + 18, name, 'tlb', 'start');
    return g;
  };
  b += led(40, 'STATUS', 'GPA1–3');
  b += led(92, 'LINK', 'GPA4–6');
  b += path('M376 102 L376 150', 'wd') + txt(382, 134, 'GPA0 → horn', 'tt', 'start');
  // the button's two pairs
  b += circ(400, 200, 22, 'o p1') + `<circle cx="400" cy="200" r="27" fill="none" stroke="#21c45d" stroke-width="3"/>`;
  b += path('M422 188 L520 188', 'wd') + path('M422 200 L520 200', 'wd') + piBoard(520, 170, 70, 46) + txt(555, 232, 'Pi 5 J2 pads', 'tt');
  b += path('M378 188 L296 188', 'wr thin2') + path('M378 212 L296 212', 'wb thin2') + txt(290, 192, 'ring + : 5 V', 'tt', 'end') + txt(290, 216, 'ring − : GND', 'tt', 'end');
  // colour code
  const y0 = 262, dot = (x, y, f) => `<circle cx="${x}" cy="${y}" r="6" fill="${f}" stroke="var(--ink)" stroke-width=".8"/>`;
  b += txt(16, y0 - 16, 'what they say', 'tlb', 'start');
  [['#21c45d', 'POWER ring on', 'power is there'], ['#e9b800', 'STATUS yellow, blinking', 'starting'], ['#21c45d', 'STATUS green', 'ready'], ['#ff4a3d', 'STATUS red, blinking', 'error: read the screen']].forEach(([f, t, m], i) => { b += dot(24, y0 + i * 18, f) + txt(36, y0 + 4 + i * 18, `${t}: ${m}`, 'ts', 'start'); });
  [['#2a7bff', 'LINK blue', 'tablet on the cable'], ['#e9b800', 'LINK yellow', 'Wi-Fi, no internet'], ['#21c45d', 'LINK green', 'online'], ['#ff4a3d', 'LINK red, blinking', 'live results failing']].forEach(([f, t, m], i) => { b += dot(344, y0 + i * 18, f) + txt(356, y0 + 4 + i * 18, `${t}: ${m}`, 'ts', 'start'); });
  return svg(640, 340, b, 'The back panel with the DATA and POWER sockets, the 16 mm power button with its green ring and the STATUS and LINK lights; how each is wired; what the colours mean');
}

// Sink the magnets and washers: before the paint
export function stepCoverHoles() {
  let b = '';
  // section at a magnet, 12 px per mm
  const k = 11, x0 = 26, y0 = 62, W = 270;
  b += txt(16, 26, 'section at one magnet (enlarged, to scale)', 'ts', 'start');
  // cover, 3 mm, washer pocket 1 mm
  b += rect(x0, y0, W, 3 * k, 'o p0') ;
  const cx = x0 + W / 2, wr = 7.5 * k, mr = 4 * k;
  b += rect(cx - wr, y0 + 2 * k, 2 * wr, 1 * k, 'o p2');
  b += txt(x0 + W + 8, y0 + 12, 'cover, 3 mm', 'tt', 'start') + txt(x0 + W + 8, y0 + 28, 'M5 washer, sunk 1 mm', 'tt', 'start');
  // felt
  b += rect(x0, y0 + 3 * k, W, 0.9 * k, 'o dark') + txt(x0 + W + 8, y0 + 3 * k + 9, 'felt, 0.8–1 mm', 'tt', 'start');
  // box border, 6 mm with magnet pocket 3 mm
  const yb = y0 + 3.9 * k;
  b += rect(x0, yb, W, 6 * k, 'o p1') + rect(cx - mr, yb, 2 * mr, 3 * k, 'o gl');
  b += txt(cx, yb + 3 * k - 10, 'N48 magnet', 'tt halo') + txt(x0 + W + 8, yb + 34, 'box border, 6 mm', 'tt', 'start') + txt(x0 + W + 8, yb + 18, 'magnet Ø8 × 3, flush', 'tt', 'start');
  // how
  b += ok(26, 208, 9) + txt(42, 212, 'Forstner bit. A spade bit’s spur goes right through 3 mm.', 'ts', 'start');
  b += ok(26, 232, 9) + txt(42, 236, 'Tape on the bit as a depth stop: 3 mm in the box, 1 mm in the cover.', 'ts', 'start');
  b += ok(26, 256, 9) + txt(42, 260, 'Drill before the paint; glue magnets and washers in after it.', 'ts', 'start');
  b += ok(26, 280, 9) + txt(42, 284, 'Marking the covers: a dab of paint on each magnet, press the cover on.', 'ts', 'start');
  // layout on the right
  const s = 0.2, fx = 448, fy = 30, dot = (x, y) => circ(x, y, 3, 'ah');
  b += txt(fx, 22, 'front A: 8 magnets', 'ts', 'start');
  b += rect(fx, fy, 1004 * s, 366 * s, 'o p0') + rect(fx + 22 * s, fy + 23 * s, 960 * s, 320 * s, 'o hatchf');
  for (const [x, y] of [[11, 11.5], [502, 11.5], [993, 11.5], [11, 183], [993, 183], [11, 354.5], [502, 354.5], [993, 354.5]]) b += dot(fx + x * s, fy + y * s);
  const ey = 134;
  b += txt(fx, ey - 8, 'each end D: 4', 'ts', 'start');
  b += rect(fx, ey, 214 * s, 368 * s, 'o p0') + rect(fx + 27 * s, ey + 24 * s, 160 * s, 320 * s, 'o hatchf');
  for (const [x, y] of [[13, 12], [201, 12], [13, 356], [201, 356]]) b += dot(fx + x * s, ey + y * s);
  const lx = fx + 88;
  b += txt(lx, ey - 8, 'flap lid: 4', 'ts', 'start');
  b += rect(lx, ey, 300 * s, 225 * s, 'o p0') + rect(lx + 10 * s, ey + 10 * s, 280 * s, 205 * s, 'o hatchf');
  for (const [x, y] of [[5, 5], [295, 5], [5, 220], [295, 220]]) b += dot(lx + x * s, ey + y * s);
  b += lines(lx, ey + 62, ['Only 10 mm border:', 'smaller washers,', 'in the corners.', 'Check at dry fit.'], 'tt', 'start', 12);
  b += txt(fx, ey + 124, '20 magnets in all', 'tlb', 'start');
  return svg(640, 300, b, 'Section through a transport cover at one magnet: magnet sunk into the 6 mm box border, washer sunk into the 3 mm cover, thin felt between; where the 20 magnets go');
}

// Covers on, bag
export function stepCovers() {
  const P = proj(FRONT, 84, 226, 0.32); let b = '';
  b += box(P, 0, 0, 0, 1020, 220, 380);
  b += poly(fFront(P, 30, 30, 960, 320, 0), 'o gl');
  // front cover coming on, end cover from the side
  const by = -120;
  b += poly(fFront(P, 0, 0, 1020, 380, by), 'o gh') + txt(P(510, by, 200)[0], P(510, by, 200)[1], 'front cover', 'tlb');
  b += arrow(P(180, by + 6, 60), P(180, -6, 60)) + arrow(P(860, by + 6, 320), P(860, -6, 320));
  const ex = 1120;
  b += poly(fSide(P, 0, 0, 220, 380, ex), 'o gh') + arrow(P(ex - 6, 110, 190), P(1026, 110, 190));
  const e = P(ex + 20, 110, 400); b += txt(e[0], e[1] - 2, 'end cover ×2', 'tt');
  b += ok(44, 28, 10) + txt(60, 33, 'Four covers snap on with the magnets. All lie inside the bag.', 'tl', 'start');
  // the lid, small back view
  const lx = 28, ly = 248, s = 0.14;
  b += rect(lx, ly, 1020 * s, 380 * s, 'o p0') + rect(lx + 360 * s, ly + 77 * s, 300 * s, 225 * s, 'o gh') + txt(lx + 510 * s, ly + 196 * s, 'lid', 'tt');
  b += txt(lx + 510 * s, ly + 380 * s + 13, 'back: lid over the flap', 'tt');
  // the bag
  const bx = 268, bY = 246;
  b += path(`M${bx} ${bY + 12} Q${bx} ${bY} ${bx + 12} ${bY} L${bx + 200} ${bY} Q${bx + 212} ${bY} ${bx + 212} ${bY + 12} L${bx + 212} ${bY + 72} Q${bx + 212} ${bY + 84} ${bx + 200} ${bY + 84} L${bx + 12} ${bY + 84} Q${bx} ${bY + 84} ${bx} ${bY + 72} Z`, 'o p1');
  b += path(`M${bx + 70} ${bY} C${bx + 74} ${bY - 26} ${bx + 138} ${bY - 26} ${bx + 142} ${bY}`, 'o thick nf');
  b += path(`M${bx + 8} ${bY + 10} L${bx + 204} ${bY + 10}`, 'o dash') + rect(bx + 66, bY + 34, 80, 36, 'o p2', 3) + txt(bx + 106, bY + 56, 'pocket', 'tt');
  b += lines(bx + 226, bY + 8, ['custom padded bag', '104 × 40 × 24 cm inside', '15–20 mm padding, 600D', 'zip on 3 sides, handles', '+ shoulder strap'], 'ts', 'start', 14);
  return svg(640, 346, b, 'The four transport covers go on with magnets: front, two ends, and a lid over the flap; then the whole box goes into a custom padded bag');
}

// ---- inventory icons (120 x 80) ------------------------------------------
const I = (b) => `<svg class="ico" viewBox="0 0 120 80" aria-hidden="true">${b}</svg>`;
const ply = (x, y, w, h) => rect(x, y, w, h, 'o p0');
export const icons = {
  A: I(hole([[10, 18], [110, 18], [110, 56], [10, 56]], [[13, 21], [107, 21], [107, 53], [13, 53]], 'o p0')),
  B: I(hole([[10, 18], [110, 18], [110, 56], [10, 56]], [[46, 26], [74, 26], [74, 48], [46, 48]], 'o p0') + circ(18, 51, 2.5, 'ringg') + circ(25, 51, 2.5, 'ringb')),
  C: I(ply(8, 26, 100, 20) + ply(14, 34, 100, 20) + rect(28, 40, 14, 6, 'o dark') + rect(80, 40, 14, 6, 'o dark')),
  D: I(hole([[46, 6], [74, 6], [74, 74], [46, 74]], [[50, 10], [70, 10], [70, 70], [50, 70]], 'o p0')),
  F: I(ply(30, 20, 56, 38) + ply(36, 26, 56, 38)),
  P: I(rect(28, 16, 64, 48, 'o p1') + rect(34, 22, 52, 36, 'o p2') + ply(28, 16, 64, 6) + ply(28, 58, 64, 6)),
  K: I(path('M10 52 L110 52 L100 36 L20 36 Z', 'o p0') + rect(10, 52, 100, 4, 'o p2')),
  H: I(poly([[40, 10], [40, 70], [64, 66]], 'o p0') + poly([[70, 10], [70, 70], [94, 66]], 'o p0')),
  Y: I(ply(26, 24, 30, 40) + ply(30, 20, 30, 40) + ply(64, 24, 30, 40) + ply(68, 20, 30, 40)),
  T: I(path('M14 50 L84 50 L106 34 L36 34 Z', 'o p0') + path('M14 50 L14 54 L84 54 L106 38 L106 34 L84 50', 'o p2')),
  spare: I(ply(24, 18, 72, 46)),
  batten: I(`<g transform="rotate(-12 60 40)">${rect(8, 26, 104, 8, 'o p1')}${rect(8, 40, 104, 8, 'o p1')}</g>`),
  bars: I(rect(8, 22, 104, 7, 'o al') + rect(8, 36, 104, 7, 'o al') + rect(8, 50, 104, 7, 'o al')),
  pc: I(rect(14, 16, 74, 44, 'o pc') + ln([30, 22], [44, 54], 'glare') + rect(94, 18, 14, 40, 'o pc')),
  piano: I(rect(8, 30, 104, 9, 'o al') + rect(8, 39, 104, 9, 'o al') + Array.from({ length: 13 }, (_, i) => ln([12 + i * 8, 30], [12 + i * 8, 48], 'o thin')).join('')),
  stay: I(rect(10, 30, 100, 16, 'o al') + circ(18, 38, 2.5, 'o p0') + [44, 60, 76, 92].map(x => circ(x, 40, 3, 'o p0') + rect(x - 3, 40, 6, 6, 'o p0')).join('')),
  pin: I(rect(28, 34, 60, 10, 'o al') + path('M20 30 L28 30 L28 48 L20 48 Z', 'o p2') + rect(88, 31, 10, 16, 'o p2', 2)),
  torque: I(rect(22, 22, 32, 36, 'o p1', 3) + rect(66, 22, 32, 36, 'o p1', 3) + rect(54, 30, 12, 20, 'o p2', 4) + torx(38, 40, 4) + torx(82, 40, 4)),
  catch: I(rect(32, 26, 54, 28, 'o p1', 3) + rect(40, 32, 38, 16, 'o p0', 2) + circ(59, 40, 4, 'o dark')),
  handle: I(rect(10, 20, 100, 44, 'o p2', 5) + rect(20, 30, 80, 24, 'o dark') + rect(26, 36, 68, 10, 'o p1', 5)),
  pads: I(Array.from({ length: 4 }, (_, i) => rect(14 + i * 25, 30, 18, 18, 'o pc', 3)).join('')),
  caps: I(path('M40 30 L70 30 L70 60 L40 60 Z', 'o dark') + path('M70 30 L84 20 L84 50 L70 60 Z', 'o dark') + path('M40 30 L54 20 L84 20 L70 30 Z', 'o p2')),
  turn: I(rect(26, 32, 50, 16, 'o p1', 8) + screw(38, 40, 3) + carrow([78, 22], [100, 30], [92, 56], 'ar', 7)),
  stand: I(rect(36, 16, 48, 48, 'o p1', 6) + circ(60, 40, 14, 'o p2') + torx(44, 24, 3) + torx(76, 24, 3) + torx(44, 56, 3) + torx(76, 56, 3)),
  inserts: I(rect(30, 22, 18, 34, 'o p2', 2) + rect(66, 18, 24, 40, 'o p2', 2) + Array.from({ length: 5 }, (_, i) => ln([30, 28 + i * 6], [48, 30 + i * 6], 'o thin') + ln([66, 25 + i * 7], [90, 27 + i * 7], 'o thin')).join('')),
  module: I(rect(14, 20, 92, 46, 'o screen') + rect(16, 22, 88, 42, 'dotsf')),
  magnet: I(circ(40, 40, 14, 'o al') + circ(40, 40, 6, 'o p2') + rect(64, 34, 34, 12, 'o al')),
  screen: I(rect(14, 14, 92, 56, 'o dark', 4) + rect(20, 20, 80, 44, 'o p2m', 2) + rect(54, 70, 12, 6, 'o p1')),
  dsi: I(path('M14 52 C40 52 40 26 70 26 L104 26', 'rib0') + path('M14 52 C40 52 40 26 70 26 L104 26', 'rib1')),
  pi: I(piBoard(20, 16, 72, 48) + rect(36, 26, 30, 24, 'o p2', 2)),
  bonnet: I(rect(20, 22, 80, 40, 'o p0', 3) + rect(28, 28, 18, 9, 'o dark thin') + rect(51, 28, 18, 9, 'o dark thin') + rect(74, 28, 18, 9, 'o dark thin') + txt(60, 54, '1   2   3', 'tt')),
  header: I(rect(14, 34, 92, 10, 'o dark') + Array.from({ length: 20 }, (_, i) => ln([18 + i * 4.4, 30], [18 + i * 4.4, 48], 'o thin')).join('')),
  sd: I(path('M46 20 L70 20 L76 26 L76 62 L46 62 Z', 'o p0') + rect(50, 24, 4, 8, 'o p2 thin') + rect(57, 24, 4, 8, 'o p2 thin')),
  conv: I(rect(24, 18, 72, 46, 'o p1', 2) + rect(24, 18, 10, 46, 'o p2') + Array.from({ length: 4 }, (_, i) => circ(48 + i * 12, 40, 2, 'o p2 thin')).join('')),
  pd: I(rect(40, 24, 40, 32, 'o p0', 2) + rect(35, 34, 12, 10, 'o dark thin', 2) + rect(72, 30, 6, 6, 'o p1 thin') + rect(72, 42, 6, 6, 'o p1 thin')),
  ext: I(rect(12, 32, 16, 16, 'o p1', 2) + path('M28 40 C60 40 60 30 92 30', 'o thick nf') + rect(92, 26, 14, 8, 'o dark thin', 2)),
  fuse: I(fuseBox(14, 14, 8, 84)),
  chip: I(rect(30, 22, 60, 36, 'o p1', 2) + rect(48, 30, 24, 20, 'o dark', 1) + Array.from({ length: 6 }, (_, i) => ln([34 + i * 10, 58], [34 + i * 10, 64], 'o')).join('')),
  ina: I(rect(26, 22, 68, 36, 'o p1', 2) + rect(40, 34, 20, 8, 'o al') + rect(70, 30, 14, 18, 'o p2')),
  mosfet: I(rect(24, 24, 72, 32, 'o p1', 2) + rect(32, 30, 16, 14, 'o dark') + rect(70, 30, 18, 18, 'o p2')),
  buzzer: I(circ(60, 40, 22, 'o p2') + circ(60, 40, 8, 'o dark') + ln([82, 40], [104, 30], 'wr') + ln([82, 44], [104, 50], 'wb')),
  sensor: I(rect(18, 26, 38, 30, 'o p1', 2) + circ(37, 41, 9, 'o p0') + rect(66, 30, 34, 22, 'o p1', 2) + rect(78, 36, 10, 10, 'o p0 thin')),
  lan: I(rect(26, 28, 44, 24, 'o p1', 4) + rect(70, 34, 10, 12, 'o dark thin', 2) + path('M26 40 C14 40 14 60 30 62 L98 62', 'wd') + rect(96, 56, 14, 12, 'o p0 thin', 1)),
  pdsrc: I(rect(26, 26, 50, 30, 'o fuse', 3) + rect(76, 34, 12, 12, 'o dark thin', 3) + path('M40 41 l8 -8 l0 6 l8 0 l-8 8 l0 -6 Z', 'ah')),
  plate: I(path('M14 52 L76 52 L104 30 L42 30 Z', 'o al') + path('M14 52 L14 56 L76 56 L104 34 L104 30 L76 52', 'o p2')),
  small: I(rect(14, 34, 22, 12, 'o fuse', 2) + ln([8, 40], [14, 40], 'o') + ln([36, 40], [42, 40], 'o') + rect(52, 36, 18, 8, 'o p1', 1) + ln([46, 40], [52, 40]) + ln([70, 40], [76, 40]) + rect(84, 34, 14, 12, 'o dark', 1) + ln([86, 46], [86, 54]) + ln([96, 46], [96, 54])),
  wire: I(path('M16 30 C40 10 70 50 104 26', 'wr') + path('M16 44 C40 24 70 64 104 40', 'wb') + rect(98, 22, 10, 8, 'o p0 thin') + rect(98, 36, 10, 8, 'o p0 thin')),
  screw20: I(torx(26, 40, 12) + path('M38 34 L96 37 L104 40 L96 43 L38 46 Z', 'o p1') + Array.from({ length: 8 }, (_, i) => ln([44 + i * 6.5, 34], [48 + i * 6.5, 46], 'o thin')).join('')),
  m4: I(torx(30, 40, 10) + rect(40, 35, 40, 10, 'o p1') + Array.from({ length: 7 }, (_, i) => ln([44 + i * 5.5, 35], [47 + i * 5.5, 45], 'o thin')).join('') + rect(86, 32, 12, 16, 'o p2', 2)),
  standoff: I(Array.from({ length: 4 }, (_, i) => rect(18 + i * 24, 26, 10, 26, 'o al') + ln([23 + i * 24, 18], [23 + i * 24, 26], 'o thick')).join('')),
  glue: I(path('M50 66 L50 30 Q50 22 58 22 L62 22 Q70 22 70 30 L70 66 Z', 'o p0') + path('M57 22 L58 10 L62 10 L63 22', 'o p2') + rect(53, 38, 14, 14, 'o p1 thin')),
  paint: I(rect(34, 20, 52, 48, 'o dark', 4) + rect(30, 16, 60, 8, 'o p2', 2) + rect(40, 34, 40, 18, 'o p0 thin')),
  seal: I(path('M14 50 C40 20 80 60 106 30', 'strap0') + path('M14 50 C40 20 80 60 106 30', 'o nf thin')),
  sticker: I(rect(10, 26, 100, 22, 'o p1', 4) + txt(60, 41, 'POINT HUB', 'tb') + rect(30, 54, 60, 14, 'o p0 thin', 3)),
};

// ---- tools (96 x 64) -------------------------------------------------------
const TI = (b) => `<svg class="ico" viewBox="0 0 96 64" aria-hidden="true">${b}</svg>`;
export const tools = {
  drill: TI(path('M14 18 L62 18 L62 34 L40 34 L36 56 L22 56 L26 34 L14 34 Z', 'o p1') + rect(62, 22, 10, 8, 'o p2') + ln([72, 26], [90, 26], 'o thick')),
  bits: TI(Array.from({ length: 5 }, (_, i) => rect(14 + i * 15, 14 + i * 3, 5 + i, 40 - i * 3, i < 3 ? 'o al' : 'o p2', 1)).join('') + rect(14, 50, 68, 6, 'o p1', 2)),
  jigsaw: TI(path('M12 22 L70 22 Q80 22 80 32 L80 38 L12 38 Z', 'o p1') + rect(38, 38, 4, 18, 'o al') + rect(8, 38, 76, 4, 'o p2')),
  blades: TI(Array.from({ length: 4 }, (_, i) => rect(18 + i * 18, 10, 8, 44, i < 2 ? 'o al' : 'o p2', 1) + rect(18 + i * 18, 6, 8, 8, 'o p1')).join('')),
  holesaw: TI(circ(40, 34, 18, 'o p1') + circ(40, 34, 8, 'o p0') + ln([58, 34], [86, 34], 'o thick') + txt(40, 62, 'Ø32 · Ø45', 'tt')),
  punch: TI(rect(20, 26, 50, 12, 'o p1', 5) + path('M70 28 L86 32 L70 36 Z', 'o al')),
  files: TI(`<g transform="rotate(-15 48 32)">${rect(10, 22, 72, 8, 'o al', 1)}${rect(10, 36, 60, 5, 'o al', 1)}${rect(70, 34, 18, 9, 'o p2', 3)}</g>`),
  clamp: TI(path('M14 14 L60 14 L60 22 L22 22 L22 44 L60 44 L60 52 L14 52 Z', 'o p1') + rect(56, 20, 6, 26, 'o al') + rect(66, 30, 22, 6, 'o p2')),
  vise: TI(rect(18, 40, 60, 14, 'o p2', 2) + rect(24, 20, 16, 22, 'o p1') + rect(56, 20, 16, 22, 'o p1') + ln([72, 31], [90, 31], 'o thick')),
  square: TI(path('M14 10 L14 54 L80 54 Z', 'o p1') + path('M24 30 L24 46 L44 46 Z', 'o p0')),
  sand: TI(rect(18, 22, 60, 24, 'o fuse', 8) + Array.from({ length: 6 }, (_, i) => circ(28 + i * 8, 34, 1, 'ah')).join('')),
  roller: TI(rect(10, 10, 40, 14, 'o p2', 7) + path('M50 17 L60 17 L60 34 L34 34 L34 50', 'o thick nf') + rect(30, 48, 8, 14, 'o p1', 3) + path('M70 10 L82 10 L80 30 L72 30 Z', 'o p2') + rect(72, 30, 8, 22, 'o p1', 2)),
  iron: TI(rect(14, 26, 44, 12, 'o p1', 5) + path('M58 28 L84 31 L84 33 L58 36 Z', 'o al') + path('M14 32 C8 32 8 48 20 50', 'o nf')),
  crimp: TI(path('M10 50 L40 30 L44 34 L16 56 Z', 'o p1') + path('M10 18 L40 30 L44 26 L16 10 Z', 'o p1') + rect(44, 24, 30, 16, 'o p2', 3)),
  shrink: TI(Array.from({ length: 5 }, (_, i) => rect(14 + i * 14, 18 + i * 2, 9, 30, ['o dark', 'wrf', 'o dark', 'wbf', 'o p2'][i], 3)).join('')),
  meter: TI(rect(28, 6, 40, 54, 'o p0', 5) + rect(33, 11, 30, 14, 'o dark', 2) + circ(48, 40, 9, 'o p1')),
  laser: TI(rect(30, 10, 32, 46, 'o p1', 4) + rect(35, 16, 22, 12, 'o dark', 2) + ln([46, 10], [46, 2], 'ar')),
  torx: TI(rect(10, 26, 40, 12, 'o p1', 6) + rect(50, 29, 30, 6, 'o al') + txt(30, 54, 'T20', 'tt')),
  tape: TI(circ(48, 32, 20, 'o tape') + circ(48, 32, 9, 'o p0') + path('M48 52 L86 52 L86 44 L56 44', 'o tape')),
};

// ---- icons for the parts and tools added later --------------------------------------------
icons.btn = I(circ(60, 40, 18, 'o p1') + `<circle cx="60" cy="40" r="23" fill="none" stroke="#21c45d" stroke-width="3"/>`);
icons.neod = I([34, 60, 86].map(x => circ(x, 40, 11, 'o gl')).join(''));
icons.washer = I([40, 80].map(x => circ(x, 40, 18, 'o p2') + circ(x, 40, 7, 'o p0')).join(''));
icons.felt = I(path('M18 54 L88 54 L104 30 L34 30 Z', 'o dark') + path('M18 54 L18 58 L88 58 L104 34 L104 30 L88 54', 'o p2'));
icons.bag = I(rect(16, 26, 88, 40, 'o p1', 6) + path('M42 26 C44 8 76 8 78 26', 'o thick nf') + rect(40, 42, 40, 18, 'o p2', 2));
icons.cablec = I(path('M16 58 C40 10 80 70 104 22', 'o thick nf') + rect(8, 54, 14, 8, 'o p2', 2) + rect(98, 18, 14, 8, 'o p2', 2));
icons.cover = I(rect(14, 16, 84, 40, 'o gh') + rect(22, 24, 84, 40, 'o p0'));
icons.ties = I(rect(30, 28, 26, 26, 'o p1', 2) + path('M20 41 C30 8 70 8 94 40', 'o nf'));
tools.strip = TI(path('M12 20 L48 34 L84 12 M12 44 L48 34 L84 54', 'o thick nf') + circ(48, 34, 5, 'o p1'));
tools.cutter = TI(path('M10 16 L52 34 L10 52', 'o thick nf') + path('M52 34 L88 24 L78 36 L52 34', 'o p2'));
tools.forst = TI(rect(8, 30, 56, 6, 'o p2') + circ(74, 33, 12, 'o p1') + circ(74, 33, 3, 'ah'));
