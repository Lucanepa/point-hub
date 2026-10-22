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
  controls.enableDamping = true; controls.minDistance = 0.7; controls.maxDistance = 5;
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
  const mDark = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.6 });
  const mRubber = new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.93 });

  const board = new THREE.Group(); scene.add(board);
  const add = (geo, mat, x, y, z, parent = board) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };

  // A face plate: a rounded rectangle with a window, a hair proud of the body, edges eased.
  function plateGeo(w, h, y0, hx0, hy0, hx1, hy1, r) {
    const s = new THREE.Shape(), x0 = -w / 2, x1 = w / 2, y1 = y0 + h;
    s.moveTo(x0 + r, y0); s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r); s.lineTo(x1, y1 - r);
    s.quadraticCurveTo(x1, y1, x1 - r, y1); s.lineTo(x0 + r, y1); s.quadraticCurveTo(x0, y1, x0, y1 - r); s.lineTo(x0, y0 + r);
    s.quadraticCurveTo(x0, y0, x0 + r, y0);
    const hole = new THREE.Path(); hole.moveTo(hx0, hy0); hole.lineTo(hx0, hy1); hole.lineTo(hx1, hy1); hole.lineTo(hx1, hy0); hole.lineTo(hx0, hy0);
    s.holes.push(hole);
    return new THREE.ExtrudeGeometry(s, { depth: 0.0012, bevelEnabled: true, bevelThickness: 0.0007, bevelSize: 0.0007, bevelSegments: 2, curveSegments: 6 });
  }
  const RC = 0.006;                      // the sanded edge radius
  add(new RoundedBoxGeometry(W, H, D, 5, RC), mBody, 0, H / 2, 0);
  const front = plateGeo(W - 2 * RC + 0.002, H - 2 * RC + 0.002, RC - 0.001, -0.48, 0.03, 0.48, 0.35, 0.002);
  add(front, mGloss, 0, 0, D / 2 - 0.0004);
  const endGeo = plateGeo(D - 2 * RC + 0.002, H - 2 * RC + 0.002, RC - 0.001, -0.08, 0.03, 0.08, 0.35, 0.002);
  const eL = add(endGeo, mGloss, -W / 2 + 0.0004, 0, 0); eL.rotation.y = -Math.PI / 2;
  const eR = add(endGeo, mGloss, W / 2 - 0.0004, 0, 0); eR.rotation.y = Math.PI / 2;

  // LED faces, set just behind the smoked sheet
  const ledMat = () => { const m = new THREE.MeshBasicMaterial({ toneMapped: false }); m.color.setScalar(0.9); return m; };
  const screen = add(new THREE.PlaneGeometry(0.96, 0.32), ledMat(), 0, 0.19, D / 2 + 0.0002); screen.castShadow = false;
  add(new THREE.PlaneGeometry(0.96, 0.32), mSmoke, 0, 0.19, D / 2 + 0.0007).castShadow = false;
  const benchL = add(new THREE.PlaneGeometry(0.16, 0.32), ledMat(), -W / 2 - 0.0002, 0.19, 0); benchL.rotation.y = -Math.PI / 2; benchL.castShadow = false;
  const benchR = add(new THREE.PlaneGeometry(0.16, 0.32), ledMat(), W / 2 + 0.0002, 0.19, 0); benchR.rotation.y = Math.PI / 2; benchR.castShadow = false;
  const pcL = add(new THREE.PlaneGeometry(0.16, 0.32), mSmoke, -W / 2 - 0.0007, 0.19, 0); pcL.rotation.y = -Math.PI / 2; pcL.castShadow = false;
  const pcR = add(new THREE.PlaneGeometry(0.16, 0.32), mSmoke, W / 2 + 0.0007, 0.19, 0); pcR.rotation.y = Math.PI / 2; pcR.castShadow = false;

  // black rubber caps on the four front corners
  const cap = new RoundedBoxGeometry(0.022, 0.022, 0.022, 3, 0.007);
  for (const sx of [-1, 1]) for (const sy of [0, 1]) add(cap, mRubber, sx * (W / 2 - 0.0095), sy ? H - 0.0095 : 0.0095, D / 2 - 0.0095);
  // black bow handles on top
  for (const hx of [-0.3, 0.3]) {
    const h = add(new THREE.TorusGeometry(0.064, 0.0065, 14, 48, Math.PI), mHw, hx, H + 0.003, 0); h.scale.y = 0.5;
    for (const bx of [-0.064, 0.064]) add(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 20), mHw, hx + bx, H + 0.003, 0);
  }
  // fold-out tilt legs: two 50 × 55 mm plywood legs hinged under the front edge (shown when tilted)
  // The box leans back on its back feet; the legs, hinged 35 mm in from the front edge, are just long
  // enough to hold the front up at 15°.
  const TILT = -15 * Math.PI / 180, PIV = new THREE.Vector3(0, -0.008, -0.08), ZH = D / 2 - 0.035;
  const LEG = -PIV.y - (ZH - PIV.z) * Math.tan(TILT);
  const legs = new THREE.Group(); board.add(legs); legs.visible = false;
  for (const lx of [-0.3, 0.3]) {
    add(new RoundedBoxGeometry(0.04, LEG, 0.006, 2, 0.0025), mBody, lx, -LEG / 2, ZH, legs);
    add(new THREE.CylinderGeometry(0.003, 0.003, 0.04, 12), mHw, lx, -0.0015, ZH, legs).rotation.z = Math.PI / 2;
    add(new RoundedBoxGeometry(0.04, 0.004, 0.008, 2, 0.0018), mRubber, lx, -LEG, ZH, legs);
  }
  function setTilt(on) {
    const a = on ? TILT : 0, c = Math.cos(a), si = Math.sin(a);
    board.rotation.x = a; legs.visible = on;
    board.position.set(0, PIV.y - (PIV.y * c - PIV.z * si), PIV.z - (PIV.y * si + PIV.z * c));
  }
  // feet
  for (const fx of [-0.45, 0.45]) for (const fz of [-0.08, 0.08]) add(new THREE.CylinderGeometry(0.012, 0.014, 0.008, 24), mRubber, fx, -0.004, fz);

  function labelTex(text, w, h, color, font, track = 0) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.clearRect(0, 0, w, h); x.fillStyle = color; x.font = font; x.textBaseline = 'middle';
    const widths = [...text].map(ch => x.measureText(ch).width);
    const tw = widths.reduce((a, b) => a + b, 0) + track * (text.length - 1);
    let px = (w - tw) / 2;
    [...text].forEach((ch, i) => { x.fillText(ch, px, h / 2); px += widths[i] + track; });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }
  // the wordmark on the front border
  const mark = add(new THREE.PlaneGeometry(0.12, 0.012), new THREE.MeshBasicMaterial({ map: labelTex('POINT HUB', 1024, 104, '#7b8188', '600 64px "Instrument Sans", Arial, sans-serif', 26), transparent: true }), 0.405, 0.0155, D / 2 + 0.0024);
  mark.castShadow = false;

  // back panel (screwed on, the way in): two USB-C ports, horn plug, vents, six T20 screws
  const back = -D / 2;
  for (const p of [{ x: 0.39, c: 0xe0a800, t: 'POWER' }, { x: 0.45, c: 0x3b74ff, t: 'DATA' }]) {
    const slot = add(new RoundedBoxGeometry(0.0135, 0.0062, 0.004, 2, 0.0028), mDark, p.x, 0.045, back - 0.0004); slot.castShadow = false;
    const ring = add(new THREE.TorusGeometry(0.0105, 0.0014, 10, 36), new THREE.MeshStandardMaterial({ color: p.c, roughness: 0.4, emissive: p.c, emissiveIntensity: 0.18 }), p.x, 0.045, back - 0.001);
    ring.castShadow = false;
    const lab = add(new THREE.PlaneGeometry(0.05, 0.01), new THREE.MeshBasicMaterial({ map: labelTex(p.t, 400, 80, '#9aa0a7', '600 44px "Instrument Sans", Arial, sans-serif', 8), transparent: true }), p.x, 0.068, back - 0.0005);
    lab.rotation.y = Math.PI; lab.castShadow = false;
  }
  add(new THREE.CylinderGeometry(0.017, 0.017, 0.004, 32), mRubber, -0.38, 0.31, back - 0.0015).rotation.x = Math.PI / 2;
  for (let i = 0; i < 8; i++) add(new THREE.BoxGeometry(0.04, 0.008, 0.002), mDark, -0.19 + i * 0.055, 0.345, back - 0.0004).castShadow = false;
  for (const x of [-0.496, 0, 0.496]) for (const y of [0.014, H - 0.014]) add(new THREE.CylinderGeometry(0.0042, 0.0042, 0.0015, 20), mHw, x, y, back - 0.0006).rotation.x = Math.PI / 2;

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
  {
    const g = new THREE.Group(); scene.add(g); mounts.speaker = g;
    rod(new THREE.Vector3(0, -0.62, 0), new THREE.Vector3(0, 0, 0), 0.0175, mStand, g);
    rod(new THREE.Vector3(0, -1.24, 0), new THREE.Vector3(0, -0.6, 0), 0.0225, mStand, g);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + 0.5;
      rod(new THREE.Vector3(0, -0.98, 0), new THREE.Vector3(Math.cos(a) * 0.5, -1.3, Math.sin(a) * 0.5), 0.011, mStand, g);
    }
    floor(-1.3, g);
  }
  {
    const g = new THREE.Group(); scene.add(g); mounts.tripod = g;
    add(new THREE.BoxGeometry(0.07, 0.03, 0.07), mStand, 0, -0.015, 0, g);
    add(new THREE.SphereGeometry(0.022, 20, 14), mStand, 0, -0.045, 0, g);
    rod(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, -0.06, 0), 0.012, mStand, g);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + 0.3;
      rod(new THREE.Vector3(Math.cos(a) * 0.03, -0.29, Math.sin(a) * 0.03), new THREE.Vector3(Math.cos(a) * 0.32, -0.8, Math.sin(a) * 0.32), 0.013, mStand, g);
      rod(new THREE.Vector3(Math.cos(a) * 0.32, -0.8, Math.sin(a) * 0.32), new THREE.Vector3(Math.cos(a) * 0.55, -1.3, Math.sin(a) * 0.55), 0.009, mStand, g);
    }
    floor(-1.3, g);
  }

  // screens
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (canvas) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
  const screens = {
    match: async () => [ledify(drawMatch(), 192, 64), ledify(drawBench('L'), 32, 64), ledify(drawBench('R'), 32, 64)],
    idle: async () => { const f = await drawIdle(); const b = await drawIdleBench(); return [ledify(f, 192, 64), ledify(b, 32, 64), ledify(b, 32, 64)]; },
    test: async () => [ledify(drawTest(192, 64), 192, 64), ledify(drawTest(32, 64), 32, 64), ledify(drawTest(32, 64), 32, 64)],
  };
  async function setScreen(name) {
    const [f, l, r] = await screens[name]();
    for (const [mesh, c] of [[screen, f], [benchL, l], [benchR, r]]) {
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.map = tex(c); mesh.material.needsUpdate = true;
    }
  }
  function setMount(name) {
    const m = name === 'tilt' ? 'table' : name;
    for (const k in mounts) mounts[k].visible = k === m;
    setTilt(name === 'tilt');
  }

  const views = {
    front: [0, 0.2, 1.8], bench: [-1.5, 0.3, 0.62], tilt: [1.75, 0.16, 0.85], back: [0.95, 0.5, -1.55], three: [1.0, 0.55, 1.55], low: [1.1, -0.28, 1.95],
  };
  function setView(name) { goal = new THREE.Vector3(...views[name]); controls.autoRotate = false; }

  await setScreen('match'); setMount('studio');

  document.querySelectorAll('[data-screen]').forEach(b => b.addEventListener('click', () => { setScreen(b.dataset.screen); press(b); }));
  document.querySelectorAll('[data-mount]').forEach(b => b.addEventListener('click', () => {
    setMount(b.dataset.mount); press(b);
    if (b.dataset.mount === 'speaker' || b.dataset.mount === 'tripod') setView('low');
    if (b.dataset.mount === 'tilt') setView('tilt');
  }));
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
  if (statusEl) statusEl.textContent = 'Drag to turn · scroll or pinch to zoom';
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
