import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const CREST = '__CREST__';
const W = 1.02, H = 0.38, D = 0.22;

const host = document.getElementById('stage3d');
const poster = document.getElementById('poster');
const statusEl = document.getElementById('stage-status');

const BLUE = '#2d6bff', ORANGE = '#ff5a1f', WHITE = '#e8ecf2', GOLD = '#ffc21a';
const F = (px, w = 700) => w + ' ' + px + 'px "Archivo Narrow", "Arial Narrow", Arial, sans-serif';

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

function srcCanvas(cols, rows) {
  const c = document.createElement('canvas'); c.width = cols; c.height = rows;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#000'; x.fillRect(0, 0, cols, rows);
  return [c, x];
}
function center(x, s, cx, y) { const w = x.measureText(s).width; x.fillText(s, Math.round(cx - w / 2), y); }

// Turn a cols x rows picture into a sheet of round LED dots, like the real panel.
const PITCH = 10;
function ledify(src, cols, rows) {
  const data = src.getContext('2d').getImageData(0, 0, cols, rows).data;
  const out = document.createElement('canvas'); out.width = cols * PITCH; out.height = rows * PITCH;
  const o = out.getContext('2d');
  o.fillStyle = '#050607'; o.fillRect(0, 0, out.width, out.height);
  const r0 = PITCH * 0.34;
  o.fillStyle = '#16181b';
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    o.beginPath(); o.arc(x * PITCH + PITCH / 2, y * PITCH + PITCH / 2, r0, 0, Math.PI * 2); o.fill();
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = (y * cols + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) < 48) continue;
    o.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',0.85)'; o.shadowBlur = PITCH * 0.9;
    o.fillStyle = 'rgb(' + Math.min(255, r * 1.08 + 14) + ',' + Math.min(255, g * 1.08 + 14) + ',' + Math.min(255, b * 1.08 + 14) + ')';
    o.beginPath(); o.arc(x * PITCH + PITCH / 2, y * PITCH + PITCH / 2, r0 * 1.04, 0, Math.PI * 2); o.fill();
  }
  o.shadowBlur = 0;
  return out;
}

function drawMatch() {
  const [c, x] = srcCanvas(192, 64);
  x.font = F(12); x.fillStyle = BLUE; x.fillText('WIEDIKON', 3, 11);
  x.fillStyle = ORANGE; x.fillText('VOLZ', 189 - x.measureText('VOLZ').width, 11);
  x.lineWidth = 1;
  x.strokeStyle = BLUE; x.strokeRect(2.5, 14.5, 62, 47);
  x.strokeStyle = ORANGE; x.strokeRect(127.5, 14.5, 62, 47);
  x.font = F(44); x.fillStyle = BLUE; center(x, '18', 34, 57); x.fillStyle = ORANGE; center(x, '16', 158, 57);
  x.font = F(13);
  const row = (y, a, label, b) => {
    x.fillStyle = BLUE; center(x, a, 75, y); x.fillStyle = WHITE; center(x, label, 96, y); x.fillStyle = ORANGE; center(x, b, 117, y);
  };
  row(27, '2', 'SET', '1'); row(43, '1', 'TO', '2'); row(59, '3', 'SUB', '6');
  x.fillStyle = GOLD; x.beginPath(); x.arc(71, 7, 3, 0, Math.PI * 2); x.fill();
  return c;
}
function drawBench(side) {
  const [c, x] = srcCanvas(32, 64);
  const home = side === 'L';
  const top = home ? ['18', BLUE] : ['16', ORANGE], bot = home ? ['16', ORANGE] : ['18', BLUE];
  x.font = F(22); x.fillStyle = top[1]; center(x, top[0], 16, 21);
  x.fillStyle = '#4c535e'; x.fillRect(4, 25, 24, 1);
  x.font = F(16); x.fillStyle = bot[1]; center(x, bot[0], 16, 42);
  x.font = F(10); x.fillStyle = WHITE; center(x, home ? '2:1' : '1:2', 16, 54);
  const used = home ? 1 : 2;
  for (let i = 0; i < 2; i++) { x.fillStyle = i < used ? top[1] : '#30343a'; x.fillRect(10 + i * 8, 58, 4, 4); }
  return c;
}
async function drawIdle() { const img = await loadImage(CREST); const [c, x] = srcCanvas(192, 64); x.drawImage(img, 0, 0); return c; }
async function drawIdleBench() {
  const img = await loadImage(CREST); const [c, x] = srcCanvas(32, 64);
  x.imageSmoothingEnabled = true; x.drawImage(img, 70, 0, 52, 64, 1, 8, 30, 37);
  x.font = F(9); x.fillStyle = GOLD; center(x, 'KSCW', 16, 58);
  return c;
}
function drawTest(cols, rows) {
  const [c, x] = srcCanvas(cols, rows);
  const bars = ['#ffffff', '#ffd400', '#00e5ff', '#00e050', '#ff3df0', '#ff2a2a', '#2a5bff'];
  const bw = cols / bars.length, bh = Math.round(rows * 0.68);
  bars.forEach((col, i) => { x.fillStyle = col; x.fillRect(Math.round(i * bw), 0, Math.ceil(bw), bh); });
  for (let i = 0; i < cols; i++) { const v = Math.round(255 * i / (cols - 1)); x.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; x.fillRect(i, bh + 2, 1, rows); }
  x.strokeStyle = '#ffffff'; x.lineWidth = 1; x.strokeRect(0.5, 0.5, cols - 1, rows - 1);
  return c;
}

function labelTex(text, w, h, color, font, track = 0) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.clearRect(0, 0, w, h); x.fillStyle = color; x.font = font; x.textBaseline = 'middle';
  const widths = [...text].map(ch => x.measureText(ch).width);
  const tw = widths.reduce((a, b) => a + b, 0) + track * (text.length - 1);
  let px = (w - tw) / 2;
  [...text].forEach((ch, i) => { x.fillText(ch, px, h / 2); px += widths[i] + track; });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// The scorer's 16" control screen (1920 x 1200), drawn at half size: the 640 x 400 layout, scaled 1.5.
function drawControl() {
  const c = document.createElement('canvas'); c.width = 960; c.height = 600;
  const x = c.getContext('2d');
  x.scale(1.5, 1.5);
  x.fillStyle = '#0d1014'; x.fillRect(0, 0, 640, 400);
  x.fillStyle = '#171b21'; x.fillRect(0, 0, 640, 46);
  x.font = '600 20px "Instrument Sans", Arial, sans-serif'; x.fillStyle = '#c9ced6'; x.fillText('Set 3 · 18 : 16', 18, 30);
  x.fillStyle = '#7d8590'; x.fillText('Point Hub', 520, 30);
  const team = (x0, col, name, pts) => {
    x.fillStyle = col; x.globalAlpha = 0.16; x.fillRect(x0, 62, 296, 250); x.globalAlpha = 1;
    x.strokeStyle = col; x.lineWidth = 3; x.strokeRect(x0 + 1.5, 63.5, 293, 247);
    x.fillStyle = col; x.font = '700 24px "Archivo Narrow", Arial, sans-serif'; center(x, name, x0 + 148, 96);
    x.font = '700 150px "Archivo Narrow", Arial, sans-serif'; center(x, pts, x0 + 148, 250);
    x.font = '600 26px "Instrument Sans", Arial, sans-serif'; x.fillStyle = '#e8ecf2'; center(x, '+1', x0 + 148, 296);
  };
  team(16, BLUE, 'WIEDIKON', '18'); team(328, ORANGE, 'VOLZ', '16');
  for (const [i, l] of ['Timeout', 'Substitution', 'Undo', 'Menu'].entries()) {
    x.fillStyle = '#1c2128'; x.fillRect(16 + i * 156, 330, 144, 52);
    x.fillStyle = '#c9ced6'; x.font = '500 19px "Instrument Sans", Arial, sans-serif'; center(x, l, 88 + i * 156, 363);
  }
  return c;
}

const d2r = Math.PI / 180;
// Design D geometry, in metres. Front is +z, the box spans x -W/2..W/2, y 0..H, z -D/2..D/2.
const T = 0.006;                              // 6 mm poplar
const AW = 1.004, AH = 0.366;                 // the tilting front frame A
const HINGE_Y = H - T;                        // the piano hinge runs along the top front edge
const K_LEN = 0.14;                          // bottom cap K, as on the cut list
const PIVOT = { y: -0.356, z: -0.016 };       // stay pivot on A, in A's own frame (10 mm up, 10 mm behind)
const PIN = { y: 0.018, z: D / 2 - 0.060 };   // M6 pin through each end wall, 60 mm behind the front
const STAY_X = W / 2 - 0.020, STAY_LEN = 0.200;
// flap opening 400 x 290 in B, top edge 40 mm below the top of the box; pocket 30 mm deep behind B
const POCKET = { w: 0.40, h: 0.29, cy: H - 0.04 - 0.145, depth: 0.03 };
// flap F 375 x 268 (12 mm), 11 mm clear of the opening top and bottom; the 16" screen 359 x 238 x 12
// hangs upside down on it, 8 mm from the sides and the bottom, 22 mm free at the top for the plugs;
// the 3 mm front frame's window is 351 x 230, 12 from the sides, 11 from the bottom, 27 from the top
const FLAP = { w: 0.375, h: 0.268, t: 0.012, gap: 0.011, strip: 0.008, frame: 0.003 };
const SCR = { w: 0.359, h: 0.238, t: 0.0115, top: 0.022, pic: [0.345, 0.216] };
const WIN = { w: 0.351, h: 0.23, top: 0.027 };
const HANDLE_X = 0.28, HANDLE_Z = D / 2 - 0.160;
const RAIL_X = 0.311, RAIL_H = 0.015, LIP = 0.006, PAD = 0.003, LIFT = RAIL_H + LIP + PAD;

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  try { await Promise.all([document.fonts.load(F(44)), document.fonts.load(F(12)), document.fonts.load('600 30px "Instrument Sans"')]); } catch (e) { /* fallback font */ }

  // The stage's gradient is CSS (it follows the page theme); the canvas stays transparent.
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(24, 1, 0.01, 50);
  camera.position.set(1.0, 0.55, 1.55);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.17, 0);
  controls.enableDamping = true; controls.minDistance = 0.6; controls.maxDistance = 5;
  controls.maxPolarAngle = Math.PI * 0.64;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotate = !reduce; controls.autoRotateSpeed = 0.45;
  let goal = null;
  controls.addEventListener('start', () => { controls.autoRotate = false; goal = null; });

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1.2, 2.6, 1.9); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.8, near: 0.5, far: 7 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 1.1); rim.position.set(-2.2, 1.4, -2.0); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xdfe6f2, 0x1a1a1a, 0.28));

  // Finish: matte black body, gloss black front and ends, smoked polycarbonate, black hardware.
  const mBody = new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.74, metalness: 0, envMapIntensity: 0.55 });
  const mGloss = new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.25 });
  const mSmoke = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.26, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.5, depthWrite: false });
  const mHw = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.42, metalness: 0.45 });
  const mHandle = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.62, metalness: 0, envMapIntensity: 0.5 });
  const mAlu = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.8 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.6 });
  const mInside = new THREE.MeshStandardMaterial({ color: 0x0a0b0c, roughness: 0.9, side: THREE.BackSide });
  const mRubber = new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.93 });
  const mPad = new THREE.MeshPhysicalMaterial({ color: 0xd8dde2, roughness: 0.3, transparent: true, opacity: 0.55 });
  const mBezel = new THREE.MeshStandardMaterial({ color: 0x030304, roughness: 0.25 });

  const board = new THREE.Group(); scene.add(board);
  board.position.y = LIFT - 0.008;          // it stands on the foot rails' rubber pads; the floor is at -0.008
  const add = (geo, mat, x, y, z, parent = board) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const slab = (w, h, d, mat, x, y, z, parent = board) => add(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d) * 0.3), mat, x, y, z, parent);

  // A panel with rectangular openings, in its own x/y plane, extruded `depth` toward +z from z = 0.
  function panelGeo(x0, y0, x1, y1, holes, depth = T, bevel = 0.0008) {
    const s = new THREE.Shape(); s.moveTo(x0, y0); s.lineTo(x1, y0); s.lineTo(x1, y1); s.lineTo(x0, y1); s.lineTo(x0, y0);
    for (const [hx0, hy0, hx1, hy1] of holes) { const h = new THREE.Path(); h.moveTo(hx0, hy0); h.lineTo(hx0, hy1); h.lineTo(hx1, hy1); h.lineTo(hx1, hy0); h.lineTo(hx0, hy0); s.holes.push(h); }
    return new THREE.ExtrudeGeometry(s, { depth: depth - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 }).translate(0, 0, bevel);
  }

  // ---- fixed shell: bottom C2, top C1, ends D (bench windows), back B (flap opening) ----
  const CD = 0.214, CZ = D / 2 - CD / 2;
  slab(W, T, CD, mBody, 0, T / 2, CZ);
  slab(W, T, CD, mBody, 0, H - T / 2, CZ);
  for (const s of [-1, 1]) {
    // end panel D: 214 deep x 368 high, window 160 x 320 (27 mm front and back, 24 mm top and bottom)
    const g = panelGeo(-CD / 2, 0, CD / 2, H - 2 * T, [[-0.08, 0.024, 0.08, 0.344]], T);
    // rotated a quarter turn, the 6 mm extrusion runs outward from x; the window faces the bench
    const e = add(g, mGloss, s < 0 ? -W / 2 + T : W / 2 - T, T, CZ);
    e.rotation.y = s * Math.PI / 2;
  }
  // back panel B: 1020 x 380, centred flap opening 400 x 290
  const back = add(panelGeo(-W / 2, 0, W / 2, H, [[-POCKET.w / 2, POCKET.cy - POCKET.h / 2, POCKET.w / 2, POCKET.cy + POCKET.h / 2]], T), mBody, 0, 0, -D / 2);
  // dark inside, seen through the gaps the tilting front opens
  const inner = add(new THREE.BoxGeometry(W - 2 * T - 0.002, H - 2 * T - 0.002, CD - 0.002), mInside, 0, H / 2, CZ - 0.001);
  inner.castShadow = false;

  // bench screens behind the end windows
  const ledMat = () => { const m = new THREE.MeshBasicMaterial({ toneMapped: false }); m.color.setScalar(0.9); return m; };
  const BZ = CZ;
  const benchL = add(new THREE.PlaneGeometry(0.16, 0.32), ledMat(), -W / 2 + 0.0035, 0.19, BZ); benchL.rotation.y = -Math.PI / 2; benchL.castShadow = false;
  const benchR = add(new THREE.PlaneGeometry(0.16, 0.32), ledMat(), W / 2 - 0.0035, 0.19, BZ); benchR.rotation.y = Math.PI / 2; benchR.castShadow = false;
  const pcL = add(new THREE.PlaneGeometry(0.16, 0.32), mSmoke, -W / 2 + 0.002, 0.19, BZ); pcL.rotation.y = -Math.PI / 2; pcL.castShadow = false;
  const pcR = add(new THREE.PlaneGeometry(0.16, 0.32), mSmoke, W / 2 - 0.002, 0.19, BZ); pcR.rotation.y = Math.PI / 2; pcR.castShadow = false;

  // black rubber caps on the four front corners of the fixed box (they cover the ends' edge, not the front frame)
  const cap = new RoundedBoxGeometry(0.012, 0.022, 0.022, 3, 0.005);
  for (const sx of [-1, 1]) for (const sy of [0, 1]) add(cap, mRubber, sx * (W / 2 - 0.004), sy ? H - 0.0095 : 0.0095, D / 2 - 0.0095);

  // ---- the tilting front: A + smoked sheet + six modules + steel bars, hung from the piano hinge ----
  const front = new THREE.Group(); front.position.set(0, HINGE_Y, D / 2); board.add(front);
  const frameA = add(panelGeo(-AW / 2, -AH - 0.001, AW / 2, -0.001, [[-0.48, -AH - 0.001 + 0.023, 0.48, -0.001 - 0.023]], T, 0.0012), mGloss, 0, 0, -T, front);
  const screen = add(new THREE.PlaneGeometry(0.96, 0.32), ledMat(), 0, -0.001 - AH / 2, -T - 0.0035, front); screen.castShadow = false;
  add(new THREE.PlaneGeometry(0.96, 0.32), mSmoke, 0, -0.001 - AH / 2, -0.0012, front).castShadow = false;
  add(new THREE.BoxGeometry(0.96, 0.32, 0.016), mDark, 0, -0.001 - AH / 2, -T - 0.0035 - 0.0085, front);
  for (const bx of [-0.32, 0, 0.32]) add(new THREE.BoxGeometry(0.02, 0.36, 0.004), mHw, bx, -0.001 - AH / 2, -0.033, front);
  add(new THREE.CylinderGeometry(0.0022, 0.0022, 1.0, 12), mHw, 0, 0.0005, -T - 0.001, front).rotation.z = Math.PI / 2;   // piano hinge knuckle
  // two triangular cheeks, just inboard of the bench screens: at 20 deg their back edge reaches the box's front plane
  {
    const A = 20 * d2r, y1 = -0.001 - AH;
    const sh = new THREE.Shape(); sh.moveTo(-T, -0.001); sh.lineTo(-T, y1); sh.lineTo(-T - AH * Math.sin(A), -0.001 - AH * Math.cos(A)); sh.lineTo(-T, -0.001);
    const cg = new THREE.ExtrudeGeometry(sh, { depth: T, bevelEnabled: false });
    for (const s of [-1, 1]) { const ch = add(cg, mBody, s * (W / 2 - 0.023) - T / 2, 0, 0, front); ch.rotation.y = -Math.PI / 2; ch.position.x = s * (W / 2 - 0.026) + T / 2; }
    // stay pivot blocks on A's back, bottom corners
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.011, 0.02, 0.02), mBody, s * (W / 2 - 0.0135), PIVOT.y, PIVOT.z, front);
  }
  const lettering = add(new THREE.PlaneGeometry(0.12, 0.012), new THREE.MeshBasicMaterial({ map: labelTex('POINT HUB', 1024, 104, '#7b8188', '600 64px "Instrument Sans", Arial, sans-serif', 26), transparent: true }), 0.405, -AH + 0.0105, 0.0004, front);
  lettering.castShadow = false;

  // bottom cap K: hangs from A's bottom inside edge, its back edge slides on the floor
  const capK = add(new THREE.BoxGeometry(AW - 0.04, T, K_LEN), mBody, 0, 0, 0);
  // ratchet stays (aluminium 25 x 4) and the M6 pins through the end walls
  const stays = [-1, 1].map(s => add(new THREE.BoxGeometry(0.004, 0.025, STAY_LEN), mAlu, s * STAY_X, 0, 0));
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 12), mHw, s * (W / 2 - 0.013), PIN.y, PIN.z).rotation.z = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.0055, 0.0055, 0.004, 6), mHw, s * (W / 2 + 0.002), PIN.y, PIN.z).rotation.z = Math.PI / 2;
  }
  const local2world = (p, a) => ({ y: HINGE_Y + p.y * Math.cos(a) - p.z * Math.sin(a), z: D / 2 + p.y * Math.sin(a) + p.z * Math.cos(a) });
  let tiltDeg = 0;
  function setFront(deg) {
    tiltDeg = deg;
    const a = -deg * d2r;                   // negative: the bottom swings out toward the referee
    front.rotation.x = a;
    // K
    const P = local2world({ y: -0.001 - AH, z: -T }, a), floorY = T + T / 2;
    const dy = P.y - floorY, reach = Math.sqrt(Math.max(0, K_LEN * K_LEN - dy * dy));
    let ang;
    if (P.z - reach <= D / 2) ang = Math.atan2(dy, reach);              // back edge lands on the floor
    else ang = Math.atan2(P.y - T, P.z - D / 2);                           // too short: it points at the front edge and hangs short
    capK.rotation.x = -ang;
    capK.position.set(0, P.y - Math.sin(ang) * K_LEN / 2, P.z - Math.cos(ang) * K_LEN / 2);
    // stays: from the pivot on A to the pin, 12 mm of strip ahead of the pivot
    const Q = local2world(PIVOT, a), vy = PIN.y - Q.y, vz = PIN.z - Q.z, L = Math.hypot(vy, vz), uy = vy / L, uz = vz / L;
    for (const st of stays) {
      st.position.y = Q.y + uy * (STAY_LEN / 2 - 0.012); st.position.z = Q.z + uz * (STAY_LEN / 2 - 0.012);
      st.rotation.x = Math.atan2(-uy, uz);
    }
    return P.z - reach > D / 2;
  }

  // ---- the scorer's flap: a 16" touch screen in a 30 mm pocket in the back, hinged at its top ----
  const PZ = -D / 2;
  const recess = add(new THREE.PlaneGeometry(POCKET.w, POCKET.h), mDark, 0, POCKET.cy, PZ + T + POCKET.depth); recess.rotation.y = Math.PI; recess.castShadow = false;
  for (const [w, h, x, y] of [[POCKET.w + 0.012, T, 0, POCKET.cy + POCKET.h / 2 + T / 2], [POCKET.w + 0.012, T, 0, POCKET.cy - POCKET.h / 2 - T / 2], [T, POCKET.h, -POCKET.w / 2 - T / 2, POCKET.cy], [T, POCKET.h, POCKET.w / 2 + T / 2, POCKET.cy]])
    add(new THREE.BoxGeometry(w, h, POCKET.depth), mBody, x, y, PZ + T + POCKET.depth / 2);
  // cable slot, about 50 x 15, in the side wall at the port corner (chosen at the dry fit; drawn on the
  // port plate's side), 15 mm below the pocket's top wall
  const slot = add(new THREE.PlaneGeometry(0.015, 0.05), mDark, POCKET.w / 2 - 0.0005, POCKET.cy + POCKET.h / 2 - 0.015 - 0.025, PZ + T + 0.0075);
  slot.rotation.y = -Math.PI / 2; slot.castShadow = false;
  // The pivot is the flap's top edge at the back panel's surface: closed, the front frame is flush with
  // B and the glass sits 3.5 mm below it. Flap-local y runs down from the top edge, z into the box.
  const flapTop = POCKET.cy + POCKET.h / 2 - FLAP.gap;
  const flapPivot = new THREE.Group(); flapPivot.position.set(0, flapTop, PZ); board.add(flapPivot);
  const zF = FLAP.frame + 0.012;                                   // F's front face: behind the frame and the 12 mm strips
  add(new THREE.BoxGeometry(FLAP.w, FLAP.h, FLAP.t), mBody, 0, -FLAP.h / 2, zF + FLAP.t / 2, flapPivot);
  // spacer strips (two 6 mm layers), with a gap at the port corner where the cables leave
  const sw = FLAP.strip, sx = FLAP.w / 2 - sw / 2, gapLen = 0.06;
  for (const [w, h, x, y] of [[FLAP.w, sw, 0, -sw / 2], [FLAP.w - 2 * sw, sw, 0, -FLAP.h + sw / 2], [sw, FLAP.h - sw, -sx, -sw - (FLAP.h - sw) / 2], [sw, FLAP.h - gapLen, sx, -gapLen - (FLAP.h - gapLen) / 2]])
    add(new THREE.BoxGeometry(w, h, 0.012), mBody, x, y, FLAP.frame + 0.006, flapPivot);
  // the screen, glass towards the scorer; a thicker strip at its (upper) port edge
  const scrY = -SCR.top - SCR.h / 2;
  add(new THREE.BoxGeometry(SCR.w, SCR.h, SCR.t), mBezel, 0, scrY, zF - SCR.t / 2, flapPivot);
  add(new THREE.BoxGeometry(0.16, 0.012, 0.009), mHw, sx - sw - 0.09, -SCR.top / 2 - sw / 2, zF - 0.0045, flapPivot);  // plugs in the band above it
  const winY = -WIN.top - WIN.h / 2;
  const ctrl = add(new THREE.PlaneGeometry(SCR.pic[0], SCR.pic[1]), new THREE.MeshBasicMaterial({ toneMapped: false }), 0, winY, zF - SCR.t - 0.0003, flapPivot);
  ctrl.rotation.y = Math.PI; ctrl.castShadow = false;
  // 3 mm front frame screwed onto the strips: its window hides the plugs and holds the screen's edges
  const wx = WIN.w / 2;
  add(panelGeo(-FLAP.w / 2, -FLAP.h, FLAP.w / 2, 0, [[-wx, winY - WIN.h / 2, wx, winY + WIN.h / 2]], FLAP.frame, 0.0005), mBody, 0, 0, 0, flapPivot);
  // three torque hinges along the top edge
  for (const hx of [-0.14, 0, 0.14]) add(new THREE.BoxGeometry(0.038, 0.008, 0.006), mHw, hx, 0.004, 0.006, flapPivot);
  function setFlap(open) { flapPivot.rotation.x = open ? 45 * d2r : 0; }   // 45 deg from flat when open

  // back panel: the port plate low on the left (seen from behind), horn hole, vents, six T20 screws
  add(new RoundedBoxGeometry(0.14, 0.06, 0.003, 2, 0.001), new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.55 }), 0.41, 0.04, PZ - 0.0015).castShadow = false;
  for (const [x, y] of [[0.345, 0.015], [0.475, 0.015], [0.345, 0.065], [0.475, 0.065]]) add(new THREE.CylinderGeometry(0.0034, 0.0034, 0.001, 16), mHw, x, y, PZ - 0.0034).rotation.x = Math.PI / 2;
  for (const p of [{ x: 0.455, c: 0xe0a800, t: 'POWER' }, { x: 0.428, c: 0x3b74ff, t: 'DATA' }, { x: 0.388, c: 0xf2f2f2 }, { x: 0.361, c: 0xf2f2f2 }]) {
    const slot = add(new RoundedBoxGeometry(0.0135, 0.0062, 0.002, 2, 0.0009), mDark, p.x, 0.036, PZ - 0.0032); slot.castShadow = false;
    const ring = add(new THREE.TorusGeometry(0.0105, 0.0012, 10, 36), new THREE.MeshStandardMaterial({ color: p.c, roughness: 0.4, emissive: p.c, emissiveIntensity: 0.18 }), p.x, 0.036, PZ - 0.0034);
    ring.castShadow = false;
    if (p.t) { const lab = add(new THREE.PlaneGeometry(0.026, 0.0052), new THREE.MeshBasicMaterial({ map: labelTex(p.t, 400, 80, '#9aa0a7', '600 44px "Instrument Sans", Arial, sans-serif', 8), transparent: true }), p.x, 0.0585, PZ - 0.0032);
      lab.rotation.y = Math.PI; lab.castShadow = false; }
  }
  const backupLab = add(new THREE.PlaneGeometry(0.03, 0.006), new THREE.MeshBasicMaterial({ map: labelTex('BACKUP', 400, 80, '#9aa0a7', '600 44px "Instrument Sans", Arial, sans-serif', 8), transparent: true }), 0.3745, 0.0585, PZ - 0.0032);
  backupLab.rotation.y = Math.PI; backupLab.castShadow = false;
  add(new THREE.CylinderGeometry(0.016, 0.016, 0.002, 32), mDark, -0.38, 0.31, PZ - 0.001).rotation.x = Math.PI / 2;
  for (let i = 0; i < 8; i++) add(new THREE.BoxGeometry(0.04, 0.008, 0.002), mDark, -0.19 + i * 0.055, 0.349, PZ - 0.0004).castShadow = false;
  for (const x of [-0.496, 0, 0.496]) for (const y of [0.014, H - 0.014]) add(new THREE.CylinderGeometry(0.0042, 0.0042, 0.0015, 20), mHw, x, y, PZ - 0.0006).rotation.x = Math.PI / 2;

  // two K16 recessed spring handles in the top, near the back edge
  for (const hx of [-HANDLE_X, HANDLE_X]) {
    add(new RoundedBoxGeometry(0.155, 0.0016, 0.0833, 2, 0.0007), mHandle, hx, H + 0.0006, HANDLE_Z);
    add(new THREE.BoxGeometry(0.129, 0.0006, 0.052), mDark, hx, H + 0.0015, HANDLE_Z).castShadow = false;
    add(new RoundedBoxGeometry(0.112, 0.003, 0.014, 2, 0.0012), mRubber, hx, H + 0.0016, HANDLE_Z + 0.012);
    for (const [dx, dz] of [[-0.0705, -0.031], [0, -0.031], [0.0705, -0.031], [-0.0705, 0.031], [0, 0.031], [0.0705, 0.031]])
      add(new THREE.CylinderGeometry(0.0035, 0.0035, 0.001, 14), mHw, hx + dx, H + 0.0018, HANDLE_Z + dz);
  }

  // pull-out rear foot T between two rails under the bottom; clear rubber pads
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.02, RAIL_H, 0.204), mBody, s * RAIL_X, -RAIL_H / 2, CZ - 0.003);
    add(new THREE.BoxGeometry(0.035, LIP, 0.204), mBody, s * (RAIL_X - 0.0075), -RAIL_H - LIP / 2, CZ - 0.003);
    for (const pz of [CZ - 0.003 + 0.08, CZ - 0.003 - 0.08]) add(new THREE.BoxGeometry(0.02, PAD, 0.02), mPad, s * (RAIL_X - 0.0075), -RAIL_H - LIP - PAD / 2, pz);
  }
  const foot = new THREE.Group(); board.add(foot);
  add(new THREE.BoxGeometry(0.6, T, 0.15), mBody, 0, -RAIL_H + T / 2 - 0.0005, -D / 2 + 0.075, foot);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.02, PAD, 0.02), mPad, s * 0.25, -RAIL_H - PAD / 2 + 0.0055 - T, -D / 2 + 0.02, foot);
  function setFoot(out) { foot.position.z = out ? -0.12 : 0; }

  // mounts
  const mounts = {};
  const mStand = new THREE.MeshStandardMaterial({ color: 0x26282c, roughness: 0.38, metalness: 0.75 });
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.26 });
  function rod(a, b, r, mat, parent) {
    const v = new THREE.Vector3().subVectors(b, a), len = v.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), mat);
    m.position.copy(a).addScaledVector(v, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
    m.castShadow = true; parent.add(m); return m;
  }
  function floor(y, parent) { const f = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), shadowMat); f.rotation.x = -Math.PI / 2; f.position.y = y; f.receiveShadow = true; parent.add(f); }
  { const g = new THREE.Group(); scene.add(g); mounts.studio = g; floor(-0.008, g); }
  {
    const g = new THREE.Group(); scene.add(g); mounts.table = g;
    const top = add(new THREE.BoxGeometry(1.5, 0.035, 0.7), new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 0.7 }), 0, -0.008 - 0.0175, 0.05, g);
    top.castShadow = false;
    for (const lx of [-0.69, 0.69]) for (const lz of [-0.26, 0.34]) add(new THREE.BoxGeometry(0.045, 0.74, 0.045), mStand, lx, -0.42, lz, g);
    floor(-0.79, g);
  }
  const BOT = LIFT - 0.008;   // underside of the box
  {
    const g = new THREE.Group(); scene.add(g); mounts.speaker = g;
    rod(new THREE.Vector3(0, -0.62, 0), new THREE.Vector3(0, BOT + 0.004, 0), 0.0175, mStand, g);
    rod(new THREE.Vector3(0, -1.24, 0), new THREE.Vector3(0, -0.6, 0), 0.0225, mStand, g);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + 0.5;
      rod(new THREE.Vector3(0, -0.98, 0), new THREE.Vector3(Math.cos(a) * 0.5, -1.3, Math.sin(a) * 0.5), 0.011, mStand, g);
    }
    floor(-1.3, g);
  }
  {
    const g = new THREE.Group(); scene.add(g); mounts.tripod = g;
    add(new THREE.BoxGeometry(0.07, 0.03, 0.07), mStand, 0.1, BOT - 0.015, 0, g);
    add(new THREE.SphereGeometry(0.022, 20, 14), mStand, 0.1, BOT - 0.045, 0, g);
    rod(new THREE.Vector3(0.1, -0.3, 0), new THREE.Vector3(0.1, BOT - 0.06, 0), 0.012, mStand, g);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + 0.3;
      rod(new THREE.Vector3(0.1 + Math.cos(a) * 0.03, -0.29, Math.sin(a) * 0.03), new THREE.Vector3(0.1 + Math.cos(a) * 0.32, -0.8, Math.sin(a) * 0.32), 0.013, mStand, g);
      rod(new THREE.Vector3(0.1 + Math.cos(a) * 0.32, -0.8, Math.sin(a) * 0.32), new THREE.Vector3(0.1 + Math.cos(a) * 0.55, -1.3, Math.sin(a) * 0.55), 0.009, mStand, g);
    }
    floor(-1.3, g);
  }

  // screens
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (canvas) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
  ctrl.material.map = tex(drawControl()); ctrl.material.needsUpdate = true;
  const screens = {
    match: async () => [drawMatch(), drawBench('L'), drawBench('R')],
    idle: async () => { const f = await drawIdle(); const b = await drawIdleBench(); return [f, b, b]; },
    test: async () => [drawTest(192, 64), drawTest(32, 64), drawTest(32, 64)],
  };
  async function setScreen(name) {
    const [f0, l0, r0] = await screens[name]();
    const f = ledify(f0, 192, 64), l = ledify(l0, 32, 64), r = ledify(r0, 32, 64);
    for (const [mesh, c] of [[screen, f], [benchL, l], [benchR, r]]) {
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.map = tex(c); mesh.material.needsUpdate = true;
    }
  }
  function setMount(name) { for (const k in mounts) mounts[k].visible = k === name; }

  const views = {
    front: [0, 0.2, 1.8], bench: [-1.5, 0.3, 0.62], side: [-1.55, 0.32, 0.95], back: [-0.55, 1.05, -1.6], three: [1.0, 0.55, 1.55], low: [1.1, -0.28, 1.95],
  };
  function setView(name) { goal = new THREE.Vector3(...views[name]); controls.autoRotate = false; }

  await setScreen('match'); setMount('studio'); setFront(0); setFlap(false); setFoot(false);

  const say = (t) => { if (statusEl) statusEl.textContent = t; };
  const hint = 'Drag to turn · scroll or pinch to zoom';
  document.querySelectorAll('[data-screen]').forEach(b => b.addEventListener('click', () => { setScreen(b.dataset.screen); press(b); }));
  document.querySelectorAll('[data-mount]').forEach(b => b.addEventListener('click', () => {
    setMount(b.dataset.mount); press(b);
    if (b.dataset.mount === 'speaker' || b.dataset.mount === 'tripod') { setView('low'); setFoot(false); document.querySelectorAll('[data-foot]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.foot === 'in'))); }
  }));
  document.querySelectorAll('[data-tilt]').forEach(b => b.addEventListener('click', () => {
    const short = setFront(+b.dataset.tilt); press(b); setView('side');
    say(short ? 'At this tilt the cap K falls short of the floor: see the dry fit.' : hint);
  }));
  document.querySelectorAll('[data-flap]').forEach(b => b.addEventListener('click', () => { setFlap(b.dataset.flap === 'open'); press(b); setView('back'); }));
  document.querySelectorAll('[data-foot]').forEach(b => b.addEventListener('click', () => { setFoot(b.dataset.foot === 'out'); press(b); setView('side'); }));
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { setView(b.dataset.view); press(b); }));
  function press(b) { b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w / h < 1.2 ? 36 : 24; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host); resize();

  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(host);
  poster.hidden = true; host.hidden = false; resize();
  say(hint);
  window.__pointhub3d = { setFront, setFlap, setFoot, setView, ready: true };
  renderer.setAnimationLoop(() => {
    if (!visible) return;
    if (goal) {
      camera.position.lerp(goal, 0.08);
      if (camera.position.distanceTo(goal) < 0.002) goal = null;
    }
    controls.update(); renderer.render(scene, camera);
  });
}

main().catch(e => {
  console.warn('3D view unavailable', e);
  if (host) host.hidden = true;
  if (poster) poster.hidden = false;
  if (statusEl) statusEl.textContent = '3D view unavailable here, showing the drawing instead.';
});
