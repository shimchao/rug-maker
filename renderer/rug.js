(() => {
'use strict';
const host = window.rugHost || null, DESKTOP = !!host;   // 앱 안이면 투명 배경 + 바탕화면 모드
if (DESKTOP) document.documentElement.classList.add('desktop');
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ───────── 장면 ───────── */
const stage = $('#stage');
let W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({canvas: stage, antialias: true, alpha: DESKTOP, preserveDrawingBuffer: true});
if (DESKTOP) renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const cam = new THREE.OrthographicCamera(0, W, 0, -H, .1, 4000);
cam.position.set(0, 0, 2000);
scene.add(new THREE.AmbientLight(0xffffff, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 2.55);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 100; sun.shadow.camera.far = 3500;
sun.shadow.normalBias = .25; sun.shadow.bias = -15e-6;
scene.add(sun, sun.target);
const fillLight = new THREE.DirectionalLight(0xffffff, .5);
scene.add(fillLight);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), DESKTOP ? new THREE.ShadowMaterial({opacity: .24}) : new THREE.MeshStandardMaterial({color: 0xe9dfd2, roughness: 1}));
floor.receiveShadow = true;
scene.add(floor);

function layout() {
  W = innerWidth; H = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W, H, false);
  cam.right = W; cam.bottom = -H; cam.updateProjectionMatrix();
  floor.position.set(W / 2, -H / 2, 0);
  fillLight.position.set(W, -H, 1000);
  dirty = true;
}

/* ───────── 러그(천) ───────── */
const R = 1.5;            // 러그 두께의 절반(바닥에서 뜬 높이)
const GRAVITY = .9, ITER = 4, SUB = 3, THICK = 3.6, MAXPULL = 7, MEMORY = 0;   // MEMORY: 접힌 자국을 기억하는 속도(클수록 접힌 모양이 빨리 굳는다)   // MAXPULL: 한 프레임에 손이 끌 수 있는 최대 거리(px)
let cloth = null, dirty = true;
// 러그 효과: 밝은 부분을 털실처럼 중립 흰색에 가깝게 하고, 아주 작은 올의 명암과 결을 더한다. 값은 효과의 세기(0이면 꺼짐)
const FX = {none: 0, faint: .35, soft: .6, normal: 1, strong: 1.7};
const U_YARN = {value: 0};
const U_TILE = {value: new THREE.Vector2(120, 120)};   // 털고리 알갱이가 가로·세로로 몇 칸인지(러그 크기에 맞춰 알갱이 크기를 일정하게 한다)
const YARN_BRIGHT = 0.55, YARN_BUMP = 0.55, YARN_TILE_PX = 512;   // 밝기 변화 세기, 굴곡 세기(기준 「보통」일 때), 질감 그림 한 장이 덮는 화면 크기(px)
let yarnTex = null;
/* 털고리 질감 그림: 작은 곡선 수천 개를 불규칙하게 흩뿌린다. 곡선마다 어두운 그늘 위에 밝은 올을 얹고, 가장자리가 이어지게 감싸 그린다 */
function getYarnTex() {
  if (yarnTex) return yarnTex;
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S); g.lineCap = 'round';
  let seed = 20261010; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 17000; i++) {   // 짧은 곡선 조각을 굵게 많이 겹쳐서 동그라미가 아니라 뭉친 털올로 보이게 한다
    const x = rnd() * S, y = rnd() * S, r = 2.2 + rnd() * 3.4, a0 = rnd() * 6.283, a1 = a0 + (.45 + rnd() * .6) * Math.PI, lw = 1.9 + rnd() * 1.3;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      const px = x + dx, py = y + dy;
      if (px < -9 || px > S + 9 || py < -9 || py > S + 9) continue;
      g.strokeStyle = 'rgba(25,25,25,.30)'; g.lineWidth = lw * 1.5; g.beginPath(); g.arc(px + .9, py + 1.0, r, a0, a1); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = lw; g.beginPath(); g.arc(px, py, r, a0, a1); g.stroke();
    }
  }
  yarnTex = new THREE.CanvasTexture(c); yarnTex.wrapS = yarnTex.wrapT = THREE.RepeatWrapping; yarnTex.anisotropy = 4;
  return yarnTex;
}

function buildCloth(canvas) {
  disposeCloth();
  const cw = canvas.width, ch = canvas.height, asp = cw / ch;
  const S = Math.min(W, H) * (W < 700 ? .62 : .46);
  const N = 52;
  const cols = asp >= 1 ? N : Math.max(8, Math.round(N * asp));
  const rows = asp >= 1 ? Math.max(8, Math.round(N / asp)) : N;
  const cell = S / Math.max(cols, rows);
  const nx = cols + 1, ny = rows + 1, count = nx * ny;
  const px = canvas.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, cw, ch).data;
  const alpha = (u, v) => {
    if (u < 0 || v < 0 || u > 1 || v > 1) return 0;
    return px[(Math.min(ch - 1, (v * ch) | 0) * cw + Math.min(cw - 1, (u * cw) | 0)) * 4 + 3] / 255;
  };
  const p = new Float64Array(count * 3), o = new Float64Array(count * 3);
  const uv = new Float32Array(count * 2), act = new Uint8Array(count);
  const wpx = cols * cell, hpx = rows * cell, cx = W / 2, cy = H / 2;
  U_TILE.value.set(wpx / YARN_TILE_PX, hpx / YARN_TILE_PX);   // 질감 그림 한 장이 화면 300px를 덮도록 반복 횟수를 정한다
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const i = r * nx + c, u = c / cols, v = r / rows;
    p[i * 3] = cx + (u - .5) * wpx; p[i * 3 + 1] = cy + (v - .5) * hpx; p[i * 3 + 2] = R;
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  const tris = [], cellOn = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const l = r * nx + c;
    for (const t of [[l, l + nx, l + 1], [l + 1, l + nx, l + nx + 1]]) {
      const mu = (uv[t[0] * 2] + uv[t[1] * 2] + uv[t[2] * 2]) / 3, mv = (uv[t[0] * 2 + 1] + uv[t[1] * 2 + 1] + uv[t[2] * 2 + 1]) / 3;
      if (alpha(mu, mv) > .08 || t.some(k => alpha(uv[k * 2], uv[k * 2 + 1]) > .08)) { tris.push(...t); t.forEach(k => act[k] = 1); cellOn[r * cols + c] = 1; }
    }
  }
  const links = [];
  const add = (i, j, s, kind = 0) => {
    if (!act[i] || !act[j]) return;
    links.push([i * 3, j * 3, Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1]), s, kind]);
  };
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const i = r * nx + c;
    if (c + 1 < nx) add(i, i + 1, 1);
    if (r + 1 < ny) add(i, i + nx, 1);
    if (c + 1 < nx && r + 1 < ny) { add(i, i + nx + 1, .85); add(i + 1, i + nx, .85); }
    // 두꺼운 러그는 잘게 접히지 않는다: 멀리 떨어진 점끼리도 이어서 큰 덩어리로만 접히게 한다
    if (c + 2 < nx && act[i + 1]) add(i, i + 2, .9, 1);
    if (r + 2 < ny && act[i + nx]) add(i, i + 2 * nx, .9, 1);
    if (c + 3 < nx && act[i + 1] && act[i + 2]) add(i, i + 3, .12, 2);
    if (r + 3 < ny && act[i + nx] && act[i + 2 * nx]) add(i, i + 3 * nx, .12, 2);
    if (c + 4 < nx && act[i + 2]) add(i, i + 4, .05, 2);
    if (r + 4 < ny && act[i + 2 * nx]) add(i, i + 4 * nx, .05, 2);
  }
  o.set(p);
  const idx = []; for (let i = 0; i < count; i++) if (act[i]) idx.push(i);

  // 그릴 때는 계산용 점 사이를 곡선(Catmull-Rom)으로 한 번 더 쪼개서, 접히는 곳이 각지지 않고 매끈하게 보이게 한다
  const K = 2, LW = cols * K + 1, LH = rows * K + 1;
  const lat = new Int32Array(LW * LH).fill(-1), latRC = [];
  const mark = (rr, cc) => { const k = rr * LW + cc; if (lat[k] < 0) { lat[k] = latRC.length / 2; latRC.push(rr, cc); } };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cellOn[r * cols + c])
    for (let a = 0; a <= K; a++) for (let b = 0; b <= K; b++) mark(r * K + a, c * K + b);
  const rc = latRC.length / 2;
  const gi = new Int32Array(rc * 16), wu = new Float32Array(rc * 4), wv = new Float32Array(rc * 4), ruv = new Float32Array(rc * 2);
  const crw = t => { const t2 = t * t, t3 = t2 * t; return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]; };
  for (let v = 0; v < rc; v++) {
    const rr = latRC[v * 2], cc = latRC[v * 2 + 1];
    const r0 = Math.min(rows - 1, Math.floor(rr / K)), c0 = Math.min(cols - 1, Math.floor(cc / K));
    const fv = (rr - r0 * K) / K, fu = (cc - c0 * K) / K;
    wu.set(crw(fu), v * 4); wv.set(crw(fv), v * 4);
    ruv[v * 2] = (c0 + fu) / cols; ruv[v * 2 + 1] = (r0 + fv) / rows;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const gr = r0 - 1 + j, gc = c0 - 1 + i;
      gi[v * 16 + j * 4 + i] = gr >= 0 && gc >= 0 && gr < ny && gc < nx && act[gr * nx + gc] ? gr * nx + gc : -1;
    }
  }
  const nb4 = new Int32Array(rc * 4).fill(-1);   // 그리는 점의 위·아래·왼·오른 이웃 (법선을 부드럽게 섞을 때 쓴다)
  for (let v = 0; v < rc; v++) {
    const rr = latRC[v * 2], cc = latRC[v * 2 + 1];
    if (rr > 0) nb4[v * 4] = lat[(rr - 1) * LW + cc];
    if (rr < LH - 1) nb4[v * 4 + 1] = lat[(rr + 1) * LW + cc];
    if (cc > 0) nb4[v * 4 + 2] = lat[rr * LW + cc - 1];
    if (cc < LW - 1) nb4[v * 4 + 3] = lat[rr * LW + cc + 1];
  }
  const rtris = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cellOn[r * cols + c])
    for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
      const rr = r * K + a, cc = c * K + b;
      const q00 = lat[rr * LW + cc], q10 = lat[(rr + 1) * LW + cc], q01 = lat[rr * LW + cc + 1], q11 = lat[(rr + 1) * LW + cc + 1];
      rtris.push(q00, q10, q01, q01, q10, q11);
    }
  const indexAttr = new THREE.BufferAttribute(new Uint32Array(rtris), 1), uvAttr = new THREE.BufferAttribute(ruv, 2);
  const mk = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rc * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rc * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', uvAttr); g.setIndex(indexAttr);
    return g;
  };
  const geo = mk(), geoB = mk();
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const topMat = new THREE.MeshStandardMaterial({map: tex, roughness: 1, metalness: 0, side: THREE.FrontSide, alphaTest: .12});
  topMat.shadowSide = THREE.DoubleSide;
  topMat.onBeforeCompile = sh => {
    sh.uniforms.uYarn = U_YARN; sh.uniforms.uYarnTile = U_TILE; sh.uniforms.uYarnTex = {value: getYarnTex()};
    sh.uniforms.uYarnBright = {value: YARN_BRIGHT}; sh.uniforms.uYarnBump = {value: YARN_BUMP};
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
      uniform float uYarn; uniform vec2 uYarnTile; uniform float uYarnBright; uniform float uYarnBump; uniform sampler2D uYarnTex;
      float yT(vec2 uv){ return texture2D(uYarnTex, uv * uYarnTile).r; }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb *= 1.0 + (yT(vMapUv) - 0.5) * uYarnBright * uYarn;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      vec2 yE = vec2(1.0 / 512.0) / uYarnTile;
      vec2 yG = vec2(yT(vMapUv + vec2(yE.x, 0.0)) - yT(vMapUv - vec2(yE.x, 0.0)), yT(vMapUv + vec2(0.0, yE.y)) - yT(vMapUv - vec2(0.0, yE.y)));
      normal = normalize(normal + vec3(yG, 0.0) * (uYarnBump * uYarn));`);
  };
  const botMat = new THREE.MeshStandardMaterial({map: tex, roughness: 1, metalness: 0, side: THREE.BackSide, alphaTest: .12});
  botMat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      float weave = sin(vMapUv.x * 1800.0) * sin(vMapUv.y * 1800.0);
      diffuseColor.rgb = vec3(0.40 + weave * 0.014, 0.36 + weave * 0.013, 0.31 + weave * 0.012);`);
  };
  const top = new THREE.Mesh(geo, topMat), bot = new THREE.Mesh(geoB, botMat);
  top.frustumCulled = bot.frustumCulled = false;
  top.castShadow = true; top.receiveShadow = true; bot.receiveShadow = true;
  scene.add(top, bot);

  const L = links.length, la = new Int32Array(L), lb = new Int32Array(L), lr = new Float64Array(L), ls = new Float64Array(L), lk = new Uint8Array(L);
  links.forEach((k, n) => { la[n] = k[0]; lb[n] = k[1]; lr[n] = k[2]; ls[n] = k[3]; lk[n] = k[4]; });
  const lr0 = new Float64Array(lr);
  cloth = {p, o, uv, act, idx, nx, ny, count, cols, rows, cell, wpx, hpx, L, la, lb, lr, ls, lk, lr0, tris: tris.length / 3, tri: new Uint32Array(tris), sw: new Float64Array(count * 3), tb: new Float64Array(tris.length * 2), tr: new Int32Array(tris.length * 2), rc, nb4, nbTmp: new Float32Array(rc * 3), gi, wu, wv, rp: new Float64Array(12), rk: new Uint8Array(4), geoB, nrm: new THREE.BufferGeometry(),
    scale: 1, pin: new Uint8Array(count), pins: [], grab: null, flattening: 0, flatCenter: null,
    sleeping: false, quiet: 0, geo, top, bot, tex, topMat, botMat};
  updateGeometry();
}
function disposeCloth() {
  if (!cloth) return;
  scene.remove(cloth.top, cloth.bot);
  cloth.geo.dispose(); cloth.geoB.dispose(); cloth.nrm.dispose(); cloth.tex.dispose(); cloth.topMat.dispose(); cloth.botMat.dispose();
  cloth = null;
}

const wake = c => { c.sleeping = false; c.quiet = 0; };
function center(c) {
  let x = 0, y = 0;
  for (const i of c.idx) { x += c.p[i * 3]; y += c.p[i * 3 + 1]; }
  return {x: x / c.idx.length, y: y / c.idx.length};
}
function nearest(c, x, y, maxR) {
  let best = -1, bd = maxR * maxR;
  for (const i of c.idx) {
    const dx = c.p[i * 3] - x, dy = c.p[i * 3 + 1] - y, d = dx * dx + dy * dy - c.p[i * 3 + 2] * .1;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function startGrab(c, x, y, i, slide = false) {
  c.flattening = 0;
  const r0 = Math.floor(i / c.nx), c0 = i % c.nx, pins = [];
  for (let r = Math.max(0, r0 - 2); r <= Math.min(c.ny - 1, r0 + 2); r++)   // 손바닥으로 귀퉁이를 통째로 드는 느낌: 5×5 칸을 한 덩어리로 잡는다
    for (let q = Math.max(0, c0 - 2); q <= Math.min(c.nx - 1, c0 + 2); q++) {
      const j = r * c.nx + q;
      if (!c.act[j]) continue;
      pins.push({i: j, dx: (q - c0) * c.cell * c.scale * .9, dy: (r - r0) * c.cell * c.scale * .9});
    }
  c.pins = pins; c.pin.fill(0); pins.forEach(k => c.pin[k.i] = 1);
  c.grab = {tx: x, ty: y, cx: x, cy: y, sx: x, sy: y, h: slide ? R + 1.2 : 6 * c.scale, slide};
  const reach = 58 * c.scale;
  if (!slide) for (const k of c.idx) {   // 잡은 자리 주변을 살짝 들어 올려 주름이 접히는 방향을 만든다
    const d = Math.hypot(c.p[k * 3] - x, c.p[k * 3 + 1] - y);
    if (d < reach) c.p[k * 3 + 2] += Math.sin((1 - d / reach) * Math.PI / 2) * 2 * c.scale;
  }
  wake(c);
}
function moveGrab(c, x, y) {
  if (!c.grab) return;
  c.grab.tx = Math.max(12, Math.min(W - 12, x)); c.grab.ty = Math.max(12, Math.min(H - 12, y));
  c.grab.h = c.grab.slide ? R + 1.2 : (7 + Math.min(12, Math.hypot(x - c.grab.sx, y - c.grab.sy) * .08)) * c.scale;   // 옮기기(slide)는 바닥에 붙여서 끈다
  wake(c);
}
function release(c) { c.grab = null; c.pins = []; c.pin.fill(0); wake(c); }
function translate(c, dx, dy) {
  for (let i = 0; i < c.count; i++) { c.p[i * 3] += dx; c.o[i * 3] += dx; c.p[i * 3 + 1] += dy; c.o[i * 3 + 1] += dy; }
  if (c.grab) { c.grab.tx += dx; c.grab.ty += dy; c.grab.cx += dx; c.grab.cy += dy; c.grab.sx += dx; c.grab.sy += dy; }
  wake(c);
}
function resize(c, f) {
  const s = Math.max(.45, Math.min(1.8, c.scale * f)); f = s / c.scale; c.scale = s;
  const m = center(c);
  for (let i = 0; i < c.count; i++) {
    c.p[i * 3] = m.x + (c.p[i * 3] - m.x) * f; c.p[i * 3 + 1] = m.y + (c.p[i * 3 + 1] - m.y) * f;
    c.p[i * 3 + 2] = R + (c.p[i * 3 + 2] - R) * f;
  }
  for (let k = 0; k < c.L; k++) { c.lr[k] *= f; c.lr0[k] *= f; }
  c.o.set(c.p); wake(c);
}
function flatten(c) { release(c); c.lr.set(c.lr0);   // 접힌 자국 기억을 지운다
  c.flatCenter = center(c); c.flattening = 1; wake(c); }
function applyPins(c) {
  const g = c.grab; if (!g) return;
  for (const k of c.pins) {
    const x = k.i * 3;
    c.p[x] = g.cx + k.dx; c.p[x + 1] = g.cy + k.dy; c.p[x + 2] = g.h;
    c.o[x] = c.p[x]; c.o[x + 1] = c.p[x + 1]; c.o[x + 2] = c.p[x + 2];
  }
}
/* 한 프레임 계산. 움직임이 남아 있으면 값을, 멈췄으면 null 을 돌려준다 */
const WEIGHT = {light: {g: .6, pull: 1.25}, normal: {g: 1, pull: 1}, heavy: {g: 1.6, pull: .75}};   // 무게: 중력 배율, 손을 따라오는 속도 배율
let wt = WEIGHT.normal;
function step(c) {
  if (c.sleeping) return null;
  const {p, o, idx, pin} = c;
  if (c.flattening) {
    let far = 0;
    for (const i of idx) {
      const x = i * 3, tx = c.flatCenter.x + (c.uv[i * 2] - .5) * c.wpx * c.scale, ty = c.flatCenter.y + (c.uv[i * 2 + 1] - .5) * c.hpx * c.scale;
      far = Math.max(far, Math.abs(tx - p[x]), Math.abs(ty - p[x + 1]), Math.abs(p[x + 2] - R));
      p[x] += (tx - p[x]) * .16; p[x + 1] += (ty - p[x + 1]) * .16; p[x + 2] += (R - p[x + 2]) * .2;
    }
    o.set(p);
    if (far < .04) { c.flattening = 0; c.sleeping = true; }
    return {move: 20, impact: 0};
  }
  const {la, lb, lr, ls, L} = c;
  // 한 프레임을 SUB 번으로 잘게 쪼개 계산한다: 조각마다 움직임이 작아서 접힌 층이 서로 뚫고 나오지 않는다
  const part = 1 / SUB, fFloor = Math.pow(.3, part), fAir = Math.pow(.9, part), fZ = Math.pow(.92, part), gSub = GRAVITY * wt.g * part * part;
  let zmax = 0; for (const i of idx) if (p[i * 3 + 2] > zmax) zmax = p[i * 3 + 2];
  const needCol = zmax > R + THICK * c.scale * 1.7;   // 천이 한 장으로 평평하면 충돌 계산을 건너뛴다
  for (let sub = 0; sub < SUB; sub++) {
    c.sw.set(p);   // 이 조각을 시작할 때의 위치: 충돌 때 「어느 쪽 면에 있었는지」를 가리는 기준
    for (const i of idx) {
      if (pin[i]) continue;
      const x = i * 3, f = p[x + 2] <= R + .4 ? fFloor : fAir;
      const vx = p[x] - o[x], vy = p[x + 1] - o[x + 1], vz = p[x + 2] - o[x + 2];
      o[x] = p[x]; o[x + 1] = p[x + 1]; o[x + 2] = p[x + 2];
      p[x] += vx * f; p[x + 1] += vy * f; p[x + 2] += vz * fZ - gSub;
    }
    if (c.grab) {   // 손이 커서를 곧바로 따라가지 않고 속도 제한을 두고 따라간다: 무거운 러그의 느낌, 천이 찢어지듯 늘어나는 것도 막는다
      const g = c.grab, dx = g.tx - g.cx, dy = g.ty - g.cy, d = Math.hypot(dx, dy);
      if (d > 1e-6) { const m = Math.min(d, Math.max(d * .4 * part, .2), MAXPULL * wt.pull * c.scale * part) / d; g.cx += dx * m; g.cy += dy * m; }
    }
    applyPins(c);
    for (let it = 0; it < ITER; it++) {
      for (let k = 0; k < L; k++) {
        const a = la[k], b = lb[k], ia = a / 3, ib = b / 3;
        const wa = pin[ia] ? 0 : 1, wb = pin[ib] ? 0 : 1, ws = wa + wb;
        if (!ws) continue;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-9) continue;
        const diff = (len - lr[k]) / len * ls[k];
        const ca = wa / ws * diff, cb = wb / ws * diff;
        p[a] += dx * ca; p[a + 1] += dy * ca; p[a + 2] += dz * ca;
        p[b] -= dx * cb; p[b + 1] -= dy * cb; p[b + 2] -= dz * cb;
      }
      applyPins(c);
      if (needCol && it === ITER - 2) collide(c);   // 마지막 반복에서 늘어난 스프링을 되돌리도록 끝에서 두 번째에
      for (const i of idx) if (p[i * 3 + 2] < R && !pin[i]) p[i * 3 + 2] = R;
    }
  }
  for (let k = 0; k < L; k++) {
    if (c.lk[k] !== 2) continue;
    const a = la[k], b = lb[k], len = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    if (len < lr[k] * .97) lr[k] = Math.max(c.lr0[k] * .45, lr[k] - (lr[k] - len) * MEMORY);
  }
  let move = 0, impact = 0;
  for (const i of idx) {
    const x = i * 3;
    move += Math.abs(p[x] - o[x]) + Math.abs(p[x + 1] - o[x + 1]) + Math.abs(p[x + 2] - o[x + 2]);
    if (o[x + 2] > R + .8 && p[x + 2] <= R + .05) impact += o[x + 2] - R;
  }
  c.quiet = !c.grab && move / idx.length < .012 ? c.quiet + 1 : 0;
  if (c.quiet > 45) { c.sleeping = true; o.set(p); }
  return {move, impact};
}
/* 점 P 에서 삼각형(a,b,c)에 가장 가까운 점을 찾는다. out: [0..2]=무게(a,b,c) [3..5]=가까운 점→P 벡터 [6..8]=삼각형 법선 [9]=면 안쪽인가 */
function closestOnTri(pi, ia, ib, ic, P, out) {
  const ax = P[ia], ay = P[ia + 1], az = P[ia + 2], bx = P[ib], by = P[ib + 1], bz = P[ib + 2], cx = P[ic], cy = P[ic + 1], cz = P[ic + 2];
  const px = P[pi], py = P[pi + 1], pz = P[pi + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const d1 = abx * (px - ax) + aby * (py - ay) + abz * (pz - az), d2 = acx * (px - ax) + acy * (py - ay) + acz * (pz - az);
  let u, v, w, inside = 0;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
  else {
    const d3 = abx * (px - bx) + aby * (py - by) + abz * (pz - bz), d4 = acx * (px - bx) + acy * (py - by) + acz * (pz - bz);
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
      else {
        const d5 = abx * (px - cx) + aby * (py - cy) + abz * (pz - cz), d6 = acx * (px - cx) + acy * (py - cy) + acz * (pz - cz);
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - t; w = t; }
            else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; inside = 1; }
          }
        }
      }
    }
  }
  out[0] = u; out[1] = v; out[2] = w;
  out[3] = px - (u * ax + v * bx + w * cx); out[4] = py - (u * ay + v * by + w * cy); out[5] = pz - (u * az + v * bz + w * cz);
  let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  out[6] = nx / nl; out[7] = ny / nl; out[8] = nz / nl; out[9] = inside;
  return out;
}
const _cq = new Float64Array(10);
let _cg = {start: new Int32Array(1), pos: new Int32Array(1), items: new Int32Array(1)};
/* 천 층끼리 서로 뚫지 못하게 한다: 모든 점을 다른 곳의 삼각형 면과 비교해, 두께(o)보다 가까우면 밀어낸다.
   이번 프레임 시작 때 어느 쪽 면에 있었는지(c.sw)를 기억해서, 이미 겹친 뒤에도 원래 있던 쪽으로 돌려보낸다 */
function collide(c) {
  const p = c.p, old = c.o, sw = c.sw, tri = c.tri, nxg = c.nx, pin = c.pin, tb = c.tb, tr = c.tr;
  const o = 2 * THICK * c.scale + 1, m = o + 2 * c.scale, l = 16 * c.scale, inv = 1 / l;
  let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
  for (const i of c.idx) {
    const g = i * 3;
    if (p[g] < minx) minx = p[g]; if (p[g] > maxx) maxx = p[g];
    if (p[g + 1] < miny) miny = p[g + 1]; if (p[g + 1] > maxy) maxy = p[g + 1];
    if (p[g + 2] < minz) minz = p[g + 2]; if (p[g + 2] > maxz) maxz = p[g + 2];
  }
  const ox = minx - m, oy = miny - m, oz = minz - m;
  const gx = Math.floor((maxx + m - ox) * inv) + 1, gy = Math.floor((maxy + m - oy) * inv) + 1, gz = Math.floor((maxz + m - oz) * inv) + 1, ncell = gx * gy * gz;
  if (ncell > 3e6) return;
  if (_cg.start.length < ncell + 1) _cg = {start: new Int32Array(ncell + 1), pos: new Int32Array(ncell + 1), items: _cg.items};
  const start = _cg.start, fillAt = _cg.pos;
  start.fill(0, 0, ncell + 1);
  let total = 0;
  for (let h = 0; h < tri.length; h += 3) {      // 1) 삼각형이 걸치는 칸 범위를 구하고 칸마다 몇 개인지 센다
    const a = tri[h] * 3, b = tri[h + 1] * 3, cc = tri[h + 2] * 3, q = h * 2;
    const x0 = Math.min(p[a], p[b], p[cc]) - m, x1 = Math.max(p[a], p[b], p[cc]) + m;
    const y0 = Math.min(p[a + 1], p[b + 1], p[cc + 1]) - m, y1 = Math.max(p[a + 1], p[b + 1], p[cc + 1]) + m;
    const z0 = Math.min(p[a + 2], p[b + 2], p[cc + 2]) - m, z1 = Math.max(p[a + 2], p[b + 2], p[cc + 2]) + m;
    tb[q] = x0; tb[q + 1] = x1; tb[q + 2] = y0; tb[q + 3] = y1; tb[q + 4] = z0; tb[q + 5] = z1;
    tr[q] = Math.floor((x0 - ox) * inv); tr[q + 1] = Math.floor((x1 - ox) * inv); tr[q + 2] = Math.floor((y0 - oy) * inv);
    tr[q + 3] = Math.floor((y1 - oy) * inv); tr[q + 4] = Math.floor((z0 - oz) * inv); tr[q + 5] = Math.floor((z1 - oz) * inv);
    for (let z = tr[q + 4]; z <= tr[q + 5]; z++) for (let y = tr[q + 2]; y <= tr[q + 3]; y++) for (let x = tr[q]; x <= tr[q + 1]; x++) { start[(z * gy + y) * gx + x + 1]++; total++; }
  }
  for (let k = 0; k < ncell; k++) start[k + 1] += start[k];
  if (_cg.items.length < total) _cg.items = new Int32Array(total + 4096);
  const items = _cg.items;
  for (let k = 0; k < ncell; k++) fillAt[k] = start[k];
  for (let h = 0; h < tri.length; h += 3) {      // 2) 칸마다 삼각형 번호를 채운다
    const q = h * 2;
    for (let z = tr[q + 4]; z <= tr[q + 5]; z++) for (let y = tr[q + 2]; y <= tr[q + 3]; y++) for (let x = tr[q]; x <= tr[q + 1]; x++) items[fillAt[(z * gy + y) * gx + x]++] = h;
  }
  for (const i of c.idx) {
    const g = i * 3;
    const cell = (Math.floor((p[g + 2] - oz) * inv) * gy + Math.floor((p[g + 1] - oy) * inv)) * gx + Math.floor((p[g] - ox) * inv);
    const ri = (i / nxg) | 0, ci = i % nxg;
    for (let it = start[cell], end = start[cell + 1]; it < end; it++) {
      const h = items[it], A = tri[h], B = tri[h + 1], C = tri[h + 2];
      if (i === A || i === B || i === C) continue;
      const dr = ri - (((A / nxg) | 0) + ((B / nxg) | 0) + ((C / nxg) | 0)) / 3, dc = ci - ((A % nxg) + (B % nxg) + (C % nxg)) / 3;
      if (dr * dr + dc * dc < 6.25) continue;                       // 가까이 이어진 삼각형은 스프링이 맡는다
      const q = h * 2;
      if (p[g] < tb[q] || p[g] > tb[q + 1] || p[g + 1] < tb[q + 2] || p[g + 1] > tb[q + 3] || p[g + 2] < tb[q + 4] || p[g + 2] > tb[q + 5]) continue;
      const a = A * 3, b = B * 3, cc = C * 3, L = closestOnTri(g, a, b, cc, p, _cq), dist = Math.sqrt(L[3] * L[3] + L[4] * L[4] + L[5] * L[5]);
      if (dist > m) continue;
      let J, nx, ny, nz;
      if (L[9]) {
        const nt = L[3] * L[6] + L[4] * L[7] + L[5] * L[8];
        const ht = (sw[g] - sw[a] * L[0] - sw[b] * L[1] - sw[cc] * L[2]) * L[6] + (sw[g + 1] - sw[a + 1] * L[0] - sw[b + 1] * L[1] - sw[cc + 1] * L[2]) * L[7] + (sw[g + 2] - sw[a + 2] * L[0] - sw[b + 2] * L[1] - sw[cc + 2] * L[2]) * L[8];
        const sg = Math.abs(ht) > .08 ? Math.sign(ht) : (Math.sign(nt) || 1);
        J = o - nt * sg; nx = L[6] * sg; ny = L[7] * sg; nz = L[8] * sg;
      } else { J = o - dist; const d = dist || 1; nx = L[3] / d; ny = L[4] / d; nz = L[5] / d; }
      if (J <= 0) continue;
      J = Math.min(J, o * 1.6);
      const mv = pin[i] ? 0 : 1, ma = pin[A] ? 0 : 1, mb = pin[B] ? 0 : 1, mc = pin[C] ? 0 : 1;
      const den = mv + ma * L[0] * L[0] + mb * L[1] * L[1] + mc * L[2] * L[2];
      if (den < 1e-9) continue;
      const lam = J * .92 / den;
      let f = mv * lam;
      p[g] += nx * f; p[g + 1] += ny * f; p[g + 2] += nz * f; old[g] += nx * f * .8; old[g + 1] += ny * f * .8; old[g + 2] += nz * f * .8;
      f = -ma * L[0] * lam; p[a] += nx * f; p[a + 1] += ny * f; p[a + 2] += nz * f; old[a] += nx * f * .8; old[a + 1] += ny * f * .8; old[a + 2] += nz * f * .8;
      f = -mb * L[1] * lam; p[b] += nx * f; p[b + 1] += ny * f; p[b + 2] += nz * f; old[b] += nx * f * .8; old[b + 1] += ny * f * .8; old[b + 2] += nz * f * .8;
      f = -mc * L[2] * lam; p[cc] += nx * f; p[cc + 1] += ny * f; p[cc + 2] += nz * f; old[cc] += nx * f * .8; old[cc + 1] += ny * f * .8; old[cc + 2] += nz * f * .8;
    }
  }
}
/* 계산용 점 → 그리는 점(곡선으로 보간). 가장자리처럼 이웃 점이 없는 곳은 바깥으로 직선 연장해서 채운다 */
function evalSurface(c, pos) {
  const {gi, wu, wv, rp, rk, rc, p} = c;
  for (let v = 0; v < rc; v++) {
    const g = v * 16, u0 = wu[v * 4], u1 = wu[v * 4 + 1], u2 = wu[v * 4 + 2], u3 = wu[v * 4 + 3];
    for (let j = 0; j < 4; j++) {
      const i0 = gi[g + j * 4], i1 = gi[g + j * 4 + 1], i2 = gi[g + j * 4 + 2], i3 = gi[g + j * 4 + 3];
      if (i1 < 0 && i2 < 0) { rk[j] = 0; continue; }
      rk[j] = 1;
      for (let d = 0; d < 3; d++) {
        let a1, a2;
        const a0 = i0 < 0 ? 0 : p[i0 * 3 + d], a3 = i3 < 0 ? 0 : p[i3 * 3 + d];
        if (i1 >= 0 && i2 >= 0) { a1 = p[i1 * 3 + d]; a2 = p[i2 * 3 + d]; }
        else if (i1 >= 0) { a1 = p[i1 * 3 + d]; a2 = i0 >= 0 ? 2 * a1 - a0 : a1; }
        else { a2 = p[i2 * 3 + d]; a1 = i3 >= 0 ? 2 * a2 - a3 : a2; }
        const b0 = i0 < 0 ? 2 * a1 - a2 : a0, b3 = i3 < 0 ? 2 * a2 - a1 : a3;
        rp[j * 3 + d] = u0 * b0 + u1 * a1 + u2 * a2 + u3 * b3;
      }
    }
    const w0 = wv[v * 4], w1 = wv[v * 4 + 1], w2 = wv[v * 4 + 2], w3 = wv[v * 4 + 3];
    for (let d = 0; d < 3; d++) {
      let q1, q2;
      if (rk[1] && rk[2]) { q1 = rp[3 + d]; q2 = rp[6 + d]; }
      else if (rk[1]) { q1 = rp[3 + d]; q2 = rk[0] ? 2 * q1 - rp[d] : q1; }
      else if (rk[2]) { q2 = rp[6 + d]; q1 = rk[3] ? 2 * q2 - rp[9 + d] : q2; }
      else { q1 = q2 = rk[0] ? rp[d] : rp[9 + d]; }
      const q0 = rk[0] ? rp[d] : 2 * q1 - q2, q3 = rk[3] ? rp[9 + d] : 2 * q2 - q1;
      const val = w0 * q0 + w1 * q1 + w2 * q2 + w3 * q3;
      pos[v * 3 + d] = d === 1 ? -val : val;
    }
  }
}
function updateGeometry() {
  const c = cloth; if (!c) return;
  const pos = c.geo.attributes.position.array, nrm = c.geo.attributes.normal.array;
  evalSurface(c, pos);
  c.geo.attributes.position.needsUpdate = true;
  c.geo.computeVertexNormals();           // 법선은 윗면 지오메트리에서 한 번만 계산
  for (let pass = 0; pass < 2; pass++) {    // 겹친 두 층의 점이 어긋나며 생기는 잔물결이 조명에 과장돼 보이지 않게 이웃과 부드럽게 섞는다
    const nbr = c.nb4, tmp = c.nbTmp;
    for (let v = 0; v < c.rc; v++) {
      let x = nrm[v * 3] * 2, y = nrm[v * 3 + 1] * 2, z = nrm[v * 3 + 2] * 2;
      for (let k = 0; k < 4; k++) { const u = nbr[v * 4 + k]; if (u >= 0) { x += nrm[u * 3]; y += nrm[u * 3 + 1]; z += nrm[u * 3 + 2]; } }
      const l = Math.hypot(x, y, z) || 1;
      tmp[v * 3] = x / l; tmp[v * 3 + 1] = y / l; tmp[v * 3 + 2] = z / l;
    }
    nrm.set(tmp);
  }
  const pb = c.geoB.attributes.position.array, nb = c.geoB.attributes.normal.array, t = THICK * c.scale, n3 = c.rc * 3;
  for (let x = 0; x < n3; x++) nb[x] = nrm[x];
  for (let x = 0; x < n3; x++) { pb[x] = pos[x] - nrm[x] * t; pos[x] += nrm[x] * t; }
  c.geoB.attributes.position.needsUpdate = true; c.geoB.attributes.normal.needsUpdate = true;
  const m = center(c);
  sun.target.position.set(m.x, -m.y, 20);
  sun.position.set(m.x - 1100, -m.y + 1000, 1120);
  const e = Math.max(c.wpx, c.hpx) * c.scale * .85 + 90, sc = sun.shadow.camera;
  sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.updateProjectionMatrix();
  sun.target.updateMatrixWorld();
}
function keepOnScreen() {
  const m = center(cloth);
  if (m.x < -50 || m.y < -50 || m.x > W + 50 || m.y > H + 50) translate(cloth, W / 2 - m.x, H / 2 - m.y);
}

/* ───────── 이미지 → 러그 ───────── */
let src = null, hasAlpha = false, mode = 'cutout', tol = 40;

function makeSample() {
  const c = document.createElement('canvas'); c.width = c.height = 800;
  const g = c.getContext('2d');
  const ell = (x, y, rx, ry, col) => { g.fillStyle = col; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, 7); g.fill(); };
  ell(205, 190, 92, 92, '#b98557'); ell(595, 190, 92, 92, '#b98557');
  ell(205, 195, 52, 52, '#efc2a0'); ell(595, 195, 52, 52, '#efc2a0');
  ell(400, 440, 330, 310, '#d9a877');
  ell(400, 520, 170, 130, '#f6e3ca');
  ell(290, 400, 28, 36, '#3b2a22'); ell(510, 400, 28, 36, '#3b2a22');
  ell(299, 388, 8, 9, '#fff'); ell(519, 388, 8, 9, '#fff');
  ell(215, 500, 46, 30, '#f0a99f'); ell(585, 500, 46, 30, '#f0a99f');
  ell(400, 480, 44, 30, '#4a342b');
  g.strokeStyle = '#4a342b'; g.lineWidth = 9; g.lineCap = 'round';
  g.beginPath(); g.moveTo(400, 505); g.lineTo(400, 540); g.moveTo(400, 540); g.quadraticCurveTo(360, 585, 322, 548); g.moveTo(400, 540); g.quadraticCurveTo(440, 585, 478, 548); g.stroke();
  return c;
}
function detectAlpha(c) {
  const d = c.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, c.width, c.height).data;
  let t = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) t++;
  return t / (d.length / 4) > .015;
}
function setSource(canvasOrImg, forcedMode) {
  const m = 900, w = canvasOrImg.width, h = canvasOrImg.height, s = Math.min(1, m / Math.max(w, h));
  src = document.createElement('canvas'); src.width = Math.max(8, Math.round(w * s)); src.height = Math.max(8, Math.round(h * s));
  src.getContext('2d').drawImage(canvasOrImg, 0, 0, src.width, src.height);
  hasAlpha = detectAlpha(src);
  mode = forcedMode || (hasAlpha ? 'asis' : 'cutout');
  syncShapeUI(); rebuild();
  if (DESKTOP) host.report({mode, hasAlpha});
  if (hasAlpha) toast('투명 배경 이미지예요. 모양 그대로 러그로 만들었어요');
}
function removeBg(c, tolerance) {
  const w = c.width, h = c.height, ctx = c.getContext('2d', {willReadFrequently: true});
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  let br = 0, bg = 0, bb = 0, n = 0;
  for (const [x0, y0] of [[0, 0], [w - 6, 0], [0, h - 6], [w - 6, h - 6]])
    for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) { const i = (y * w + x) * 4; br += d[i]; bg += d[i + 1]; bb += d[i + 2]; n++; }
  br /= n; bg /= n; bb /= n;
  const match = i => Math.hypot(d[i * 4] - br, d[i * 4 + 1] - bg, d[i * 4 + 2] - bb) < tolerance;
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const push = i => { if (!seen[i] && match(i)) { seen[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  let removed = 0;
  while (sp) {
    const i = stack[--sp]; d[i * 4 + 3] = 0; removed++;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const frac = removed / (w * h);
  const edge = [];
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] === 0) continue;
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && d[(i - 1) * 4 + 3] === 0) || (x < w - 1 && d[(i + 1) * 4 + 3] === 0) || (y > 0 && d[(i - w) * 4 + 3] === 0) || (y < h - 1 && d[(i + w) * 4 + 3] === 0)) edge.push(i);
  }
  for (const i of edge) d[i * 4 + 3] = 90;
  ctx.putImageData(img, 0, 0);
  return frac;
}
function roundRectPath(g, w, h, r) {
  g.beginPath(); g.moveTo(r, 0); g.arcTo(w, 0, w, h, r); g.arcTo(w, h, 0, h, r); g.arcTo(0, h, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.closePath();
}
function shaped() {
  const sw = src.width, sh = src.height;
  const out = document.createElement('canvas'), g = out.getContext('2d', {willReadFrequently: true});
  if (mode === 'circle') {
    const s = Math.min(sw, sh); out.width = out.height = s;
    g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 1, 0, 7); g.clip();
    g.drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, s, s);
  } else if (mode === 'round') {
    out.width = sw; out.height = sh; roundRectPath(g, sw, sh, Math.min(sw, sh) * .12); g.clip(); g.drawImage(src, 0, 0);
  } else {
    out.width = sw; out.height = sh; g.drawImage(src, 0, 0);
    if (mode === 'cutout' && !hasAlpha) {
      const f = removeBg(out, tol);
      if (f < .01 || f > .9) {   // 사진처럼 배경이 단색이 아니면 지울 수 없다 → 사진 전체를 둥근 네모 러그로
        toast(f < .01 ? '배경이 단색이 아니라서 사진 전체를 러그로 만들었어요' : '거의 다 지워져서 사진 전체를 러그로 만들었어요');
        mode = 'round'; syncShapeUI(); if (DESKTOP) host.report({mode, hasAlpha});
        return shaped();
      }
    }
  }
  return out;
}
let rebuildTimer = 0;
function rebuild() { if (src) buildCloth(shaped()); dirty = true; }
function syncShapeUI() {
  $$('#shapes .pill').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#tolRow').style.display = mode === 'cutout' && !hasAlpha ? 'flex' : 'none';
}
function loadDataUrl(url, forcedMode) {
  const img = new Image();
  img.onload = () => setSource(img, forcedMode);
  img.onerror = () => { toast('이미지를 열 수 없어요'); setSource(makeSample()); };
  img.src = url;
}
function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('이미지 파일만 올릴 수 있어요'); return; }
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => { setSource(img); URL.revokeObjectURL(url); };
  img.onerror = () => { URL.revokeObjectURL(url); toast('이미지를 열 수 없어요. 다른 파일로 해 보세요'); };
  img.src = url;
}

/* ───────── 입력 ───────── */
let drag = null, hitState = null;
const onRug = (x, y) => !!cloth && nearest(cloth, x, y, cloth.cell * cloth.scale * 2.2) >= 0;
function setHit(v) {
  if (!DESKTOP || v === hitState) return;
  hitState = v; host.hit(v); stage.style.cursor = v ? 'grab' : 'default';
}
stage.addEventListener('pointermove', ev => { if (!drag) setHit(onRug(ev.clientX, ev.clientY)); });
stage.addEventListener('pointerdown', ev => {
  if (!cloth || drag) return;
  const i = nearest(cloth, ev.clientX, ev.clientY, cloth.cell * cloth.scale * 2.2);
  if (i < 0) return;
  const move = ev.button === 2 || ev.button === 1 || ev.shiftKey;
  drag = {move, x: ev.clientX, y: ev.clientY, d: 0, button: ev.button};
  stage.setPointerCapture(ev.pointerId);
  if (DESKTOP) { host.dragging(true); stage.style.cursor = 'grabbing'; }
  startGrab(cloth, ev.clientX, ev.clientY, i, move);   // 옮기기도 통째로 평행이동하지 않고 바닥에서 끌어 모양이 흐트러지게 한다
  ev.preventDefault();
});
stage.addEventListener('pointermove', ev => {
  if (!drag || !cloth) return;
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  drag.d += Math.hypot(dx, dy); drag.x = ev.clientX; drag.y = ev.clientY;
  moveGrab(cloth, ev.clientX, ev.clientY);
});
const endDrag = ev => {
  if (!drag) return;
  if (cloth) { release(cloth); keepOnScreen(); }
  if (DESKTOP) { const menuClick = drag.button === 2 && drag.d < 5; host.dragging(false); hitState = null; setHit(onRug(ev.clientX, ev.clientY)); if (menuClick) host.menu(); }
  
  drag = null;
  try { stage.releasePointerCapture(ev.pointerId); } catch (e) {}
};
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => stage.addEventListener(t, endDrag));
stage.addEventListener('contextmenu', e => e.preventDefault());
stage.addEventListener('dblclick', e => {
  if (cloth && nearest(cloth, e.clientX, e.clientY, cloth.cell * cloth.scale * 2.2) >= 0) { flatten(cloth); toast('펼치는 중', 1500); }
});
stage.addEventListener('wheel', e => {
  if (!cloth || nearest(cloth, e.clientX, e.clientY, cloth.cell * cloth.scale * 2.2) < 0) return;
  e.preventDefault(); resize(cloth, e.deltaY < 0 ? 1.055 : .948); keepOnScreen();
  toast('크기 ' + Math.round(cloth.scale * 100) + '%');
}, {passive: false});

/* ───────── 패널 ───────── */
let toastT = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.classList.remove('on'); void t.offsetWidth;   // 아래 선이 처음부터 다시 차오르게 한다
  t.textContent = msg; t.style.setProperty('--dur', ms + 'ms'); t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}
$('#pick').onclick = () => $('#file').click();
$('#file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
$('#sample').onclick = () => setSource(makeSample());
$('#fold').onclick = () => { const p = $('#panel'); p.classList.toggle('min'); $('#fold').textContent = p.classList.contains('min') ? '펼치기' : '접기'; };
$$('#shapes .pill').forEach(b => b.onclick = () => { mode = b.dataset.mode; syncShapeUI(); rebuild(); });
$$('#fx .pill').forEach(b => b.onclick = () => { U_YARN.value = FX[b.dataset.fx]; $$('#fx .pill').forEach(x => x.setAttribute('aria-pressed', String(x === b))); dirty = true; });
$('#tol').oninput = e => { tol = +e.target.value; clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 160); };
$$('#floors .sw').forEach(b => b.onclick = () => {
  floor.material.color.set(b.dataset.c); document.body.style.background = b.dataset.c;
  $$('#floors .sw').forEach(x => x.setAttribute('aria-pressed', String(x === b))); dirty = true;
});
$('#flat').onclick = () => { if (cloth) { flatten(cloth); toast('펼치는 중', 1500); } };
$('#save').onclick = () => {
  renderer.render(scene, cam);
  stage.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'my-rug.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
};
addEventListener('dragover', e => { e.preventDefault(); $('#drop').classList.add('on'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) $('#drop').classList.remove('on'); });
addEventListener('drop', e => { e.preventDefault(); $('#drop').classList.remove('on'); loadFile(e.dataTransfer.files[0]); });
addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f) loadFile(f); });
addEventListener('resize', () => { layout(); if (cloth) keepOnScreen(); });

/* ───────── 루프 ───────── */
let last = 0, acc = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(.05, (ts - last) / 1000); last = ts; acc += dt;
  let steps = 0, ran = false;
  while (acc >= 1 / 60 && steps < 3) {
    acc -= 1 / 60; steps++;
    if (cloth && step(cloth)) ran = true;
  }
  if (ran || dirty) { updateGeometry(); renderer.render(scene, cam); dirty = false; }
}

layout(); syncShapeUI();
$$('#floors .sw')[0].setAttribute('aria-pressed', 'true');
requestAnimationFrame(frame);
if (DESKTOP) {
  host.onCursor(p => { if (!drag) setHit(onRug(p.x, p.y)); });
  host.onCommand(cmd => {
    const t = typeof cmd === 'string' ? cmd : cmd.type;
    if (t === 'flatten' && cloth) { flatten(cloth); toast('펼치는 중', 1500); }
    else if (t === 'scale' && cloth) { resize(cloth, cmd.factor); keepOnScreen(); }
    else if (t === 'center' && cloth) { const m = center(cloth); translate(cloth, W / 2 - m.x, H / 2 - m.y); }
    else if (t === 'scaleReset' && cloth) { resize(cloth, 1 / cloth.scale); keepOnScreen(); }
    else if (t === 'reset' && cloth) { resize(cloth, 1 / cloth.scale); const m = center(cloth); translate(cloth, W / 2 - m.x, H / 2 - m.y); flatten(cloth); toast('펼치는 중', 1500); }
    else if (t === 'effect') { U_YARN.value = FX[cmd.value] ?? 0; dirty = true; }
    else if (t === 'weight') { wt = WEIGHT[cmd.value] || WEIGHT.normal; if (cloth) wake(cloth); }
    else if (t === 'mode') { mode = cmd.value; rebuild(); }
    else if (t === 'tol') { tol = cmd.value; rebuild(); }
    else if (t === 'image') loadDataUrl(cmd.dataUrl, cmd.mode);
    else if (t === 'help') toast('왼쪽 드래그로 구기고, 오른쪽 드래그로 옮겨요. 우클릭은 메뉴예요');
    else if (t === 'wake') { dirty = true; }
  });
  host.init().then(init => {
    const st = (init && init.settings) || {};
    if (st.tol) tol = st.tol;
    if (st.weight) wt = WEIGHT[st.weight] || WEIGHT.normal;
    if (st.effect) U_YARN.value = FX[st.effect] ?? 0;
    if (init && init.imageDataUrl) loadDataUrl(init.imageDataUrl, st.mode || undefined);
    else setSource(makeSample());
    if (!st.seen) toast('왼쪽 드래그로 구기고, 오른쪽 드래그로 옮겨요. 우클릭 메뉴에서 이미지를 바꿀 수 있어요');
  });
} else {
  setSource(makeSample());
}
window.__rug = {DESKTOP, get cloth() { return cloth; }, step: () => step(cloth), grab: (x, y) => { const i = nearest(cloth, x, y, 999); startGrab(cloth, x, y, i); }, moveGrab: (x, y) => moveGrab(cloth, x, y), release: () => release(cloth)};
})();
