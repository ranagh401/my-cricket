/*
 * render-b.js  -  MY CRICKET, 3D renderer, variant B ("floodlit T20 final").
 *
 * ES module. Exposes window.Renderer and fires window 'renderer-ready' when loaded.
 *
 *   const r = Renderer(canvas);           // also works with `new`
 *
 * PUBLIC API (every method is safe in any order and any number of times; times are
 * performance.now() milliseconds and every animation is a pure function of the `now`
 * passed in, so a frozen clock renders a deterministic frame):
 *
 *   setMatch({ teams: [ { name, short, color, color2 }, { name, short, color, color2 } ] })
 *       Kit colours for slot 0 / slot 1 (match start and rematch).
 *   setScene({ battingSlot, bowlingSlot, striker: { name, hand:'R'|'L' },
 *              nonStriker: { name, hand }, bowler: { name, type:'fast'|'medium'|'spin' } })
 *       Who is on the field. A left-handed striker mirrors the batter and the line geometry.
 *   startDelivery(ev, t0)
 *       ev = { lineIndex:-1..3, turn:-1|0|1, length:'short'|'good'|'full',
 *              pace:'fast'|'slower'|'spin'|'arm', flightMs, lead, bowlerType }
 *       t0 = release instant. Run-up during the `lead` ms before t0; the ball is at the bat
 *       exactly at t0 + flightMs, pitching at the length's spot, drifting by `turn` after
 *       the bounce, and carrying on to the keeper if nothing else happens.
 *   swing(dir, now)                 dir = 'leg'|'straight'|'off' ('left'/'right' accepted)
 *   startResult(ev, now)            ev = { type:'runs'|'wicket', runs, wicketKind, contact,
 *                                          wide, shot:{dir,kind,timing}|null, ball:{...},
 *                                          fielderZone, commentary, decisionPending }
 *   showDecision('out'|'notout', now)
 *   startReview(data, now)          data = { kind:'lbw'|'caught', pitching, impact, wickets,
 *                                            ultraEdge, verdict, overturned, decision, durationMs }
 *   signal(kind, now)               'four'|'six'|'wide'|'noball'|'out'|'notout'
 *   celebrate(kind, now)            'six'|'four'|'wicket'|'win'
 *   idle()                          everything back to the start position, batting camera
 *   draw(now)                       render one frame
 *   resize()                        re-read the canvas CSS size
 *
 * World: metres. Striker's stumps at the origin, pitch along +z, bowler's stumps at
 * z = 20.12, the batter faces +z. The batting camera looks along +z, so (right-handed
 * three.js axes) +x is on the LEFT of the screen; a right-handed striker's leg side is the
 * TV-style screen-left = +x, mirrored (-x) for a left-hander. Line offsets at the stumps
 * are leg 0.25 / middle 0 / off -0.25 / wide 1.0 on the batter's own leg/off sign.
 *
 * Everything is procedural: canvas textures, box/cylinder rigs, instanced crowd. No files
 * other than ./vendor/three.module.js. DOM overlays (DRS boxes, UltraEdge, umpire inset)
 * are created inside canvas.parentElement and never touch anything outside it.
 */
'use strict';
import * as THREE from './vendor/three.module.js';

// =====================================================================================
// 1. Constants and small helpers
// =====================================================================================
const PITCH_LEN = 20.12;
const BAT_Z = 1.2;                                   // where the bat meets the ball
const BALL_R = 0.036;
const G = 9.81;
const PITCH_Z = { short: 11, good: 7, full: 3 };     // pitching distance from the striker's stumps
const BAT_H = { short: 1.2, good: 0.7, full: 0.3 };  // ball height at the bat
const LINE_OFF = [1.0, 0.25, 0, -0.25, -1.0];        // lineIndex -1..3, in "leg = +" units
const ROPE_RX = 62, ROPE_RZ = 68, FIELD_CZ = 10.06;  // boundary ellipse around the pitch centre
const DEG = Math.PI / 180;
const HIP_Y = 0.95;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const easeOut = (t) => { t = clamp01(t); return 1 - (1 - t) * (1 - t); };
const easeIn = (t) => { t = clamp01(t); return t * t; };
const easeInOut = (t) => { t = clamp01(t); return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < (s || '').length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function hexToRgb(hex, fallback) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return parseInt(s, 16);
}
function cssColor(n) { return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6); }
function mix(a, b, t) { // mix two 0xRRGGBB colours
  const ar = a >> 16 & 255, ag = a >> 8 & 255, ab = a & 255, br = b >> 16 & 255, bg = b >> 8 & 255, bb = b & 255;
  return (Math.round(lerp(ar, br, t)) << 16) | (Math.round(lerp(ag, bg, t)) << 8) | Math.round(lerp(ab, bb, t));
}
function ropeRadius(dx, dz) { // distance from the pitch centre to the rope along (dx, dz)
  const l = Math.hypot(dx, dz) || 1; const ux = dx / l, uz = dz / l;
  return 1 / Math.sqrt((ux * ux) / (ROPE_RX * ROPE_RX) + (uz * uz) / (ROPE_RZ * ROPE_RZ));
}

// =====================================================================================
// 2. Procedural textures (canvas generated, built once)
// =====================================================================================
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function canvasTex(c, srgb = true, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

function texOutfield() {
  const S = 2048, c = makeCanvas(S, S), g = c.getContext('2d');
  const toX = (x) => (0.5 + x / 200) * S, toY = (z) => (z + 90) / 200 * S;
  g.fillStyle = '#2f9a3c'; g.fillRect(0, 0, S, S);
  // mown stripes along z, 5 m wide, saturated under the lights
  for (let i = 0; i < 40; i++) {
    g.fillStyle = i % 2 ? '#36ab44' : '#2d9238';
    g.fillRect(toX(-100 + i * 5), 0, S / 40 + 1, S);
  }
  // soft noise
  const rnd = mulberry32(7);
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * 0.12;
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,200,${a})` : `rgba(0,40,0,${a})`;
    g.fillRect(x, y, 3 + rnd() * 6, 2 + rnd() * 4);
  }
  // 30-yard circle: two arcs of 27.4 m around each set of stumps joined by lines
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 3; g.setLineDash([22, 16]);
  g.beginPath();
  g.arc(toX(0), toY(0), 27.4 / 200 * S, Math.PI, 2 * Math.PI);                 // striker's end arc (z<0)
  g.arc(toX(0), toY(PITCH_LEN), 27.4 / 200 * S, 0, Math.PI);                  // bowler's end arc (z>20)
  g.closePath(); g.stroke();
  g.setLineDash([]);
  // beyond the rope: darker apron then a grey perimeter path
  g.save();
  g.beginPath(); g.rect(0, 0, S, S);
  g.ellipse(toX(0), toY(FIELD_CZ), ROPE_RX / 200 * S, ROPE_RZ / 200 * S, 0, 0, Math.PI * 2);
  g.fillStyle = '#1f6e2b'; g.fill('evenodd');
  g.restore();
  g.lineWidth = 2.2 / 200 * S; g.strokeStyle = '#6c7076';
  g.beginPath(); g.ellipse(toX(0), toY(FIELD_CZ), (ROPE_RX + 3.3) / 200 * S, (ROPE_RZ + 3.3) / 200 * S, 0, 0, Math.PI * 2); g.stroke();
  return canvasTex(c);
}

function texPitch() {
  const W = 256, H = 2048, c = makeCanvas(W, H), g = c.getContext('2d');
  const toX = (x) => (x + 1.525) / 3.05 * W, toY = (z) => (z + 2) / 24.12 * H;
  g.fillStyle = '#c9a96a'; g.fillRect(0, 0, W, H);
  const rnd = mulberry32(99);
  for (let i = 0; i < 9000; i++) {         // grain
    g.fillStyle = rnd() < 0.5 ? `rgba(255,240,200,${rnd() * 0.25})` : `rgba(90,60,20,${rnd() * 0.22})`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 6 + rnd() * 30);
  }
  // worn, darker patches on a good length at both ends and footmarks
  const patch = (z, x, rx, rz, a) => { g.fillStyle = `rgba(110,70,30,${a})`; g.beginPath(); g.ellipse(toX(x), toY(z), rx / 3.05 * W, rz / 24.12 * H, 0, 0, Math.PI * 2); g.fill(); };
  patch(7.5, 0, 0.9, 2.6, 0.22); patch(12.6, 0, 0.9, 2.6, 0.22);
  for (let i = 0; i < 14; i++) { patch(18.2 + rnd() * 1.2, -0.9 + rnd() * 0.5, 0.16, 0.3, 0.25); patch(1.9 - rnd() * 1.2, 0.9 - rnd() * 0.5, 0.16, 0.3, 0.2); }
  // cracks
  g.strokeStyle = 'rgba(80,50,20,0.45)'; g.lineWidth = 1;
  for (let i = 0; i < 60; i++) { let x = rnd() * W, y = rnd() * H; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 10; y += rnd() * 14; g.lineTo(x, y); } g.stroke(); }
  // creases (white): bowling crease 2.64 m at the stumps, popping crease 1.22 m in front, return creases
  g.strokeStyle = '#f7f7f2'; g.lineWidth = 5;
  const line = (x0, z0, x1, z1) => { g.beginPath(); g.moveTo(toX(x0), toY(z0)); g.lineTo(toX(x1), toY(z1)); g.stroke(); };
  for (const [zs, dir] of [[0, 1], [PITCH_LEN, -1]]) {
    line(-1.32, zs, 1.32, zs);                                   // bowling crease
    line(-1.6, zs + dir * 1.22, 1.6, zs + dir * 1.22);          // popping crease (full width)
    line(-1.32, zs - dir * 0.6, -1.32, zs + dir * 1.22);        // return creases
    line(1.32, zs - dir * 0.6, 1.32, zs + dir * 1.22);
  }
  return canvasTex(c);
}

function texCrowd(rnd) {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#1d2230'; g.fillRect(0, 0, S, S);
  const shirts = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#4361ee', '#f72585', '#ffffff', '#ffb703', '#8ecae6', '#06d6a0', '#ff6b6b', '#c77dff', '#3a86ff', '#fb5607'];
  const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
  const rows = 8, cols = 14;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5 + (r % 2) * 0.5) * S / cols, y = (r + 0.75) * S / rows;
      g.fillStyle = shirts[Math.floor(rnd() * shirts.length)];
      g.beginPath(); g.ellipse(x, y, S / cols * 0.42, S / rows * 0.34, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = skins[Math.floor(rnd() * skins.length)];
      g.beginPath(); g.arc(x, y - S / rows * 0.36, S / cols * 0.22, 0, Math.PI * 2); g.fill();
    }
  }
  return canvasTex(c, true, true);
}

function texGlow(inner = 1, soft = 0.25) {
  const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
  const r = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  r.addColorStop(0, `rgba(255,255,255,${inner})`);
  r.addColorStop(0.25, `rgba(255,250,230,${soft})`);
  r.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = r; g.fillRect(0, 0, S, S);
  return canvasTex(c, false);
}

function texBoards() {
  const names = ['MY CRICKET', 'T20 FINAL', 'VOLT ENERGY', 'NOVA MOBILE', 'AERO AIR', 'QUICKPAY', 'BLAZE COLA', 'ORBIT TYRES'];
  const cols = ['#d62828', '#1d4ed8', '#f59e0b', '#7c3aed', '#059669', '#0ea5e9', '#e11d48', '#111827'];
  const W = 2048, H = 128, c = makeCanvas(W, H), g = c.getContext('2d');
  for (let i = 0; i < 8; i++) {
    g.fillStyle = cols[i]; g.fillRect(i * 256, 0, 256, H);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(i * 256, 0, 256, 18);
    g.fillStyle = '#ffffff'; g.font = 'bold 54px Arial, Helvetica, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(names[i], i * 256 + 128, H / 2 + 4);
  }
  return canvasTex(c);
}

function texLamps() {
  const W = 128, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#20242a'; g.fillRect(0, 0, W, H);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    const r = g.createRadialGradient(x * 16 + 8, y * 16 + 8, 0, x * 16 + 8, y * 16 + 8, 8);
    r.addColorStop(0, '#ffffff'); r.addColorStop(0.5, '#fff6d0'); r.addColorStop(1, 'rgba(255,240,180,0)');
    g.fillStyle = r; g.fillRect(x * 16, y * 16, 16, 16);
  }
  return canvasTex(c);
}

function texSky() {
  const W = 16, H = 512, c = makeCanvas(W, H), g = c.getContext('2d');
  const r = g.createLinearGradient(0, 0, 0, H);           // y=0 is the top (zenith)
  r.addColorStop(0, '#04071a'); r.addColorStop(0.45, '#0a1540'); r.addColorStop(0.75, '#16306e'); r.addColorStop(1, '#2a4d8f');
  g.fillStyle = r; g.fillRect(0, 0, W, H);
  return canvasTex(c);
}

function texWood() {
  const W = 64, H = 256, c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#e4c48c'; g.fillRect(0, 0, W, H);
  const rnd = mulberry32(5);
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(120,80,30,${0.08 + rnd() * 0.18})`; g.fillRect(rnd() * W, 0, 1 + rnd() * 2, H); }
  return canvasTex(c);
}

function texSightscreen() {
  const S = 128, c = makeCanvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#0c0f16'; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1;
  for (let i = 0; i < S; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); }
  return canvasTex(c, true, true);
}

// Big screen: redrawn on setMatch / events; returns the canvas, ctx and texture together.
function makeScreen() {
  const W = 512, H = 288, c = makeCanvas(W, H), g = c.getContext('2d');
  const tex = canvasTex(c);
  function paint(teams, headline, sub) {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1230'); bg.addColorStop(1, '#1a2b6b');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.06)'; for (let i = 0; i < H; i += 6) g.fillRect(0, i, W, 2);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffd166'; g.font = 'bold 30px Arial, Helvetica, sans-serif'; g.fillText('MY CRICKET  •  T20 FINAL', W / 2, 36);
    const t0 = teams[0] || {}, t1 = teams[1] || {};
    const block = (t, x) => {
      g.fillStyle = cssColor(hexToRgb(t.color, 0x2255cc)); g.fillRect(x - 92, 70, 184, 64);
      g.fillStyle = cssColor(hexToRgb(t.color2, 0xffffff)); g.fillRect(x - 92, 70, 184, 8);
      g.fillStyle = '#ffffff'; g.font = 'bold 44px Arial, Helvetica, sans-serif'; g.fillText((t.short || t.name || '???').slice(0, 4).toUpperCase(), x, 106);
    };
    block(t0, 150); block(t1, 362);
    g.fillStyle = '#ffffff'; g.font = 'bold 34px Arial, Helvetica, sans-serif'; g.fillText('v', W / 2, 104);
    g.fillStyle = '#ffffff'; g.font = 'bold 64px Arial, Helvetica, sans-serif'; g.fillText(headline || '', W / 2, 190);
    g.fillStyle = '#9fd3ff'; g.font = '24px Arial, Helvetica, sans-serif'; g.fillText(sub || '', W / 2, 252);
    tex.needsUpdate = true;
  }
  return { canvas: c, tex, paint };
}

// =====================================================================================
// 3. Geometry helpers
// =====================================================================================
// A band between two concentric ellipses (inner at y0, outer at y1): tiers, walls, roofs.
function bandGeometry(rx0, rz0, y0, rx1, rz1, y1, segs, repeatU, cx = 0, cz = FIELD_CZ) {
  const pos = new Float32Array((segs + 1) * 2 * 3), uv = new Float32Array((segs + 1) * 2 * 2);
  const idx = new Uint32Array(segs * 6);
  for (let i = 0; i <= segs; i++) {
    const a = i / segs * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    pos.set([cx + rx0 * ca, y0, cz + rz0 * sa], i * 6);
    pos.set([cx + rx1 * ca, y1, cz + rz1 * sa], i * 6 + 3);
    uv.set([i / segs * repeatU, 0, i / segs * repeatU, 1], i * 4);
    if (i < segs) { const b = i * 2; idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// Merge non-indexed geometries (position/normal/uv) into one.
function mergeGeoms(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of parts) {
    const c = p.attributes.position.count;
    pos.set(p.attributes.position.array, o * 3);
    if (p.attributes.normal) nor.set(p.attributes.normal.array, o * 3);
    if (p.attributes.uv) uv.set(p.attributes.uv.array, o * 2);
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function placed(geom, x, y, z, rx = 0, ry = 0, rz = 0, s = 1) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));
  return geom.clone().applyMatrix4(m);
}

// =====================================================================================
// 4. Stadium
// =====================================================================================
function buildStadium(scene, rnd, uTime, uWave) {
  const S = {};
  const RX = ROPE_RX, RZ = ROPE_RZ, CZ = FIELD_CZ;

  // sky + stars
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(600, 24, 12), new THREE.MeshBasicMaterial({ map: texSky(), side: THREE.BackSide, fog: false })));
  {
    const n = 420, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const a = rnd() * Math.PI * 2, e = 0.15 + rnd() * 1.3; p.set([Math.cos(a) * Math.cos(e) * 560, Math.sin(e) * 560, CZ + Math.sin(a) * Math.cos(e) * 560], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.8 })));
  }

  // ground + pitch
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ map: texOutfield() }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, 10); ground.receiveShadow = true; scene.add(ground);
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 24.12), new THREE.MeshLambertMaterial({ map: texPitch() }));
  pitch.rotation.x = -Math.PI / 2; pitch.position.set(0, 0.015, 10.06); pitch.receiveShadow = true; scene.add(pitch);

  // boundary rope
  {
    const pts = []; for (let i = 0; i < 160; i++) { const a = i / 160 * Math.PI * 2; pts.push(new THREE.Vector3(RX * Math.cos(a), 0.09, CZ + RZ * Math.sin(a))); }
    const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 240, 0.09, 6, true), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x333333 }));
    scene.add(rope);
  }

  // LED sponsor boards around the rope (one merged geometry, atlas tiles)
  {
    const N = 64, pos = new Float32Array(N * 6 * 3), uv = new Float32Array(N * 6 * 2), nor = new Float32Array(N * 6 * 3);
    for (let i = 0; i < N; i++) {
      const a0 = i / N * Math.PI * 2 + 0.004, a1 = (i + 1) / N * Math.PI * 2 - 0.004, rx = RX + 2.6, rz = RZ + 2.6;
      const p = (a, y) => [rx * Math.cos(a) + (y * 0.18) * Math.cos(a), y, CZ + rz * Math.sin(a) + (y * 0.18) * Math.sin(a)];
      const A = p(a0, 0.05), B = p(a1, 0.05), C = p(a1, 1.05), D = p(a0, 1.05), t = (i % 8) / 8;
      pos.set([...A, ...C, ...B, ...A, ...D, ...C], i * 18);
      uv.set([t, 0, t + 1 / 8, 1, t + 1 / 8, 0, t, 0, t, 1, t + 1 / 8, 1], i * 12);
      const am = (a0 + a1) / 2; for (let k = 0; k < 6; k++) nor.set([-Math.cos(am), 0.2, -Math.sin(am)], i * 18 + k * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texBoards(), side: THREE.DoubleSide })));
  }

  // stands: wall, tier 1, walkway, tier 2, back wall, roof, fascia
  const crowdTex = texCrowd(rnd);
  const crowdMat = new THREE.MeshLambertMaterial({ map: crowdTex, emissive: 0xffffff, emissiveMap: crowdTex, emissiveIntensity: 0.35, side: THREE.DoubleSide });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c2436, side: THREE.DoubleSide });
  const grey = new THREE.MeshLambertMaterial({ color: 0x6b7280, side: THREE.DoubleSide });
  const roofMat = new THREE.MeshBasicMaterial({ color: 0xd9dee6, side: THREE.DoubleSide });
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); scene.add(m); return m; };
  add(bandGeometry(RX + 3.6, RZ + 3.6, 0, RX + 5.8, RZ + 5.8, 1.6, 96, 1), new THREE.MeshLambertMaterial({ color: 0x27346b, side: THREE.DoubleSide }));
  const tier1 = { r0: RX + 5.8, y0: 1.6, r1: RX + 23, y1: 11 };
  const tier2 = { r0: RX + 26, y0: 13, r1: RX + 42, y1: 24.5 };
  add(bandGeometry(tier1.r0, tier1.r0 + (RZ - RX), tier1.y0, tier1.r1, tier1.r1 + (RZ - RX), tier1.y1, 128, 56), crowdMat);
  add(bandGeometry(RX + 23, RZ + 23, 11, RX + 26, RZ + 26, 11, 96, 1), grey);
  add(bandGeometry(RX + 26, RZ + 26, 11, RX + 26, RZ + 26, 13, 96, 1), dark);
  add(bandGeometry(tier2.r0, tier2.r0 + (RZ - RX), tier2.y0, tier2.r1, tier2.r1 + (RZ - RX), tier2.y1, 128, 64), crowdMat);
  add(bandGeometry(RX + 42, RZ + 42, 24.5, RX + 42, RZ + 42, 27.5, 96, 1), dark);
  add(bandGeometry(RX + 24, RZ + 24, 27, RX + 45, RZ + 45, 30.5, 96, 1), roofMat);
  add(bandGeometry(RX + 45, RZ + 45, 30.5, RX + 45, RZ + 45, 33, 96, 1), new THREE.MeshLambertMaterial({ color: 0x111827, side: THREE.DoubleSide }));
  {
    const cols = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.55, 0.55, 29, 8), new THREE.MeshLambertMaterial({ color: 0xb8c0cc }), 32);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 32; i++) { const a = i / 32 * Math.PI * 2; m.makeTranslation((RX + 41) * Math.cos(a), 14.5, CZ + (RZ + 41) * Math.sin(a)); cols.setMatrixAt(i, m); }
    scene.add(cols);
  }

  // instanced 3D crowd on both tiers (one draw call) with a cheap vertex-shader bob
  const PAL = [0xe63946, 0xf4a261, 0x2a9d8f, 0xe9c46a, 0x4361ee, 0xf72585, 0xffffff, 0xffb703, 0x8ecae6, 0x06d6a0, 0xc77dff, 0x3a86ff];
  const personGeo = mergeGeoms([
    placed(new THREE.BoxGeometry(0.5, 0.75, 0.35), 0, 0.42, 0),
    placed(new THREE.IcosahedronGeometry(0.17, 0), 0, 0.98, 0),
  ]);
  const spots = [];
  for (const tier of [tier1, tier2]) {
    const rows = 9;
    for (let r = 0; r < rows; r++) {
      const v = (r + 0.5) / rows, rx = lerp(tier.r0, tier.r1, v), rz = rx + (RZ - RX), y = lerp(tier.y0, tier.y1, v) + 0.1;
      const count = Math.floor(Math.PI * (rx + rz) / 2.3);
      for (let i = 0; i < count; i++) {
        const a = (i + rnd() * 0.6) / count * Math.PI * 2;
        spots.push({ x: rx * Math.cos(a), y, z: CZ + rz * Math.sin(a), a, s: 0.85 + rnd() * 0.3 });
      }
    }
  }
  const crowdInst = new THREE.InstancedMesh(personGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.22 }), spots.length);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    spots.forEach((sp, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -sp.a + Math.PI / 2 + Math.PI);
      p.set(sp.x, sp.y, sp.z); s.set(sp.s, sp.s, sp.s); m.compose(p, q, s); crowdInst.setMatrixAt(i, m);
      c.setHex(PAL[Math.floor(rnd() * PAL.length)]); crowdInst.setColorAt(i, c);
    });
    crowdInst.material.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime; sh.uniforms.uWave = uWave;
      sh.vertexShader = 'uniform float uTime;\nuniform float uWave;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n#ifdef USE_INSTANCING\n float ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.23;\n transformed.y += uWave * max(0.0, sin(uTime * 7.0 + ph)) * 0.45;\n#endif\n');
    };
    scene.add(crowdInst);
  }
  // small waving flags in the crowd, coloured by team (recoloured in setMatch)
  const flags = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.1, 0.7), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 180);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), c = new THREE.Color();
    for (let i = 0; i < 180; i++) {
      const sp = spots[Math.floor(rnd() * spots.length)];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -sp.a + Math.PI / 2 + Math.PI + 0.6);
      p.set(sp.x, sp.y + 1.9, sp.z); m.compose(p, q, s); flags.setMatrixAt(i, m);
      c.setHex(i % 2 ? 0xffd166 : 0x4cc9f0); flags.setColorAt(i, c);
    }
    flags.material.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n#ifdef USE_INSTANCING\n float fp = instanceMatrix[3][0] * 0.5 + instanceMatrix[3][2] * 0.3;\n transformed.z += sin(uTime * 9.0 + fp + uv.x * 5.0) * 0.14 * uv.x;\n transformed.y += sin(uTime * 7.0 + fp) * 0.05;\n#endif\n');
    };
    scene.add(flags);
  }
  S.flags = flags;
  // crowd camera-flash sparkles (only lit during celebrations)
  {
    const n = 360, p = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const sp = spots[Math.floor(rnd() * spots.length)]; p.set([sp.x, sp.y + 1.2, sp.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    S.flashes = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, vertexColors: true, map: texGlow(1, 0.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    S.flashes.visible = false; scene.add(S.flashes);
  }

  // floodlight towers: mast, lamp head, two additive glows and a faint beam
  const glowTex = texGlow(1, 0.3), lampTex = texLamps();
  S.towerHeads = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2, x = (RX + 36) * Math.cos(a), z = CZ + (RZ + 36) * Math.sin(a);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.4, 52, 8), new THREE.MeshLambertMaterial({ color: 0x9aa4b3 }));
    mast.position.set(x, 26, z); scene.add(mast);
    const head = new THREE.Group(); head.position.set(x, 52, z); head.lookAt(0, 0, CZ); scene.add(head);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(8, 4.5, 0.8), new THREE.MeshBasicMaterial({ map: lampTex }));
    head.add(panel);
    const big = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff2c8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }));
    big.scale.set(40, 40, 1); head.add(big);
    const small = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    small.scale.set(14, 14, 1); head.add(small);
    const L = Math.hypot(x, 52, z - CZ);
    const beamGeo = new THREE.ConeGeometry(26, L, 20, 1, true); beamGeo.translate(0, -L / 2, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0xfff1c0, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(x, 52, z);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-x, -52, CZ - z).normalize());
    scene.add(beam);
    S.towerHeads.push(head);
  }

  // big screen on top of the far stand, sightscreens at both ends
  S.screen = makeScreen();
  {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(23.5, 14, 1.2), new THREE.MeshLambertMaterial({ color: 0x0b0f1a }));
    const face = new THREE.Mesh(new THREE.BoxGeometry(22, 12.4, 0.4), new THREE.MeshBasicMaterial({ map: S.screen.tex }));
    const g = new THREE.Group(); g.add(frame); face.position.z = -0.66; g.add(face);
    g.position.set(30, 31, CZ + RZ + 40); g.rotation.y = Math.atan2(30, RZ + 40);   // local -z (the face) looks at the pitch
    scene.add(g);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(2, 10, 2), new THREE.MeshLambertMaterial({ color: 0x1f2937 }));
    legs.position.set(30, 25, CZ + RZ + 41); scene.add(legs);
  }
  {
    const ssMat = new THREE.MeshLambertMaterial({ map: texSightscreen() });
    for (const zz of [CZ + RZ + 1.4, CZ - RZ - 1.4]) {
      const ss = new THREE.Mesh(new THREE.BoxGeometry(10, 6.5, 0.4), ssMat); ss.position.set(0, 3.25, zz); scene.add(ss);
    }
  }
  return S;
}

// Stumps: three stumps and two bails as separate meshes (the striker's end can shatter).
function makeStumps() {
  const g = new THREE.Group();
  const stumpGeo = new THREE.CylinderGeometry(0.018, 0.016, 0.711, 8); stumpGeo.translate(0, 0.3555, 0);
  const bailGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.11, 6); bailGeo.rotateZ(Math.PI / 2);
  const stumpMat = new THREE.MeshLambertMaterial({ color: 0xf5e6bf });
  const bailMat = new THREE.MeshLambertMaterial({ color: 0xe9cf8c });
  const stumps = [], bails = [];
  for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(stumpGeo, stumpMat); m.position.x = (i - 1) * 0.114; m.castShadow = true; g.add(m); stumps.push(m); }
  for (let i = 0; i < 2; i++) { const m = new THREE.Mesh(bailGeo, bailMat); m.position.set((i - 0.5) * 0.114, 0.72, 0); g.add(m); bails.push(m); }
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.07, 0.045), new THREE.MeshLambertMaterial({ color: 0x1d4ed8 }));
  band.position.y = 0.52; g.add(band);
  return { group: g, stumps, bails, band };
}

// =====================================================================================
// 5. Figures: a low-poly articulated rig, poses (degrees) and keyframe animations
// =====================================================================================
// Pose layout (Float32Array(40)): 12 joints x [rx, ry, rz] in degrees, then
// [36] hips y offset, [37] hips x offset, [38] hips z offset (metres, local).
// Joints: 0 hips(whole body) 1 torso 2 head 3 lSh 4 rSh 5 lEl 6 rEl 7 lHip 8 rHip 9 lKnee 10 rKnee 11 bat
// Conventions (figure faces local +z): shoulder/hip rx<0 raises the limb forward, knee rx>0
// bends, elbow rx<0 bends, rz moves a limb sideways (+ towards local +x = the figure's left).
const JN = { hp: 0, to: 1, hd: 2, ls: 3, rs: 4, le: 5, re: 6, lh: 7, rh: 8, lk: 9, rk: 10, bt: 11 };
function P(o, base) {
  const a = new Float32Array(40);
  if (base) a.set(base);
  for (const k in o) {
    if (k === 'y') a[36] = o[k]; else if (k === 'x') a[37] = o[k]; else if (k === 'z') a[38] = o[k];
    else { const j = JN[k] * 3, v = o[k]; a[j] = v[0] || 0; a[j + 1] = v[1] || 0; a[j + 2] = v[2] || 0; }
  }
  return a;
}
function anim(keys, loop = false) {
  return { t: keys.map((k) => k[0]), p: keys.map((k) => k[1]), loop, n: keys.length };
}
// Writes the interpolated pose at u (0..1, wraps when looping) into out.
function sampleAnim(a, u, out) {
  if (a.loop) { u = u - Math.floor(u); } else u = clamp01(u);
  const t = a.t, n = a.n;
  let i = 0; while (i < n - 2 && u >= t[i + 1]) i++;
  const span = t[i + 1] - t[i] || 1, s = smooth((u - t[i]) / span), p0 = a.p[i], p1 = a.p[i + 1];
  for (let k = 0; k < 40; k++) out[k] = p0[k] + (p1[k] - p0[k]) * s;
}
function lerpPose(a, b, s, out) { for (let k = 0; k < 40; k++) out[k] = a[k] + (b[k] - a[k]) * s; }

const POSES = {};
const ANIMS = {};
{
  const stand = P({ ls: [0, 0, 8], rs: [0, 0, -8], le: [-12, 0, 0], re: [-12, 0, 0] });
  POSES.stand = stand;
  POSES.ready = P({ hp: [18, 0, 0], lh: [-22, 0, 8], rh: [-22, 0, -8], lk: [30, 0, 0], rk: [30, 0, 0], ls: [-45, 0, 15], rs: [-45, 0, -15], le: [-70, 0, 0], re: [-70, 0, 0], hd: [-18, 0, 0], y: -0.08 });
  POSES.hips = P({ ls: [10, 0, 38], rs: [10, 0, -38], le: [-110, 0, -50], re: [-110, 0, 50] });
  POSES.watch = P({ hd: [-28, 0, 0], ls: [0, 0, 10], rs: [0, 0, -10], le: [-20, 0, 0], re: [-20, 0, 0] });
  POSES.pickup = P({ hp: [62, 0, 0], lk: [40, 0, 0], rk: [40, 0, 0], lh: [-20, 0, 6], rh: [-20, 0, -6], ls: [-70, 0, 10], rs: [-70, 0, -10], le: [-20, 0, 0], re: [-20, 0, 0], hd: [-30, 0, 0], y: -0.12 });
  POSES.catch = P({ ls: [-125, 0, 15], rs: [-125, 0, -15], le: [-45, 0, 0], re: [-45, 0, 0], hd: [-25, 0, 0], lk: [15, 0, 0], rk: [15, 0, 0], y: -0.03 });
  POSES.catchHigh = P({ ls: [-170, 0, 12], rs: [-170, 0, -12], le: [-20, 0, 0], re: [-20, 0, 0], hd: [-40, 0, 0], lk: [10, 0, 0], rk: [10, 0, 0], y: 0.12 });
  POSES.appeal = P({ ls: [-165, 0, 35], rs: [-165, 0, -35], le: [-25, 0, 0], re: [-25, 0, 0], hd: [-25, 0, 0], to: [-12, 0, 0], lk: [12, 0, 0], rk: [12, 0, 0], y: 0.12 });
  POSES.celebrate = P({ ls: [-175, 0, 30], rs: [-175, 0, -30], le: [-15, 0, 0], re: [-15, 0, 0], hd: [-20, 0, 0], lk: [25, 0, 0], rk: [25, 0, 0], lh: [-15, 0, 0], rh: [-15, 0, 0], y: 0.22 });
  POSES.slump = P({ to: [22, 0, 0], hd: [25, 0, 0], ls: [10, 0, 38], rs: [10, 0, -38], le: [-110, 0, -50], re: [-110, 0, 50] });
  // run cycle (loop)
  const r0 = P({ lh: [-42, 0, 0], rh: [28, 0, 0], lk: [12, 0, 0], rk: [60, 0, 0], ls: [38, 0, 6], rs: [-48, 0, -6], le: [-35, 0, 0], re: [-85, 0, 0], to: [12, 0, 0] });
  const r1 = P({ lh: [-8, 0, 0], rh: [-4, 0, 0], lk: [28, 0, 0], rk: [75, 0, 0], ls: [0, 0, 6], rs: [0, 0, -6], le: [-55, 0, 0], re: [-55, 0, 0], to: [12, 0, 0], y: -0.04 });
  const r2 = P({ lh: [28, 0, 0], rh: [-42, 0, 0], lk: [60, 0, 0], rk: [12, 0, 0], ls: [-48, 0, 6], rs: [38, 0, -6], le: [-85, 0, 0], re: [-35, 0, 0], to: [12, 0, 0] });
  const r3 = P({ lh: [-4, 0, 0], rh: [-8, 0, 0], lk: [75, 0, 0], rk: [28, 0, 0], ls: [0, 0, 6], rs: [0, 0, -6], le: [-55, 0, 0], re: [-55, 0, 0], to: [12, 0, 0], y: -0.04 });
  ANIMS.run = anim([[0, r0], [0.25, r1], [0.5, r2], [0.75, r3], [1, r0]], true);
  const bat = { rs: [-10, 0, -20], re: [-30, 0, 0], bt: [65, 0, 0] };
  ANIMS.runBat = anim([[0, P(bat, r0)], [0.25, P(bat, r1)], [0.5, P(bat, r2)], [0.75, P(bat, r3)], [1, P(bat, r0)]], true);
  const j = (p) => { const q = new Float32Array(p); for (let k = 0; k < 36; k++) q[k] *= 0.55; q[36] *= 0.5; return q; };
  ANIMS.jog = anim([[0, j(r0)], [0.25, j(r1)], [0.5, j(r2)], [0.75, j(r3)], [1, j(r0)]], true);
  ANIMS.jogBat = anim([[0, P(bat, j(r0))], [0.25, P(bat, j(r1))], [0.5, P(bat, j(r2))], [0.75, P(bat, j(r3))], [1, P(bat, j(r0))]], true);
  ANIMS.stand = anim([[0, stand], [1, stand]]);
  ANIMS.ready = anim([[0, POSES.ready], [1, POSES.ready]]);

  // bowling action: u 0..1 over the action window, release at u = 0.5
  ANIMS.bowl = anim([
    [0.00, P({ to: [10, 0, 0], ls: [-150, 0, 10], rs: [-150, 0, -10], le: [-20, 0, 0], re: [-20, 0, 0], lh: [-30, 0, 0], rh: [20, 0, 0], lk: [40, 0, 0], rk: [60, 0, 0], y: 0.1 })],
    [0.15, P({ to: [0, 35, 0], ls: [-165, 0, 20], rs: [50, 0, -10], le: [-10, 0, 0], re: [-10, 0, 0], lh: [-10, 0, 0], rh: [40, 0, 0], lk: [70, 0, 0], rk: [90, 0, 0], y: 0.3 })],
    [0.30, P({ to: [-6, 35, 0], ls: [-150, 0, 20], rs: [110, 0, -10], le: [-20, 0, 0], re: [0, 0, 0], lh: [-50, 0, 0], rh: [15, 0, 0], lk: [10, 0, 0], rk: [70, 0, 0], y: -0.02 })],
    [0.42, P({ to: [15, 10, 0], ls: [-80, 0, 20], rs: [140, 0, -5], le: [-70, 0, 0], re: [0, 0, 0], lh: [-45, 0, 0], rh: [25, 0, 0], lk: [5, 0, 0], rk: [50, 0, 0], y: -0.05 })],
    [0.50, P({ to: [25, -10, 0], ls: [10, 0, 10], rs: [195, 0, -5], le: [-60, 0, 0], re: [0, 0, 0], lh: [-30, 0, 0], rh: [10, 0, 0], lk: [15, 0, 0], rk: [40, 0, 0], y: -0.08 })],
    [0.62, P({ to: [45, -30, 0], ls: [30, 0, 10], rs: [290, 0, -30], le: [-40, 0, 0], re: [-20, 0, 0], lh: [-15, 0, 0], rh: [-25, 0, 0], lk: [35, 0, 0], rk: [60, 0, 0], y: -0.1 })],
    [0.80, P({ to: [25, -10, 0], ls: [10, 0, 10], rs: [335, 0, -20], le: [-30, 0, 0], re: [-40, 0, 0], lh: [25, 0, 0], rh: [-30, 0, 0], lk: [45, 0, 0], rk: [20, 0, 0], y: -0.04 })],
    [1.00, P({ to: [12, 0, 0], ls: [0, 0, 8], rs: [372, 0, -8], le: [-20, 0, 0], re: [-20, 0, 0], lh: [-20, 0, 0], rh: [20, 0, 0], lk: [20, 0, 0], rk: [40, 0, 0] })],
  ]);

  // batter (local frame: chest -> +z = off side, bowler at +x, leg side -z)
  const stance = P({ to: [22, 0, 0], hd: [-10, 68, 0], ls: [-40, 0, -30], rs: [-18, 0, -12], le: [-70, 0, 0], re: [-40, 0, 0], lh: [-6, 0, 14], rh: [-6, 0, -16], lk: [22, 0, 0], rk: [24, 0, 0], bt: [36, 0, -18], y: -0.05 });
  const backlift = P({ to: [24, 8, 0], hd: [-10, 68, 0], ls: [-55, 0, -30], rs: [-50, 0, -10], le: [-90, 0, 0], re: [-70, 0, 0], lh: [-6, 0, 14], rh: [-6, 0, -16], lk: [22, 0, 0], rk: [26, 0, 0], bt: [-84, 0, -45], y: -0.06 });
  POSES.stance = stance; POSES.backlift = backlift;
  ANIMS.stance = anim([[0, stance], [1, stance]]);
  ANIMS.ready_bat = anim([[0, stance], [1, backlift]]);
  const mk = (keys) => anim(keys);
  // every shot: 0 backlift -> 0.14 contact -> follow-through -> 1 back to the stance.
  // Bat rx is chosen so that torso.rx + shoulder.rx + elbow.rx + bat.rx gives the wanted blade angle.
  const driveC = P({ to: [30, 25, 0], hd: [-10, 60, 0], ls: [-30, 0, 60], rs: [-30, 0, 40], le: [-10, 0, 0], re: [-20, 0, 0], lh: [-48, 0, 10], rh: [10, 0, -12], lk: [12, 0, 0], rk: [34, 0, 0], bt: [20, 0, -20], y: -0.1, x: 0.25 });
  const driveF = P({ to: [20, 40, 0], hd: [-12, 50, 0], ls: [-110, 0, 30], rs: [-120, 0, 20], le: [-40, 0, 0], re: [-60, 0, 0], lh: [-48, 0, 10], rh: [16, 0, -12], lk: [12, 0, 0], rk: [36, 0, 0], bt: [-20, 0, -30], y: -0.1, x: 0.25 });
  ANIMS.drive = mk([[0, backlift], [0.14, driveC], [0.42, driveF], [0.7, driveF], [1, stance]]);
  const flickC = P({ to: [26, -10, 0], hd: [-8, 70, 0], ls: [-46, 0, 50], rs: [-36, 0, 50], le: [-20, 0, 0], re: [-20, 0, 0], bt: [55, 0, 17], x: 0.2, y: -0.08, lh: [-40, 0, 10], rh: [8, 0, -12], lk: [14, 0, 0], rk: [30, 0, 0] });
  const flickF = P({ to: [18, -40, 0], hd: [-8, 80, 0], ls: [-120, 0, 20], rs: [-110, 0, 30], le: [-60, 0, 0], re: [-60, 0, 0], bt: [-87, 0, -17], x: 0.2, y: -0.08, lh: [-36, 0, 10], rh: [12, 0, -12], lk: [14, 0, 0], rk: [30, 0, 0] });
  ANIMS.flick = mk([[0, backlift], [0.14, flickC], [0.42, flickF], [0.7, flickF], [1, stance]]);
  const pullC = P({ to: [18, -30, 0], hd: [-8, 76, 0], ls: [-80, 0, 40], rs: [-80, 0, 30], le: [-10, 0, 0], re: [-10, 0, 0], bt: [7, 0, 64], x: -0.12, y: -0.08, lh: [-8, 0, 16], rh: [-20, 0, -14], lk: [30, 0, 0], rk: [24, 0, 0] });
  const pullF = P({ to: [10, -70, 0], hd: [-8, 90, 0], ls: [-95, 0, -30], rs: [-100, 0, 40], le: [-70, 0, 0], re: [-50, 0, 0], bt: [-112, 0, -17], x: -0.12, y: -0.08, lh: [-8, 0, 16], rh: [-20, 0, -14], lk: [30, 0, 0], rk: [24, 0, 0] });
  ANIMS.pull = mk([[0, backlift], [0.14, pullC], [0.42, pullF], [0.7, pullF], [1, stance]]);
  const cutC = P({ to: [30, 30, 0], hd: [-8, 56, 0], ls: [-80, 0, 70], rs: [-80, 0, 20], le: [-10, 0, 0], re: [-10, 0, 0], bt: [-17, 0, 30], x: -0.1, y: -0.1, lh: [-8, 0, 16], rh: [-24, 0, -14], lk: [34, 0, 0], rk: [26, 0, 0] });
  const cutF = P({ to: [24, 60, 0], hd: [-8, 40, 0], ls: [-100, 0, 80], rs: [-100, 0, 60], le: [-20, 0, 0], re: [-30, 0, 0], bt: [-3, 0, -24], x: -0.1, y: -0.1, lh: [-8, 0, 16], rh: [-24, 0, -14], lk: [34, 0, 0], rk: [26, 0, 0] });
  ANIMS.cut = mk([[0, backlift], [0.14, cutC], [0.42, cutF], [0.7, cutF], [1, stance]]);
  const defC = P({ to: [34, 14, 0], hd: [-12, 62, 0], ls: [-45, 0, 50], rs: [-45, 0, 30], le: [-40, 0, 0], re: [-40, 0, 0], lh: [-44, 0, 10], rh: [8, 0, -12], lk: [14, 0, 0], rk: [34, 0, 0], bt: [39, 0, 12], y: -0.1, x: 0.18 });
  ANIMS.defend = mk([[0, backlift], [0.14, defC], [0.5, defC], [1, stance]]);
  const loftC = P({ to: [16, 30, 0], hd: [-16, 60, 0], ls: [-50, 0, 60], rs: [-50, 0, 40], le: [-10, 0, 0], re: [-20, 0, 0], lh: [-30, 0, 10], rh: [4, 0, -28], lk: [10, 0, 0], rk: [40, 0, 0], bt: [5, 0, 37], y: -0.06, x: 0.1 });
  const loftF = P({ to: [-8, 50, 0], hd: [-35, 40, 0], ls: [-160, 0, 40], rs: [-150, 0, 10], le: [-30, 0, 0], re: [-60, 0, 0], lh: [-30, 0, 10], rh: [10, 0, -28], lk: [10, 0, 0], rk: [40, 0, 0], bt: [26, 0, -12], y: -0.02, x: 0.1 });
  ANIMS.loft = mk([[0, backlift], [0.14, loftC], [0.42, loftF], [0.72, loftF], [1, stance]]);
  const raise = P({ to: [0, 10, 0], hd: [-20, 50, 0], ls: [-160, 0, 20], rs: [-150, 0, -20], le: [-20, 0, 0], re: [-20, 0, 0], lh: [0, 0, 12], rh: [0, 0, -12], lk: [5, 0, 0], rk: [5, 0, 0], bt: [-10, 0, 0] });
  ANIMS.raiseBat = anim([[0, stance], [0.3, raise], [1, raise]]);
  const padHit = P({ to: [28, 20, 0], hd: [-14, 90, 0], ls: [-60, 0, -20], rs: [-60, 0, -10], le: [-90, 0, 0], re: [-90, 0, 0], lh: [-30, 0, 14], rh: [-6, 0, -16], lk: [40, 0, 0], rk: [24, 0, 0], bt: [-58, 0, -45], y: -0.08, x: 0.12 });
  const padLook = P({ to: [10, 60, 0], hd: [0, 30, 0], ls: [-20, 0, 20], rs: [-20, 0, -20], le: [-60, 0, 0], re: [-60, 0, 0], lh: [0, 0, 12], rh: [0, 0, -12], lk: [10, 0, 0], rk: [10, 0, 0], bt: [70, 0, 0] });
  ANIMS.padHit = anim([[0, backlift], [0.1, padHit], [0.45, padHit], [0.7, padLook], [1, padLook]]);
  const beaten = P({ to: [26, 20, 0], hd: [-6, 20, 0], ls: [-40, 0, 50], rs: [-34, 0, 30], le: [-50, 0, 0], re: [-50, 0, 0], lh: [-30, 0, 12], rh: [0, 0, -14], lk: [20, 0, 0], rk: [26, 0, 0], bt: [38, 0, 10], y: -0.08 });
  ANIMS.beaten = anim([[0, backlift], [0.2, beaten], [0.6, beaten], [1, stance]]);
  const walk = P({ to: [8, 0, 0], hd: [12, 0, 0], ls: [10, 0, 10], rs: [10, 0, -10], le: [-20, 0, 0], re: [-20, 0, 0], bt: [2, 0, 0] });
  ANIMS.walkOff = anim([[0, walk], [1, walk]]);

  // keeper
  const crouch = P({ hp: [34, 0, 0], hd: [-40, 0, 0], lh: [-78, 0, 18], rh: [-78, 0, -18], lk: [118, 0, 0], rk: [118, 0, 0], ls: [-50, 0, 28], rs: [-50, 0, -28], le: [-80, 0, 0], re: [-80, 0, 0], y: -0.46 });
  const take = P({ hp: [20, 0, 0], hd: [-25, 0, 0], lh: [-40, 0, 16], rh: [-40, 0, -16], lk: [60, 0, 0], rk: [60, 0, 0], ls: [-85, 0, 12], rs: [-85, 0, -12], le: [-60, 0, 0], re: [-60, 0, 0], y: -0.22 });
  const takeHigh = P({ hp: [6, 0, 0], hd: [-25, 0, 0], lh: [-20, 0, 16], rh: [-20, 0, -16], lk: [30, 0, 0], rk: [30, 0, 0], ls: [-130, 0, 12], rs: [-130, 0, -12], le: [-40, 0, 0], re: [-40, 0, 0], y: -0.08 });
  POSES.crouch = crouch;
  ANIMS.crouch = anim([[0, crouch], [1, crouch]]);
  ANIMS.take = anim([[0, crouch], [0.3, take], [0.7, take], [1, POSES.stand]]);
  ANIMS.takeHigh = anim([[0, crouch], [0.3, takeHigh], [0.7, takeHigh], [1, POSES.stand]]);

  // fielding: pick up and throw, catches, celebrations, appeals
  ANIMS.pickup = anim([[0, POSES.ready], [0.4, POSES.pickup], [0.75, POSES.pickup], [1, POSES.stand]]);
  const windup = P({ to: [-10, -35, 0], ls: [-60, 0, 30], rs: [120, 0, -30], le: [-40, 0, 0], re: [-10, 0, 0], lh: [-35, 0, 8], rh: [20, 0, -8], lk: [20, 0, 0], rk: [40, 0, 0] });
  const release = P({ to: [30, 35, 0], ls: [20, 0, 20], rs: [250, 0, -10], le: [-30, 0, 0], re: [0, 0, 0], lh: [-40, 0, 8], rh: [20, 0, -8], lk: [10, 0, 0], rk: [40, 0, 0], y: -0.05 });
  const thrown = P({ to: [35, 20, 0], ls: [20, 0, 20], rs: [320, 0, -20], le: [-30, 0, 0], re: [-30, 0, 0], lh: [-20, 0, 8], rh: [0, 0, -8], lk: [20, 0, 0], rk: [20, 0, 0], y: -0.03 });
  ANIMS.throw = anim([[0, POSES.pickup], [0.35, windup], [0.6, release], [0.8, thrown], [1, POSES.stand]]);
  ANIMS.catch = anim([[0, POSES.ready], [0.35, POSES.catch], [0.75, POSES.catch], [1, POSES.celebrate]]);
  ANIMS.catchHigh = anim([[0, POSES.ready], [0.35, POSES.catchHigh], [0.7, POSES.catch], [1, POSES.celebrate]]);
  const celeb2 = new Float32Array(POSES.celebrate); celeb2[36] = 0; celeb2[JN.lk * 3] = 8; celeb2[JN.rk * 3] = 8;
  ANIMS.celebrate = anim([[0, POSES.stand], [0.15, POSES.celebrate], [0.3, celeb2], [0.45, POSES.celebrate], [0.6, celeb2], [1, celeb2]]);
  ANIMS.appeal = anim([[0, POSES.stand], [0.12, POSES.appeal], [0.6, POSES.appeal], [1, POSES.appeal]]);
  ANIMS.slump = anim([[0, POSES.appeal], [0.3, POSES.slump], [1, POSES.slump]]);
  ANIMS.hips = anim([[0, POSES.stand], [0.3, POSES.hips], [1, POSES.hips]]);
  ANIMS.watch = anim([[0, POSES.stand], [0.3, POSES.watch], [1, POSES.watch]]);

  // umpire signals (one-shot, held at the end)
  const ustand = P({ ls: [-28, 0, 6], rs: [-28, 0, -6], le: [-75, 0, 0], re: [-75, 0, 0] });
  POSES.ustand = ustand;
  ANIMS.ustand = anim([[0, ustand], [1, ustand]]);
  const deliberate = P({ hd: [16, 0, 0], to: [6, 0, 0], ls: [20, 0, 10], rs: [20, 0, -10], le: [-10, 0, 0], re: [-10, 0, 0] });
  ANIMS.deliberate = anim([[0, ustand], [0.3, deliberate], [1, deliberate]]);
  const out = P({ hd: [-8, 0, 0], ls: [-28, 0, 6], rs: [-178, 0, -6], le: [-75, 0, 0], re: [0, 0, 0] });
  ANIMS.out = anim([[0, ustand], [0.25, out], [1, out]]);
  const nl = P({ hd: [4, -22, 0], ls: [-30, 0, -34], rs: [-30, 0, 34], le: [-70, 0, 0], re: [-70, 0, 0] });
  const nr = P({ hd: [4, 22, 0], ls: [-30, 0, -34], rs: [-30, 0, 34], le: [-70, 0, 0], re: [-70, 0, 0] });
  ANIMS.notout = anim([[0, ustand], [0.15, nl], [0.3, nr], [0.45, nl], [0.6, nr], [0.75, nl], [1, nr]]);
  const fa = P({ ls: [-28, 0, 6], rs: [-80, 0, -55], le: [-75, 0, 0], re: [-10, 0, 0] });
  const fb = P({ ls: [-28, 0, 6], rs: [-80, 0, 25], le: [-75, 0, 0], re: [-10, 0, 0] });
  ANIMS.four = anim([[0, ustand], [0.15, fa], [0.3, fb], [0.45, fa], [0.6, fb], [0.75, fa], [1, fb]]);
  const six = P({ hd: [-10, 0, 0], ls: [-178, 0, 8], rs: [-178, 0, -8] });
  ANIMS.six = anim([[0, ustand], [0.3, six], [1, six]]);
  const wide = P({ ls: [0, 0, 88], rs: [0, 0, -88] });
  ANIMS.wide = anim([[0, ustand], [0.25, wide], [1, wide]]);
  const noball = P({ ls: [-28, 0, 6], rs: [0, 0, -88], le: [-75, 0, 0] });
  ANIMS.noball = anim([[0, ustand], [0.25, noball], [1, noball]]);
}

// ---- rig construction --------------------------------------------------------------
const GEO = {};
function geo(name, make) { return GEO[name] || (GEO[name] = make()); }
const SHARED_MATS = {};
function sharedMat(name, color, extra) { return SHARED_MATS[name] || (SHARED_MATS[name] = new THREE.MeshLambertMaterial(Object.assign({ color }, extra || {}))); }

// kit = { shirt, trouser, accent, skin, helmet, cap, hat, pads, gloves, bat, keeper, umpire }
function buildFigure(kit) {
  const mats = {
    shirt: new THREE.MeshLambertMaterial({ color: kit.shirt }),
    trouser: new THREE.MeshLambertMaterial({ color: kit.trouser }),
    accent: new THREE.MeshLambertMaterial({ color: kit.accent }),
  };
  const skin = sharedMat('skin' + kit.skin, kit.skin);
  const padMat = sharedMat('pad', 0xf3f1e6), gloveMat = sharedMat('glove', 0xf5f5f5), shoeMat = sharedMat('shoe', 0xf0f0f0);
  const box = (w, h, d, m, x, y, z) => { const me = new THREE.Mesh(geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), m); me.position.set(x, y, z); me.castShadow = true; return me; };
  const grp = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };

  const root = new THREE.Group();
  const hips = grp(root, 0, HIP_Y, 0);
  hips.add(box(0.36, 0.2, 0.22, mats.trouser, 0, 0.1, 0));
  const torso = grp(hips, 0, 0.18, 0);
  torso.add(box(0.4, 0.42, 0.24, mats.shirt, 0, 0.2, 0));
  const head = grp(torso, 0, 0.44, 0);
  head.add(new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.11, 10, 8)), skin)).position.y = 0.12;
  head.add(box(0.09, 0.07, 0.04, skin, 0, 0.04, 0.03)); // neck
  if (kit.helmet) {
    const h = new THREE.Mesh(geo('helmet', () => new THREE.SphereGeometry(0.128, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62)), mats.accent); h.position.y = 0.13; head.add(h);
    head.add(box(0.2, 0.02, 0.1, mats.accent, 0, 0.1, 0.13));
    const grille = new THREE.Mesh(geo('grille', () => new THREE.BoxGeometry(0.2, 0.1, 0.01)), sharedMat('grille', 0x9aa3ad)); grille.position.set(0, 0.06, 0.13); head.add(grille);
  } else if (kit.cap) {
    const c = new THREE.Mesh(geo('cap', () => new THREE.SphereGeometry(0.118, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5)), mats.accent); c.position.y = 0.12; head.add(c);
    head.add(box(0.14, 0.015, 0.1, mats.accent, 0, 0.12, 0.14));
  } else if (kit.hat) {
    const hatMat = sharedMat('hat', 0xf4f4f4);
    const brim = new THREE.Mesh(geo('brim', () => new THREE.CylinderGeometry(0.2, 0.2, 0.015, 12)), hatMat); brim.position.y = 0.17; head.add(brim);
    const crown = new THREE.Mesh(geo('crown', () => new THREE.CylinderGeometry(0.1, 0.115, 0.1, 12)), hatMat); crown.position.y = 0.22; head.add(crown);
  } else {
    const hair = new THREE.Mesh(geo('hair', () => new THREE.SphereGeometry(0.115, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.45)), sharedMat('hair', 0x2b1d14)); hair.position.y = 0.125; head.add(hair);
  }
  const arm = (side) => {
    const sh = grp(torso, side * 0.24, 0.36, 0);
    sh.add(box(0.1, 0.3, 0.1, mats.accent, 0, -0.14, 0));
    const el = grp(sh, 0, -0.29, 0);
    el.add(box(0.085, 0.28, 0.085, skin, 0, -0.13, 0));
    const hand = grp(el, 0, -0.28, 0);
    if (kit.gloves || kit.keeper) hand.add(box(kit.keeper ? 0.16 : 0.1, kit.keeper ? 0.2 : 0.12, 0.07, kit.keeper ? sharedMat('kglove', 0xd98f2b) : gloveMat, 0, -0.05, 0));
    else hand.add(box(0.08, 0.1, 0.05, skin, 0, -0.04, 0));
    return { sh, el, hand };
  };
  const L = arm(1), R = arm(-1);
  const leg = (side) => {
    const hp = grp(hips, side * 0.11, 0.02, 0);
    hp.add(box(0.14, 0.45, 0.14, mats.trouser, 0, -0.22, 0));
    const kn = grp(hp, 0, -0.45, 0);
    kn.add(box(0.12, 0.44, 0.12, mats.trouser, 0, -0.22, 0));
    if (kit.pads) kn.add(box(0.17, 0.5, 0.1, padMat, 0, -0.2, 0.07));
    kn.add(box(0.11, 0.07, 0.27, shoeMat, 0, -0.44, 0.05));
    return { hp, kn };
  };
  const LL = leg(1), RL = leg(-1);
  let batJ = null;
  if (kit.bat) {
    batJ = new THREE.Group(); batJ.position.set(0, 0.1, 0); R.hand.add(batJ);
    const handle = new THREE.Mesh(geo('handle', () => { const g = new THREE.CylinderGeometry(0.017, 0.017, 0.3, 8); g.translate(0, -0.15, 0); return g; }), sharedMat('handle', 0x2b1d14));
    batJ.add(handle);
    const blade = new THREE.Mesh(geo('blade', () => { const g = new THREE.BoxGeometry(0.108, 0.56, 0.042); g.translate(0, -0.58, 0); return g; }), sharedMat('wood', 0xffffff, { map: texWood() }));
    blade.castShadow = true; batJ.add(blade);
    const sticker = box(0.095, 0.2, 0.012, mats.accent, 0, -0.6, -0.022); batJ.add(sticker);
  }
  const joints = [hips, torso, head, L.sh, R.sh, L.el, R.el, LL.hp, RL.hp, LL.kn, RL.kn, batJ];
  const fig = { root, hips, joints, handR: R.hand, handL: L.hand, head, mats, pose: new Float32Array(40), hasBat: !!batJ };
  fig.pose.set(POSES.stand);
  applyPose(fig, fig.pose);
  return fig;
}
function applyPose(fig, p) {
  const J = fig.joints;
  for (let i = 0; i < 12; i++) { const j = J[i]; if (!j) continue; j.rotation.set(p[i * 3] * DEG, p[i * 3 + 1] * DEG, p[i * 3 + 2] * DEG); }
  fig.hips.position.set(p[37], HIP_Y + p[36], p[38]);
}
function setKitColors(fig, shirt, trouser, accent) {
  fig.mats.shirt.color.setHex(shirt); fig.mats.trouser.color.setHex(trouser); fig.mats.accent.color.setHex(accent);
}

// =====================================================================================
// 6. Ball paths: a chain of arc segments (straight in xz, parabolic bulge in y)
// =====================================================================================
// Segment: from (x0,y0,z0) at t0 to (x1,y1,z1) at t1, y gets + 4*h*u*(1-u); ease 0 linear,
// 1 ease-out (rolling to a stop). A gravity-true flight of d ms has bulge G*(d/1000)^2/8.
const gravityBulge = (ms) => G * (ms / 1000) * (ms / 1000) / 8;
class BallPath {
  constructor() {
    this.segs = []; this.n = 0;
    for (let i = 0; i < 20; i++) this.segs.push({ t0: 0, t1: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, h: 0, ease: 0 });
  }
  clear() { this.n = 0; return this; }
  add(t0, t1, x0, y0, z0, x1, y1, z1, h = 0, ease = 0) {
    if (this.n >= this.segs.length) return null;
    const s = this.segs[this.n++];
    s.t0 = t0; s.t1 = Math.max(t1, t0 + 1); s.x0 = x0; s.y0 = y0; s.z0 = z0; s.x1 = x1; s.y1 = y1; s.z1 = z1; s.h = h; s.ease = ease;
    return s;
  }
  // continue from the last segment's end point
  then(dur, x1, y1, z1, h = 0, ease = 0) {
    const l = this.segs[this.n - 1];
    return this.add(l.t1, l.t1 + dur, l.x1, l.y1, l.z1, x1, y1, z1, h, ease);
  }
  get tStart() { return this.n ? this.segs[0].t0 : 0; }
  get tEnd() { return this.n ? this.segs[this.n - 1].t1 : 0; }
  // -1: before the path starts (out = first point); 0: flying; 1: finished (out = last point)
  at(t, out) {
    if (!this.n) { out.set(0, -10, 0); return -1; }
    const first = this.segs[0];
    if (t < first.t0) { out.set(first.x0, first.y0, first.z0); return -1; }
    for (let i = 0; i < this.n; i++) {
      const s = this.segs[i];
      if (t <= s.t1 || i === this.n - 1) {
        let u = clamp01((t - s.t0) / (s.t1 - s.t0));
        const done = t >= s.t1 && i === this.n - 1;
        if (done) u = 1;
        const w = s.ease === 1 ? easeOut(u) : s.ease === 2 ? easeIn(u) : u;
        out.x = lerp(s.x0, s.x1, w); out.z = lerp(s.z0, s.z1, w);
        out.y = lerp(s.y0, s.y1, w) + 4 * s.h * w * (1 - w);
        return done ? 1 : 0;
      }
    }
    return 1;
  }
}
// A shot along the ground: a few decreasing hops then a roll to (x1, z1) over totalMs.
function addGroundTravel(path, t0, x0, y0, z0, x1, z1, totalMs, firstBulge) {
  const fr = [0.28, 0.2, 0.14], hb = [1, 0.42, 0.18];
  let u = 0, t = t0, px = x0, py = y0, pz = z0;
  for (let i = 0; i < 3; i++) {
    const u1 = u + fr[i], nx = lerp(x0, x1, u1), nz = lerp(z0, z1, u1), d = totalMs * fr[i];
    path.add(t, t + d, px, py, pz, nx, BALL_R, nz, firstBulge * hb[i], 0);
    t += d; u = u1; px = nx; py = BALL_R; pz = nz;
  }
  path.add(t, t0 + totalMs, px, py, pz, x1, BALL_R, z1, 0, 1);
}

// =====================================================================================
// 7. Overlay DOM (broadcast graphics) inside canvas.parentElement
// =====================================================================================
const OVERLAY_CSS = `
.rb-ov{position:absolute;left:0;top:0;pointer-events:none;overflow:hidden;font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#fff;z-index:5}
.rb-ov *{box-sizing:border-box}
.rb-ov .rb-h{display:none!important}
.rb-inset{position:absolute;left:4%;bottom:4%;width:46%;display:flex;align-items:center;gap:1.5em;padding:1.2em 1.6em;background:rgba(6,10,26,.9);border:.45em solid #ffd166;border-radius:1.4em;box-shadow:0 .8em 2.4em rgba(0,0,0,.6);animation:rbPop .35s cubic-bezier(.2,1.4,.4,1)}
.rb-inset svg{width:34%;height:auto;flex:none}
.rb-inset .rb-ilabel{font-size:1.9em;font-weight:600;letter-spacing:.14em;opacity:.75;text-transform:uppercase}
.rb-inset .rb-itxt{font-size:6.4em;font-weight:900;line-height:1;letter-spacing:.02em;text-shadow:0 .06em .2em rgba(0,0,0,.7)}
.rb-inset.out .rb-itxt{color:#ff5a4e}.rb-inset.notout .rb-itxt{color:#4ade80}.rb-inset.four .rb-itxt{color:#7fc8ff}.rb-inset.six .rb-itxt{color:#d9b3ff}.rb-inset.wide .rb-itxt,.rb-inset.noball .rb-itxt{color:#ffe08a}
.rb-slate{position:absolute;left:8%;right:8%;top:30%;padding:3em 2em;text-align:center;background:linear-gradient(180deg,rgba(8,14,40,.96),rgba(20,30,80,.96));border:.35em solid #ffd166;border-radius:1.6em;box-shadow:0 1em 3em rgba(0,0,0,.6)}
.rb-slate .rb-s1{font-size:3.4em;font-weight:700;letter-spacing:.35em;color:#ffd166}
.rb-slate .rb-s2{font-size:9em;font-weight:900;line-height:1.05;margin:.1em 0}
.rb-slate .rb-s3{font-size:3em;opacity:.85}
.rb-boxes{position:absolute;left:3%;right:3%;top:4%;display:flex;gap:2%}
.rb-box{flex:1;min-width:0;padding:.9em .3em 1em;text-align:center;border-radius:.9em;background:rgba(10,14,32,.9);border:.3em solid rgba(255,255,255,.25);transform:scale(.8);opacity:0;transition:transform .3s,opacity .3s;box-shadow:0 .5em 1.5em rgba(0,0,0,.5)}
.rb-box.show{transform:scale(1);opacity:1}
.rb-box.ok{background:#15803d;border-color:#4ade80}.rb-box.bad{background:#b91c1c;border-color:#fca5a5}.rb-box.uc{background:#b45309;border-color:#fcd34d}
.rb-box b{display:block;font-size:2em;letter-spacing:.12em;opacity:.85;white-space:nowrap}
.rb-box span{display:block;font-size:2.7em;font-weight:900;line-height:1.1;margin-top:.2em;text-shadow:0 .05em .2em rgba(0,0,0,.5);white-space:nowrap}
.rb-ue{position:absolute;left:3%;right:3%;bottom:4%;padding:1em 1.4em 1.2em;background:rgba(4,8,20,.92);border:.3em solid #7fc8ff;border-radius:1em}
.rb-ue .rb-ut{font-size:3em;font-weight:800;letter-spacing:.3em;color:#7fc8ff}
.rb-ue canvas{display:block;width:100%;height:16em;margin-top:.5em;background:#02060f;border-radius:.4em}
.rb-stamp{position:absolute;left:0;right:0;top:34%;text-align:center}
.rb-stamp .rb-st{display:inline-block;font-size:15em;font-weight:900;line-height:1;padding:.05em .3em;border:.08em solid currentColor;border-radius:.1em;transform:rotate(-6deg);text-shadow:0 .04em .2em rgba(0,0,0,.6);background:rgba(0,0,0,.55);animation:rbStamp .35s cubic-bezier(.2,1.5,.4,1)}
.rb-stamp.out .rb-st{color:#ff5a4e}.rb-stamp.notout .rb-st{color:#4ade80}
.rb-stamp .rb-ss{display:block;margin-top:1em;font-size:3.6em;font-weight:700;letter-spacing:.1em;text-shadow:0 .1em .3em #000;background:rgba(0,0,0,.55);display:inline-block;padding:.2em .8em;border-radius:.4em}
.rb-tag{position:absolute;right:4%;top:4%;padding:.5em 1.2em;font-size:2.6em;font-weight:800;letter-spacing:.2em;background:#dc2626;border-radius:.3em;box-shadow:0 .2em .8em rgba(0,0,0,.5)}
@keyframes rbPop{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes rbStamp{from{transform:rotate(-6deg) scale(2);opacity:0}to{transform:rotate(-6deg) scale(1);opacity:1}}
`;

function umpireSvg(kind) {
  // arms: [upper x, y] for the right (viewer's left) and left arms, in a 100x120 box
  const arm = (x0, y0, x1, y1, x2, y2) => `<path d="M${x0} ${y0} L${x1} ${y1} L${x2} ${y2}" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  let arms = '';
  switch (kind) {
    case 'out': arms = arm(62, 48, 70, 30, 72, 8) + arm(38, 48, 30, 64, 36, 78) + '<circle cx="72" cy="6" r="4" fill="#f1c27d"/>'; break;
    case 'notout': arms = arm(62, 48, 52, 66, 36, 70) + arm(38, 48, 48, 66, 64, 70); break;
    case 'four': arms = arm(62, 48, 80, 42, 96, 36) + arm(38, 48, 30, 64, 36, 78); break;
    case 'six': arms = arm(62, 48, 70, 26, 74, 6) + arm(38, 48, 30, 26, 26, 6); break;
    case 'wide': arms = arm(62, 48, 82, 46, 100, 46) + arm(38, 48, 18, 46, 0, 46); break;
    case 'noball': arms = arm(62, 48, 82, 46, 100, 46) + arm(38, 48, 30, 64, 36, 78); break;
    default: arms = arm(62, 48, 66, 66, 60, 78) + arm(38, 48, 34, 66, 40, 78);
  }
  return `<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">
<rect x="34" y="78" width="32" height="40" rx="4" fill="#111827"/>
<path d="M30 48 Q50 40 70 48 L68 82 L32 82 Z" fill="#f8fafc"/>
<circle cx="50" cy="30" r="12" fill="#e0ac69"/>
<path d="M30 22 Q50 8 70 22 L74 24 Q50 14 26 24 Z" fill="#f8fafc"/>
<rect x="38" y="12" width="24" height="8" rx="3" fill="#f8fafc"/>
${arms}</svg>`;
}

function buildOverlay(container) {
  const style = document.createElement('style'); style.textContent = OVERLAY_CSS; container.appendChild(style);
  const root = document.createElement('div'); root.className = 'rb-ov'; container.appendChild(root);
  const el = (cls, html) => { const d = document.createElement('div'); d.className = cls + ' rb-h'; d.innerHTML = html || ''; root.appendChild(d); return d; };
  const inset = el('rb-inset', '<div class="rb-isvg"></div><div><div class="rb-ilabel">Umpire</div><div class="rb-itxt"></div></div>');
  const slate = el('rb-slate', '<div class="rb-s1">DECISION REVIEW</div><div class="rb-s2"></div><div class="rb-s3"></div>');
  const boxes = el('rb-boxes', ['PITCHING', 'IMPACT', 'WICKETS'].map((t) => `<div class="rb-box"><b>${t}</b><span>&nbsp;</span></div>`).join(''));
  const ue = el('rb-ue', '<div class="rb-ut">ULTRAEDGE</div><canvas width="600" height="120"></canvas>');
  const stamp = el('rb-stamp', '<div class="rb-st"></div><br><span class="rb-ss"></span>');
  const tag = el('rb-tag', 'REVIEW');
  const O = {
    root, inset, slate, boxes, ue, stamp, tag,
    insetSvg: inset.querySelector('.rb-isvg'), insetTxt: inset.querySelector('.rb-itxt'),
    slateKind: slate.querySelector('.rb-s2'), slateSub: slate.querySelector('.rb-s3'),
    boxEls: Array.from(boxes.querySelectorAll('.rb-box')), ueCanvas: ue.querySelector('canvas'),
    stampTxt: stamp.querySelector('.rb-st'), stampSub: stamp.querySelector('.rb-ss'),
    shown: new Map(),
    show(e, on) { const cur = O.shown.get(e); if (cur === on) return; O.shown.set(e, on); e.classList.toggle('rb-h', !on); },
    hideAll() { for (const e of [inset, slate, boxes, ue, stamp, tag]) O.show(e, false); },
    setSize(left, top, w, h) {
      root.style.left = left + 'px'; root.style.top = top + 'px'; root.style.width = w + 'px'; root.style.height = h + 'px';
      root.style.fontSize = (w / 100) + 'px';
    },
    lastInset: '',
    setInset(kind, text) {
      const key = kind + '|' + text;
      if (O.lastInset !== key) { O.lastInset = key; O.insetSvg.innerHTML = umpireSvg(kind); O.insetTxt.textContent = text; inset.className = 'rb-inset ' + kind; }
      O.show(inset, true);
    },
    setBox(i, cls, text) {
      const b = O.boxEls[i], key = cls + '|' + text;
      if (b.dataset.k !== key) { b.dataset.k = key; b.className = 'rb-box ' + cls; b.querySelector('span').textContent = text; }
    },
  };
  O.ueCtx = O.ueCanvas.getContext('2d');
  return O;
}

// =====================================================================================
// 8. Actors: a figure plus a timeline of movement/animation tracks (pure function of t)
// =====================================================================================
class Actor {
  constructor(fig, name) {
    this.fig = fig; this.name = name;
    this.home = new THREE.Vector3(); this.homeYaw = 0; this.homeAnim = ANIMS.stand;
    this.pos = new THREE.Vector3(); this.yaw = 0; this.mirror = 1;
    this.pose = fig.pose; this.tmp = new Float32Array(40);
    this.tracks = []; this.n = 0;
    for (let i = 0; i < 12; i++) this.tracks.push({ t0: 0, t1: 0, x0: 0, z0: 0, x1: 0, z1: 0, anim: null, rate: 0, yaw: NaN, yawFrom: 0, ease: 0, blend: 0, from: new Float32Array(40) });
  }
  reset() { this.n = 0; }
  // Drop every track that starts after t (they are superseded by what is being scheduled).
  cut(t) { while (this.n > 0 && this.tracks[this.n - 1].t0 >= t) this.n--; }
  // Schedule: anim from t0 to t1, moving from the current place (or opts.from) to opts.to.
  // opts: { from:[x,z], to:[x,z], rate (loop cycles/s), yaw (radians, NaN = face the motion), ease, blend (ms) }
  add(t0, t1, anim, opts = {}) {
    this.cut(t0);
    this.evalAt(t0);                       // where am I and what do I look like when this starts
    if (this.n >= this.tracks.length) return null;
    const tr = this.tracks[this.n++];
    tr.t0 = t0; tr.t1 = Math.max(t1, t0 + 1); tr.anim = anim || ANIMS.stand;
    tr.x0 = opts.from ? opts.from[0] : this.pos.x; tr.z0 = opts.from ? opts.from[1] : this.pos.z;
    tr.x1 = opts.to ? opts.to[0] : tr.x0; tr.z1 = opts.to ? opts.to[1] : tr.z0;
    tr.rate = opts.rate || 0; tr.yaw = opts.yaw === undefined ? NaN : opts.yaw; tr.yawFrom = this.yaw;
    tr.ease = opts.ease || 0; tr.blend = opts.blend === undefined ? 140 : opts.blend;
    tr.from.set(this.pose);
    return tr;
  }
  evalAt(t) {
    let tr = null;
    for (let i = this.n - 1; i >= 0; i--) if (t >= this.tracks[i].t0) { tr = this.tracks[i]; break; }
    if (!tr) {
      this.pos.copy(this.home); this.yaw = this.homeYaw;
      sampleAnim(this.homeAnim, this.homeAnim.loop ? t / 1000 : 1, this.pose);
      return;
    }
    const dur = tr.t1 - tr.t0, raw = clamp01((t - tr.t0) / dur);
    const w = tr.ease === 1 ? easeOut(raw) : tr.ease === 2 ? easeInOut(raw) : raw;
    this.pos.set(lerp(tr.x0, tr.x1, w), 0, lerp(tr.z0, tr.z1, w));
    const dx = tr.x1 - tr.x0, dz = tr.z1 - tr.z0;
    this.yaw = !isNaN(tr.yaw) ? tr.yaw : (dx * dx + dz * dz > 1e-4 ? Math.atan2(dx, dz) : tr.yawFrom);
    const u = tr.anim.loop ? Math.min(t - tr.t0, dur) / 1000 * tr.rate : raw;
    sampleAnim(tr.anim, u, this.pose);
    if (tr.blend > 0 && t - tr.t0 < tr.blend) lerpPose(tr.from, this.pose, smooth((t - tr.t0) / tr.blend), this.pose);
  }
  apply() {
    applyPose(this.fig, this.pose);
    this.fig.root.position.set(this.pos.x * this.mirror, 0, this.pos.z);
    this.fig.root.rotation.y = this.yaw;
  }
}

// Fielding positions (L = leg-side sign of the striker, zk = keeper depth).
function fieldLayout(L, zk) {
  return [
    { name: 'slip', x: -L * 2.3, z: zk + 0.6, zone: 'off', close: true },
    { name: 'point', x: -L * 19, z: 3, zone: 'off' },
    { name: 'cover', x: -L * 24, z: 18, zone: 'off' },
    { name: 'midoff', x: -L * 11, z: 29, zone: 'straight' },
    { name: 'longoff', x: -L * 22, z: 57, zone: 'straight', deep: true },
    { name: 'midon', x: L * 11, z: 29, zone: 'straight' },
    { name: 'longon', x: L * 22, z: 57, zone: 'straight', deep: true },
    { name: 'deepmidwicket', x: L * 42, z: 36, zone: 'leg', deep: true },
    { name: 'squareleg', x: L * 25, z: 2, zone: 'leg' },
  ];
}
const KEEPER_Z = { fast: -9, medium: -6, spin: -1.4 };
const RUN_LEN = { fast: 9, medium: 7, spin: 3.5 };
const DEFAULT_TEAMS = [{ name: 'Blue', short: 'BLU', color: '#1d4ed8', color2: '#facc15' }, { name: 'Red', short: 'RED', color: '#dc2626', color2: '#ffffff' }];

// =====================================================================================
// 9. Renderer
// =====================================================================================
function Renderer(canvas, opts = {}) {
  const R = {};                                  // the public object
  const container = canvas.parentElement || document.body;
  const rnd = mulberry32(2024);

  // ---- three.js setup -------------------------------------------------------------
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
  gl.shadowMap.enabled = false; gl.shadowMap.type = THREE.PCFShadowMap;
  gl.setClearColor(0x06091c, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 0.75, 0.2, 1400);
  scene.add(camera);
  const hemi = new THREE.HemisphereLight(0x9fb8ff, 0x1f4a22, 0.75); scene.add(hemi);
  scene.add(new THREE.AmbientLight(0xffffff, 0.32));
  const key = new THREE.DirectionalLight(0xfff5dc, 2.4); key.position.set(45, 80, -30); key.target.position.set(0, 0, 10); scene.add(key); scene.add(key.target);
  key.shadow.mapSize.set(2048, 2048); key.shadow.camera.near = 20; key.shadow.camera.far = 220;
  key.shadow.camera.left = -40; key.shadow.camera.right = 40; key.shadow.camera.top = 40; key.shadow.camera.bottom = -40; key.shadow.bias = -0.0008;
  const fill = new THREE.DirectionalLight(0xdfe9ff, 1.1); fill.position.set(-50, 60, 70); scene.add(fill);
  const uTime = { value: 0 }, uWave = { value: 0 };
  const stadium = buildStadium(scene, rnd, uTime, uWave);

  // stumps at both ends (the striker's can shatter)
  const stumpsA = makeStumps(); scene.add(stumpsA.group);
  const stumpsB = makeStumps(); stumpsB.group.position.z = PITCH_LEN; scene.add(stumpsB.group);

  // ball, glow, trail
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 14, 10), new THREE.MeshPhongMaterial({ color: 0xd81f26, shininess: 90, specular: 0xffffff, emissive: 0x3a0505 }));
  ball.castShadow = true;
  const seam = new THREE.Mesh(new THREE.TorusGeometry(BALL_R, 0.004, 4, 24), new THREE.MeshBasicMaterial({ color: 0xf1f1f1 })); seam.rotation.y = Math.PI / 2; ball.add(seam);
  const ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: texGlow(0.9, 0.2), color: 0xff8070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
  ballGlow.scale.set(0.55, 0.55, 1); ball.add(ballGlow);
  scene.add(ball); ball.visible = false;
  const TRAIL_N = 18;
  const trail = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R * 1.5, 7, 5), new THREE.MeshBasicMaterial({ color: 0xff7a60, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }), TRAIL_N);
  trail.count = 0; scene.add(trail);
  const trailLineGeo = new THREE.BufferGeometry(); trailLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TRAIL_N + 1) * 3), 3));
  const trailLine = new THREE.Line(trailLineGeo, new THREE.LineBasicMaterial({ color: 0xffb0a0, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  trailLine.frustumCulled = false; trailLine.visible = false; scene.add(trailLine);

  // fireworks
  const FW_N = 320;
  const fwGeo = new THREE.BufferGeometry();
  fwGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FW_N * 3), 3));
  fwGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FW_N * 3), 3));
  const fwVel = new Float32Array(FW_N * 3), fwHue = new Float32Array(FW_N);
  for (let i = 0; i < FW_N; i++) {
    const a = rnd() * Math.PI * 2, e = (rnd() - 0.5) * Math.PI, s = 7 + rnd() * 9;
    fwVel.set([Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 3, Math.sin(a) * Math.cos(e) * s], i * 3); fwHue[i] = rnd();
  }
  const fireworks = new THREE.Points(fwGeo, new THREE.PointsMaterial({ size: 1.4, vertexColors: true, map: texGlow(1, 0.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  fireworks.visible = false; fireworks.frustumCulled = false; scene.add(fireworks);
  const FW_ORIGINS = [[-40, 42, 95], [38, 46, 100], [0, 50, 108], [-20, 40, 90], [25, 44, 92]];

  // Hawk-Eye objects (built on first review)
  const hawk = { group: new THREE.Group(), tube: null, glow: null, dashed: null, ghost: null, zone: null, pts: [] };
  hawk.group.visible = false; scene.add(hawk.group);
  hawk.zone = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.74, 0.06), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.45, depthWrite: false }));
  hawk.zone.position.set(0, 0.37, 0); hawk.group.add(hawk.zone);
  hawk.ghost = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.2, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 })); hawk.group.add(hawk.ghost);

  // ---- figures ---------------------------------------------------------------------
  const kitB = (shirt, accent) => ({ shirt, trouser: shirt, accent, skin: 0xd9a06b, helmet: true, pads: true, gloves: true, bat: true });
  const kitF = (shirt, accent) => ({ shirt, trouser: shirt, accent, skin: 0xc98a58, cap: true });
  const mirrorS = new THREE.Group(), mirrorN = new THREE.Group(); scene.add(mirrorS); scene.add(mirrorN);
  const striker = new Actor(buildFigure(kitB(0x1d4ed8, 0xfacc15)), 'striker'); mirrorS.add(striker.fig.root);
  const nonStriker = new Actor(buildFigure(kitB(0x1d4ed8, 0xfacc15)), 'nonstriker'); mirrorN.add(nonStriker.fig.root);
  const bowler = new Actor(buildFigure(kitF(0xdc2626, 0xffffff)), 'bowler'); scene.add(bowler.fig.root);
  const keeper = new Actor(buildFigure(Object.assign(kitF(0xdc2626, 0xffffff), { keeper: true, pads: true, skin: 0xe0ac69 })), 'keeper'); scene.add(keeper.fig.root);
  const fielders = [];
  for (let i = 0; i < 9; i++) { const a = new Actor(buildFigure(kitF(0xdc2626, 0xffffff)), 'f' + i); scene.add(a.fig.root); fielders.push(a); }
  const umpKit = { shirt: 0xf8fafc, trouser: 0x111827, accent: 0xf8fafc, skin: 0xe0ac69, hat: true };
  const umpire = new Actor(buildFigure(umpKit), 'umpire'); scene.add(umpire.fig.root);
  const umpireSq = new Actor(buildFigure(umpKit), 'umpire2'); scene.add(umpireSq.fig.root);
  const everyone = [striker, nonStriker, bowler, keeper, ...fielders, umpire, umpireSq];
  const fieldingSide = [bowler, keeper, ...fielders];

  // ---- state -----------------------------------------------------------------------
  const S = {
    now: 0, w: 480, h: 640, dpr: 1, shadows: false,
    teams: DEFAULT_TEAMS.slice(), battingSlot: 0, bowlingSlot: 1,
    L: 1, hand: 'R', nsHand: 'R', bowlerType: 'fast', zk: KEEPER_Z.fast,
    layout: fieldLayout(1, KEEPER_Z.fast),
    delivery: null, result: null, review: null,
    swingT: -1e9, swingDir: null,
    sig: { kind: null, t: -1e9, text: '' },
    celeb: { kind: null, t: -1e9 },
    wave: { t0: -1e9, t1: -1e9 },
    shatter: { t: -1e9, stump: 1, dir: 1 },
    screenText: ['', ''],
    camPlan: [], camFrom: 'bat',
  };
  const overlay = buildOverlay(container);
  const path = new BallPath();           // the live ball
  const hawkPath = new BallPath();       // the replay ball
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _look = new THREE.Vector3(), _pos = new THREE.Vector3();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();
  const contactPose = new Float32Array(40);
  const debugCam = opts.debugCamera || null;

  // ---- small internal helpers --------------------------------------------------------
  sampleAnim(ANIMS.drive, 0.14, contactPose);
  ANIMS.ueHold = anim([[0, contactPose], [1, contactPose]]);
  const nsPose = P({ ls: [0, 0, 8], rs: [-18, 0, -14], le: [-12, 0, 0], re: [-40, 0, 0], bt: [52, 0, 0], to: [6, 0, 0] });
  ANIMS.nsStand = anim([[0, nsPose], [1, nsPose]]);

  function lineX(i) { const L = S.L; if (i < -1) return L * (1.0 + (-1 - i) * 0.5); if (i > 3) return L * (-1.0 - (i - 3) * 0.5); return L * LINE_OFF[i + 1]; }
  function teamCol(slot) { const t = S.teams[slot] || DEFAULT_TEAMS[slot] || DEFAULT_TEAMS[0]; return [hexToRgb(t.color, slot ? 0xdc2626 : 0x1d4ed8), hexToRgb(t.color2, slot ? 0xffffff : 0xfacc15)]; }
  function applyKits() {
    const [bc, ba] = teamCol(S.battingSlot), [fc, fa] = teamCol(S.bowlingSlot);
    setKitColors(striker.fig, bc, bc, ba); setKitColors(nonStriker.fig, bc, bc, ba);
    for (const a of fieldingSide) setKitColors(a.fig, fc, fc, fa);
    for (let i = 0; i < 180; i++) { _c.setHex(i % 2 ? bc : fc); stadium.flags.setColorAt(i, _c); }
    stadium.flags.instanceColor.needsUpdate = true;
  }
  function placeHomes() {
    const L = S.L, zk = S.zk;
    striker.mirror = L; mirrorS.scale.x = L; striker.home.set(0.38, 0, 0.78); striker.homeYaw = -Math.PI / 2; striker.homeAnim = ANIMS.stance;
    nonStriker.mirror = S.nsHand === 'L' ? -1 : 1; mirrorN.scale.x = nonStriker.mirror;
    nonStriker.home.set(1.3 * nonStriker.mirror, 0, 19.4); nonStriker.homeYaw = Math.PI; nonStriker.homeAnim = ANIMS.nsStand;
    bowler.home.set(-0.65, 0, PITCH_LEN + 1.2 + RUN_LEN[S.bowlerType]); bowler.homeYaw = Math.PI; bowler.homeAnim = ANIMS.stand;
    keeper.home.set(-L * 0.55, 0, zk); keeper.homeYaw = 0; keeper.homeAnim = ANIMS.crouch;
    S.layout = fieldLayout(L, zk);
    fielders.forEach((f, i) => { const p = S.layout[i]; f.home.set(p.x, 0, p.z); f.homeYaw = Math.atan2(-p.x, 1 - p.z); f.homeAnim = ANIMS.ready; });
    umpire.home.set(0.35, 0, PITCH_LEN + 2.6); umpire.homeYaw = Math.PI; umpire.homeAnim = ANIMS.ustand;
    umpireSq.home.set(L * 18, 0, 1.2); umpireSq.homeYaw = Math.atan2(-L, 0); umpireSq.homeAnim = ANIMS.ustand;
  }
  function resetStumps() {
    stumpsA.stumps.forEach((m, i) => { m.position.set((i - 1) * 0.114, 0, 0); m.rotation.set(0, 0, 0); });
    stumpsA.bails.forEach((m, i) => { m.position.set((i - 0.5) * 0.114, 0.72, 0); m.rotation.set(0, 0, 0); });
    S.shatter.t = -1e9;
  }
  function camModeAt(t) { let m = 'bat'; for (const e of S.camPlan) if (e.t <= t) m = e.mode; return m; }
  function camPush(t, mode, blend) {
    const plan = S.camPlan; while (plan.length && plan[plan.length - 1].t >= t) plan.pop();
    plan.push({ t, mode, blend, from: camModeAt(t) });
  }
  function queueSignal(kind, t) { S.sigQ.kind = kind; S.sigQ.t = t; }
  function setSignal(kind, t) {
    if (S.sig.kind === kind && t - S.sig.t < 400) return;
    S.sig.kind = kind; S.sig.t = t;
    const an = ANIMS[kind] || ANIMS.ustand;
    umpire.add(t, t + 1400, an, { yaw: Math.PI, blend: 120 });
    umpire.add(t + 1400, t + 3200, ANIMS.ustand, { yaw: Math.PI, blend: 500 });
    if (kind === 'four') paintScreen('FOUR!', 'to the rope'); else if (kind === 'six') paintScreen('SIX!', 'into the crowd');
    else if (kind === 'out') paintScreen('OUT!', ''); else if (kind === 'notout') paintScreen('NOT OUT', '');
  }
  function paintScreen(headline, sub) {
    if (S.screenText[0] === headline && S.screenText[1] === sub) return;
    S.screenText[0] = headline; S.screenText[1] = sub; stadium.screen.paint(S.teams, headline, sub);
  }
  function ropeHit(bx, bz, dx, dz) {         // distance along (dx,dz) from (bx,bz) to the rope
    const A = (dx * dx) / (ROPE_RX * ROPE_RX) + (dz * dz) / (ROPE_RZ * ROPE_RZ);
    const B = 2 * (bx * dx / (ROPE_RX * ROPE_RX) + (bz - FIELD_CZ) * dz / (ROPE_RZ * ROPE_RZ));
    const C = (bx * bx) / (ROPE_RX * ROPE_RX) + ((bz - FIELD_CZ) * (bz - FIELD_CZ)) / (ROPE_RZ * ROPE_RZ) - 1;
    return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
  }
  function nearestFielder(x, z, deep) {
    let best = -1, bd = 1e9;
    S.layout.forEach((p, i) => { if (deep && !p.deep) return; const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = i; } });
    return best < 0 ? 0 : best;
  }
  function zoneCatcher(zone, kind, salt) {
    const cands = []; S.layout.forEach((p, i) => { if (p.zone === zone) cands.push({ p, i }); });
    if (!cands.length) return nearestFielder(0, 20);
    let pool = cands;
    if (kind === 'loft') pool = cands.filter((c) => c.p.deep);
    else if (kind === 'defend') pool = cands.filter((c) => c.p.close || !c.p.deep);
    else pool = cands.filter((c) => !c.p.deep && !c.p.close);
    if (!pool.length) pool = cands;
    return pool[salt % pool.length].i;
  }
  function shotVec(dir, salt) {
    const L = S.L, jit = ((salt % 17) / 16 - 0.5) * 0.26;
    let a = dir === 'leg' ? 0.85 : dir === 'off' ? -0.85 : 0.1;    // angle from +z, leg positive
    a = (a + jit) * L;
    return [Math.sin(a), Math.cos(a)];
  }
  function pickShotAnim(dir, kind, length) {
    if (kind === 'defend') return ANIMS.defend;
    if (kind === 'loft') return ANIMS.loft;
    if (dir === 'leg') return length === 'short' ? ANIMS.pull : ANIMS.flick;
    if (dir === 'off') return length === 'short' ? ANIMS.cut : ANIMS.drive;
    return ANIMS.drive;
  }
  function normDir(d) { return d === 'left' ? 'leg' : d === 'right' ? 'off' : (d === 'leg' || d === 'off') ? d : 'straight'; }
  function ensureSwing(dir, kind, now) {
    if (now - S.swingT < 600) return;
    S.swingT = now; S.swingDir = dir;
    const len = S.delivery ? S.delivery.length : 'good';
    striker.add(now - 140, now + 860, pickShotAnim(dir, kind, len), { yaw: -Math.PI / 2, blend: 60 });
  }
  function scheduleRuns(t, n) {
    let ts = t; const runMs = 1150, turnMs = 240, mN = nonStriker.mirror;
    for (let k = 0; k < n; k++) {
      const fwd = k % 2 === 0;
      const nearS = [k === 0 ? 0.38 : -1.3, k === 0 ? 0.78 : 0.4], farS = [-1.3, 19.7];
      striker.add(ts, ts + runMs, ANIMS.runBat, { from: fwd ? nearS : farS, to: fwd ? farS : nearS, rate: 2.4, blend: 120 });
      const nearN = [1.3 * mN, 0.4], farN = [1.3 * mN, 19.4];
      nonStriker.add(ts, ts + runMs, ANIMS.runBat, { from: fwd ? farN : nearN, to: fwd ? nearN : farN, rate: 2.4, blend: 120 });
      ts += runMs;
      if (k < n - 1) { striker.add(ts, ts + turnMs, ANIMS.stand, { blend: 120 }); nonStriker.add(ts, ts + turnMs, ANIMS.stand, { blend: 120 }); ts += turnMs; }
    }
    striker.add(ts, ts + 600, ANIMS.nsStand, { blend: 250 }); nonStriker.add(ts, ts + 600, ANIMS.nsStand, { blend: 250 });
  }
  function fielderThrowBack(fi, t, bx, bz, afterMs) {
    // fielder fi runs to (bx,bz), picks the ball up and throws it to the keeper; returns the arrival time of the throw
    const f = fielders[fi], d = Math.hypot(bx - f.home.x, bz - f.home.z);
    const tArrive = Math.max(t + afterMs, t + d / 7.5 * 1000);
    f.add(t, tArrive, ANIMS.run, { to: [bx - (bx - f.home.x) * 0.02, bz - (bz - f.home.z) * 0.02], rate: 2.6, ease: 1 });
    const kx = keeper.home.x, kz = keeper.home.z + 0.45;
    f.add(tArrive, tArrive + 380, ANIMS.pickup, { yaw: Math.atan2(kx - bx, kz - bz) });
    f.add(tArrive + 380, tArrive + 1080, ANIMS.throw, { yaw: Math.atan2(kx - bx, kz - bz) });
    f.add(tArrive + 1080, tArrive + 1500, ANIMS.stand, {});
    const tRel = tArrive + 380 + 420, dist = Math.hypot(kx - bx, kz - bz), fl = 600 + dist * 9;
    path.add(path.tEnd, tArrive + 150, bx, BALL_R, bz, bx, BALL_R, bz, 0, 0);   // waiting on the grass
    path.then(tRel - tArrive - 150, bx, 0.9, bz, 0, 0);                          // picked up
    path.add(tRel, tRel + fl, bx, 1.6, bz, kx, 1.0, kz, 1.2 + dist * 0.035, 0);
    keeper.add(tRel + fl - 300, tRel + fl + 700, ANIMS.take, { yaw: Math.atan2(bx - kx, bz - kz) });
    return tRel + fl;
  }
  function allCelebrate(t, exceptIdx) {
    fieldingSide.forEach((a, i) => { if (a === fielders[exceptIdx]) return; a.add(t + i * 40, t + 3200, ANIMS.celebrate, { blend: 200 }); });
  }
  function allAppeal(t) {
    [bowler, keeper, fielders[0], fielders[1], fielders[8]].forEach((a, i) => a.add(t + i * 50, t + 4000, ANIMS.appeal, { yaw: Math.atan2(umpire.home.x - a.home.x, umpire.home.z - a.home.z), blend: 200 }));
  }

  // ---- public API --------------------------------------------------------------------
  R.setMatch = function (m) {
    const teams = (m && Array.isArray(m.teams)) ? m.teams : [];
    S.teams = [Object.assign({}, DEFAULT_TEAMS[0], teams[0] || {}), Object.assign({}, DEFAULT_TEAMS[1], teams[1] || {})];
    applyKits();
    S.screenText[0] = null; paintScreen('MY CRICKET', 'Night match  •  T20 final');
  };
  R.setScene = function (sc) {
    sc = sc || {};
    if (sc.battingSlot === 0 || sc.battingSlot === 1) S.battingSlot = sc.battingSlot;
    S.bowlingSlot = (sc.bowlingSlot === 0 || sc.bowlingSlot === 1) ? sc.bowlingSlot : 1 - S.battingSlot;
    S.hand = sc.striker && sc.striker.hand === 'L' ? 'L' : 'R';
    S.nsHand = sc.nonStriker && sc.nonStriker.hand === 'L' ? 'L' : 'R';
    S.L = S.hand === 'L' ? -1 : 1;
    const bt = sc.bowler && sc.bowler.type; S.bowlerType = KEEPER_Z[bt] ? bt : 'fast';
    S.zk = KEEPER_Z[S.bowlerType];
    applyKits(); placeHomes();
  };
  R.startDelivery = function (ev, t0) {
    ev = ev || {}; t0 = +t0 || S.now;
    const lead = Math.max(300, +ev.lead || 1100), flightMs = Math.max(250, +ev.flightMs || 800);
    const pace = ev.pace || 'fast';
    const type = KEEPER_Z[ev.bowlerType] ? ev.bowlerType : (pace === 'spin' || pace === 'arm') ? 'spin' : S.bowlerType;
    if (type !== S.bowlerType) { S.bowlerType = type; S.zk = KEEPER_Z[type]; placeHomes(); }
    const li = clamp(Math.round(+ev.lineIndex || 0), -1, 3), turn = clamp(Math.round(+ev.turn || 0), -1, 1);
    const length = PITCH_Z[ev.length] ? ev.length : 'good';
    const L = S.L, xr = -0.35, zr = 18.7, hr = type === 'spin' ? 2.0 : pace === 'slower' ? 2.2 : 2.3;
    const zp = PITCH_Z[length], hb = BAT_H[length], xLine = lineX(li), xArr = lineX(li + turn);
    const xp = xr + (xLine - xr) * (zr - zp) / (zr - BAT_Z);
    const tb = t0 + flightMs * (zr - zp) / (zr - BAT_Z);
    const zk = S.zk + 0.45, v = (zp - BAT_Z) / (t0 + flightMs - tb), dtk = (zp - zk) / v;
    const xk = xp + (xArr - xp) / (zp - BAT_Z) * (zp - zk);
    const dtb = (t0 + flightMs - tb) / 1000, v1 = (hb - BALL_R + 0.5 * G * dtb * dtb) / dtb, tks = dtk / 1000;
    const yk = Math.max(BALL_R, BALL_R + v1 * tks - 0.5 * G * tks * tks);
    // actors first (they clear anything still running from the previous ball)
    for (const a of everyone) a.reset();
    resetStumps(); overlay.hideAll(); S.sig.kind = null; S.sigQ.kind = null; S.result = null; S.review = null; hawk.group.visible = false;
    S.swingT = -1e9; S.wave.t1 = -1e9;
    const A = Math.min(450, lead * 0.4), runLen = RUN_LEN[type], runMs = lead - A;
    const rate = Math.min(3.6, (runLen / (runMs / 1000)) / 3.2);
    bowler.add(t0 - lead, t0 - A, ANIMS.run, { from: [-0.65, PITCH_LEN + 1.2 + runLen], to: [-0.65, PITCH_LEN + 0.95], rate, yaw: Math.PI, blend: 200 });
    bowler.add(t0 - A, t0 + A, ANIMS.bowl, { to: [-0.75, 17.9], yaw: Math.PI, blend: 80 });
    bowler.add(t0 + A, t0 + A + 900, ANIMS.jog, { to: [-2.3, 15.2], rate: 2.2, yaw: Math.PI, ease: 1, blend: 150 });
    bowler.add(t0 + A + 900, t0 + A + 1500, ANIMS.stand, { yaw: Math.PI, blend: 300 });
    striker.add(t0 + flightMs * 0.3, t0 + flightMs * 0.8, ANIMS.ready_bat, { yaw: -Math.PI / 2, blend: 100 });
    path.clear();
    path.add(t0, tb, xr, hr, zr, xp, BALL_R, zp, gravityBulge(tb - t0), 0);
    path.add(tb, tb + dtk, xp, BALL_R, zp, xk, yk, zk, gravityBulge(dtk), 0);
    keeper.add(tb + dtk - 280, tb + dtk + 700, yk > 1.1 ? ANIMS.takeHigh : ANIMS.take, { yaw: 0 });
    S.delivery = { t0, lead, flightMs, li, turn, length, pace, type, xArr, hb, tBat: t0 + flightMs, tKeeper: tb + dtk };
    S.camPlan.length = 0; camPush(t0 - lead, 'bat', 600);
    paintScreen('MY CRICKET', 'Night match  •  T20 final');
  };
  R.swing = function (dir, now) { now = +now || S.now; ensureSwing(normDir(dir), 'attack', now); };
  R.startResult = function (ev, now) {
    ev = ev || {}; now = +now || S.now;
    const d = S.delivery, L = S.L;
    const salt = hashStr(ev.commentary || '') % 1000;
    const bx = d ? d.xArr : 0, by = d ? d.hb : 0.7, bz = BAT_Z;
    const shot = ev.shot ? { dir: normDir(ev.shot.dir), kind: ev.shot.kind || 'attack' } : null;
    const contact = ev.contact !== false && !ev.wide && !!shot;
    const wicket = ev.type === 'wicket' ? (ev.wicketKind || 'bowled') : null;
    const pending = !!ev.decisionPending;
    S.result = { t0: now, ev, tEnd: now + 2500 };
    S.camPlan.length = 0; camPush(now - 1, 'bat', 0);
    if (contact || wicket) for (const a of [keeper, ...fielders]) a.cut(now);
    if (shot && (contact || wicket === 'caught')) ensureSwing(shot.dir, shot.kind, now);
    else if (!ev.wide && !shot && now - S.swingT > 600) striker.add(now - 100, now + 900, ANIMS.beaten, { yaw: -Math.PI / 2, blend: 80 });
    if (wicket === 'bowled') {
      const stumpX = bx > 0.057 ? 2 : bx < -0.057 ? 0 : 1, tHit = now + 55;
      path.clear();
      path.add(now, tHit, bx, by, bz, (stumpX - 1) * 0.114, 0.45, 0.03, 0, 0);
      path.then(620, (stumpX - 1) * 0.114 + L * 0.7, BALL_R, -3.2, 0.55, 0);
      path.then(800, (stumpX - 1) * 0.114 + L * 1.1, BALL_R, -4.6, 0, 1);
      S.shatter.t = tHit; S.shatter.stump = stumpX; S.shatter.dir = L;
      striker.add(now - 100, now + 1800, ANIMS.beaten, { yaw: -Math.PI / 2, blend: 80 });
      striker.add(now + 1800, now + 5000, ANIMS.walkOff, { to: [-0.3, -7], rate: 1.4 });
      keeper.add(tHit + 250, tHit + 3000, ANIMS.celebrate, { yaw: Math.PI, blend: 200 });
      bowler.add(tHit + 500, tHit + 3400, ANIMS.celebrate, { yaw: Math.PI, blend: 250 });
      fielders.forEach((f, i) => f.add(tHit + 600 + i * 40, tHit + 3400, ANIMS.celebrate, { blend: 250 }));
      camPush(now, 'sideLow', 0); camPush(tHit + 1500, 'bowlerEnd', 0); camPush(tHit + 3300, 'bat', 1100);
      S.result.tEnd = tHit + 3300; S.wave.t0 = tHit + 300; S.wave.t1 = tHit + 2800;
      paintScreen('BOWLED!', 'stumps shattered');
    } else if (wicket === 'lbw') {
      const px = clamp(bx, -L * 0.2, L * 0.5), py = Math.min(by, 0.5), tPad = now + 30;
      path.clear();
      path.add(now, tPad, bx, by, bz, px, py, 1.0, 0, 0);
      path.then(480, px - L * 0.4, BALL_R, 1.8, 0.14, 0);
      path.then(600, px - L * 0.6, BALL_R, 2.6, 0, 1);
      striker.cut(now - 200); striker.add(now - 80, now + 2400, ANIMS.padHit, { yaw: -Math.PI / 2, blend: 60 });
      allAppeal(now + 150);
      camPush(now, 'sideLow', 0); camPush(now + 1000, 'umpire', 0);
      if (pending) { umpire.add(now + 400, now + 9000, ANIMS.deliberate, { yaw: Math.PI, blend: 300 }); S.result.tEnd = now + 9000; }
      else { queueSignal('out', now + 1000); striker.add(now + 2400, now + 6000, ANIMS.walkOff, { to: [-0.3, -7], rate: 1.4 }); allCelebrate(now + 1500, -1); camPush(now + 3400, 'bat', 1100); S.result.tEnd = now + 3400; }
      paintScreen('APPEAL!', 'lbw?');
    } else if (wicket === 'caught') {
      const zone = ev.fielderZone === 'keeper' ? 'keeper' : (ev.fielderZone === 'leg' || ev.fielderZone === 'off' || ev.fielderZone === 'straight') ? ev.fielderZone : (shot ? shot.dir : 'straight');
      let tCatch, catcher = null;
      path.clear();
      if (zone === 'keeper') {
        const kx = keeper.home.x, kz = keeper.home.z + 0.5, fl = Math.max(120, (bz - kz) / 0.021);
        tCatch = now + fl;
        path.add(now, tCatch, bx, by, bz, kx - L * 0.1, 0.95, kz, 0.05, 0);
        keeper.add(tCatch - 300, tCatch + 1000, ANIMS.take, { yaw: 0 });
        keeper.add(tCatch + 1000, tCatch + 3500, pending ? ANIMS.appeal : ANIMS.celebrate, { yaw: Math.PI, blend: 200 });
      } else {
        const fi = zoneCatcher(zone, shot ? shot.kind : 'attack', salt), p = S.layout[fi];
        catcher = fielders[fi]; S.catcher = catcher;
        const dx = p.x - bx, dz = p.z - bz, dist = Math.hypot(dx, dz), ux = dx / dist, uz = dz / dist;
        const cx = p.x - ux * 1.6, cz = p.z - uz * 1.6, high = (shot && shot.kind === 'loft') || dist > 30;
        const fl = high ? 1100 + dist * 22 : 500 + dist * 18, bulge = high ? 7 + dist * 0.16 : 1.0 + dist * 0.04;
        tCatch = now + fl;
        path.add(now, tCatch, bx, by, bz, cx - ux * 0.4, high ? 1.9 : 1.25, cz - uz * 0.4, bulge, 0);
        catcher.add(now + 100, tCatch - 350, ANIMS.run, { to: [cx, cz], rate: 2.4, ease: 1 });
        catcher.add(tCatch - 350, tCatch + 800, high ? ANIMS.catchHigh : ANIMS.catch, { yaw: Math.atan2(bx - cx, bz - cz) });
        catcher.add(tCatch + 800, tCatch + 3800, pending ? ANIMS.appeal : ANIMS.celebrate, { blend: 200 });
      }
      S.wave.t0 = tCatch + 200; S.wave.t1 = tCatch + 2600;
      if (pending) { allAppeal(tCatch + 150); umpire.add(tCatch + 500, tCatch + 9000, ANIMS.deliberate, { yaw: Math.PI, blend: 300 }); camPush(now, 'follow', 0); camPush(tCatch + 900, 'umpire', 0); S.result.tEnd = tCatch + 9000; }
      else {
        allCelebrate(tCatch + 300, catcher ? fielders.indexOf(catcher) : -1);
        queueSignal('out', tCatch + 700);
        striker.add(now + 1400, now + 6000, ANIMS.walkOff, { to: [-0.3, -7], rate: 1.4 });
        camPush(now, 'follow', 0); camPush(tCatch + 500, catcher ? 'catcher' : 'bat', catcher ? 0 : 800); camPush(tCatch + 2600, 'bat', 1100);
        S.result.tEnd = tCatch + 2600;
      }
      paintScreen(pending ? 'APPEAL!' : 'CAUGHT!', pending ? 'is it out?' : 'a fine catch');
    } else if (contact) {
      const runs = clamp(Math.round(+ev.runs || 0), 0, 6), [ux, uz] = shotVec(shot.dir, salt);
      const sRope = ropeHit(bx, bz, ux, uz);
      if (runs >= 6) {
        const sEnd = sRope + 12 + (salt % 7), T = 2600 + sEnd * 4, tCross = now + T * (sRope / sEnd);
        path.clear();
        path.add(now, now + T, bx, by, bz, bx + ux * sEnd, 2.2, bz + uz * sEnd, 13 + sEnd * 0.06, 0);
        path.then(500, bx + ux * (sEnd + 3), 2.2, bz + uz * (sEnd + 3), 0.5, 1);
        const fi = nearestFielder(bx + ux * sRope, bz + uz * sRope, true), f = fielders[fi];
        f.add(now + 150, tCross + 200, ANIMS.run, { to: [bx + ux * (sRope - 4), bz + uz * (sRope - 4)], rate: 2.4, ease: 1 });
        f.add(tCross + 200, tCross + 3000, ANIMS.watch, {});
        striker.add(now + 900, now + 4500, ANIMS.raiseBat, { yaw: -Math.PI / 2, blend: 300 });
        queueSignal('six', tCross + 100);
        S.wave.t0 = tCross; S.wave.t1 = tCross + 3200;
        camPush(now, 'follow', 0); camPush(now + T + 700, 'bat', 1300); S.result.tEnd = now + T + 700;
      } else if (runs >= 4) {
        const sEnd = sRope + 3.5, T = 1700 + sEnd * 11, tCross = now + T * 0.93;
        path.clear();
        if (shot.kind === 'loft') { path.add(now, now + T * 0.45, bx, by, bz, bx + ux * sEnd * 0.5, BALL_R, bz + uz * sEnd * 0.5, 5, 0); addGroundTravel(path, now + T * 0.45, bx + ux * sEnd * 0.5, BALL_R, bz + uz * sEnd * 0.5, bx + ux * sEnd, bz + uz * sEnd, T * 0.55, 0.9); }
        else addGroundTravel(path, now, bx, by, bz, bx + ux * sEnd, bz + uz * sEnd, T, 1.0 + sEnd * 0.012);
        const fi = nearestFielder(bx + ux * sRope, bz + uz * sRope, true), f = fielders[fi];
        f.add(now + 150, tCross + 350, ANIMS.run, { to: [bx + ux * (sRope - 2), bz + uz * (sRope - 2)], rate: 2.6, ease: 1 });
        f.add(tCross + 350, tCross + 3000, ANIMS.hips, {});
        striker.add(now + 900, now + 2200, ANIMS.jogBat, { to: [-0.8, 4], rate: 1.6, ease: 1, blend: 250 });
        striker.add(now + 2200, now + 4000, ANIMS.nsStand, { blend: 300 });
        nonStriker.add(now + 300, now + 1400, ANIMS.jogBat, { to: [1.3 * nonStriker.mirror, 15.5], rate: 1.6, ease: 1 });
        queueSignal('four', tCross + 250);
        S.wave.t0 = tCross; S.wave.t1 = tCross + 2600;
        camPush(now, 'follow', 0); camPush(now + T + 500, 'bat', 1300); S.result.tEnd = now + T + 500;
      } else {
        const base = runs === 0 ? (shot.kind === 'defend' ? 4 : 9) : runs === 1 ? 26 : runs === 2 ? 44 : 57;
        const dist = Math.min(base + (salt % 5) - 2, sRope - 2.5), ex = bx + ux * dist, ez = bz + uz * dist, T = 700 + dist * 24;
        path.clear();
        if (shot.kind === 'loft' && runs > 0) { path.add(now, now + T * 0.5, bx, by, bz, bx + ux * dist * 0.6, BALL_R, bz + uz * dist * 0.6, 3 + dist * 0.08, 0); addGroundTravel(path, now + T * 0.5, bx + ux * dist * 0.6, BALL_R, bz + uz * dist * 0.6, ex, ez, T * 0.5, 0.5); }
        else addGroundTravel(path, now, bx, by, bz, ex, ez, T, runs === 0 ? 0.25 : 0.8 + dist * 0.01);
        const fi = nearestFielder(ex, ez, false);
        const tBack = fielderThrowBack(fi, now + 200, ex, ez, T - 300);
        if (runs > 0) scheduleRuns(now + 450, runs);
        camPush(now, runs === 0 ? 'bat' : 'follow', 0); camPush(tBack + 300, 'bat', 1000); S.result.tEnd = tBack + 600;
      }
    } else {
      // no contact: through to the keeper on the delivery path (already scheduled); a wide gets its signal
      if (!d) { path.clear(); path.add(now, now + 450, bx, by, bz, keeper.home.x, 0.9, keeper.home.z + 0.45, 0.1, 0); keeper.add(now + 150, now + 1100, ANIMS.take, { yaw: 0 }); }
      if (ev.wide) { queueSignal('wide', now + 350); striker.add(now - 100, now + 1500, ANIMS.watch, { yaw: -Math.PI / 2, blend: 150 }); }
      S.result.tEnd = now + 1800;
    }
  };
  R.showDecision = function (decision, now) {
    now = +now || S.now; const out = decision === 'out';
    S.sigQ.kind = null; setSignal(out ? 'out' : 'notout', now);
    if (out) { allCelebrate(now + 300, -1); striker.add(now + 1200, now + 6000, ANIMS.walkOff, { to: [-0.3, -7], rate: 1.4 }); S.wave.t0 = now + 300; S.wave.t1 = now + 2800; }
    else { fieldingSide.forEach((a, i) => a.add(now + 200 + i * 30, now + 3000, ANIMS.slump, { blend: 300 })); striker.add(now + 300, now + 2500, ANIMS.stance, { yaw: -Math.PI / 2, blend: 400 }); }
    camPush(now, 'umpire', 0); camPush(now + 2400, 'bat', 1000);
    if (S.result) S.result.tEnd = now + 2400;
  };
  R.startReview = function (data, now) {
    data = data || {}; now = +now || S.now;
    const dur = Math.max(2500, +data.durationMs || 7000), kind = data.kind === 'caught' ? 'caught' : 'lbw';
    S.review = { data, t0: now, dur, kind, out: data.verdict === 'out', stampShown: false, tCross: 0 };
    S.sig.kind = null; S.sigQ.kind = null; overlay.hideAll();
    overlay.slateKind.textContent = kind.toUpperCase(); overlay.slateSub.textContent = 'Third umpire checking…';
    overlay.boxEls.forEach((b) => { b.classList.remove('show'); });
    umpire.add(now, now + dur, ANIMS.deliberate, { yaw: Math.PI, blend: 300 });
    if (kind === 'lbw') buildHawk(data);
    else { striker.add(now, now + dur * 0.86, ANIMS.ueHold, { yaw: -Math.PI / 2, blend: 200 }); S.review.tCross = now + (0.16 + 0.44 * 0.55) * dur; }
    const tStamp = now + dur * 0.88;
    umpire.add(tStamp, now + dur + 1500, S.review.out ? ANIMS.out : ANIMS.notout, { yaw: Math.PI, blend: 200 });
    if (S.review.out) { allCelebrate(tStamp + 200, -1); striker.add(tStamp + 600, now + dur + 5000, ANIMS.walkOff, { to: [-0.3, -7], rate: 1.4 }); S.wave.t0 = tStamp; S.wave.t1 = now + dur + 1500; }
    else { fieldingSide.forEach((a, i) => a.add(tStamp + 200 + i * 30, now + dur + 1500, ANIMS.slump, { blend: 300 })); striker.add(tStamp + 300, now + dur + 1500, ANIMS.stance, { yaw: -Math.PI / 2, blend: 400 }); }
    camPush(now, kind === 'lbw' ? 'hawkeye' : 'ultraedge', 0); camPush(now + dur, 'bat', 900);
    if (S.result) S.result.tEnd = now + dur + 1500;
    paintScreen('REVIEW', kind.toUpperCase());
  };
  R.signal = function (kind, now) {
    now = +now || S.now; if (!ANIMS[kind] || !/^(four|six|wide|noball|out|notout)$/.test(kind)) return;
    S.sigQ.kind = null; setSignal(kind, now);
  };
  R.celebrate = function (kind, now) {
    now = +now || S.now;
    S.celeb.kind = kind === 'six' || kind === 'four' || kind === 'wicket' || kind === 'win' ? kind : 'four'; S.celeb.t = now;
    S.wave.t0 = now; S.wave.t1 = now + (kind === 'win' ? 5000 : 2600);
  };
  R.idle = function () {
    for (const a of everyone) a.reset();
    path.clear(); resetStumps(); overlay.hideAll(); hawk.group.visible = false;
    S.delivery = null; S.result = null; S.review = null; S.sig.kind = null; S.sigQ.kind = null; S.celeb.kind = null;
    S.wave.t1 = -1e9; S.swingT = -1e9; ball.visible = false; trail.count = 0; trailLine.visible = false; fireworks.visible = false;
    camPush(S.now, 'bat', 900);
    placeHomes();
  };
  R.resize = function () {
    const w = canvas.clientWidth || canvas.width || 480, h = canvas.clientHeight || canvas.height || 640;
    if (w < 2 || h < 2) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (w !== S.w || h !== S.h || dpr !== S.dpr) {
      S.w = w; S.h = h; S.dpr = dpr;
      gl.setPixelRatio(dpr); gl.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    overlay.setSize(canvas.offsetLeft, canvas.offsetTop, w, h);
    const wantShadows = w > 700;
    if (wantShadows !== S.shadows) {
      S.shadows = wantShadows; gl.shadowMap.enabled = wantShadows; key.castShadow = wantShadows;
      scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.needsUpdate = true; } });
    }
  };

  // ---- Hawk-Eye replay geometry (built per review; allocations here are fine) ------------
  function buildHawk(data) {
    const L = S.L, d = S.delivery, len = d ? d.length : 'good';
    const zp = PITCH_Z[len], hr = 2.2, zr = 18.7, xr = -0.35, zi = 1.0;
    const xp = data.pitching === 'outside-leg' ? L * 0.42 : data.pitching === 'outside-off' ? -L * 0.45 : L * 0.04;
    const hi = clamp(BAT_H[len], 0.3, 0.75);
    const xi = data.impact === 'outside' ? -L * 0.42 : L * 0.05;
    const w = data.wickets;
    const xw = w === 'missing' ? L * 0.36 : w === 'umpires-call' ? L * 0.14 : xi * 0.6, yw = w === 'missing' ? 0.8 : w === 'umpires-call' ? 0.7 : 0.45;
    const ti = 650, tb = ti * (zr - zp) / (zr - zi), v = (zp - zi) / (ti - tb), tw = ti + 1.4 / v;
    hawkPath.clear();
    hawkPath.add(0, tb, xr, hr, zr, xp, BALL_R, zp, gravityBulge(tb), 0);
    const dt = (ti - tb) / 1000, v1 = (hi - BALL_R + 0.5 * G * dt * dt) / dt;
    hawkPath.add(tb, ti, xp, BALL_R, zp, xi, hi, zi, gravityBulge(ti - tb) * (v1 > 0 ? 1 : 0.5), 0);
    hawkPath.add(ti, tw, xi, hi, zi, xw, yw, -0.4, 0.02, 0);
    const pts = [];
    for (let i = 0; i <= 48; i++) { const p = new THREE.Vector3(); hawkPath.at(i / 48 * ti, p); pts.push(p); }
    const curve = new THREE.CatmullRomCurve3(pts);
    if (hawk.tube) { hawk.group.remove(hawk.tube); hawk.group.remove(hawk.glow); hawk.group.remove(hawk.dashed); hawk.tube.geometry.dispose(); hawk.glow.geometry.dispose(); hawk.dashed.geometry.dispose(); }
    hawk.tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.036, 8, false), new THREE.MeshBasicMaterial({ color: 0x9df2ff }));
    hawk.glow = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.07, 8, false), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    const dg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xi, hi, zi), new THREE.Vector3(lerp(xi, xw, 0.5), lerp(hi, yw, 0.5) + 0.03, lerp(zi, -0.4, 0.5)), new THREE.Vector3(xw, yw, -0.4)]);
    hawk.dashed = new THREE.Line(dg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.1, gapSize: 0.07 })); hawk.dashed.computeLineDistances();
    hawk.group.add(hawk.tube); hawk.group.add(hawk.glow); hawk.group.add(hawk.dashed);
    hawk.ghost.position.set(xw, yw, 0.0);
    hawk.ti = ti; hawk.tw = tw; hawk.tubeIdx = hawk.tube.geometry.index.count;
    hawk.group.visible = false;
  }

  // ---- camera modes (pure functions of t) ------------------------------------------------
  function camMode(mode, t, pos, look) {
    const L = S.L;
    switch (mode) {
      case 'follow': {
        const vis = ballAt(t, _v3);
        if (!vis) { _v3.set(0, 1, 8); }
        const bz = clamp(_v3.z, -8, 90), by = Math.max(0, _v3.y);
        pos.set(_v3.x * 0.22, 7.5 + by * 0.35 + Math.max(0, bz) * 0.07, -12 + (bz + 8) * 0.22);
        look.set(_v3.x * 0.8, 1 + (by - 1) * 0.8, 8 + (_v3.z - 8) * 0.85);
        return;
      }
      case 'sideLow': pos.set(-L * 7.5, 1.5, 3.4); look.set(0, 0.6, 0.7); return;
      case 'bowlerEnd': pos.set(-2.2, 3.4, 31); look.set(0, 1.0, 6); return;
      case 'umpire': pos.set(1.4, 2.1, 12.5); look.set(0.3, 1.25, PITCH_LEN + 2.6); return;
      case 'catcher': {
        const c = S.catcher || fielders[0];
        const dx = -c.pos.x, dz = 10 - c.pos.z, d = Math.hypot(dx, dz) || 1;
        pos.set(c.pos.x + dx / d * 6.5, 2.4, c.pos.z + dz / d * 6.5); look.set(c.pos.x, 1.2, c.pos.z); return;
      }
      case 'hawkeye': {
        const rv = S.review, f = rv ? clamp01((t - rv.t0 - 0.16 * rv.dur) / (0.44 * rv.dur)) : 1;
        pos.set(-L * 10.5, 2.3, 10.5 - 6.5 * f); look.set(0, 0.7, 8.5 - 6.5 * f); return;
      }
      case 'ultraedge': pos.set(-L * 2.8, 1.0, 2.1); look.set(L * 0.1, 0.72, 1.15); return;
      default: pos.set(0, 5.6, -11.5); look.set(0, 2.1, 12);
    }
  }
  function camEval(t) {
    let e = null;
    for (const x of S.camPlan) { if (x.t <= t) e = x; else break; }
    if (!e) { camMode('bat', t, _pos, _look); return; }
    camMode(e.mode, t, _pos, _look);
    if (e.blend > 0 && t - e.t < e.blend) {
      const s = smooth((t - e.t) / e.blend);
      camMode(e.from, t, _v, _v2);
      _pos.lerpVectors(_v, _pos, s); _look.lerpVectors(_v2, _look, s);
    }
  }
  function ballAt(t, out) {
    const d = S.delivery;
    if (d && t < d.t0) {
      if (t < d.t0 - d.lead + 50) return false;
      bowler.fig.root.updateMatrixWorld(true); bowler.fig.handR.getWorldPosition(out); out.y -= 0.07; return true;
    }
    if (!path.n) return false;
    return path.at(t, out) >= 0;
  }

  // ---- per-frame update --------------------------------------------------------------
  function updateStumps(t) {
    const sh = S.shatter; if (t < sh.t) return;
    const tau = Math.min(1.6, (t - sh.t) / 1000), st = stumpsA.stumps[sh.stump];
    st.rotation.x = -Math.min(1.45, tau * 7); st.rotation.y = Math.min(2, tau * 3) * sh.dir;
    st.position.z = -Math.min(0.9, tau * 2.4); st.position.y = Math.max(0, 1.2 * tau - 4.9 * tau * tau);
    stumpsA.bails.forEach((b, i) => {
      const vx = (i - 0.5) * 1.4 + sh.dir * 0.6, vy = 2.6 + i * 0.5, vz = -3.4 - i * 0.4;
      const tl = (vy + Math.sqrt(vy * vy + 4 * 4.9 * 0.71)) / 9.8, k = Math.min(tau, tl);
      b.position.set((i - 0.5) * 0.114 + vx * k, Math.max(0.012, 0.72 + vy * k - 4.9 * k * k), vz * k);
      b.rotation.set(k * 9, 0, k * 14);
    });
  }
  function updateReview(t) {
    const rv = S.review; if (!rv) { hawk.group.visible = false; return; }
    const f = (t - rv.t0) / rv.dur;
    if (f >= 1.25) { S.review = null; overlay.hideAll(); hawk.group.visible = false; return; }
    const O = overlay;
    O.show(O.tag, f < 1 && !(rv.kind === 'lbw' && f >= 0.6));
    O.show(O.slate, f < 0.16);
    const showStamp = f >= 0.88 && f < 1.0;
    if (showStamp && !rv.stampShown) {
      rv.stampShown = true; O.stampTxt.textContent = rv.out ? 'OUT' : 'NOT OUT'; O.stamp.className = 'rb-stamp ' + (rv.out ? 'out' : 'notout');
      O.stampSub.textContent = rv.data.overturned ? 'Decision overturned' : rv.data.wickets === 'umpires-call' ? "Umpire's call, decision stands" : 'Decision stands';
    }
    O.show(O.stamp, showStamp);
    if (rv.kind === 'lbw') {
      O.show(O.ue, false);
      hawk.group.visible = f >= 0.16 && f < 1.0;
      const rf = clamp01((f - 0.16) / 0.44), pt = rf * hawk.ti;
      hawk.tube.geometry.setDrawRange(0, Math.floor(rf * 64) * 48);
      hawk.glow.geometry.setDrawRange(0, Math.floor(rf * 64) * 48);
      const proj = f >= 0.5;
      hawk.dashed.visible = proj; hawk.ghost.visible = proj;
      if (rf < 1) { hawkPath.at(pt, _v); ball.position.copy(_v); ball.visible = true; } else { hawkPath.at(hawk.ti, _v); ball.position.copy(_v); ball.visible = true; }
      const b = rv.data, show = f >= 0.6;
      O.show(O.boxes, show && f < 1.0);
      const pc = b.pitching === 'outside-leg' ? ['ok', 'OUTSIDE LEG'] : b.pitching === 'outside-off' ? ['bad', 'OUTSIDE OFF'] : b.pitching === 'inline' ? ['bad', 'IN LINE'] : ['', '—'];
      const ic = b.impact === 'outside' ? ['ok', 'OUTSIDE'] : b.impact === 'inline' ? ['bad', 'IN LINE'] : ['', '—'];
      const wc = b.wickets === 'missing' ? ['ok', 'MISSING'] : b.wickets === 'umpires-call' ? ['uc', "UMPIRE'S CALL"] : b.wickets === 'hitting' ? ['bad', 'HITTING'] : ['', '—'];
      O.setBox(0, pc[0], pc[1]); O.setBox(1, ic[0], ic[1]); O.setBox(2, wc[0], wc[1]);
      O.boxEls[0].classList.toggle('show', f >= 0.6); O.boxEls[1].classList.toggle('show', f >= 0.69); O.boxEls[2].classList.toggle('show', f >= 0.78);
      hawk.zone.visible = f >= 0.78;
      hawk.zone.material.color.setHex(wc[0] === 'ok' ? 0x22c55e : wc[0] === 'uc' ? 0xf59e0b : 0xef4444);
    } else {
      O.show(O.boxes, false);
      const inUE = f >= 0.16 && f < 1.0;
      O.show(O.ue, inUE);
      if (inUE) {
        const rf = clamp01((f - 0.16) / 0.44), d = S.delivery, L = S.L;
        const bx = d ? d.xArr : 0, by = d ? d.hb : 0.7, z = 4.5 - 6 * rf;
        const edge = rv.data.ultraEdge === true && z < BAT_Z;
        ball.position.set(bx - (edge ? L * 0.12 * (BAT_Z - z) : 0), by - (z < BAT_Z ? (BAT_Z - z) * 0.05 : 0), z); ball.visible = true;
        drawUltraEdge(t, rv);
        const ut = overlay.ue.firstElementChild;
        const txt = f >= 0.62 ? (rv.data.ultraEdge ? 'ULTRAEDGE  —  SPIKE DETECTED' : 'ULTRAEDGE  —  NO SPIKE') : 'ULTRAEDGE';
        if (ut.textContent !== txt) { ut.textContent = txt; ut.style.color = f >= 0.62 ? (rv.data.ultraEdge ? '#fca5a5' : '#86efac') : '#7fc8ff'; }
      }
    }
  }
  function drawUltraEdge(t, rv) {
    const g = overlay.ueCtx, W = 600, H = 120;
    g.fillStyle = '#02060f'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(127,200,255,0.25)'; g.lineWidth = 1;
    for (let x = 0; x < W; x += 50) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.strokeStyle = '#7fc8ff'; g.lineWidth = 2; g.beginPath();
    const slow = 8;                                   // replay slow-motion factor: 1 px = slow ms of real time
    for (let x = 0; x <= W; x++) {
      const ts = t - (420 - x) * slow;                // time represented by this column (marker at x=420)
      let a = Math.sin(ts * 0.021) * 1.2 + Math.sin(ts * 0.0073 + 1) * 1.5;
      if (x > 420) a = 0;
      if (rv.data.ultraEdge === true) { const dd = Math.abs(ts - rv.tCross); if (dd < 70) a += Math.sin(ts * 0.9) * 40 * (1 - dd / 70); }
      if (x === 0) g.moveTo(x, H / 2 - a); else g.lineTo(x, H / 2 - a);
    }
    g.stroke();
    g.fillStyle = '#ffd166'; g.fillRect(419, 0, 2, H);
    g.font = 'bold 16px Arial, Helvetica, sans-serif'; g.fillStyle = '#ffffff'; g.textAlign = 'left';
    g.fillText(t >= rv.tCross ? 'BALL PAST BAT' : 'BALL APPROACHING', 8, 20);
  }
  function updateSignals(t) {
    if (S.sigQ.kind && t >= S.sigQ.t) { const k = S.sigQ.kind; S.sigQ.kind = null; setSignal(k, S.sigQ.t); }
    const show = !S.review && S.sig.kind && t - S.sig.t >= 0 && t - S.sig.t < 2800;
    if (show) {
      const k = S.sig.kind, text = k === 'out' ? 'OUT' : k === 'notout' ? 'NOT OUT' : k === 'four' ? 'FOUR' : k === 'six' ? 'SIX' : k === 'wide' ? 'WIDE' : 'NO BALL';
      overlay.setInset(k, text);
    } else overlay.show(overlay.inset, false);
  }
  function updateEffects(t) {
    const waveOn = t >= S.wave.t0 && t < S.wave.t1;
    uWave.value = waveOn ? 1 : 0;
    const c = S.celeb, age = t - c.t;
    const fwOn = c.kind && c.kind !== 'wicket' && age >= 0 && age < 3200;
    fireworks.visible = fwOn;
    if (fwOn) {
      const pos = fwGeo.attributes.position.array, col = fwGeo.attributes.color.array, per = c.kind === 'four' ? 80 : 64, bursts = c.kind === 'four' ? 1 : 5;
      for (let i = 0; i < FW_N; i++) {
        const b = Math.floor(i / per);
        if (b >= bursts) { pos[i * 3 + 1] = -100; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
        const tau = (age - b * 420) / 1000, o = FW_ORIGINS[b % FW_ORIGINS.length];
        if (tau < 0 || tau > 1.7) { pos[i * 3 + 1] = -100; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
        pos[i * 3] = o[0] + fwVel[i * 3] * tau; pos[i * 3 + 1] = o[1] + fwVel[i * 3 + 1] * tau - 4 * tau * tau; pos[i * 3 + 2] = o[2] + fwVel[i * 3 + 2] * tau;
        const k = 1 - tau / 1.7, h = fwHue[i];
        col[i * 3] = k * (0.6 + 0.4 * Math.sin(h * 6.28)); col[i * 3 + 1] = k * (0.6 + 0.4 * Math.sin(h * 6.28 + 2.1)); col[i * 3 + 2] = k * (0.6 + 0.4 * Math.sin(h * 6.28 + 4.2));
      }
      fwGeo.attributes.position.needsUpdate = true; fwGeo.attributes.color.needsUpdate = true;
    }
    const flOn = c.kind && age >= 0 && age < (c.kind === 'win' ? 5000 : 2600);
    stadium.flashes.visible = flOn;
    if (flOn) {
      const col = stadium.flashes.geometry.attributes.color.array, n = col.length / 3;
      for (let i = 0; i < n; i++) { const ph = (t * 0.0021 + i * 0.6180339) % 1; const on = ph < 0.05 ? 1 : 0; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = on; }
      stadium.flashes.geometry.attributes.color.needsUpdate = true;
    }
  }
  function updateTrail(t) {
    const d = S.delivery;
    const flying = ball.visible && path.n && t > path.tStart && t < path.tEnd && !(d && t < d.t0) && !S.review;
    if (!flying) { trail.count = 0; trailLine.visible = false; return; }
    const lp = trailLineGeo.attributes.position.array;
    lp[0] = ball.position.x; lp[1] = ball.position.y; lp[2] = ball.position.z;
    let n = 0;
    for (let k = 1; k <= TRAIL_N; k++) {
      const tk = t - k * 18; if (tk < path.tStart) break;
      path.at(tk, _v); const s = 1 - k / (TRAIL_N + 1);
      _s.set(s, s, s); _m.compose(_v, _q, _s); trail.setMatrixAt(n, _m);
      lp[(n + 1) * 3] = _v.x; lp[(n + 1) * 3 + 1] = _v.y; lp[(n + 1) * 3 + 2] = _v.z; n++;
    }
    trail.count = n; trail.instanceMatrix.needsUpdate = true;
    trailLineGeo.setDrawRange(0, n + 1); trailLineGeo.attributes.position.needsUpdate = true; trailLine.visible = n > 1;
  }
  let frame = 0;
  function update(t) {
    uTime.value = t / 1000;
    for (const a of everyone) { a.evalAt(t); a.apply(); }
    // live ball (during a review the replay positions it)
    if (!S.review) { ball.visible = ballAt(t, _v); if (ball.visible) ball.position.copy(_v); }
    updateStumps(t);
    updateReview(t);
    updateTrail(t);
    updateSignals(t);
    updateEffects(t);
    if (S.result && t > S.result.tEnd + 6000) S.result = null;
    // camera
    if (debugCam) { camera.position.set(debugCam[0], debugCam[1], debugCam[2]); camera.lookAt(debugCam[3], debugCam[4], debugCam[5]); }
    else { camEval(t); camera.position.copy(_pos); camera.lookAt(_look); }
  }
  R.draw = function (now) {
    now = +now || 0; S.now = now;
    if ((frame++ & 63) === 0) R.resize();
    update(now);
    gl.render(scene, camera);
  };

  // ---- init ----------------------------------------------------------------------------
  S.sigQ = { kind: null, t: 0 };
  S.catcher = null;
  R.setMatch({ teams: DEFAULT_TEAMS });
  R.setScene({ battingSlot: 0, bowlingSlot: 1, striker: { name: 'Striker', hand: 'R' }, nonStriker: { name: 'Non-striker', hand: 'R' }, bowler: { name: 'Bowler', type: 'fast' } });
  R.idle();
  R.resize();
  if (typeof ResizeObserver === 'function') { try { new ResizeObserver(() => R.resize()).observe(canvas); } catch (e) { /* ignore */ } }
  window.addEventListener('resize', () => R.resize());
  return R;
}

window.Renderer = Renderer;
window.dispatchEvent(new Event('renderer-ready'));
