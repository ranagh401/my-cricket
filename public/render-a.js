// render-a.js - 3D renderer "A" for MY CRICKET: TV-broadcast-style stadium cricket on three.js r170.
//
// Late-afternoon Test-match television look: warm low sun, long soft shadows on desktop, muted greens,
// cream pitch, white sightscreens, tiered stands dotted with a crowd under a sweeping roof.
// Everything is procedural (geometry and canvas textures): no external image or model files.
//
// Loading: this is an ES module. At the end it publishes window.Renderer and dispatches the
// 'renderer-ready' event on window, so a classic script can wait for it:
//     window.addEventListener('renderer-ready', () => { const r = Renderer(canvas); ... });
//
// PUBLIC API (all times are performance.now() milliseconds; every method is safe to call in any order,
// any number of times, with missing or partial data):
//   const r = Renderer(canvasElement [, { shadows: true|false }]);   // plain call or `new` both work
//   r.setMatch({ teams: [ { name, short, color, color2 }, { name, short, color, color2 } ] })
//       kit colours for slot 0 and slot 1 (shirt = color, trim = color2). Called at match start / rematch.
//   r.setScene({ battingSlot, bowlingSlot, striker: { name, hand: 'R'|'L' }, nonStriker: { name, hand },
//                bowler: { name, type: 'fast'|'medium'|'spin' } })
//       who is on the field. A left-handed striker mirrors the batter and the line geometry; spinners
//       get a short run-up and the keeper stands up to the stumps.
//   r.startDelivery(ev, t0)   ev = { lineIndex: -1..3, turn: -1|0|1, length: 'short'|'good'|'full',
//                                    pace: 'fast'|'slower'|'spin'|'arm', flightMs, lead, bowlerType }
//       t0 = the instant the ball leaves the hand. The run-up and action play during the `lead` ms
//       before t0; the ball is at the bat EXACTLY at t0 + flightMs, pitching at the point for its
//       length and drifting sideways by `turn` lines after the bounce; untouched it carries to the keeper.
//   r.swing(dir, now)         dir = 'leg'|'straight'|'off': the batter plays a shot right now.
//   r.startResult(ev, now)    ev = { type: 'runs'|'wicket', runs, wicketKind, contact, wide, shot,
//                                    ball, fielderZone, commentary, decisionPending }   (see the brief)
//   r.showDecision('out'|'notout', now)      umpire's finger or head shake, plus the broadcast inset.
//   r.startReview(data, now)  TV DRS sequence (Hawk-Eye for lbw, UltraEdge for caught) over durationMs.
//   r.signal(kind, now)       'four'|'six'|'wide'|'noball'|'out'|'notout' umpire signal + inset.
//   r.celebrate(kind, now)    'six'|'four'|'wicket'|'win': crowd flashes, fireworks, confetti (brief).
//   r.idle()                  cancel everything, everyone back in position, batting camera.
//   r.draw(now)               render one frame (cheap when idle).
//   r.resize()                re-read the canvas CSS size (also done automatically on window resize).
//
// COORDINATES (metres): the striker's stumps are at the origin, +y is up. three.js is right-handed, so a
// y-up camera behind the striker shows world -x on the LEFT of the screen only if the pitch runs along
// -z: the bowler's stumps are therefore at z = -20.12 and the batter faces -z. All the x-side rules of
// the brief hold unchanged: a right-hander's leg side is -x (screen left in the batting camera), the
// off side is +x, line offsets at the stumps are leg -0.25, middle 0, off +0.25, wides +-1.0, mirrored
// for a left-hander. Pitching distances from the striker's stumps: short 11 m, good 7 m, full 3 m; the
// ball meets the bat 1.2 m in front of the stumps at 1.2 / 0.7 / 0.3 m height for short / good / full.
//
// No globals are created apart from window.Renderer. The renderer owns a small overlay <div> inside
// canvas.parentElement for 2D broadcast graphics (review slate, DRS verdict boxes, UltraEdge strip,
// umpire inset frame) and injects one <style> element for it; nothing outside that container is touched.
'use strict';

import * as THREE from './vendor/three.module.js';

// =====================================================================================================
// 1. Constants and small helpers
// =====================================================================================================
const TAU = Math.PI * 2;
const PITCH_LEN = 20.12;
const BOWL_Z = -PITCH_LEN;              // bowler's stumps
const CREASE = 1.22;                    // popping crease distance from the stumps
const BAT_Z = -1.2;                     // where the bat meets the ball
const FIELD_CZ = -PITCH_LEN / 2;        // centre of the ground
const ROPE_R = 66;                      // boundary rope radius from the centre
const STAND_R = 74;                     // front of the lower tier
const LINE_X = { '-1': -1.0, 0: -0.25, 1: 0, 2: 0.25, 3: 1.0 };
const PITCH_DIST = { short: 11, good: 7, full: 3 };
const BAT_H = { short: 1.2, good: 0.7, full: 0.3 };
const BALL_R = 0.036;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const easeOut = (t) => { t = clamp01(t); return 1 - (1 - t) * (1 - t) * (1 - t); };
const easeIn = (t) => { t = clamp01(t); return t * t * t; };
const easeInOut = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const span = (t, a, b) => clamp01((t - a) / (b - a));          // 0..1 as t goes from a to b
const num = (v, d) => (Number.isFinite(v) ? v : d);

// Deterministic PRNG (mulberry32) so the crowd, fielding choices and effects are repeatable frame to frame.
function rng(seed) {
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

function parseColor(c, fallback) {
  const col = new THREE.Color(fallback);
  if (typeof c === 'string' && c.trim()) { try { col.set(c.trim()); } catch (e) { /* keep fallback */ } }
  else if (typeof c === 'number') col.setHex(c);
  return col;
}

// Merge a list of (possibly indexed) geometries that share position/normal/uv into one non-indexed geometry.
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const g of parts) if (!geos.includes(g)) g.dispose();
  return out;
}
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v3a = new THREE.Vector3(), _v3b = new THREE.Vector3();
function transformed(geo, x, y, z, rx, ry, rz, sx, sy, sz) {
  _m4.compose(_v3a.set(x, y, z), _q.setFromEuler(_e.set(rx || 0, ry || 0, rz || 0)), _v3b.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz));
  return geo.applyMatrix4(_m4);
}

// =====================================================================================================
// 2. Procedural textures (canvas generated)
// =====================================================================================================
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(canvas, repeatX, repeatY, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeatX || repeatY) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeatX || 1, repeatY || 1); }
  t.anisotropy = 4;
  return t;
}
function noise(ctx, w, h, amount, random) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (random() - 0.5) * amount; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  ctx.putImageData(img, 0, 0);
}

function grassTexture() {
  const w = 256, h = 256, c = makeCanvas(w, h), ctx = c.getContext('2d'), r = rng(7);
  // four mown stripes per tile (tile = 20 m), alternating light / dark, running along z (texture v)
  for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#4f7a33' : '#5a8739'; ctx.fillRect(i * (w / 4), 0, w / 4, h); }
  noise(ctx, w, h, 22, r);
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 900; i++) { ctx.fillStyle = r() < 0.5 ? '#3f6a2a' : '#6a9644'; ctx.fillRect(r() * w, r() * h, 2, 2); }
  ctx.globalAlpha = 1;
  return tex(c, 10, 10);
}
function pitchTexture() {
  // 3.05 m x 25 m strip: v runs from z = +2.4 (behind the striker) to z = -22.6 (behind the bowler)
  const w = 256, h = 2048, c = makeCanvas(w, h), ctx = c.getContext('2d'), r = rng(11);
  const ppm = h / 25, zToY = (z) => (z + 22.6) * ppm, xToX = (x) => (x + 1.525) * (w / 3.05);
  ctx.fillStyle = '#d3c399'; ctx.fillRect(0, 0, w, h);
  noise(ctx, w, h, 26, r);
  // darker worn / rolled patches on a good length at both ends
  for (const [z0, z1] of [[-9.5, -5.5], [-14.6, -10.6]]) {
    const g = ctx.createLinearGradient(0, zToY(z0), 0, zToY(z1));
    g.addColorStop(0, 'rgba(120,96,60,0)'); g.addColorStop(0.5, 'rgba(120,96,60,0.28)'); g.addColorStop(1, 'rgba(120,96,60,0)');
    ctx.fillStyle = g; ctx.fillRect(0, zToY(z0), w, zToY(z1) - zToY(z0));
  }
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 2200; i++) { ctx.fillStyle = r() < 0.5 ? '#b9a67a' : '#e4d6ad'; ctx.fillRect(r() * w, r() * h, 2, 3); }
  ctx.globalAlpha = 1;
  // creases (white, 6 cm lines)
  ctx.fillStyle = '#f4f1e8';
  const line = (x0, x1, z, thick = 0.06) => ctx.fillRect(xToX(Math.min(x0, x1)), zToY(z) - (thick * ppm) / 2, Math.abs(x1 - x0) * (w / 3.05), thick * ppm);
  const vline = (x, z0, z1, thick = 0.06) => ctx.fillRect(xToX(x) - (thick * (w / 3.05)) / 2, zToY(Math.max(z0, z1)), thick * (w / 3.05), Math.abs(z1 - z0) * ppm);
  for (const sgn of [1, -1]) {
    const stumpZ = sgn === 1 ? 0 : BOWL_Z, dir = sgn === 1 ? -1 : 1;     // dir: toward the middle of the pitch
    line(-1.32, 1.32, stumpZ);                                          // bowling crease
    line(-1.525, 1.525, stumpZ + dir * CREASE);                         // popping crease
    vline(-1.32, stumpZ - dir * 0.8, stumpZ + dir * CREASE);            // return creases
    vline(1.32, stumpZ - dir * 0.8, stumpZ + dir * CREASE);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';                              // guard mark scratched by the batter
  ctx.fillRect(xToX(-0.02), zToY(-1.0), 3, 10);
  return tex(c);
}
function seatTexture() {
  const w = 64, h = 64, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = '#5c6d84'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#4b5a6e';
  for (let y = 0; y < h; y += 8) ctx.fillRect(0, y, w, 2);
  ctx.fillStyle = '#6a7b93';
  for (let x = 0; x < w; x += 6) ctx.fillRect(x, 0, 1, h);
  return tex(c, 1, 1);
}
function boardTexture(text, bg, fg) {
  const w = 512, h = 48, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg; ctx.font = 'bold 30px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 1);
  return tex(c);
}
function glowTexture() {
  const s = 64, c = makeCanvas(s, s), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  return tex(c);
}
// The big screen: a scoreboard canvas that is redrawn on setMatch / setScene only.
function makeScreen() {
  const c = makeCanvas(512, 288), ctx = c.getContext('2d'), t = tex(c);
  function paint(match, scene) {
    const teams = (match && match.teams) || [];
    const t0 = teams[0] || {}, t1 = teams[1] || {};
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, 512, 288);
    ctx.fillStyle = '#141f33'; ctx.fillRect(0, 0, 512, 54);
    ctx.fillStyle = '#f2f4f8'; ctx.font = 'bold 30px system-ui, "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('MY CRICKET', 22, 28);
    ctx.textAlign = 'right'; ctx.font = '22px system-ui, "Segoe UI", Arial, sans-serif'; ctx.fillStyle = '#9fb0c8';
    ctx.fillText('LIVE', 490, 28);
    const bat = scene && scene.battingSlot === 1 ? t1 : t0, bowl = bat === t0 ? t1 : t0;
    const chip = (x, y, team, label) => {
      ctx.fillStyle = parseColor(team.color, '#335').getStyle(); ctx.fillRect(x, y, 16, 44);
      ctx.fillStyle = '#f2f4f8'; ctx.font = 'bold 34px system-ui, "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(String(team.short || team.name || label).slice(0, 4).toUpperCase(), x + 28, y + 22);
      ctx.fillStyle = '#9fb0c8'; ctx.font = '20px system-ui, "Segoe UI", Arial, sans-serif';
      ctx.fillText(String(team.name || label).slice(0, 22), x + 120, y + 22);
    };
    chip(24, 80, bat, 'BAT'); chip(24, 140, bowl, 'BOWL');
    ctx.fillStyle = '#213050'; ctx.fillRect(24, 204, 464, 2);
    ctx.fillStyle = '#e8c15a'; ctx.font = 'bold 22px system-ui, "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'left';
    const st = (scene && scene.striker && scene.striker.name) || 'Striker', bw = (scene && scene.bowler && scene.bowler.name) || 'Bowler';
    ctx.fillText(String(st).slice(0, 18).toUpperCase(), 24, 236);
    ctx.fillStyle = '#9fb0c8'; ctx.font = '20px system-ui, "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('bowling: ' + String(bw).slice(0, 18), 488, 236);
    ctx.textAlign = 'left'; ctx.fillStyle = '#7f8ea8'; ctx.font = '16px system-ui, "Segoe UI", Arial, sans-serif';
    ctx.fillText('DAY MATCH  -  FINAL SESSION', 24, 268);
    t.needsUpdate = true;
  }
  paint(null, null);
  return { texture: t, paint };
}

// =====================================================================================================
// 3. Stadium (all procedural)
// =====================================================================================================
const SPONSORS = [
  ['MY CRICKET', '#17213a', '#f3f5f9'], ['LAN LEAGUE', '#f1efe8', '#1c2436'], ['NORTHWIND BANK', '#1f3d2a', '#e9f0e6'],
  ['SKYLINE AIR', '#f1efe8', '#20355f'], ['ORBITAL ENERGY', '#5a1f1f', '#f6e9e9'], ['GREENFIELD TYRES', '#2c2f36', '#e6e9ee'],
  ['PULSE SPORTS', '#f1efe8', '#7a2f1a'],
];
const EX = 1.0, EZ = 1.1;                 // the bowl is slightly longer along the pitch
const ringX = (r, th) => r * EX * Math.cos(th);
const ringZ = (r, th) => FIELD_CZ + r * EZ * Math.sin(th);
const SUN_DIR = new THREE.Vector3(-0.55, 0.42, 0.72).normalize();

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: new THREE.Color(0xf0d7b4) }, zenith: { value: new THREE.Color(0x4d7fc0) },
      sunDir: { value: SUN_DIR.clone() }, sunCol: { value: new THREE.Color(0xffe2b0) },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 horizon, zenith, sunDir, sunCol; varying vec3 vDir;',
      'void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0.0, 1.0);',
      ' vec3 col = mix(horizon, zenith, pow(h, 0.5)); float s = max(dot(d, sunDir), 0.0);',
      ' col += sunCol * (pow(s, 900.0) * 1.6 + pow(s, 14.0) * 0.28 + pow(s, 3.0) * 0.06);',
      ' gl_FragColor = vec4(col, 1.0);',
      '#include <tonemapping_fragment>', '#include <colorspace_fragment>', '}',
    ].join('\n'),
  });
}

// A band of quads around the bowl between two profile points (radius, height). Non-indexed so the
// shading is flat; uv in metres / scale so the seat texture tiles sensibly.
function ringBand(rA, yA, rB, yB, segs, uvScale, pos, uv, th0 = 0, th1 = TAU) {
  const slopeLen = Math.hypot(rB - rA, yB - yA);
  for (let i = 0; i < segs; i++) {
    const t0 = th0 + ((th1 - th0) * i) / segs, t1 = th0 + ((th1 - th0) * (i + 1)) / segs;
    const a0 = [ringX(rA, t0), yA, ringZ(rA, t0)], a1 = [ringX(rA, t1), yA, ringZ(rA, t1)];
    const b0 = [ringX(rB, t0), yB, ringZ(rB, t0)], b1 = [ringX(rB, t1), yB, ringZ(rB, t1)];
    const u0 = (t0 * rA) / uvScale, u1 = (t1 * rA) / uvScale, v1 = slopeLen / uvScale;
    // winding so the face normal points up / inward (toward the pitch)
    pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
    uv.push(u0, 0, u0, v1, u1, v1, u0, 0, u1, v1, u1, 0);
  }
}
function bandGeometry(pos, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function buildStadium(scene, mobile) {
  const S = { crowdPoints: [] };
  const T = { grass: grassTexture(), pitch: pitchTexture(), seats: seatTexture(), glow: glowTexture() };
  T.grass.repeat.set(22, 22);
  const M = {
    grass: new THREE.MeshLambertMaterial({ map: T.grass }),
    pitch: new THREE.MeshLambertMaterial({ map: T.pitch }),
    white: new THREE.MeshLambertMaterial({ color: 0xf3f2ec }),
    rope: new THREE.MeshLambertMaterial({ color: 0xf5f1e6 }),
    stump: new THREE.MeshLambertMaterial({ color: 0xe6d3a3 }),
    bail: new THREE.MeshLambertMaterial({ color: 0xd9b77a }),
    seats: new THREE.MeshLambertMaterial({ map: T.seats }),
    concrete: new THREE.MeshLambertMaterial({ color: 0x9d9fa3 }),
    roof: new THREE.MeshLambertMaterial({ color: 0xd6d9de, side: THREE.DoubleSide }),
    fascia: new THREE.MeshLambertMaterial({ color: 0xe9e9e6, side: THREE.DoubleSide }),
    steel: new THREE.MeshLambertMaterial({ color: 0x6d7178 }),
    dark: new THREE.MeshLambertMaterial({ color: 0x2b2f36 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xf6f4ea }),
    crowd: new THREE.MeshLambertMaterial({ color: 0xffffff }),
  };
  S.materials = M; S.textures = T;

  // --- sky, haze, lights
  const sky = new THREE.Mesh(new THREE.SphereGeometry(650, 28, 14), skyMaterial());
  sky.position.set(0, -20, FIELD_CZ);
  scene.add(sky);
  scene.fog = new THREE.Fog(0xe4d3bb, 190, 560);
  const sun = new THREE.DirectionalLight(0xffd9ac, 2.2);
  sun.position.copy(SUN_DIR).multiplyScalar(140);
  sun.target.position.set(0, 0, -8);
  scene.add(sun, sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 20; sc.far = 320;
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.035; sun.shadow.radius = 3;
  S.sun = sun;
  scene.add(new THREE.HemisphereLight(0xc3d8f2, 0x4a6638, 0.62));
  const fill = new THREE.DirectionalLight(0xb9c9e6, 0.3);
  fill.position.set(60, 40, -90);
  scene.add(fill);
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xfff1d6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  sunSprite.position.copy(SUN_DIR).multiplyScalar(560).add(new THREE.Vector3(0, -20, FIELD_CZ));
  sunSprite.scale.set(140, 140, 1);
  scene.add(sunSprite);

  // --- outfield and pitch
  const ground = new THREE.Mesh(new THREE.CircleGeometry(240, 72), M.grass);
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, FIELD_CZ); ground.receiveShadow = true;
  scene.add(ground);
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 25), M.pitch);
  pitch.rotation.x = -Math.PI / 2; pitch.position.set(0, 0.012, -10.1); pitch.receiveShadow = true;
  scene.add(pitch);

  // --- stumps and bails at both ends
  const stumpGeo = new THREE.CylinderGeometry(0.019, 0.017, 0.71, 8);
  const bailGeo = transformed(new THREE.CylinderGeometry(0.011, 0.011, 0.112, 6), 0, 0, 0, 0, 0, Math.PI / 2);
  function makeStumps(z) {
    const set = { group: new THREE.Group(), stumps: [], bails: [], z };
    set.group.position.set(0, 0, z);
    for (const x of [-0.114, 0, 0.114]) {
      const pivot = new THREE.Group(); pivot.position.set(x, 0, 0);
      const m = new THREE.Mesh(stumpGeo, M.stump); m.position.y = 0.355; m.castShadow = true;
      pivot.add(m); set.group.add(pivot); set.stumps.push(pivot);
    }
    for (const x of [-0.057, 0.057]) {
      const b = new THREE.Mesh(bailGeo, M.bail); b.castShadow = true;
      b.userData.rest = new THREE.Vector3(x, 0.725, z);
      b.position.copy(b.userData.rest);
      scene.add(b); set.bails.push(b);
    }
    scene.add(set.group);
    return set;
  }
  S.stumpsA = makeStumps(0); S.stumpsB = makeStumps(BOWL_Z);

  // --- boundary rope, 30-yard circle markers
  const rope = new THREE.Mesh(new THREE.TorusGeometry(ROPE_R, 0.1, 6, 120), M.rope);
  rope.rotation.x = -Math.PI / 2; rope.position.set(0, 0.1, FIELD_CZ); rope.scale.set(EX, EZ, 1);
  scene.add(rope);
  {
    const pts = [], R = 27.4;
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI; pts.push([R * Math.cos(a), R * Math.sin(a) * 1.0]); }          // behind the striker (+z)
    for (let i = 0; i < 20; i++) { const a = Math.PI + (i / 20) * Math.PI; pts.push([R * Math.cos(a), BOWL_Z + R * Math.sin(a)]); } // behind the bowler
    for (let i = 0; i <= 10; i++) { const z = (-PITCH_LEN * i) / 10; pts.push([R, z], [-R, z]); }
    const dot = new THREE.CircleGeometry(0.22, 8);
    const geos = pts.map(([x, z]) => transformed(dot.clone(), x, 0.015, z, -Math.PI / 2, 0, 0));
    scene.add(new THREE.Mesh(mergeGeos(geos), M.white));
    dot.dispose();
  }

  // --- sponsor boards just outside the rope (merged per sponsor so they are 7 draw calls)
  {
    const byText = SPONSORS.map(() => []);
    const n = 36, rB = ROPE_R + 2.6;
    for (let i = 0; i < n; i++) {
      const th = ((i + 0.5) / n) * TAU, x = ringX(rB, th), z = ringZ(rB, th);
      const yaw = Math.atan2(0 - x, FIELD_CZ - z);                           // face the centre
      byText[i % SPONSORS.length].push(transformed(new THREE.PlaneGeometry(9.4, 0.9), x, 0.5, z, 0, yaw, 0));
    }
    byText.forEach((geos, i) => {
      if (!geos.length) return;
      const [text, bg, fg] = SPONSORS[i];
      const m = new THREE.Mesh(mergeGeos(geos), new THREE.MeshLambertMaterial({ map: boardTexture(text, bg, fg), side: THREE.DoubleSide }));
      scene.add(m);
    });
  }

  // --- stands: three tiers of seats, risers and walkways around an elliptical bowl
  const segs = mobile ? 56 : 72;
  const profile = [
    // [rFront, yFront, rBack, yBack, kind]   kind: seat | wall
    [STAND_R, 0, STAND_R, 1.3, 'wall'], [STAND_R, 1.3, STAND_R + 9, 7.0, 'seat'], [STAND_R + 9, 7.0, STAND_R + 11, 7.0, 'wall'],
    [STAND_R + 11, 7.0, STAND_R + 11, 8.6, 'wall'], [STAND_R + 11, 8.6, STAND_R + 20, 14.4, 'seat'], [STAND_R + 20, 14.4, STAND_R + 22, 14.4, 'wall'],
    [STAND_R + 22, 14.4, STAND_R + 22, 16.0, 'wall'], [STAND_R + 22, 16.0, STAND_R + 31, 22.0, 'seat'], [STAND_R + 31, 22.0, STAND_R + 33, 22.0, 'wall'],
    [STAND_R + 33, 22.0, STAND_R + 33, 23.4, 'wall'],
  ];
  const seatPos = [], seatUv = [], wallPos = [], wallUv = [];
  for (const [rA, yA, rB, yB, kind] of profile) ringBand(rA, yA, rB, yB, segs, 3.6, kind === 'seat' ? seatPos : wallPos, kind === 'seat' ? seatUv : wallUv);
  ringBand(ROPE_R + 4, 0, STAND_R, 0, segs, 10, wallPos, wallUv);           // concrete apron in front of the stands
  const seatsMesh = new THREE.Mesh(bandGeometry(seatPos, seatUv), M.seats);
  const wallsMesh = new THREE.Mesh(bandGeometry(wallPos, wallUv), M.concrete);
  scene.add(seatsMesh, wallsMesh);

  // --- the crowd: one instanced mesh of simple seated figures scattered on the seat slopes
  {
    const body = new THREE.BoxGeometry(0.42, 0.5, 0.3);
    const head = transformed(new THREE.BoxGeometry(0.2, 0.22, 0.2), 0, 0.37, 0.02);
    const person = mergeGeos([transformed(body, 0, 0, 0), head]);
    const target = mobile ? 3200 : 6500;
    const r = rng(2024), slots = [];
    for (const [rA, yA, rB, yB, kind] of profile) {
      if (kind !== 'seat') continue;
      const rows = 10;
      for (let k = 0; k < rows; k++) {
        const f = (k + 0.5) / rows, rr = lerp(rA, rB, f), yy = lerp(yA, yB, f) + 0.52;
        const circumference = TAU * rr * (EX + EZ) / 2, seats = Math.floor(circumference / 0.62);
        for (let s = 0; s < seats; s++) slots.push([rr, yy, (s / seats) * TAU]);
      }
    }
    const density = target / slots.length;
    const palette = [0xe9e6df, 0xd8d6d0, 0x3b4a6b, 0x6b7f9e, 0xb3372c, 0xe4c15a, 0x2f6b3e, 0x1f2a3a, 0x8c8f96, 0xd98c3b, 0x5aa0c8, 0xf0efe9];
    const mats = [], cols = [], color = new THREE.Color(), dummy = new THREE.Object3D();
    for (const [rr, yy, th] of slots) {
      const clump = 0.55 + 0.9 * (0.5 + 0.5 * Math.sin(th * 7.3) * Math.cos(th * 3.1 + rr * 0.21));
      if (r() > density * clump) continue;
      const x = ringX(rr, th), z = ringZ(rr, th);
      dummy.position.set(x, yy, z);
      dummy.rotation.set(0, Math.atan2(0 - x, FIELD_CZ - z), 0);
      dummy.scale.setScalar(0.9 + r() * 0.25);
      dummy.updateMatrix();
      mats.push(dummy.matrix.clone());
      color.setHex(palette[Math.floor(r() * palette.length)]);
      color.offsetHSL(0, 0, (r() - 0.5) * 0.12);
      cols.push(color.clone());
      if (S.crowdPoints.length < 700 && r() < 0.14) S.crowdPoints.push(x, yy + 0.4, z);
    }
    const crowd = new THREE.InstancedMesh(person, M.crowd, mats.length);
    for (let i = 0; i < mats.length; i++) { crowd.setMatrixAt(i, mats[i]); crowd.setColorAt(i, cols[i]); }
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    scene.add(crowd);
    S.crowdCount = mats.length;
  }

  // --- roof: a sweeping cantilever ring, higher behind the sightscreens, with fascia and columns
  {
    const pos = [], uv = [], fpos = [], fuv = [];
    const rIn = STAND_R + 23, rOut = STAND_R + 40, n = segs;
    const sweep = (th) => -2.6 * Math.cos(2 * th);
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * TAU, t1 = ((i + 1) / n) * TAU;
      const y0 = 27.6 + sweep(t0), y1 = 27.6 + sweep(t1);
      const a0 = [ringX(rIn, t0), y0, ringZ(rIn, t0)], a1 = [ringX(rIn, t1), y1, ringZ(rIn, t1)];
      const b0 = [ringX(rOut, t0), y0 + 3.4, ringZ(rOut, t0)], b1 = [ringX(rOut, t1), y1 + 3.4, ringZ(rOut, t1)];
      pos.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1); uv.push(0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1);
      const f0 = [a0[0], y0 - 1.4, a0[2]], f1 = [a1[0], y1 - 1.4, a1[2]];
      fpos.push(...f0, ...a1, ...a0, ...f0, ...f1, ...a1); fuv.push(0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1);
    }
    scene.add(new THREE.Mesh(bandGeometry(pos, uv), M.roof), new THREE.Mesh(bandGeometry(fpos, fuv), M.fascia));
    const cols = 40, colGeo = new THREE.CylinderGeometry(0.55, 0.65, 1, 8);
    const columns = new THREE.InstancedMesh(colGeo, M.steel, cols), d = new THREE.Object3D();
    for (let i = 0; i < cols; i++) {
      const th = ((i + 0.5) / cols) * TAU, h = 27.6 + sweep(th) + 3.2;
      d.position.set(ringX(rOut - 1.2, th), h / 2, ringZ(rOut - 1.2, th)); d.scale.set(1, h, 1); d.updateMatrix();
      columns.setMatrixAt(i, d.matrix);
    }
    scene.add(columns);
  }

  // --- floodlight towers at the four corners
  {
    const mast = new THREE.CylinderGeometry(0.7, 1.2, 56, 8), headBox = new THREE.BoxGeometry(7.5, 5.2, 0.7);
    const lampDisc = new THREE.CircleGeometry(0.38, 8), lamps = [];
    for (const th of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      const x = ringX(STAND_R + 44, th), z = ringZ(STAND_R + 44, th), yaw = Math.atan2(0 - x, FIELD_CZ - z);
      const m = new THREE.Mesh(mast, M.steel); m.position.set(x, 28, z); scene.add(m);
      const head = new THREE.Mesh(headBox, M.dark); head.position.set(x, 54, z); head.rotation.set(0.35, yaw, 0, "YXZ"); head.updateMatrix(); scene.add(head);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 7; j++) {
        const g = lampDisc.clone();
        transformed(g, (j - 3) * 1.0, (i - 1.5) * 1.1, 0.37, 0, 0, 0);
        g.applyMatrix4(head.matrix.clone());
        lamps.push(g);
      }
    }
    scene.add(new THREE.Mesh(mergeGeos(lamps), M.lamp));
    lampDisc.dispose();
  }

  // --- big screen (scoreboard) high on the stand at the bowler's end, off side
  {
    const th = -Math.PI * 0.42, r = STAND_R + 27;
    const x = ringX(r, th), z = ringZ(r, th), yaw = Math.atan2(0 - x, FIELD_CZ - z);
    const g = new THREE.Group(); g.position.set(x, 26.3, z); g.rotation.y = yaw;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(16, 8.4, 1.0), M.dark); g.add(frame);
    S.screen = makeScreen();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(15, 7.6), new THREE.MeshBasicMaterial({ map: S.screen.texture }));
    face.position.z = 0.52; g.add(face);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(14, 4.6, 0.6), M.steel); legs.position.set(0, -6.3, 0); g.add(legs);
    scene.add(g);
  }

  // --- sightscreens at both ends
  for (const end of [-1, 1]) {
    const z = FIELD_CZ + end * (ROPE_R + 5) * EZ;
    const g = new THREE.Group(); g.position.set(0, 0, z);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(14, 7, 0.4), M.white); panel.position.y = 4.2; g.add(panel);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(14.6, 7.6, 0.3), M.dark); frame.position.set(0, 4.2, end * 0.2); g.add(frame);
    for (const x of [-6.6, 6.6]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 1.2), M.steel); leg.position.set(x, 0.35, 0); g.add(leg); }
    scene.add(g);
  }
  return S;
}

// =====================================================================================================
// 4. Figures: low-poly humanoids with a small joint rig, pose arrays, keyframes and two-bone arm IK
// =====================================================================================================
// Joint conventions (figure local space, +z = facing, +y up, the figure's right side is -x):
//   spine.x > 0 leans the torso forward, spine.y twists, spine.z side-bends toward -x
//   shoulder.x < 0 swings the arm forward, shoulder.z moves it sideways (left arm +, right arm -)
//   hip.x < 0 swings the thigh forward, knee.x > 0 bends the knee (shin backward)
const J = { spine: 0, head: 1, shL: 2, elL: 3, shR: 4, elR: 5, hipL: 6, kneeL: 7, hipR: 8, kneeR: 9 };
const NJ = 10, P_ROOTY = NJ * 3, POSE_LEN = NJ * 3 + 1;
const newPose = () => new Float32Array(POSE_LEN);
function setJ(p, j, x, y, z) { p[j * 3] = x; p[j * 3 + 1] = y; p[j * 3 + 2] = z; }
function addJ(p, j, x, y, z) { p[j * 3] += x; p[j * 3 + 1] += y; p[j * 3 + 2] += z; }
function blendPose(a, b, t, out) { for (let i = 0; i < POSE_LEN; i++) out[i] = a[i] + (b[i] - a[i]) * t; }
function makeKeys(list) {
  return list.map(([u, spec]) => {
    const p = newPose();
    for (const k in spec) { if (k === 'rootY') p[P_ROOTY] = spec[k]; else setJ(p, J[k], spec[k][0], spec[k][1], spec[k][2]); }
    return [u, p];
  });
}
function evalKeys(keys, u, out) {
  if (u <= keys[0][0]) { out.set(keys[0][1]); return; }
  for (let i = 1; i < keys.length; i++) {
    if (u <= keys[i][0]) { blendPose(keys[i - 1][1], keys[i][1], smooth((u - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0])), out); return; }
  }
  out.set(keys[keys.length - 1][1]);
}

// --- reusable poses
function poseStand(p, t, sway = 1) {
  p.fill(0);
  const s = Math.sin(t * 0.0021) * 0.02 * sway;
  setJ(p, J.spine, 0.03 + s, 0, 0);
  setJ(p, J.shL, 0.05, 0, 0.14); setJ(p, J.shR, 0.05, 0, -0.14);
  setJ(p, J.elL, -0.25, 0, 0); setJ(p, J.elR, -0.25, 0, 0);
  setJ(p, J.hipL, 0, 0, 0.05); setJ(p, J.hipR, 0, 0, -0.05);
}
function poseReady(p, t) {               // fielder: knees bent, hands on knees, walking in
  poseStand(p, t, 0);
  const b = 0.5 + 0.5 * Math.sin(t * 0.0032);
  setJ(p, J.spine, 0.55 + 0.1 * b, 0, 0); setJ(p, J.head, -0.45, 0, 0);
  setJ(p, J.hipL, -0.55, 0, 0.18); setJ(p, J.hipR, -0.55, 0, -0.18);
  setJ(p, J.kneeL, 0.9, 0, 0); setJ(p, J.kneeR, 0.9, 0, 0);
  setJ(p, J.shL, -0.9, 0, 0.25); setJ(p, J.shR, -0.9, 0, -0.25);
  setJ(p, J.elL, -0.2, 0, 0); setJ(p, J.elR, -0.2, 0, 0);
  p[P_ROOTY] = -0.2;
}
function poseRun(p, phase, amp = 1) {
  p.fill(0);
  const s = Math.sin(phase), c = Math.cos(phase);
  setJ(p, J.spine, 0.22 * amp, 0, 0); setJ(p, J.head, -0.15 * amp, 0, 0);
  setJ(p, J.hipL, -0.95 * amp * s, 0, 0.04); setJ(p, J.hipR, 0.95 * amp * s, 0, -0.04);
  setJ(p, J.kneeL, Math.max(0, -1.4 * amp * c) + 0.25 * amp, 0, 0); setJ(p, J.kneeR, Math.max(0, 1.4 * amp * c) + 0.25 * amp, 0, 0);
  setJ(p, J.shL, 0.9 * amp * s - 0.2, 0, 0.12); setJ(p, J.shR, -0.9 * amp * s - 0.2, 0, -0.12);
  setJ(p, J.elL, -1.5 * amp, 0, 0); setJ(p, J.elR, -1.5 * amp, 0, 0);
  p[P_ROOTY] = -0.03 * amp + 0.035 * amp * Math.abs(c);
}
function poseCrouch(p, t, depth = 1) {   // wicketkeeper set position
  p.fill(0);
  setJ(p, J.spine, 0.5 * depth, 0, 0); setJ(p, J.head, -0.5 * depth, 0, 0);
  setJ(p, J.hipL, -1.55 * depth, 0, 0.32); setJ(p, J.hipR, -1.55 * depth, 0, -0.32);
  setJ(p, J.kneeL, 1.95 * depth, 0, 0); setJ(p, J.kneeR, 1.95 * depth, 0, 0);
  setJ(p, J.shL, -1.1 * depth, 0, 0.18); setJ(p, J.shR, -1.1 * depth, 0, -0.18);
  setJ(p, J.elL, -0.55, 0, 0); setJ(p, J.elR, -0.55, 0, 0);
  p[P_ROOTY] = -0.48 * depth;
}
function poseAppeal(p, u) {              // u 0..1 arms going up, then a bounce
  poseStand(p, 0, 0);
  const a = smooth(u * 2), hop = Math.max(0, Math.sin(u * Math.PI * 2)) * 0.08;
  setJ(p, J.shL, lerp(0.05, -0.5, a), 0, lerp(0.14, 2.55, a)); setJ(p, J.shR, lerp(0.05, -0.5, a), 0, lerp(-0.14, -2.55, a));
  setJ(p, J.elL, lerp(-0.25, -0.35, a), 0, 0); setJ(p, J.elR, lerp(-0.25, -0.35, a), 0, 0);
  setJ(p, J.spine, -0.15 * a, 0, 0); setJ(p, J.head, -0.35 * a, 0, 0);
  setJ(p, J.kneeL, 0.3 * (1 - a), 0, 0); setJ(p, J.kneeR, 0.3 * (1 - a), 0, 0);
  p[P_ROOTY] = hop;
}
function poseHandsOnHips(p, t) { poseStand(p, t); setJ(p, J.shL, 0.3, 0, 0.75); setJ(p, J.shR, 0.3, 0, -0.75); setJ(p, J.elL, -1.9, 0, 0); setJ(p, J.elR, -1.9, 0, 0); }
function poseHandsOnHead(p, t) { poseStand(p, t); setJ(p, J.shL, -0.6, 0, 2.2); setJ(p, J.shR, -0.6, 0, -2.2); setJ(p, J.elL, -2.3, 0, 0); setJ(p, J.elR, -2.3, 0, 0); setJ(p, J.head, -0.2, 0, 0); }
function poseCelebrate(p, t) {           // arms up, hopping
  poseStand(p, t, 0);
  const b = Math.abs(Math.sin(t * 0.009));
  setJ(p, J.shL, -0.3, 0, 2.6 + 0.3 * b); setJ(p, J.shR, -0.3, 0, -2.6 - 0.3 * b);
  setJ(p, J.elL, -0.5, 0, 0); setJ(p, J.elR, -0.5, 0, 0);
  setJ(p, J.head, -0.4, 0, 0);
  p[P_ROOTY] = 0.12 * b;
}
function poseCatch(p, high) {
  poseStand(p, 0, 0);
  if (high) { setJ(p, J.shL, -2.75, 0, 0.35); setJ(p, J.shR, -2.75, 0, -0.35); setJ(p, J.elL, -0.3, 0, 0); setJ(p, J.elR, -0.3, 0, 0); setJ(p, J.head, -0.7, 0, 0); }
  else { setJ(p, J.shL, -1.0, 0, 0.3); setJ(p, J.shR, -1.0, 0, -0.3); setJ(p, J.elL, -1.3, 0, 0); setJ(p, J.elR, -1.3, 0, 0); setJ(p, J.spine, 0.25, 0, 0); setJ(p, J.head, -0.2, 0, 0); setJ(p, J.kneeL, 0.35, 0, 0); setJ(p, J.kneeR, 0.35, 0, 0); p[P_ROOTY] = -0.08; }
}
// Umpire signals: u = ms since the signal started
function poseSignal(p, kind, u) {
  poseStand(p, 0, 0);
  const a = smooth(u / 320), w = Math.sin(u * 0.012);
  switch (kind) {
    case 'out': setJ(p, J.shR, -0.25 * a, 0, -3.05 * a); setJ(p, J.elR, -0.1, 0, 0); setJ(p, J.head, -0.2 * a, 0, 0); break;
    case 'four': setJ(p, J.shR, -0.3 * a, 0, -1.55 * a); setJ(p, J.elR, (-0.9 + 0.7 * w) * a, 0, 0); break;
    case 'six': setJ(p, J.shL, -0.2 * a, 0, 2.95 * a); setJ(p, J.shR, -0.2 * a, 0, -2.95 * a); setJ(p, J.head, -0.25 * a, 0, 0); break;
    case 'wide': setJ(p, J.shL, 0, 0, 1.55 * a); setJ(p, J.shR, 0, 0, -1.55 * a); break;
    case 'noball': setJ(p, J.shR, 0, 0, -1.55 * a); break;
    case 'notout': setJ(p, J.head, 0, 0.45 * Math.sin(u * 0.011) * a, 0); setJ(p, J.shL, 0.1, 0, 0.35 * a); setJ(p, J.shR, 0.1, 0, -0.35 * a); setJ(p, J.elL, -0.2, 0, 0); setJ(p, J.elR, -0.2, 0, 0); break;
    default: break;
  }
}

// Bowling action keyframes over u: 0 = last running stride, 1 = release, 1.3 = end of the follow-through.
const BOWL_KEYS = makeKeys([
  [0.0, { spine: [0.25, 0, 0], head: [-0.2, 0, 0], shL: [-0.5, 0, 0.1], elL: [-1.4, 0, 0], shR: [0.5, 0, -0.1], elR: [-1.4, 0, 0], hipL: [-0.7, 0, 0.04], kneeL: [0.4, 0, 0], hipR: [0.6, 0, -0.04], kneeR: [1.2, 0, 0], rootY: 0 }],
  [0.22, { spine: [-0.1, 0, 0], head: [-0.3, 0, 0], shL: [-2.3, 0, 0.3], elL: [-0.9, 0, 0], shR: [-2.0, 0, -0.4], elR: [-1.0, 0, 0], hipL: [-1.1, 0, 0.1], kneeL: [1.6, 0, 0], hipR: [-0.3, 0, -0.1], kneeR: [0.9, 0, 0], rootY: 0.22 }],
  [0.45, { spine: [-0.3, 0.35, 0.1], head: [-0.4, -0.3, 0], shL: [-2.7, 0, 0.5], elL: [-0.3, 0, 0], shR: [2.0, 0, -0.5], elR: [-0.2, 0, 0], hipL: [-1.3, 0, 0.1], kneeL: [0.5, 0, 0], hipR: [0.3, 0, -0.15], kneeR: [0.5, 0, 0], rootY: -0.05 }],
  [0.72, { spine: [0.05, 0.2, 0.05], head: [-0.2, -0.2, 0], shL: [-1.2, 0, 0.4], elL: [-1.4, 0, 0], shR: [2.85, 0, -0.25], elR: [-0.1, 0, 0], hipL: [-0.75, 0, 0.1], kneeL: [0.25, 0, 0], hipR: [0.9, 0, -0.1], kneeR: [0.6, 0, 0], rootY: -0.1 }],
  [1.0, { spine: [0.55, -0.1, -0.1], head: [-0.4, 0, 0], shL: [0.4, 0, 0.3], elL: [-1.3, 0, 0], shR: [3.75, 0, -0.1], elR: [-0.15, 0, 0], hipL: [-0.35, 0, 0.1], kneeL: [0.3, 0, 0], hipR: [1.1, 0, -0.1], kneeR: [0.9, 0, 0], rootY: -0.12 }],
  [1.3, { spine: [0.7, -0.3, -0.25], head: [-0.6, 0, 0], shL: [0.7, 0, 0.5], elL: [-1.0, 0, 0], shR: [5.3, 0, -0.3], elR: [-0.4, 0, 0], hipL: [0.3, 0, 0.1], kneeL: [0.8, 0, 0], hipR: [-0.6, 0, -0.1], kneeR: [0.6, 0, 0], rootY: -0.1 }],
]);
// Fielder throw over the top: u 0..1
const THROW_KEYS = makeKeys([
  [0.0, { spine: [0.5, 0, 0], head: [-0.4, 0, 0], shL: [-0.7, 0, 0.3], elL: [-1.2, 0, 0], shR: [-0.5, 0, -0.3], elR: [-1.6, 0, 0], hipL: [-0.6, 0, 0.1], kneeL: [1.0, 0, 0], hipR: [-0.6, 0, -0.1], kneeR: [1.0, 0, 0], rootY: -0.22 }],
  [0.35, { spine: [-0.2, 0.4, 0], head: [-0.2, -0.3, 0], shL: [-2.0, 0, 0.4], elL: [-0.5, 0, 0], shR: [2.3, 0, -0.5], elR: [-1.3, 0, 0], hipL: [-0.5, 0, 0.1], kneeL: [0.3, 0, 0], hipR: [0.4, 0, -0.1], kneeR: [0.5, 0, 0], rootY: 0 }],
  [0.6, { spine: [0.45, -0.2, 0], head: [-0.3, 0, 0], shL: [0.4, 0, 0.3], elL: [-1.2, 0, 0], shR: [3.7, 0, -0.2], elR: [-0.2, 0, 0], hipL: [-0.5, 0, 0.1], kneeL: [0.4, 0, 0], hipR: [0.8, 0, -0.1], kneeR: [0.7, 0, 0], rootY: -0.08 }],
  [1.0, { spine: [0.35, -0.1, 0], head: [-0.2, 0, 0], shL: [0.2, 0, 0.2], elL: [-0.6, 0, 0], shR: [4.6, 0, -0.2], elR: [-0.5, 0, 0], hipL: [-0.2, 0, 0.1], kneeL: [0.3, 0, 0], hipR: [0.4, 0, -0.1], kneeR: [0.4, 0, 0], rootY: -0.04 }],
]);

// --- shared geometry
const GEO = {
  torso: new THREE.BoxGeometry(0.36, 0.5, 0.21),
  pelvis: new THREE.BoxGeometry(0.31, 0.17, 0.2),
  trim: new THREE.BoxGeometry(0.37, 0.07, 0.22),
  head: new THREE.SphereGeometry(0.11, 10, 8),
  cap: new THREE.SphereGeometry(0.12, 10, 6, 0, TAU, 0, 1.25),
  peak: new THREE.BoxGeometry(0.2, 0.02, 0.13),
  helmet: new THREE.SphereGeometry(0.13, 10, 8, 0, TAU, 0, 1.95),
  grille: new THREE.BoxGeometry(0.17, 0.09, 0.03),
  hat: new THREE.CylinderGeometry(0.11, 0.12, 0.11, 10),
  brim: new THREE.CylinderGeometry(0.21, 0.21, 0.012, 14),
  upper: transformed(new THREE.CapsuleGeometry(0.052, 0.26, 2, 7), 0, -0.165, 0),
  fore: transformed(new THREE.CapsuleGeometry(0.046, 0.24, 2, 7), 0, -0.155, 0),
  hand: new THREE.SphereGeometry(0.055, 8, 6),
  glove: new THREE.BoxGeometry(0.11, 0.15, 0.08),
  kglove: new THREE.BoxGeometry(0.19, 0.22, 0.08),
  finger: transformed(new THREE.BoxGeometry(0.02, 0.09, 0.02), 0, -0.08, 0),
  thigh: transformed(new THREE.CapsuleGeometry(0.075, 0.3, 2, 7), 0, -0.21, 0),
  shin: transformed(new THREE.CapsuleGeometry(0.06, 0.3, 2, 7), 0, -0.21, 0),
  foot: transformed(new THREE.BoxGeometry(0.11, 0.08, 0.26), 0, -0.43, 0.06),
  pad: transformed(new THREE.BoxGeometry(0.17, 0.56, 0.15), 0, -0.25, 0.04),
};
GEO.liteArm = mergeGeos([GEO.upper.clone(), transformed(GEO.fore.clone(), 0, -0.33, 0), transformed(GEO.hand.clone(), 0, -0.65, 0)]);
GEO.liteLeg = mergeGeos([GEO.thigh.clone(), transformed(GEO.shin.clone(), 0, -0.45, 0), transformed(GEO.foot.clone(), 0, -0.45, 0)]);
function coloredMerge(parts) {               // parts: [[geometry, hex], ...] -> one geometry with a vertex colour attribute
  const geos = parts.map(([g]) => g), merged = mergeGeos(geos);
  const n = merged.attributes.position.count, col = new Float32Array(n * 3), c = new THREE.Color();
  let o = 0;
  for (const [g, hex] of parts) {
    const cnt = (g.index ? g.index.count : g.attributes.position.count);
    c.setHex(hex).convertSRGBToLinear();
    for (let i = 0; i < cnt; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
    o += cnt;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return merged;
}
GEO.bat = coloredMerge([
  [transformed(new THREE.CylinderGeometry(0.016, 0.016, 0.32, 6), 0, -0.16, 0), 0x2a2420],
  [transformed(new THREE.BoxGeometry(0.108, 0.56, 0.046), 0, -0.6, 0), 0xdcc39c],
  [transformed(new THREE.BoxGeometry(0.108, 0.1, 0.03), 0, -0.3, 0), 0xcbb08a],
]);
const MAT = {
  skin: [0xd8a883, 0xa8714d, 0x6f4a35].map((c) => new THREE.MeshLambertMaterial({ color: c })),
  white: new THREE.MeshLambertMaterial({ color: 0xf4f3ee }),
  black: new THREE.MeshLambertMaterial({ color: 0x24262b }),
  shoe: new THREE.MeshLambertMaterial({ color: 0xe9e9e4 }),
  glove: new THREE.MeshLambertMaterial({ color: 0xf0efe9 }),
  kglove: new THREE.MeshLambertMaterial({ color: 0xc89a55 }),
  grille: new THREE.MeshLambertMaterial({ color: 0x3a3d44 }),
  bat: new THREE.MeshLambertMaterial({ vertexColors: true }),
  umpShirt: new THREE.MeshLambertMaterial({ color: 0xf2f1ec }),
  umpTrousers: new THREE.MeshLambertMaterial({ color: 0x1f2126 }),
};
function makeKit(color, trim) {
  const kit = { shirt: new THREE.MeshLambertMaterial({ color: 0x1b3f8f }), trousers: new THREE.MeshLambertMaterial({ color: 0x15306b }), cap: new THREE.MeshLambertMaterial({ color: 0x1b3f8f }), trim: new THREE.MeshLambertMaterial({ color: 0xf0c330 }) };
  setKitColors(kit, color, trim);
  return kit;
}
function setKitColors(kit, color, trim) {
  kit.shirt.color.copy(color); kit.cap.color.copy(color); kit.trim.color.copy(trim);
  kit.trousers.color.copy(color).multiplyScalar(0.72);
}

const ARM_L1 = 0.33, ARM_L2 = 0.315;
const _ik = { d: new THREE.Vector3(), u: new THREE.Vector3(), perp: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(), w: new THREE.Vector3(), x: new THREE.Vector3(), y: new THREE.Vector3(), m: new THREE.Matrix4() };

class Figure {
  // kit: materials from makeKit; o: { lite, helmet, cap, umpire, pads, gloves, kgloves, bat, skin }
  constructor(kit, o = {}) {
    this.o = o; this.lite = !!o.lite; this.kit = kit;
    this.mirror = new THREE.Group();
    this.root = new THREE.Group();
    this.mirror.add(this.root);
    this.pelvis = new THREE.Group(); this.pelvis.position.y = 0.98; this.root.add(this.pelvis);
    this.spine = new THREE.Group(); this.pelvis.add(this.spine);
    const skin = MAT.skin[(o.skin || 0) % MAT.skin.length];
    const shirt = o.umpire ? MAT.umpShirt : kit.shirt, trousers = o.umpire ? MAT.umpTrousers : kit.trousers;
    const add = (parent, geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
    this.kitMeshes = { shirt: [], trousers: [], cap: [], trim: [] };
    this.kitMeshes.shirt.push(add(this.spine, GEO.torso, shirt, 0, 0.27, 0));
    if (!o.umpire) this.kitMeshes.trim.push(add(this.spine, GEO.trim, kit.trim, 0, 0.45, 0));
    this.kitMeshes.trousers.push(add(this.pelvis, GEO.pelvis, trousers, 0, -0.03, 0));
    this.headG = new THREE.Group(); this.headG.position.set(0, 0.55, 0); this.spine.add(this.headG);
    add(this.headG, GEO.head, skin, 0, 0.1, 0);
    if (o.helmet) { this.kitMeshes.cap.push(add(this.headG, GEO.helmet, kit.cap, 0, 0.12, 0)); add(this.headG, GEO.grille, MAT.grille, 0, 0.04, 0.12); add(this.headG, GEO.peak, MAT.grille, 0, 0.13, 0.13); }
    else if (o.umpire) { add(this.headG, GEO.hat, MAT.white, 0, 0.2, 0); add(this.headG, GEO.brim, MAT.white, 0, 0.16, 0); }
    else { this.kitMeshes.cap.push(add(this.headG, GEO.cap, kit.cap, 0, 0.1, 0)); this.kitMeshes.cap.push(add(this.headG, GEO.peak, kit.cap, 0, 0.14, 0.14)); }
    // arms
    this.sh = {}; this.el = {}; this.hand = {};
    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? 1 : -1;
      const sh = new THREE.Group(); sh.position.set(sx * 0.215, 0.49, 0); this.spine.add(sh); this.sh[side] = sh;
      if (this.lite) { this.kitMeshes.shirt.push(add(sh, GEO.liteArm, shirt, 0, 0, 0)); const h = new THREE.Group(); h.position.set(0, -0.65, 0); sh.add(h); this.hand[side] = h; continue; }
      this.kitMeshes.shirt.push(add(sh, GEO.upper, shirt, 0, 0, 0));
      const el = new THREE.Group(); el.position.set(0, -0.33, 0); sh.add(el); this.el[side] = el;
      add(el, GEO.fore, skin, 0, 0, 0);
      const hand = new THREE.Group(); hand.position.set(0, -0.315, 0); el.add(hand); this.hand[side] = hand;
      if (o.kgloves) add(hand, GEO.kglove, MAT.kglove, 0, -0.03, 0);
      else if (o.gloves) add(hand, GEO.glove, MAT.glove, 0, -0.02, 0);
      else add(hand, GEO.hand, skin, 0, 0, 0);
      if (o.umpire && side === 'R') add(hand, GEO.finger, skin, 0, 0, 0);
    }
    // legs
    this.hip = {}; this.knee = {};
    for (const side of ['L', 'R']) {
      const sx = side === 'L' ? 1 : -1;
      const hip = new THREE.Group(); hip.position.set(sx * 0.1, -0.05, 0); this.pelvis.add(hip); this.hip[side] = hip;
      if (this.lite) { this.kitMeshes.trousers.push(add(hip, GEO.liteLeg, trousers, 0, 0, 0)); continue; }
      this.kitMeshes.trousers.push(add(hip, GEO.thigh, trousers, 0, 0, 0));
      const knee = new THREE.Group(); knee.position.set(0, -0.45, 0); hip.add(knee); this.knee[side] = knee;
      this.kitMeshes.trousers.push(add(knee, GEO.shin, trousers, 0, 0, 0));
      add(knee, GEO.foot, o.umpire ? MAT.black : MAT.shoe, 0, 0, 0);
      if (o.pads) add(knee, GEO.pad, MAT.white, 0, 0, 0);
    }
    if (o.bat) { this.bat = new THREE.Group(); this.spine.add(this.bat); const b = add(this.bat, GEO.bat, MAT.bat, 0, 0, 0); this.batMesh = b; }
    this.joints = [this.spine, this.headG, this.sh.L, this.el.L, this.sh.R, this.el.R, this.hip.L, this.knee.L, this.hip.R, this.knee.R];
    this.pose = newPose(); this.poseB = newPose();
    this.yaw = 0;
    this.holdBall = false;        // when true the ball is drawn in the right hand
  }
  setKit(kit) {
    this.kit = kit;
    if (this.o.umpire) return;
    for (const m of this.kitMeshes.shirt) m.material = kit.shirt;
    for (const m of this.kitMeshes.trousers) m.material = kit.trousers;
    for (const m of this.kitMeshes.cap) m.material = kit.cap;
    for (const m of this.kitMeshes.trim) m.material = kit.trim;
  }
  setMirror(on) { this.mirror.scale.x = on ? -1 : 1; }
  place(x, z, yaw) { this.root.position.x = x; this.root.position.z = z; this.root.rotation.y = yaw; this.yaw = yaw; }
  applyPose(p) {
    for (let j = 0; j < NJ; j++) { const g = this.joints[j]; if (g) g.rotation.set(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]); }
    this.pelvis.position.y = 0.98 + p[P_ROOTY];
  }
  // Two-bone IK in spine-local space: puts the hand of `side` on `target`, elbow pushed toward `pole`.
  solveArm(side, target, pole) {
    const sh = this.sh[side], el = this.el[side];
    if (!el) return;
    const k = _ik, S = sh.position;
    k.d.subVectors(target, S);
    const dist = clamp(k.d.length(), 0.08, ARM_L1 + ARM_L2 - 0.004);
    k.d.normalize();
    const cosE = clamp((ARM_L1 * ARM_L1 + ARM_L2 * ARM_L2 - dist * dist) / (2 * ARM_L1 * ARM_L2), -1, 1), theta = Math.acos(cosE);
    const cosA = clamp((ARM_L1 * ARM_L1 + dist * dist - ARM_L2 * ARM_L2) / (2 * ARM_L1 * dist), -1, 1), alpha = Math.acos(cosA);
    k.perp.subVectors(pole, S); k.perp.addScaledVector(k.d, -k.perp.dot(k.d));
    if (k.perp.lengthSq() < 1e-6) k.perp.set(side === 'L' ? 1 : -1, 0, 0).addScaledVector(k.d, -k.d.x * (side === 'L' ? 1 : -1));
    k.perp.normalize();
    k.u.copy(k.d).multiplyScalar(Math.cos(alpha)).addScaledVector(k.perp, Math.sin(alpha));      // upper arm direction
    k.e.copy(S).addScaledVector(k.u, ARM_L1);                                                      // elbow
    k.f.subVectors(target, k.e).normalize();                                                      // forearm direction
    k.w.copy(k.f).addScaledVector(k.u, Math.cos(theta));
    if (k.w.lengthSq() < 1e-6) k.w.copy(k.perp); else k.w.normalize();
    k.y.copy(k.u).negate(); k.x.crossVectors(k.y, k.w);
    k.m.makeBasis(k.x, k.y, k.w);
    sh.quaternion.setFromRotationMatrix(k.m);
    el.rotation.set(-(Math.PI - theta), 0, 0);
  }
}

// =====================================================================================================
// 5. Ball path: a list of time segments that can be evaluated at ANY time, so a frame is a pure function
//    of the clock (no per-frame integration, deterministic frozen frames, no allocations in draw()).
// =====================================================================================================
const MAX_SEG = 12;
class BallPath {
  constructor() {
    this.segs = [];
    for (let i = 0; i < MAX_SEG; i++) this.segs.push({ t0: 0, t1: 0, tEnd: 0, a: new THREE.Vector3(), b: new THREE.Vector3(), arc: 0, shape: 0, bounces: 1, ease: 0 });
    this.n = 0; this.visibleFrom = Infinity;
  }
  reset() { this.n = 0; this.visibleFrom = Infinity; }
  // shape 0: parabolic bulge `arc` above the straight line; shape 1: skimming bounces that die out.
  // ease 0 linear, 1 ease-out (rolling to a stop), 2 ease-in.
  add(t0, t1, ax, ay, az, bx, by, bz, arc = 0, shape = 0, ease = 0, bounces = 1) {
    if (this.n >= MAX_SEG) return null;
    const s = this.segs[this.n++];
    s.t0 = t0; s.t1 = Math.max(t1, t0 + 1); s.tEnd = s.t1; s.a.set(ax, ay, az); s.b.set(bx, by, bz); s.arc = arc; s.shape = shape; s.ease = ease; s.bounces = bounces;
    return s;
  }
  addRest(t0, t1, p) { return this.add(t0, t1, p.x, p.y, p.z, p.x, p.y, p.z); }
  // Cut the path at time t: everything after t is dropped; the segment containing t keeps its curve.
  cutAt(t) {
    for (let i = 0; i < this.n; i++) {
      const s = this.segs[i];
      if (t <= s.tEnd) { s.tEnd = Math.max(t, s.t0); this.n = i + 1; return; }
    }
  }
  get end() { return this.n ? this.segs[this.n - 1] : null; }
  get endTime() { return this.n ? this.segs[this.n - 1].tEnd : 0; }
  at(t, out) {
    if (!this.n) return false;
    let s = this.segs[0];
    for (let i = 0; i < this.n; i++) { s = this.segs[i]; if (t <= s.tEnd) break; }
    let u = (t - s.t0) / (s.t1 - s.t0);
    if (t > s.tEnd) u = (s.tEnd - s.t0) / (s.t1 - s.t0);
    u = clamp01(u);
    const ue = s.ease === 1 ? easeOut(u) : s.ease === 2 ? easeIn(u) : u;
    out.lerpVectors(s.a, s.b, ue);
    if (s.shape === 0) out.y += s.arc * 4 * ue * (1 - ue);
    else out.y += s.arc * Math.abs(Math.sin(Math.PI * s.bounces * ue)) * (1 - ue);
    return t >= this.visibleFrom;
  }
}

// Fielding positions for a right-handed striker (x mirrored for a left-hander). zone matches fielderZone.
const FIELD = [
  { name: 'slip', x: 2.6, z: 3.4, zone: 'off', deep: false, yawTo: 'bat' },
  { name: 'point', x: 21, z: -5, zone: 'off', deep: false },
  { name: 'cover', x: 19, z: -19, zone: 'off', deep: false },
  { name: 'mid-off', x: 9, z: -27, zone: 'straight', deep: false },
  { name: 'mid-on', x: -9, z: -27, zone: 'straight', deep: false },
  { name: 'midwicket', x: -20, z: -17, zone: 'leg', deep: false },
  { name: 'square leg', x: -23, z: -4, zone: 'leg', deep: false },
  { name: 'long-on', x: -10, z: -60, zone: 'straight', deep: true },
  { name: 'deep cover', x: 42, z: -40, zone: 'off', deep: true },
];
const SHOT_DIR = { leg: [-0.9, -0.44], straight: [-0.05, -1.0], off: [0.9, -0.44] };
const RUN_DIST = [5, 20, 42, 58];
const RUN_MS = [650, 1100, 1600, 2050];

// Distance s along direction (vx, vz) from (px, pz) to the boundary rope (an ellipse around the centre).
function ropeDistance(px, pz, vx, vz) {
  const ax = vx / EX, az = vz / EZ, bx = px / EX, bz = (pz - FIELD_CZ) / EZ;
  const A = ax * ax + az * az, B = 2 * (ax * bx + az * bz), C = bx * bx + bz * bz - ROPE_R * ROPE_R;
  const disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-9) return 60;
  return Math.max(5, (-B + Math.sqrt(disc)) / (2 * A));
}
// Height of the stand surface at a given point (for a six landing in the crowd).
function standHeightAt(x, z) {
  const r = Math.hypot(x / EX, (z - FIELD_CZ) / EZ);
  if (r < STAND_R) return 0;
  const d = r - STAND_R;
  if (d < 9) return 1.3 + (d / 9) * 5.7;
  if (d < 20) return 8.6 + ((d - 11) / 9) * 5.8;
  return 16 + Math.min(1, (d - 22) / 9) * 6;
}

// Trail: a few fading spheres sampled back along the path (analytic, so it is right even in a frozen frame).
const TRAIL_N = 10;
class Trail {
  constructor(scene) {
    const geo = new THREE.SphereGeometry(1, 6, 5);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffe9dc, transparent: true, opacity: 0.35, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, TRAIL_N);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.d = new THREE.Object3D(); this.p = new THREE.Vector3(); this.prev = new THREE.Vector3();
  }
  update(path, now, scaleBoost) {
    if (!path.n || now < path.visibleFrom + 60) { this.mesh.visible = false; return; }
    let any = false;
    path.at(now, this.prev);
    for (let i = 0; i < TRAIL_N; i++) {
      const t = now - (i + 1) * 28;
      const vis = t >= path.visibleFrom && path.at(t, this.p);
      const moving = this.p.distanceToSquared(this.prev) > 0.0004;
      if (vis && moving) {
        any = true;
        const s = BALL_R * scaleBoost * (1.0 - i / TRAIL_N) * 0.9;
        this.d.position.copy(this.p); this.d.scale.setScalar(Math.max(s, 0.001)); this.d.updateMatrix();
      } else { this.d.scale.setScalar(0.0001); this.d.updateMatrix(); }
      this.mesh.setMatrixAt(i, this.d.matrix);
      this.prev.copy(this.p);
    }
    this.mesh.visible = any;
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// =====================================================================================================
// 6. Broadcast overlay: 2D graphics in a DOM layer over the canvas (inside canvas.parentElement only)
// =====================================================================================================
const OVERLAY_CSS = [
  '.ra-ov{position:absolute;left:0;top:0;pointer-events:none;overflow:hidden;font-family:system-ui,"Segoe UI",Roboto,Arial,sans-serif;color:#fff;--u:1px;z-index:5;line-height:1.2}',
  '.ra-ov *{box-sizing:border-box}', '.ra-ov .ra-hide{display:none!important}',
  '.ra-inset{position:absolute;right:4%;top:6%;width:40%;aspect-ratio:4/5;border:calc(var(--u)*2) solid rgba(255,255,255,.92);border-radius:calc(var(--u)*6);box-shadow:0 calc(var(--u)*6) calc(var(--u)*20) rgba(0,0,0,.45);overflow:hidden}',
  '.ra-inset-label{position:absolute;left:0;right:0;bottom:0;padding:calc(var(--u)*6) 0;text-align:center;font-weight:800;font-size:calc(var(--u)*17);letter-spacing:.08em;background:rgba(10,14,22,.85)}',
  '.ra-inset-label.out{background:#b3261e}.ra-inset-label.notout{background:#1f8a3a}.ra-inset-label.four{background:#1f5fb3}.ra-inset-label.six{background:#6b3fb3}.ra-inset-label.wide,.ra-inset-label.noball{background:#e0a022;color:#111}',
  '.ra-inset-tag{position:absolute;left:0;top:0;padding:calc(var(--u)*3) calc(var(--u)*8);font-size:calc(var(--u)*10);font-weight:700;letter-spacing:.1em;background:rgba(10,14,22,.75)}',
  '.ra-slate{position:absolute;left:8%;right:8%;top:30%;padding:calc(var(--u)*18) calc(var(--u)*12);text-align:center;background:linear-gradient(180deg,rgba(8,12,24,.93),rgba(16,24,44,.93));border:calc(var(--u)*1) solid rgba(255,255,255,.25);border-radius:calc(var(--u)*8)}',
  '.ra-slate h1{margin:0;font-size:calc(var(--u)*34);letter-spacing:.2em;font-weight:900}', '.ra-slate p{margin:calc(var(--u)*8) 0 0;font-size:calc(var(--u)*14);color:#cfd8ea;letter-spacing:.06em}',
  '.ra-tag{position:absolute;left:4%;top:4%;padding:calc(var(--u)*5) calc(var(--u)*10);font-size:calc(var(--u)*12);font-weight:800;letter-spacing:.14em;background:rgba(8,12,24,.85);border-left:calc(var(--u)*4) solid #e8c15a;border-radius:calc(var(--u)*3)}',
  '.ra-verdicts{position:absolute;left:4%;right:4%;bottom:5%;display:flex;gap:2%}',
  '.ra-box{flex:1;background:rgba(8,12,24,.9);border-radius:calc(var(--u)*5);overflow:hidden;opacity:0;transform:translateY(20%);transition:opacity .25s,transform .25s}', '.ra-box.on{opacity:1;transform:none}',
  '.ra-box .k{font-size:calc(var(--u)*10);letter-spacing:.14em;font-weight:700;padding:calc(var(--u)*5) 0 calc(var(--u)*3);text-align:center;color:#cfd8ea}',
  '.ra-box .v{font-size:calc(var(--u)*13);font-weight:900;letter-spacing:.05em;padding:calc(var(--u)*7) 0;text-align:center;background:#55606f;white-space:nowrap}',
  '.ra-box.green .v{background:#1f8a3a}.ra-box.red .v{background:#b3261e}.ra-box.amber .v{background:#d98c1a;color:#111}',
  '.ra-stamp{position:absolute;left:6%;right:6%;top:34%;text-align:center}',
  '.ra-stamp .big{display:inline-block;padding:calc(var(--u)*10) calc(var(--u)*28);font-size:calc(var(--u)*44);font-weight:900;letter-spacing:.16em;border-radius:calc(var(--u)*8);background:#b3261e;box-shadow:0 calc(var(--u)*8) calc(var(--u)*28) rgba(0,0,0,.5)}',
  '.ra-stamp.notout .big{background:#1f8a3a}', '.ra-stamp .sub{margin-top:calc(var(--u)*10);font-size:calc(var(--u)*15);font-weight:700;letter-spacing:.08em;text-shadow:0 2px 8px #000}',
  '.ra-ue{position:absolute;left:5%;right:5%;bottom:5%;background:rgba(8,12,24,.92);border-radius:calc(var(--u)*6);padding:calc(var(--u)*7)}',
  '.ra-ue .t{font-size:calc(var(--u)*11);letter-spacing:.18em;font-weight:800;color:#cfd8ea;margin-bottom:calc(var(--u)*5)}', '.ra-ue canvas{display:block;width:100%;height:auto}',
  '.ra-pop{animation:ra-pop .35s cubic-bezier(.2,1.4,.4,1)}', '@keyframes ra-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}',
].join('\n');

class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    const parent = canvas.parentElement || document.body;
    const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; if (html) d.innerHTML = html; return d; };
    this.style = document.createElement('style'); this.style.textContent = OVERLAY_CSS;
    this.root = el('ra-ov');
    this.root.appendChild(this.style);
    this.inset = el('ra-inset ra-hide', '<div class="ra-inset-tag">UMPIRE</div><div class="ra-inset-label"></div>');
    this.insetLabel = this.inset.lastChild;
    this.slate = el('ra-slate ra-hide', '<h1>REVIEW</h1><p></p>');
    this.tag = el('ra-tag ra-hide');
    this.verdicts = el('ra-verdicts ra-hide');
    this.boxes = ['PITCHING', 'IMPACT', 'WICKETS'].map((k) => { const b = el('ra-box', '<div class="k">' + k + '</div><div class="v">&nbsp;</div>'); this.verdicts.appendChild(b); return b; });
    this.stamp = el('ra-stamp ra-hide', '<div class="big"></div><div class="sub"></div>');
    this.ue = el('ra-ue ra-hide', '<div class="t">ULTRAEDGE</div>');
    this.ueCanvas = document.createElement('canvas'); this.ueCanvas.width = 480; this.ueCanvas.height = 96; this.ue.appendChild(this.ueCanvas);
    for (const c of [this.inset, this.slate, this.tag, this.verdicts, this.stamp, this.ue]) this.root.appendChild(c);
    parent.appendChild(this.root);
    this.w = 1; this.h = 1; this.ueFrame = -1;
    this.cache = new Map();
  }
  layout(left, top, w, h) {
    if (w === this.w && h === this.h && left === this.left && top === this.top) return;
    this.w = w; this.h = h; this.left = left; this.top = top;
    const s = this.root.style;
    s.left = left + 'px'; s.top = top + 'px'; s.width = w + 'px'; s.height = h + 'px';
    s.setProperty('--u', (w / 390).toFixed(4) + 'px');
  }
  // Only touch the DOM when something changes (draw() runs every frame).
  _set(key, value, fn) { if (this.cache.get(key) === value) return; this.cache.set(key, value); fn(); }
  _vis(el, key, on) { this._set(key, !!on, () => el.classList.toggle('ra-hide', !on)); }
  insetRect() { const bw = this.w * 0.4, bh = bw * 1.25; return { x: this.w * 0.56, y: this.h * 0.06, w: bw, h: bh }; }
  setInset(on, label, cls) {
    this._vis(this.inset, 'inset', on);
    if (on) this._set('insetLabel', label + '|' + cls, () => { this.insetLabel.textContent = label; this.insetLabel.className = 'ra-inset-label ' + (cls || ''); });
  }
  setSlate(on, sub) { this._vis(this.slate, 'slate', on); if (on) this._set('slateSub', sub, () => { this.slate.lastChild.textContent = sub; }); }
  setTag(on, text) { this._vis(this.tag, 'tag', on); if (on) this._set('tagText', text, () => { this.tag.textContent = text; }); }
  // items: [{ v, cls, on }] for PITCHING / IMPACT / WICKETS
  setVerdicts(on, items) {
    this._vis(this.verdicts, 'verdicts', on);
    if (!on) return;
    items.forEach((it, i) => {
      const key = it.v + '|' + it.cls + '|' + (it.on ? 1 : 0);
      this._set('box' + i, key, () => { const b = this.boxes[i]; b.className = 'ra-box ' + (it.cls || '') + (it.on ? ' on' : ''); b.lastChild.textContent = it.on ? it.v : '. . .'; });
    });
  }
  setStamp(on, text, cls, sub) {
    this._vis(this.stamp, 'stamp', on);
    if (on) this._set('stampText', text + '|' + cls + '|' + sub, () => { this.stamp.className = 'ra-stamp ra-pop ' + (cls || ''); this.stamp.firstChild.textContent = text; this.stamp.lastChild.textContent = sub; });
  }
  setUE(on) { this._vis(this.ue, 'ue', on); if (!on) this.ueFrame = -1; }
  // Scrolling waveform: progress 0..1 through the replay, spike at `spikeAt` when hasSpike; noise: Float32Array
  drawUE(progress, spikeAt, hasSpike, noise, frameKey) {
    if (frameKey === this.ueFrame) return;
    this.ueFrame = frameKey;
    const c = this.ueCanvas, ctx = c.getContext('2d'), w = c.width, h = c.height, mid = h * 0.55;
    ctx.fillStyle = '#0d1424'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    const head = progress * (w * 0.92), n = noise.length;
    ctx.strokeStyle = '#9fe0ff'; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x <= head; x += 2) {
      const i = Math.floor((x / w) * n) % n;
      let y = noise[i] * h * 0.05;
      if (hasSpike) { const d = (x / w - spikeAt) * w; if (d > -2 && d < 42) { const k = Math.exp(-d / 12) * Math.sin(d * 0.9); y += k * h * 0.42 * noise[(i * 7) % n] + k * h * 0.3; } }
      if (x === 0) ctx.moveTo(x, mid + y); else ctx.lineTo(x, mid + y);
    }
    ctx.stroke();
    ctx.fillStyle = '#ffd36a'; ctx.fillRect(head, 0, 2, h);
    if (hasSpike && progress > spikeAt) {
      ctx.fillStyle = 'rgba(255,211,106,0.9)'; ctx.font = 'bold 15px system-ui, Arial, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('SPIKE AS BALL PASSES BAT', Math.min(spikeAt * w + 8, w - 230), 18);
    } else if (!hasSpike && progress > spikeAt + 0.08) {
      ctx.fillStyle = 'rgba(159,224,255,0.9)'; ctx.font = 'bold 15px system-ui, Arial, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('NO SPIKE', Math.min(spikeAt * w + 8, w - 100), 18);
    }
  }
  dispose() { if (this.root.parentNode) this.root.parentNode.removeChild(this.root); }
}

// =====================================================================================================
// 7. Effects: fireworks, confetti and crowd camera flashes (GPU-animated points, no per-frame CPU work)
// =====================================================================================================
const PARTICLE_VERT = [
  'attribute vec3 aVel; attribute float aBirth; attribute float aLife; attribute vec3 aColor; attribute float aSize;',
  'uniform float uTime; uniform float uPixelRatio; uniform float uGravity; uniform float uSway;',
  'varying float vAlpha; varying vec3 vColor;',
  'void main(){ float t = uTime - aBirth; float alive = step(0.0, t) * step(t, aLife);',
  ' vec3 p = position + aVel * t + vec3(uSway * sin(t * 3.0 + aBirth * 7.0), -uGravity * t * t * 0.5, uSway * cos(t * 2.3 + aBirth * 5.0));',
  ' vec4 mv = modelViewMatrix * vec4(p, 1.0); float fade = 1.0 - t / max(aLife, 0.001);',
  ' vAlpha = alive * fade; vColor = aColor;',
  ' gl_PointSize = alive * aSize * uPixelRatio * (70.0 / max(-mv.z, 1.0)); gl_Position = projectionMatrix * mv; }',
].join('\n');
const PARTICLE_FRAG = [
  'uniform float uRound; varying float vAlpha; varying vec3 vColor;',
  'void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q); float a = mix(1.0, smoothstep(0.5, 0.12, d), uRound) * vAlpha;',
  ' if (a < 0.02) discard; gl_FragColor = vec4(vColor * (0.55 + 0.6 * a), a);',
  '#include <tonemapping_fragment>', '#include <colorspace_fragment>', '}',
].join('\n');
const FLASH_VERT = [
  'attribute float aPhase; uniform float uTime; uniform float uIntensity; uniform float uPixelRatio; varying float vOn;',
  'void main(){ float f = fract(uTime * 0.9 + aPhase * 17.0); float on = step(f, 0.07) * uIntensity * step(0.35, fract(aPhase * 3.7 + floor(uTime * 0.9 + aPhase * 17.0) * 0.618));',
  ' vOn = on; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = on * 9.0 * uPixelRatio * (200.0 / max(-mv.z, 1.0)); gl_Position = projectionMatrix * mv; }',
].join('\n');
const FLASH_FRAG = [
  'varying float vOn; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d) * vOn; if (a < 0.02) discard;',
  ' gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * 1.4, a);', '#include <tonemapping_fragment>', '#include <colorspace_fragment>', '}',
].join('\n');

class ParticleSet {
  constructor(scene, count, { gravity, sway, round, blending }) {
    this.count = count; this.head = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 3); this.vel = new Float32Array(count * 3); this.birth = new Float32Array(count).fill(-1e9);
    this.life = new Float32Array(count); this.col = new Float32Array(count * 3); this.size = new Float32Array(count);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uGravity: { value: gravity }, uSway: { value: sway }, uRound: { value: round } },
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, transparent: true, depthWrite: false, blending, fog: false,
    });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; this.points.visible = false;
    scene.add(this.points);
    this.activeUntil = -1;
  }
  emit(n, birth, life, fill) {           // fill(i, out) writes { x,y,z, vx,vy,vz, r,g,b, size } into `out`
    const o = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, size: 1 };
    for (let k = 0; k < n; k++) {
      const i = this.head; this.head = (this.head + 1) % this.count;
      fill(k, o);
      this.pos[i * 3] = o.x; this.pos[i * 3 + 1] = o.y; this.pos[i * 3 + 2] = o.z;
      this.vel[i * 3] = o.vx; this.vel[i * 3 + 1] = o.vy; this.vel[i * 3 + 2] = o.vz;
      this.col[i * 3] = o.r; this.col[i * 3 + 1] = o.g; this.col[i * 3 + 2] = o.b;
      this.birth[i] = birth; this.life[i] = life; this.size[i] = o.size;
    }
    for (const a of ['position', 'aVel', 'aBirth', 'aLife', 'aColor', 'aSize']) this.geo.attributes[a].needsUpdate = true;
    this.activeUntil = Math.max(this.activeUntil, birth + life);
  }
  update(timeSec, pixelRatio) {
    const on = timeSec <= this.activeUntil;
    this.points.visible = on;
    if (on) { this.mat.uniforms.uTime.value = timeSec; this.mat.uniforms.uPixelRatio.value = pixelRatio; }
  }
}

class Effects {
  constructor(scene, crowdPoints) {
    this.fire = new ParticleSet(scene, 900, { gravity: 4.5, sway: 0, round: 1, blending: THREE.AdditiveBlending });
    this.confetti = new ParticleSet(scene, 500, { gravity: 1.6, sway: 0.5, round: 0, blending: THREE.NormalBlending });
    const g = new THREE.BufferGeometry();
    const n = Math.max(1, crowdPoints.length / 3), phase = new Float32Array(n), r = rng(99);
    for (let i = 0; i < n; i++) phase[i] = r();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(crowdPoints.length ? crowdPoints : [0, -100, 0]), 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.flashMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uPixelRatio: { value: 1 } }, vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.flashes = new THREE.Points(g, this.flashMat); this.flashes.frustumCulled = false; this.flashes.visible = false;
    scene.add(this.flashes);
    this.flashFrom = -1; this.flashUntil = -1; this.epoch = null;
  }
  sec(now) { if (this.epoch == null) this.epoch = now; return (now - this.epoch) / 1000; }
  crowdFlash(now, ms) { this.flashFrom = now; this.flashUntil = now + ms; }
  firework(now, x, y, z, hex, count = 110) {
    const r = rng(Math.floor(now) ^ Math.floor(x * 7)), c = new THREE.Color(hex);
    this.fire.emit(count, this.sec(now), 1.7 + r() * 0.5, (k, o) => {
      const th = r() * TAU, ph = Math.acos(2 * r() - 1), sp = 9 + r() * 11;
      o.x = x; o.y = y; o.z = z;
      o.vx = Math.sin(ph) * Math.cos(th) * sp; o.vy = Math.cos(ph) * sp; o.vz = Math.sin(ph) * Math.sin(th) * sp;
      const tint = 0.7 + r() * 0.5; o.r = c.r * tint; o.g = c.g * tint; o.b = c.b * tint; o.size = 3 + r() * 2.5;
    });
  }
  confettiDrop(now, x, z) {
    const r = rng(Math.floor(now)), cols = [0xf5c542, 0x3b82f6, 0xef4444, 0x22c55e, 0xffffff, 0xa855f7], c = new THREE.Color();
    this.confetti.emit(300, this.sec(now), 6, (k, o) => {
      o.x = x + (r() - 0.5) * 30; o.y = 24 + r() * 10; o.z = z + (r() - 0.5) * 30;
      o.vx = (r() - 0.5) * 2; o.vy = -1 - r() * 2; o.vz = (r() - 0.5) * 2;
      c.setHex(cols[Math.floor(r() * cols.length)]); o.r = c.r; o.g = c.g; o.b = c.b; o.size = 3 + r() * 2.5;
    });
  }
  get busy() { return this._busy; }
  update(now, pixelRatio) {
    const s = this.sec(now);
    this.fire.update(s, pixelRatio); this.confetti.update(s, pixelRatio);
    const on = now >= this.flashFrom && now < this.flashUntil;
    this.flashes.visible = on;
    if (on) {
      const k = Math.min(1, (this.flashUntil - now) / 800) * Math.min(1, (now - this.flashFrom) / 200);
      this.flashMat.uniforms.uTime.value = s; this.flashMat.uniforms.uIntensity.value = k; this.flashMat.uniforms.uPixelRatio.value = pixelRatio;
    }
    this._busy = on || this.fire.points.visible || this.confetti.points.visible;
  }
}

// =====================================================================================================
// 8. Bat keyframes (spine-local): position of the top of the handle, the direction the blade points
//    (axis) and the direction the face looks (face). Both hands are then placed on the handle by IK.
// =====================================================================================================
const _bk = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), m: new THREE.Matrix4() };
function batKey(p, a, f) {
  const k = { pos: new THREE.Vector3(p[0], p[1], p[2]), q: new THREE.Quaternion() };
  _bk.y.set(a[0], a[1], a[2]).negate().normalize();
  _bk.z.set(f[0], f[1], f[2]); _bk.z.addScaledVector(_bk.y, -_bk.z.dot(_bk.y));
  if (_bk.z.lengthSq() < 1e-6) _bk.z.set(1, 0, 0).addScaledVector(_bk.y, -_bk.y.x);
  _bk.z.normalize(); _bk.x.crossVectors(_bk.y, _bk.z);
  _bk.m.makeBasis(_bk.x, _bk.y, _bk.z); k.q.setFromRotationMatrix(_bk.m);
  return k;
}
// The batter faces local +z (the off side); local +x points at the bowler; local -z is the leg side.
const BAT = {
  stance: batKey([0.0, -0.15, 0.36], [-0.35, -1, 0.08], [1, 0, 0]),
  backlift: batKey([-0.05, 0.02, 0.24], [-0.7, 0.68, 0.25], [0.55, 0.35, -0.75]),
  leave: batKey([-0.1, 0.38, 0.22], [-0.35, 1, 0.1], [0, 0, 1]),
  rest: batKey([-0.3, -0.3, 0.2], [0.1, -1, 0.3], [1, 0, 0]),
  raised: batKey([0.1, 0.32, 0.2], [0.25, 1, 0.1], [0, 0, 1]),
  defendC: batKey([0.32, -0.5, 0.3], [0.12, -1, 0.05], [1, 0, 0]),
  defendF: batKey([0.36, -0.45, 0.32], [0.2, -1, 0.08], [1, 0, 0]),
  straightC: batKey([0.45, -0.42, 0.3], [0.3, -0.92, 0.15], [1, 0.1, -0.1]),
  straightF: batKey([0.25, 0.28, 0.05], [0.55, 0.75, -0.35], [0, 0.3, -0.95]),
  legC: batKey([0.35, -0.38, 0.0], [0.6, -0.5, -0.65], [0.5, 0.2, -0.85]),
  legF: batKey([-0.15, 0.15, -0.3], [-0.4, 0.4, -0.85], [-0.8, 0.2, 0.5]),
  offC: batKey([0.4, -0.42, 0.55], [0.35, -0.7, 0.6], [0.75, 0.1, 0.65]),
  offF: batKey([0.15, 0.2, 0.45], [0.1, 0.6, 0.8], [0.6, -0.3, -0.7]),
  loftC: batKey([0.42, -0.3, 0.3], [0.55, -0.6, 0.2], [0.9, 0.35, -0.2]),
  loftF: batKey([-0.2, 0.42, -0.2], [-0.6, 0.6, -0.5], [-0.6, 0.5, 0.6]),
};
const bodyPose = (spec) => makeKeys([[0, spec]])[0][1];
const BODY = {
  stance: bodyPose({ spine: [0.34, -0.1, -0.05], head: [-0.05, 1.15, 0], hipL: [0, 0, 0.36], hipR: [0, 0, -0.36], kneeL: [0.4, 0, 0], kneeR: [0.4, 0, 0], rootY: -0.09 }),
  backlift: bodyPose({ spine: [0.4, -0.15, -0.08], head: [-0.05, 1.15, 0], hipL: [0, 0, 0.33], hipR: [0, 0, -0.33], kneeL: [0.4, 0, 0], kneeR: [0.45, 0, 0], rootY: -0.1 }),
  straightC: bodyPose({ spine: [0.4, -0.2, -0.35], head: [0.1, 1.0, 0], hipL: [0, 0, 0.6], hipR: [0, 0, -0.2], kneeL: [0.55, 0, 0], kneeR: [0.15, 0, 0], rootY: -0.12 }),
  straightF: bodyPose({ spine: [0.2, -0.35, -0.3], head: [-0.2, 0.9, 0], hipL: [0, 0, 0.55], hipR: [0, 0, -0.2], kneeL: [0.45, 0, 0], kneeR: [0.1, 0, 0], rootY: -0.08 }),
  legC: bodyPose({ spine: [0.3, 0.8, -0.1], head: [0.0, 0.5, 0], hipL: [0, 0, 0.45], hipR: [0, 0, -0.3], kneeL: [0.45, 0, 0], kneeR: [0.35, 0, 0], rootY: -0.1 }),
  legF: bodyPose({ spine: [0.15, 1.2, 0.05], head: [-0.1, 0.1, 0], hipL: [0, 0, 0.4], hipR: [0, 0, -0.3], kneeL: [0.35, 0, 0], kneeR: [0.3, 0, 0], rootY: -0.06 }),
  offC: bodyPose({ spine: [0.5, -0.45, -0.3], head: [0.1, 1.0, 0], hipL: [0, 0, 0.55], hipR: [0, 0, -0.25], kneeL: [0.55, 0, 0], kneeR: [0.2, 0, 0], rootY: -0.14 }),
  offF: bodyPose({ spine: [0.3, -0.7, -0.25], head: [-0.1, 0.7, 0], hipL: [0, 0, 0.5], hipR: [0, 0, -0.25], kneeL: [0.45, 0, 0], kneeR: [0.15, 0, 0], rootY: -0.1 }),
  defendC: bodyPose({ spine: [0.55, -0.1, -0.3], head: [0.25, 1.1, 0], hipL: [0, 0, 0.6], hipR: [0, 0, -0.2], kneeL: [0.7, 0, 0], kneeR: [0.2, 0, 0], rootY: -0.16 }),
  loftC: bodyPose({ spine: [0.2, -0.1, -0.3], head: [0.0, 1.0, 0], hipL: [0, 0, 0.55], hipR: [0, 0, -0.25], kneeL: [0.5, 0, 0], kneeR: [0.2, 0, 0], rootY: -0.1 }),
  loftF: bodyPose({ spine: [-0.1, 0.6, -0.2], head: [-0.3, 0.5, 0], hipL: [0, 0, 0.5], hipR: [0, 0, -0.25], kneeL: [0.4, 0, 0], kneeR: [0.2, 0, 0], rootY: -0.04 }),
  leave: bodyPose({ spine: [0.2, -0.1, -0.05], head: [-0.05, 1.15, 0], hipL: [0, 0, 0.33], hipR: [0, 0, -0.33], kneeL: [0.3, 0, 0], kneeR: [0.3, 0, 0], rootY: -0.06 }),
  struck: bodyPose({ spine: [0.6, -0.1, -0.2], head: [0.7, 0.9, 0], hipL: [0, 0, 0.5], hipR: [0, 0, -0.25], kneeL: [0.6, 0, 0], kneeR: [0.2, 0, 0], rootY: -0.14 }),
  watchStumps: bodyPose({ spine: [0.2, 0.1, 0.0], head: [0.1, -1.0, 0], hipL: [0, 0, 0.33], hipR: [0, 0, -0.33], kneeL: [0.2, 0, 0], kneeR: [0.2, 0, 0], rootY: -0.04 }),
  stand: bodyPose({ spine: [0.05, 0, 0], head: [0, 0, 0], hipL: [0, 0, 0.06], hipR: [0, 0, -0.06], rootY: 0 }),
  raise: bodyPose({ spine: [-0.1, 0, 0], head: [-0.3, 0.3, 0], hipL: [0, 0, 0.1], hipR: [0, 0, -0.1], rootY: 0 }),
};
const SHOT_KEYS = {
  defend: { C: 'defendC', F: 'defendF', BC: 'defendC', BF: 'defendC' },
  attack: { leg: { C: 'legC', F: 'legF', BC: 'legC', BF: 'legF' }, straight: { C: 'straightC', F: 'straightF', BC: 'straightC', BF: 'straightF' }, off: { C: 'offC', F: 'offF', BC: 'offC', BF: 'offF' } },
  loft: { leg: { C: 'legC', F: 'loftF', BC: 'legC', BF: 'loftF' }, straight: { C: 'loftC', F: 'loftF', BC: 'loftC', BF: 'loftF' }, off: { C: 'offC', F: 'loftF', BC: 'offC', BF: 'loftF' } },
};
function shotKeys(kind, dir) {
  const k = SHOT_KEYS[kind] || SHOT_KEYS.attack;
  return k.C ? k : (k[dir] || k.straight);
}

// =====================================================================================================
// 9. The Renderer
// =====================================================================================================
const _bv = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _gTop = new THREE.Vector3(), _gBot = new THREE.Vector3(), _poleL = new THREE.Vector3(), _poleR = new THREE.Vector3(), _qa = new THREE.Quaternion();
const INSET_MS = 2800, SIGNAL_MS = { out: 3000, notout: 2600, four: 2600, six: 2600, wide: 2300, noball: 2300 };
const DEFAULT_TEAMS = [
  { name: 'Blue Kings', short: 'BLU', color: '#1b3f8f', color2: '#f0c330' },
  { name: 'Green Hawks', short: 'GRN', color: '#1f5c2e', color2: '#f4e04d' },
];

function Renderer(canvas, options) {
  options = options || {};
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('Renderer needs a <canvas> element');
  const mobile = (window.innerWidth || 800) <= 700;
  const gl = new THREE.WebGLRenderer({ canvas, antialias: !mobile, alpha: false, powerPreference: 'high-performance' });
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.95;
  gl.shadowMap.enabled = options.shadows != null ? !!options.shadows : !mobile;
  gl.shadowMap.type = THREE.PCFSoftShadowMap; gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 3 / 4, 0.3, 1000);
  const insetCam = new THREE.PerspectiveCamera(36, 0.8, 0.2, 400);
  const ST = buildStadium(scene, mobile);
  const overlay = new Overlay(canvas);
  const fx = new Effects(scene, ST.crowdPoints);

  // --- people
  const kits = [makeKit(parseColor(DEFAULT_TEAMS[0].color), parseColor(DEFAULT_TEAMS[0].color2)), makeKit(parseColor(DEFAULT_TEAMS[1].color), parseColor(DEFAULT_TEAMS[1].color2))];
  const striker = new Figure(kits[0], { helmet: true, pads: true, gloves: true, bat: true, skin: 0 });
  const nonStriker = new Figure(kits[0], { helmet: true, pads: true, gloves: true, bat: true, skin: 1 });
  const bowler = new Figure(kits[1], { skin: 2 });
  const keeper = new Figure(kits[1], { pads: true, kgloves: true, skin: 1 });
  const umpires = [new Figure(kits[0], { umpire: true, skin: 0 }), new Figure(kits[0], { umpire: true, skin: 2 })];
  const fielders = FIELD.map((f, i) => new Figure(kits[1], { lite: true, skin: i % 3 }));
  const everyone = [striker, nonStriker, bowler, keeper, ...umpires, ...fielders];
  for (const f of everyone) scene.add(f.mirror);

  // --- ball, trail, Hawk-Eye props
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 12, 10), new THREE.MeshPhongMaterial({ color: 0xb5261c, shininess: 70, specular: 0x5a3a3a }));
  ball.castShadow = true; ball.visible = false; scene.add(ball);
  const path = new BallPath(), trail = new Trail(scene);
  const HE = { group: new THREE.Group(), tube: null, halo: null, dashed: null, curve: null, proj: null };
  HE.group.visible = false; scene.add(HE.group);
  HE.ballMat = new THREE.MeshBasicMaterial({ color: 0xffd9d0 });
  HE.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.15, 12, 10), HE.ballMat); HE.group.add(HE.ball);
  HE.zone = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.73, 0.08), new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.35, depthWrite: false }));
  HE.zone.position.set(0, 0.365, 0); HE.group.add(HE.zone);
  HE.pitchMark = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); HE.pitchMark.rotation.x = -Math.PI / 2; HE.group.add(HE.pitchMark);
  HE.impactMark = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe066 })); HE.group.add(HE.impactMark);
  HE.tubeMat = new THREE.MeshBasicMaterial({ color: 0xff3b2f });
  HE.haloMat = new THREE.MeshBasicMaterial({ color: 0xff6a4a, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
  HE.dashMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.1, gapSize: 0.06 });

  // --- state (everything below is a pure function of these records plus the clock)
  const match = { teams: DEFAULT_TEAMS.map((t) => ({ ...t })) };
  const sceneInfo = { battingSlot: 0, bowlingSlot: 1, striker: { name: 'Striker', hand: 'R' }, nonStriker: { name: 'Non-striker', hand: 'R' }, bowler: { name: 'Bowler', type: 'fast' } };
  let mirrorX = 1;
  const D = { active: false, t0: 0, lead: 1100, flightMs: 950, tBat: 0, tPitch: 0, tKeep: 0, lineIndex: 1, turn: 0, length: 'good', pace: 'fast', type: 'fast', runLen: 8, actionMs: 600, speed: 20,
    R: new THREE.Vector3(), P: new THREE.Vector3(), B: new THREE.Vector3(), K: new THREE.Vector3(), swing: { on: false, dir: 'straight', t: 0 }, keeperX: 0.4, keeperZ: 6 };
  const R = { active: false, kind: 'none', tc: 0, ev: null, contact: true, wide: false, pending: false, shotDir: 'straight', shotKind: 'attack', runs: 0,
    P: new THREE.Vector3(), vx: 0, vz: 1, stopPt: new THREE.Vector3(), tStop: 0, chaser: -1, tChase0: 0, tArr: 0, noThrow: false, tThrow0: 0, tThrow1: 0, throwTo: new THREE.Vector3(),
    catcher: -1, catchPt: new THREE.Vector3(), tCatch: 0, high: false, keeperCatch: false, perRun: 0, tRun0: 0, tDead: 0, tCamBack: 0, tStumps: 0, stumpHit: 1, tCross: 0, autoOutAt: 0, autoSignal: null, autoSignalAt: 0, bailV: [new THREE.Vector3(), new THREE.Vector3()] };
  const REV = { active: false, t0: 0, dur: 9000, tA: 0, tB: 0, tStamp: 0, tEnd: 0, kind: 'lbw', data: {}, freezeAt: 0, noise: new Float32Array(256), spikeAt: 0.35, reveal: [0, 0, 0], ueBallZ: [-3.6, 1.3], pass: 0.38 };
  const DEC = { kind: null, t: -1e9 };
  const SIG = { kind: null, t: -1e9 };
  let lastNow = 0, lastRender = -1e9, needResize = true, viewW = 480, viewH = 640;
  {
    const r = rng(5);
    for (let i = 0; i < REV.noise.length; i++) REV.noise[i] = (r() - 0.5) * 2 * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.3)));
  }

  // --- camera rig: named shots are pure functions of time; switches blend from the pose at switch time
  const cam = { shot: 'batting', since: -1e9, blend: 0, from: { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 46 }, tmp: { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 46 }, cur: { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 46 } };
  const SHOTS = {
    batting(now, o) { o.pos.set(-1.1 * mirrorX, 5.8, 8.8); o.target.set(0.1 * mirrorX, 1.2, -13); o.fov = 50; },
    follow(now, o) {
      ballAt(now - 90, _bv);
      const bx = clamp(_bv.x, -18, 18);
      o.pos.set(bx * 0.3, 9.5 + Math.max(0, _bv.y - 8) * 0.35, 12.5);
      o.target.copy(_bv); o.target.y += 0.5;
      const d = o.pos.distanceTo(o.target);
      o.fov = clamp(50 - d * 0.3, 26, 50);
    },
    wicketSide(now, o) {
      const lbw = R.kind === 'lbw';
      o.pos.set((lbw ? 6.2 : 5.8) * mirrorX, lbw ? 1.5 : 1.3, lbw ? -3.6 : -0.9); o.target.set(lbw ? -0.1 * mirrorX : 0, lbw ? 0.7 : 0.5, lbw ? -1.4 : -0.8); o.fov = 34;
    },
    bowlerEnd(now, o) { o.pos.set(1.9, 2.9, -25.5); o.target.set(-0.3 * mirrorX, 0.9, -4); o.fov = 38; },
    hawkeye(now, o) {
      const p = REV.active ? span(now, REV.tA, REV.tB) : 0, bz = lerp(-18.5, -1.3, clamp01(p / 0.62));
      o.pos.set(13.5 * mirrorX, 3.0, bz + 2.0); o.target.set(0, 0.8, bz - 1.2); o.fov = 38;
    },
    ultraedge(now, o) { o.pos.set(3.9 * mirrorX, 1.05, -0.1); o.target.set(-0.2 * mirrorX, 0.62, -1.3); o.fov = 28; },
    slate(now, o) { const p = REV.active ? span(now, REV.t0, REV.tEnd) : 0; o.pos.set(46 + 10 * p, 27, 38 - 14 * p); o.target.set(0, 3, -12); o.fov = 48; },
  };
  function camEval(now, o) {
    SHOTS[cam.shot](now, cam.tmp);
    const k = cam.blend > 0 ? easeInOut((now - cam.since) / cam.blend) : 1;
    if (k >= 1) { o.pos.copy(cam.tmp.pos); o.target.copy(cam.tmp.target); o.fov = cam.tmp.fov; return; }
    o.pos.lerpVectors(cam.from.pos, cam.tmp.pos, k); o.target.lerpVectors(cam.from.target, cam.tmp.target, k); o.fov = lerp(cam.from.fov, cam.tmp.fov, k);
  }
  // since = the (possibly scheduled, earlier) moment of the cut, so frozen frames stay deterministic
  function camGo(name, since, blendMs) {
    if (cam.shot === name) return;
    camEval(since, cam.from);
    cam.shot = name; cam.since = since; cam.blend = blendMs;
  }
  function ballAt(t, out) { if (path.n) return path.at(t, out); out.set(0, 0.7, BAT_Z); return false; }

  // --- decisions and signals (explicit calls win over the automatic ones scheduled by a result)
  const _dec = { kind: null, t: 0 }, _sig = { kind: null, t: 0 };
  function decisionNow(now) {
    if (DEC.kind && DEC.t <= now && (!R.active || DEC.t >= R.tc - 1)) { _dec.kind = DEC.kind; _dec.t = DEC.t; return _dec; }
    if (R.active && R.autoOutAt && now >= R.autoOutAt) { _dec.kind = 'out'; _dec.t = R.autoOutAt; return _dec; }
    return null;
  }
  function signalNow(now) {
    if (SIG.kind && SIG.t <= now && now < SIG.t + SIGNAL_MS[SIG.kind] + 400) { _sig.kind = SIG.kind; _sig.t = SIG.t; return _sig; }
    if (R.active && R.autoSignal && now >= R.autoSignalAt && now < R.autoSignalAt + SIGNAL_MS[R.autoSignal] + 400 && !(SIG.kind && SIG.t >= R.tc)) { _sig.kind = R.autoSignal; _sig.t = R.autoSignalAt; return _sig; }
    return null;
  }
  const isWicketKind = () => R.kind === 'bowled' || R.kind === 'lbw' || R.kind === 'caught';
  function outNow(now) {           // has the striker been given out by this time?
    if (!R.active) return false;
    if (R.kind === 'bowled') return now >= R.tStumps;
    const d = decisionNow(now);
    return !!(d && d.kind === 'out');
  }

  // --- bowler ---------------------------------------------------------------------------------------
  function bowlerReact(now, p) {
    const dec = decisionNow(now);
    if (R.kind === 'bowled') { if (now < R.tStumps + 250) poseHandsOnHips(p, now); else poseCelebrate(p, now - R.tStumps); return; }
    const tAsk = R.kind === 'caught' ? R.tCatch : R.tStumps + 60;
    if (now < tAsk) { poseStand(p, now, 0); return; }
    if (dec && now >= dec.t) {
      if (dec.kind === 'out') { if (now < dec.t + 150) poseAppeal(p, 1); else poseCelebrate(p, now - dec.t); }
      else poseHandsOnHips(p, now);
      return;
    }
    if (now < tAsk + 1500) poseAppeal(p, (now - tAsk) / 600); else poseHandsOnHead(p, now);
  }
  function updateBowler(now) {
    const f = bowler, p = f.pose;
    const bx = 0.95, zMark = BOWL_Z - 1.3 - D.runLen;
    let x = bx, z = zMark, yaw = 0;
    f.holdBall = false;
    if (!D.active) { poseStand(p, now); f.place(x, z, yaw); f.applyPose(p); return; }
    const tRun0 = D.t0 - D.lead, tAct0 = D.t0 - D.actionMs, zAct0 = BOWL_Z - 1.3 - 2.4, zRel = BOWL_Z + CREASE - 0.45;
    if (now < tAct0) {
      const u = span(now, tRun0, tAct0);
      z = lerp(zMark, zAct0, u);
      poseRun(p, ((z - zMark) / 1.75) * TAU, 0.55 + 0.45 * smooth(u * 2.5));
      f.holdBall = true;
    } else if (now < D.t0 + 450) {
      const u = now < D.t0 ? span(now, tAct0, D.t0) : 1 + ((now - D.t0) / 450) * 0.3;
      evalKeys(BOWL_KEYS, u, p);
      z = u <= 1 ? lerp(zAct0, zRel, u) : lerp(zRel, zRel + 1.7, (u - 1) / 0.3);
      f.holdBall = now < D.t0;
    } else {
      const t = now - (D.t0 + 450), zEnd = zRel + 1.7;
      if (R.active && isWicketKind()) { bowlerReact(now, p); z = zEnd + 1.0; yaw = R.kind === 'bowled' ? 0 : Math.PI; }
      else if (t < 700) { z = zEnd + easeOut(t / 700) * 1.2; poseRun(p, (t / 700) * TAU * 0.8, 0.45 * (1 - t / 700)); }
      else {
        z = zEnd + 1.2;
        if (R.active && (R.kind === 'runs' || R.kind === 'dot' || R.kind === 'four')) x = lerp(bx, 2.4, smooth((now - R.tc - 150) / 500));
        if (R.active && (R.kind === 'four' || R.kind === 'six') && now > R.tc + 900) poseHandsOnHead(p, now);
        else poseHandsOnHips(p, now);
      }
    }
    f.place(x, z, yaw); f.applyPose(p);
  }

  // --- striker ----------------------------------------------------------------------------------------
  const _batPos = new THREE.Vector3(), _batQ = new THREE.Quaternion();
  function layerBat(key, t) { if (t <= 0) return; _batPos.lerp(key.pos, t); _batQ.slerp(key.q, t); }
  function layerPose(p, target, t) { if (t > 0) blendPose(p, target, t, p); }
  function batBlend(a, b, t) { _batPos.lerpVectors(a.pos, b.pos, t); _batQ.slerpQuaternions(a.q, b.q, t); }
  // batting at the crease: stance -> backlift -> shot / leave -> stance, written into p and _batPos/_batQ
  function batterBase(now, p) {
    const sw = D.swing;
    p.set(BODY.stance); batBlend(BAT.stance, BAT.stance, 0);
    if (!D.active) return;
    const t0 = D.t0;
    const noShot = R.active && !R.ev.shot && !sw.on;
    if (sw.on && now >= sw.t) {
      const keys = shotKeys(R.active ? R.shotKind : (sw.kind || 'attack'), sw.dir), t = now - sw.t;
      if (t < 90) { const k = smooth(t / 90); blendPose(BODY.backlift, BODY[keys.BC], k, p); batBlend(BAT.backlift, BAT[keys.C], k); }
      else if (t < 420) { const k = easeOut((t - 90) / 330); blendPose(BODY[keys.BC], BODY[keys.BF], k, p); batBlend(BAT[keys.C], BAT[keys.F], k); }
      else if (t < 1300) { const k = smooth((t - 420) / 880); blendPose(BODY[keys.BF], BODY.stance, k, p); batBlend(BAT[keys.F], BAT.stance, k); }
    } else if (noShot && !R.wide && now >= D.tBat - 320) {
      if (now < D.tBat + 500) { const k = smooth((now - (D.tBat - 320)) / 240); blendPose(BODY.backlift, BODY.leave, k, p); batBlend(BAT.backlift, BAT.leave, k); }
      else { const k = smooth((now - D.tBat - 500) / 600); blendPose(BODY.leave, BODY.stance, k, p); batBlend(BAT.leave, BAT.stance, k); }
    } else if (now >= t0 - 150) {
      const k = smooth((now - (t0 - 150)) / 420); blendPose(BODY.stance, BODY.backlift, k, p); batBlend(BAT.stance, BAT.backlift, k);
    }
    // the head follows the ball a little
    if (now > t0 && now < D.tBat) addJ(p, J.head, 0.25 * span(now, t0, D.tBat), 0, 0);
  }
  function updateStriker(now) {
    const f = striker, p = f.pose;
    let x = -0.42, z = -1.05, yaw = Math.PI / 2, twoHands = true, idleBat = false;
    const out = outNow(now), dec = R.active ? decisionNow(now) : null;
    const tWalk = out ? (R.kind === 'bowled' ? R.tStumps + 1300 : dec.t + 750) : Infinity;
    const runsOn = R.active && (R.kind === 'runs' || R.kind === 'four') && R.tRun0 && now >= R.tRun0 && !out;
    if (R.active && now >= tWalk) {
      const t = (now - tWalk) / 1000;
      z = -1.05 + Math.min(t * 1.25, 14); yaw = 0; x = -0.42 + Math.min(t, 1) * 0.5;
      poseRun(p, t * 4.5, 0.3); batBlend(BAT.rest, BAT.rest, 0); twoHands = false;
    } else if (runsOn) {
      const zA = -1.05, zB = BOWL_Z + CREASE + 0.55, lane = 1.35 * mirrorX;
      if (R.kind === 'four') {
        const u = span(now, R.tRun0, R.tRun0 + 1300), e = easeOut(u);
        z = lerp(zA, zA - 7, e); x = lerp(-0.42, lane, smooth(u * 3)); yaw = lerp(Math.PI / 2, Math.PI, smooth(u * 3));
        if (u < 1) poseRun(p, (Math.abs(z - zA) / 1.9) * TAU, 1 - u * 0.7); else poseHandsOnHips(p, now);
      } else {
        const n = Math.max(1, Math.min(R.runs, 3)), per = R.perRun, k = Math.min(n - 1, Math.floor((now - R.tRun0) / per));
        const u = clamp01((now - R.tRun0 - k * per) / per), from = k % 2 === 0 ? zA : zB, to = k % 2 === 0 ? zB : zA;
        const done = now >= R.tRun0 + n * per;
        z = lerp(from, to, done ? 1 : u);
        const s0 = k === 0 ? smooth(u * per / 300) : 1;
        x = lerp(-0.42, lane, s0); yaw = to < from ? lerp(Math.PI / 2, Math.PI, s0) : 0;
        if (done) poseStand(p, now); else poseRun(p, (Math.abs(z - from) / 1.9) * TAU, 1);
      }
      batBlend(BAT.rest, BAT.rest, 0); twoHands = false;
    } else {
      batterBase(now, p);
      if (R.active) {
        if (R.kind === 'bowled' && now >= R.tStumps + 150) { const t = smooth((now - R.tStumps - 150) / 450); layerPose(p, BODY.watchStumps, t); layerBat(BAT.rest, t); }
        else if (R.kind === 'lbw' && now >= R.tStumps) {
          let t = smooth((now - R.tStumps) / 220);
          if (dec && dec.kind === 'notout') t *= 1 - smooth((now - dec.t - 300) / 500);
          else if (!dec && now > R.tStumps + 1500) t *= 1 - 0.6 * smooth((now - R.tStumps - 1500) / 500);
          layerPose(p, BODY.struck, t); layerBat(BAT.defendC, t);
        }
        else if (R.kind === 'six' && now >= R.tc + 900) { const t = smooth((now - R.tc - 900) / 450); layerPose(p, BODY.raise, t); layerBat(BAT.raised, t); }
        else if (R.kind === 'caught' && now >= R.tc + 600) { const t = smooth((now - R.tc - 600) / 500); layerPose(p, BODY.stand, t); layerBat(BAT.rest, t); if (t > 0.5) twoHands = false; }
        if (out && R.kind !== 'bowled' && now >= dec.t) { const t = smooth((now - dec.t) / 500); layerPose(p, BODY.stand, t); layerBat(BAT.rest, t); if (t > 0.5) twoHands = false; }
      }
    }
    f.place(x, z, yaw); f.applyPose(p);
    f.bat.position.copy(_batPos); f.bat.quaternion.copy(_batQ);
    _gBot.set(0, -0.2, 0).applyQuaternion(_batQ).add(_batPos);
    f.solveArm('R', _gBot, _poleR.set(-0.55, -0.25, 0.15));
    if (twoHands) { _gTop.set(0, -0.07, 0).applyQuaternion(_batQ).add(_batPos); f.solveArm('L', _gTop, _poleL.set(0.6, -0.15, 0.35)); }
    void idleBat;
  }

  // --- non-striker ------------------------------------------------------------------------------------
  function updateNonStriker(now) {
    const f = nonStriker, p = f.pose, m = sceneInfo.nonStriker.hand === 'L' ? -1 : 1;
    const zHome = BOWL_Z + CREASE - 0.4, zBack = BOWL_Z + CREASE + 0.6, zFar = -0.8, lane = -1.15;
    let z = zHome, yaw = 0, x = lane;
    poseStand(p, now);
    if (D.active) {
      const u = smooth(span(now, D.t0 - 500, D.t0 + 250));
      z = lerp(zHome, zBack, u);
      if (u > 0 && u < 1) poseRun(p, u * 5, 0.25);
    }
    const out = outNow(now);
    if (R.active && R.kind === 'runs' && R.tRun0 && now >= R.tRun0 && !out) {
      const n = Math.max(1, Math.min(R.runs, 3)), per = R.perRun, k = Math.min(n - 1, Math.floor((now - R.tRun0) / per));
      const u = clamp01((now - R.tRun0 - k * per) / per), from = k % 2 === 0 ? zBack : zFar, to = k % 2 === 0 ? zFar : zBack;
      const done = now >= R.tRun0 + n * per;
      z = lerp(from, to, done ? 1 : u); yaw = to > from ? 0 : Math.PI;
      if (done) poseStand(p, now); else poseRun(p, (Math.abs(z - from) / 1.9) * TAU, 1);
    } else if (R.active && (R.kind === 'four' || R.kind === 'six') && now >= R.tc + 200) {
      const u = span(now, R.tc + 200, R.tc + 1100); z = zBack + 2.0 * easeOut(u);
      if (u < 1) poseRun(p, u * 7, 0.6 * (1 - u)); else poseStand(p, now);
    } else if (R.active && out && now > R.tc + 800) poseHandsOnHips(p, now);
    f.place(x * m, z, yaw); f.applyPose(p);
    f.bat.position.copy(BAT.rest.pos); f.bat.quaternion.copy(BAT.rest.q);
    _gBot.set(0, -0.2, 0).applyQuaternion(BAT.rest.q).add(BAT.rest.pos);
    f.solveArm('R', _gBot, _poleR.set(-0.55, -0.25, 0.15));
  }

  // --- wicketkeeper -----------------------------------------------------------------------------------
  function keeperHands(target) {
    keeper.mirror.updateMatrixWorld(true);
    _v1.copy(target); keeper.spine.worldToLocal(_v1); _v2.copy(_v1); _v1.x += 0.08; _v2.x -= 0.08;
    keeper.solveArm('L', _v1, _poleL.set(0.5, -0.3, 0.15)); keeper.solveArm('R', _v2, _poleR.set(-0.5, -0.3, 0.15));
  }
  function updateKeeper(now) {
    const f = keeper, p = f.pose;
    let x = D.keeperX, z = D.keeperZ, ik = null;
    if (!D.active) { poseCrouch(p, now, 0.55); f.place(x, z, Math.PI); f.applyPose(p); return; }
    const tK = D.tKeep, dec = R.active ? decisionNow(now) : null;
    if (R.active && R.kind === 'bowled') { if (now > R.tStumps + 250) poseCelebrate(p, now - R.tStumps); else poseCrouch(p, now, 0.5); }
    else if (R.active && (R.kind === 'lbw' || (R.kind === 'caught' && !R.keeperCatch))) {
      const tAsk = R.kind === 'caught' ? R.tCatch : R.tStumps + 60;
      if (now < tAsk) poseCrouch(p, now, 0.5);
      else if (dec && now >= dec.t) { if (dec.kind === 'out') poseCelebrate(p, now - dec.t); else poseHandsOnHips(p, now); }
      else if (now < tAsk + 1500) poseAppeal(p, (now - tAsk) / 600); else poseHandsOnHead(p, now);
    } else if (R.active && R.keeperCatch) {
      const u = span(now, R.tc, R.tCatch - 60);
      x = lerp(D.keeperX, R.catchPt.x, u);
      if (now < R.tCatch + 350) { poseCrouch(p, now, lerp(0.8, 0.35, u)); ik = R.catchPt; }
      else if (dec && now >= dec.t) { if (dec.kind === 'out') poseCelebrate(p, now - dec.t); else poseHandsOnHips(p, now); }
      else poseAppeal(p, (now - R.tCatch - 350) / 500);
    } else if (R.active && (R.kind === 'runs' || R.kind === 'four' || R.kind === 'six' || R.kind === 'dot')) {
      if (now < R.tc + 300) poseCrouch(p, now, 0.6);
      else { poseStand(p, now); if (R.tThrow1 && R.throwToKeeper && now > R.tThrow1 - 350 && now < R.tThrow1 + 900) ik = R.throwTo; }
    } else {
      const depth = now < D.tPitch ? 1 : lerp(1, 0.55, span(now, D.tPitch, D.tBat));
      poseCrouch(p, now, depth);
      if (now >= tK - 240 && now < tK + 800) { ik = D.K; x = lerp(D.keeperX, D.K.x, smooth(span(now, D.tPitch, tK - 80))); }
      else if (now >= tK + 800) { poseStand(p, now); x = D.K.x; }
    }
    f.place(x, z, Math.PI); f.applyPose(p);
    if (ik) keeperHands(ik);
  }

  // --- fielders -----------------------------------------------------------------------------------------
  function updateFielders(now) {
    const out = outNow(now);
    for (let i = 0; i < fielders.length; i++) {
      const f = fielders[i], base = FIELD[i], p = f.pose;
      const bx = base.x * mirrorX, bz = base.z;
      let x = bx, z = bz, yaw = Math.atan2(-bx, -bz);
      if (!R.active) {
        if (D.active) {
          const u = span(now, D.t0 - D.lead, D.t0 + 150), L = Math.hypot(bx, bz) || 1;
          x += (-bx / L) * 1.6 * u; z += (-bz / L) * 1.6 * u;
          if (u < 1) poseRun(p, u * 7 + i, 0.35 * (1 - u * 0.5)); else poseReady(p, now + i * 700);
        } else poseReady(p, now + i * 700);
      } else if (i === R.chaser) {
        if (now < R.tChase0) poseReady(p, now + i * 700);
        else if (now < R.tArr) {
          const u = span(now, R.tChase0, R.tArr);
          x = lerp(bx, R.stopPt.x, u); z = lerp(bz, R.stopPt.z, u); yaw = Math.atan2(R.stopPt.x - bx, R.stopPt.z - bz);
          poseRun(p, (Math.hypot(x - bx, z - bz) / 1.9) * TAU, 1);
        } else {
          x = R.stopPt.x; z = R.stopPt.z;
          if (R.noThrow) { yaw = Math.atan2(R.vx, R.vz); poseHandsOnHips(p, now); }
          else {
            yaw = Math.atan2(R.throwTo.x - x, R.throwTo.z - z);
            if (now < R.tArr + 250) poseCrouch(p, now, 0.7);
            else if (now < R.tArr + 800) evalKeys(THROW_KEYS, span(now, R.tArr + 250, R.tArr + 800), p);
            else poseStand(p, now);
          }
        }
      } else if (i === R.catcher) {
        const tMove1 = R.tCatch - 250;
        if (now < R.tc + 100) poseReady(p, now + i * 700);
        else if (now < tMove1) {
          const u = span(now, R.tc + 100, tMove1), dist = Math.hypot(R.catchPt.x - bx, R.catchPt.z - bz);
          x = lerp(bx, R.catchPt.x, u); z = lerp(bz, R.catchPt.z, u);
          yaw = Math.atan2(R.P.x - x, R.P.z - z);
          if (dist > 1.5) poseRun(p, (Math.hypot(x - bx, z - bz) / 1.9) * TAU, Math.min(1, dist / 6)); else poseReady(p, now + i * 700);
        } else {
          x = R.catchPt.x; z = R.catchPt.z; yaw = Math.atan2(R.P.x - x, R.P.z - z);
          const dec = decisionNow(now);
          if (now < R.tCatch + 450) poseCatch(p, R.high);
          else if (dec && now >= dec.t) { if (dec.kind === 'out') poseCelebrate(p, now - dec.t); else poseHandsOnHips(p, now); }
          else if (R.pending) poseAppeal(p, (now - R.tCatch - 450) / 500);
          else poseCelebrate(p, now - R.tCatch - 450);
        }
      } else if (out && isWicketKind() && !base.deep) {
        // the close fielders converge on the bowler to celebrate
        const tGo = R.kind === 'bowled' ? R.tStumps + 1400 : (decisionNow(now) ? decisionNow(now).t + 1300 : now);
        const u = span(now, tGo, tGo + 2200), tx = bx * 0.15 + 1.5, tz = bz * 0.15 - 12;
        x = lerp(bx, tx, easeOut(u)); z = lerp(bz, tz, easeOut(u)); yaw = Math.atan2(tx - bx, tz - bz);
        if (u < 1) poseRun(p, (Math.hypot(x - bx, z - bz) / 1.9) * TAU, 1); else poseCelebrate(p, now);
      } else if ((R.kind === 'four' || R.kind === 'six') && now > R.tc + 900) poseHandsOnHips(p, now + i * 300);
      else if (R.kind === 'six' && now > R.tc + 200) { poseStand(p, now, 0); setJ(p, J.head, -0.6, 0, 0); }
      else poseReady(p, now + i * 700);
      f.place(x, z, yaw); f.applyPose(p);
    }
  }

  // --- umpires ------------------------------------------------------------------------------------------
  function updateUmpires(now) {
    const u0 = umpires[0], p = u0.pose;
    const sig = signalNow(now), dec = decisionNow(now);
    let kind = null, t = 0;
    if (sig) { kind = sig.kind; t = sig.t; }
    if (dec && now >= dec.t && now < dec.t + SIGNAL_MS[dec.kind] + 400 && (!sig || dec.t >= sig.t)) { kind = dec.kind; t = dec.t; }
    if (kind) {
      const hold = SIGNAL_MS[kind], u = now - t;
      poseSignal(p, kind, u);
      if (u > hold) { u0.poseB.fill(0); poseStand(u0.poseB, now, 0); blendPose(p, u0.poseB, smooth((u - hold) / 400), p); }
    } else {
      poseStand(p, now);
      if (R.active && R.pending && !dec && now > R.tc + 400) setJ(p, J.head, 0.35, 0.1 * Math.sin(now * 0.004), 0);
    }
    u0.place(0, BOWL_Z - 2.5, 0); u0.applyPose(p);
    const u1 = umpires[1];
    poseStand(u1.pose, now + 1000); u1.place(-17, -1.0, Math.PI / 2); u1.applyPose(u1.pose);
  }

  // --- stumps, bails, ball ------------------------------------------------------------------------------
  function resetStumps() {
    for (const S of [ST.stumpsA, ST.stumpsB]) {
      for (const s of S.stumps) s.rotation.set(0, 0, 0);
      for (const b of S.bails) { b.position.copy(b.userData.rest); b.rotation.set(0, 0, 0); }
    }
  }
  function updateStumps(now) {
    const A = ST.stumpsA;
    if (R.active && R.kind === 'bowled' && now >= R.tStumps) {
      const t = (now - R.tStumps) / 1000;
      for (let i = 0; i < 3; i++) A.stumps[i].rotation.x = i === R.stumpHit ? 0.62 * smooth(t / 0.16) : 0;
      for (let i = 0; i < 2; i++) {
        const b = A.bails[i], v = R.bailV[i], tt = Math.min(t, R.bailLand[i]), rest = b.userData.rest;
        b.position.set(rest.x + v.x * tt, Math.max(0.012, rest.y + v.y * tt - 4.9 * tt * tt), rest.z + v.z * tt);
        b.rotation.set(tt * 14, 0, tt * 6 * (i ? -1 : 1));
      }
    } else resetStumps();
  }
  function updateBall(now, realNow) {
    let vis = false, onPath = false;
    const reviewing = REV.active && realNow >= REV.tA && realNow < REV.tEnd;
    if (!reviewing && path.n && (D.active || R.active)) { vis = ballAt(now, _bv); onPath = vis; }
    if (!vis && !reviewing && bowler.holdBall) { bowler.mirror.updateMatrixWorld(true); bowler.hand.R.getWorldPosition(_bv); _bv.y -= 0.04; vis = true; }
    ball.visible = vis;
    let s = 1;
    if (vis) { ball.position.copy(_bv); s = Math.max(1, camera.position.distanceTo(_bv) * 0.085); ball.scale.setScalar(s); }
    if (onPath) trail.update(path, now, s); else trail.mesh.visible = false;
  }

  // --- DRS review -----------------------------------------------------------------------------------------
  const VERDICT_TEXT = {
    pitching: { inline: ['IN LINE', 'red'], 'outside-leg': ['OUTSIDE LEG', 'green'], 'outside-off': ['OUTSIDE OFF', 'red'] },
    impact: { inline: ['IN LINE', 'red'], outside: ['OUTSIDE', 'green'] },
    wickets: { hitting: ['HITTING', 'red'], missing: ['MISSING', 'green'], 'umpires-call': ["UMPIRE'S CALL", 'amber'] },
  };
  const _items = [{ v: '', cls: '', on: false }, { v: '', cls: '', on: false }, { v: '', cls: '', on: false }];
  function disposeHawkEye() {
    for (const k of ['tube', 'halo', 'dashed']) { const m = HE[k]; if (m) { HE.group.remove(m); m.geometry.dispose(); HE[k] = null; } }
    HE.curve = null; HE.proj = null;
  }
  function buildHawkEye(d) {
    disposeHawkEye();
    const len = D.active ? D.length : 'good', spin = D.active && (D.pace === 'spin' || D.type === 'spin');
    const rel = D.active ? D.R : _v4.set(0.72, 2.15, BOWL_Z + CREASE + 0.35);
    const basePx = D.active ? D.P.x : 0, baseBx = D.active ? D.B.x : 0, baseBy = D.active ? D.B.y : 0.5;
    const px = d.pitching === 'outside-leg' ? -0.6 * mirrorX : d.pitching === 'outside-off' ? 0.62 * mirrorX : d.pitching === 'inline' ? clamp(basePx, -0.2, 0.2) : basePx;
    const ix = d.impact === 'outside' ? 0.58 * mirrorX : d.impact === 'inline' ? clamp(baseBx, -0.2, 0.2) : clamp(baseBx, -0.4, 0.4);
    const iy = clamp(baseBy * 0.75 + 0.08, 0.22, 0.62), iz = -1.32;
    let wx = clamp(ix, -0.14, 0.14), wy = clamp(iy - 0.06, 0.18, 0.6);
    if (d.wickets === 'missing') { if (Math.abs(ix) > 0.12) wx = ix + 0.38 * Math.sign(ix); else wy = 0.98; }
    else if (d.wickets === 'umpires-call') { wx = 0.27 * (ix >= 0 ? 1 : -1) * (Math.abs(ix) > 0.05 ? 1 : mirrorX); wy = iy; }
    const pts = [];
    const pz = -PITCH_DIST[len], arc1 = spin ? 0.5 : 0.04, arc2 = len === 'short' ? 0.14 : len === 'good' ? 0.1 : 0.05;
    for (let i = 0; i <= 14; i++) { const u = i / 14; pts.push(new THREE.Vector3(lerp(rel.x, px, u), lerp(rel.y, 0.036, u) + arc1 * 4 * u * (1 - u), lerp(rel.z, pz, u))); }
    for (let i = 1; i <= 10; i++) { const u = i / 10; pts.push(new THREE.Vector3(lerp(px, ix, u), lerp(0.036, iy, u) + arc2 * 4 * u * (1 - u), lerp(pz, iz, u))); }
    HE.curve = new THREE.CatmullRomCurve3(pts);
    HE.tube = new THREE.Mesh(new THREE.TubeGeometry(HE.curve, 72, 0.045, 7, false), HE.tubeMat);
    HE.halo = new THREE.Mesh(new THREE.TubeGeometry(HE.curve, 72, 0.1, 7, false), HE.haloMat);
    HE.group.add(HE.tube, HE.halo);
    const beyond = new THREE.Vector3(wx + (wx - ix) * 0.7, Math.max(0.05, wy - (iy - wy) * 0.7), 0.9);
    HE.proj = [new THREE.Vector3(ix, iy, iz), new THREE.Vector3(wx, wy, 0), beyond];
    const lg = new THREE.BufferGeometry().setFromPoints(HE.proj);
    HE.dashed = new THREE.Line(lg, HE.dashMat); HE.dashed.computeLineDistances(); HE.group.add(HE.dashed);
    HE.pitchMark.position.set(px, 0.02, pz); HE.impactMark.position.set(ix, iy, iz);
    HE.ball.position.copy(rel);
    HE.zone.visible = true;
  }
  function endReview(now) {
    if (!REV.active) return;
    REV.active = false;
    disposeHawkEye();
    HE.group.visible = false;
    overlay.setSlate(false); overlay.setTag(false); overlay.setVerdicts(false); overlay.setStamp(false); overlay.setUE(false);
    camGo('batting', Math.max(now, REV.tEnd) === now && now > REV.tEnd ? REV.tEnd : now, 900);
  }
  function updateReview(now) {
    if (!REV.active) return;
    if (now >= REV.tEnd) { endReview(now); return; }
    const d = REV.data, lbw = REV.kind === 'lbw';
    overlay.setTag(true, lbw ? 'DRS  -  LBW REVIEW' : 'DRS  -  CAUGHT REVIEW');
    const slateOn = now < REV.tA;
    overlay.setSlate(slateOn, lbw ? 'Third umpire checking: LBW' : 'Third umpire checking: CAUGHT');
    const replay = now >= REV.tA;
    HE.group.visible = replay && lbw;
    if (replay && lbw && HE.curve) {
      const p = span(now, REV.tA, REV.tB), bp = clamp01(p / 0.62);
      const idx = HE.tube.geometry.index.count;
      HE.tube.geometry.setDrawRange(0, Math.floor((idx * bp) / 6) * 6); HE.halo.geometry.setDrawRange(0, Math.floor((idx * bp) / 6) * 6);
      if (bp < 1) HE.curve.getPointAt(bp, HE.ball.position);
      else { const q = span(p, 0.62, 0.8); if (q < 0.5) HE.ball.position.lerpVectors(HE.proj[0], HE.proj[1], q * 2); else HE.ball.position.lerpVectors(HE.proj[1], HE.proj[2], (q - 0.5) * 2); }
      HE.dashed.visible = p > 0.64;
      HE.impactMark.visible = bp >= 1;
      for (let i = 0; i < 3; i++) {
        const key = i === 0 ? 'pitching' : i === 1 ? 'impact' : 'wickets', val = d[key], tx = VERDICT_TEXT[key][val] || VERDICT_TEXT[key][i === 0 ? 'inline' : i === 1 ? 'inline' : 'hitting'];
        _items[i].v = tx[0]; _items[i].cls = tx[1]; _items[i].on = now >= REV.reveal[i];
      }
      overlay.setVerdicts(true, _items);
    } else overlay.setVerdicts(false);
    if (replay && !lbw) {
      const p = span(now, REV.tA, REV.tB), pass = REV.pass, hold = 0.12;
      const z0 = REV.ueBallZ[0], z1 = REV.ueBallZ[1], zPass = BAT_Z + 0.02;
      let z;
      if (p < pass) z = lerp(z0, zPass, p / pass); else if (p < pass + hold) z = zPass; else z = lerp(zPass, z1, (p - pass - hold) / (1 - pass - hold));
      HE.group.visible = true; HE.zone.visible = false; HE.dashed && (HE.dashed.visible = false); HE.impactMark.visible = false;
      HE.ball.position.set(D.active ? D.B.x : 0.1 * mirrorX, D.active ? D.B.y : 0.7, z);
      HE.pitchMark.visible = false;
      overlay.setUE(true);
      overlay.drawUE(p, REV.spikeAt, d.ultraEdge === true, REV.noise, Math.floor(p * 240));
    } else { overlay.setUE(false); HE.pitchMark.visible = true; }
    if (now >= REV.tStamp) {
      const dec = d.decision === 'out' || (d.decision == null && d.verdict === 'out') ? 'out' : 'notout';
      const sub = d.overturned ? 'Decision overturned' : d.wickets === 'umpires-call' ? "Umpire's call, decision stands" : 'Decision stands';
      overlay.setStamp(true, dec === 'out' ? 'OUT' : 'NOT OUT', dec, sub);
    } else overlay.setStamp(false);
  }

  // --- umpire inset ----------------------------------------------------------------------------------------
  const INSET_LABEL = { out: ['OUT', 'out'], notout: ['NOT OUT', 'notout'], four: ['FOUR', 'four'], six: ['SIX', 'six'], wide: ['WIDE', 'wide'], noball: ['NO BALL', 'noball'] };
  let insetOn = false;
  function updateInset(now) {
    const sig = signalNow(now), dec = decisionNow(now);
    let kind = null, t = -1e9;
    if (sig && now < sig.t + INSET_MS) { kind = sig.kind; t = sig.t; }
    if (dec && now >= dec.t && now < dec.t + INSET_MS && dec.t >= t) { kind = dec.kind; t = dec.t; }
    insetOn = !!kind && !REV.active && now >= t + 120;
    overlay.setInset(insetOn, kind ? INSET_LABEL[kind][0] : '', kind ? INSET_LABEL[kind][1] : '');
  }

  // --- camera director (shot choice is a pure function of time; cuts are scheduled at event times) ------
  let lastFov = -1;
  function updateCamera(now) {
    if (REV.active) {
      if (now < REV.tA) camGo('slate', REV.t0, 500);
      else camGo(REV.kind === 'lbw' ? 'hawkeye' : 'ultraedge', REV.tA, 700);
    } else if (R.active) {
      if (R.kind === 'bowled' || R.kind === 'lbw') {
        if (now >= R.tCamBack) camGo('batting', R.tCamBack, 1000);
        else if (R.kind === 'lbw' && now >= R.tStumps + 700) camGo('bowlerEnd', R.tStumps + 700, 0);
        else camGo('wicketSide', R.tc, 0);
      }
      else if (R.kind === 'runs' || R.kind === 'four' || R.kind === 'six' || R.kind === 'caught') { if (now < R.tCamBack) camGo('follow', R.tc + 40, 380); else camGo('batting', R.tCamBack, 1100); }
      else camGo('batting', R.tc, 600);
    } else camGo('batting', lastNow, 700);
    camEval(now, cam.cur);
    const dbg = options.debugCamera;                 // undocumented: { pos: [x,y,z], target: [x,y,z], fov } forces a fixed camera (preview tooling)
    if (dbg && dbg.pos && dbg.target) { cam.cur.pos.fromArray(dbg.pos); cam.cur.target.fromArray(dbg.target); cam.cur.fov = num(dbg.fov, 40); }
    camera.position.copy(cam.cur.pos);
    camera.lookAt(cam.cur.target);
    if (Math.abs(cam.cur.fov - lastFov) > 0.01) { lastFov = cam.cur.fov; camera.fov = cam.cur.fov; camera.updateProjectionMatrix(); }
  }

  // --- event planning ---------------------------------------------------------------------------------------
  function cancelResult() { R.active = false; R.chaser = -1; R.catcher = -1; R.autoOutAt = 0; R.autoSignal = null; }
  function addCarryToKeeper(t, from) {
    const dk = Math.hypot(D.K.x - from.x, D.K.z - from.z), dur = Math.max(40, dk / D.speed);
    path.add(t, t + dur, from.x, from.y, from.z, D.K.x, D.K.y, D.K.z, 0.02, 0, 0);
    path.addRest(t + dur, t + dur + 60000, D.K);
    return t + dur;
  }
  function startDelivery(ev, t0) {
    ev = ev || {};
    const lead = clamp(num(ev.lead, 1100), 250, 8000);
    t0 = num(t0, lastNow + lead);
    cancelResult();
    if (REV.active) endReview(lastNow);
    D.active = true; D.t0 = t0; D.lead = lead; D.flightMs = clamp(num(ev.flightMs, 950), 250, 5000); D.tBat = t0 + D.flightMs;
    D.lineIndex = clamp(Math.round(num(ev.lineIndex, 1)), -1, 3); D.turn = clamp(Math.round(num(ev.turn, 0)), -1, 1);
    D.length = PITCH_DIST[ev.length] ? ev.length : 'good'; D.pace = typeof ev.pace === 'string' ? ev.pace : 'fast';
    D.type = ev.bowlerType || sceneInfo.bowler.type || 'fast';
    const spin = D.type === 'spin' || D.pace === 'spin' || D.pace === 'arm';
    D.actionMs = Math.min(600, lead * 0.6);
    const runSpeed = spin ? 4.2 : D.type === 'medium' ? 6 : 7.5, maxRun = spin ? 5 : D.type === 'medium' ? 12 : 18;
    D.runLen = clamp((runSpeed * (lead - D.actionMs)) / 1000, 1.5, maxRun);
    D.keeperZ = spin ? 1.5 : D.type === 'medium' ? 4.2 : 6.0; D.keeperX = 0.4;
    D.R.set(0.72, spin ? 1.95 : 2.15, BOWL_Z + CREASE + 0.35);
    const pitchX = LINE_X[D.lineIndex] * mirrorX, batX = LINE_X[clamp(D.lineIndex + D.turn, -1, 3)] * mirrorX;
    D.P.set(pitchX, 0.036, -PITCH_DIST[D.length]); D.B.set(batX, BAT_H[D.length], BAT_Z);
    const d1 = Math.hypot(D.P.x - D.R.x, D.P.z - D.R.z), d2 = Math.hypot(D.B.x - D.P.x, D.B.z - D.P.z);
    D.speed = (d1 + d2) / D.flightMs;                       // metres per millisecond
    D.tPitch = t0 + d1 / D.speed;
    const dirx = (D.B.x - D.P.x) / d2, dirz = (D.B.z - D.P.z) / d2;
    const kz = D.keeperZ - 0.6, dk = Math.max(0.5, (kz - D.B.z) / Math.max(dirz, 0.2));
    D.K.set(clamp(D.B.x + dirx * dk, -1.7, 1.7), clamp(D.B.y - 0.08 * dk, 0.3, 1.1), kz);
    D.tKeep = D.tBat + dk / D.speed;
    path.reset(); path.visibleFrom = t0;
    path.add(t0, D.tPitch, D.R.x, D.R.y, D.R.z, D.P.x, D.P.y, D.P.z, spin ? 0.5 : 0.04, 0, 0);
    path.add(D.tPitch, D.tBat, D.P.x, D.P.y, D.P.z, D.B.x, D.B.y, D.B.z, D.length === 'short' ? 0.14 : D.length === 'good' ? 0.1 : 0.05, 0, 0);
    addCarryToKeeper(D.tBat, D.B);
    D.swing.on = false;
  }
  function swing(dir, now) {
    const sw = D.swing;
    sw.on = true; sw.dir = SHOT_DIR[dir] ? dir : 'straight'; sw.t = num(now, lastNow); if (!sw.kind) sw.kind = 'attack';
  }
  function pickFielder(zone, preferDeep, px, pz) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < FIELD.length; i++) {
      const f = FIELD[i];
      if (zone && f.zone !== zone) continue;
      if (preferDeep != null && f.deep !== preferDeep) continue;
      const d = Math.hypot(f.x * mirrorX - px, f.z - pz);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function startResult(ev, now) {
    ev = ev || {}; now = num(now, lastNow);
    if (REV.active) endReview(now);
    if (!D.active) {
      const b = ev.ball || {};
      startDelivery({ lineIndex: b.lineIndex, length: b.length, pace: b.pace, flightMs: 950, lead: 1100 }, now - 950);
    }
    const tc = Math.max(now, D.tBat), shot = ev.shot || null;
    R.active = true; R.ev = ev; R.tc = tc; R.contact = ev.contact !== false; R.wide = !!ev.wide; R.pending = !!ev.decisionPending;
    R.shotDir = shot && SHOT_DIR[shot.dir] ? shot.dir : (D.swing.on ? D.swing.dir : 'straight');
    R.shotKind = shot && SHOT_KEYS[shot.kind] ? shot.kind : 'attack';
    R.runs = clamp(Math.round(num(ev.runs, 0)), 0, 6);
    R.chaser = -1; R.catcher = -1; R.noThrow = false; R.keeperCatch = false; R.autoOutAt = 0; R.autoSignal = null; R.tThrow0 = 0; R.tThrow1 = 0; R.tRun0 = 0; R.tStumps = 0; R.throwToKeeper = false; R.tCross = 0;
    const wk = ev.type === 'wicket' ? (ev.wicketKind || 'bowled') : null;
    R.kind = R.wide ? 'wide' : wk === 'lbw' ? 'lbw' : wk === 'caught' ? 'caught' : wk ? 'bowled' : !R.contact ? 'miss' : R.runs >= 6 ? 'six' : R.runs >= 4 ? 'four' : R.runs > 0 ? 'runs' : 'dot';
    if (shot && !D.swing.on) { D.swing.on = true; D.swing.dir = R.shotDir; D.swing.t = tc - 90; }
    if (shot) D.swing.kind = R.shotKind;
    path.cutAt(tc); path.at(tc, R.P);
    const dv = SHOT_DIR[R.shotDir], jitter = ((hashStr(ev.commentary || '') % 1000) / 1000 - 0.5) * 0.5;
    const cj = Math.cos(jitter), sj = Math.sin(jitter), vx0 = dv[0] * mirrorX, vz0 = dv[1];
    R.vx = vx0 * cj - vz0 * sj; R.vz = vx0 * sj + vz0 * cj;
    const loft = R.shotKind === 'loft';
    R.tCamBack = tc + 2500; R.tDead = tc + 2500;
    const P = R.P;
    switch (R.kind) {
      case 'miss': case 'wide': {
        const tK = addCarryToKeeper(tc, P);
        R.tDead = tK; R.tCamBack = tc;
        if (R.wide) { R.autoSignal = 'wide'; R.autoSignalAt = tK + 350; }
        break;
      }
      case 'dot': {
        R.stopPt.set(P.x + R.vx * 5, 0.036, P.z + R.vz * 5);
        path.add(tc, tc + 650, P.x, P.y, P.z, R.stopPt.x, R.stopPt.y, R.stopPt.z, 0.25, 1, 1, 2);
        path.addRest(tc + 650, tc + 60650, R.stopPt);
        R.tDead = tc + 650; R.tCamBack = tc;
        break;
      }
      case 'runs': {
        const n = Math.min(R.runs, 3), dist = RUN_DIST[n] + (R.runs > 3 ? 8 : 0), ms = RUN_MS[n];
        R.stopPt.set(P.x + R.vx * dist, 0.036, P.z + R.vz * dist); R.tStop = tc + ms;
        if (loft) {
          const mx = P.x + R.vx * dist * 0.6, mz = P.z + R.vz * dist * 0.6;
          path.add(tc, tc + ms * 0.5, P.x, P.y, P.z, mx, 0.04, mz, dist * 0.16 + 2, 0, 0);
          path.add(tc + ms * 0.5, tc + ms, mx, 0.04, mz, R.stopPt.x, R.stopPt.y, R.stopPt.z, 0.5, 1, 1, 2);
        } else path.add(tc, tc + ms, P.x, P.y, P.z, R.stopPt.x, R.stopPt.y, R.stopPt.z, 0.7, 1, 1, 3);
        const r = Math.hypot(R.stopPt.x, R.stopPt.z - FIELD_CZ);
        R.chaser = pickFielder(null, r < 38 ? false : null, R.stopPt.x, R.stopPt.z);
        const fb = FIELD[R.chaser], dF = Math.hypot(fb.x * mirrorX - R.stopPt.x, fb.z - R.stopPt.z);
        R.tChase0 = tc + 150; R.tArr = Math.max(R.tChase0 + (dF / 7.5) * 1000, R.tStop - 80);
        R.tThrow0 = R.tArr + 550;
        R.throwToKeeper = R.stopPt.z > -11;
        if (R.throwToKeeper) R.throwTo.set(D.keeperX, 0.95, D.keeperZ - 0.55); else R.throwTo.set(0.7, 0.95, BOWL_Z + 1.3);
        const dT = R.stopPt.distanceTo(R.throwTo), tf = clamp(dT / 22, 0.7, 1.5) * 1000;
        R.tThrow1 = R.tThrow0 + tf;
        path.addRest(R.tStop, R.tThrow0, R.stopPt);
        path.add(R.tThrow0, R.tThrow1, R.stopPt.x, 1.5, R.stopPt.z, R.throwTo.x, R.throwTo.y, R.throwTo.z, dT * 0.1, 0, 0);
        path.addRest(R.tThrow1, R.tThrow1 + 60000, R.throwTo);
        R.tDead = R.tThrow1; R.tCamBack = Math.min(R.tThrow0, tc + 2400);
        R.perRun = n === 1 ? 1500 : n === 2 ? 1250 : 950; R.tRun0 = tc + 250;
        break;
      }
      case 'four': {
        const s = ropeDistance(P.x, P.z, R.vx, R.vz), total = s + 7;
        const ex = P.x + R.vx * total, ez = P.z + R.vz * total;
        let frac, tSeg0, tSeg1;
        if (loft) {
          const mx = P.x + R.vx * s * 0.55, mz = P.z + R.vz * s * 0.55;
          path.add(tc, tc + 1000, P.x, P.y, P.z, mx, 0.04, mz, 7, 0, 0);
          path.add(tc + 1000, tc + 2100, mx, 0.04, mz, ex, 0.036, ez, 0.5, 1, 1, 3);
          frac = (s * 0.45) / (s * 0.45 + 7); tSeg0 = tc + 1000; tSeg1 = tc + 2100;
        } else {
          path.add(tc, tc + 2000, P.x, P.y, P.z, ex, 0.036, ez, 0.9, 1, 1, 4);
          frac = s / total; tSeg0 = tc; tSeg1 = tc + 2000;
        }
        R.tCross = tSeg0 + (1 - Math.cbrt(1 - frac)) * (tSeg1 - tSeg0);
        R.stopPt.set(ex, 0.036, ez);
        path.addRest(tSeg1, tSeg1 + 60000, R.stopPt);
        R.tDead = tSeg1; R.tCamBack = R.tCross + 700;
        R.chaser = pickFielder(null, null, P.x + R.vx * s, P.z + R.vz * s);
        const fb = FIELD[R.chaser], dF = Math.hypot(fb.x * mirrorX - ex, fb.z - ez);
        R.stopPt.set(P.x + R.vx * (s - 2), 0.036, P.z + R.vz * (s - 2));
        R.tChase0 = tc + 150; R.tArr = Math.max(R.tChase0 + (dF / 7.5) * 1000, R.tCross + 350); R.noThrow = true;
        R.autoSignal = 'four'; R.autoSignalAt = R.tCross + 400;
        R.tRun0 = tc + 250;
        break;
      }
      case 'six': {
        const s = ropeDistance(P.x, P.z, R.vx, R.vz), total = s + 11;
        const lx = P.x + R.vx * total, lz = P.z + R.vz * total, ly = standHeightAt(lx, lz) + 0.3;
        path.add(tc, tc + 2400, P.x, P.y, P.z, lx, ly, lz, 21 + (loft ? 5 : 0), 0, 0);
        R.stopPt.set(lx, ly, lz); path.addRest(tc + 2400, tc + 62400, R.stopPt);
        R.tCross = tc + 2400 * (s / total); R.tDead = tc + 2400; R.tCamBack = tc + 2900;
        R.autoSignal = 'six'; R.autoSignalAt = R.tCross + 300;
        break;
      }
      case 'bowled': {
        const sx = clamp(P.x, -0.12, 0.12), sy = clamp(P.y, 0.25, 0.65);
        const dS = Math.hypot(P.x - sx, P.z), dt = Math.max(30, dS / D.speed);
        R.tStumps = tc + dt; R.stumpHit = sx < -0.06 ? 0 : sx > 0.06 ? 2 : 1;
        path.add(tc, R.tStumps, P.x, P.y, P.z, sx, sy, 0.02, 0, 0, 0);
        const sg = sx >= 0 ? 1 : -1, dx = sx + 0.6 * sg;
        path.add(R.tStumps, R.tStumps + 450, sx, sy, 0.02, dx, 0.03, 2.4, 0.4, 0, 0);
        path.add(R.tStumps + 450, R.tStumps + 1100, dx, 0.03, 2.4, dx + 0.4 * sg, 0.03, 4.0, 0.15, 1, 1, 2);
        _v1.set(dx + 0.4 * sg, 0.03, 4.0); path.addRest(R.tStumps + 1100, R.tStumps + 61100, _v1);
        R.bailV[0].set(-1.1, 3.4, 2.0); R.bailV[1].set(1.3, 3.0, 2.4);
        R.bailLand = R.bailV.map((v) => (v.y + Math.sqrt(v.y * v.y + 4 * 4.9 * 0.713)) / 9.8);
        R.tDead = R.tStumps + 1100; R.tCamBack = tc + 2400;
        break;
      }
      case 'lbw': {
        const px = P.x * 0.4 - 0.21 * mirrorX, py = clamp(P.y, 0.25, 0.6), pz = -1.32;
        const dt = Math.max(30, Math.hypot(P.x - px, P.z - pz) / D.speed);
        R.tStumps = tc + dt;
        path.add(tc, R.tStumps, P.x, P.y, P.z, px, py, pz, 0, 0, 0);
        _v1.set(px + 0.9 * mirrorX, 0.03, pz - 1.3);
        path.add(R.tStumps, R.tStumps + 450, px, py, pz, _v1.x, _v1.y, _v1.z, 0.25, 0, 0);
        path.addRest(R.tStumps + 450, R.tStumps + 60450, _v1);
        R.tDead = R.tStumps + 450; R.tCamBack = tc + (R.pending ? 2900 : 2600);
        if (!R.pending) R.autoOutAt = tc + 750;
        break;
      }
      case 'caught': {
        const zone = ['leg', 'straight', 'off', 'keeper'].includes(ev.fielderZone) ? ev.fielderZone : R.shotDir;
        if (zone === 'keeper') {
          R.keeperCatch = true;
          R.catchPt.set(clamp(P.x + 0.35 * mirrorX, -1.2, 1.2), 0.85, D.keeperZ - 0.6);
          const dt = Math.max(60, R.catchPt.distanceTo(P) / (D.speed * 0.9));
          R.tCatch = tc + dt; R.high = false;
          path.add(tc, R.tCatch, P.x, P.y, P.z, R.catchPt.x, R.catchPt.y, R.catchPt.z, 0.02, 0, 0);
          path.addRest(R.tCatch, R.tCatch + 60000, R.catchPt);
        } else {
          let fi = pickFielder(zone, loft, P.x, P.z);
          if (fi < 0) fi = pickFielder(zone, null, P.x, P.z);
          if (fi < 0) fi = pickFielder(null, null, P.x + R.vx * 25, P.z + R.vz * 25);
          R.catcher = fi;
          const fb = FIELD[fi], bx = fb.x * mirrorX, bz = fb.z;
          let s = (bx - P.x) * R.vx + (bz - P.z) * R.vz; s = Math.max(8, s);
          let mx = P.x + R.vx * s - bx, mz = P.z + R.vz * s - bz;
          const ml = Math.hypot(mx, mz); if (ml > 9) { mx *= 9 / ml; mz *= 9 / ml; }
          R.catchPt.set(bx + mx, 0, bz + mz);
          let fx = P.x - R.catchPt.x, fz = P.z - R.catchPt.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
          const dist = fl;
          R.high = loft || dist > 28;
          _v1.set(R.catchPt.x + fx * (R.high ? 0.25 : 0.55), R.high ? 2.05 : 1.1, R.catchPt.z + fz * (R.high ? 0.25 : 0.55));
          const flight = R.high ? clamp(dist / 13, 1.2, 2.6) : clamp(dist / 24, 0.5, 1.2);
          R.tCatch = tc + flight * 1000;
          path.add(tc, R.tCatch, P.x, P.y, P.z, _v1.x, _v1.y, _v1.z, R.high ? 8 + dist * 0.14 : dist * 0.05 + 0.5, 0, 0);
          path.addRest(R.tCatch, R.tCatch + 60000, _v1);
        }
        R.tDead = R.tCatch; R.tCamBack = R.tCatch + (R.pending ? 2600 : 1100);
        if (!R.pending) R.autoOutAt = R.tCatch + 450;
        break;
      }
      default: break;
    }
  }
  function showDecision(decision, now) {
    DEC.kind = decision === 'out' ? 'out' : 'notout'; DEC.t = num(now, lastNow);
  }
  function signal(kind, now) {
    if (!SIGNAL_MS[kind]) return;
    SIG.kind = kind; SIG.t = num(now, lastNow);
  }
  function startReview(data, now) {
    data = data || {}; now = num(now, lastNow);
    if (REV.active) endReview(now);
    REV.active = true; REV.t0 = now; REV.dur = clamp(num(data.durationMs, 9000), 2500, 60000);
    REV.kind = data.kind === 'caught' ? 'caught' : 'lbw';
    REV.data = { pitching: data.pitching, impact: data.impact, wickets: data.wickets, ultraEdge: data.ultraEdge, verdict: data.verdict, overturned: !!data.overturned, decision: data.decision };
    const dur = REV.dur;
    REV.tA = now + dur * 0.13; REV.tB = now + dur * 0.76; REV.tStamp = now + dur * 0.8; REV.tEnd = now + dur;
    REV.reveal[0] = now + dur * 0.42; REV.reveal[1] = now + dur * 0.55; REV.reveal[2] = now + dur * 0.68;
    REV.freezeAt = R.active ? (R.kind === 'caught' ? (D.swing.on ? D.swing.t + 90 : R.tc) : R.tStumps ? R.tStumps + 40 : R.tc + 160) : D.active ? D.tBat + 60 : now;
    REV.pass = 0.38; REV.spikeAt = REV.pass * 0.92;
    if (REV.kind === 'lbw') buildHawkEye(REV.data); else { disposeHawkEye(); HE.ball.position.set(0, 0.7, -3); }
    camGo('slate', now, 500);
  }
  function celebrate(kind, now) {
    now = num(now, lastNow);
    const burst = (t, x, y, z, c) => fx.firework(t, x, y, z, c);
    switch (kind) {
      case 'six': fx.crowdFlash(now, 3200); burst(now + 150, -38, 36, -78, 0xffd27a); burst(now + 550, 30, 38, -84, 0xff8c6a); burst(now + 950, -5, 40, -92, 0xffffff); break;
      case 'four': fx.crowdFlash(now, 2300); break;
      case 'wicket': fx.crowdFlash(now, 2700); break;
      case 'win': fx.crowdFlash(now, 5000); fx.confettiDrop(now + 300, 0, -10);
        for (let i = 0; i < 7; i++) burst(now + 200 + i * 330, -50 + i * 16, 36 + (i % 3) * 3, -70 - (i % 2) * 18, [0xffd27a, 0xff8c6a, 0x9fd8ff, 0xffffff][i % 4]);
        break;
      default: fx.crowdFlash(now, 1800); break;
    }
  }
  function idle() {
    D.active = false; D.swing.on = false; D.swing.kind = null;
    cancelResult();
    if (REV.active) endReview(lastNow);
    DEC.kind = null; DEC.t = -1e9; SIG.kind = null; SIG.t = -1e9;
    path.reset(); resetStumps();
    bowler.holdBall = false; ball.visible = false; trail.mesh.visible = false;
    overlay.setInset(false, '', '');
    camGo('batting', lastNow, 700);
  }

  // --- match data ---------------------------------------------------------------------------------------------
  function applyKits() {
    const kb = kits[sceneInfo.battingSlot], kf = kits[sceneInfo.bowlingSlot];
    striker.setKit(kb); nonStriker.setKit(kb); bowler.setKit(kf); keeper.setKit(kf);
    for (const f of fielders) f.setKit(kf);
  }
  function setMatch(m) {
    const teams = m && Array.isArray(m.teams) ? m.teams : [];
    for (let i = 0; i < 2; i++) {
      const t = Object.assign({}, DEFAULT_TEAMS[i], teams[i] && typeof teams[i] === 'object' ? teams[i] : {});
      match.teams[i] = t;
      setKitColors(kits[i], parseColor(t.color, DEFAULT_TEAMS[i].color), parseColor(t.color2, DEFAULT_TEAMS[i].color2));
    }
    applyKits();
    ST.screen.paint(match, sceneInfo);
  }
  function setScene(s) {
    s = s || {};
    sceneInfo.battingSlot = s.battingSlot === 1 ? 1 : 0;
    sceneInfo.bowlingSlot = s.bowlingSlot === 0 || s.bowlingSlot === 1 ? s.bowlingSlot : 1 - sceneInfo.battingSlot;
    const person = (p, d) => ({ name: p && typeof p.name === 'string' ? p.name : d.name, hand: p && p.hand === 'L' ? 'L' : 'R', type: p && ['fast', 'medium', 'spin'].includes(p.type) ? p.type : d.type });
    sceneInfo.striker = person(s.striker, { name: 'Striker' });
    sceneInfo.nonStriker = person(s.nonStriker, { name: 'Non-striker' });
    sceneInfo.bowler = person(s.bowler, { name: 'Bowler', type: 'fast' });
    mirrorX = sceneInfo.striker.hand === 'L' ? -1 : 1;
    striker.setMirror(mirrorX < 0);
    nonStriker.setMirror(sceneInfo.nonStriker.hand === 'L');
    if (!D.active) { const spin = sceneInfo.bowler.type === 'spin'; D.keeperZ = spin ? 1.5 : sceneInfo.bowler.type === 'medium' ? 4.2 : 6.0; }
    applyKits();
    ST.screen.paint(match, sceneInfo);
  }

  // --- size and frame -----------------------------------------------------------------------------------------
  function resize() {
    needResize = false;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 480)), h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 640));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (w !== viewW || h !== viewH || dpr !== gl.getPixelRatio()) {
      gl.setPixelRatio(dpr); gl.setSize(w, h, false); viewW = w; viewH = h;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      gl.shadowMap.needsUpdate = true;
    }
    const parent = canvas.parentElement;
    let left = canvas.offsetLeft, top = canvas.offsetTop;
    if (parent && canvas.offsetParent !== parent) { const pr = parent.getBoundingClientRect(); left = Math.round(rect.left - pr.left + parent.scrollLeft); top = Math.round(rect.top - pr.top + parent.scrollTop); }
    overlay.layout(left, top, w, h);
    const want = options.shadows != null ? !!options.shadows : (window.innerWidth || 800) > 700;
    if (want !== gl.shadowMap.enabled) {
      gl.shadowMap.enabled = want;
      scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
      gl.shadowMap.needsUpdate = true;
    }
  }
  const onWinResize = () => { needResize = true; };
  window.addEventListener('resize', onWinResize);
  if (typeof ResizeObserver === 'function') { try { new ResizeObserver(onWinResize).observe(canvas); } catch (e) { /* optional */ } }
  insetCam.position.set(0.35, 1.5, BOWL_Z - 2.5 + 3.2);
  insetCam.lookAt(0, 1.32, BOWL_Z - 2.5);
  let shadowFrames = 3;

  function draw(now) {
    now = num(now, lastNow + 16.7); lastNow = now;
    if (needResize) resize();
    const camBusy = now < cam.since + cam.blend;
    const busy = D.active || R.active || REV.active || now < DEC.t + INSET_MS + 600 || now < SIG.t + 3400 || fx.busy || camBusy;
    if (!busy && now - lastRender < 45 && shadowFrames <= 0) return;
    updateCamera(now);
    const frozen = REV.active && now >= REV.tA && now < REV.tEnd;
    const figNow = frozen ? REV.freezeAt : now;
    updateBowler(figNow); updateStriker(figNow); updateNonStriker(figNow); updateKeeper(figNow); updateFielders(figNow);
    updateUmpires(now);
    updateStumps(figNow); updateBall(figNow, now);
    updateReview(now); updateInset(now);
    fx.update(now, gl.getPixelRatio());
    if (gl.shadowMap.enabled && (busy || shadowFrames > 0)) gl.shadowMap.needsUpdate = true;
    if (shadowFrames > 0) shadowFrames--;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, viewW, viewH);
    gl.render(scene, camera);
    if (insetOn) {
      const r = overlay.insetRect();
      const x = Math.round(r.x), y = Math.round(viewH - r.y - r.h), w = Math.round(r.w), h = Math.round(r.h);
      insetCam.aspect = w / Math.max(1, h); insetCam.updateProjectionMatrix();
      gl.setScissorTest(true); gl.setScissor(x, y, w, h); gl.setViewport(x, y, w, h);
      gl.clear(true, true, false);
      gl.render(scene, insetCam);
      gl.setScissorTest(false); gl.setViewport(0, 0, viewW, viewH);
    }
    lastRender = now;
  }

  setMatch(match); setScene(sceneInfo);
  return { setMatch, setScene, startDelivery, swing, startResult, showDecision, startReview, signal, celebrate, idle, draw, resize };
}

window.Renderer = Renderer;
window.dispatchEvent(new Event('renderer-ready'));
