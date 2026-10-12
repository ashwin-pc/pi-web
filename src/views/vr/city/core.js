// Shared scene core for the City mock: renderer, camera, the night sky, the frame shader, and layout constants.
import * as THREE from 'three';
import {PanelConfig} from './panel.js';
import {C} from './draw.js';
import * as V from './views.js';
import {buildSky} from './city-mesh.js';
import {host} from './host.js';

export const nowMs = () => performance.now();
// The animation clock: advances with the frames, at most 50 ms per frame. Transitions run on it, so a hitch (the
// first frame of a newly opened panel, a texture upload) slows an animation down instead of skipping it.
let animT = performance.now(), animReal = animT;
export const animMs = () => animT;
export function tickAnim() { const r = performance.now(); animT += Math.min(50, Math.max(0, r - animReal)); animReal = r; }
export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const easeOut = (u) => 1 - Math.pow(1 - u, 3);
export const QS = new URLSearchParams(location.search);
/** Cross-module app references (filled in by main.js). */
export const A = {};

// ------------------------------------------------------------------ renderer
// alpha: false: the page is fully covered by the scene, so the compositor needs no blending of the canvas.
export const renderer = new THREE.WebGLRenderer({antialias: new URLSearchParams(location.search).get('aa') !== '0', alpha: false, powerPreference: 'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.NoToneMapping; // every material in the city outputs its final colour
renderer.domElement.id = 'scene';
(host.el || document.body).prepend(renderer.domElement);
PanelConfig.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030303);
export const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 6000); // the big workspace is 2.6 km across
scene.add(camera);

// ------------------------------------------------------------------ the night sky (centred on you), then your space
export const uiRoot = new THREE.Group(); // recentred on the head when an XR session starts
scene.add(uiRoot);
const SKY = buildSky(); uiRoot.add(SKY);
export const env = {sky: SKY, setDim() {}};
export const world = new THREE.Group();
uiRoot.add(world);

// ------------------------------------------------------------------ frame shader: rounded rect fill + border + glow
const frameVS = 'uniform vec2 uExt; varying vec2 vP; void main(){ vP = position.xy * uExt; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const frameFS = `uniform vec2 uHalf; uniform vec2 uExt; uniform float uR, uBW, uGW, uFillA, uBorderA, uGlowA, uOpacity;
  uniform vec3 uFill, uBorder, uGlow; varying vec2 vP;
  float sdb(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main(){
    float d = sdb(vP, uHalf, uR);
    float aa = max(fwidth(d), 1e-5);
    float inside = 1.0 - smoothstep(-aa, aa, d);
    float band = inside * smoothstep(-uBW - aa, -uBW + aa, d) * uBorderA;
    vec3 cin = mix(uFill, uBorder, clamp(band / max(uBorderA, 1e-4), 0.0, 1.0) * step(0.001, uBorderA));
    float ain = inside * max(uFillA, band);
    float glow = (1.0 - inside) * uGlowA * exp(-max(d, 0.0) / max(uGW, 1e-4) * 3.0);
    float a = ain + glow * (1.0 - ain);
    vec3 col = (cin * ain + uGlow * glow * (1.0 - ain)) / max(a, 1e-4);
    gl_FragColor = vec4(col, a * uOpacity);
    #include <colorspace_fragment>
  }`;
const planeGeo = new THREE.PlaneGeometry(1, 1);
export function frameMesh(w, h, o = {}) {
  const gw = o.glowW ?? 0.07;
  const mat = new THREE.ShaderMaterial({
    vertexShader: frameVS, fragmentShader: frameFS, transparent: true, depthWrite: false, toneMapped: false,
    uniforms: {
      uHalf: {value: new THREE.Vector2(w / 2, h / 2)}, uExt: {value: new THREE.Vector2(w + 2 * gw, h + 2 * gw)}, uR: {value: o.r ?? 0.025},
      uBW: {value: o.bw ?? 0.0025}, uGW: {value: gw}, uFillA: {value: o.fillA ?? 1}, uBorderA: {value: o.borderA ?? 1}, uGlowA: {value: 0}, uOpacity: {value: 1},
      uFill: {value: new THREE.Color(o.fill ?? 0x0d0d0d)}, uBorder: {value: new THREE.Color(o.border ?? 0x262626)}, uGlow: {value: new THREE.Color(C.accent)},
    },
  });
  const m = new THREE.Mesh(planeGeo, mat);
  m.renderOrder = o.renderOrder ?? 0;
  m.scale.set(w + 2 * gw, h + 2 * gw, 1);
  m.userData.frame = {w, h, gw};
  return m;
}
/** A frame's quad with its middle cut out: only the band from `inset` inside the edge to `out` outside it (metres).
 * Used once a panel has settled in front of its opaque card, so the frame shader no longer shades the whole panel,
 * nor a 7 cm glow margin when nothing glows. */
export function frameRingGeo(m, inset, out) {
  const {w, h, gw} = m.userData.frame, ex = w + 2 * gw, ey = h + 2 * gw;
  const ix = (w / 2 - inset) / ex, iy = (h / 2 - inset) / ey, ox = Math.min(0.5, (w / 2 + out) / ex), oy = Math.min(0.5, (h / 2 + out) / ey);
  const p = [-ox, -oy, ox, -oy, ox, oy, -ox, oy, -ix, -iy, ix, -iy, ix, iy, -ix, iy];
  const pos = [], idx = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  for (let i = 0; i < 8; i++) pos.push(p[i * 2], p[i * 2 + 1], 0);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}
export function setFrameSize(m, w, h) { const u = m.material.uniforms, gw = m.userData.frame.gw; u.uHalf.value.set(w / 2, h / 2); u.uExt.value.set(w + 2 * gw, h + 2 * gw); m.scale.set(w + 2 * gw, h + 2 * gw, 1); }
const COL = {accent: new THREE.Color(C.accent), wait: new THREE.Color('#8fb8ff'), readerB: new THREE.Color(0x262626)};
/** The reading panel glows softly while its session runs (amber) or waits on workers (slow blue breathing). */
export function applyStatus(m, kind, t, strength = 1) {
  const u = m.material.uniforms;
  u.uBW.value = 0.0025; u.uBorderA.value = 1;
  if (kind === 'running') {
    u.uGlow.value.copy(COL.accent);
    u.uGlowA.value = strength * (0.42 + 0.14 * Math.sin(t * 2.2) + 0.08 * Math.sin(t * 5.3));
    u.uBorder.value.copy(COL.accent).multiplyScalar(0.75);
  } else if (kind === 'waiting') {
    u.uGlow.value.copy(COL.wait);
    u.uGlowA.value = strength * (0.08 + 0.16 * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 3.2)));
    u.uBorder.value.copy(COL.wait).multiplyScalar(0.55);
  } else { u.uGlowA.value = 0; u.uBorder.value.copy(COL.readerB); }
}

// ------------------------------------------------------------------ layout (metres, the user's eye at 1.6 m)
export const EYE = 1.6;
export const R = V.READER;
export const RW = R.w, RH = R.headerH + R.streamH;
/** Round 3, the focus panel: FOCUS.D metres away, scaled by FOCUS.S (text 1.27° at 1.4 m becomes 1.2° at 1.9 m), its
 * centre FOCUS.E degrees below where you looked when you opened it (see focus.js). READER_POS is the level default. */
export const FOCUS = {D: 1.9, S: (1.9 / 1.4) * (1.2 / 1.27), E: -3};
export const READER_POS = new THREE.Vector3(0, EYE + FOCUS.D * Math.sin(FOCUS.E * DEG), -FOCUS.D * Math.cos(FOCUS.E * DEG));
export const TOP = RH / 2, STREAM_TOP = TOP - R.headerH, STREAM_BOT = -RH / 2;
